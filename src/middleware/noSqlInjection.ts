import { Request, Response, NextFunction } from 'express';

/**
 * Global defence against MongoDB operator injection and prototype pollution.
 *
 * Several public routes pass request values straight into Mongoose filters
 * without a Joi schema (forgot-password, resend-verification, …). A body such
 * as `{"email": {"$ne": null}}` would then match the FIRST user in the
 * collection: the reset/verification email was generated for an arbitrary
 * account chosen by an anonymous caller.
 *
 * No legitimate client sends `$`-prefixed keys — the admin dashboard's
 * advanced filters use `amount[gte]=…`, and the server adds the `$` itself
 * (AdminController.sanitizeQueryObject). Such a request is therefore REJECTED
 * (400) rather than silently rewritten, so a bug or an attack is visible.
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_DEPTH = 20;

export function findForbiddenKey(value: unknown, depth = 0): string | null {
  if (value === null || typeof value !== 'object') return null;
  if (Buffer.isBuffer(value)) return null; // raw webhook bodies
  if (depth > MAX_DEPTH) return '<too deep>';

  for (const key of Object.keys(value as object)) {
    if (key.startsWith('$') || FORBIDDEN_KEYS.has(key)) return key;
    const nested = findForbiddenKey((value as Record<string, unknown>)[key], depth + 1);
    if (nested) return nested;
  }
  return null;
}

export function rejectNoSqlInjection(req: Request, res: Response, next: NextFunction) {
  const key =
    findForbiddenKey(req.body) || findForbiddenKey(req.query) || findForbiddenKey(req.params);
  if (key) {
    return res.status(400).json({
      status: 'error',
      message: 'Paramètres de requête invalides.',
    });
  }
  next();
}
