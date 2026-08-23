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
   * Derive a 32-byte key using a master secret and the reseller's specific ID salt
   */
  private static deriveKey(resellerId: string): Buffer {
    const masterSecret =
      process.env.VAULT_ENCRYPTION_KEY || 'default_32_bytes_vault_secret_key_kauri_2026';
    return crypto.scryptSync(masterSecret, `salt_${resellerId}`, 32);
  }

  /**
   * Encrypt plaintext string using AES-256-GCM
   */
  static encrypt(plaintext: string, resellerId: string): EncryptedPayload {
    if (!plaintext) {
      return { ciphertext: '', iv: '', authTag: '' };
    }

    try {
      const key = this.deriveKey(resellerId);
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
    } catch (error: any) {
      logger.error(`Vault encryption failed: ${error.message}`);
      throw new Error("Erreur lors du chiffrement des identifiants du coffre-fort.");
    }
  }

  /**
   * Decrypt AES-256-GCM payload back to plaintext string
   */
  static decrypt(
    ciphertext: string,
    ivHex: string,
    authTagHex: string,
    resellerId: string,
  ): string {
    if (!ciphertext || !ivHex || !authTagHex) {
      return '';
    }

    try {
      const key = this.deriveKey(resellerId);
      const iv = Buffer.from(ivHex, 'hex');
      const authTag = Buffer.from(authTagHex, 'hex');

      const decipher = crypto.createDecipheriv(this.ALGORITHM, key, iv);
      decipher.setAuthTag(authTag);

      let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    } catch (error: any) {
      logger.error(`Vault decryption failed: ${error.message}`);
      throw new Error("Échec du déchiffrement (clé invalide ou données corrompues).");
    }
  }
}
