import crypto from 'node:crypto';

/**
 * Constant-time string equality. Both inputs are hashed first so the comparison
 * time depends neither on the content nor on the length of either value
 * (crypto.timingSafeEqual itself throws on length mismatch).
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}
