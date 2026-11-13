/**
 * MIGRATIONS DE DONNÉES (exécutées une fois au démarrage) — testées contre une vraie base.
 */
import { useTestDB } from '../helpers/db';
import { createUser } from '../helpers/factories';
import { as } from '../helpers/http';
import User from '../../src/models/User';
import Challenge from '../../src/models/Challenge';
import UserChallenge from '../../src/models/UserChallenge';
import FeatureFlag from '../../src/models/FeatureFlag';
import Migration from '../../src/models/Migration';
import { MigrationService } from '../../src/services/migrationService';
import { dedupeActiveChallenges } from '../../src/services/migrations/dedupeActiveChallenges';
import SavingGoal from '../../src/models/SavingGoal';
import Tontine from '../../src/models/Tontine';
import { FeatureFlagService } from '../../src/services/featureFlagService';
import mongoose from 'mongoose';
import os from 'node:os';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import Transaction from '../../src/models/Transaction';
import { migrateLocalUploads } from '../../src/services/migrations/localUploadsToStorage';
import { StorageService } from '../../src/services/storageService';

jest.setTimeout(60000);
const balanceOf = async (u: { _id: unknown }) => (await User.findById(u._id))!.walletBalance;

describe('Migrations', () => {
  useTestDB();

  describe('Doublons de participations actives aux défis', () => {
    async function duplicates() {
      // État produit par l'ancien bug : l'index unique n'existait pas encore
      await UserChallenge.collection.dropIndex('userId_1_challengeId_1').catch(() => undefined);
      const user = await createUser({ walletBalance: 1000 });
      const ch = await Challenge.create({
        title: 't',
        description: 'd',
        type: 'saving',
        targetAmount: 40000,
        durationDays: 28,
      });
      const base = {
        userId: user._id,
        challengeId: ch._id,
        status: 'active',
        endDate: new Date(Date.now() + 1e9),
      };
      const best = await UserChallenge.create({ ...base, progress: 50, currentValue: 20000 });
      const dupA = await UserChallenge.create({ ...base, progress: 25, currentValue: 10000 });
      const dupB = await UserChallenge.create({ ...base, progress: 0, currentValue: 0 });
      return { user, best, dupA, dupB };
    }

    it('simulation : rapport sans modification', async () => {
      const { best } = await duplicates();
      const r = await dedupeActiveChallenges({ apply: false });
      expect(r).toEqual([expect.objectContaining({ kept: String(best._id), refunded: 10000 })]);
      expect(await UserChallenge.countDocuments({ status: 'active' })).toBe(3);
    });

    it('application : garde la plus avancée, rembourse intégralement les autres, une seule fois, puis crée l’index', async () => {
      const { user, best, dupA, dupB } = await duplicates();
      await dedupeActiveChallenges({ apply: true });
      await dedupeActiveChallenges({ apply: true });
      expect((await UserChallenge.findById(best._id))!.status).toBe('active');
      for (const d of [dupA, dupB])
        expect((await UserChallenge.findById(d._id))!.status).toBe('abandoned');
      expect(await balanceOf(user)).toBe(11000);
      const indexes = await UserChallenge.collection.indexes();
      expect(indexes.some((i) => i.name === 'userId_1_challengeId_1' && i.unique)).toBe(true);
    });
  });

  it('désactivation des investissements : une seule fois, le choix ultérieur de l’admin est respecté', async () => {
    await FeatureFlag.create({
      name: 'Investissements',
      slug: 'feat_investments',
      isEnabled: true,
    });
    await MigrationService.runDisableInvestmentsMigration();
    expect((await FeatureFlag.findOne({ slug: 'feat_investments' }))!.isEnabled).toBe(false);
    await FeatureFlag.updateOne({ slug: 'feat_investments' }, { isEnabled: true });
    await MigrationService.runDisableInvestmentsMigration();
    expect((await FeatureFlag.findOne({ slug: 'feat_investments' }))!.isEnabled).toBe(true);
    expect(
      await Migration.countDocuments({ migrationId: 'disable-investments-by-default-v1' }),
    ).toBe(1);
  });

  describe('Passage à l’argent réel', () => {
    it('la réinitialisation des données de simulation n’a lieu qu’au PREMIER passage en argent réel, une seule fois', async () => {
      const user = await createUser();
      const goal = await SavingGoal.create({
        userId: user._id,
        name: 'g',
        targetAmount: 1000,
        currentAmount: 500,
        deadline: new Date(Date.now() + 1e9),
      });
      const t = await Tontine.create({
        name: 't',
        creatorId: user._id,
        frequency: 'monthly',
        startDate: new Date(),
        contributionAmount: 10,
        totalParts: 2,
        status: 'active',
      });

      // Démarrage / désactivation : rien n'est touché
      await FeatureFlagService.setRealMoneyMode(false);
      expect((await SavingGoal.findById(goal._id))!.currentAmount).toBe(500);

      await FeatureFlagService.setRealMoneyMode(true);
      expect((await SavingGoal.findById(goal._id))!.currentAmount).toBe(0);
      expect((await Tontine.findById(t._id))!.status).toBe('completed'); // statut valide (plus 'cancelled')

      // Rebasculer ne relance jamais la réinitialisation
      await SavingGoal.updateOne({ _id: goal._id }, { currentAmount: 300 });
      await FeatureFlagService.setRealMoneyMode(false);
      await FeatureFlagService.setRealMoneyMode(true);
      expect((await SavingGoal.findById(goal._id))!.currentAmount).toBe(300);
    });

    it('le démarrage du serveur n’appelle plus la migration "real money"', () => {
      const server = require('node:fs').readFileSync(
        require('node:path').join(__dirname, '../../src/server.ts'),
        'utf8',
      );
      expect(server).not.toMatch(/await MigrationService\.runRealMoneyMigration\(\)/);
    });
  });

  describe('Soldes de simulation au lancement de l’argent réel', () => {
    it('remis à zéro, archivés intégralement, tracés dans l’historique ; jamais deux fois', async () => {
      const a = await createUser({ walletBalance: 990100 });
      const b = await createUser({ walletBalance: 12.5 });
      const c = await createUser({ walletBalance: 0 });
      await FeatureFlagService.setRealMoneyMode(true);

      for (const u of [a, b, c]) expect((await User.findById(u._id))!.walletBalance).toBe(0);
      const archive = mongoose.connection.db!.collection('realmoneyarchives');
      const snap = await archive.findOne({ kind: 'wallet', refId: a._id });
      expect(snap!.snapshot.walletBalance).toBe(990100);
      expect(await archive.countDocuments({ kind: 'wallet' })).toBe(2);
      const line = await Transaction.findOne({ userId: a._id, category: 'simulation_reset' });
      expect(line).toMatchObject({ amount: 990100, paymentMethod: 'cash', status: 'completed' });

      // Après le lancement, un vrai solde n'est plus jamais touché
      await User.updateOne({ _id: a._id }, { walletBalance: 5000 });
      await FeatureFlagService.setRealMoneyMode(false);
      await FeatureFlagService.setRealMoneyMode(true);
      expect((await User.findById(a._id))!.walletBalance).toBe(5000);
      expect(
        await Transaction.countDocuments({ userId: a._id, category: 'simulation_reset' }),
      ).toBe(1);
    });

    it('SÉCURITÉ : si la remise à zéro échoue, l’argent réel reste DÉSACTIVÉ', async () => {
      await createUser({ walletBalance: 100000 });
      const spy = jest.spyOn(User, 'updateMany').mockRejectedValueOnce(new Error('disk full'));
      await expect(FeatureFlagService.setRealMoneyMode(true)).rejects.toThrow();
      expect(await FeatureFlagService.isRealMoneyEnabled()).toBe(false);
      spy.mockRestore();
      // nouvel essai propre (le verrou a été libéré)
      await FeatureFlagService.setRealMoneyMode(true);
      expect(await FeatureFlagService.isRealMoneyEnabled()).toBe(true);
      expect(await User.countDocuments({ walletBalance: { $gt: 0 } })).toBe(0);
    });
  });

  describe('Fichiers locaux de l’ancienne API → stockage objet', () => {
    function localDir() {
      const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'kauri-uploads-'));
      for (const k of ['avatars', 'receipts']) nodeFs.mkdirSync(nodePath.join(dir, k));
      nodeFs.writeFileSync(nodePath.join(dir, 'avatars', 'a1.jpg'), Buffer.from('avatar-bytes'));
      nodeFs.writeFileSync(nodePath.join(dir, 'receipts', 'r1.png'), Buffer.from('receipt-bytes'));
      return dir;
    }

    it('simulation puis application : avatars publics, preuves privées signées, fichiers conservés, idempotent', async () => {
      const dir = localDir();
      const withAvatar = await createUser({ avatar: '/uploads/avatars/a1.jpg' });
      const lost = await createUser({ avatar: '/uploads/avatars/absent.jpg' });
      const google = await createUser({ avatar: 'https://lh3.googleusercontent.com/a/x' });
      const ch = await Challenge.create({
        title: 't',
        description: 'd',
        type: 'saving',
        targetAmount: 10,
        durationDays: 7,
      });
      const uc = await UserChallenge.create({
        userId: withAvatar._id,
        challengeId: ch._id,
        status: 'active',
        endDate: new Date(Date.now() + 1e9),
        weeks: [
          {
            weekNumber: 1,
            targetAmount: 10,
            savedAmount: 10,
            status: 'completed',
            proofImageUrl: '/uploads/receipts/r1.png',
          },
        ],
      });

      const dry = await migrateLocalUploads({ apply: false, uploadsDir: dir });
      expect(dry).toEqual({
        avatars: { migrated: 1, missing: [String(lost._id)] },
        challengeProofs: { migrated: 1, missing: [] },
      });
      expect((await User.findById(withAvatar._id))!.avatar).toBe('/uploads/avatars/a1.jpg');

      await migrateLocalUploads({ apply: true, uploadsDir: dir });
      const avatar = (await User.findById(withAvatar._id))!.avatar as string;
      expect(avatar).toContain('/kauri-avatars/avatars/legacy-a1.jpg');
      const parsed = StorageService.parseStoredUrl(avatar)!;
      expect((await StorageService.downloadBuffer(parsed.bucket, parsed.key)).toString()).toBe(
        'avatar-bytes',
      );
      expect((await User.findById(lost._id))!.avatar).toBe('/uploads/avatars/absent.jpg'); // rien de cassé
      expect((await User.findById(google._id))!.avatar).toBe(
        'https://lh3.googleusercontent.com/a/x',
      );

      const proof = (await UserChallenge.findById(uc._id))!.weeks[0].proofImageUrl as string;
      expect(proof).toContain(`/kauri-uploads/receipts/${withAvatar._id}/legacy-r1.png`);
      const viaApi = await as(withAvatar).get('/challenges/my-challenges');
      expect(viaApi.body.data[0].weeks[0].proofImageUrl).toMatch(/X-Amz-Signature=/);

      expect(nodeFs.existsSync(nodePath.join(dir, 'receipts', 'r1.png'))).toBe(true); // jamais supprimé
      const again = await migrateLocalUploads({ apply: true, uploadsDir: dir });
      expect(again.avatars.migrated + again.challengeProofs.migrated).toBe(0);
    });
  });
});
