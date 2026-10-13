import { Response } from 'express';

const ACCESS_TOKEN_MAX_AGE_MS = 15 * 60 * 1000; // 15 minutes — keep in sync with JWT_ACCESS_EXPIRATION
const REFRESH_TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — keep in sync with JWT_REFRESH_EXPIRATION

const isProduction = process.env.NODE_ENV === 'production';

/**
 * Sets the access/refresh JWTs as httpOnly cookies rather than returning them
 * in the JSON body — the admin frontend never touches the raw token, which
 * removes the classic XSS-steals-localStorage-token attack surface.
 * sameSite=lax is safe here because the admin UI and the API are same-site
 * (same registrable domain, different subdomains).
 */
export function setAuthCookies(
  res: Response,
  tokens: { accessToken: string; refreshToken: string },
) {
  res.cookie('access_token', tokens.accessToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: ACCESS_TOKEN_MAX_AGE_MS,
  });

  res.cookie('refresh_token', tokens.refreshToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: REFRESH_TOKEN_MAX_AGE_MS,
  });
}

export function clearAuthCookies(res: Response) {
  res.clearCookie('access_token');
  res.clearCookie('refresh_token');
}

/**
 * Browser clients (the admin dashboard) authenticate through the httpOnly
 * cookies set above and declare themselves with `X-Client-Type: web`. For them
 * the raw JWTs must never appear in a JSON body: any script running on the page
 * (XSS) could otherwise call /auth/login or /auth/refresh with `credentials:
 * 'include'` and read the tokens back, defeating the httpOnly protection.
 * Mobile clients (no such header) keep receiving tokens in the body.
 */
export function isCookieOnlyClient(req: { headers: Record<string, any> }): boolean {
  return String(req.headers['x-client-type'] || '').toLowerCase() === 'web';
}
