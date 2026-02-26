import User from '../models/User';
import Migration from '../models/Migration';
import logger from '../utils/logger';

/**
 * Service gérant les migrations de données "one-time" lors des déploiements.
 */
export class MigrationService {
    /**
     * Migre les utilisateurs existants vers le nouveau système Fintech.
     * Initialise le solde du portefeuille, le niveau KYC et la devise par défaut.
     */
    static async runInitialFintechMigration() {
        const migrationId = 'migrate-users-fintech-v1';

        try {
            // Vérifier si la migration a déjà été exécutée
            const alreadyRun = await Migration.findOne({ migrationId });
            if (alreadyRun) {
                logger.info(`[Migration] ${migrationId} déjà effectuée. Passage.`);
                return;
            }

            logger.info(`[Migration] Lancement de la migration : ${migrationId}...`);

            // Initialisation des champs pour les utilisateurs qui ne les ont pas encore
            // On utilise updateMany pour l'efficacité globale
            const result = await User.updateMany(
                {
                    $or: [
                        { walletBalance: { $exists: false } },
                        { kycLevel: { $exists: false } },
                        { currency: { $exists: false } }
                    ]
                },
                {
                    $set: {
                        walletBalance: 0,
                        kycLevel: 'none',
                        kycData: {},
                        currency: 'XAF'
                    }
                }
            );

            // Enregistrer le succès de la migration
            await Migration.create({ migrationId });

            logger.info(`[Migration] ${migrationId} terminée avec succès. ${result.modifiedCount} utilisateurs mis à jour.`);
        } catch (error: any) {
            logger.error(`[Migration] ${migrationId} a échoué : ${error.message}`);
            // On ne bloque pas le démarrage du serveur en cas d'erreur de migration, 
            // mais l'erreur est enregistrée pour intervention humaine.
        }
    }
}
