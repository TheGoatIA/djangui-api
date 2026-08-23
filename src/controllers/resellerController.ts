import { Response, NextFunction } from 'express';
import { AuthRequest } from '../middleware/auth';
import { ResellerService } from '../services/resellerService';
import { ResellerAnalyticsService } from '../services/resellerAnalyticsService';
import { WhatsAppDeepLinkProvider, ResellerNotificationDispatcher } from '../services/resellerNotificationService';
import { SERVICE_CATALOG } from '../data/serviceCatalog';
import SharedSlot from '../models/SharedSlot';
import SharedMasterAccount from '../models/SharedMasterAccount';
import { AppError } from '../middleware/errorHandler';

export class ResellerController {
  // ─── CATALOGUE PRÉDÉFINI ───────────────────────────────────────────────────

  static async getCatalog(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      res.status(200).json({
        status: 'success',
        data: SERVICE_CATALOG,
      });
    } catch (err) {
      next(err);
    }
  }

  // ─── COMPTES MAÎTRES ───────────────────────────────────────────────────────

  static async listAccounts(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const accounts = await ResellerService.getResellerAccounts(req.user._id);
      res.status(200).json({
        status: 'success',
        results: accounts.length,
        data: accounts,
      });
    } catch (err) {
      next(err);
    }
  }

  static async createAccount(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const account = await ResellerService.createMasterAccount(req.user._id, req.body);
      res.status(201).json({
        status: 'success',
        data: account,
      });
    } catch (err) {
      next(err);
    }
  }

  static async getAccountDetails(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const account = await ResellerService.getMasterAccountById(req.params.id, req.user._id);
      const slots = await SharedSlot.find({ masterAccountId: account._id });

      res.status(200).json({
        status: 'success',
        data: {
          account,
          slots,
        },
      });
    } catch (err) {
      next(err);
    }
  }

  static async updateAccount(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const account = await ResellerService.updateMasterAccount(req.params.id, req.user._id, req.body);
      res.status(200).json({
        status: 'success',
        data: account,
      });
    } catch (err) {
      next(err);
    }
  }

  static async deleteAccount(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      await ResellerService.deleteMasterAccount(req.params.id, req.user._id);
      res.status(204).json({
        status: 'success',
        data: null,
      });
    } catch (err) {
      next(err);
    }
  }

  static async unlockVault(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const credentials = await ResellerService.getVaultCredentials(req.params.id, req.user._id);
      res.status(200).json({
        status: 'success',
        data: credentials,
      });
    } catch (err) {
      next(err);
    }
  }

  // ─── SLOTS / PROFILS CLIENTS ────────────────────────────────────────────────

  static async addSlot(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const slot = await ResellerService.createSlot(req.user._id, req.params.accountId, req.body);
      res.status(201).json({
        status: 'success',
        data: slot,
      });
    } catch (err) {
      next(err);
    }
  }

  static async updateSlot(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const slot = await ResellerService.updateSlot(req.params.slotId, req.user._id, req.body);
      res.status(200).json({
        status: 'success',
        data: slot,
      });
    } catch (err) {
      next(err);
    }
  }

  static async deleteSlot(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      await ResellerService.deleteSlot(req.params.slotId, req.user._id);
      res.status(204).json({
        status: 'success',
        data: null,
      });
    } catch (err) {
      next(err);
    }
  }

  static async recordPayment(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const slot = await ResellerService.recordSlotPayment(req.params.slotId, req.user._id, req.body);
      res.status(200).json({
        status: 'success',
        message: 'Paiement enregistré et slot renouvelé avec succès.',
        data: slot,
      });
    } catch (err) {
      next(err);
    }
  }

  static async getWhatsAppReminderLink(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const slot = await SharedSlot.findOne({ _id: req.params.slotId, resellerId: req.user._id });
      if (!slot) throw new AppError('Slot introuvable', 404);

      const account = await SharedMasterAccount.findById(slot.masterAccountId);
      const deepLink = WhatsAppDeepLinkProvider.getDeepLink(
        slot,
        account?.serviceName || 'Service Partagé',
        req.user.phone,
        req.user.language || 'fr',
      );

      res.status(200).json({
        status: 'success',
        data: {
          deepLink,
        },
      });
    } catch (err) {
      next(err);
    }
  }

  static async triggerReminder(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const slot = await SharedSlot.findOne({ _id: req.params.slotId, resellerId: req.user._id });
      if (!slot) throw new AppError('Slot introuvable', 404);

      const reminderType = req.body.type || 'J-3';
      await ResellerNotificationDispatcher.dispatch(slot, reminderType);

      res.status(200).json({
        status: 'success',
        message: 'Relance envoyée avec succès.',
      });
    } catch (err) {
      next(err);
    }
  }

  // ─── ANALYTICS ──────────────────────────────────────────────────────────────

  static async getDashboard(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const stats = await ResellerAnalyticsService.getResellerDashboardStats(req.user._id);
      res.status(200).json({
        status: 'success',
        data: stats,
      });
    } catch (err) {
      next(err);
    }
  }

  static async exportCsv(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const csv = await ResellerAnalyticsService.exportAccountingCsv(req.user._id);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="kauri-reseller-export-${new Date().toISOString().split('T')[0]}.csv"`,
      );
      res.status(200).send(csv);
    } catch (err) {
      next(err);
    }
  }
}
