/**
 * MODULE INVESTISSEMENTS (premium) — tests de bout en bout : création (débit réel du wallet),
 * revalorisation (admin uniquement), clôture (crédit à la valeur serveur), suppression,
 * concurrence, droits d'accès.
 */
import { useTestDB } from '../helpers/db';
import { anon, as } from '../helpers/http';
import { createUser, createPremium, createAdmin } from '../helpers/factories';
import User from '../../src/models/User';
import Investment from '../../src/models/Investment';
import Transaction from '../../src/models/Transaction';
import FeatureFlag from '../../src/models/FeatureFlag';
import { FeatureFlagService } from '../../src/services/featureFlagService';

jest.setTimeout(60000);

const balanceOf = async (u: { _id: unknown }) => (await User.findById(u._id))!.walletBalance;
const invest = (u: { _id: unknown }, o: Record<string, unknown> = {}) =>
  as(u)
    .post('/investments')
    .send({ title: 'Actions BVMAC', type: 'stock', initialAmount: 10000, ...o });

async function position(balance = 50000) {
  const user = await createPremium({ walletBalance: balance });
  const res = await invest(user);
  expect(res.status).toBeLessThan(300);
  const inv = await Investment.findOne({ userId: user._id });
  return { user, id: String(inv!._id) };
}
const revalue = async (id: string, value: number) =>
  as(await createAdmin())
    .patch(`/admin/investments/${id}/value`)
    .send({ value });

const setInvestments = (isEnabled: boolean) =>
  FeatureFlag.updateOne(
    { slug: 'feat_investments' },
    { $set: { isEnabled, name: 'Investissements' } },
    { upsert: true },
  );

describe('API /investments', () => {
  useTestDB();
  beforeEach(() => setInvestments(true));

  describe('Désactivation (décision produit : OFF par défaut)', () => {
    it('le flag est créé désactivé sur une base neuve', async () => {
      await FeatureFlag.deleteMany({});
      await FeatureFlagService.seed();
      expect((await FeatureFlag.findOne({ slug: 'feat_investments' }))!.isEnabled).toBe(false);
    });

    it('le redémarrage (seed) ne réécrase plus le choix d’un admin', async () => {
      await FeatureFlagService.seed();
      await FeatureFlag.updateOne({ slug: 'feat_tontines' }, { isEnabled: false });
      await FeatureFlag.updateOne({ slug: 'feat_investments' }, { isEnabled: true });
      await FeatureFlagService.seed();
      expect((await FeatureFlag.findOne({ slug: 'feat_tontines' }))!.isEnabled).toBe(false);
      expect((await FeatureFlag.findOne({ slug: 'feat_investments' }))!.isEnabled).toBe(true);
    });

    it('désactivé : ouvrir une position est refusé, mais les positions existantes restent consultables et récupérables', async () => {
      const { user, id } = await position();
      await setInvestments(false);
      const res = await invest(user);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FEATURE_DISABLED');
      expect(await balanceOf(user)).toBe(40000);
      expect((await as(user).get('/investments')).body.data).toHaveLength(1);
      expect((await as(user).post(`/investments/${id}/close`)).status).toBeLessThan(300);
      expect(await balanceOf(user)).toBe(50000);
    });
  });

  it('réservé aux abonnés premium / business', async () => {
    expect((await invest(await createUser({ walletBalance: 50000 }))).status).toBe(403);
    expect(
      (await invest(await createUser({ plan: 'business', walletBalance: 50000 }))).status,
    ).toBeLessThan(300);
  });

  it('création : débite réellement le wallet, valeur initiale = montant, devise du wallet', async () => {
    const { user, id } = await position();
    expect(await balanceOf(user)).toBe(40000);
    expect(await Investment.findById(id)).toMatchObject({
      currentValue: 10000,
      status: 'active',
      currency: 'XAF',
    });
  });

  it.each([
    ['montant nul', { initialAmount: 0 }],
    ['montant texte', { initialAmount: 'beaucoup' }],
    ['type inconnu', { type: 'loterie' }],
    ['titre absent', { title: '' }],
  ])('refuse : %s → 400', async (_l, o) => {
    const user = await createPremium({ walletBalance: 50000 });
    expect((await invest(user, o)).status).toBe(400);
    expect(await balanceOf(user)).toBe(50000);
  });

  it('SÉCURITÉ : valeur actuelle / devise non fabricables par le client', async () => {
    const user = await createPremium({ walletBalance: 50000 });
    await invest(user, { currentValue: 999999, currency: 'EUR', status: 'closed' });
    expect(await Investment.findOne({ userId: user._id })).toMatchObject({
      currentValue: 10000,
      currency: 'XAF',
      status: 'active',
    });
  });

  it('solde insuffisant → 400, aucun investissement', async () => {
    const user = await createPremium({ walletBalance: 100 });
    expect((await invest(user)).status).toBe(400);
    expect(await Investment.countDocuments({ userId: user._id })).toBe(0);
  });

  it('SÉCURITÉ : seul un admin revalorise (le propriétaire ne peut pas)', async () => {
    const { user, id } = await position();
    expect(
      (await as(user).patch(`/admin/investments/${id}/value`).send({ value: 1e9 })).status,
    ).toBe(403);
    expect((await revalue(id, 12000)).status).toBe(200);
    expect((await Investment.findById(id))!.currentValue).toBe(12000);
  });

  it('clôture : crédit à la valeur serveur, valeur envoyée par le client ignorée', async () => {
    const { user, id } = await position();
    await revalue(id, 12000);
    expect(
      (await as(user).post(`/investments/${id}/close`).send({ value: 1e9 })).status,
    ).toBeLessThan(300);
    expect(await balanceOf(user)).toBe(52000);
    expect(
      await Transaction.countDocuments({ userId: user._id, category: 'investment_close' }),
    ).toBe(1);
  });

  it('CONCURRENCE : clôtures simultanées → créditée une seule fois, jamais d’erreur 500', async () => {
    const { user, id } = await position();
    const r = await Promise.all(
      Array.from({ length: 4 }, () => as(user).post(`/investments/${id}/close`)),
    );
    expect(r.every((x) => x.status < 500)).toBe(true);
    expect(await balanceOf(user)).toBe(50000);
  });

  it('SÉCURITÉ ARGENT : supprimer une position en perte ne rembourse PAS le montant initial', async () => {
    const { user, id } = await position();
    await revalue(id, 5000);
    await as(user).delete(`/investments/${id}`);
    expect(await balanceOf(user)).toBe(45000);
    expect(await Investment.findById(id)).toBeNull();
  });

  it('supprimer une position déjà clôturée ne crédite rien de plus', async () => {
    const { user, id } = await position();
    await as(user).post(`/investments/${id}/close`);
    await as(user).delete(`/investments/${id}`);
    expect(await balanceOf(user)).toBe(50000);
  });

  it('SÉCURITÉ : impossible de clôturer / supprimer la position d’un autre', async () => {
    const { id } = await position();
    const other = await createPremium({ walletBalance: 0 });
    expect((await as(other).post(`/investments/${id}/close`)).status).toBe(404);
    expect((await as(other).delete(`/investments/${id}`)).status).toBe(404);
    expect(await balanceOf(other)).toBe(0);
    expect((await as(other).get('/investments')).body.data).toHaveLength(0);
  });

  it('sans authentification → 401', async () => {
    expect((await anon().get('/investments')).status).toBe(401);
  });
});
