/**
 * Suite « sécurité & non-régression » — rejoue, contre l'application réelle (supertest) et une
 * vraie MongoDB, les scénarios corrigés lors de l'audit pré-production d'octobre 2026.
 * Chaque test protège une faille ou un bug réel : s'il casse, une régression de sécurité
 * vient d'être introduite.
 */
import crypto from 'node:crypto';
import request from 'supertest';
import mongoose from 'mongoose';

// Firebase est simulé (aucun appel réseau) : on pilote ce que « verifyIdToken » renvoie.
let nextFirebaseClaims: Record<string, unknown> = {};
jest.mock('../../src/config/firebase', () => ({
  __esModule: true,
  default: { auth: () => ({ verifyIdToken: async () => nextFirebaseClaims }) },
}));

import app from '../../src/app';
import User from '../../src/models/User';
import redis from '../../src/config/redis';
import Country from '../../src/models/Country';
import { AuthService } from '../../src/services/authService';

// bcrypt (coût 12) + imports dynamiques de la suppression de compte : le délai par défaut de 5 s est trop juste en CI.
jest.setTimeout(30000);

const API = '/api/v1';
const PW = 'Str0ng!Passw0rd';
const ADMIN_ORIGIN = 'https://admin.kauri-app.com';
let seq = 0;
const uniqueEmail = (p: string) => `${p}.${Date.now()}.${seq++}@example.com`;
// Chaque test a sa propre « IP » (trust proxy = 1) pour ne pas partager les limiteurs.
const ip = () => `10.${(seq >> 8) & 255}.${seq & 255}.${(seq * 7) & 255}`;

async function register(prefix: string, extra: Record<string, unknown> = {}) {
  const email = uniqueEmail(prefix);
  const res = await request(app)
    .post(`${API}/auth/register`)
    .set('X-Forwarded-For', ip())
    .send({ email, password: PW, firstName: 'Sec', lastName: 'Test', country: 'CM', ...extra });
  return { email, res, tokens: res.body?.data?.tokens, id: res.body?.data?.user?._id };
}
function login(email: string, password = PW, extra: Record<string, unknown> = {}) {
  return request(app)
    .post(`${API}/auth/login`)
    .set('X-Forwarded-For', ip())
    .send({ email, password, ...extra });
}

beforeAll(async () => {
  process.env.SWAGGER_USER = 'docs';
  process.env.SWAGGER_PASSWORD = 'a-long-swagger-password';
  // Base dédiée : les autres suites font `User.deleteMany({})` sur la base par défaut, en parallèle.
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/kauri_test', {
    dbName: 'kauri_test_security',
  });
  // seedCountries() ne tourne qu'au démarrage du serveur : on sème le pays requis à l'inscription.
  await Country.updateOne(
    { code: 'CM' },
    { $set: { name: 'Cameroun', currency: 'XAF', currencySymbol: 'FCFA', isActive: true } },
    { upsert: true },
  );
});
afterAll(async () => {
  await User.deleteMany({ email: /@example\.com$/ });
  await mongoose.connection.close(true);
  if (redis.status === 'ready' || redis.status === 'connect') redis.disconnect();
});

