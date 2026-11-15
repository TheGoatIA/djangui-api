/**
 * MODULE PAIEMENTS / WALLET — tests de bout en bout (HTTP → services → MongoDB + Redis réels).
 *
 * Fournisseurs RÉELS en mode test :
 *   - NotchPay SANDBOX : initialisation de paiement, vérification, transferts (retraits)
 *   - Stripe TEST-MODE : création et lecture de sessions Checkout
 * Les webhooks sont signés par le test avec les secrets de test, au FORMAT RÉEL observé
 * sur le sandbox NotchPay (`reference` = id NotchPay, `merchant_reference` = notre référence).
 *
 * Les suites "fournisseur réel" sont ignorées si aucune clé sandbox n'est disponible.
 */
import crypto from 'node:crypto';
import Stripe from 'stripe';
import { useTestDB } from '../helpers/db';
import { api, as } from '../helpers/http';
import { createUser, createPremium } from '../helpers/factories';
import User from '../../src/models/User';
import Payment from '../../src/models/Payment';
import Transaction from '../../src/models/Transaction';
import SystemSetting from '../../src/models/SystemSetting';
import { notchpayApi, notchpayAdminApi } from '../../src/config/notchpay';
import { WalletService } from '../../src/services/walletService';
import { NotchPayReconciliationService } from '../../src/services/notchpayReconciliationService';

jest.setTimeout(60000);

const realNotchPay = process.env.HAS_NOTCHPAY_SANDBOX ? describe : describe.skip;
const realStripe = process.env.HAS_STRIPE_SANDBOX ? describe : describe.skip;

const CM_PHONE = '+237690000000'; // Orange CM (format valide)
const MTN_PHONE = '670000000';

const enableRealMoney = (on = true) =>
  SystemSetting.updateOne({ key: 'real_money_mode' }, { value: on }, { upsert: true });

const cmUser = (o: Record<string, unknown> = {}) =>
  createUser({ country: 'CM', currency: 'XAF', phone: CM_PHONE, ...o });

/** Webhook NotchPay signé, au format réel du sandbox. */
function notchpayWebhook(event: string, data: Record<string, unknown>, secret?: string) {
  const body = JSON.stringify({ event, data });
  const sig = crypto
    .createHmac('sha256', secret ?? (process.env.NOTCHPAY_WEBHOOK_SECRET as string))
    .update(body)
    .digest('hex');
  return api('post', '/webhooks/notchpay', {
    headers: { 'Content-Type': 'application/json', 'X-Notch-Signature': sig },
  }).send(body);
}

function stripeWebhook(event: Record<string, unknown>, secret?: string) {
  const payload = JSON.stringify(event);
  const header = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: secret ?? (process.env.STRIPE_WEBHOOK_SECRET as string),
  });
  return api('post', '/webhooks/stripe', {
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': header },
  }).send(payload);
}

