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
          logger.info(`[Migration] Migration ${migrationId} déjà verrouillée ou effectuée par un autre processus.`);
          return; // Sortie silencieuse pour les autres workers PM2
        }
        throw err;
      }

      logger.info(`[Migration] Lancement de la transition REAL MONEY : ${migrationId}...`);

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
      const tontinesReset = await Tontine.updateMany(
        { status: 'active' },
        { $set: { status: 'cancelled' } },
      );

      // 4. Marquer TOUTES les anciennes transactions comme "Cash"
      // Cela permet de garder l'historique sans impacter le solde réel
      const transactionsReset = await Transaction.updateMany(
        {},
        { $set: { paymentMethod: 'cash' } },
      );

      // 5. Notification Globale (Logique simplifiée pour cette migration)
      // On pourrait envoyer une notification via Topic "all" si configuré
      await NotificationService.sendToTopic('all_users', {
        title: "Bienvenue dans l'ère du Réel ! 🚀",
        body: "Kauri passe à l'argent réel. Vos anciens challenges et objectifs en cours ont été réinitialisés pour ce nouveau départ.",
        category: 'important',
      });

      logger.info(`[Migration] REAL MONEY Transition COMPLETED.`);
      logger.info(`- Challenges: ${ChallengesReset.modifiedCount} resets`);
      logger.info(`- Goals: ${goalsReset.modifiedCount} resets`);
      logger.info(`- Tontines: ${tontinesReset.modifiedCount} closures`);
      logger.info(`- Transactions: ${transactionsReset.modifiedCount} marked as cash`);
    } catch (error: any) {
      logger.error(`[Migration] Real Money Migration FAILED: ${error.message}`);
    }
  }
}
