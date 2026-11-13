/**
 * MODULE AUTH — tests d'API de bout en bout (HTTP → contrôleur → service → MongoDB réel).
 *
 * Couvre tous les cas d'usage de /api/v1/auth : inscription, connexion (mobile & web
 * cookie-only), verrouillage de compte, refresh avec rotation, logout + blacklist,
 * mot de passe oublié / réinitialisation, vérification d'email, profil, sessions
 * multi-appareils, changement de mot de passe, 2FA TOTP admin, suppression de compte RGPD.
 */
import { useTestDB } from '../helpers/db';
import { api, anon, as } from '../helpers/http';
import {
  STRONG_PASSWORD,
  accessTokenFor,
  createAdmin,
  createUser,
  uniqueEmail,
} from '../helpers/factories';
import { totpCode } from '../helpers/totp';
import jwt from 'jsonwebtoken';
import User from '../../src/models/User';
import Country from '../../src/models/Country';
import Budget from '../../src/models/Budget';
import Payment from '../../src/models/Payment';
import { EmailService } from '../../src/services/emailService';

jest.setTimeout(30000);

describe('API /auth', () => {
  useTestDB();

  const register = (body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    anon()
      .post('/auth/register', { headers })
      .send({
        email: uniqueEmail(),
        password: STRONG_PASSWORD,
        firstName: 'Awa',
        lastName: 'Ngono',
        ...body,
      });

  const login = (
    email: string,
    password = STRONG_PASSWORD,
    extra: Record<string, unknown> = {},
    ip?: string,
  ) => api('post', '/auth/login', { ip }).send({ email, password, ...extra });

  // Capture des liens envoyés par email (aucun email réel n'est émis en test)
  let mailbox: { kind: string; to: string; token: string }[];
  beforeEach(() => {
    mailbox = [];
    jest.spyOn(EmailService, 'sendVerificationEmail').mockImplementation(async (to, token) => {
      mailbox.push({ kind: 'verify', to, token });
    });
    jest.spyOn(EmailService, 'sendPasswordResetEmail').mockImplementation(async (to, token) => {
      mailbox.push({ kind: 'reset', to, token });
    });
  });

  // ---------------------------------------------------------------- inscription
  describe('POST /auth/register', () => {
    it('crée le compte, renvoie user + tokens, ne fuit aucun secret', async () => {
      const email = uniqueEmail();
      const res = await register({ email });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.user.email).toBe(email);
      expect(res.body.data.tokens.accessToken).toEqual(expect.any(String));
      expect(res.body.data.tokens.refreshToken).toEqual(expect.any(String));
      const u = res.body.data.user;
      for (const secret of [
        'password',
        'refreshToken',
        'emailVerificationToken',
        'passwordResetToken',
      ]) {
        expect(u).not.toHaveProperty(secret);
      }
      expect(u.role).toBe('user');
      expect(u.isEmailVerified).toBe(false);
      expect(u.walletBalance).toBe(0);
      expect(mailbox).toEqual([expect.objectContaining({ kind: 'verify', to: email })]);
    });

    it('stocke le mot de passe haché (bcrypt), jamais en clair', async () => {
      const email = uniqueEmail();
      await register({ email });
      const db = await User.findOne({ email }).select('+password');
      expect(db!.password).not.toBe(STRONG_PASSWORD);
      expect(db!.password).toMatch(/^\$2[aby]\$/);
    });

    it('pose les cookies httpOnly et, pour un client web, ne met PAS les tokens dans le JSON', async () => {
      const res = await register({}, { 'X-Client-Type': 'web' });
      expect(res.status).toBe(201);
      expect(res.body.data.tokens).toBeUndefined();
      const cookies = ([] as string[]).concat(res.headers['set-cookie'] || []);
      expect(cookies.some((c) => /^access_token=.+HttpOnly/i.test(c))).toBe(true);
      expect(cookies.some((c) => /^refresh_token=.+HttpOnly/i.test(c))).toBe(true);
    });

    it('refuse un email déjà utilisé (409)', async () => {
      const email = uniqueEmail();
      await register({ email });
      const res = await register({ email });
      expect(res.status).toBe(409);
    });

    it('refuse un email déjà utilisé même avec une casse différente', async () => {
      const email = uniqueEmail();
      await register({ email });
      const res = await register({ email: email.toUpperCase() });
      expect(res.status).toBe(409);
    });

    it.each([
      ['email manquant', { email: undefined }],
      ['email invalide', { email: 'pas-un-email' }],
      ['mot de passe trop court', { password: 'Ab1!' }],
      ['mot de passe sans majuscule', { password: 'password123!' }],
      ['mot de passe sans chiffre', { password: 'Password!!' }],
      ['mot de passe sans caractère spécial', { password: 'Password123' }],
      ['prénom manquant', { firstName: undefined }],
      ['nom manquant', { lastName: undefined }],
      ['code pays sur 3 lettres', { country: 'CMR' }],
    ])('valide les entrées : %s → 400', async (_label, body) => {
      const res = await register(body as Record<string, unknown>);
      expect(res.status).toBe(400);
    });

    it('refuse un pays non supporté', async () => {
      const res = await register({ country: 'ZZ' });
      expect(res.status).toBe(400);
    });

    it('déduit la devise du pays choisi', async () => {
      await Country.create({
        code: 'SN',
        name: 'Sénégal',
        currency: 'XOF',
        currencySymbol: 'CFA',
        isActive: true,
      });
      const res = await register({ country: 'sn' });
      expect(res.status).toBe(201);
      expect(res.body.data.user.country).toBe('SN');
      expect(res.body.data.user.currency).toBe('XOF');
    });

    it('SÉCURITÉ : ignore les champs privilégiés envoyés par le client (mass assignment)', async () => {
      const email = uniqueEmail();
      const res = await register({
        email,
        role: 'admin',
        walletBalance: 1_000_000,
        isEmailVerified: true,
        kycLevel: 'verified',
        subscription: { plan: 'business', status: 'active' },
      });
      expect(res.status).toBe(201);
      const db = await User.findOne({ email });
      expect(db!.role).toBe('user');
      expect(db!.walletBalance).toBe(0);
      expect(db!.isEmailVerified).toBe(false);
      expect(db!.kycLevel).toBe('none');
      expect(db!.subscription?.plan ?? 'free').toBe('free');
    });
  });

  // ---------------------------------------------------------------- connexion
  describe('POST /auth/login', () => {
    it('connecte avec les bons identifiants et ouvre une session', async () => {
      const user = await createUser();
      const res = await login(user.email, STRONG_PASSWORD, {
        deviceId: 'pixel-8',
        deviceInfo: { model: 'Pixel 8', os: 'Android', osVersion: '15', platform: 'android' },
        appVersion: '4.0.1',
      });
      expect(res.status).toBe(200);
      expect(res.body.data.tokens.accessToken).toEqual(expect.any(String));
      const db = await User.findById(user._id);
      expect(db!.sessions).toHaveLength(1);
      expect(db!.sessions[0].deviceId).toBe('pixel-8');
      expect(db!.lastLogin).toBeInstanceOf(Date);
    });

    it('accepte l’email quelle que soit sa casse', async () => {
      const user = await createUser();
      const res = await login(user.email.toUpperCase());
      expect(res.status).toBe(200);
    });

    it('mauvais mot de passe → 401 avec message générique', async () => {
      const user = await createUser();
      const res = await login(user.email, 'WrongPassword1!');
      expect(res.status).toBe(401);
      expect(res.body.message).toBe('E-mail ou mot de passe incorrect.'); // traduit (fr par défaut)
    });

    it('email inconnu → MÊME réponse qu’un mauvais mot de passe (pas d’énumération)', async () => {
      const res = await login(uniqueEmail());
      expect(res.status).toBe(401);
      expect(res.body.message).toBe('E-mail ou mot de passe incorrect.'); // traduit (fr par défaut)
    });

    it('compte social sans mot de passe → 401, jamais de crash', async () => {
      const user = await createUser({ password: null, firebaseUid: 'fb-123' });
      const res = await login(user.email);
      expect(res.status).toBe(401);
    });

    it('compte désactivé → impossible d’accéder aux routes protégées', async () => {
      const user = await createUser({ isActive: false });
      const res = await as(user).get('/auth/me');
      expect(res.status).toBe(403);
      expect(res.body.code ?? res.body.errorCode ?? 'ACCOUNT_DEACTIVATED').toBe(
        'ACCOUNT_DEACTIVATED',
      );
    });

    it('SÉCURITÉ : verrouille le compte après 10 échecs, même depuis des IP différentes', async () => {
      const user = await createUser();
      for (let i = 0; i < 10; i++) {
        const r = await login(user.email, 'WrongPassword1!');
        expect(r.status).toBe(401);
      }
      // Le compteur est incrémenté de façon asynchrone : laisse l'event loop finir
      await new Promise((r) => setImmediate(r));
      const locked = await login(user.email, STRONG_PASSWORD);
      expect(locked.status).toBe(429);
    });

    it('SÉCURITÉ : une connexion réussie remet le compteur d’échecs à zéro', async () => {
      const user = await createUser();
      for (let i = 0; i < 9; i++) await login(user.email, 'WrongPassword1!');
      await new Promise((r) => setImmediate(r));
      expect((await login(user.email)).status).toBe(200);
      await new Promise((r) => setImmediate(r));
      for (let i = 0; i < 9; i++) await login(user.email, 'WrongPassword1!');
      await new Promise((r) => setImmediate(r));
      expect((await login(user.email)).status).toBe(200);
    });

    it('limite à 3 sessions simultanées (la plus ancienne est évincée)', async () => {
      const user = await createUser();
      const tokens: string[] = [];
      for (const d of ['d1', 'd2', 'd3', 'd4']) {
        const r = await login(user.email, STRONG_PASSWORD, { deviceId: d });
        tokens.push(r.body.data.tokens.refreshToken);
        await new Promise((r) => setTimeout(r, 5));
      }
      const db = await User.findById(user._id);
      expect(db!.sessions.map((s) => s.deviceId)).toEqual(['d2', 'd3', 'd4']);
      // la session évincée ne peut plus rafraîchir
      expect((await anon().post('/auth/refresh').send({ refreshToken: tokens[0] })).status).toBe(
        401,
      );
      expect((await anon().post('/auth/refresh').send({ refreshToken: tokens[3] })).status).toBe(
        200,
      );
    });

    it('se reconnecter depuis le même appareil réutilise la session (pas de doublon)', async () => {
      const user = await createUser();
      await login(user.email, STRONG_PASSWORD, { deviceId: 'same' });
      await login(user.email, STRONG_PASSWORD, { deviceId: 'same' });
      const db = await User.findById(user._id);
      expect(db!.sessions).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------- jetons
  describe('Jetons d’accès (middleware protect)', () => {
    it('sans jeton → 401', async () => {
      expect((await anon().get('/auth/me')).status).toBe(401);
    });

    it('accepte le jeton via le cookie access_token (admin web)', async () => {
      const user = await createUser();
      const res = await api('get', '/auth/me', {
        headers: { Cookie: `access_token=${accessTokenFor(user)}` },
      });
      expect(res.status).toBe(200);
      expect(res.body.data.user.email).toBe(user.email);
    });

    it('SÉCURITÉ : jeton expiré → 401', async () => {
      const user = await createUser();
      const res = await as(user, { token: accessTokenFor(user, { expiresIn: -10 }) }).get(
        '/auth/me',
      );
      expect(res.status).toBe(401);
    });

    it('SÉCURITÉ : jeton signé avec un autre secret → 401', async () => {
      const user = await createUser();
      const forged = jwt.sign({ id: String(user._id) }, 'attacker-secret-attacker-secret-xx');
      expect((await as(null, { token: forged }).get('/auth/me')).status).toBe(401);
    });

    it('SÉCURITÉ : jeton "alg: none" → 401', async () => {
      const user = await createUser();
      const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ id: String(user._id) })}.`;
      expect((await as(null, { token: none }).get('/auth/me')).status).toBe(401);
    });

    it('SÉCURITÉ : un refresh token n’est pas accepté comme access token', async () => {
      const user = await createUser();
      const r = await login(user.email);
      const res = await as(null, { token: r.body.data.tokens.refreshToken }).get('/auth/me');
      expect(res.status).toBe(401);
    });

    it('SÉCURITÉ : jeton d’un utilisateur supprimé → 401', async () => {
      const user = await createUser();
      const token = accessTokenFor(user);
      await User.deleteOne({ _id: user._id });
      expect((await as(null, { token }).get('/auth/me')).status).toBe(401);
    });
  });

  // ---------------------------------------------------------------- refresh
  describe('POST /auth/refresh', () => {
    it('émet une nouvelle paire et fait tourner le refresh token (l’ancien est invalidé)', async () => {
      const user = await createUser();
      const { refreshToken } = (await login(user.email, STRONG_PASSWORD, { deviceId: 'a' })).body
        .data.tokens;
      await new Promise((r) => setTimeout(r, 1100)); // iat différent → jeton différent

      const r1 = await anon().post('/auth/refresh').send({ refreshToken });
      expect(r1.status).toBe(200);
      const next = r1.body.data.tokens.refreshToken;
      expect(next).not.toBe(refreshToken);

      expect((await anon().post('/auth/refresh').send({ refreshToken })).status).toBe(401);
      expect((await anon().post('/auth/refresh').send({ refreshToken: next })).status).toBe(200);
    });

    it('accepte le refresh token en cookie (admin web) et ne le renvoie pas dans le JSON', async () => {
      const user = await createUser();
      const { refreshToken } = (await login(user.email)).body.data.tokens;
      const res = await api('post', '/auth/refresh', {
        headers: {
          Cookie: `refresh_token=${refreshToken}`,
          'X-Client-Type': 'web',
          Origin: 'http://localhost:5173',
        },
      }).send({});
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({});
      expect(
        ([] as string[])
          .concat(res.headers['set-cookie'])
          .some((c) => c.startsWith('access_token=')),
      ).toBe(true);
    });

    it.each([
      ['origine malveillante', { Origin: 'https://evil.example.com' }],
      ['sans origine ni referer', {}],
      ['referer malveillant', { Referer: 'https://evil.example.com/page' }],
    ])('SÉCURITÉ CSRF : requête cookie-only %s → 403', async (_l, extra) => {
      const user = await createUser();
      const { refreshToken } = (await login(user.email)).body.data.tokens;
      const res = await api('post', '/auth/refresh', {
        headers: { Cookie: `refresh_token=${refreshToken}`, ...(extra as Record<string, string>) },
      }).send({});
      expect(res.status).toBe(403);
    });

    it.each([
      ['absent', undefined],
      ['malformé', 'abc.def.ghi'],
      ['signé avec le secret d’accès', 'ACCESS'],
    ])('refresh token %s → 401', async (_l, tok) => {
      const user = await createUser();
      const refreshToken = tok === 'ACCESS' ? accessTokenFor(user) : tok;
      expect((await anon().post('/auth/refresh').send({ refreshToken })).status).toBe(401);
    });

    it('compte désactivé → refresh refusé', async () => {
      const user = await createUser();
      const { refreshToken } = (await login(user.email)).body.data.tokens;
      await User.updateOne({ _id: user._id }, { isActive: false });
      expect((await anon().post('/auth/refresh').send({ refreshToken })).status).toBe(401);
    });
  });

  // ---------------------------------------------------------------- logout
  describe('POST /auth/logout', () => {
    it('ferme la session, blackliste l’access token et invalide le refresh token', async () => {
      const user = await createUser();
      const { accessToken, refreshToken } = (
        await login(user.email, STRONG_PASSWORD, { deviceId: 'x' })
      ).body.data.tokens;

      const out = await as(null, { token: accessToken })
        .post('/auth/logout')
        .send({ refreshToken });
      expect(out.status).toBe(200);

      expect((await as(null, { token: accessToken }).get('/auth/me')).status).toBe(401);
      expect((await anon().post('/auth/refresh').send({ refreshToken })).status).toBe(401);
      expect((await User.findById(user._id))!.sessions).toHaveLength(0);
    });

    it('ne déconnecte que l’appareil courant', async () => {
      const user = await createUser();
      const a = (await login(user.email, STRONG_PASSWORD, { deviceId: 'A' })).body.data.tokens;
      const b = (await login(user.email, STRONG_PASSWORD, { deviceId: 'B' })).body.data.tokens;
      await as(null, { token: a.accessToken })
        .post('/auth/logout')
        .send({ refreshToken: a.refreshToken });
      expect((await as(null, { token: b.accessToken }).get('/auth/me')).status).toBe(200);
      expect(
        (await anon().post('/auth/refresh').send({ refreshToken: b.refreshToken })).status,
      ).toBe(200);
    });
  });

  // ---------------------------------------------------------------- mot de passe oublié
  describe('Mot de passe oublié / réinitialisation', () => {
    it('parcours complet : demande → email → reset → ancien mdp refusé, nouveau accepté', async () => {
      const user = await createUser();
      const req = await anon().post('/auth/forgot-password').send({ email: user.email });
      expect(req.status).toBe(200);
      const mail = mailbox.find((m) => m.kind === 'reset');
      expect(mail?.to).toBe(user.email);

      const res = await anon()
        .patch(`/auth/reset-password/${mail!.token}`)
        .send({ password: 'NewPassw0rd!' });
      expect(res.status).toBe(200);

      expect((await login(user.email)).status).toBe(401);
      expect((await login(user.email, 'NewPassw0rd!')).status).toBe(200);
    });

    it('le lien de réinitialisation est à usage unique', async () => {
      const user = await createUser();
      await anon().post('/auth/forgot-password').send({ email: user.email });
      const { token } = mailbox.find((m) => m.kind === 'reset')!;
      expect(
        (await anon().patch(`/auth/reset-password/${token}`).send({ password: 'NewPassw0rd!' }))
          .status,
      ).toBe(200);
      expect(
        (await anon().patch(`/auth/reset-password/${token}`).send({ password: 'Other0Pass!' }))
          .status,
      ).toBe(400);
    });

    it('le lien expire après 10 minutes', async () => {
      const user = await createUser();
      await anon().post('/auth/forgot-password').send({ email: user.email });
      const { token } = mailbox.find((m) => m.kind === 'reset')!;
      await User.updateOne(
        { _id: user._id },
        { passwordResetExpires: new Date(Date.now() - 1000) },
      );
      expect(
        (await anon().patch(`/auth/reset-password/${token}`).send({ password: 'NewPassw0rd!' }))
          .status,
      ).toBe(400);
    });

    it('le reset déconnecte TOUS les appareils (refresh tokens révoqués)', async () => {
      const user = await createUser();
      const old = (await login(user.email, STRONG_PASSWORD, { deviceId: 'stolen' })).body.data
        .tokens;
      await anon().post('/auth/forgot-password').send({ email: user.email });
      const { token } = mailbox.find((m) => m.kind === 'reset')!;
      await anon().patch(`/auth/reset-password/${token}`).send({ password: 'NewPassw0rd!' });
      expect(
        (await anon().post('/auth/refresh').send({ refreshToken: old.refreshToken })).status,
      ).toBe(401);
    });

    it('SÉCURITÉ : le reset invalide aussi les access tokens déjà émis', async () => {
      const user = await createUser();
      const old = (await login(user.email)).body.data.tokens;
      await new Promise((r) => setTimeout(r, 1100));
      await anon().post('/auth/forgot-password').send({ email: user.email });
      const { token } = mailbox.find((m) => m.kind === 'reset')!;
      await anon().patch(`/auth/reset-password/${token}`).send({ password: 'NewPassw0rd!' });
      expect((await as(null, { token: old.accessToken }).get('/auth/me')).status).toBe(401);
    });

    it('email inconnu → même réponse 200, aucun email envoyé (pas d’énumération)', async () => {
      const res = await anon().post('/auth/forgot-password').send({ email: uniqueEmail() });
      expect(res.status).toBe(200);
      expect(mailbox).toHaveLength(0);
    });

    it('nouveau mot de passe faible → 400', async () => {
      const user = await createUser();
      await anon().post('/auth/forgot-password').send({ email: user.email });
      const { token } = mailbox.find((m) => m.kind === 'reset')!;
      expect(
        (await anon().patch(`/auth/reset-password/${token}`).send({ password: 'faible' })).status,
      ).toBe(400);
    });

    it('SÉCURITÉ : injection d’opérateur MongoDB dans l’email → aucun compte ciblé', async () => {
      const victim = await createUser();
      const res = await anon()
        .post('/auth/forgot-password')
        .send({ email: { $ne: null } });
      expect([200, 400]).toContain(res.status);
      expect(mailbox).toHaveLength(0);
      const db = await User.findById(victim._id);
      expect(db!.passwordResetToken).toBeUndefined();
    });

    it('SÉCURITÉ : la page de redirection du lien refuse un token non hexadécimal (XSS)', async () => {
      const res = await anon().get('/auth/reset-password/"><script>alert(1)</script>');
      expect(res.text).not.toContain('<script>alert(1)</script>');
    });
  });

  // ---------------------------------------------------------------- vérification email
  describe('Vérification de l’email', () => {
    it('le lien reçu à l’inscription vérifie le compte', async () => {
      const email = uniqueEmail();
      await register({ email });
      const { token } = mailbox.find((m) => m.kind === 'verify')!;
      const res = await anon().get(`/auth/verify-email?token=${token}`);
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/vérifié/i);
      expect((await User.findOne({ email }))!.isEmailVerified).toBe(true);
    });

    it('lien invalide ou absent → page d’erreur 400', async () => {
      expect((await anon().get('/auth/verify-email?token=deadbeef')).status).toBe(400);
      expect((await anon().get('/auth/verify-email')).status).toBe(400);
      expect((await anon().get('/auth/verify-email?token[$ne]=x')).status).toBe(400);
    });

    it('lien expiré (24 h) → 400', async () => {
      const email = uniqueEmail();
      await register({ email });
      const { token } = mailbox.find((m) => m.kind === 'verify')!;
      await User.updateOne({ email }, { emailVerificationExpires: new Date(Date.now() - 1) });
      expect((await anon().get(`/auth/verify-email?token=${token}`)).status).toBe(400);
    });

    it('renvoi : nouveau lien pour un compte non vérifié, silencieux sinon', async () => {
      const email = uniqueEmail();
      await register({ email });
      mailbox.length = 0;
      expect((await anon().post('/auth/resend-verification').send({ email })).status).toBe(200);
      expect(mailbox).toHaveLength(1);

      const verified = await createUser({ isEmailVerified: true });
      expect(
        (await anon().post('/auth/resend-verification').send({ email: verified.email })).status,
      ).toBe(200);
      expect(
        (await anon().post('/auth/resend-verification').send({ email: uniqueEmail() })).status,
      ).toBe(200);
      expect(mailbox).toHaveLength(1);
    });

    it('SÉCURITÉ : injection d’opérateur dans resend-verification → aucun email', async () => {
      await register({});
      mailbox.length = 0;
      await anon()
        .post('/auth/resend-verification')
        .send({ email: { $gt: '' } });
      expect(mailbox).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------- profil
  describe('Profil /auth/me', () => {
    it('GET renvoie le profil sans secrets', async () => {
      const user = await createUser();
      const res = await as(user).get('/auth/me');
      expect(res.status).toBe(200);
      expect(res.body.data.user._id ?? res.body.data.user.id).toBe(String(user._id));
      expect(res.body.data.user.password).toBeUndefined();
      expect(res.body.data.user.sessions?.[0]?.refreshToken).toBeUndefined();
    });

    it('PATCH met à jour prénom, nom, téléphone, revenu, préférences', async () => {
      const user = await createUser();
      const res = await as(user)
        .patch('/auth/me')
        .send({
          firstName: '  Boris ',
          lastName: 'Kamga',
          phone: '+237 690 00 00 00',
          monthlyIncome: 250000,
          preferences: { coachTone: 'kind_auntie', budgetAlertThreshold: 90 },
        });
      expect(res.status).toBe(200);
      const db = await User.findById(user._id);
      expect(db!.firstName).toBe('Boris');
      expect(db!.monthlyIncome).toBe(250000);
      expect(db!.preferences!.coachTone).toBe('kind_auntie');
      expect(db!.preferences!.notificationFrequency).toBe('medium');
      expect(db!.preferences!.budgetAlertThreshold).toBe(90);
      expect(db!.isPhoneVerified).toBe(false);
    });

    it.each([
      ['prénom vide', { firstName: '  ' }],
      ['prénom > 60 caractères', { firstName: 'x'.repeat(61) }],
      ['téléphone invalide', { phone: 'abc' }],
      ['revenu négatif', { monthlyIncome: -1 }],
      ['revenu non numérique', { monthlyIncome: 'beaucoup' }],
      ['langue non supportée', { language: 'de' }],
      ['ton du coach inconnu', { preferences: { coachTone: 'sarcastic' } }],
      ['seuil d’alerte > 100', { preferences: { budgetAlertThreshold: 150 } }],
      ['changement de pays direct', { country: 'FR' }],
      ['changement de devise direct', { currency: 'EUR' }],
    ])('PATCH refuse : %s → 400', async (_l, body) => {
      const user = await createUser();
      expect((await as(user).patch('/auth/me').send(body)).status).toBe(400);
    });

    it('SÉCURITÉ : PATCH ignore role / walletBalance / email / kycLevel', async () => {
      const user = await createUser();
      await as(user).patch('/auth/me').send({
        role: 'admin',
        walletBalance: 999999,
        email: 'hijack@example.com',
        kycLevel: 'verified',
        isEmailVerified: false,
      });
      const db = await User.findById(user._id);
      expect(db!.role).toBe('user');
      expect(db!.walletBalance).toBe(0);
      expect(db!.email).toBe(user.email);
      expect(db!.kycLevel).toBe('none');
    });

    it('PATCH /auth/language change la langue', async () => {
      const user = await createUser();
      expect((await as(user).patch('/auth/language').send({ language: 'en' })).status).toBe(200);
      expect((await User.findById(user._id))!.language).toBe('en');
    });

    it('POST /auth/fcm-token enregistre un token sans doublon, refuse un token vide', async () => {
      const user = await createUser();
      await as(user).post('/auth/fcm-token').send({ fcmToken: 'tok-1' });
      await as(user).post('/auth/fcm-token').send({ fcmToken: 'tok-1' });
      expect((await User.findById(user._id))!.fcmTokens).toEqual(['tok-1']);
      expect((await as(user).post('/auth/fcm-token').send({})).status).toBe(400);
    });
  });

  // ---------------------------------------------------------------- sessions
  describe('Sessions multi-appareils', () => {
    it('liste les sessions avec infos appareil, sans refresh token', async () => {
      const user = await createUser();
      await login(user.email, STRONG_PASSWORD, {
        deviceId: 'iphone',
        deviceInfo: { model: 'iPhone 15', os: 'iOS', osVersion: '18.1', platform: 'ios' },
      });
      const res = await as(user).get('/auth/sessions');
      expect(res.status).toBe(200);
      expect(res.body.data.sessions).toEqual([
        expect.objectContaining({ deviceName: 'iPhone 15', os: 'iOS 18.1' }),
      ]);
      expect(JSON.stringify(res.body)).not.toMatch(/refreshToken/);
    });

    it('révoque une session précise : son refresh token ne marche plus', async () => {
      const user = await createUser();
      const a = (await login(user.email, STRONG_PASSWORD, { deviceId: 'A' })).body.data.tokens;
      await login(user.email, STRONG_PASSWORD, { deviceId: 'B' });
      const sessions = (await as(user).get('/auth/sessions')).body.data.sessions;
      const db = await User.findById(user._id);
      const sidA = String((db!.sessions.find((s) => s.deviceId === 'A') as any)._id);
      expect(sessions).toHaveLength(2);
      expect((await as(user).delete(`/auth/sessions/${sidA}`)).status).toBe(200);
      expect(
        (await anon().post('/auth/refresh').send({ refreshToken: a.refreshToken })).status,
      ).toBe(401);
      expect((await User.findById(user._id))!.sessions).toHaveLength(1);
    });

    it('SÉCURITÉ : impossible de révoquer la session d’un autre utilisateur', async () => {
      const victim = await createUser();
      const attacker = await createUser();
      const v = (await login(victim.email, STRONG_PASSWORD, { deviceId: 'V' })).body.data.tokens;
      const sid = String(((await User.findById(victim._id))!.sessions[0] as any)._id);
      await as(attacker).delete(`/auth/sessions/${sid}`);
      expect(
        (await anon().post('/auth/refresh').send({ refreshToken: v.refreshToken })).status,
      ).toBe(200);
    });

    it('révoquer toutes les sessions déconnecte tous les appareils', async () => {
      const user = await createUser();
      const a = (await login(user.email, STRONG_PASSWORD, { deviceId: 'A' })).body.data.tokens;
      const b = (await login(user.email, STRONG_PASSWORD, { deviceId: 'B' })).body.data.tokens;
      expect((await as(user).delete('/auth/sessions')).status).toBe(200);
      for (const t of [a, b]) {
        expect(
          (await anon().post('/auth/refresh').send({ refreshToken: t.refreshToken })).status,
        ).toBe(401);
      }
    });

    it('identifiant de session invalide → pas d’erreur 500', async () => {
      const user = await createUser();
      const res = await as(user).delete('/auth/sessions/not-an-id');
      expect(res.status).toBeLessThan(500);
    });
  });

  // ---------------------------------------------------------------- changement de mdp
  describe('PATCH /auth/change-password', () => {
    it('change le mot de passe et garde UNIQUEMENT la session courante', async () => {
      const user = await createUser();
      const here = (await login(user.email, STRONG_PASSWORD, { deviceId: 'here' })).body.data
        .tokens;
      const other = (await login(user.email, STRONG_PASSWORD, { deviceId: 'other' })).body.data
        .tokens;

      const res = await as(null, { token: here.accessToken }).patch('/auth/change-password').send({
        currentPassword: STRONG_PASSWORD,
        newPassword: 'Chang3d!Pass',
        refreshToken: here.refreshToken,
      });
      expect(res.status).toBe(200);

      expect((await login(user.email, 'Chang3d!Pass')).status).toBe(200);
      expect(
        (await anon().post('/auth/refresh').send({ refreshToken: other.refreshToken })).status,
      ).toBe(401);
      expect(
        (await anon().post('/auth/refresh').send({ refreshToken: here.refreshToken })).status,
      ).toBe(200);
    });

    it('mot de passe actuel incorrect → 401, rien ne change', async () => {
      const user = await createUser();
      const res = await as(user)
        .patch('/auth/change-password')
        .send({ currentPassword: 'Wrong123!x', newPassword: 'Chang3d!Pass' });
      expect(res.status).toBe(401);
      expect((await login(user.email)).status).toBe(200);
    });

    it('nouveau mot de passe faible → 400', async () => {
      const user = await createUser();
      const res = await as(user)
        .patch('/auth/change-password')
        .send({ currentPassword: STRONG_PASSWORD, newPassword: 'weak' });
      expect(res.status).toBe(400);
    });

    it('SÉCURITÉ : les access tokens des autres appareils sont invalidés', async () => {
      const user = await createUser();
      const other = (await login(user.email, STRONG_PASSWORD, { deviceId: 'other' })).body.data
        .tokens;
      const here = (await login(user.email, STRONG_PASSWORD, { deviceId: 'here' })).body.data
        .tokens;
      await new Promise((r) => setTimeout(r, 1100));
      await as(null, { token: here.accessToken }).patch('/auth/change-password').send({
        currentPassword: STRONG_PASSWORD,
        newPassword: 'Chang3d!Pass',
        refreshToken: here.refreshToken,
      });
      expect((await as(null, { token: other.accessToken }).get('/auth/me')).status).toBe(401);
    });

    it('l’appareil courant continue après un simple refresh (pas de déconnexion forcée)', async () => {
      const user = await createUser();
      const here = (await login(user.email, STRONG_PASSWORD, { deviceId: 'here' })).body.data
        .tokens;
      await new Promise((r) => setTimeout(r, 1100));
      await as(null, { token: here.accessToken }).patch('/auth/change-password').send({
        currentPassword: STRONG_PASSWORD,
        newPassword: 'Chang3d!Pass',
        refreshToken: here.refreshToken,
      });
      const r = await anon().post('/auth/refresh').send({ refreshToken: here.refreshToken });
      expect(r.status).toBe(200);
      expect(
        (await as(null, { token: r.body.data.tokens.accessToken }).get('/auth/me')).status,
      ).toBe(200);
    });
  });

  describe('Révocation globale', () => {
    it('SÉCURITÉ : "déconnecter tous les appareils" invalide aussi les access tokens', async () => {
      const user = await createUser();
      const a = (await login(user.email, STRONG_PASSWORD, { deviceId: 'A' })).body.data.tokens;
      const b = (await login(user.email, STRONG_PASSWORD, { deviceId: 'B' })).body.data.tokens;
      await new Promise((r) => setTimeout(r, 1100));
      await as(null, { token: a.accessToken }).delete('/auth/sessions');
      expect((await as(null, { token: b.accessToken }).get('/auth/me')).status).toBe(401);
      expect((await as(null, { token: a.accessToken }).get('/auth/me')).status).toBe(401);
      // une nouvelle connexion fonctionne normalement
      const fresh = (await login(user.email)).body.data.tokens;
      expect((await as(null, { token: fresh.accessToken }).get('/auth/me')).status).toBe(200);
    });

    it('SÉCURITÉ : NoSQL injection rejetée en query string sur toute l’API', async () => {
      const user = await createUser();
      const res = await as(user).get('/auth/me?filter[$where]=sleep(1000)');
      expect(res.status).toBe(400);
      const proto = await anon()
        .post('/auth/forgot-password')
        .set('Content-Type', 'application/json')
        .send('{"email":"a@example.com","__proto__":{"isAdmin":true}}');
      expect(proto.status).toBe(400);
    });
  });

  // ---------------------------------------------------------------- 2FA
  describe('2FA TOTP (admin / support)', () => {
    async function enable2fa(admin: { _id: unknown }) {
      const setup = await as(admin).post('/auth/2fa/setup');
      expect(setup.status).toBe(200);
      expect(setup.body.data.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
      const { secret } = setup.body.data;
      const en = await as(admin)
        .post('/auth/2fa/enable')
        .send({ code: totpCode(secret) });
      expect(en.status).toBe(200);
      expect(en.body.data.backupCodes).toHaveLength(8);
      return { secret, backupCodes: en.body.data.backupCodes as string[] };
    }

    it('un utilisateur standard ne peut pas activer la 2FA (403)', async () => {
      const user = await createUser();
      expect((await as(user).post('/auth/2fa/setup')).status).toBe(403);
    });

    it('activation avec un mauvais code → refus, 2FA reste inactive', async () => {
      const admin = await createAdmin();
      await as(admin).post('/auth/2fa/setup');
      const res = await as(admin).post('/auth/2fa/enable').send({ code: '000000' });
      expect(res.status).toBeGreaterThanOrEqual(400);
      const db = await User.findById(admin._id).select('+security.totpEnabled');
      expect(db!.security?.totpEnabled).toBeFalsy();
    });

    it('login admin 2FA : challenge puis code TOTP → session ouverte', async () => {
      const admin = await createAdmin();
      const { secret } = await enable2fa(admin);

      const step1 = await login(admin.email);
      expect(step1.status).toBe(200);
      expect(step1.body.data.requiresTotp).toBe(true);
      expect(step1.body.data.tokens).toBeUndefined();

      const step2 = await anon()
        .post('/auth/2fa/verify')
        .send({ challengeToken: step1.body.data.challengeToken, code: totpCode(secret) });
      expect(step2.status).toBe(200);
      expect(step2.body.data.tokens.accessToken).toEqual(expect.any(String));
    });

    it('mauvais code TOTP → 401 ; challenge forgé → 401', async () => {
      const admin = await createAdmin();
      await enable2fa(admin);
      const { challengeToken } = (await login(admin.email)).body.data;
      expect(
        (await anon().post('/auth/2fa/verify').send({ challengeToken, code: '123456' })).status,
      ).toBe(401);
      const forged = jwt.sign(
        { id: String(admin._id), purpose: '2fa_challenge' },
        'wrong-secret-wrong-secret-wrong!!',
      );
      expect(
        (await anon().post('/auth/2fa/verify').send({ challengeToken: forged, code: '123456' }))
          .status,
      ).toBe(401);
    });

    it('SÉCURITÉ : un access token ne peut pas servir de challenge 2FA', async () => {
      const admin = await createAdmin();
      const { secret } = await enable2fa(admin);
      const res = await anon()
        .post('/auth/2fa/verify')
        .send({ challengeToken: accessTokenFor(admin), code: totpCode(secret) });
      expect(res.status).toBe(401);
    });

    it('code de secours : utilisable UNE seule fois', async () => {
      const admin = await createAdmin();
      const { backupCodes } = await enable2fa(admin);
      const c1 = (await login(admin.email)).body.data.challengeToken;
      expect(
        (await anon().post('/auth/2fa/verify').send({ challengeToken: c1, code: backupCodes[0] }))
          .status,
      ).toBe(200);
      const c2 = (await login(admin.email)).body.data.challengeToken;
      expect(
        (await anon().post('/auth/2fa/verify').send({ challengeToken: c2, code: backupCodes[0] }))
          .status,
      ).toBe(401);
    });

    it('désactivation exige un code valide', async () => {
      const admin = await createAdmin();
      const { secret } = await enable2fa(admin);
      expect(
        (await as(admin).post('/auth/2fa/disable').send({ code: '000000' })).status,
      ).toBeGreaterThanOrEqual(400);
      expect(
        (
          await as(admin)
            .post('/auth/2fa/disable')
            .send({ code: totpCode(secret) })
        ).status,
      ).toBe(200);
      const step1 = await login(admin.email);
      expect(step1.body.data.tokens.accessToken).toEqual(expect.any(String));
    });
  });

  // ---------------------------------------------------------------- suppression RGPD
  describe('DELETE /auth/delete-me', () => {
    it('exige le mot de passe pour un compte email', async () => {
      const user = await createUser();
      expect((await as(user).delete('/auth/delete-me').send({})).status).toBe(400);
      expect(
        (await as(user).delete('/auth/delete-me').send({ password: 'Wrong123!x' })).status,
      ).toBe(401);
      expect(await User.findById(user._id)).not.toBeNull();
    });

    it('refuse si le portefeuille a un solde positif', async () => {
      const user = await createUser({ walletBalance: 500 });
      const res = await as(user).delete('/auth/delete-me').send({ password: STRONG_PASSWORD });
      expect(res.status).toBe(400);
      expect(await User.findById(user._id)).not.toBeNull();
    });

    it('supprime le compte, efface les données perso, anonymise les paiements (AML)', async () => {
      const user = await createUser();
      await Budget.collection.insertOne({ userId: user._id, name: 'Courses' });
      await Payment.collection.insertOne({
        userId: user._id,
        amount: 1000,
        reference: `ref-${user._id}`,
        status: 'completed',
      });

      const res = await as(user).delete('/auth/delete-me').send({ password: STRONG_PASSWORD });
      expect(res.status).toBe(200);
      expect(await User.findById(user._id)).toBeNull();
      expect(await Budget.collection.countDocuments({ userId: user._id })).toBe(0);
      const pay = await Payment.collection.findOne({ reference: `ref-${user._id}` });
      expect(pay).not.toBeNull();
      expect(pay!.userId).toBeNull();
      expect((await as(user).get('/auth/me')).status).toBe(401);
    });

    it('compte social (sans mot de passe) : suppression sans mot de passe', async () => {
      const user = await createUser({ password: null, firebaseUid: 'fb-del' });
      expect((await as(user).delete('/auth/delete-me').send({})).status).toBe(200);
    });
  });

  // ---------------------------------------------------------------- rate limiting
  describe('Rate limiting par IP', () => {
    it('bloque après 30 tentatives de login depuis la même IP (429)', async () => {
      const ip = '203.0.113.77';
      let last = 0;
      for (let i = 0; i < 31; i++) {
        last = (await login(uniqueEmail(), 'WrongPassword1!', {}, ip)).status;
      }
      expect(last).toBe(429);
      // une autre IP n'est pas impactée
      expect((await login(uniqueEmail(), 'WrongPassword1!', {}, '203.0.113.78')).status).toBe(401);
    });
  });
});