describe('Sessions & jetons', () => {
  it('deux connexions simultanées reçoivent des refresh tokens DIFFÉRENTS (jti)', async () => {
    const { email } = await register('jti');
    const [a, b] = await Promise.all([
      login(email, PW, { deviceId: 'A' }),
      login(email, PW, { deviceId: 'B' }),
    ]);
    expect(a.body.data.tokens.refreshToken).not.toBe(b.body.data.tokens.refreshToken);
  });

  it('la réinitialisation du mot de passe révoque TOUTES les sessions', async () => {
    const { email } = await register('reset');
    const a = await login(email, PW, { deviceId: 'A' });
    const b = await login(email, PW, { deviceId: 'B' });

    const raw = crypto.randomBytes(32).toString('hex');
    await User.updateOne(
      { email },
      {
        passwordResetToken: crypto.createHash('sha256').update(raw).digest('hex'),
        passwordResetExpires: new Date(Date.now() + 600_000),
      },
    );
    const reset = await request(app)
      .patch(`${API}/auth/reset-password/${raw}`)
      .set('X-Forwarded-For', ip())
      .send({ password: 'N3w!Passw0rd#2' });
    expect(reset.status).toBe(200);

    for (const t of [a, b]) {
      const r = await request(app)
        .post(`${API}/auth/refresh`)
        .set('X-Forwarded-For', ip())
        .send({ refreshToken: t.body.data.tokens.refreshToken });
      expect(r.status).toBe(401);
    }
    const fresh = await request(app)
      .post(`${API}/auth/refresh`)
      .set('X-Forwarded-For', ip())
      .send({ refreshToken: reset.body.data.tokens.refreshToken });
    expect(fresh.status).toBe(200);
  });

  it('le changement de mot de passe déconnecte les AUTRES appareils seulement', async () => {
    const { email } = await register('chg');
    const a = await login(email, PW, { deviceId: 'A' });
    const b = await login(email, PW, { deviceId: 'B' });
    const change = await request(app)
      .patch(`${API}/auth/change-password`)
      .set('Authorization', `Bearer ${a.body.data.tokens.accessToken}`)
      .set('X-Forwarded-For', ip())
      .send({
        currentPassword: PW,
        newPassword: 'Ch4nged!Pass#9',
        refreshToken: a.body.data.tokens.refreshToken,
      });
    expect(change.status).toBe(200);

    const other = await request(app)
      .post(`${API}/auth/refresh`)
      .set('X-Forwarded-For', ip())
      .send({ refreshToken: b.body.data.tokens.refreshToken });
    const current = await request(app)
      .post(`${API}/auth/refresh`)
      .set('X-Forwarded-For', ip())
      .send({ refreshToken: a.body.data.tokens.refreshToken });
    expect(other.status).toBe(401);
    expect(current.status).toBe(200);
  });

  it('un compte désactivé ne peut plus rafraîchir sa session', async () => {
    const { email } = await register('deact');
    const l = await login(email);
    await User.updateOne({ email }, { isActive: false });
    const r = await request(app)
      .post(`${API}/auth/refresh`)
      .set('X-Forwarded-For', ip())
      .send({ refreshToken: l.body.data.tokens.refreshToken });
    expect(r.status).toBe(401);
  });

  it('verrouille le compte après 10 échecs, même avec le bon mot de passe', async () => {
    const { email } = await register('lock');
    for (let i = 0; i < 10; i++) await login(email, `Wrong!Pass${i}`);
    const r = await login(email, PW);
    expect(r.status).toBe(429);
  });
});

