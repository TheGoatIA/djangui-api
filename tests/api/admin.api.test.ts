/**
 * API ADMIN (back-office) — tests de bout en bout sur les cas d'usage du dashboard admin :
 * utilisateurs, statuts, abonnements, crédits de simulation, retraits (4 yeux + vérification
 * opérateur), objectifs, tontines, réglages, argent réel, feature flags, pays, défis,
 * export, logs, sauvegardes, audit, rôles admin / support.
 */
import { useTestDB } from '../helpers/db';
import { as } from '../helpers/http';
import { createUser, createAdmin, createSupport, accessTokenFor } from '../helpers/factories';
import User from '../../src/models/User';
import Transaction from '../../src/models/Transaction';
import SavingGoal from '../../src/models/SavingGoal';
import Tontine from '../../src/models/Tontine';
import AuditLog from '../../src/models/AuditLog';
import Challenge from '../../src/models/Challenge';
import FeatureFlag from '../../src/models/FeatureFlag';
import { WalletService } from '../../src/services/walletService';
import { FeatureFlagService } from '../../src/services/featureFlagService';
import { notchpayAdminApi } from '../../src/config/notchpay';

jest.setTimeout(90000);

const balanceOf = async (u: { _id: unknown }) => (await User.findById(u._id))!.walletBalance;

