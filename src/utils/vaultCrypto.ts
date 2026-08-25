import crypto from 'crypto';
import logger from './logger';

export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  authTag: string;
}

export class VaultCrypto {
  private static readonly ALGORITHM = 'aes-256-gcm';
  private static readonly IV_LENGTH = 12; // 96-bit IV recommended for GCM

  /**
   * Derive a 32-byte key using a master secret and a salt ID
   */
  private static deriveKey(saltId: string): Buffer {
    const masterSecret = process.env.VAULT_ENCRYPTION_KEY;
    if (!masterSecret || masterSecret.length < 32) {
      // In test mode, fallback to standard test key if not set
      if (process.env.NODE_ENV === 'test') {
        return crypto.scryptSync('test_32_bytes_vault_secret_key_kauri_2026_test', `salt_${saltId}`, 32);
      }
      throw new Error('🚨 [VAULT] VAULT_ENCRYPTION_KEY manquant ou trop court (min 32 caractères requis)');
    }
    return crypto.scryptSync(masterSecret, `salt_${saltId}`, 32);
  }

  /**
   * Encrypt plaintext string using AES-256-GCM
   */
  static encrypt(plaintext: string, saltId: string): EncryptedPayload {
    if (!plaintext) {
      return { ciphertext: '', iv: '', authTag: '' };
    }

    try {
      const key = this.deriveKey(saltId);
      const iv = crypto.randomBytes(this.IV_LENGTH);
      const cipher = crypto.createCipheriv(this.ALGORITHM, key, iv);

      let ciphertext = cipher.update(plaintext, 'utf8', 'hex');
      ciphertext += cipher.final('hex');

      const authTag = cipher.getAuthTag().toString('hex');

      return {
        ciphertext,
        iv: iv.toString('hex'),
        authTag,
      };
    } catch (err: any) {
      logger.error(`Encryption error: ${err.message}`);
      throw err;
    }
  }

  /**
   * Decrypt AES-256-GCM ciphertext
   */
  static decrypt(ciphertext: string, iv: string, authTag: string, saltId: string): string {
    if (!ciphertext || !iv || !authTag) {
      return '';
    }

    try {
      const key = this.deriveKey(saltId);
      const decipher = crypto.createDecipheriv(
        this.ALGORITHM,
        key,
        Buffer.from(iv, 'hex'),
      );
      decipher.setAuthTag(Buffer.from(authTag, 'hex'));

      let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    } catch (err: any) {
      logger.error(`Decryption error: ${err.message}`);
      return '';
    }
  }

  /**
   * Encrypt simple string as 'iv:authTag:ciphertext' for MongoDB fields
   */
  static encryptSimple(plaintext: string, saltId: string): string {
    if (!plaintext) return '';
    const payload = this.encrypt(plaintext, saltId);
    if (!payload.ciphertext) return '';
    return `${payload.iv}:${payload.authTag}:${payload.ciphertext}`;
  }

  /**
   * Decrypt simple string 'iv:authTag:ciphertext' (or return plaintext if unencrypted)
   */
  static decryptSimple(encryptedStr: string, saltId: string): string {
    if (!encryptedStr) return '';
    const parts = encryptedStr.split(':');
    if (parts.length !== 3) {
      // Return plaintext if legacy / unencrypted
      return encryptedStr;
    }
    const [iv, authTag, ciphertext] = parts;
    return this.decrypt(ciphertext, iv, authTag, saltId);
  }
}
