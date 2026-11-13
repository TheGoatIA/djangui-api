/**
 * SÉCURITÉ TRANSVERSALE — non-régression de l'audit (2026-11-10).
 *
 *  1. Matrice d'authentification : TOUTES les routes de l'API sont énumérées depuis le
 *     routeur Express ; chaque route non publique doit refuser un appel anonyme.
 *  2. Matrice d'autorisation : chaque route /admin doit refuser un utilisateur standard.
 *  3. Correctifs ponctuels : ReDoS, pagination bornée, masquage des logs, paiements
 *     refusés sans secret de webhook, quotas IA, coffre revendeur.
 */
import { useTestDB } from '../helpers/db';
import { api, as } from '../helpers/http';
import { createUser, createAdmin, createPremium, createSupport } from '../helpers/factories';
import app from '../../src/app';
import SystemSetting from '../../src/models/SystemSetting';
import SharedSlot from '../../src/models/SharedSlot';
import { sanitize } from '../../src/middleware/requestLogger';
import { CoachService } from '../../src/services/ai/coachService';

jest.setTimeout(120000);

type Route = { method: string; path: string };

/** Walks the Express 4 router stack (nested routers included). */
function listRoutes(): Route[] {
  const out: Route[] = [];
  const walk = (stack: any[], prefix: string) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const m of Object.keys(layer.route.methods)) {
          out.push({ method: m, path: prefix + layer.route.path });
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        const src: string = layer.regexp?.source ?? '';
        const mount = src
          .replace('^\\', '')
          .replace('\\/?(?=\\/|$)', '')
          .replace(/\\\//g, '/')
          .replace(/\(\?:\(\[\^\\\/\]\+\?\)\)/g, ':param');
        walk(layer.handle.stack, prefix + (mount === '^' ? '' : mount));
      }
    }
  };
  walk((app as any)._router.stack, '');
  return out.filter((r) => r.path.startsWith('/'));
}

const concrete = (p: string) =>
  p.replace(/:([A-Za-z]+)\?/g, '').replace(/:[A-Za-z]+/g, '000000000000000000000000');

// Routes VOLONTAIREMENT publiques (revues une à une pendant l'audit)
const PUBLIC = [
  /^\/$/,
  /^\/favicon\.ico$/,
  /^\/reset-password/,
  /^\/\.well-known\//,
  /^\/api\/health$/,
  /^\/payment\/(success|cancel)$/,
  /^\/api-docs/,
  /^\/metrics$/,
  /^\/api\/v1\/auth\/(register|login|2fa\/verify|refresh|firebase|google|apple|forgot-password|reset-password\/|verify-email|resend-verification)/,
  /^\/api\/v1\/config\/features$/,
  /^\/api\/v1\/webhooks\//,
  /^\/api\/v1\/subscriptions\/plans$/,
  /^\/api\/v1\/system\/(version-check|public-settings|countries|telemetry\/)/,
];