describe('API /admin', () => {
  useTestDB();

  describe('Tableau de bord et utilisateurs', () => {
    it('statistiques accessibles admin et support', async () => {
      await createUser();
      for (const who of [await createAdmin(), await createSupport()]) {
        expect((await as(who).get('/admin/stats')).status).toBe(200);
      }
    });

    it('liste paginée, recherche, détail utilisateur sans secrets', async () => {
      const target = await createUser({ firstName: 'Ngozi', email: 'ngozi.unique@example.com' });
      const admin = await createAdmin();
      const list = await as(admin).get('/admin/users?search=ngozi.unique');
      expect(list.status).toBe(200);
      expect(JSON.stringify(list.body)).toContain('ngozi.unique@example.com');
      const detail = await as(admin).get(`/admin/users/${target._id}`);
      expect(detail.status).toBe(200);
      expect(JSON.stringify(detail.body)).not.toMatch(/"password"|refreshToken|totpSecret/);
    });

    it('modification : champs autorisés seulement, auditée ; le support ne peut pas modifier', async () => {
      const target = await createUser();
      const admin = await createAdmin();
      await as(admin)
        .patch(`/admin/users/${target._id}`)
        .send({ firstName: 'Nouveau', walletBalance: 999999, password: 'x' });
      const db = await User.findById(target._id).select('+password');
      expect(db!.firstName).toBe('Nouveau');
      expect(db!.walletBalance).toBe(0);
      expect(await AuditLog.countDocuments({ resourceId: String(target._id) })).toBeGreaterThan(0);
      expect(
        (
          await as(await createSupport())
            .patch(`/admin/users/${target._id}`)
            .send({ firstName: 'x' })
        ).status,
      ).toBe(403);
    });

    it('SÉCURITÉ : suspension effective IMMÉDIATEMENT (jetons déjà émis refusés), réactivation possible', async () => {
      const target = await createUser();
      const token = accessTokenFor(target);
      await new Promise((r) => setTimeout(r, 1100));
      const admin = await createAdmin();
      expect(
        (await as(admin).patch(`/admin/users/${target._id}/status`).send({ status: 'suspended' }))
          .status,
      ).toBe(200);
      expect((await as(null, { token }).get('/auth/me')).status).toBeGreaterThanOrEqual(401);
      expect((await User.findById(target._id))!.isActive).toBe(false);
      await as(admin).patch(`/admin/users/${target._id}/status`).send({ status: 'active' });
      expect((await as(target).get('/auth/me')).status).toBe(200);
    });

    it('statut invalide → 400', async () => {
      const target = await createUser();
      expect(
        (
          await as(await createAdmin())
            .patch(`/admin/users/${target._id}/status`)
            .send({ status: 'vip' })
        ).status,
      ).toBe(400);
    });

    it('abonnement manuel : premium 30 jours, puis retour au gratuit', async () => {
      const target = await createUser();
      const admin = await createAdmin();
      expect(
        (
          await as(admin)
            .put(`/admin/users/${target._id}/subscription`)
            .send({ plan: 'premium', durationDays: 30, reason: 'geste commercial' })
        ).status,
      ).toBe(200);
      expect(((await User.findById(target._id)) as any).isPremium).toBe(true);
      await as(admin)
        .put(`/admin/users/${target._id}/subscription`)
        .send({ plan: 'free', reason: 'fin' });
      expect(((await User.findById(target._id)) as any).isPremium).toBe(false);
      expect(
        (await as(admin).put(`/admin/users/${target._id}/subscription`).send({ plan: 'gold' }))
          .status,
      ).toBe(400);
    });

    it('révocation des sessions d’un utilisateur', async () => {
      const target = await createUser();
      expect(
        (await as(await createAdmin()).delete(`/admin/users/${target._id}/sessions`)).status,
      ).toBeLessThan(300);
    });
  });

  describe('Crédit de simulation', () => {
    it('autorisé en mode simulation (motif obligatoire, plafonné) ; INTERDIT en argent réel', async () => {
      const target = await createUser();
      const admin = await createAdmin();
      expect(
        (await as(admin).post(`/admin/users/${target._id}/wallet/credit`).send({ amount: 1000 }))
          .status,
      ).toBe(400);
      expect(
        (
          await as(admin)
            .post(`/admin/users/${target._id}/wallet/credit`)
            .send({ amount: 600000, reason: 'test' })
        ).status,
      ).toBe(400);
      expect(
        (
          await as(admin)
            .post(`/admin/users/${target._id}/wallet/credit`)
            .send({ amount: 1000, reason: 'démo' })
        ).status,
      ).toBeLessThan(300);
      expect(await balanceOf(target)).toBe(1000);
      await FeatureFlagService.setRealMoneyMode(true, String(admin._id));
      expect([400, 403]).toContain(
        (
          await as(admin)
            .post(`/admin/users/${target._id}/wallet/credit`)
            .send({ amount: 1000, reason: 'démo' })
        ).status,
      );
      expect(await balanceOf(target)).toBe(0); // et le solde de simulation a été remis à zéro au lancement
    });
  });

  describe('Retraits (Payouts)', () => {
    async function withdrawal(status: 'pending' | 'completed' | 'failed' = 'pending') {
      const user = await createUser({ walletBalance: 10000 });
      const tx = await WalletService.executeTransaction({
        userId: String(user._id),
        amount: 2100,
        fees: 100,
        type: 'withdrawal',
        description: 'Retrait',
        paymentMethod: 'wallet',
        metadata: { phone: '+237670000000', provider: 'cm.mtn' },
        silent: true,
      });
      await Transaction.updateOne({ _id: tx._id }, { status, externalReference: 'trf.test_x' });
      return { user, txId: String(tx._id) };
    }

    it('la liste montre les VRAIS retraits (transactions wallet), avec l’utilisateur', async () => {
      const { user } = await withdrawal();
      const res = await as(await createSupport()).get('/admin/payouts');
      expect(res.status).toBe(200);
      expect(res.body.data.payouts).toHaveLength(1);
      expect(res.body.data.payouts[0]).toMatchObject({
        amount: 2000,
        fees: 100,
        status: 'pending',
        method: 'cm.mtn',
      });
      expect(res.body.data.payouts[0].userId.email).toBe(user.email);
    });

    it('4 YEUX : l’admin qui demande ne peut pas approuver ; un second admin approuve → vérification opérateur', async () => {
      const { user, txId } = await withdrawal();
      const a = await createAdmin();
      const b = await createAdmin();
      jest
        .spyOn(notchpayAdminApi, 'get')
        .mockResolvedValue({ data: { transfer: { status: 'failed' } } } as never);
      expect((await as(a).post(`/admin/payouts/${txId}/retry`)).status).toBe(200);
      expect((await as(a).post(`/admin/payouts/${txId}/retry`)).status).toBe(400);
      expect((await as(a).post(`/admin/payouts/${txId}/approve-retry`)).status).toBe(403);
      const ok = await as(b).post(`/admin/payouts/${txId}/approve-retry`);
      expect(ok.body.outcome).toBe('refunded');
      expect(await balanceOf(user)).toBe(10000); // remboursé montant + frais
      expect(await AuditLog.countDocuments({ action: 'PAYOUT_RETRY_APPROVED' })).toBe(1);
    });

    it('SÉCURITÉ ARGENT : une relance n’envoie JAMAIS un second transfert', async () => {
      const { txId } = await withdrawal();
      const post = jest.spyOn(notchpayAdminApi, 'post');
      jest
        .spyOn(notchpayAdminApi, 'get')
        .mockResolvedValue({ data: { transfer: { status: 'complete' } } } as never);
      await as(await createAdmin()).post(`/admin/payouts/${txId}/retry`);
      const r = await as(await createAdmin()).post(`/admin/payouts/${txId}/approve-retry`);
      expect(r.body.outcome).toBe('confirmed');
      expect(post).not.toHaveBeenCalled();
      expect((await Transaction.findById(txId))!.status).toBe('completed');
    });

    it('SÉCURITÉ ARGENT : un retrait déjà remboursé n’est jamais repassé en "completed"', async () => {
      const { user, txId } = await withdrawal('failed');
      jest
        .spyOn(notchpayAdminApi, 'get')
        .mockResolvedValue({ data: { transfer: { status: 'complete' } } } as never);
      await as(await createAdmin()).post(`/admin/payouts/${txId}/retry`);
      const r = await as(await createAdmin()).post(`/admin/payouts/${txId}/approve-retry`);
      expect(r.body.outcome).toBe('unchanged');
      expect((await Transaction.findById(txId))!.status).toBe('failed');
      expect(await balanceOf(user)).toBe(10000 - 2100);
    });

    it('rejet de la relance avec motif ; un retrait confirmé ne peut pas être relancé', async () => {
      const { txId } = await withdrawal();
      const a = await createAdmin();
      await as(a).post(`/admin/payouts/${txId}/retry`);
      expect(
        (
          await as(await createAdmin())
            .post(`/admin/payouts/${txId}/reject-retry`)
            .send({ reason: 'doublon' })
        ).status,
      ).toBe(200);
      const done = await withdrawal('completed');
      expect((await as(a).post(`/admin/payouts/${done.txId}/retry`)).status).toBe(400);
    });

    it('le support consulte mais ne relance pas', async () => {
      const { txId } = await withdrawal();
      expect((await as(await createSupport()).post(`/admin/payouts/${txId}/retry`)).status).toBe(
        403,
      );
    });
  });

  describe('Objectifs et tontines', () => {
    it('ARGENT : supprimer un objectif rembourse les contributeurs (sans pénalité) et est audité', async () => {
      const owner = await createUser({ walletBalance: 10000 });
      const goal = await SavingGoal.create({
        userId: owner._id,
        name: 'g',
        targetAmount: 50000,
        deadline: new Date(Date.now() + 1e9),
      });
      await WalletService.executeTransaction({
        userId: String(owner._id),
        amount: 8000,
        type: 'saving_transfer',
        description: 'g',
        paymentMethod: 'wallet',
      });
      await SavingGoal.updateOne(
        { _id: goal._id },
        {
          currentAmount: 8000,
          contributions: [
            { userId: owner._id, amount: 8000, date: new Date(), type: 'contribution' },
          ],
        },
      );
      expect(await balanceOf(owner)).toBe(2000);
      const res = await as(await createAdmin()).delete(`/admin/goals/${goal._id}`);
      expect(res.status).toBe(200);
      expect(await balanceOf(owner)).toBe(10000);
      expect(await AuditLog.countDocuments({ action: 'GOAL_ADMIN_DELETE' })).toBe(1);
    });

    it('tontine active : montant/parts/fonds social figés, pas de clôture par simple statut ; suspension auditée', async () => {
      const creator = await createUser();
      const t = await Tontine.create({
        name: 't',
        creatorId: creator._id,
        frequency: 'monthly',
        startDate: new Date(),
        contributionAmount: 1000,
        totalParts: 2,
        status: 'active',
        socialFund: { enabled: true, amount: 500, totalCollected: 1000 },
      });
      const admin = await createAdmin();
      expect(
        (await as(admin).patch(`/admin/tontines/${t._id}`).send({ contributionAmount: 1 })).status,
      ).toBe(400);
      expect(
        (
          await as(admin)
            .patch(`/admin/tontines/${t._id}`)
            .send({ socialFund: { enabled: true, amount: 1, totalCollected: 0 } })
        ).status,
      ).toBe(400);
      expect(
        (await as(admin).patch(`/admin/tontines/${t._id}`).send({ status: 'completed' })).status,
      ).toBe(400);
      expect(
        (
          await as(admin)
            .patch(`/admin/tontines/${t._id}`)
            .send({ status: 'suspended', name: 'Renommée' })
        ).status,
      ).toBe(200);
      const db = await Tontine.findById(t._id);
      expect(db).toMatchObject({ status: 'suspended', name: 'Renommée', contributionAmount: 1000 });
      expect(db!.socialFund!.totalCollected).toBe(1000);
      expect(await AuditLog.countDocuments({ action: 'TONTINE_ADMIN_UPDATE' })).toBe(1);
    });
  });

  describe('Réglages, argent réel, feature flags, pays, défis', () => {
    it('passer en argent réel via les réglages déclenche la remise à zéro des soldes de simulation', async () => {
      const u = await createUser({ walletBalance: 50000 });
      const admin = await createAdmin();
      expect(
        (
          await as(admin)
            .patch('/admin/settings')
            .send({ key: 'real_money_mode', value: true, group: 'payment' })
        ).status,
      ).toBe(200);
      expect(await FeatureFlagService.isRealMoneyEnabled()).toBe(true);
      expect(await balanceOf(u)).toBe(0);
    });

    it('réglage : clé invalide ou groupe inconnu → 400', async () => {
      const admin = await createAdmin();
      expect((await as(admin).patch('/admin/settings').send({ key: 'a b', value: 1 })).status).toBe(
        400,
      );
      expect(
        (await as(admin).patch('/admin/settings').send({ key: 'x', value: 1, group: 'hack' }))
          .status,
      ).toBe(400);
    });

    it('feature flag : bascule persistée et respectée au redémarrage', async () => {
      await FeatureFlagService.seed();
      const flag = await FeatureFlag.findOne({ slug: 'feat_tontines' });
      await as(await createAdmin())
        .patch(`/admin/feature-flags/${flag!._id}`)
        .send({ isEnabled: false });
      await FeatureFlagService.seed();
      expect((await FeatureFlag.findById(flag!._id))!.isEnabled).toBe(false);
    });

    it('pays : ajout puis visible publiquement ; le support ne peut pas ajouter', async () => {
      const admin = await createAdmin();
      expect(
        (
          await as(await createSupport())
            .post('/admin/countries')
            .send({ code: 'GA', name: 'Gabon', currency: 'XAF', currencySymbol: 'FCFA' })
        ).status,
      ).toBe(403);
      expect(
        (
          await as(admin).post('/admin/countries').send({
            code: 'GA',
            name: 'Gabon',
            currency: 'XAF',
            currencySymbol: 'FCFA',
            isActive: true,
          })
        ).status,
      ).toBeLessThan(300);
      const pub = await as(null).get('/system/countries');
      expect(JSON.stringify(pub.body)).toContain('GA');
    });

    it('défis : création (champs filtrés), modification, suppression', async () => {
      const admin = await createAdmin();
      const res = await as(admin).post('/admin/challenges').send({
        title: 'Défi',
        description: 'd',
        type: 'saving',
        targetAmount: 1000,
        durationDays: 7,
        _id: '000000000000000000000001',
      });
      expect(res.status).toBeLessThan(300);
      const c = await Challenge.findOne({ title: 'Défi' });
      expect(String(c!._id)).not.toBe('000000000000000000000001');
      expect(
        (await as(admin).patch(`/admin/challenges/${c!._id}`).send({ title: 'Défi 2' })).status,
      ).toBeLessThan(300);
      expect((await as(admin).delete(`/admin/challenges/${c!._id}`)).status).toBeLessThan(300);
    });
  });

  describe('Données et maintenance', () => {
    it('export de la base : aucun secret (mots de passe, TOTP, jetons, coffre revendeur)', async () => {
      await createUser();
      const res = await as(await createAdmin()).get('/admin/db/export');
      expect(res.status).toBe(200);
      const text =
        typeof res.text === 'string' && res.text.length ? res.text : JSON.stringify(res.body);
      expect(text).not.toMatch(
        /"password":|"totpSecret"|"refreshToken"|"passwordResetToken"|"encryptedPassword"|"encryptedPin"/,
      );
      expect(await AuditLog.countDocuments({ action: /EXPORT/i })).toBeGreaterThan(0);
    });

    it('export réservé à l’admin (pas au support)', async () => {
      expect((await as(await createSupport()).get('/admin/db/export')).status).toBe(403);
    });

    it('SÉCURITÉ : téléchargement de logs / restauration protégés contre le path traversal', async () => {
      const admin = await createAdmin();
      for (const f of ['..%2F..%2F.env', '..%2Fpackage.json', 'x.txt']) {
        expect((await as(admin).get(`/admin/logs/${f}`)).status).toBeGreaterThanOrEqual(400);
        expect((await as(admin).post(`/admin/db/restore/${f}`)).status).toBeGreaterThanOrEqual(400);
      }
    });

    it('journal d’audit consultable par le support', async () => {
      expect((await as(await createSupport()).get('/admin/audit-logs')).status).toBe(200);
    });
  });
});
