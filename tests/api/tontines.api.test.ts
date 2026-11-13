/**
 * MODULE TONTINES — tests de bout en bout (HTTP → services → MongoDB transactions + Redis + S3 réels).
 *
 * Cycle complet : création → adhésion → fonds social → démarrage → cotisations (auto-débit wallet
 * et reçus validés par le créateur) → rotation / versement du gagnant → fin de cycle / renouvellement.
 * Plus : gouvernance (votes), messagerie, export, droits d'accès (IDOR), limites des plans.
 *
 * Seule l'analyse IA du reçu (Gemini, payante) est simulée.
 */
import crypto from 'node:crypto';
import { useTestDB } from '../helpers/db';
import { anon, as } from '../helpers/http';
import { createUser, createPremium, createAdmin } from '../helpers/factories';
import User from '../../src/models/User';
import Tontine from '../../src/models/Tontine';
import TontineMember from '../../src/models/TontineMember';
import TontineContribution from '../../src/models/TontineContribution';
import Transaction from '../../src/models/Transaction';
import { TontineService } from '../../src/services/tontineService';
import { TontineAIService } from '../../src/services/ai/tontineAIService';
import TontineVote from '../../src/models/TontineVote';
import AuditLog from '../../src/models/AuditLog';
import { repairTontineRotations } from '../../src/services/migrations/tontineRotationMigration';

jest.setTimeout(60000);

// PNG 1×1 valide (magic bytes réels) — chaque appel est unique (empreinte différente)
const pngReceipt = () =>
  Buffer.concat([
    Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex'),
    crypto.randomBytes(16),
  ]);

const baseTontine = (o: Record<string, unknown> = {}) => ({
  name: 'Tontine des amis',
  frequency: 'monthly',
  startDate: new Date().toISOString(),
  contributionAmount: 10000,
  currency: 'XAF',
  totalParts: 3,
  rotationMode: 'fixed',
  ...o,
});

const balanceOf = async (u: { _id: unknown }) => (await User.findById(u._id))!.walletBalance;

async function createTontineAs(creator: { _id: unknown }, o: Record<string, unknown> = {}) {
  const res = await as(creator).post('/tontines').send(baseTontine(o));
  expect(res.status).toBe(201);
  return res.body.data as { _id: string; inviteCode: string };
}

async function join(user: { _id: unknown }, inviteCode: string, parts = 1) {
  return as(user).post('/tontines/join').send({ inviteCode, displayName: 'Membre', parts });
}

/** Tontine démarrée : créateur + n membres, wallets approvisionnés. */
async function startedTontine(n = 2, o: Record<string, unknown> = {}, balance = 100000) {
  const creator = await createPremium({ walletBalance: balance });
  const t = await createTontineAs(creator, { totalParts: n + 1, ...o });
  const members = [];
  for (let i = 0; i < n; i++) {
    const m = await createUser({ walletBalance: balance });
    expect((await join(m, t.inviteCode)).status).toBe(200);
    members.push(m);
  }
  expect((await as(creator).post(`/tontines/${t._id}/start`)).status).toBe(200);
  return { creator, members, tontineId: t._id, all: [creator, ...members] };
}

function mockReceipt(amount: number) {
  // Une référence opérateur différente à chaque reçu (sinon anti-doublon)
  return jest.spyOn(TontineAIService, 'analyzeReceipt').mockImplementation(
    async () =>
      ({
        amount,
        currency: 'XAF',
        date: new Date(),
        transactionRef: `MP${crypto.randomBytes(5).toString('hex')}`,
        beneficiaryName: 'Bénéficiaire',
        confidence: 0.9,
      }) as any,
  );
}