describe('Client navigateur (cookies) : pas de jeton dans le JSON + anti-CSRF', () => {
  it('login web : aucun jeton dans le corps, cookies httpOnly', async () => {
    const { email } = await register('web');
    const r = await login(email, PW).set('X-Client-Type', 'web');
    expect(r.status).toBe(200);
    expect(r.body.data.tokens).toBeUndefined();
    const cookies = (r.headers['set-cookie'] as unknown as string[]).join(';');
    expect(cookies).toMatch(/access_token=.*HttpOnly/i);
    expect(cookies).toMatch(/refresh_token=.*HttpOnly/i);
  });

  it('refresh par cookie avec un corps vide fonctionne et ne renvoie pas de jeton', async () => {
    const { email } = await register('cookie');
    const agent = request.agent(app);
    await agent
      .post(`${API}/auth/login`)
      .set('X-Forwarded-For', ip())
      .set('X-Client-Type', 'web')
      .send({ email, password: PW });
    const r = await agent
      .post(`${API}/auth/refresh`)
      .set('X-Forwarded-For', ip())
      .set('X-Client-Type', 'web')
      .set('Origin', ADMIN_ORIGIN)
      .send({});
    expect(r.status).toBe(200);
    expect(r.body.data.tokens).toBeUndefined();
  });

  it('CSRF : mutation par cookie sans Origin / avec origine étrangère = 403 ; origine admin = 200', async () => {
    const { email } = await register('csrf');
    const agent = request.agent(app);
    await agent
      .post(`${API}/auth/login`)
      .set('X-Forwarded-For', ip())
      .set('X-Client-Type', 'web')
      .send({ email, password: PW });

    const noOrigin = await agent.patch(`${API}/auth/language`).send({ language: 'en' });
    const evil = await agent
      .patch(`${API}/auth/language`)
      .set('Origin', 'https://evil.example')
      .send({ language: 'en' });
    const ok = await agent
      .patch(`${API}/auth/language`)
      .set('Origin', ADMIN_ORIGIN)
      .send({ language: 'en' });
    expect(noOrigin.status).toBe(403);
    expect(evil.status).toBe(403);
    expect(ok.status).toBe(200);
  });

  it('un client mobile (Bearer) n’est pas soumis au contrôle d’origine', async () => {
    const { tokens } = await register('bearer');
    const r = await request(app)
      .patch(`${API}/auth/language`)
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .set('X-Forwarded-For', ip())
      .send({ language: 'en' });
    expect(r.status).toBe(200);
  });

  it('CORS : l’origine admin est autorisée (X-Client-Type) ; une origine étrangère ne l’est pas', async () => {
    const good = await request(app)
      .options(`${API}/auth/me`)
      .set('Origin', ADMIN_ORIGIN)
      .set('Access-Control-Request-Method', 'PATCH')
      .set('Access-Control-Request-Headers', 'x-client-type,content-type');
    expect(good.headers['access-control-allow-origin']).toBe(ADMIN_ORIGIN);
    expect(good.headers['access-control-allow-headers']).toMatch(/x-client-type/i);

    const bad = await request(app)
      .options(`${API}/auth/me`)
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'GET');
    expect(bad.headers['access-control-allow-origin']).not.toBe('https://evil.example');
  });
});

describe('Profil & suppression de compte', () => {
  it('PATCH /auth/me valide chaque champ (pays, devise, langue, revenu, préférences)', async () => {
    const { tokens } = await register('me');
    const patch = (b: object) =>
      request(app)
        .patch(`${API}/auth/me`)
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .set('X-Forwarded-For', ip())
        .send(b);

    expect((await patch({ country: 'FR' })).status).toBe(400);
    expect((await patch({ currency: 'USD' })).status).toBe(400);
    expect((await patch({ language: 'klingon' })).status).toBe(400);
    expect((await patch({ monthlyIncome: -5 })).status).toBe(400);
    expect((await patch({ preferences: { coachTone: 'evil' } })).status).toBe(400);
    expect((await patch({ preferences: { budgetAlertThreshold: 500 } })).status).toBe(400);
    expect(
      (
        await patch({
          firstName: 'Awa',
          language: 'en',
          monthlyIncome: 150000,
          preferences: { coachTone: 'firm', budgetAlertThreshold: 70 },
        })
      ).status,
    ).toBe(200);
  });

  it('delete-me exige le mot de passe, puis efface le compte', async () => {
    const { email, tokens } = await register('del');
    const del = (body?: object) =>
      request(app)
        .delete(`${API}/auth/delete-me`)
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .set('X-Forwarded-For', ip())
        .send(body);

    expect((await del()).status).toBe(400);
    expect((await del({ password: 'wrong' })).status).toBe(401);
    expect(await User.countDocuments({ email })).toBe(1);
    expect((await del({ password: PW })).status).toBe(200);
    expect(await User.countDocuments({ email })).toBe(0);
  });

  it('resend-verification ne révèle pas si le compte existe', async () => {
    const { email } = await register('rv');
    const known = await request(app)
      .post(`${API}/auth/resend-verification`)
      .set('X-Forwarded-For', ip())
      .send({ email });
    const unknown = await request(app)
      .post(`${API}/auth/resend-verification`)
      .set('X-Forwarded-For', ip())
      .send({ email: uniqueEmail('ghost') });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
  });
});

