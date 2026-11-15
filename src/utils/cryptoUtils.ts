import crypto from 'crypto';

/**
 * Hash an opaque token (e.g. a refresh token) before persisting it.
 * Refresh tokens are high-entropy JWTs, not low-entropy secrets like
 * passwords, so a plain SHA-256 digest (rather than bcrypt) is sufficient:
 * it is not brute-forceable and lets us compare/index by hash directly,
 * while ensuring a leaked database no longer yields usable tokens.
 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Verify NotchPay webhook signature using a timing-safe comparison
 * to prevent timing-based side-channel attacks.
 * @param payload The RAW request body bytes (Buffer/string) — must be exactly what
 * NotchPay signed. Passing the parsed-then-re-serialized JSON object here (e.g.
 * `JSON.stringify(req.body)`) is not guaranteed to byte-match the original payload
 * (key order, number formatting, unicode escaping can differ), which silently
 * rejects legitimate webhook deliveries. See app.ts's express.json `verify` hook,
 * which captures `req.rawBody` for this route.
 * @param signature The signature from the X-Notch-Signature header
 * @param secret The webhook secret from the NotchPay dashboard
 */
export function verifyNotchPaySignature(
  payload: Buffer | string,
  signature: string,
  secret: string,
): boolean {
  if (!signature || !secret) return false;

  const hmac = crypto.createHmac('sha256', secret);
  const calculatedSignature = hmac.update(payload).digest('hex');

  // Use timing-safe comparison to prevent timing attacks
  try {
    const sigBuffer = Buffer.from(signature, 'hex');
    const calcBuffer = Buffer.from(calculatedSignature, 'hex');

    if (sigBuffer.length !== calcBuffer.length) return false;

    return crypto.timingSafeEqual(calcBuffer, sigBuffer);
  } catch {
    return false;
  }
}
