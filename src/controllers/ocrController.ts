import { Request, Response, NextFunction } from 'express';
import { OCRService } from '../services/ai/ocrService';
import { AuthRequest } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { StorageService } from '../services/storageService';
import path from 'path';
import fs from 'fs';

export class OCRController {
  /**
   * Scan a receipt from an uploaded file
   */
  static async scanReceipt(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      if (!req.file) {
        throw new AppError('Aucun fichier téléchargé', 400);
      }

      const filePath = req.file.path;
      try {
        const result = await OCRService.scanReceipt(filePath);

        // Upload vers MinIO
        const minioUrl = await StorageService.uploadFile(
          filePath,
          'kauri-uploads',
          `receipts/${req.file.filename}`,
        );

        res.status(200).json({
          success: true,
          data: {
            ...result,
            imageUrl: minioUrl,
          },
        });
      } finally {
        // Nettoyage local — dans un `finally` pour ne pas laisser le fichier
        // temporaire sur disque si le scan OCR ou l'upload MinIO échoue.
        try {
          fs.unlinkSync(filePath);
        } catch (e) {}
      }
    } catch (err) {
      next(err);
    }
  }
}
