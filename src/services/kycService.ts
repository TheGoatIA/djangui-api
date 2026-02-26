import User from '../models/User';
import { AppError } from '../middleware/errorHandler';
import logger from '../utils/logger';
import { AuditService } from './auditService';
import { NotificationService } from './notificationService';

export class KYCService {
    /**
     * Soumet les documents KYC pour un utilisateur
     */
    static async submitDocuments(userId: string, data: {
        documentType: 'cni' | 'passport' | 'driver_license';
        documentNumber: string;
        fullName: string;
        documentImageUrl: string;
        selfieImageUrl: string;
    }) {
        const user = await User.findById(userId);
        if (!user) throw new AppError('Utilisateur non trouvé', 404);

        user.kycLevel = 'pending';
        user.kycData = {
            ...data,
            verifiedAt: undefined,
            rejectionReason: undefined
        };

        await user.save();

        await AuditService.record({
            userId: userId as any,
            action: 'KYC_SUBMITTED',
            resource: 'USER',
            resourceId: userId,
            status: 'success',
            metadata: { documentType: data.documentType }
        });

        // Déclencher l'analyse IA en arrière-plan
        this.processAIValidation(userId).catch(err =>
            logger.error(`KYC AI Background Error: ${err.message}`)
        );

        return user;
    }

    /**
     * Simule la validation par IA (OCR + Face Match)
     * À remplacer par une vraie intégration (ex: OpenAI Vision, AWS Rekognition)
     */
    private static async processAIValidation(userId: string) {
        logger.info(`Starting AI KYC Validation for user ${userId}`);

        // Simulation d'un délai d'analyse
        await new Promise(resolve => setTimeout(resolve, 5000));

        const user = await User.findById(userId);
        if (!user || user.kycLevel !== 'pending') return;

        try {
            // LOGIQUE IA THÉORIQUE :
            // 1. OCR sur documentImageUrl -> extraire le nom
            // 2. FaceMatch(documentImageUrl, selfieImageUrl) -> score > 0.8 ?
            // 3. Liveness detection sur selfieImageUrl

            const isSuccess = true; // Simulation de succès pour la démo

            if (isSuccess) {
                user.kycLevel = 'verified';
                if (user.kycData) user.kycData.verifiedAt = new Date();

                await user.save();

                await AuditService.record({
                    userId: userId as any,
                    action: 'KYC_VERIFIED',
                    resource: 'USER',
                    resourceId: userId,
                    status: 'success'
                });

                await NotificationService.sendToUser(userId, {
                    title: 'KYC Approuvé !',
                    body: 'Votre identité a été vérifiée. Vous pouvez maintenant effectuer des retraits.',
                    category: 'important'
                });
            } else {
                user.kycLevel = 'none';
                if (user.kycData) user.kycData.rejectionReason = "La photo du document est illisible ou ne correspond pas au selfie.";
                await user.save();

                // Notification d'échec
            }
        } catch (error: any) {
            logger.error(`KYC AI Processing Error: ${error.message}`);
        }
    }

    /**
     * Validation manuelle par un admin
     */
    static async adminVerify(userId: string, approve: boolean, reason?: string) {
        const user = await User.findById(userId);
        if (!user) throw new AppError('Utilisateur non trouvé', 404);

        if (approve) {
            user.kycLevel = 'verified';
            if (user.kycData) user.kycData.verifiedAt = new Date();
        } else {
            user.kycLevel = 'none';
            if (user.kycData) user.kycData.rejectionReason = reason || "Refusé par l'administrateur";
        }

        await user.save();
        return user;
    }
}
