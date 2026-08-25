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
      documentType: string;
      documentNumber: string;
      fullName: string;
      documentExpiryDate?: Date | string;
      documentImageUrl: string;
      documentBackImageUrl?: string;
      selfieImageUrl: string;
    },
  ) {
    const user = await User.findById(userId);
    if (!user) throw new AppError('Utilisateur non trouvé', 404);

    // Bloquer la re-soumission si le KYC est déjà validé
    if (user.kycLevel === 'verified') {
      throw new AppError('Votre identité est déjà vérifiée. Aucune nouvelle soumission n\'est nécessaire.', 400);
    }

    // Whitelist des champs autorisés pour éviter l'injection de champs sensibles
    const allowedFields: (keyof typeof data)[] = [
      'documentType',
      'documentNumber',
      'fullName',
      'documentExpiryDate',
      'documentImageUrl',
      'documentBackImageUrl',
      'selfieImageUrl',
    ];
    const filteredData = allowedFields.reduce(
      (acc, key) => {
        if (data[key] !== undefined) acc[key] = data[key] as any;
        return acc;
      },
      {} as typeof data,
    );

    user.kycLevel = 'pending';
    user.kycData = {
      ...filteredData,
      documentExpiryDate: data.documentExpiryDate ? new Date(data.documentExpiryDate) : undefined,
      verifiedAt: undefined,
      rejectionReason: undefined,
      aiAnalysisStatus: 'pending',
    };

    await user.save();

    await AuditService.recordSync({
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
      const [docBuffer, selfieBuffer] = await Promise.all([
        this.downloadKycImage(user.kycData.documentImageUrl!),
        this.downloadKycImage(user.kycData.selfieImageUrl!),
      ]);

      const prompt = PromptBuilder.buildKycAnalysisPrompt(user.kycData);
      const docMime = this.detectMimeType(docBuffer, user.kycData.documentImageUrl);
      const selfieMime = this.detectMimeType(selfieBuffer, user.kycData.selfieImageUrl);

      // Format multi-modal pour Gemini
      const aiResult = await GeminiService.generateJSON(
        [
          { text: prompt },
          {
            inlineData: {
              data: docBuffer.toString('base64'),
              mimeType: docMime,
            },
          },
          {
            inlineData: {
              data: selfieBuffer.toString('base64'),
              mimeType: selfieMime,
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
   */
  private static async downloadKycImage(storedUrl: string): Promise<Buffer> {
    const parsed = StorageService.parseStoredUrl(storedUrl);
    if (!parsed) throw new AppError('Référence de document KYC invalide.', 500);
    return StorageService.downloadBuffer(parsed.bucket, parsed.key);
  }

  /**
   * Génère des URLs signées à courte durée de vie pour afficher les documents KYC
   */
  static async getSignedDocumentUrls(userId: string, expiresInSeconds = 300) {
    const user = await User.findById(userId).select('kycData');
    if (!user?.kycData) return { documentUrl: null, documentBackUrl: null, selfieUrl: null };

    const sign = async (storedUrl?: string) => {
      if (!storedUrl) return null;
      const parsed = StorageService.parseStoredUrl(storedUrl);
      if (!parsed) return null;
      return StorageService.getSignedUrl(parsed.bucket, parsed.key, expiresInSeconds);
    };

    const [documentUrl, documentBackUrl, selfieUrl] = await Promise.all([
      sign(user.kycData.documentImageUrl),
      sign(user.kycData.documentBackImageUrl),
      sign(user.kycData.selfieImageUrl),
    ]);

    return { documentUrl, documentBackUrl, selfieUrl };
  }

  /**
   * Validation manuelle par un admin (Point de décision final)
   */
  static async adminVerify(userId: string, status: 'verified' | 'rejected' | 'expired' | 'update_required', reason?: string) {
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

      await NotificationService.sendToUser(userId, {
        title: 'Vérification Rejetée',
        body: `Votre vérification KYC a été refusée. Raison : ${reason || 'Documents non conformes.'}`,
        category: 'important',
      });
    }

    await user.save();

    await AuditService.recordSync({
      userId: userId as any,
      action: status === 'verified' ? 'KYC_VERIFIED' : 'KYC_REJECTED',
      resource: 'USER',
      resourceId: userId,
      status: 'success',
      metadata: { reason },
    });

    return user;
  }

  /**
   * Détecte le type MIME réel d'un buffer à partir de ses magic bytes
   */
  private static detectMimeType(buffer: Buffer, url?: string): string {
    if (buffer && buffer.length >= 4) {
      if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
        return 'image/png';
      }
      if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return 'image/jpeg';
      }
      if (
        buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
        buffer.length >= 12 && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
      ) {
        return 'image/webp';
      }
      if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
        return 'application/pdf';
      }
    }
    if (url) {
      const lower = url.toLowerCase();
      if (lower.endsWith('.png')) return 'image/png';
      if (lower.endsWith('.webp')) return 'image/webp';
      if (lower.endsWith('.pdf')) return 'application/pdf';
    }
    return 'image/jpeg';
  }
}
