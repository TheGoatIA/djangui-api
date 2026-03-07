import { Response, NextFunction } from 'express';
import { AnneVoiceService } from '../services/ai/anneVoiceService';
import { AuthRequest } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { StorageService } from '../services/storageService';
import fs from 'fs';

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

      const result = await AnneVoiceService.processVoiceTransaction(
        filePath,
        mimeType,
        req.user._id,
      );

      // Upload vers MinIO (pour historique/audit)
      const minioUrl = await StorageService.uploadFile(
        filePath,
        'kauri-uploads',
        `voice/${req.file.filename}`,
      );

      // Nettoyage local
      try {
        fs.unlinkSync(filePath);
      } catch (e) {}

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