describe('API /tontines', () => {
  useTestDB();

  // ------------------------------------------------------------- création
  describe('Création', () => {
    it('crée la tontine en "pending", le créateur est membre accepté, code d’invitation fort', async () => {
      const creator = await createUser();
      const t = await createTontineAs(creator);
      const db = await Tontine.findById(t._id);
      expect(db!.status).toBe('pending');
      expect(db!.currentTurn).toBe(1);
      expect(db!.inviteCode).toMatch(/^[0-9A-F]{12}$/);
      expect(
        await TontineMember.countDocuments({
          tontineId: t._id,
          userId: creator._id,
          invitationStatus: 'accepted',
        }),
      ).toBe(1);
    });

    it.each([
      ['nom manquant', { name: '' }],
      ['fréquence inconnue', { frequency: 'daily' }],
      ['montant négatif', { contributionAmount: -1 }],
      ['montant nul', { contributionAmount: 0 }],
      ['moins de 2 parts', { totalParts: 1 }],
      ['montant décimal en XAF', { contributionAmount: 1000.5 }],
    ])('refuse : %s → 400', async (_l, o) => {
      const creator = await createUser();
      expect((await as(creator).post('/tontines').send(baseTontine(o))).status).toBe(400);
    });

    it('SÉCURITÉ : les champs système envoyés par le client sont ignorés (mass assignment)', async () => {
      const creator = await createUser();
      const t = await createTontineAs(creator, {
        status: 'active',
        currentTurn: 7,
        inviteCode: 'AAAAAAAAAAAA',
        creatorId: String((await createUser())._id),
        socialFund: { enabled: true, amount: 500, totalCollected: 999999 },
        rulesAcceptedByAll: true,
      });
      const db = await Tontine.findById(t._id);
      expect(db!.status).toBe('pending');
      expect(db!.currentTurn).toBe(1);
      expect(db!.inviteCode).not.toBe('AAAAAAAAAAAA');
      expect(String(db!.creatorId)).toBe(String(creator._id));
      expect(db!.socialFund!.totalCollected).toBe(0);
    });

    it('compte gratuit : une seule tontine non terminée ; premium et business : illimité', async () => {
      const free = await createUser();
      await createTontineAs(free);
      expect((await as(free).post('/tontines').send(baseTontine())).status).toBe(403);
      for (const plan of ['premium', 'business'] as const) {
        const u = await createUser({ plan });
        await createTontineAs(u);
        await createTontineAs(u);
      }
    });

    it('un premium EXPIRÉ retombe sur la limite gratuite', async () => {
      const u = await createUser({
        subscription: {
          plan: 'premium',
          status: 'expired',
          endDate: new Date(Date.now() - 86400000),
        },
      } as any);
      await createTontineAs(u);
      expect((await as(u).post('/tontines').send(baseTontine())).status).toBe(403);
    });

    it('CONCURRENCE : deux créations simultanées d’un compte gratuit → une seule réussit', async () => {
      const free = await createUser();
      const r = await Promise.all([
        as(free).post('/tontines').send(baseTontine()),
        as(free).post('/tontines').send(baseTontine()),
      ]);
      expect(r.filter((x) => x.status === 201)).toHaveLength(1);
      expect(await Tontine.countDocuments({ creatorId: free._id })).toBe(1);
    });
  });

  // ------------------------------------------------------------- adhésion
  describe('Adhésion', () => {
    it('rejoindre avec le code d’invitation', async () => {
      const creator = await createUser();
      const t = await createTontineAs(creator);
      const m = await createUser();
      const res = await join(m, t.inviteCode);
      expect(res.status).toBe(200);
      expect(res.body.data.invitationStatus).toBe('accepted');
    });

    it('code invalide → 404 ; déjà membre → 400', async () => {
      const creator = await createUser();
      const t = await createTontineAs(creator);
      const m = await createUser();
      expect((await join(m, 'FFFFFFFFFFFF')).status).toBe(404);
      await join(m, t.inviteCode);
      expect((await join(m, t.inviteCode)).status).toBe(400);
      expect((await join(creator, t.inviteCode)).status).toBe(400);
    });

    it('plus de place (parts) → 400', async () => {
      const creator = await createUser();
      const t = await createTontineAs(creator, { totalParts: 3 });
      expect((await join(await createUser(), t.inviteCode, 2)).status).toBe(200);
      expect((await join(await createUser(), t.inviteCode, 1)).status).toBe(400);
    });

    it.each([
      ['0 part', 0],
      ['parts négatives', -2],
      ['parts décimales', 1.5],
      ['parts en texte', 'beaucoup'],
    ])('parts invalides (%s) → 400', async (_l, parts) => {
      const creator = await createUser();
      const t = await createTontineAs(creator, { totalParts: 5 });
      expect((await join(await createUser(), t.inviteCode, parts as any)).status).toBe(400);
    });

    it('CONCURRENCE : adhésions simultanées ne dépassent jamais le nombre de parts', async () => {
      const creator = await createUser();
      const t = await createTontineAs(creator, { totalParts: 3 });
      const users = await Promise.all(Array.from({ length: 5 }, () => createUser()));
      const res = await Promise.all(users.map((u) => join(u, t.inviteCode)));
      expect(res.filter((r) => r.status === 200)).toHaveLength(2);
      const members = await TontineMember.find({ tontineId: t._id });
      expect(members.reduce((s, m) => s + m.parts, 0)).toBe(3);
    });

    it('adhésions fermées une fois la tontine démarrée', async () => {
      const { tontineId } = await startedTontine(1, { totalParts: 3 });
      const t = await Tontine.findById(tontineId);
      expect((await join(await createUser(), t!.inviteCode)).status).toBe(400);
    });

    it('SÉCURITÉ : brute-force du code d’invitation limité (429)', async () => {
      const u = await createUser();
      let last = 0;
      for (let i = 0; i < 16; i++) {
        last = (
          await as(u, { ip: '198.51.100.9' })
            .post('/tontines/join')
            .send({ inviteCode: `X${i}`, displayName: 'x' })
        ).status;
      }
      expect(last).toBe(429);
    });
  });

  // ------------------------------------------------------------- droits d'accès
  describe('Droits d’accès (IDOR)', () => {
    it('un non-membre ne voit ni détails, ni membres, ni messages', async () => {
      const creator = await createUser();
      const t = await createTontineAs(creator);
      const outsider = await createUser();
      for (const u of [
        `/tontines/${t._id}`,
        `/tontines/${t._id}/members`,
        `/tontines/${t._id}/messages`,
      ]) {
        expect((await as(outsider).get(u)).status).toBe(403);
      }
    });

    it('seul le créateur peut modifier, démarrer, supprimer, exporter, voir les reçus, lancer un vote', async () => {
      const creator = await createUser();
      const t = await createTontineAs(creator);
      const member = await createUser();
      await join(member, t.inviteCode);
      expect((await as(member).patch(`/tontines/${t._id}`).send({ name: 'pirate' })).status).toBe(
        403,
      );
      expect((await as(member).post(`/tontines/${t._id}/start`)).status).toBe(403);
      expect((await as(member).delete(`/tontines/${t._id}`)).status).toBe(403);
      expect((await as(member).get(`/tontines/${t._id}/export`)).status).toBe(403);
      expect((await as(member).get(`/tontines/${t._id}/contributions`)).status).toBe(403);
      expect(
        (
          await as(member)
            .post(`/tontines/${t._id}/votes`)
            .send({ question: 'q', options: ['a', 'b'], durationHours: 1 })
        ).status,
      ).toBe(403);
    });

    it('SÉCURITÉ : le créateur d’une tontine A ne peut PAS retirer un membre d’une tontine B', async () => {
      const attacker = await createUser();
      const tA = await createTontineAs(attacker);
      const victimCreator = await createUser();
      const tB = await createTontineAs(victimCreator);
      const victim = await createUser();
      const vm = (await join(victim, tB.inviteCode)).body.data;
      const res = await as(attacker).delete(`/tontines/${tA._id}/members/${vm._id}`);
      expect([403, 404]).toContain(res.status);
      expect(await TontineMember.findById(vm._id)).not.toBeNull();
    });

    it('SÉCURITÉ : auto-débit modifiable seulement par le membre lui-même ou le créateur', async () => {
      const { tontineId, members } = await startedTontine(2);
      const m0 = await TontineMember.findOne({ tontineId, userId: members[0]._id });
      expect(
        (
          await as(members[1])
            .patch(`/tontines/${tontineId}/members/${m0!._id}/auto-debit/toggle`)
            .send({ enabled: false })
        ).status,
      ).toBe(403);
      expect(
        (
          await as(members[0])
            .patch(`/tontines/${tontineId}/members/${m0!._id}/auto-debit/toggle`)
            .send({ enabled: false })
        ).status,
      ).toBe(200);
    });

    it('routes admin réservées aux admins', async () => {
      const user = await createUser();
      expect((await as(user).get('/tontines/admin/all')).status).toBe(403);
      expect((await as(await createAdmin()).get('/tontines/admin/all')).status).toBe(200);
    });

    it('sans authentification → 401', async () => {
      expect((await anon().get('/tontines')).status).toBe(401);
    });
  });

  // ------------------------------------------------------------- modification / suppression
  describe('Modification et suppression', () => {
    it('modifie les champs autorisés ; refuse les champs système', async () => {
      const creator = await createUser();
      const t = await createTontineAs(creator);
      expect(
        (
          await as(creator)
            .patch(`/tontines/${t._id}`)
            .send({ name: 'Nouveau nom', contributionAmount: 5000 })
        ).status,
      ).toBe(200);
      for (const f of [{ status: 'active' }, { currentTurn: 3 }, { inviteCode: 'X' }]) {
        expect((await as(creator).patch(`/tontines/${t._id}`).send(f)).status).toBe(400);
      }
    });

    it('SÉCURITÉ : impossible de falsifier le total collecté du fonds social', async () => {
      const creator = await createUser();
      const t = await createTontineAs(creator, { socialFund: { enabled: true, amount: 1000 } });
      await as(creator)
        .patch(`/tontines/${t._id}`)
        .send({ socialFund: { enabled: true, amount: 1000, totalCollected: 500000 } });
      expect((await Tontine.findById(t._id))!.socialFund!.totalCollected).toBe(0);
    });

    it('une fois active : montant, devise, parts, fréquence et fonds social figés', async () => {
      const { creator, tontineId } = await startedTontine(1, { totalParts: 2 });
      for (const f of [
        { contributionAmount: 1 },
        { totalParts: 9 },
        { frequency: 'weekly' },
        { socialFund: { enabled: true, amount: 99999 } },
      ]) {
        expect((await as(creator).patch(`/tontines/${tontineId}`).send(f)).status).toBe(400);
      }
    });

    it('supprimer une tontine "pending" rembourse le fonds social déjà payé', async () => {
      const creator = await createUser({ walletBalance: 5000 });
      const t = await createTontineAs(creator, { socialFund: { enabled: true, amount: 1000 } });
      const m = await createUser({ walletBalance: 5000 });
      await join(m, t.inviteCode);
      expect((await as(m).post(`/tontines/${t._id}/social-fund/pay`)).status).toBe(200);
      expect(await balanceOf(m)).toBe(4000);
      expect((await as(creator).delete(`/tontines/${t._id}`)).status).toBe(200);
      expect(await balanceOf(m)).toBe(5000);
      expect(await Tontine.findById(t._id)).toBeNull();
    });
  });

  // ------------------------------------------------------------- fonds social
  describe('Fonds social', () => {
    it('paiement unique, débité du wallet, comptabilisé ; démarrage bloqué tant que tous n’ont pas payé', async () => {
      const creator = await createUser({ walletBalance: 5000 });
      const t = await createTontineAs(creator, { socialFund: { enabled: true, amount: 1000 } });
      const m = await createUser({ walletBalance: 5000 });
      await join(m, t.inviteCode);

      expect((await as(m).post(`/tontines/${t._id}/social-fund/pay`)).status).toBe(200);
      expect((await as(m).post(`/tontines/${t._id}/social-fund/pay`)).status).toBe(400);
      expect(await balanceOf(m)).toBe(4000);
      expect((await as(creator).post(`/tontines/${t._id}/start`)).status).toBe(400); // créateur pas encore payé
      await as(creator).post(`/tontines/${t._id}/social-fund/pay`);
      expect((await as(creator).post(`/tontines/${t._id}/start`)).status).toBe(200);
      expect((await Tontine.findById(t._id))!.socialFund!.totalCollected).toBe(2000);
    });

    it('CONCURRENCE : double paiement simultané → un seul débit', async () => {
      const creator = await createUser();
      const t = await createTontineAs(creator, { socialFund: { enabled: true, amount: 1000 } });
      const m = await createUser({ walletBalance: 5000 });
      await join(m, t.inviteCode);
      await Promise.all([
        as(m).post(`/tontines/${t._id}/social-fund/pay`),
        as(m).post(`/tontines/${t._id}/social-fund/pay`),
      ]);
      expect(await balanceOf(m)).toBe(4000);
    });

    it('solde insuffisant → 400 ; non-membre → 403 ; fonds non activé → 400', async () => {
      const creator = await createUser();
      const t = await createTontineAs(creator, { socialFund: { enabled: true, amount: 1000 } });
      const poor = await createUser({ walletBalance: 10 });
      await join(poor, t.inviteCode);
      expect((await as(poor).post(`/tontines/${t._id}/social-fund/pay`)).status).toBe(400);
      expect(
        (
          await as(await createUser({ walletBalance: 5000 })).post(
            `/tontines/${t._id}/social-fund/pay`,
          )
        ).status,
      ).toBe(403);
      const t2 = await createTontineAs(await createUser());
      expect(
        (await as(creator).post(`/tontines/${t2._id}/social-fund/pay`)).status,
      ).toBeGreaterThanOrEqual(400);
    });
  });

  // ------------------------------------------------------------- démarrage
  describe('Démarrage', () => {
    it('minimum 2 membres', async () => {
      const creator = await createUser();
      const t = await createTontineAs(creator);
      expect((await as(creator).post(`/tontines/${t._id}/start`)).status).toBe(400);
    });

    it('attribue un ordre de passage unique à chaque part et passe la tontine en "active"', async () => {
      const { tontineId } = await startedTontine(2);
      const t = await Tontine.findById(tontineId);
      expect(t!.status).toBe('active');
      const orders = (await TontineMember.find({ tontineId })).flatMap(
        (m: any) => m.rotationOrders ?? [m.rotationOrder],
      );
      expect(orders.sort()).toEqual([1, 2, 3]);
    });

    it('un membre avec 2 parts reçoit 2 tours ; le nombre de tours = parts réellement prises', async () => {
      const creator = await createPremium({ walletBalance: 100000 });
      const t = await createTontineAs(creator, { totalParts: 10 });
      const big = await createUser({ walletBalance: 100000 });
      await join(big, t.inviteCode, 2);
      await as(creator).post(`/tontines/${t._id}/start`);
      const db = await Tontine.findById(t._id);
      expect(db!.totalParts).toBe(3); // 1 (créateur) + 2 : plus de tours fantômes sans gagnant
      const bigMember: any = await TontineMember.findOne({ tontineId: t._id, userId: big._id });
      expect(bigMember.rotationOrders).toHaveLength(2);
    });

    it('rotation aléatoire : chaque part a exactement un tour', async () => {
      const { tontineId } = await startedTontine(4, { rotationMode: 'random' });
      const orders = (await TontineMember.find({ tontineId })).flatMap(
        (m: any) => m.rotationOrders,
      );
      expect(orders.sort((a: number, b: number) => a - b)).toEqual([1, 2, 3, 4, 5]);
    });
  });

  // ------------------------------------------------------------- cotisations par reçu
  describe('Cotisation par reçu (hors app)', () => {
    const contribute = (user: { _id: unknown }, tontineId: string) =>
      as(user)
        .post('/tontines/contribute')
        .field('tontineId', tontineId)
        .attach('receipt', pngReceipt(), { filename: 'recu.png', contentType: 'image/png' });

    it('reçu valide → cotisation en attente de validation, reçu stocké sur S3', async () => {
      const { tontineId, members } = await startedTontine(2);
      mockReceipt(10000);
      const res = await contribute(members[0], tontineId);
      expect(res.status).toBe(201);
      expect(res.body.data.validationStatus).toBe('manual_pending');
      expect(res.body.data.proofImage).toContain('/kauri-uploads/tontines/');
    });

    it('montant insuffisant → 400', async () => {
      const { tontineId, members } = await startedTontine(2);
      mockReceipt(9999);
      expect((await contribute(members[0], tontineId)).status).toBe(400);
    });

    it('IA indisponible (panne / quota) → cotisation NON bloquée : validation manuelle du créateur', async () => {
      const { GeminiService } = await import('../../src/services/ai/geminiService');
      jest.spyOn(GeminiService, 'generateJSON').mockRejectedValue(new Error('quota exceeded'));
      const { tontineId, members } = await startedTontine(2);
      const file = pngReceipt();
      const send = (u: { _id: unknown }) =>
        as(u)
          .post('/tontines/contribute')
          .field('tontineId', tontineId)
          .attach('receipt', file, { filename: 'r.png', contentType: 'image/png' });
      const res = await send(members[0]);
      expect(res.status).toBe(201);
      expect(res.body.data.validationStatus).toBe('manual_pending');
      expect(res.body.data.amountPaid).toBe(10000); // montant attendu, à vérifier par le créateur
      expect(res.body.data.aiAnalysis.confidence).toBe(0);
      // Sans lecture IA, le même reçu reste détecté comme doublon (empreinte du fichier).
      expect((await send(members[1])).status).toBe(400);
    });

    it('SÉCURITÉ : le même reçu ne peut pas servir deux fois', async () => {
      const { tontineId, members } = await startedTontine(2);
      const file = pngReceipt();
      mockReceipt(10000);
      const send = (u: { _id: unknown }) =>
        as(u)
          .post('/tontines/contribute')
          .field('tontineId', tontineId)
          .attach('receipt', file, { filename: 'r.png', contentType: 'image/png' });
      expect((await send(members[0])).status).toBe(201);
      expect((await send(members[1])).status).toBe(400);
    });

    it('SÉCURITÉ : fichier non-image déguisé (magic bytes) → rejeté', async () => {
      const { tontineId, members } = await startedTontine(2);
      const res = await as(members[0])
        .post('/tontines/contribute')
        .field('tontineId', tontineId)
        .attach('receipt', Buffer.from('<?php system($_GET[1]); ?>'), {
          filename: 'x.png',
          contentType: 'image/png',
        });
      expect(res.status).toBe(400);
    });

    it('non-membre → 403 ; sans reçu → 400', async () => {
      const { tontineId } = await startedTontine(2);
      mockReceipt(10000);
      expect((await contribute(await createUser(), tontineId)).status).toBe(403);
      const { members } = await startedTontine(2);
      expect((await as(members[0]).post('/tontines/contribute').send({ tontineId })).status).toBe(
        400,
      );
    });

    it('validation : seul le créateur, une seule fois ; rejet avec motif', async () => {
      const { creator, tontineId, members } = await startedTontine(2);
      mockReceipt(10000);
      const c = (await contribute(members[0], tontineId)).body.data;
      expect(
        (
          await as(members[1])
            .patch(`/tontines/${tontineId}/contributions/${c._id}/validate`)
            .send({ decision: 'approve' })
        ).status,
      ).toBe(403);
      expect(
        (
          await as(creator)
            .patch(`/tontines/${tontineId}/contributions/${c._id}/validate`)
            .send({ decision: 'maybe' })
        ).status,
      ).toBe(400);
      expect(
        (
          await as(creator)
            .patch(`/tontines/${tontineId}/contributions/${c._id}/validate`)
            .send({ decision: 'approve' })
        ).status,
      ).toBe(200);
      expect(
        (
          await as(creator)
            .patch(`/tontines/${tontineId}/contributions/${c._id}/validate`)
            .send({ decision: 'reject' })
        ).status,
      ).toBe(400);
    });

    it('SÉCURITÉ ARGENT : une cotisation hors app validée n’est JAMAIS créditée sur le wallet du gagnant', async () => {
      const { creator, tontineId, members } = await startedTontine(2, {}, 0);
      // Tous les membres sans auto-débit : seules des preuves hors app
      await TontineMember.updateMany({ tontineId }, { isAutoDebitEnabled: false });
      mockReceipt(10000);
      for (const m of members) {
        const c = (await contribute(m, tontineId)).body.data;
        await as(creator)
          .patch(`/tontines/${tontineId}/contributions/${c._id}/validate`)
          .send({ decision: 'approve' });
      }
      await as(creator).post(`/tontines/${tontineId}/rotation/next`);
      // Aucun argent n'est entré dans Kauri : personne ne doit pouvoir en retirer
      for (const u of [creator, ...members]) expect(await balanceOf(u)).toBe(0);
    });
  });

  // ------------------------------------------------------------- auto-débit + rotation
  describe('Auto-débit et rotation (argent wallet)', () => {
    it('cycle complet : prélèvements, versement du gagnant moins 1 % de frais, clôture au dernier tour', async () => {
      const { tontineId, all } = await startedTontine(2, {}, 50000);
      for (let turn = 1; turn <= 3; turn++) {
        await TontineService.processAutoDebits();
        const winner: any = (await TontineMember.find({ tontineId })).find((m: any) =>
          m.rotationOrders.includes(turn),
        );
        const before = await balanceOf({ _id: winner.userId });
        await TontineService.rotateTurn(tontineId);
        expect((await balanceOf({ _id: winner.userId })) - before).toBe(30000 - 300);
      }
      expect((await Tontine.findById(tontineId))!.status).toBe('completed');
      // chaque membre a cotisé 3 × 10 000 et reçu 29 700 une fois
      for (const u of all) expect(await balanceOf(u)).toBe(50000 - 30000 + 29700);
    });

    it('auto-débit idempotent : relancer le job ne prélève pas deux fois le même tour', async () => {
      const { tontineId, members } = await startedTontine(2, {}, 50000);
      await TontineService.processAutoDebits();
      await TontineService.processAutoDebits();
      await Promise.all([TontineService.processAutoDebits(), TontineService.processAutoDebits()]);
      expect(await balanceOf(members[0])).toBe(40000);
      expect(await TontineContribution.countDocuments({ tontineId, turnIndex: 1 })).toBe(3);
    });

    it('rotation idempotente : deux rotations simultanées ne paient le tour qu’une fois', async () => {
      const { tontineId, all } = await startedTontine(2, {}, 50000);
      await TontineService.processAutoDebits();
      await Promise.allSettled([
        TontineService.rotateTurn(tontineId),
        TontineService.rotateTurn(tontineId),
      ]);
      const payouts = await Transaction.countDocuments({ category: 'tontine_payout' });
      expect(payouts).toBe(1);
      const total = (await Promise.all(all.map(balanceOf))).reduce((a, b) => a + b, 0);
      expect(total).toBe(150000 - 300); // seul le 1 % de frais a quitté les wallets
    });

    it('membre sans solde : son auto-débit échoue sans bloquer les autres', async () => {
      const { tontineId, members } = await startedTontine(2, {}, 50000);
      await User.updateOne({ _id: members[0]._id }, { walletBalance: 0 });
      await TontineService.processAutoDebits();
      expect(await TontineContribution.countDocuments({ tontineId, turnIndex: 1 })).toBe(2);
      expect(await balanceOf(members[1])).toBe(40000);
    });

    it('auto-débit désactivé → pas de prélèvement', async () => {
      const { tontineId, members } = await startedTontine(2, {}, 50000);
      await TontineMember.updateOne(
        { tontineId, userId: members[0]._id },
        { isAutoDebitEnabled: false },
      );
      await TontineService.processAutoDebits();
      expect(await balanceOf(members[0])).toBe(50000);
    });

    it('cagnotte > 50 000 XAF : le versement interne n’est pas bloqué par le plafond AML', async () => {
      const { tontineId, all } = await startedTontine(5, { contributionAmount: 20000 }, 50000);
      await TontineService.processAutoDebits();
      const updated = await TontineService.rotateTurn(tontineId);
      expect(updated.currentTurn).toBe(2);
      const winner: any = (await TontineMember.find({ tontineId })).find((m: any) =>
        m.rotationOrders.includes(1),
      );
      expect(await balanceOf({ _id: winner.userId })).toBe(50000 - 20000 + 120000 - 1200);
      expect(all).toHaveLength(6);
    });

    it('rotation manuelle : créateur uniquement, tontine active uniquement', async () => {
      const { creator, members, tontineId } = await startedTontine(2);
      expect((await as(members[0]).post(`/tontines/${tontineId}/rotation/next`)).status).toBe(403);
      expect((await as(creator).post(`/tontines/${tontineId}/rotation/next`)).status).toBe(200);
      const pending = await createTontineAs(await createUser());
      expect((await as(creator).post(`/tontines/${pending._id}/rotation/next`)).status).toBe(403);
    });

    it('frais d’absence : membre sans auto-débit et sans cotisation après le délai de grâce', async () => {
      const { tontineId, members } = await startedTontine(
        2,
        { sanctions: { absenceFee: 1000, gracePeriodHours: 1, lateFee: 0 } },
        50000,
      );
      await TontineMember.updateOne(
        { tontineId, userId: members[0]._id },
        { isAutoDebitEnabled: false },
      );
      await Tontine.updateOne(
        { _id: tontineId },
        { startDate: new Date(Date.now() - 3 * 3600000) },
      );
      await TontineService.applyAbsenceFees(tontineId);
      await TontineService.applyAbsenceFees(tontineId);
      expect(await balanceOf(members[0])).toBe(49000);
      expect((await TontineMember.findOne({ tontineId, userId: members[0]._id }))!.trustScore).toBe(
        90,
      );
    });

    it('fin de cycle avec renouvellement automatique → nouvelle tontine "pending" avec les mêmes membres', async () => {
      const { tontineId } = await startedTontine(1, { totalParts: 2, autoRenew: true }, 50000);
      await TontineService.rotateTurn(tontineId);
      await TontineService.rotateTurn(tontineId);
      const renewed = await Tontine.findOne({ _id: { $ne: tontineId }, name: 'Tontine des amis' });
      expect(renewed!.status).toBe('pending');
      expect(await TontineMember.countDocuments({ tontineId: renewed!._id })).toBe(2);
    });
  });

  // ------------------------------------------------------------- limites du plan du créateur
  describe('Plan du créateur', () => {
    it('un créateur GRATUIT garde sa tontine active (sa seule tontine autorisée)', async () => {
      const creator = await createUser({ walletBalance: 50000 });
      const t = await createTontineAs(creator);
      await join(await createUser(), t.inviteCode);
      await as(creator).post(`/tontines/${t._id}/start`);
      expect((await as(creator).get(`/tontines/${t._id}`)).status).toBe(200);
      expect((await Tontine.findById(t._id))!.status).toBe('active');
    });
  });

  // ------------------------------------------------------------- votes
  describe('Votes', () => {
    it('créer, voter une fois, refuser un second vote et une option invalide', async () => {
      const { creator, members, tontineId } = await startedTontine(2);
      const v = (
        await as(creator)
          .post(`/tontines/${tontineId}/votes`)
          .send({ question: 'Exclure X ?', options: ['Oui', 'Non'], durationHours: 24 })
      ).body.data;
      expect(
        (
          await as(members[0])
            .post(`/tontines/${tontineId}/votes/${v._id}`)
            .send({ optionIndex: 0 })
        ).status,
      ).toBe(200);
      expect(
        (
          await as(members[0])
            .post(`/tontines/${tontineId}/votes/${v._id}`)
            .send({ optionIndex: 1 })
        ).status,
      ).toBe(400);
      expect(
        (
          await as(members[1])
            .post(`/tontines/${tontineId}/votes/${v._id}`)
            .send({ optionIndex: 5 })
        ).status,
      ).toBe(400);
      expect(
        (
          await as(await createUser())
            .post(`/tontines/${tontineId}/votes/${v._id}`)
            .send({ optionIndex: 0 })
        ).status,
      ).toBe(403);
    });

    it('CONCURRENCE : votes simultanés du même membre → compté une seule fois', async () => {
      const { creator, members, tontineId } = await startedTontine(2);
      const v = (
        await as(creator)
          .post(`/tontines/${tontineId}/votes`)
          .send({ question: 'q', options: ['a', 'b'], durationHours: 1 })
      ).body.data;
      await Promise.all(
        Array.from({ length: 5 }, () =>
          as(members[0]).post(`/tontines/${tontineId}/votes/${v._id}`).send({ optionIndex: 0 }),
        ),
      );
      const total = (await import('../../src/models/TontineVote')).default;
      const db = await total.findById(v._id);
      expect(db!.options[0].count).toBe(1);
    });

    it.each([
      ['options absentes', { question: 'q', durationHours: 1 }],
      ['une seule option', { question: 'q', options: ['a'], durationHours: 1 }],
      ['durée invalide', { question: 'q', options: ['a', 'b'], durationHours: 'x' }],
      ['question vide', { question: '', options: ['a', 'b'], durationHours: 1 }],
    ])('vote invalide (%s) → 400', async (_l, body) => {
      const { creator, tontineId } = await startedTontine(1, { totalParts: 2 });
      expect((await as(creator).post(`/tontines/${tontineId}/votes`).send(body)).status).toBe(400);
    });

    it('liste des votes : membres uniquement, "déjà voté" par membre, secret du vote préservé', async () => {
      const { creator, members, tontineId } = await startedTontine(2);
      const v = (
        await as(creator)
          .post(`/tontines/${tontineId}/votes`)
          .send({ kind: 'closure', durationHours: 24 })
      ).body.data;
      // 3 membres acceptés (créateur + 2) → majorité absolue = 2
      expect(v).toMatchObject({ majority: 2, hasVoted: false, votersCount: 0 });
      expect(v.voters).toBeUndefined();
      const cast = await as(members[0])
        .post(`/tontines/${tontineId}/votes/${v._id}`)
        .send({ optionIndex: 1 });
      expect(cast.status).toBe(200);
      expect(cast.body.data).toMatchObject({ hasVoted: true, votersCount: 1, majority: 2 });
      expect(cast.body.data.voters).toBeUndefined();
      const mine = await as(members[0]).get(`/tontines/${tontineId}/votes`);
      expect(mine.status).toBe(200);
      expect(mine.body.data[0]).toMatchObject({ kind: 'closure', hasVoted: true, votersCount: 1 });
      expect(mine.body.data[0].voters).toBeUndefined();
      expect(JSON.stringify(mine.body)).not.toContain(String(members[0]._id));
      expect((await as(members[1]).get(`/tontines/${tontineId}/votes`)).body.data[0].hasVoted).toBe(
        false,
      );
      expect((await as(await createUser()).get(`/tontines/${tontineId}/votes`)).status).toBe(403);
    });

    it('vote expiré → plus de vote possible', async () => {
      const { creator, members, tontineId } = await startedTontine(2);
      const v = (
        await as(creator)
          .post(`/tontines/${tontineId}/votes`)
          .send({ question: 'q', options: ['a', 'b'], durationHours: 1 })
      ).body.data;
      const TontineVote = (await import('../../src/models/TontineVote')).default;
      await TontineVote.updateOne({ _id: v._id }, { expiresAt: new Date(Date.now() - 1000) });
      expect(
        (
          await as(members[0])
            .post(`/tontines/${tontineId}/votes/${v._id}`)
            .send({ optionIndex: 0 })
        ).status,
      ).toBe(400);
    });
  });

  // ------------------------------------------------------------- messagerie & export
  describe('Messagerie et export', () => {
    it('les membres échangent des messages ; un non-membre ne peut ni lire ni écrire', async () => {
      const { members, tontineId } = await startedTontine(2);
      expect(
        (
          await as(members[0])
            .post(`/tontines/${tontineId}/messages`)
            .send({ content: 'Bonjour !' })
        ).status,
      ).toBe(201);
      const list = await as(members[1]).get(`/tontines/${tontineId}/messages`);
      expect(list.body.data[0].content).toBe('Bonjour !');
      expect(
        (
          await as(await createUser())
            .post(`/tontines/${tontineId}/messages`)
            .send({ content: 'spam' })
        ).status,
      ).toBe(403);
    });

    it('message vide ou démesuré → 400', async () => {
      const { members, tontineId } = await startedTontine(2);
      expect(
        (await as(members[0]).post(`/tontines/${tontineId}/messages`).send({ content: '' })).status,
      ).toBe(400);
      expect(
        (
          await as(members[0])
            .post(`/tontines/${tontineId}/messages`)
            .send({ content: 'x'.repeat(5001) })
        ).status,
      ).toBe(400);
    });

    it('export CSV du créateur ; SÉCURITÉ : pas d’injection de formule tableur', async () => {
      const { creator, tontineId } = await startedTontine(1, { totalParts: 2 }, 50000);
      await TontineMember.updateMany(
        { tontineId, userId: { $ne: creator._id } },
        { displayName: '=HYPERLINK("http://evil","x")' },
      );
      await TontineService.processAutoDebits();
      const res = await as(creator).get(`/tontines/${tontineId}/export`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/csv/);
      expect(res.text).not.toMatch(/(^|[",\n])=HYPERLINK/);
    });
  });
  // ------------------------------------------------------------- clôture en cours de cycle
  describe('Clôture d’une tontine active (vote des membres ou admin)', () => {
    const closureVote = (u: { _id: unknown }, tontineId: string) =>
      as(u).post(`/tontines/${tontineId}/votes`).send({ kind: 'closure', durationHours: 48 });
    const vote = (u: { _id: unknown }, tontineId: string, voteId: string, optionIndex: number) =>
      as(u).post(`/tontines/${tontineId}/votes/${voteId}`).send({ optionIndex });

    it('SÉCURITÉ : le créateur seul ne peut plus clôturer une tontine en cours', async () => {
      const { creator, tontineId } = await startedTontine(2);
      expect((await as(creator).delete(`/tontines/${tontineId}`)).status).toBe(400);
      expect((await Tontine.findById(tontineId))!.status).toBe('active');
    });

    it('vote de clôture : n’importe quel membre peut le lancer ; la majorité absolue clôture', async () => {
      const { creator, members, tontineId } = await startedTontine(3, {}, 50000); // 4 membres
      const v = (await closureVote(members[0], tontineId)).body.data;
      expect(v.kind).toBe('closure');
      expect(v.options.map((o: any) => o.text)).toHaveLength(2);
      await vote(members[0], tontineId, v._id, 0);
      await vote(members[1], tontineId, v._id, 0);
      expect((await Tontine.findById(tontineId))!.status).toBe('active'); // 2/4 : pas encore majorité
      await vote(creator, tontineId, v._id, 0);
      expect((await Tontine.findById(tontineId))!.status).toBe('completed');
      expect((await TontineVote.findById(v._id))!.outcome).toBe('approved');
      // plus aucun prélèvement après clôture
      await TontineService.processAutoDebits();
      expect(await balanceOf(members[2])).toBe(50000);
    });

    it('majorité contre → la tontine continue, le vote est clos "rejected"', async () => {
      const { creator, members, tontineId } = await startedTontine(2); // 3 membres
      const v = (await closureVote(creator, tontineId)).body.data;
      await vote(members[0], tontineId, v._id, 1);
      await vote(members[1], tontineId, v._id, 1);
      expect((await Tontine.findById(tontineId))!.status).toBe('active');
      expect((await TontineVote.findById(v._id))!.outcome).toBe('rejected');
    });

    it('un seul vote de clôture ouvert à la fois ; impossible sur une tontine non démarrée', async () => {
      const { members, tontineId } = await startedTontine(2);
      expect((await closureVote(members[0], tontineId)).status).toBe(201);
      expect((await closureVote(members[1], tontineId)).status).toBe(400);
      const creator = await createUser();
      const pending = await createTontineAs(creator);
      expect((await closureVote(creator, pending._id)).status).toBe(400);
    });

    it('admin : clôture avec motif obligatoire, tracée dans le journal d’audit ; interdite aux non-admins', async () => {
      const { creator, tontineId } = await startedTontine(2);
      const admin = await createAdmin();
      expect(
        (
          await as(creator)
            .post(`/tontines/admin/${tontineId}/close`)
            .send({ reason: 'Litige membres' })
        ).status,
      ).toBe(403);
      expect((await as(admin).post(`/tontines/admin/${tontineId}/close`).send({})).status).toBe(
        400,
      );
      expect(
        (
          await as(admin)
            .post(`/tontines/admin/${tontineId}/close`)
            .send({ reason: 'Litige entre membres' })
        ).status,
      ).toBe(200);
      expect((await Tontine.findById(tontineId))!.status).toBe('completed');
      expect(
        await AuditLog.countDocuments({
          action: 'TONTINE_ADMIN_CLOSE',
          resourceId: String(tontineId),
        }),
      ).toBe(1);
      expect(
        (
          await as(admin)
            .post(`/tontines/admin/${tontineId}/close`)
            .send({ reason: 'Encore une fois' })
        ).status,
      ).toBe(404);
    });
  });

  // ------------------------------------------------------------- confidentialité des reçus
  describe('Confidentialité des reçus et notes vocales', () => {
    it('le reçu est stocké en privé et n’est servi que par URL signée temporaire', async () => {
      const { creator, members, tontineId } = await startedTontine(2);
      mockReceipt(10000);
      const res = await as(members[0])
        .post('/tontines/contribute')
        .field('tontineId', tontineId)
        .attach('receipt', pngReceipt(), { filename: 'recu.png', contentType: 'image/png' });
      expect(res.body.data.proofImage).toMatch(/X-Amz-Signature=/);
      const stored = await TontineContribution.findById(res.body.data._id);
      expect(stored!.proofImage).not.toMatch(/X-Amz-Signature=/); // la base garde l'URL d'objet, jamais une signature
      const list = await as(creator).get(`/tontines/${tontineId}/contributions`);
      const signed = list.body.data[0].proofImage as string;
      expect(signed).toMatch(/X-Amz-Expires=3600/);
      expect((await fetch(signed)).status).toBe(200);
    });

    it('la vue admin des reçus est signée aussi', async () => {
      const { members, tontineId } = await startedTontine(2);
      mockReceipt(10000);
      await as(members[0])
        .post('/tontines/contribute')
        .field('tontineId', tontineId)
        .attach('receipt', pngReceipt(), { filename: 'recu.png', contentType: 'image/png' });
      const res = await as(await createAdmin()).get(`/tontines/admin/all/${tontineId}`);
      expect(res.body.data.contributions[0].proofImage).toMatch(/X-Amz-Signature=/);
    });
  });

  // ------------------------------------------------------------- migration des tontines existantes
  describe('Migration des tontines démarrées avec l’ancien algorithme', () => {
    /** Reproduit l'état produit par l'ANCIEN startTontine : 1 tour par membre, totalParts = parts annoncées. */
    async function legacyTontine() {
      const c = await createUser({ walletBalance: 100000 });
      const b = await createUser({ walletBalance: 100000 });
      const t = await Tontine.create({
        name: 'Ancienne',
        creatorId: c._id,
        frequency: 'monthly',
        startDate: new Date(),
        contributionAmount: 10000,
        currency: 'XAF',
        totalParts: 5,
        status: 'active',
        currentTurn: 4,
      });
      const mc = await TontineMember.create({
        tontineId: t._id,
        userId: c._id,
        displayName: 'C',
        parts: 1,
        invitationStatus: 'accepted',
        rotationOrder: 1,
      });
      const mb = await TontineMember.create({
        tontineId: t._id,
        userId: b._id,
        displayName: 'B',
        parts: 2,
        invitationStatus: 'accepted',
        rotationOrder: 2,
      });
      // Tour 3 : personne n'avait ce tour, mais les auto-débits ont prélevé quand même
      await TontineContribution.create([
        {
          tontineId: t._id,
          memberId: mc._id,
          turnIndex: 3,
          amountPaid: 10000,
          currency: 'XAF',
          validationStatus: 'completed',
        },
        {
          tontineId: t._id,
          memberId: mb._id,
          turnIndex: 3,
          amountPaid: 20000,
          currency: 'XAF',
          validationStatus: 'completed',
        },
        // un reçu hors app sur ce tour n'est PAS remboursé (Kauri n'a jamais eu l'argent)
      ]);
      return { t, c, b, mb };
    }

    it('simulation : décrit la réparation sans rien modifier', async () => {
      const { t } = await legacyTontine();
      const report = await repairTontineRotations({ apply: false });
      expect(report).toHaveLength(1);
      expect(report[0]).toMatchObject({ oldTotalParts: 5, newTotalParts: 4, completed: false });
      expect(report[0].refunded.map((r) => r.amount).sort()).toEqual([10000, 20000]);
      expect((await Tontine.findById(t._id))!.totalParts).toBe(5);
    });

    it('application : tour supplémentaire au membre à 2 parts, remboursement du tour orphelin, une seule fois', async () => {
      const { t, c, b, mb } = await legacyTontine();
      await repairTontineRotations({ apply: true });
      expect(((await TontineMember.findById(mb._id)) as any).rotationOrders).toEqual([2, 4]);
      expect((await Tontine.findById(t._id))!.totalParts).toBe(4);
      expect(await balanceOf(c)).toBe(110000);
      expect(await balanceOf(b)).toBe(120000);

      const again = await repairTontineRotations({ apply: true });
      expect(again).toHaveLength(0);
      expect(await balanceOf(b)).toBe(120000);

      // le tour 4 a maintenant un bénéficiaire
      await TontineService.processAutoDebits();
      await TontineService.rotateTurn(String(t._id));
      expect((await Tontine.findById(t._id))!.status).toBe('completed');
    });

    it('tontine déjà réparée ou démarrée avec le nouvel algorithme → ignorée', async () => {
      await startedTontine(2);
      expect(await repairTontineRotations({ apply: false })).toHaveLength(0);
    });
  });
  // ------------------------------------------------------------- règlement de fin
  describe('Règlement à la fin d’une tontine (aucun argent bloqué)', () => {
    it('clôture admin en cours de cycle : cotisations du tour non versé remboursées, dette du gagnant signalée', async () => {
      const { tontineId, all } = await startedTontine(2, {}, 50000); // 3 membres
      await TontineService.processAutoDebits();
      const winner: any = (await TontineMember.find({ tontineId })).find((m: any) =>
        m.rotationOrders.includes(1),
      );
      await TontineService.rotateTurn(tontineId); // tour 1 versé (29 700 net)
      await TontineService.processAutoDebits(); // tour 2 prélevé, pas encore versé
      for (const u of all) {
        const isWinner = String(u._id) === String(winner.userId);
        expect(await balanceOf(u)).toBe(isWinner ? 50000 - 20000 + 29700 : 30000);
      }

      const admin = await createAdmin();
      const res = await as(admin)
        .post(`/tontines/admin/${tontineId}/close`)
        .send({ reason: 'Litige entre membres' });
      expect(res.status).toBe(200);

      // Chaque membre récupère sa cotisation du tour 2 : seul le 1 % de frais est sorti.
      for (const u of all) {
        const isWinner = String(u._id) === String(winner.userId);
        expect(await balanceOf(u)).toBe(isWinner ? 69700 : 40000);
      }
      expect(await Transaction.countDocuments({ category: 'tontine_refund' })).toBe(3);
      const audit: any = await AuditLog.findOne({
        action: 'TONTINE_SETTLEMENT',
        resourceId: String(tontineId),
      });
      // Il a touché 29 700 net (frais déduits) pour 10 000 cotisés.
      expect(audit.metadata.debts).toEqual([{ userId: String(winner.userId), amount: 19700 }]);
    });

    it('fonds social rendu à la fin normale du cycle ; règlement idempotent', async () => {
      const creator = await createPremium({ walletBalance: 50000 });
      const t = await createTontineAs(creator, {
        totalParts: 2,
        socialFund: { enabled: true, amount: 1000 },
      });
      const m = await createUser({ walletBalance: 50000 });
      await join(m, t.inviteCode);
      for (const u of [creator, m]) {
        expect((await as(u).post(`/tontines/${t._id}/social-fund/pay`)).status).toBe(200);
      }
      expect((await as(creator).post(`/tontines/${t._id}/start`)).status).toBe(200);
      for (let turn = 1; turn <= 2; turn++) {
        await TontineService.processAutoDebits();
        await TontineService.rotateTurn(t._id);
      }
      const done = (await Tontine.findById(t._id))!;
      expect(done.status).toBe('completed');
      expect(done.socialFund!.totalCollected).toBe(0);
      // cotisé 2 × 10 000, reçu 19 800, fonds social 1 000 rendu
      for (const u of [creator, m]) expect(await balanceOf(u)).toBe(50000 - 20000 + 19800);

      await TontineService.settleEndedTontine(t._id, 'rejeu');
      for (const u of [creator, m]) expect(await balanceOf(u)).toBe(49800);
      expect(await Transaction.countDocuments({ category: 'tontine_refund' })).toBe(2);
    });

    it('vote de clôture : les cotisations du tour en cours sont rendues', async () => {
      const { creator, members, tontineId, all } = await startedTontine(2, {}, 50000);
      await TontineService.processAutoDebits(); // tour 1 prélevé, non versé
      const v = (
        await as(members[0])
          .post(`/tontines/${tontineId}/votes`)
          .send({ kind: 'closure', durationHours: 48 })
      ).body.data;
      for (const u of [members[0], creator]) {
        await as(u).post(`/tontines/${tontineId}/votes/${v._id}`).send({ optionIndex: 0 });
      }
      expect((await Tontine.findById(tontineId))!.status).toBe('completed');
      for (const u of all) expect(await balanceOf(u)).toBe(50000);
    });
  });
});
