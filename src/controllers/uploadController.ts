import { Response, NextFunction } from 'express';
import { AuthRequest } from '../middleware/auth';
import { OCRService } from '../services/ai/ocrService';
import { AvatarGenerationService } from '../services/ai/avatarGenerationService';
import { StorageService } from '../services/storageService';
import User from '../models/User';
import fs from 'node:fs';
import logger from '../utils/logger';

export class UploadController {
  /**
   * Upload and analyze a receipt
   */
  static async scanReceipt(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, message: 'No file uploaded' });
      }

      try {
        const ocrResult = await OCRService.scanReceipt(req.file.path);

        // Upload vers MinIO
        const minioUrl = await StorageService.uploadFile(
          req.file.path,
          'kauri-uploads',
          `receipts/${req.file.filename}`,
        );

        res.status(200).json({
          success: true,
          data: {
            ...ocrResult,
            fileName: req.file.filename,
            filePath: minioUrl,
          },
        });
      } finally {
        // Nettoyage local — dans un `finally` pour ne pas laisser le fichier
        // temporaire sur disque si le scan OCR ou l'upload MinIO échoue.
        try {
          fs.unlinkSync(req.file.path);
        } catch (e: any) {
          logger.warn(`Failed to cleanup physical file at ${req.file.path}`, { error: e.message });
        }
      }
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

      // Upload vers MinIO — nettoyage local dans un `finally` : un échec du stockage
      // ne doit pas laisser le fichier temporaire sur le disque.
      let avatarUrl: string;
      try {
        avatarUrl = await StorageService.uploadFile(
          req.file.path,
          'kauri-uploads',
          `avatars/${req.file.filename}`,
        );
      } finally {
        try {
          fs.unlinkSync(req.file.path);
        } catch (e: any) {
          logger.warn(`Failed to cleanup physical file at ${req.file.path}`, {
            error: e.message,
          });
        }
      }

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

  /**
   * Generate a profile avatar preview via AI (Premium). Does NOT change the
   * user's actual avatar yet — the client shows this as a preview the user
   * can regenerate or discard before committing via `applyGeneratedAvatar`.
   */
  static async generateAvatar(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { style, refinement } = req.body;
      const avatarUrl = await AvatarGenerationService.generate(req.user._id, style, refinement);
      res.status(200).json({ success: true, data: { avatarUrl } });
    } catch (err) {
      next(err);
    }
  }

  /**
   * Commits a previously generated AI avatar preview as the user's real avatar.
   */
  static async applyGeneratedAvatar(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { avatarUrl } = req.body;
      const applied = await AvatarGenerationService.applyAvatar(req.user._id, avatarUrl);
      res.status(200).json({ success: true, data: { avatarUrl: applied } });
    } catch (err) {
      next(err);
    }
  }

  /**
   * Upload a generic document (KYC identity document / selfie). These images are
   * sensitive PII, so they're stored privately — never fetchable by an anonymous,
   * unsigned request. Only KYCService (internally, via the S3 SDK) and the admin
   * KYC review endpoints (via short-TTL signed URLs) can read them back.
   */
  static async uploadDocument(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, message: 'No file uploaded' });
      }

      // Upload vers MinIO (privé) — nettoyage local garanti, même en cas d'échec
      let documentUrl: string;
      try {
        documentUrl = await StorageService.uploadFile(
          req.file.path,
          'kauri-uploads',
          `documents/${req.file.filename}`,
          'private',
        );
      } finally {
        try {
          fs.unlinkSync(req.file.path);
        } catch (e: any) {
          logger.warn(`Failed to cleanup physical file at ${req.file.path}`, {
            error: e.message,
          });
        }
      }

      res.status(200).json({
        success: true,
        data: {
          documentUrl,
        },
      });
    } catch (err) {
      next(err);
    }
  }
}
