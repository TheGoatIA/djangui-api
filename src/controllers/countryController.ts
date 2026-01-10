import { Request, Response, NextFunction } from 'express';
import Country from '../models/Country';
import { AppError } from '../middleware/errorHandler';

export class CountryController {
  /**
   * Public: Get all active countries
   */
  static async getActiveCountries(req: Request, res: Response, next: NextFunction) {
    try {
      const countries = await Country.find({ isActive: true }).sort('name');
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
      const country = await Country.create(req.body);
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
      const country = await Country.findByIdAndUpdate(req.params.id, req.body, {
        new: true,
        runValidators: true,
      });

      if (!country) throw new AppError('Country not found', 404);

      res.status(200).json({
        success: true,
        data: { country },
      });
    } catch (err) {
      next(err);
    }
  }
}
