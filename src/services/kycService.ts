import User from '../models/User';
import { AppError } from '../middleware/errorHandler';
import logger from '../utils/logger';
import { AuditService } from './auditService';
import { NotificationService } from './notificationService';
import { SlackService } from './slackService';
import { GeminiService } from './ai/geminiService';
import { PromptBuilder } from './ai/promptBuilder';
import { StorageService } from './storageService';

export class KYCService {
  /**
   * Soumet les documents KYC pour un utilisateur
   */
  static async submitDocuments(
    userId: string,
    data: {
      documentType: 'cni' | 'passport' | 'driver_license';
      documentNumber: string;
      fullName: string;
      documentImageUrl: string;
      selfieImageUrl: string;
    },
  ) {
    const user = await User.findById(userId);
    if (!user) throw new AppError('Utilisateur non trouvé', 404);

    user.kycLevel = 'pending';
    user.kycData = {
      ...data,
      verifiedAt: undefined,
      rejectionReason: undefined,
      aiAnalysisStatus: 'pending',
    };

    await user.save();

    await AuditService.record({
      userId: userId as any,
      action: 'KYC_SUBMITTED',
      resource: 'USER',
      resourceId: userId,
      status: 'success',
      metadata: { documentType: data.documentType },
    });

    // 1. Notification Utilisateur : "En cours d'étude"
    await NotificationService.sendToUser(userId, {
      title: '',
      body: '',
      translationKey: 'KYC_SUBMITTED',
      category: 'important',
    }).catch((err) => logger.error(`KYC Submission User Notification Error: ${err.message}`));

    // 2. Notification Slack Admin : "Nouvelle soumission"
    await SlackService.sendNotification(
      `📑 *Nouvelle soumission KYC*\n*Utilisateur*: ${user.firstName} ${user.lastName} (${user.email})\n*Document*: ${data.documentType.toUpperCase()}\n*Action*: Analyse IA lancée...`,
      false,
    );

    // Déclencher l'analyse IA en arrière-plan
    this.processAIValidation(userId).catch((err) =>
      logger.error(`KYC AI Background Error: ${err.message}`),
    );

    return user;
  }

  /**
   * Analyse réelle par IA (Gemini Vision)
   */
  private static async processAIValidation(userId: string) {
    logger.info(`Starting Real AI KYC Validation for user ${userId}`);

    const user = await User.findById(userId);
    if (!user || user.kycLevel !== 'pending' || !user.kycData) return;

    try {
      // Les documents KYC sont stockés en privé (voir StorageService/uploadController) :
      // on les récupère via le SDK S3 authentifié, pas par un simple GET HTTP anonyme
      // qui serait rejeté (403) sur un objet privé.
      const [docBuffer, selfieBuffer] = await Promise.all([
        this.downloadKycImage(user.kycData.documentImageUrl!),
        this.downloadKycImage(user.kycData.selfieImageUrl!),
      ]);

      const prompt = PromptBuilder.buildKycAnalysisPrompt(user.kycData);

      // Format multi-modal pour Gemini
      const aiResult = await GeminiService.generateJSON(
        [
          { text: prompt },
          {
            inlineData: {
              data: docBuffer.toString('base64'),
              mimeType: 'image/jpeg',
            },
          },
          {
            inlineData: {
              data: selfieBuffer.toString('base64'),
              mimeType: 'image/jpeg',
            },
          },
        ],
        'kyc-analysis',
      );

      // Mise à jour des résultats IA (Sans valider le KYC automatiquement)
      user.kycData.aiReport = aiResult.analysisReport;
      user.kycData.aiConfidence = aiResult.confidenceScore;
      user.kycData.aiAnalysisStatus = 'completed';

      await user.save();

      // Notification Slack pour l'admin : "Analyse terminée"
      const statusEmoji = aiResult.isMatch && aiResult.confidenceScore > 80 ? '✅' : '⚠️';
      await SlackService.sendNotification(
        `🤖 *Analyse IA KYC Terminée* ${statusEmoji}\n*Utilisateur*: ${user.firstName} ${user.lastName}\n*Score*: ${aiResult.confidenceScore}%\n*Rapport*: ${aiResult.analysisReport.substring(0, 500)}...\n*Lien Admin*: ${process.env.ADMIN_URL}/users/${user._id}`,
        false,
      );
    } catch (error: any) {
      const errorMsg = error.response
        ? `Axios Error: ${error.response.status} ${error.response.statusText}`
        : error.message;
      logger.error(`KYC AI Processing Error: ${errorMsg}`, { stack: error.stack });

      if (user.kycData) {
        user.kycData.aiAnalysisStatus = 'failed';
        await user.save();
      }
      await SlackService.sendNotification(
        `🚨 *Erreur Analyse IA KYC*\n*Utilisateur*: ${user.firstName}\n*Erreur*: ${errorMsg}`,
        true,
      );
    }
  }

