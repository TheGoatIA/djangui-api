import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { AppError } from '../middleware/errorHandler';

const uploadDir = 'uploads/receipts';
const avatarDir = 'uploads/avatars';
const voiceDir = 'uploads/voice-notes';

// Ensure directories exist
[uploadDir, avatarDir, voiceDir].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.fieldname === 'avatar') {
      cb(null, avatarDir);
    } else {
      cb(null, uploadDir);
    }
  },
  filename: (req, file, cb) => {
    cb(null, `${uuidv4()}${path.extname(file.originalname)}`);
  },
});

const fileFilter = (req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/pdf'];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new AppError(
        `Invalid file type (${file.mimetype}). Only JPEG, PNG, WEBP and PDF are allowed.`,
        400,
      ) as any,
      false,
    );
  }
};

export const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
  },
});

const voiceStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, voiceDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${uuidv4()}${path.extname(file.originalname) || '.m4a'}`);
  },
});

const voiceFileFilter = (req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const allowedTypes = [
    'audio/aac',
    'audio/mp4',
    'audio/m4a',
    'audio/x-m4a',
    'audio/mpeg',
    'audio/ogg',
  ];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new AppError(
        `Invalid audio type (${file.mimetype}). Only AAC/M4A, MP3 and OGG are allowed.`,
        400,
      ) as any,
      false,
    );
  }
};

// Voice notes must stay short (chat attachments, not full recordings) — 5MB caps an
// AAC-LC clip at roughly 2 minutes, matching the client-side auto-stop guard.
export const uploadVoice = multer({
  storage: voiceStorage,
  fileFilter: voiceFileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

/**
 * Middleware validating actual magic bytes (file signature) to prevent polyglot / MIME spoofing (F15)
 */
export const validateFileMagicBytes = (req: any, res: any, next: any) => {
  const file = req.file;
  if (!file) return next();

  try {
    const buffer = Buffer.alloc(12);
    const fd = fs.openSync(file.path, 'r');
    fs.readSync(fd, buffer, 0, 12, 0);
    fs.closeSync(fd);

    const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    const isPng = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
    const isPdf = buffer.toString('ascii', 0, 4) === '%PDF';
    const isWebp = buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';

    if (!isJpeg && !isPng && !isPdf && !isWebp) {
      try { fs.unlinkSync(file.path); } catch (_) {}
      return next(new AppError('Type de fichier invalide (signature binaire non reconnue)', 400));
    }
    next();
  } catch (err: any) {
    try { fs.unlinkSync(file.path); } catch (_) {}
    return next(new AppError('Erreur de validation du fichier téléversé', 400));
  }
};

/**
 * Same principle as validateFileMagicBytes, for the voice-note upload (F15) — MP3 has
 * no fixed magic byte beyond loose frame-sync bits, which is fine here since this only
 * gates which files get accepted (the size cap and dedicated, non-executable storage
 * path are the actual security boundary, not this check).
 */
export const validateVoiceMagicBytes = (req: any, res: any, next: any) => {
  const file = req.file;
  if (!file) return next();

  try {
    const buffer = Buffer.alloc(12);
    const fd = fs.openSync(file.path, 'r');
    fs.readSync(fd, buffer, 0, 12, 0);
    fs.closeSync(fd);

    const isM4a = buffer.toString('ascii', 4, 8) === 'ftyp';
    const isAdts = buffer[0] === 0xff && (buffer[1] === 0xf1 || buffer[1] === 0xf9);
    const isMp3 =
      (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) || buffer.toString('ascii', 0, 3) === 'ID3';
    const isOgg = buffer.toString('ascii', 0, 4) === 'OggS';

    if (!isM4a && !isAdts && !isMp3 && !isOgg) {
      try { fs.unlinkSync(file.path); } catch (_) {}
      return next(new AppError('Type de fichier audio invalide (signature binaire non reconnue)', 400));
    }
    next();
  } catch (err: any) {
    try { fs.unlinkSync(file.path); } catch (_) {}
    return next(new AppError('Erreur de validation du fichier audio', 400));
  }
};
