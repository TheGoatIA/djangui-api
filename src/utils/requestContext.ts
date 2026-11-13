import { AsyncLocalStorage } from 'async_hooks';
import { Request, Response, NextFunction } from 'express';
import { pickLanguage } from './errorI18n';

/**
 * Contexte de la requête en cours, accessible depuis n'importe quel service
 * (sans faire descendre `req` partout) — utilisé pour répondre dans la langue
 * de l'utilisateur : libellés de catégories, contenus de défis…
 */
const storage = new AsyncLocalStorage<{ req: Request }>();

export function requestContext(req: Request, _res: Response, next: NextFunction) {
  storage.run({ req }, next);
}

/** Langue de la requête en cours : profil, sinon Accept-Language, sinon français. */
export function currentLanguage(): 'fr' | 'en' {
  const req = storage.getStore()?.req as any;
  if (!req) return 'fr';
  return pickLanguage(req.user?.language, req.headers?.['accept-language']);
}
