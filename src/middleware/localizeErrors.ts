import { Request, Response, NextFunction } from 'express';
import { localizeMessage, pickLanguage } from '../utils/errorI18n';

/**
 * Traduit le champ `message` de TOUTE réponse d'erreur (>= 400) dans la langue
 * de l'utilisateur (profil, sinon Accept-Language, sinon français) — couvre le
 * gestionnaire d'erreurs global ET les réponses directes (limiteur de débit,
 * validations ad hoc…). Voir utils/errorI18n.ts.
 */
export function localizeErrors(req: Request, res: Response, next: NextFunction) {
  const originalJson = res.json.bind(res);
  res.json = (body: any) => {
    if (
      res.statusCode >= 400 &&
      body &&
      typeof body === 'object' &&
      typeof body.message === 'string'
    ) {
      const lang = pickLanguage((req as any).user?.language, req.headers['accept-language']);
      body = { ...body, message: localizeMessage(body.message, lang) };
    }
    return originalJson(body);
  };
  next();
}
