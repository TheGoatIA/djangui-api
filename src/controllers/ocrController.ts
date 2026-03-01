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
      const result = await OCRService.scanReceipt(filePath);

      // Upload vers MinIO
      const minioUrl = await StorageService.uploadFile(
        filePath,
        'kauri-uploads',
        `receipts/${req.file.filename}`,
      );

      // Nettoyage local
      try {
        fs.unlinkSync(filePath);
      } catch (e) {}

      res.status(200).json({
        success: true,
        data: {
          ...result,
          imageUrl: minioUrl,
        },
      });
    } catch (err) {
      next(err);
    }
  }
}
