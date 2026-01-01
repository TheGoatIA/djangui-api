import { Response, NextFunction } from 'express';
import { AuthRequest } from '../middleware/auth';
import { OCRService } from '../services/ai/ocrService';
import User from '../models/User';
import logger from '../utils/logger';
import path from 'path';

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

            res.status(200).json({
                success: true,
                data: {
                    ...ocrResult,
                    fileName: req.file.filename,
                    filePath: req.file.path,
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

            // In a real app, you would probably upload to S3/Cloudinary and get a URL
            // For now we store locally and map to a URL
            const avatarUrl = `/uploads/avatars/${req.file.filename}`;

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
