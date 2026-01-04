import { Request, Response, NextFunction } from 'express';
import { OCRService } from '../services/ai/ocrService';
import { AuthRequest } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import path from 'path';

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

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err) {
      next(err);
    }
  }
}
