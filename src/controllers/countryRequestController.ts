import { Request, Response, NextFunction } from 'express';
import CountryChangeRequest from '../models/CountryChangeRequest';
import Country from '../models/Country';
import User from '../models/User';
import { CurrencyService } from '../services/currencyService';
import { NotificationService } from '../services/notificationService';
import { AuthRequest } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import logger from '../utils/logger';

export class CountryRequestController {
    /**
     * User: Submit a request to change country
     */
    static async requestChange(req: AuthRequest, res: Response, next: NextFunction) {
        try {
            const { countryCode } = req.body;
            if (!countryCode) throw new AppError('Country code is required', 400);

            const targetCountry = await Country.findOne({ code: countryCode.toUpperCase(), isActive: true });
            if (!targetCountry) throw new AppError('Selected country is not supported', 400);

            // Check if user already has a pending request
            const pendingRequest = await CountryChangeRequest.findOne({
                userId: req.user._id,
                status: 'pending',
            });

            if (pendingRequest) throw new AppError('You already have a pending request', 400);

            const newRequest = await CountryChangeRequest.create({
                userId: req.user._id,
                requestedCountryCode: countryCode.toUpperCase(),
            });

            res.status(201).json({
                success: true,
                message: 'Demande de changement de pays soumise avec succès.',
                data: { request: newRequest },
            });
        } catch (err) {
            next(err);
        }
    }

    /**
     * Admin: Process a request (Approve/Reject)
     */
    static async processRequest(req: AuthRequest, res: Response, next: NextFunction) {
        try {
            const { id } = req.params;
            const { status, rejectionReason } = req.body;

            if (!['approved', 'rejected'].includes(status)) {
                throw new AppError('Invalid status', 400);
            }

            const countryRequest = await CountryChangeRequest.findById(id).populate('userId');
            if (!countryRequest) throw new AppError('Request not found', 404);
            if (countryRequest.status !== 'pending') throw new AppError('Request already processed', 400);

            const user = await User.findById(countryRequest.userId);
            if (!user) throw new AppError('User not found', 404);

            if (status === 'rejected') {
                countryRequest.status = 'rejected';
                countryRequest.rejectionReason = rejectionReason || 'Non spécifié';
                countryRequest.adminId = req.user._id;
                countryRequest.processedAt = new Date();
                await countryRequest.save();

                // Notify User
                await NotificationService.sendToUser(user._id.toString(), {
                    title: 'Demande de changement de pays rejetée',
                    body: `Votre demande a été refusée. Raison: ${countryRequest.rejectionReason}`,
                });

                return res.status(200).json({ success: true, message: 'Demande rejetée.' });
            }

            // If APPROVED
            const targetCountry = await Country.findOne({ code: countryRequest.requestedCountryCode });
            if (!targetCountry) throw new AppError('Target country not found or inactive', 400);

            const oldCurrency = user.currency;
            const newCurrency = targetCountry.currency;

            // 1. Perform Financial Conversion
            await CurrencyService.convertUserFinancialData(user._id.toString(), oldCurrency, newCurrency);

            // 2. Update User Country/Currency (Done inside CurrencyService but we double check/ensure here)
            user.country = targetCountry.code;
            user.currency = targetCountry.currency;
            await (user as any).save({ validateBeforeSave: false });

            // 3. Finalize Request
            countryRequest.status = 'approved';
            countryRequest.adminId = req.user._id;
            countryRequest.processedAt = new Date();
            await countryRequest.save();

            // 4. Notify User
            await NotificationService.sendToUser(user._id.toString(), {
                title: 'Pays mis à jour !',
                body: `Votre pays a été changé pour ${targetCountry.name}. Tous vos comptes ont été convertis en ${newCurrency}.`,
                data: { type: 'country_update', reload: 'true' }
            });

            res.status(200).json({
                success: true,
                message: 'Demande approuvée et conversion effectuée.',
            });

        } catch (err) {
            next(err);
        }
    }

    /**
     * Admin: List all requests
     */
    static async listRequests(req: Request, res: Response, next: NextFunction) {
        try {
            const { status } = req.query;
            const query = status ? { status } : {};
            const requests = await CountryChangeRequest.find(query)
                .populate('userId', 'firstName lastName email')
                .sort('-createdAt');

            res.status(200).json({
                success: true,
                data: { requests }
            });
        } catch (err) {
            next(err);
        }
    }
}
