import crypto from 'crypto';

/**
 * Verify NotchPay webhook signature
 * @param payload The raw request body as string
 * @param signature The signature from X-Notch-Signature header
 * @param secret The webhook secret from dashboard
 */
export function verifyNotchPaySignature(payload: any, signature: string, secret: string): boolean {
    if (!signature || !secret) return false;

    const hmac = crypto.createHmac('sha256', secret);
    const calculatedSignature = hmac.update(JSON.stringify(payload)).digest('hex');

    return calculatedSignature === signature;
}
