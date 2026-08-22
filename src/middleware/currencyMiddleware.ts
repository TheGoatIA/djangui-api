import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth';
import { CurrencyService } from '../services/currencyService';

const MONETARY_FIELDS = new Set([
  'amount',
  'targetAmount',
  'balance',
  'walletBalance',
  'currentValue',
  'contributionAmount',
  'savedAmount',
  'weeklyTarget',
  'lateFee',
  'absenceFee',
  'socialFundAmount',
  'monthlyIncome',
]);

const TEXT_FIELDS = new Set(['description', 'title', 'message', 'body']);
const CURRENCY_FIELDS = new Set(['currency', 'currencySymbol']);

/**
 * Middleware de conversion automatique de devise dans les réponses.
 * Convertit XAF → devise de l'utilisateur si différente.
 * Fallback silencieux si le taux est indisponible.
 */
export const currencyMiddleware = (req: AuthRequest, res: Response, next: NextFunction) => {
  const originalJson = res.json;

  res.json = function (body: any) {
    const userCurrency = req.user?.currency;

    if (userCurrency && userCurrency !== 'XAF' && body) {
      try {
        body = convertObject(body, userCurrency);
      } catch (err) {
        // Fallback silencieux : retourne le body en XAF sans planter
        console.error('[Currency] Erreur de conversion, fallback XAF:', err);
      }
    }

    return originalJson.call(this, body);
  };

  next();
};

/**
 * Convertit récursivement les champs monétaires d'un objet ou tableau.
 */
function convertObject(obj: any, targetCurrency: string): any {
  if (Array.isArray(obj)) {
    return obj.map((item) => convertObject(item, targetCurrency));
  }

  if (obj !== null && typeof obj === 'object') {
    // Gérer les Documents Mongoose
    if (typeof obj.toJSON === 'function') {
      obj = obj.toJSON();
    } else if (typeof obj.toObject === 'function') {
      obj = obj.toObject();
    }

    // La devise déclarée par l'objet lui-même (ex: une tontine en EUR) est la
    // vraie devise source de ses champs monétaires. Supposer XAF sans regarder
    // ce champ convertit un montant déjà en EUR/USD comme s'il était en XAF,
    // ce qui produit un montant totalement faux (sur/sous-paiement réel).
    const sourceCurrency: string =
      typeof obj.currency === 'string' && obj.currency ? obj.currency : 'XAF';

    const newObj: any = {};

    for (const key in obj) {
      if (Object.hasOwn(obj, key)) {
        let value = obj[key];

        if (MONETARY_FIELDS.has(key) && typeof value === 'number') {
          value = CurrencyService.convert(value, sourceCurrency, targetCurrency);
        } else if (TEXT_FIELDS.has(key) && typeof value === 'string') {
          value = CurrencyService.convertText(value, targetCurrency, sourceCurrency);
        } else if (CURRENCY_FIELDS.has(key) && typeof value === 'string') {
          if (key === 'currency') value = targetCurrency;
          if (key === 'currencySymbol') value = CurrencyService.getSymbol(targetCurrency);
        } else if (typeof value === 'object') {
          value = convertObject(value, targetCurrency);
        }

        newObj[key] = value;
      }
    }
    return newObj;
  }

  return obj;
}

