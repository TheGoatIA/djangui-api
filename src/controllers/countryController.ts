import { Request, Response, NextFunction } from 'express';
import Country from '../models/Country';
import { AppError } from '../middleware/errorHandler';
import { RedisService } from '../services/redisService';

const ACTIVE_COUNTRIES_CACHE_KEY = 'config:countries:active';
const CACHE_TTL = 300; // 5 minutes

// Explicit field whitelist for admin-supplied Country data — defense in depth
// even though addCountry/updateCountry are already admin-only routes, so a
// schema field added later can't be set unexpectedly through mass assignment.
const pickCountryFields = (body: any) => {
  const { code, name, currency, currencySymbol, isActive } = body || {};
  return { code, name, currency, currencySymbol, isActive };
};

export class CountryController {
  /**
   * Public: Get all active countries
   */
  static async getActiveCountries(req: Request, res: Response, next: NextFunction) {
    try {
      const cached = await RedisService.get<any[]>(ACTIVE_COUNTRIES_CACHE_KEY);
      if (cached) {
        return res.status(200).json({
          success: true,
          data: { countries: cached },
        });
      }

      const countries = await Country.find({ isActive: true }).sort('name');
      await RedisService.set(ACTIVE_COUNTRIES_CACHE_KEY, countries, CACHE_TTL);

      res.status(200).json({
        success: true,
        data: { countries },
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * Admin: Get all countries (including inactive)
   */
  static async getAllCountries(req: Request, res: Response, next: NextFunction) {
    try {
      const countries = await Country.find().sort('name');
      res.status(200).json({
        success: true,
        data: { countries },
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * Admin: Add a new country
   */
  static async addCountry(req: Request, res: Response, next: NextFunction) {
    try {
      const country = await Country.create(pickCountryFields(req.body));
      await RedisService.del(ACTIVE_COUNTRIES_CACHE_KEY);
      res.status(201).json({
        success: true,
        data: { country },
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * Admin: Update country details
   */
  static async updateCountry(req: Request, res: Response, next: NextFunction) {
    try {
      const country = await Country.findByIdAndUpdate(req.params.id, pickCountryFields(req.body), {
        new: true,
        runValidators: true,
      });

      if (!country) throw new AppError('Country not found', 404);

      await RedisService.del(ACTIVE_COUNTRIES_CACHE_KEY);

      res.status(200).json({
        success: true,
        data: { country },
      });
    } catch (err) {
      next(err);
    }
  }
}
