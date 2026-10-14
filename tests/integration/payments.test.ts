/**
 * Non-régression des PAIEMENTS (argent réel) — nécessite une MongoDB en REPLICA SET
 * (transactions). Activé quand MONGO_RS_URI est défini (la CI le fournit) ; sinon la suite
 * est ignorée proprement pour ne pas bloquer un poste de développement sans replica set.
 *
 * Seuls les appels HTTP aux fournisseurs (Stripe / NotchPay) sont simulés.
 */
import crypto from 'node:crypto';
import request from 'supertest';
import mongoose from 'mongoose';

import app from '../../src/app';
import redis from '../../src/config/redis';
import stripe from '../../src/config/stripe';
import { notchpayApi, notchpayConfig } from '../../src/config/notchpay';
import Payment from '../../src/models/Payment';
import User from '../../src/models/User';
import { PaymentService } from '../../src/services/paymentService';
import { PaymentPollingService } from '../../src/services/paymentPollingService';

const RS_URI = process.env.MONGO_RS_URI;
const suite = RS_URI ? describe : describe.skip;

jest.setTimeout(60000);

suite('Paiements : confirmation par sondage, webhooks, idempotence', () => {
  const providerState = new Map<
    string,
    { status?: string; paid?: boolean; expired?: boolean; fail?: string }
  >();

  beforeAll(async () => {
    await mongoose.connect(RS_URI as string, { dbName: 'kauri_test_payments' });
    await mongoose.connection.db!.dropDatabase();
  });

  beforeEach(() => {
    providerState.clear();
    jest.spyOn(notchpayApi, 'get').mockImplementation((async (url: string) => {
      const ref = url.split('/').pop() as string;
      const s = providerState.get(ref);
      if (!s) throw new Error(`unknown ref ${ref}`);
      if (s.fail) throw new Error(s.fail);
      return { data: { transaction: { status: s.status } } };
    }) as never);
    jest.spyOn(stripe.checkout.sessions, 'retrieve').mockImplementation((async (id: string) => {
      const s = providerState.get(id);
      if (!s) throw new Error(`unknown session ${id}`);
      if (s.fail) throw new Error(s.fail);
      return {
        id,
        payment_status: s.paid ? 'paid' : 'unpaid',
        status: s.expired ? 'expired' : 'open',
      };
    }) as never);
  });

  afterAll(async () => {
    await mongoose.connection.close(true);
    if (redis.status === 'ready' || redis.status === 'connect') redis.disconnect();
  });

  let n = 0;
  const mkUser = async () =>
    User.create({
      email: `pay.${Date.now()}.${n++}@example.com`,
      password: 'Str0ng!Passw0rd',
      firstName: 'Pay',
      lastName: 'Test',
      country: 'CM',
    });
  const mkPayment = async (
    userId: unknown,
    o: {
      method: 'notchpay' | 'stripe';
      amount?: number;
      ageMs?: number;
      type?: string;
      meta?: object;
    },
  ) => {
    const reference = `CI-${Date.now()}-${n++}`;
    const externalReference = `${o.method === 'stripe' ? 'cs_test_' : 'np_'}${reference}`;
    const created = new Date(Date.now() - (o.ageMs ?? 60_000));
    const r = await Payment.collection.insertOne({
      userId,
      amount: o.amount ?? 5000,
      currency: 'XAF',
      method: o.method,
      type: o.type ?? 'deposit',
      status: 'pending',
      reference,
      externalReference,
      metadata: o.meta ?? {},
      createdAt: created,
      updatedAt: created,
    });
    return { id: r.insertedId, reference, externalReference };
  };
  const statusOf = async (id: unknown) => (await Payment.findById(id))?.status;
  const balanceOf = async (id: unknown) => (await User.findById(id))?.walletBalance;

  it('NotchPay payé -> paiement finalisé et portefeuille crédité une seule fois', async () => {
    const u = await mkUser();
    const p = await mkPayment(u._id, { method: 'notchpay', amount: 5000 });
    providerState.set(p.externalReference, { status: 'complete' });

    const r = await PaymentPollingService.pollPendingPayments();
    expect(r.completed).toBeGreaterThanOrEqual(1);
    expect(await statusOf(p.id)).toBe('completed');
    expect(await balanceOf(u._id)).toBe(5000);
  });

  it('Stripe payé -> finalisé ; session expirée -> failed sans crédit', async () => {
    const u = await mkUser();
    const paid = await mkPayment(u._id, { method: 'stripe', amount: 3000 });
    const expired = await mkPayment(u._id, { method: 'stripe', amount: 999 });
    providerState.set(paid.externalReference, { paid: true });
    providerState.set(expired.externalReference, { expired: true });

    await PaymentPollingService.pollPendingPayments();
    expect(await statusOf(paid.id)).toBe('completed');
    expect(await statusOf(expired.id)).toBe('failed');
    expect(await balanceOf(u._id)).toBe(3000);
  });

  it('paiement NotchPay échoué -> failed, aucun crédit', async () => {
    const u = await mkUser();
    const p = await mkPayment(u._id, { method: 'notchpay', amount: 1111 });
    providerState.set(p.externalReference, { status: 'failed' });
    await PaymentPollingService.pollPendingPayments();
    expect(await statusOf(p.id)).toBe('failed');
    expect(await balanceOf(u._id)).toBe(0);
  });

  it('une erreur fournisseur n’interrompt pas le lot', async () => {
    const u = await mkUser();
    const bad = await mkPayment(u._id, { method: 'notchpay', amount: 600 });
    const good = await mkPayment(u._id, { method: 'notchpay', amount: 400 });
    providerState.set(bad.externalReference, { fail: 'ETIMEDOUT' });
    providerState.set(good.externalReference, { status: 'complete' });

    const r = await PaymentPollingService.pollPendingPayments();
    expect(r.errors).toBeGreaterThanOrEqual(1);
    expect(await statusOf(bad.id)).toBe('pending');
    expect(await statusOf(good.id)).toBe('completed');
  });

  it('exécutions concurrentes (2 sondages + 2 vérifications manuelles) : crédité UNE fois', async () => {
    const u = await mkUser();
    const p = await mkPayment(u._id, { method: 'stripe', amount: 10000 });
    providerState.set(p.externalReference, { paid: true });

    await Promise.all([
      PaymentPollingService.pollPendingPayments(),
      PaymentPollingService.pollPendingPayments(),
      PaymentService.verifyTransaction(p.reference).catch(() => null),
      PaymentService.verifyTransaction(p.reference).catch(() => null),
    ]);
    // un rejeu tardif (webhook, /verify) reste sans effet
    await PaymentService.completePayment(p.reference).catch(() => null);

    expect(await balanceOf(u._id)).toBe(10000);
    expect(await statusOf(p.id)).toBe('completed');
  });

  it('abonnement payé -> plan premium activé', async () => {
    const u = await mkUser();
    const p = await mkPayment(u._id, {
      method: 'notchpay',
      amount: 2000,
      type: 'subscription',
      meta: { plan: 'premium' },
    });
    providerState.set(p.externalReference, { status: 'complete' });
    await PaymentPollingService.pollPendingPayments();
    const d = await User.findById(u._id);
    expect(d?.subscription?.plan).toBe('premium');
    expect(d?.subscription?.status).toBe('active');
  });

  it('webhook NotchPay signé : crédite une fois, la redélivrance est idempotente', async () => {
    const secret = 'notchpay-webhook-secret-ci';
    // le secret est lu à l'import de config/notchpay : on le force sur l'objet exporté
    notchpayConfig.webhookSecret = secret;

    const u = await mkUser();
    const p = await mkPayment(u._id, { method: 'notchpay', amount: 7000 });
    const body = JSON.stringify({ event: 'payment.complete', data: { reference: p.reference } });
    const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
    const send = () =>
      request(app)
        .post('/api/v1/webhooks/notchpay')
        .set('Content-Type', 'application/json')
        .set('x-notchpay-signature', sig)
        .send(body);

    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect(await balanceOf(u._id)).toBe(7000);
  });

  it('webhook : référence inconnue acquittée (200) sans planter', async () => {
    const secret = 'notchpay-webhook-secret-ci';
    notchpayConfig.webhookSecret = secret;
    const body = JSON.stringify({ event: 'payment.complete', data: { reference: 'NOPE' } });
    const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
    const r = await request(app)
      .post('/api/v1/webhooks/notchpay')
      .set('Content-Type', 'application/json')
      .set('x-notchpay-signature', sig)
      .send(body);
    expect(r.status).toBe(200);
  });
});