async function pendingNotchPayPayment(
  user: { _id: unknown },
  o: { amount?: number; type?: 'deposit' | 'subscription'; plan?: string } = {},
) {
  const reference = `NTP-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  return Payment.create({
    userId: user._id,
    amount: o.amount ?? 5000,
    currency: 'XAF',
    method: 'notchpay',
    type: o.type ?? 'deposit',
    reference,
    status: 'pending',
    externalReference: `trx.test_${crypto.randomBytes(8).toString('hex')}`,
    metadata: { plan: o.plan ?? 'premium' },
  });
}

const balanceOf = async (u: { _id: unknown }) => (await User.findById(u._id))!.walletBalance;

describe('API paiements & wallet', () => {
  useTestDB();
  beforeEach(() => enableRealMoney(true));

  // ------------------------------------------------------------- garde-fous globaux
  describe('Garde-fous argent réel', () => {
    it('toutes les routes exigent une authentification', async () => {
      for (const [m, u] of [
        ['post', '/payments/init/notchpay'],
        ['post', '/payments/checkout/stripe'],
        ['post', '/payments/pay/wallet'],
        ['get', '/payments'],
        ['get', '/fintech/wallet/balance'],
        ['post', '/fintech/payout/withdraw'],
      ] as const) {
        expect((await api(m, u).send({})).status).toBe(401);
      }
    });

    it('mode argent réel désactivé → dépôt, abonnement carte et retrait refusés', async () => {
      await enableRealMoney(false);
      const user = await cmUser({ kycLevel: 'verified', walletBalance: 10000 });
      const spy = jest.spyOn(notchpayApi, 'post');
      expect(
        (await as(user).post('/payments/init/notchpay').send({ type: 'deposit', amount: 1000 }))
          .status,
      ).toBe(400);
      expect(
        (
          await as(user)
            .post('/payments/checkout/stripe')
            .send({ type: 'subscription', plan: 'premium' })
        ).status,
      ).toBe(400);
      expect(
        (
          await as(user)
            .post('/fintech/payout/withdraw')
            .send({ amount: 1000, phone: MTN_PHONE, provider: 'mtn' })
        ).status,
      ).toBe(400);
      expect(spy).not.toHaveBeenCalled();
      expect(await balanceOf(user)).toBe(10000);
    });

    it('pays hors périmètre (FR) → refusé avant tout appel fournisseur', async () => {
      const user = await createUser({ country: 'FR', currency: 'EUR', phone: CM_PHONE });
      const spy = jest.spyOn(notchpayApi, 'post');
      const res = await as(user)
        .post('/payments/init/notchpay')
        .send({ type: 'deposit', amount: 1000 });
      expect(res.status).toBe(400);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------- NotchPay : initialisation
  describe('POST /payments/init/notchpay — validation (aucun appel fournisseur)', () => {
    it.each([
      ['montant absent', { type: 'deposit' }],
      ['montant nul', { type: 'deposit', amount: 0 }],
      ['montant négatif', { type: 'deposit', amount: -500 }],
      ['montant décimal (XAF sans centimes)', { type: 'deposit', amount: 100.4 }],
      ['montant sous le minimum (100 XAF)', { type: 'deposit', amount: 50 }],
      ['montant au-dessus du plafond AML (50 000 XAF)', { type: 'deposit', amount: 60000 }],
      ['type inconnu', { type: 'gift', amount: 1000 }],
      ['plan "free" non achetable', { type: 'subscription', plan: 'free' }],
    ])('%s → 400, aucun paiement créé', async (_l, body) => {
      const user = await cmUser();
      const spy = jest.spyOn(notchpayApi, 'post');
      const res = await as(user).post('/payments/init/notchpay').send(body);
      expect(res.status).toBe(400);
      expect(spy).not.toHaveBeenCalled();
      expect(await Payment.countDocuments({ userId: user._id })).toBe(0);
    });

    it('téléphone absent ou invalide → 400', async () => {
      const noPhone = await createUser({ country: 'CM', currency: 'XAF' });
      expect(
        (await as(noPhone).post('/payments/init/notchpay').send({ type: 'deposit', amount: 1000 }))
          .status,
      ).toBe(400);
      expect(
        (
          await as(noPhone)
            .post('/payments/init/notchpay')
            .send({ type: 'deposit', amount: 1000, phone: 'abc' })
        ).status,
      ).toBe(400);
    });

    it('panne NotchPay → 500 propre, aucun paiement fantôme', async () => {
      const user = await cmUser();
      jest
        .spyOn(notchpayApi, 'post')
        .mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'ECONNRESET' }));
      const res = await as(user)
        .post('/payments/init/notchpay')
        .send({ type: 'deposit', amount: 1000 });
      expect(res.status).toBe(500);
      expect(await Payment.countDocuments({ userId: user._id })).toBe(0);
    });
  });

  realNotchPay('NotchPay SANDBOX réel — initialisation et vérification', () => {
    it('dépôt : crée un paiement pending lié à la transaction NotchPay et renvoie l’URL de paiement', async () => {
      const user = await cmUser();
      const res = await as(user)
        .post('/payments/init/notchpay')
        .send({ type: 'deposit', amount: 1000 });
      expect(res.status).toBe(200);
      expect(res.body.data.url).toMatch(/^https:\/\/.*notchpay/);
      const p = await Payment.findOne({ reference: res.body.data.reference });
      expect(p).toMatchObject({
        status: 'pending',
        amount: 1000,
        currency: 'XAF',
        method: 'notchpay',
        type: 'deposit',
      });
      expect(p!.externalReference).toMatch(/^trx\./);
      expect(await balanceOf(user)).toBe(0); // rien n'est crédité avant confirmation
    });

    it('abonnement : le prix est fixé par le serveur, jamais par le client', async () => {
      const user = await cmUser();
      const res = await as(user)
        .post('/payments/init/notchpay')
        .send({ type: 'subscription', plan: 'premium', amount: 1 });
      expect(res.status).toBe(200);
      const p = await Payment.findOne({ reference: res.body.data.reference });
      expect(p!.amount).toBe(2000);
      expect(p!.metadata?.plan).toBe('premium');
    });

    it('abonnement Business : 5 000 XAF', async () => {
      const user = await cmUser();
      const res = await as(user)
        .post('/payments/init/notchpay')
        .send({ type: 'subscription', plan: 'business' });
      expect((await Payment.findOne({ reference: res.body.data.reference }))!.amount).toBe(5000);
    });

    it('idempotence : même Idempotency-Key → 409, un seul paiement', async () => {
      const user = await cmUser();
      const headers = { 'Idempotency-Key': crypto.randomUUID() };
      const a = await as(user)
        .post('/payments/init/notchpay', { headers })
        .send({ type: 'deposit', amount: 1000 });
      const b = await as(user)
        .post('/payments/init/notchpay', { headers })
        .send({ type: 'deposit', amount: 1000 });
      expect(a.status).toBe(200);
      expect(b.status).toBe(409);
      expect(await Payment.countDocuments({ userId: user._id })).toBe(1);
    });

    it('vérification : interroge NotchPay et rapporte "pending" tant que le client n’a pas payé', async () => {
      const user = await cmUser();
      const { reference } = (
        await as(user).post('/payments/init/notchpay').send({ type: 'deposit', amount: 1000 })
      ).body.data;
      const res = await as(user).get(`/payments/verify/${reference}`);
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('pending');
      expect(await balanceOf(user)).toBe(0);
    });
  });

  describe('GET /payments/verify/:reference', () => {
    it('SÉCURITÉ : impossible de vérifier le paiement d’un autre utilisateur (IDOR)', async () => {
      const owner = await cmUser();
      const other = await cmUser();
      const p = await pendingNotchPayPayment(owner);
      expect((await as(other).get(`/payments/verify/${p.reference}`)).status).toBe(403);
    });

    it('référence inconnue → 404 ; référence absente → 400', async () => {
      const user = await cmUser();
      expect((await as(user).get('/payments/verify/NTP-NOPE')).status).toBe(404);
      expect((await as(user).get('/payments/verify')).status).toBe(400);
    });

    it('paiement confirmé chez NotchPay → crédit du wallet (une seule fois)', async () => {
      const user = await cmUser();
      const p = await pendingNotchPayPayment(user, { amount: 3000 });
      jest
        .spyOn(notchpayApi, 'get')
        .mockResolvedValue({ data: { transaction: { status: 'complete' } } } as never);
      expect((await as(user).get(`/payments/verify/${p.reference}`)).body.data.status).toBe(
        'completed',
      );
      expect((await as(user).get(`/payments/verify/${p.reference}`)).body.data.status).toBe(
        'completed',
      );
      expect(await balanceOf(user)).toBe(3000);
    });

    it('panne fournisseur pendant la vérification → 502, rien n’est crédité', async () => {
      const user = await cmUser();
      const p = await pendingNotchPayPayment(user);
      jest.spyOn(notchpayApi, 'get').mockRejectedValue(new Error('ETIMEDOUT'));
      expect((await as(user).get(`/payments/verify/${p.reference}`)).status).toBe(502);
      expect(await balanceOf(user)).toBe(0);
    });
  });

  // ------------------------------------------------------------- webhooks NotchPay
  describe('Webhook NotchPay payment.complete', () => {
    const realPayload = (p: { reference: string; externalReference?: string; amount: number }) => ({
      amount: p.amount,
      reference: p.externalReference, // id NotchPay (trx.…)
      merchant_reference: p.reference, // notre référence
      status: 'complete',
      currency: 'XAF',
    });

    it('dépôt confirmé (format réel NotchPay) → wallet crédité, transaction + facture', async () => {
      const user = await cmUser();
      const p = await pendingNotchPayPayment(user, { amount: 4000 });
      const res = await notchpayWebhook('payment.complete', realPayload(p));
      expect(res.status).toBe(200);
      expect(await balanceOf(user)).toBe(4000);
      expect((await Payment.findById(p._id))!.status).toBe('completed');
      const tx = await Transaction.findOne({ userId: user._id, category: 'deposit' });
      expect(tx).toMatchObject({ amount: 4000, type: 'income', status: 'completed' });
    });

    it('sans merchant_reference : retrouve le paiement par l’id NotchPay stocké', async () => {
      const user = await cmUser();
      const p = await pendingNotchPayPayment(user, { amount: 1500 });
      await notchpayWebhook('payment.complete', {
        reference: p.externalReference,
        status: 'complete',
      });
      expect(await balanceOf(user)).toBe(1500);
    });

    it('livraisons dupliquées, séquentielles ET simultanées → crédit unique', async () => {
      const user = await cmUser();
      const p = await pendingNotchPayPayment(user, { amount: 2500 });
      await Promise.all(
        Array.from({ length: 5 }, () => notchpayWebhook('payment.complete', realPayload(p))),
      );
      await notchpayWebhook('payment.complete', realPayload(p));
      expect(await balanceOf(user)).toBe(2500);
      expect(await Transaction.countDocuments({ userId: user._id, category: 'deposit' })).toBe(1);
    });

    it('abonnement confirmé → plan premium actif ~30 jours', async () => {
      const user = await cmUser();
      const p = await pendingNotchPayPayment(user, {
        type: 'subscription',
        amount: 2000,
        plan: 'premium',
      });
      await notchpayWebhook('payment.complete', realPayload(p));
      const u = await User.findById(user._id);
      expect(u!.subscription!.plan).toBe('premium');
      expect(u!.subscription!.status).toBe('active');
      const days = (new Date(u!.subscription!.endDate!).getTime() - Date.now()) / 86400000;
      expect(days).toBeGreaterThan(27);
      expect(days).toBeLessThan(32);
      expect(await balanceOf(user)).toBe(0);
    });

    it('SÉCURITÉ : signature invalide → 401, rien n’est crédité', async () => {
      const user = await cmUser();
      const p = await pendingNotchPayPayment(user);
      const res = await notchpayWebhook('payment.complete', realPayload(p), 'mauvais-secret');
      expect(res.status).toBe(401);
      expect(await balanceOf(user)).toBe(0);
    });

    it('SÉCURITÉ : signature absente → 401', async () => {
      const res = await api('post', '/webhooks/notchpay').send({
        event: 'payment.complete',
        data: {},
      });
      expect(res.status).toBe(401);
    });

    it('référence inconnue → 200 (pas de redélivrance inutile), aucun effet', async () => {
      const res = await notchpayWebhook('payment.complete', {
        reference: 'trx.test_unknown',
        merchant_reference: 'NTP-NOPE',
      });
      expect(res.status).toBe(200);
      expect(await Transaction.countDocuments({})).toBe(0);
    });
  });

  // ------------------------------------------------------------- Stripe
  realStripe('Stripe TEST-MODE réel', () => {
    it('abonnement : crée une vraie session Checkout au prix serveur', async () => {
      const user = await cmUser();
      const res = await as(user)
        .post('/payments/checkout/stripe')
        .send({ type: 'subscription', plan: 'premium', amount: 1 });
      expect(res.status).toBe(200);
      expect(res.body.data.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
      const p = await Payment.findOne({ reference: res.body.data.reference });
      expect(p).toMatchObject({
        status: 'pending',
        amount: 2000,
        currency: 'XAF',
        method: 'stripe',
      });
      expect(p!.externalReference).toMatch(/^cs_test_/);
    });

    it('vérification : la session non payée est rapportée "unpaid"', async () => {
      const user = await cmUser();
      const { reference } = (
        await as(user)
          .post('/payments/checkout/stripe')
          .send({ type: 'subscription', plan: 'premium' })
      ).body.data;
      const res = await as(user).get(`/payments/verify/${reference}`);
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('unpaid');
      expect((await User.findById(user._id))!.subscription?.plan ?? 'free').toBe('free');
    });
  });

  describe('Stripe — règles et webhook', () => {
    it('la recharge par carte est refusée (Mobile Money uniquement)', async () => {
      const user = await cmUser();
      expect(
        (await as(user).post('/payments/checkout/stripe').send({ type: 'deposit', amount: 1000 }))
          .status,
      ).toBe(400);
    });

    it('webhook checkout.session.completed signé → abonnement Business activé', async () => {
      const user = await cmUser();
      const p = await Payment.create({
        userId: user._id,
        amount: 5000,
        currency: 'XAF',
        method: 'stripe',
        type: 'subscription',
        reference: 'STP-BIZ0001',
        status: 'pending',
        externalReference: 'cs_test_x',
        metadata: { plan: 'business' },
      });
      const res = await stripeWebhook({
        id: 'evt_test_1',
        object: 'event',
        type: 'checkout.session.completed',
        data: { object: { id: 'cs_test_x', metadata: { reference: p.reference } } },
      });
      expect(res.status).toBe(200);
      expect((await User.findById(user._id))!.subscription!.plan).toBe('business');
    });

    it('compte Stripe partagé : un paiement d’une autre app (metadata.app) est ignoré', async () => {
      const user = await cmUser();
      const p = await Payment.create({
        userId: user._id,
        amount: 5000,
        currency: 'XAF',
        method: 'stripe',
        type: 'subscription',
        reference: 'STP-SHARED01',
        status: 'pending',
        externalReference: 'cs_test_shared',
        metadata: { plan: 'business' },
      });
      const res = await stripeWebhook({
        id: 'evt_other_app',
        object: 'event',
        type: 'checkout.session.completed',
        data: { object: { id: 'cs_other', metadata: { app: 'cvbrain', reference: p.reference } } },
      });
      expect(res.status).toBe(200);
      expect((await Payment.findById(p._id))!.status).toBe('pending');
      expect((await User.findById(user._id))!.subscription?.plan ?? 'free').toBe('free');
    });

    it('SÉCURITÉ : webhook Stripe mal signé → 400, aucun effet', async () => {
      const user = await cmUser();
      await Payment.create({
        userId: user._id,
        amount: 2000,
        currency: 'XAF',
        method: 'stripe',
        type: 'subscription',
        reference: 'STP-FAKE001',
        status: 'pending',
        metadata: { plan: 'premium' },
      });
      const res = await stripeWebhook(
        {
          id: 'evt_x',
          type: 'checkout.session.completed',
          data: { object: { metadata: { reference: 'STP-FAKE001' } } },
        },
        'whsec_attacker',
      );
      expect(res.status).toBe(400);
      expect((await User.findById(user._id))!.subscription?.plan ?? 'free').toBe('free');
    });
  });

  // ------------------------------------------------------------- abonnement par wallet
  describe('POST /payments/pay/wallet', () => {
    it('solde insuffisant → 400, rien ne bouge', async () => {
      const user = await cmUser({ walletBalance: 1000 });
      expect((await as(user).post('/payments/pay/wallet').send({ plan: 'premium' })).status).toBe(
        400,
      );
      expect(await balanceOf(user)).toBe(1000);
      expect((await User.findById(user._id))!.subscription?.plan ?? 'free').toBe('free');
    });

    it('débite le prix exact, active le plan, trace paiement + transaction', async () => {
      const user = await cmUser({ walletBalance: 10000 });
      const res = await as(user).post('/payments/pay/wallet').send({ plan: 'premium' });
      expect(res.status).toBe(200);
      expect(await balanceOf(user)).toBe(8000);
      expect((await User.findById(user._id))!.subscription!.plan).toBe('premium');
      expect(
        await Payment.countDocuments({ userId: user._id, method: 'wallet', status: 'completed' }),
      ).toBe(1);
      expect(
        await Transaction.countDocuments({
          userId: user._id,
          type: 'expense',
          paymentMethod: 'wallet',
        }),
      ).toBe(1);
    });

    it('CONCURRENCE : deux paiements simultanés avec un solde pour un seul → un seul passe, jamais de solde négatif', async () => {
      const user = await cmUser({ walletBalance: 2000 });
      const results = await Promise.all([
        as(user).post('/payments/pay/wallet').send({ plan: 'premium' }),
        as(user).post('/payments/pay/wallet').send({ plan: 'premium' }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
      expect(await balanceOf(user)).toBe(0);
      expect(await Payment.countDocuments({ userId: user._id, method: 'wallet' })).toBe(1);
    });

    it('renouvellement anticipé : la durée s’ajoute à l’abonnement en cours', async () => {
      const user = await createPremium({ country: 'CM', currency: 'XAF', walletBalance: 5000 });
      const before = new Date((await User.findById(user._id))!.subscription!.endDate!).getTime();
      await as(user).post('/payments/pay/wallet').send({ plan: 'premium' });
      const after = new Date((await User.findById(user._id))!.subscription!.endDate!).getTime();
      expect((after - before) / 86400000).toBeGreaterThan(27);
    });

    it('résiliation : statut cancelled, accès conservé jusqu’à la fin ; sans abonnement → 400', async () => {
      const user = await createPremium({ country: 'CM', currency: 'XAF' });
      const res = await as(user).post('/payments/cancel-subscription');
      expect(res.status).toBe(200);
      const u = await User.findById(user._id);
      expect(u!.subscription!.status).toBe('cancelled');
      expect((u as any).isPremium).toBe(true);
      const free = await cmUser();
      expect((await as(free).post('/payments/cancel-subscription')).status).toBe(400);
    });
  });

  // ------------------------------------------------------------- AML
  describe('Limites AML', () => {
    const debit = (user: { _id: unknown }, amount: number) =>
      WalletService.executeTransaction({
        userId: String(user._id),
        amount,
        type: 'saving_transfer',
        description: 'test',
        paymentMethod: 'wallet',
      });

    it('plafond journalier des débits (100 000 XAF pour un compte gratuit)', async () => {
      const user = await cmUser({ walletBalance: 200000 });
      await debit(user, 50000);
      await debit(user, 50000);
      await expect(debit(user, 1000)).rejects.toThrow(/journalière/);
      expect(await balanceOf(user)).toBe(100000);
    });

    it('plafond par opération (50 000 XAF)', async () => {
      const user = await cmUser({ walletBalance: 200000 });
      await expect(debit(user, 50001)).rejects.toThrow(/limite par transaction/);
    });

    it('les dépenses saisies manuellement dans le budget ne consomment PAS le plafond wallet', async () => {
      const user = await cmUser({ walletBalance: 10000 });
      for (const amount of [150000, 80000]) {
        const r = await as(user).post('/transactions').send({
          type: 'expense',
          amount,
          category: 'Logement',
          description: 'Loyer payé en espèces',
          date: new Date().toISOString(),
        });
        expect(r.status).toBe(201);
      }
      expect((await as(user).post('/payments/pay/wallet').send({ plan: 'premium' })).status).toBe(
        200,
      );
    });

    it('un retrait encore "pending" compte dans le plafond journalier', async () => {
      const user = await cmUser({ walletBalance: 200000 });
      const tx = await debit(user, 50000);
      await Transaction.updateOne({ _id: tx._id }, { status: 'pending' });
      await debit(user, 50000);
      await expect(debit(user, 1000)).rejects.toThrow(/journalière/);
    });

    it('SÉCURITÉ : impossible de se créditer le wallet via une transaction manuelle', async () => {
      const user = await cmUser({ walletBalance: 0 });
      await as(user).post('/transactions').send({
        type: 'income',
        amount: 1_000_000,
        category: 'Salaire',
        description: 'free money',
        paymentMethod: 'wallet',
        date: new Date().toISOString(),
      });
      expect(await balanceOf(user)).toBe(0);
    });
  });

  // ------------------------------------------------------------- retraits
  describe('POST /fintech/payout/withdraw — règles (aucun appel fournisseur)', () => {
    const withdraw = (user: { _id: unknown }, body: Record<string, unknown>) =>
      as(user)
        .post('/fintech/payout/withdraw')
        .send({ phone: MTN_PHONE, provider: 'mtn', ...body });

    it('KYC non vérifié → 403', async () => {
      const user = await cmUser({ walletBalance: 10000 });
      expect((await withdraw(user, { amount: 1000 })).status).toBe(403);
      expect(await balanceOf(user)).toBe(10000);
    });

    it.each([
      ['montant en chaîne de caractères', '5000'],
      ['montant décimal', 1000.5],
      ['montant sous le minimum (500)', 100],
      ['montant négatif', -1000],
    ])('%s → 400, solde intact', async (_l, amount) => {
      const user = await cmUser({ walletBalance: 10000, kycLevel: 'verified' });
      const spy = jest.spyOn(notchpayAdminApi, 'post');
      expect((await withdraw(user, { amount })).status).toBe(400);
      expect(spy).not.toHaveBeenCalled();
      expect(await balanceOf(user)).toBe(10000);
    });

    it.each([
      ['numéro trop court', { phone: '67000' }],
      ['numéro non camerounais', { phone: '+33612345678' }],
      ['opérateur incohérent (Orange déclaré MTN)', { phone: '690000000', provider: 'mtn' }],
    ])('%s → 400 sans débit', async (_l, extra) => {
      const user = await cmUser({ walletBalance: 10000, kycLevel: 'verified' });
      expect((await withdraw(user, { amount: 1000, ...extra })).status).toBe(400);
      expect(await balanceOf(user)).toBe(10000);
    });

    it('retrait Orange Money : tenté (pas bloqué) ; refus opérateur → remboursé + message clair en français', async () => {
      const user = await cmUser({ walletBalance: 10000, kycLevel: 'verified' });
      const transfer = jest.spyOn(notchpayAdminApi, 'post').mockRejectedValue(
        Object.assign(new Error('rejected'), {
          response: { status: 422, data: { message: 'The selected channel is invalid.' } },
        }),
      );
      const res = await withdraw(user, { amount: 1000, phone: '690000000', provider: 'orange' });
      expect(transfer).toHaveBeenCalled();
      expect((transfer.mock.calls[0][1] as any).channel).toBe('cm.orange');
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Orange Money a été refusé par l'opérateur.*rétabli/);
      expect(res.body.message).not.toMatch(/channel is invalid/i);
      expect(await balanceOf(user)).toBe(10000);
    });

    it('solde insuffisant (frais inclus) → 400', async () => {
      const user = await cmUser({ walletBalance: 1050, kycLevel: 'verified' });
      expect((await withdraw(user, { amount: 1000 })).status).toBe(400);
      expect(await balanceOf(user)).toBe(1050);
    });

    it('rejet explicite NotchPay (422) → remboursement immédiat et intégral', async () => {
      const user = await cmUser({ walletBalance: 10000, kycLevel: 'verified' });
      jest.spyOn(notchpayAdminApi, 'post').mockRejectedValue(
        Object.assign(new Error('rejected'), {
          response: { status: 422, data: { message: 'Invalid account' } },
        }),
      );
      expect((await withdraw(user, { amount: 2000 })).status).toBe(400);
      expect(await balanceOf(user)).toBe(10000);
    });

    it('NotchPay injoignable (ECONNREFUSED) → remboursé, 503', async () => {
      const user = await cmUser({ walletBalance: 10000, kycLevel: 'verified' });
      jest
        .spyOn(notchpayAdminApi, 'post')
        .mockRejectedValue(Object.assign(new Error('down'), { code: 'ECONNREFUSED' }));
      expect((await withdraw(user, { amount: 2000 })).status).toBe(503);
      expect(await balanceOf(user)).toBe(10000);
    });

    it('erreur ambiguë (5xx) → reste débité en "pending" (pas de double paiement possible)', async () => {
      const user = await cmUser({ walletBalance: 10000, kycLevel: 'verified' });
      jest
        .spyOn(notchpayAdminApi, 'post')
        .mockRejectedValue(
          Object.assign(new Error('gateway'), { response: { status: 502, data: {} } }),
        );
      expect((await withdraw(user, { amount: 2000 })).status).toBe(500);
      expect(await balanceOf(user)).toBe(10000 - 2100);
      expect(
        (await Transaction.findOne({ userId: user._id, category: 'withdrawal' }))!.status,
      ).toBe('pending');
    });

    it('idempotence : double soumission du même retrait → 409, un seul débit', async () => {
      const user = await cmUser({ walletBalance: 10000, kycLevel: 'verified' });
      jest
        .spyOn(notchpayAdminApi, 'post')
        .mockResolvedValue({ data: { transfer: { reference: 'trf.test_idem' } } } as never);
      const headers = { 'Idempotency-Key': crypto.randomUUID() };
      const a = await as(user)
        .post('/fintech/payout/withdraw', { headers })
        .send({ amount: 1000, phone: MTN_PHONE, provider: 'mtn' });
      const b = await as(user)
        .post('/fintech/payout/withdraw', { headers })
        .send({ amount: 1000, phone: MTN_PHONE, provider: 'mtn' });
      expect([a.status, b.status]).toEqual([200, 409]);
      expect(await balanceOf(user)).toBe(10000 - 1100);
    });

    it.each([
      ['gratuit', {}, 3],
      ['premium', { plan: 'premium' }, 1.5],
      ['business', { plan: 'business' }, 1.5],
    ])('frais de retrait pour un compte %s : %s %%', async (_l, extra, pct) => {
      const user = await cmUser({ walletBalance: 20000, kycLevel: 'verified', ...extra });
      jest
        .spyOn(notchpayAdminApi, 'post')
        .mockResolvedValue({ data: { transfer: { reference: 'trf.test_fee' } } } as never);
      const res = await withdraw(user, { amount: 10000 });
      expect(res.status).toBe(200);
      expect(res.body.data.fees).toBe((10000 * pct) / 100);
      expect(await balanceOf(user)).toBe(20000 - 10000 - (10000 * pct) / 100);
    });
  });

  realNotchPay('Retraits — NotchPay SANDBOX réel', () => {
    it('retrait MTN : débit montant + frais, transfert créé chez NotchPay, id stocké', async () => {
      const user = await cmUser({ walletBalance: 10000, kycLevel: 'verified' });
      const res = await as(user)
        .post('/fintech/payout/withdraw')
        .send({ amount: 1000, phone: MTN_PHONE, provider: 'mtn' });
      expect(res.status).toBe(200);
      expect(res.body.data.fees).toBe(100); // min 100 XAF
      expect(await balanceOf(user)).toBe(8900);
      const tx = await Transaction.findOne({ reference: res.body.data.reference });
      expect(tx).toMatchObject({
        status: 'completed',
        amount: 1000,
        fees: 100,
        category: 'withdrawal',
      });
      expect(tx!.externalReference).toMatch(/^trf\./);
    });
  });

  // ------------------------------------------------------------- échec de transfert / réconciliation
  describe('Retrait échoué chez l’opérateur → remboursement', () => {
    async function completedWithdrawal(user: { _id: unknown }, amount = 2000, fees = 100) {
      const tx = await WalletService.executeTransaction({
        userId: String(user._id),
        amount: amount + fees,
        fees,
        type: 'withdrawal',
        description: 'Retrait',
        paymentMethod: 'wallet',
        silent: true,
      });
      await Transaction.updateOne(
        { _id: tx._id },
        { externalReference: `trf.test_${tx.reference}` },
      );
      return (await Transaction.findById(tx._id))!;
    }

    it('webhook transfer.failed (format réel) → remboursement montant + frais, une seule fois', async () => {
      const user = await cmUser({ walletBalance: 10000 });
      const tx = await completedWithdrawal(user);
      expect(await balanceOf(user)).toBe(7900);
      const payload = {
        reference: tx.externalReference,
        merchant_reference: tx.reference,
        status: 'failed',
        reason: 'Compte inexistant',
      };
      await Promise.all([
        notchpayWebhook('transfer.failed', payload),
        notchpayWebhook('transfer.failed', payload),
      ]);
      await notchpayWebhook('transfer.failed', payload);
      expect(await balanceOf(user)).toBe(10000);
      expect((await Transaction.findById(tx._id))!.status).toBe('failed');
    });

    it('sans merchant_reference : retrouvé par l’id NotchPay du transfert', async () => {
      const user = await cmUser({ walletBalance: 10000 });
      const tx = await completedWithdrawal(user);
      await notchpayWebhook('transfer.failed', { reference: tx.externalReference, reason: 'x' });
      expect(await balanceOf(user)).toBe(10000);
    });

    it('SÉCURITÉ : transfer.failed sans référence → aucun remboursement (pas de "match all")', async () => {
      const user = await cmUser({ walletBalance: 10000 });
      await completedWithdrawal(user);
      const res = await notchpayWebhook('transfer.failed', { reason: 'x' });
      expect(res.status).toBe(200);
      expect(await balanceOf(user)).toBe(7900);
    });

    it('SÉCURITÉ : transfer.failed visant un DÉPÔT → aucun "remboursement"', async () => {
      const user = await cmUser();
      const p = await pendingNotchPayPayment(user, { amount: 3000 });
      await notchpayWebhook('payment.complete', {
        reference: p.externalReference,
        merchant_reference: p.reference,
      });
      await notchpayWebhook('transfer.failed', { merchant_reference: p.reference, reason: 'x' });
      expect(await balanceOf(user)).toBe(3000);
    });

    it('transfer.complete → confirmation opérateur tracée', async () => {
      const user = await cmUser({ walletBalance: 10000 });
      const tx = await completedWithdrawal(user);
      await notchpayWebhook('transfer.complete', {
        reference: tx.externalReference,
        merchant_reference: tx.reference,
      });
      expect((await Transaction.findById(tx._id))!.metadata?.notchpayStatus).toBe('confirmed');
    });

    it('réconciliation : un retrait "pending" échoué chez NotchPay sans webhook est remboursé', async () => {
      const user = await cmUser({ walletBalance: 10000 });
      const tx = await completedWithdrawal(user);
      await Transaction.collection.updateOne(
        { _id: tx._id },
        { $set: { status: 'pending', createdAt: new Date(Date.now() - 60 * 60 * 1000) } },
      );
      const get = jest
        .spyOn(notchpayAdminApi, 'get')
        .mockResolvedValue({ data: { transfer: { status: 'failed' } } } as never);
      jest
        .spyOn(notchpayApi, 'get')
        .mockResolvedValue({ data: { transaction: { status: 'pending' } } } as never);

      const r1 = await NotchPayReconciliationService.reconcile();
      const r2 = await NotchPayReconciliationService.reconcile();
      expect(get).toHaveBeenCalledWith(`/transfers/${tx.externalReference}`);
      expect(r1.transfersRefunded).toBe(1);
      expect(r2.transfersRefunded).toBe(0);
      expect(await balanceOf(user)).toBe(10000);
    });
  });

  // ------------------------------------------------------------- consultation
  describe('Consultation : solde, historique, factures', () => {
    it('solde et historique ne montrent que les données de l’utilisateur', async () => {
      const a = await cmUser({ walletBalance: 777 });
      const b = await cmUser({ walletBalance: 5000 });
      await WalletService.executeTransaction({
        userId: String(b._id),
        amount: 100,
        type: 'saving_transfer',
        description: 'b',
        paymentMethod: 'wallet',
      });
      expect((await as(a).get('/fintech/wallet/balance')).body.data).toEqual({
        balance: 777,
        currency: 'XAF',
      });
      expect((await as(a).get('/fintech/wallet/transactions')).body.results).toBe(0);
    });

    it('liste des paiements : uniquement les siens, filtrable par type', async () => {
      const a = await cmUser();
      const b = await cmUser();
      await pendingNotchPayPayment(a, { type: 'deposit' });
      await pendingNotchPayPayment(a, { type: 'subscription' });
      await pendingNotchPayPayment(b);
      expect((await as(a).get('/payments')).body.results).toBe(2);
      expect((await as(a).get('/payments?type=subscription')).body.results).toBe(1);
    });

    it('facture d’un dépôt : PDF généré et stocké ; SÉCURITÉ : refusée à un autre utilisateur', async () => {
      const user = await cmUser();
      const p = await pendingNotchPayPayment(user, { amount: 2000 });
      await notchpayWebhook('payment.complete', {
        reference: p.externalReference,
        merchant_reference: p.reference,
      });
      const tx = await Transaction.findOne({ userId: user._id, category: 'deposit' });
      const mine = await as(user).get(`/fintech/invoice/${tx!._id}`);
      expect(mine.status).toBe(200);
      expect(mine.body.data.invoiceNumber).toMatch(/^INV-/);
      const intruder = await cmUser();
      expect((await as(intruder).get(`/fintech/invoice/${tx!._id}`)).status).toBe(404);
    });
  });
  // ------------------------------------------------------------- décisions produit (non-régression)
  describe('Règles validées par le produit', () => {
    const withdraw = (user: { _id: unknown }, amount: unknown) =>
      as(user).post('/fintech/payout/withdraw').send({ amount, phone: MTN_PHONE, provider: 'mtn' });

    it('retrait de 50 000 XAF exactement : accepté, frais en plus du plafond', async () => {
      const user = await cmUser({ walletBalance: 60000, kycLevel: 'verified' });
      jest
        .spyOn(notchpayAdminApi, 'post')
        .mockResolvedValue({ data: { transfer: { reference: 'trf.test_max' } } } as never);
      const res = await withdraw(user, 50000);
      expect(res.status).toBe(200);
      expect(res.body.data.fees).toBe(1500);
      expect(await balanceOf(user)).toBe(60000 - 51500);
    });

    it('retrait au-delà de 50 000 XAF → 400 sans débit', async () => {
      const user = await cmUser({ walletBalance: 100000, kycLevel: 'verified' });
      const spy = jest.spyOn(notchpayAdminApi, 'post');
      expect((await withdraw(user, 50001)).status).toBe(400);
      expect(spy).not.toHaveBeenCalled();
      expect(await balanceOf(user)).toBe(100000);
    });

    it('anti-fraude : jusqu’à 9 tentatives de dépôt/heure → autorisé ; à partir de 10 → bloqué (403)', async () => {
      const user = await cmUser();
      const spy = jest.spyOn(notchpayApi, 'post').mockResolvedValue({
        data: {
          transaction: { reference: 'trx.test_burst' },
          authorization_url: 'https://pay.notchpay.co/x',
        },
      } as never);
      for (let i = 0; i < 9; i++) await pendingNotchPayPayment(user, { amount: 1000 });
      expect(
        (await as(user).post('/payments/init/notchpay').send({ type: 'deposit', amount: 1000 }))
          .status,
      ).toBe(200);
      const blocked = await as(user)
        .post('/payments/init/notchpay')
        .send({ type: 'deposit', amount: 1000 });
      expect(blocked.status).toBe(403);
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });
});
