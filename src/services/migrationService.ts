import mongoose from 'mongoose';
import User from '../models/User';
import Migration from '../models/Migration';
import UserChallenge from '../models/UserChallenge';
import SavingGoal from '../models/SavingGoal';
import Tontine from '../models/Tontine';
import Transaction from '../models/Transaction';
import { NotificationService } from './notificationService';
import logger from '../utils/logger';

/**
 * Service gérant les migrations de données "one-time" lors des déploiements.
 */
export class MigrationService {
  /**
   * Migre les utilisateurs existants vers le nouveau système Fintech.
   */
  static async runInitialFintechMigration() {
    // ... (code existant inchangé)
  }

  /**
   * Migration vers le système "Real Money" : reset des données fictives.
   */
  static async runRealMoneyMigration() {
    const migrationId = 'migrate-real-money-launch-v1';

    try {
      try {
        // 0. Le Lock Atomique de Migration
        // En mode PM2 Cluster, plusieurs instances démarrent en même temps.
        // En forçant la création dès le début, une seule instance réussira, les autres auront l'erreur E11000.
        await Migration.create({ migrationId });
      } catch (err: any) {
        if (err.code === 11000) {
          logger.info(
            `[Migration] Migration ${migrationId} déjà verrouillée ou effectuée par un autre processus.`,
          );
          return; // Sortie silencieuse pour les autres workers PM2
        }
        throw err;
      }

      logger.info(`[Migration] Lancement de la transition REAL MONEY : ${migrationId}...`);

      // 0bis. ARCHIVE FIRST — nothing is lost. A full snapshot of every value this
      // migration resets is kept in `realmoneyarchives` (upsert + $setOnInsert:
      // a retried run never overwrites the original values with already-reset ones).
      const archive = mongoose.connection.db!.collection('realmoneyarchives');
      const snap = async (kind: string, docs: any[]) => {
        if (!docs.length) return;
        await archive.bulkWrite(
          docs.map((d) => ({
            updateOne: {
              filter: { migrationId, kind, refId: d._id },
              update: {
                $setOnInsert: {
                  migrationId,
                  kind,
                  refId: d._id,
                  snapshot: d,
                  archivedAt: new Date(),
                },
              },
              upsert: true,
            },
          })),
        );
      };
      await snap(
        'wallet',
        await User.find({ walletBalance: { $gt: 0 } })
          .select('_id walletBalance currency')
          .lean(),
      );
      await snap(
        'goal',
        await SavingGoal.find({
          status: { $in: ['active', 'paused'] },
          currentAmount: { $gt: 0 },
        }).lean(),
      );
      await snap('challenge', await UserChallenge.find({ status: 'active' }).lean());
      await snap('tontine', await Tontine.find({ status: 'active' }).lean());

      // 1. Désinscrire des challenges (Reset à abandoned)
      const ChallengesReset = await UserChallenge.updateMany(
        { status: 'active' },
        {
          $set: {
            status: 'abandoned',
            progress: 0,
            currentValue: 0,
            'weeks.$[].status': 'skipped', // On marque les semaines comme sautées
          },
        },
      );

      // 2. Réinitialiser les objectifs d'épargne en cours (sauf terminés)
      const goalsReset = await SavingGoal.updateMany(
        { status: { $in: ['active', 'paused'] } },
        { $set: { currentAmount: 0, progress: 0, contributions: [] } },
      );

      // 3. Clôturer les tontines actives (fictives)
      // 'cancelled' is not a Tontine status (enum): updateMany does not run
      // validators and wrote invalid documents. 'completed' = closed.
      const tontinesReset = await Tontine.updateMany(
        { status: 'active' },
        { $set: { status: 'completed', endDate: new Date() } },
      );

      // 4. Marquer TOUTES les anciennes transactions comme "Cash"
      // Cela permet de garder l'historique sans impacter le solde réel
      const transactionsReset = await Transaction.updateMany(
        {},
        { $set: { paymentMethod: 'cash' } },
      );

      // 5. Simulation wallet balances → 0. They were never backed by a real
      // deposit (set directly or via simulation credits): left in place, they
      // became withdrawable real money the day real money was switched on.
      // Each user gets an explicit ledger line; the original balance is archived above.
      const funded = await User.find({ walletBalance: { $gt: 0 } })
        .select('_id walletBalance currency')
        .lean();
      for (const u of funded) {
        await Transaction.collection.updateOne(
          { reference: `SIM-RESET-${u._id}` },
          {
            $setOnInsert: {
              userId: u._id,
              amount: u.walletBalance,
              currency: u.currency || 'XAF',
              type: 'expense',
              category: 'simulation_reset',
              description: 'Remise à zéro du solde de simulation (lancement argent réel)',
              status: 'completed',
              reference: `SIM-RESET-${u._id}`,
              paymentMethod: 'cash', // never counted as a real wallet debit (AML)
              date: new Date(),
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
          { upsert: true },
        );
      }
      const walletsReset = await User.updateMany(
        { walletBalance: { $gt: 0 } },
        { $set: { walletBalance: 0 } },
      );
      logger.info(
        `- Wallets: ${walletsReset.modifiedCount} soldes de simulation remis à zéro (archivés)`,
      );

      // The broadcast is sent by setRealMoneyMode itself (no duplicate here).

      logger.info(`[Migration] REAL MONEY Transition COMPLETED.`);
      logger.info(`- Challenges: ${ChallengesReset.modifiedCount} resets`);
      logger.info(`- Goals: ${goalsReset.modifiedCount} resets`);
      logger.info(`- Tontines: ${tontinesReset.modifiedCount} closures`);
      logger.info(`- Transactions: ${transactionsReset.modifiedCount} marked as cash`);
    } catch (error: any) {
      // Release the lock: every step is idempotent, the next switch retries cleanly.
      await Migration.deleteOne({ migrationId }).catch(() => undefined);
      logger.error(`[Migration] Real Money Migration FAILED: ${error.message}`);
      throw error;
    }
  }

  /**
   * Adds the English version of the default challenges already in the
   * database (they were seeded French-only, so English users saw French).
   * Only fills empty fields: an admin's own translation is never overwritten.
   */
  static async runChallengeTranslationsMigration() {
    const migrationId = 'challenge-default-translations-v1';
    try {
      await Migration.create({ migrationId });
    } catch (err: any) {
      if (err.code === 11000) return;
      throw err;
    }
    try {
      const Challenge = (await import('../models/Challenge')).default;
      const defaults: Array<[string, string, string]> = [
        [
          'Épargne de Secours',
          'Emergency Savings',
          'Save 50,000 XAF in 4 weeks to be ready for the unexpected.',
        ],
        [
          'Défi Tontineur Pro',
          'Pro Tontine Member',
          "Don't miss a single contribution for 3 months.",
        ],
        [
          'Zéro Dépense Inutile',
          'Zero Wasteful Spending',
          'Cut your entertainment spending by 20% this month.',
        ],
      ];
      let n = 0;
      for (const [title, titleEn, descriptionEn] of defaults) {
        const r = await Challenge.updateMany(
          { title, $or: [{ titleEn: { $exists: false } }, { titleEn: '' }] },
          { $set: { titleEn, descriptionEn } },
        );
        n += r.modifiedCount;
      }
      logger.info(`[Migration] ${migrationId}: ${n} défi(s) traduit(s).`);
    } catch (error: any) {
      await Migration.deleteOne({ migrationId }).catch(() => undefined);
      logger.error(
        `[Migration] ${migrationId} FAILED (will retry on next start): ${error.message}`,
      );
    }
  }

  /**
   * Removes duplicate ACTIVE participations to the same challenge (refunded in
   * full), then builds the unique index that now prevents them.
   */
  static async runDedupeActiveChallengesMigration() {
    const migrationId = 'dedupe-active-user-challenges-v1';
    try {
      await Migration.create({ migrationId });
    } catch (err: any) {
      if (err.code === 11000) return;
      throw err;
    }
    try {
      const { dedupeActiveChallenges } = await import('./migrations/dedupeActiveChallenges');
      const report = await dedupeActiveChallenges({ apply: true });
      logger.info(
        `[Migration] ${migrationId}: ${report.length} doublon(s) traité(s), ${report.reduce((s, r) => s + r.refunded, 0)} remboursé(s) au total.`,
      );
      for (const r of report) logger.info(`[Migration] ${migrationId}: ${JSON.stringify(r)}`);
    } catch (error: any) {
      await Migration.deleteOne({ migrationId }).catch(() => undefined);
      logger.error(
        `[Migration] ${migrationId} FAILED (will retry on next start): ${error.message}`,
      );
    }
  }

  /**
   * Moves avatars / receipt images still stored on the container disk (served by
   * the old public express.static) to object storage. See
   * migrations/localUploadsToStorage.ts. Local files are never deleted.
   */
  static async runLocalUploadsMigration() {
    const migrationId = 'local-uploads-to-object-storage-v1';
    try {
      await Migration.create({ migrationId });
    } catch (err: any) {
      if (err.code === 11000) return;
      throw err;
    }
    try {
      const { migrateLocalUploads } = await import('./migrations/localUploadsToStorage');
      const report = await migrateLocalUploads({ apply: true });
      logger.info(`[Migration] ${migrationId}: ${JSON.stringify(report)}`);
    } catch (error: any) {
      await Migration.deleteOne({ migrationId }).catch(() => undefined);
      logger.error(
        `[Migration] ${migrationId} FAILED (will retry on next start): ${error.message}`,
      );
    }
  }

  /**
   * One-time product decision (2026-11): investments are switched OFF on
   * existing databases. Runs once; an admin re-enabling the flag afterwards is
   * respected (the seed no longer overwrites isEnabled).
   */
  static async runDisableInvestmentsMigration() {
    const migrationId = 'disable-investments-by-default-v1';
    try {
      await Migration.create({ migrationId });
    } catch (err: any) {
      if (err.code === 11000) return;
      throw err;
    }
    try {
      const FeatureFlag = (await import('../models/FeatureFlag')).default;
      await FeatureFlag.updateOne({ slug: 'feat_investments' }, { $set: { isEnabled: false } });
      logger.info(`[Migration] ${migrationId}: feat_investments désactivé.`);
    } catch (error: any) {
      await Migration.deleteOne({ migrationId }).catch(() => undefined);
      logger.error(
        `[Migration] ${migrationId} FAILED (will retry on next start): ${error.message}`,
      );
    }
  }

  /**
   * Repairs tontines started before rotation slots were assigned per part
   * (multi-part members, untaken parts, wallet money stuck on winner-less
   * turns). See migrations/tontineRotationMigration.ts. Unlike the lock above,
   * the lock is RELEASED on failure so the repair is retried on next start.
   */
  static async runTontineRotationMigration() {
    const migrationId = 'repair-tontine-rotation-slots-v1';
    try {
      await Migration.create({ migrationId });
    } catch (err: any) {
      if (err.code === 11000) return;
      throw err;
    }
    try {
      const { repairTontineRotations } = await import('./migrations/tontineRotationMigration');
      const repairs = await repairTontineRotations({ apply: true });
      const refunds = repairs.flatMap((r) => r.refunded);
      logger.info(
        `[Migration] ${migrationId}: ${repairs.length} tontine(s) réparée(s), ${refunds.length} remboursement(s) (${refunds.reduce((s, r) => s + r.amount, 0)} au total), ${repairs.filter((r) => r.completed).length} clôturée(s).`,
      );
      for (const r of repairs) logger.info(`[Migration] ${migrationId}: ${JSON.stringify(r)}`);
    } catch (error: any) {
      await Migration.deleteOne({ migrationId }).catch(() => undefined);
      logger.error(
        `[Migration] ${migrationId} FAILED (will retry on next start): ${error.message}`,
      );
    }
  }
}