  /**
   * Télécharge le contenu d'une image KYC stockée (privée) via le SDK S3 authentifié
   * — un simple GET HTTP anonyme serait rejeté (403) sur un objet privé.
   */
  private static async downloadKycImage(storedUrl: string): Promise<Buffer> {
    const parsed = StorageService.parseStoredUrl(storedUrl);
    if (!parsed) throw new AppError('Référence de document KYC invalide.', 500);
    return StorageService.downloadBuffer(parsed.bucket, parsed.key);
  }

  /**
   * Génère des URLs signées à courte durée de vie pour afficher les documents KYC
   * d'un utilisateur (revue admin, ou l'utilisateur consultant son propre dossier).
   * Ne JAMAIS renvoyer `kycData.documentImageUrl`/`selfieImageUrl` bruts : ce sont
   * des objets privés, l'URL stockée n'est plus fetchable telle quelle.
   */
  static async getSignedDocumentUrls(userId: string, expiresInSeconds = 300) {
    const user = await User.findById(userId).select('kycData');
    if (!user?.kycData) return { documentUrl: null, selfieUrl: null };

    const sign = async (storedUrl?: string) => {
      if (!storedUrl) return null;
      const parsed = StorageService.parseStoredUrl(storedUrl);
      if (!parsed) return null;
      return StorageService.getSignedUrl(parsed.bucket, parsed.key, expiresInSeconds);
    };

    const [documentUrl, selfieUrl] = await Promise.all([
      sign(user.kycData.documentImageUrl),
      sign(user.kycData.selfieImageUrl),
    ]);

    return { documentUrl, selfieUrl };
  }

  /**
   * Validation manuelle par un admin (Point de décision final)
   */
  static async adminVerify(userId: string, status: 'verified' | 'rejected', reason?: string) {
    const user = await User.findById(userId);
    if (!user) throw new AppError('Utilisateur non trouvé', 404);

    user.kycLevel = status;
    if (status === 'verified') {
      if (user.kycData) user.kycData.verifiedAt = new Date();

      await NotificationService.sendToUser(userId, {
        title: '',
        body: '',
        translationKey: 'KYC_APPROVED',
        category: 'important',
      });
    } else {
      if (user.kycData)
        user.kycData.rejectionReason = reason || 'Documents non valides après examen.';

      // On pourrait ajouter une clé KYC_REJECTED
      await NotificationService.sendToUser(userId, {
        title: 'Vérification Rejetée',
        body: `Votre vérification KYC a été refusée. Raison : ${reason || 'Documents non conformes.'}`,
        category: 'important',
      });
    }

    await user.save();

    await AuditService.record({
      userId: userId as any,
      action: status === 'verified' ? 'KYC_VERIFIED' : 'KYC_REJECTED',
      resource: 'USER',
      resourceId: userId,
      status: 'success',
      metadata: { reason },
    });

    return user;
  }
}
