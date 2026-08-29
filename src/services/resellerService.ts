import mongoose from 'mongoose';
import SharedMasterAccount, { ISharedMasterAccountDocument } from '../models/SharedMasterAccount';
import SharedSlot, { ISharedSlotDocument } from '../models/SharedSlot';
import SlotPaymentHistory from '../models/SlotPaymentHistory';
import User from '../models/User';
import { AppError } from '../middleware/errorHandler';
import { VaultCrypto } from '../utils/vaultCrypto';
import { CurrencyService } from './currencyService';
import { withLock } from '../utils/distributedLock';
import { RESELLER_LIMITS } from '../middleware/resellerQuota';
import logger from '../utils/logger';

export class ResellerService {
  // ─── COMPTES MAÎTRES ────────────────────────────────────────────────────────

  /**
   * Créer un compte maître avec chiffrement automatique des identifiants
   */
  static async createMasterAccount(
    resellerId: string,
    data: any,
  ): Promise<ISharedMasterAccountDocument> {
    const { email, password, pin, recoveryContact, secretNotes, ...accountData } = data;

    let vault: any = undefined;
    if (email || password || pin || secretNotes || recoveryContact) {
      const payloadString = JSON.stringify({
        email: email || '',
        password: password || '',
        pin: pin || '',
        recoveryContact: recoveryContact || '',
        secretNotes: secretNotes || '',
      });

      const { ciphertext, iv, authTag } = VaultCrypto.encrypt(payloadString, resellerId);

      vault = {
        encryptedPassword: ciphertext,
        recoveryContact,
        iv,
        authTag,
      };
    }

    // Le quota est vérifié ET consommé sous verrou (F18) — un simple compte-puis-crée
    // laisse une fenêtre où deux requêtes concurrentes lisent toutes deux un compteur
    // encore sous la limite avant que l'une ou l'autre n'écrive.
    return withLock(`reseller:${resellerId}:accounts`, 5000, async () => {
      const user = await User.findById(resellerId).select('subscription.plan');
      const plan = (user?.subscription?.plan as 'free' | 'premium' | 'business') || 'free';
      const limit = RESELLER_LIMITS[plan] || RESELLER_LIMITS.free;

      if (limit.maxAccounts !== Infinity) {
        const currentAccountsCount = await SharedMasterAccount.countDocuments({
          resellerId,
          status: { $ne: 'expired' },
        });
        if (currentAccountsCount >= limit.maxAccounts) {
          throw new AppError(
            `Limite atteinte : Votre forfait actuel (${plan.toUpperCase()}) ne permet de gérer que ${limit.maxAccounts} compte(s). Passez au forfait Premium ou Business pour en ajouter davantage.`,
            403,
          );
        }
      }

      const account = await SharedMasterAccount.create({
        ...accountData,
        resellerId,
        vault,
      });

      logger.info(`Master account created: ${account.serviceName} for reseller ${resellerId}`);
      return account;
    });
  }

