import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth';
import { CurrencyService } from '../services/currencyService';

const MONETARY_FIELDS = [
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
];

const TEXT_FIELDS = ['description', 'title', 'message', 'body'];

const CURRENCY_FIELDS = ['currency', 'currencySymbol'];

/**
 * Middleware to automatically convert currency in responses
 */
export const currencyMiddleware = (req: AuthRequest, res: Response, next: NextFunction) => {
    // Save original json method
    const originalJson = res.json;

    // Override json method
    res.json = function (body: any) {
        // Only convert if user is logged in and has a different currency than XAF
        const userCurrency = req.user?.currency;

        // if (userCurrency && userCurrency !== 'XAF' && body) {
        //     try {
        //         body = convertObject(body, userCurrency);
        //     } catch (err) {
        //         // Fallback to original body if conversion fails
        //         console.error('Currency conversion error:', err);
        //     }
        // }

        return originalJson.call(this, body);
    };

    next();
};

/**
 * Recursively convert monetary fields in an object or array
 */
function convertObject(obj: any, targetCurrency: string): any {
    if (Array.isArray(obj)) {
        return obj.map((item) => convertObject(item, targetCurrency));
    }

    if (obj !== null && typeof obj === 'object') {
        // Handle Mongoose Documents
        if (typeof obj.toJSON === 'function') {
            obj = obj.toJSON();
        } else if (typeof obj.toObject === 'function') {
            obj = obj.toObject();
        }

        const newObj: any = {};

        for (const key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) {
                let value = obj[key];

                if (MONETARY_FIELDS.includes(key) && typeof value === 'number') {
                    value = CurrencyService.convert(value, 'XAF', targetCurrency);
                } else if (TEXT_FIELDS.includes(key) && typeof value === 'string') {
                    value = CurrencyService.convertText(value, targetCurrency, 'XAF');
                } else if (CURRENCY_FIELDS.includes(key) && typeof value === 'string') {
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
