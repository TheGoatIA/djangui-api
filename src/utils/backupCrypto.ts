import crypto from 'node:crypto';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';

/**
 * Streaming AES-256-GCM for database/file backups sent to third-party storage.
 * A full dump holds password hashes, KYC data and every user's financial
 * history: it must never leave the server readable.
 *
 * File format: "KBK1" (4) | IV (12) | ciphertext | auth tag (16).
 * Key: SHA-256 of BACKUP_ENCRYPTION_KEY (≥ 32 chars). Losing the key = losing
 * the backups — keep it OUTSIDE the server (password manager).
 */
const MAGIC = Buffer.from('KBK1');

const keyFrom = (secret: string) => {
  if (!secret || secret.length < 32) throw new Error('BACKUP_ENCRYPTION_KEY must be ≥ 32 chars');
  return crypto.createHash('sha256').update(secret).digest();
};

/** Longueur du tag d'authentification AES-GCM (128 bits), écrite en fin de fichier. */
const TAG_LENGTH = 16;

export async function encryptFile(src: string, dst: string, secret: string): Promise<void> {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFrom(secret), iv, {
    authTagLength: TAG_LENGTH,
  });
  fs.writeFileSync(dst, Buffer.concat([MAGIC, iv]));
  await pipeline(fs.createReadStream(src), cipher, fs.createWriteStream(dst, { flags: 'a' }));
  fs.appendFileSync(dst, cipher.getAuthTag());
}

export async function decryptFile(src: string, dst: string, secret: string): Promise<void> {
  const { size } = fs.statSync(src);
  if (size < MAGIC.length + 12 + 16) throw new Error('Encrypted backup too small');
  const fd = fs.openSync(src, 'r');
  const head = Buffer.alloc(16);
  const tag = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  fs.readSync(fd, tag, 0, 16, size - 16);
  fs.closeSync(fd);
  if (!head.subarray(0, 4).equals(MAGIC)) throw new Error('Not a Kauri encrypted backup');
  // Longueur de tag imposée : sans elle, un tag tronqué (falsifié) pourrait être accepté.
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFrom(secret), head.subarray(4, 16), {
    authTagLength: TAG_LENGTH,
  });
  decipher.setAuthTag(tag);
  // Tampered/truncated file or wrong key → 'Unsupported state or unable to authenticate data'
  await pipeline(
    fs.createReadStream(src, { start: 16, end: size - 17 }),
    decipher,
    fs.createWriteStream(dst),
  );
}
