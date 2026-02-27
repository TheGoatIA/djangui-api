import { Response, NextFunction } from 'express';
import { AuthRequest } from '../middleware/auth';
import { OCRService } from '../services/ai/ocrService';
import { StorageService } from '../services/storageService';
import User from '../models/User';
import logger from '../utils/logger';
import path from 'path';
import fs from 'fs';

export class UploadController {
  /**
   * Upload and analyze a receipt
   */
  static async scanReceipt(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, message: 'No file uploaded' });
      }

      const ocrResult = await OCRService.scanReceipt(req.file.path);

      // Upload vers MinIO
      const minioUrl = await StorageService.uploadFile(
        req.file.path,
        'kauri-uploads',
        `receipts/${req.file.filename}`
      );

      // Nettoyage local
      try { fs.unlinkSync(req.file.path); } catch (e) { }

      res.status(200).json({
        success: true,
        data: {
          ...ocrResult,
          fileName: req.file.filename,
          filePath: minioUrl,
        },
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * Upload user avatar
   */
  static async uploadAvatar(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, message: 'No file uploaded' });
      }

      // Upload vers MinIO
      const avatarUrl = await StorageService.uploadFile(
        req.file.path,
        'kauri-uploads',
        `avatars/${req.file.filename}`
      );

      // Nettoyage local
      try { fs.unlinkSync(req.file.path); } catch (e) { }

      await User.findByIdAndUpdate(req.user._id, { avatar: avatarUrl });

      res.status(200).json({
        success: true,
        data: {
          avatarUrl,
        },
      });
    } catch (err) {
      next(err);
    }
  }
}