  /**
   * Récupérer tous les comptes maîtres d'un revendeur avec stats de slots, paginé.
   *
   * `resellerId: null` est le mode supervision admin (dashboard staff) : aucun
   * filtre de propriétaire, tous les comptes de la plateforme sont retournés page
   * par page, avec l'identité du revendeur propriétaire peuplée pour l'affichage.
   * Un revendeur en forfait Business a un nombre de comptes illimité (voir
   * RESELLER_LIMITS) — la pagination s'applique donc aussi en mode self-service,
   * pas seulement côté admin.
   */
  static async getResellerAccounts(
    resellerId: string | null,
    page = 1,
    limit = 20,
  ): Promise<{ accounts: any[]; total: number }> {
    const filter = resellerId ? { resellerId } : {};
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(100, Math.max(1, limit));

    const total = await SharedMasterAccount.countDocuments(filter);

    let query = SharedMasterAccount.find(filter)
      .sort({ createdAt: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit);
    if (!resellerId) {
      query = query.populate('resellerId', 'firstName lastName email');
    }
    const accounts = await query;

    const results = await Promise.all(
      accounts.map(async (acc) => {
        // A slot's resellerId always matches its master account's owner, so
        // scoping by the account itself is correct whether the caller is the
        // owning reseller or an admin supervising every account.
        const ownerId = resellerId || (acc.resellerId as any)?._id || acc.resellerId;
        const slots = await SharedSlot.find({ masterAccountId: acc._id, resellerId: ownerId });
        const occupiedSlots = slots.filter((s) => s.status !== 'vacant').length;
        const totalRevenue = slots.reduce(
          (accTotal, s) => accTotal + (s.status !== 'vacant' ? s.price : 0),
          0,
        );
        const netMargin = totalRevenue - acc.billingCost;

        // Strip vault secrets
        const accObj: any = acc.toObject();
        if (accObj.vault) {
          delete accObj.vault.encryptedEmail;
          delete accObj.vault.encryptedPassword;
          delete accObj.vault.encryptedPin;
          delete accObj.vault.encryptedNotes;
          accObj.hasVaultCredentials = true;
        }

        if (!resellerId && accObj.resellerId && typeof accObj.resellerId === 'object') {
          accObj.reseller = accObj.resellerId;
          accObj.resellerId = accObj.resellerId._id;
        }

        return {
          ...accObj,
          slotsCount: slots.length,
          occupiedSlots,
          vacantSlots: acc.maxSlots - occupiedSlots,
          totalRevenue,
          netMargin,
          slots,
        };
      }),
    );

    return { accounts: results, total };
  }

  /**
   * Récupérer un compte maître par ID. `resellerId: null` = portée admin
   * (tout compte, peu importe son propriétaire).
   */
  static async getMasterAccountById(
    accountId: string,
    resellerId: string | null,
  ): Promise<ISharedMasterAccountDocument> {
    const filter = resellerId ? { _id: accountId, resellerId } : { _id: accountId };
    let query = SharedMasterAccount.findOne(filter);
    if (!resellerId) {
      query = query.populate('resellerId', 'firstName lastName email');
    }
    const account = await query;
    if (!account) throw new AppError('Compte maître introuvable', 404);
    return account;
  }

  /**
   * Déverrouiller et déchiffrer les identifiants du coffre-fort
   */
  static async getVaultCredentials(accountId: string, resellerId: string): Promise<any> {
    const account = await SharedMasterAccount.findOne({ _id: accountId, resellerId });
    if (!account) throw new AppError('Compte introuvable', 404);
    if (!account.vault?.iv || !account.vault?.authTag || !account.vault?.encryptedPassword) {
      return { email: '', password: '', pin: '', recoveryContact: '', secretNotes: '' };
    }

    const { iv, authTag, encryptedPassword } = account.vault;
    const decryptedJson = VaultCrypto.decrypt(encryptedPassword, iv, authTag, resellerId);

    try {
      const data = JSON.parse(decryptedJson);
      logger.info(`Vault unlocked for account ${accountId} by reseller ${resellerId}`);
      return data;
    } catch {
      return { email: '', password: '', pin: '', recoveryContact: '', secretNotes: '' };
    }
  }

  /**
   * Mettre à jour un compte maître
   */
  static async updateMasterAccount(
    accountId: string,
    resellerId: string,
    data: any,
  ): Promise<ISharedMasterAccountDocument> {
    const account = await SharedMasterAccount.findOne({ _id: accountId, resellerId });
    if (!account) throw new AppError('Compte introuvable', 404);

    const {
      email,
      password,
      pin,
      recoveryContact,
      secretNotes,
      resellerId: _r,
      vault: _v,
      status: _s,
      ...restData
    } = data;

    if (email || password || pin || secretNotes || recoveryContact) {
      const payloadString = JSON.stringify({
        email: email || '',
        password: password || '',
        pin: pin || '',
        recoveryContact: recoveryContact || '',
        secretNotes: secretNotes || '',
      });

      const { ciphertext, iv, authTag } = VaultCrypto.encrypt(payloadString, resellerId);
      account.vault = {
        encryptedPassword: ciphertext,
        recoveryContact:
          recoveryContact !== undefined ? recoveryContact : account.vault?.recoveryContact,
        iv,
        authTag,
      };
    }

    const ALLOWED_ACCOUNT_FIELDS = [
      'serviceName',
      'icon',
      'category',
      'customCategory',
      'billingCost',
      'billingCycle',
      'renewalDate',
      'notes',
      'maxSlots',
    ];

    for (const key of ALLOWED_ACCOUNT_FIELDS) {
      if (key in restData) {
        (account as any)[key] = restData[key];
      }
    }

    await account.save();
    return account;
  }

  /**
   * Supprimer un compte maître et ses slots associés. `resellerId: null` =
   * portée admin (peut supprimer le compte de n'importe quel revendeur).
   */
  static async deleteMasterAccount(accountId: string, resellerId: string | null): Promise<void> {
    const filter = resellerId ? { _id: accountId, resellerId } : { _id: accountId };
    const account = await SharedMasterAccount.findOne(filter);
    if (!account) throw new AppError('Compte introuvable', 404);

    await SharedSlot.deleteMany({ masterAccountId: accountId });
    await SharedMasterAccount.deleteOne({ _id: accountId });
    logger.info(
      `Master account ${accountId} and associated slots deleted` +
        (resellerId ? '' : ` by admin (owner was ${account.resellerId})`),
    );
  }

  // ─── SLOTS / PROFILS CLIENTS ────────────────────────────────────────────────

  /**
   * Ajouter un slot à un compte maître
   */
  static async createSlot(
    resellerId: string,
    accountId: string,
    data: any,
  ): Promise<ISharedSlotDocument> {
    // Verrou par revendeur (F18) : couvre à la fois le quota du forfait (total de
    // slots actifs tous comptes confondus) et le quota par compte maître, tous deux
    // vérifiés puis consommés dans la même section critique.
    return withLock(`reseller:${resellerId}:slots`, 5000, async () => {
      const account = await SharedMasterAccount.findOne({ _id: accountId, resellerId });
      if (!account) throw new AppError('Compte maître introuvable', 404);

      const user = await User.findById(resellerId).select('subscription.plan');
      const plan = (user?.subscription?.plan as 'free' | 'premium' | 'business') || 'free';
      const planLimit = RESELLER_LIMITS[plan] || RESELLER_LIMITS.free;

      if (planLimit.maxSlotsTotal !== Infinity) {
        const totalSlotsCount = await SharedSlot.countDocuments({
          resellerId,
          status: { $ne: 'vacant' },
        });
        if (totalSlotsCount >= planLimit.maxSlotsTotal) {
          throw new AppError(
            `Limite de profils atteinte : Votre forfait (${plan.toUpperCase()}) est limité à ${planLimit.maxSlotsTotal} profils clients actifs. Mettez à niveau votre compte pour débloquer plus de slots.`,
            403,
          );
        }
      }

      const currentSlotsCount = await SharedSlot.countDocuments({ masterAccountId: accountId });
      if (currentSlotsCount >= account.maxSlots) {
        throw new AppError(
          `Tous les slots (${account.maxSlots}/${account.maxSlots}) de ce compte sont déjà créés.`,
          400,
        );
      }

      // Calculate dates
      const startDate = data.startDate ? new Date(data.startDate) : new Date();
      const billingCycle = data.billingCycle || 'monthly';
      const currentPeriodStart = startDate;
      const currentPeriodEnd = new Date(startDate);

      if (billingCycle === 'yearly') {
        currentPeriodEnd.setFullYear(currentPeriodEnd.getFullYear() + 1);
      } else if (billingCycle === 'quarterly') {
        currentPeriodEnd.setMonth(currentPeriodEnd.getMonth() + 3);
      } else {
        currentPeriodEnd.setMonth(currentPeriodEnd.getMonth() + 1);
      }

      const slot = await SharedSlot.create({
        ...data,
        masterAccountId: accountId,
        resellerId,
        startDate,
        currentPeriodStart,
        currentPeriodEnd,
        status: 'active',
      });

      // Record initial payment history if marked paid
      if (data.recordInitialPayment !== false) {
        await SlotPaymentHistory.create({
          slotId: slot._id,
          masterAccountId: accountId,
          resellerId,
          amount: slot.price,
          currency: slot.currency,
          periodCoveredStart: currentPeriodStart,
          periodCoveredEnd: currentPeriodEnd,
          paidAt: new Date(),
          paymentMethod: data.paymentMethod || 'momo',
          notes: 'Premier règlement client',
        });
      }

      return slot;
    });
  }

  /**
   * Marquer un slot comme renouvelé / payé
   */
  static async recordSlotPayment(
    slotId: string,
    resellerId: string,
    paymentData: { amount?: number; paymentMethod?: string; notes?: string },
  ): Promise<ISharedSlotDocument> {
    const slot = await SharedSlot.findOne({ _id: slotId, resellerId });
    if (!slot) throw new AppError('Slot introuvable', 404);

    const periodCoveredStart = new Date(slot.currentPeriodEnd);
    const periodCoveredEnd = new Date(periodCoveredStart);

    if (slot.billingCycle === 'yearly') {
      periodCoveredEnd.setFullYear(periodCoveredEnd.getFullYear() + 1);
    } else if (slot.billingCycle === 'quarterly') {
      periodCoveredEnd.setMonth(periodCoveredEnd.getMonth() + 3);
    } else {
      periodCoveredEnd.setMonth(periodCoveredEnd.getMonth() + 1);
    }

    // Advance slot period
    slot.currentPeriodStart = periodCoveredStart;
    slot.currentPeriodEnd = periodCoveredEnd;
    slot.status = 'active';
    await slot.save();

    // Create payment history entry
    await SlotPaymentHistory.create({
      slotId: slot._id,
      masterAccountId: slot.masterAccountId,
      resellerId,
      amount: paymentData.amount || slot.price,
      currency: slot.currency,
      periodCoveredStart,
      periodCoveredEnd,
      paidAt: new Date(),
      paymentMethod: paymentData.paymentMethod || 'momo',
      notes: paymentData.notes || 'Renouvellement mensuel',
    });

    logger.info(`Payment recorded and slot renewed for ${slot.client.fullName} (${slot._id})`);
    return slot;
  }

  /**
   * Mettre à jour un slot
   */
  static async updateSlot(
    slotId: string,
    resellerId: string,
    data: any,
  ): Promise<ISharedSlotDocument> {
    const ALLOWED_SLOT_FIELDS = [
      'profileName',
      'pin',
      'client',
      'price',
      'currency',
      'billingCycle',
      'notes',
      'reminderSent',
    ];

    const safeData: any = {};
    for (const key of ALLOWED_SLOT_FIELDS) {
      if (key in data) {
        safeData[key] = data[key];
      }
    }

    const slot = await SharedSlot.findOneAndUpdate(
      { _id: slotId, resellerId },
      { $set: safeData },
      { new: true, runValidators: true },
    );
    if (!slot) throw new AppError('Slot introuvable', 404);
    return slot;
  }

  /**
   * Libérer / supprimer un slot
   */
  static async deleteSlot(slotId: string, resellerId: string): Promise<void> {
    const result = await SharedSlot.deleteOne({ _id: slotId, resellerId });
    if (result.deletedCount === 0) throw new AppError('Slot introuvable', 404);
  }
}