describe('Firebase : pas de pré-détournement de compte par téléphone', () => {
  it('un numéro NON vérifié enregistré par un tiers ne capte pas la connexion OTP de la victime', async () => {
    const phone = `+2376${String(Date.now()).slice(-8)}`;
    const attacker = await register('attacker', { phone });
    expect(attacker.res.status).toBe(201);

    nextFirebaseClaims = { uid: `victim-${Date.now()}`, phone_number: phone };
    const out = await AuthService.firebaseAuth('fake', { country: 'CM' });
    expect(String(out.user._id)).not.toBe(String(attacker.id));
    expect(out.isNewUser).toBe(true);
  });

  it('un numéro vérifié reste rapproché du bon compte', async () => {
    const phone = `+2376${String(Date.now() + 1).slice(-8)}`;
    const u = await User.create({
      email: uniqueEmail('legit'),
      password: PW,
      firstName: 'L',
      lastName: 'U',
      phone,
      isPhoneVerified: true,
      country: 'CM',
    });
    nextFirebaseClaims = { uid: `legit-${Date.now()}`, phone_number: phone };
    const out = await AuthService.firebaseAuth('fake', { country: 'CM' });
    expect(String(out.user._id)).toBe(String(u._id));
    expect(out.isNewUser).toBe(false);
  });
});

describe('Endpoints publics & infrastructure', () => {
  const prevKey = process.env.MOBILE_CLIENT_API_KEY;
  afterEach(() => {
    process.env.MOBILE_CLIENT_API_KEY = prevKey;
    if (prevKey === undefined) delete process.env.MOBILE_CLIENT_API_KEY;
  });

  it('télémétrie : clé client obligatoire (401), corps limité à 2 Mo (413)', async () => {
    process.env.MOBILE_CLIENT_API_KEY = 'k3y-test';
    const denied = await request(app)
      .post(`${API}/system/telemetry/traces`)
      .set('Content-Type', 'application/x-protobuf')
      .send(Buffer.alloc(100, 1));
    expect(denied.status).toBe(401);

    const tooBig = await request(app)
      .post(`${API}/system/telemetry/traces`)
      .set('Content-Type', 'application/x-protobuf')
      .set('X-Client-Key', 'k3y-test')
      .send(Buffer.alloc(3 * 1024 * 1024, 1));
    expect(tooBig.status).toBe(413);
  });

  it('/metrics : une IPv6 finissant par ::1 (usurpée) n’est PAS autorisée', async () => {
    const spoof = await request(app).get('/metrics').set('X-Forwarded-For', '2001:db8::1');
    expect(spoof.status).toBe(403);
    const withToken = await request(app)
      .get('/metrics')
      .set('X-Forwarded-For', '2001:db8::1')
      .set('Authorization', `Bearer ${process.env.METRICS_TOKEN}`);
    expect(withToken.status).toBe(200);
  });

  it('webhooks : signatures invalides rejetées (Stripe 400, NotchPay 401)', async () => {
    const stripe = await request(app)
      .post(`${API}/webhooks/stripe`)
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 't=1,v1=bad')
      .send('{"id":"evt"}');
    expect(stripe.status).toBe(400);

    const notchpay = await request(app)
      .post(`${API}/webhooks/notchpay`)
      .set('Content-Type', 'application/json')
      .set('x-notchpay-signature', 'deadbeef')
      .send('{"event":"payment.complete"}');
    expect(notchpay.status).toBe(401);
  });

  it('JSON malformé -> 400 (et non 500)', async () => {
    const r = await request(app)
      .post(`${API}/auth/login`)
      .set('Content-Type', 'application/json')
      .set('X-Forwarded-For', ip())
      .send('{bad json');
    expect(r.status).toBe(400);
  });

  it('Swagger protégé par authentification', async () => {
    const r = await request(app).get('/api-docs/json');
    expect(r.status).toBe(401);
  });

  it('Digital Asset Links : 404 tant que les empreintes ne sont pas configurées', async () => {
    const r = await request(app).get('/.well-known/assetlinks.json');
    expect(r.status).toBe(404);
  });
});
