/**
 * Générateur TOTP INDÉPENDANT de src/utils/totp.ts (RFC 6238, SHA-1, 6 chiffres, 30 s) :
 * si l'implémentation de prod dérive de la norme, les tests 2FA le détectent.
 */
import crypto from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32ToBuffer(secret: string): Buffer {
  let bits = '';
  for (const c of secret.toUpperCase().replace(/=+$/, '')) {
    const v = ALPHABET.indexOf(c);
    if (v < 0) throw new Error(`base32 invalide: ${c}`);
    bits += v.toString(2).padStart(5, '0');
  }
  const out: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}

export function totpCode(secret: string, atMs = Date.now()): string {
  const counter = Math.floor(atMs / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32ToBuffer(secret)).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}
