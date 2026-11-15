import { Response, NextFunction } from 'express';
import { AnneVoiceService } from '../services/ai/anneVoiceService';
import { AuthRequest } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { StorageService } from '../services/storageService';

export class VoiceController {
  /**
   * Process a voice transaction from an uploaded audio file
   */
  static async processVoiceTransaction(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      if (!req.file) {
        throw new AppError('No audio file uploaded', 400);
      }

      const filePath = req.file.path;
      const mimeType = req.file.mimetype;

      // Upload vers MinIO (pour historique/audit) AVANT l'analyse IA :
      // AnneVoiceService.processVoiceTransaction supprime toujours le fichier
      // temporaire lui-même (succès ou échec, voir son `finally`), donc l'appeler
      // en premier laissait ce upload échouer systématiquement (ENOENT) sur un
      // fichier déjà supprimé — chaque requête vocale réussie renvoyait quand
      // même une erreur 500 à ce stade.
      const minioUrl = await StorageService.uploadFile(
        filePath,
        'kauri-uploads',
        `voice/${req.file.filename}`,
      );

      const result = await AnneVoiceService.processVoiceTransaction(
        filePath,
        mimeType,
        req.user._id,
      );

      res.status(200).json({
        success: true,
        data: {
          ...result,
          audioUrl: minioUrl,
        },
      });
    } catch (err) {
      next(err);
    }
  }
}