describe('Sécurité transversale', () => {
  useTestDB();

  const routes = listRoutes();

  it('l’énumération des routes fonctionne (garde-fou du test lui-même)', () => {
    expect(routes.length).toBeGreaterThan(150);
    expect(routes.some((r) => r.path === '/api/v1/auth/me')).toBe(true);
    expect(routes.some((r) => r.path.startsWith('/api/v1/admin/'))).toBe(true);
  });

  it('MATRICE : toute route non publique refuse un appel anonyme (jamais 2xx, jamais 500)', async () => {
    const leaks: string[] = [];
    for (const r of routes) {
      if (PUBLIC.some((re) => re.test(r.path))) continue;
      const res = await api(r.method as any, concrete(r.path)).send({});
      if (res.status < 400 || res.status >= 500)
        leaks.push(`${r.method.toUpperCase()} ${r.path} → ${res.status}`);
    }
    expect(leaks).toEqual([]);
  });

  it('MATRICE : toute route /admin refuse un utilisateur standard (403)', async () => {
    const user = await createUser();
    const leaks: string[] = [];
    for (const r of routes.filter((x) => /\/admin(\/|$)/.test(x.path))) {
      const res = await as(user)[r.method as 'get'](concrete(r.path)).send({});
      if (res.status !== 403) leaks.push(`${r.method.toUpperCase()} ${r.path} → ${res.status}`);
    }
    expect(leaks).toEqual([]);
  });

  describe('Correctifs de l’audit', () => {
    it('ReDoS : une recherche admin piégée répond vite et ne casse rien', async () => {
      const admin = await createAdmin();
      for (const u of [
        '/admin/users?search=(a%2B)%2B%24',
        '/admin/support/tickets?search=(.*a){25}',
      ]) {
        const t = Date.now();
        const res = await as(admin).get(u);
        expect(res.status).toBe(200);
        expect(Date.now() - t).toBeLessThan(3000);
      }
    });

    it('pagination admin plafonnée à 100', async () => {
      const res = await as(await createAdmin()).get('/admin/users?limit=1000000');
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toMatch(/"limit":1000000/);
    });

    it('logs : mots de passe, jetons, codes 2FA, numéros de pièce et signatures masqués', () => {
      const out = sanitize({
        email: 'a@b.c',
        password: 'x',
        refreshToken: 'x',
        code: '123456',
        backupCode: 'x',
        nested: { documentNumber: 'CM1', otp: '1', authorization: 'Bearer x' },
        amount: 10,
      });
      expect(JSON.stringify(out)).not.toMatch(/"x"|123456|CM1|Bearer/);
      expect(out.email).toBe('a@b.c');
      expect(out.amount).toBe(10);
    });

    it('paiements refusés (503) tant que le secret de webhook n’est pas configuré', async () => {
      await SystemSetting.updateOne({ key: 'real_money_mode' }, { value: true }, { upsert: true });
      const user = await createUser({ country: 'CM', currency: 'XAF', phone: '+237690000000' });
      const saved = process.env.NOTCHPAY_WEBHOOK_SECRET;
      process.env.NOTCHPAY_WEBHOOK_SECRET = '';
      try {
        const res = await as(user)
          .post('/payments/init/notchpay')
          .send({ type: 'deposit', amount: 1000 });
        expect(res.status).toBe(503);
      } finally {
        process.env.NOTCHPAY_WEBHOOK_SECRET = saved;
      }
    });

    it('quota IA du coach : 15 messages/jour en gratuit, puis 429 sans appel au modèle', async () => {
      const spy = jest.spyOn(CoachService, 'askCoach').mockResolvedValue('ok');
      const user = await createUser();
      for (let i = 0; i < 15; i++) {
        expect((await as(user).post('/coach/ask').send({ message: 'Bonjour' })).status).toBe(200);
      }
      const res = await as(user).post('/coach/ask').send({ message: 'Encore' });
      expect(res.status).toBe(429);
      expect(res.body.code).toBe('AI_QUOTA_EXCEEDED');
      expect(spy).toHaveBeenCalledTimes(15);
    });

    it('coach : message démesuré refusé avant tout appel au modèle', async () => {
      const spy = jest.spyOn(CoachService, 'askCoach').mockResolvedValue('ok');
      const res = await as(await createPremium())
        .post('/coach/ask')
        .send({ message: 'x'.repeat(2001) });
      expect(res.status).toBe(400);
      expect(spy).not.toHaveBeenCalled();
    });

    it('SMS : import en masse limité à 50 messages', async () => {
      const res = await as(await createUser())
        .post('/sms/bulk-parse')
        .send({ messages: Array(51).fill('Dépôt 1000 FCFA') });
      expect(res.status).toBe(400);
    });

    it('revendeur : le PIN d’un profil est chiffré, les champs système envoyés sont ignorés', async () => {
      const reseller = await createUser({ plan: 'business' });
      const acc = await as(reseller)
        .post('/reseller/accounts')
        .send({
          serviceName: 'Netflix',
          billingCost: 8000,
          billingCurrency: 'XAF',
          maxSlots: 4,
          password: 'S3cret!',
          nextRenewalDate: new Date(Date.now() + 30 * 86400000).toISOString(),
        });
      expect(acc.status).toBeLessThan(300);
      const accountId = acc.body.data?._id ?? acc.body.data?.account?._id;
      const slot = await as(reseller)
        .post(`/reseller/accounts/${accountId}/slots`)
        .send({
          profileName: 'Profil 1',
          pin: '4321',
          client: { fullName: 'Client A', phone: '+237690000000' },
          price: 2500,
          status: 'vacant',
          totalPaid: 999999,
          resellerId: String((await createUser())._id),
        });
      expect(slot.status).toBeLessThan(300);
      const db: any = await SharedSlot.findOne({ resellerId: reseller._id }).lean();
      expect(db.encryptedPin).toBeTruthy();
      expect(JSON.stringify(db)).not.toContain('4321');
      expect(db.status).toBe('active');
      expect(db.totalPaid ?? 0).not.toBe(999999);
      expect(JSON.stringify(slot.body)).not.toMatch(/encryptedPin|pinIv|pinAuthTag/);
    });

    it("abonnements suivis : impossible de déplacer le sien dans la liste d'un autre", async () => {
      const a = await createUser();
      const b = await createUser();
      const created = await as(a)
        .post('/subscriptions')
        .send({
          name: 'Netflix',
          amount: 5000,
          billingCycle: 'monthly',
          nextBillingDate: new Date(Date.now() + 86400000).toISOString(),
        });
      const id = created.body.data?._id ?? created.body.data?.subscription?._id;
      expect(id).toBeTruthy();
      await as(a)
        .patch(`/subscriptions/${id}`)
        .send({ userId: String(b._id), name: 'Spotify' });
      expect((await as(b).get('/subscriptions')).body.data).toHaveLength(0);
    });

    it("logs client : niveau hors liste refusé silencieusement (jamais d'appel arbitraire au logger), support autorisé", async () => {
      const logger = (await import('../../src/utils/logger')).default as any;
      const closeSpy = jest.spyOn(logger, 'close').mockImplementation(() => logger);
      const res = await as(await createSupport())
        .post('/admin/logs')
        .send({ level: 'close', message: 'x\nFAKE LINE' });
      expect(res.status).toBe(201);
      expect(closeSpy).not.toHaveBeenCalled();
      expect(
        (
          await as(await createUser())
            .post('/admin/logs')
            .send({ message: 'x' })
        ).status,
      ).toBe(403);
    });
  });
});
