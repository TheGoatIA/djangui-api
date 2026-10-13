import { Request, Response, NextFunction } from 'express';
import { safeEqual } from '../utils/safeCompare';

/**
 * Garde-fou léger pour les endpoints publics qui doivent rester accessibles
 * sans session utilisateur (ex: télémétrie pré-connexion) mais ne devraient
 * pas non plus être ouverts à n'importe qui sur Internet (audit F-14).
 *
 * Ce n'est PAS un remplacement de l'authentification par JWT : la clé est
 * embarquée dans le client mobile (comme une clé API Firebase), donc pas un
 * vrai secret — elle prouve seulement "cette requête vient d'un client
 * officiel Kauri", ce qui suffit à écarter le spam/l'injection anonyme sur
 * un endpoint dont le seul but est de ne jamais bloquer un utilisateur non
 * connecté (K-07 : le vrai token de session, lui, n'est jamais envoyé ici).
 */
export function requireClientApiKey(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.MOBILE_CLIENT_API_KEY;
  if (!expected) {
    // Fail CLOSED en production (server.ts refuse d'ailleurs de démarrer sans clé).
    // Hors production, on laisse passer pour ne pas imposer la clé en local.
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({ success: false, message: 'Client key not configured' });
    }
    return next();
  }

  const provided = req.headers['x-client-key'];
  if (typeof provided !== 'string' || !safeEqual(provided, expected)) {
    return res.status(401).json({ success: false, message: 'Invalid client key' });
  }
  next();
}
