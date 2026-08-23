import mongoose from 'mongoose';
import SharedMasterAccount, { ISharedMasterAccountDocument } from '../models/SharedMasterAccount';
import SharedSlot, { ISharedSlotDocument } from '../models/SharedSlot';
import SlotPaymentHistory from '../models/SlotPaymentHistory';
import User from '../models/User';
import { AppError } from '../middleware/errorHandler';
import { VaultCrypto } from '../utils/vaultCrypto';
import { CurrencyService } from './currencyService';
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

    const account = await SharedMasterAccount.create({
      ...accountData,
      resellerId,
      vault,
    });

    logger.info(`Master account created: ${account.serviceName} for reseller ${resellerId}`);
    return account;
  }

  /**
   * Récupérer tous les comptes maîtres d'un revendeur avec stats de slots
   */
  static async getResellerAccounts(resellerId: string): Promise<any[]> {
    const accounts = await SharedMasterAccount.find({ resellerId }).sort({ createdAt: -1 });

    const results = await Promise.all(
      accounts.map(async (acc) => {
        const slots = await SharedSlot.find({ masterAccountId: acc._id });
        const occupiedSlots = slots.filter((s) => s.status !== 'vacant').length;
        const totalRevenue = slots.reduce((accTotal, s) => accTotal + (s.status !== 'vacant' ? s.price : 0), 0);
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

    return results;
  }

  /**
   * Récupérer un compte maître par ID
   */
  static async getMasterAccountById(
    accountId: string,
    resellerId: string,
  ): Promise<ISharedMasterAccountDocument> {
    const account = await SharedMasterAccount.findOne({ _id: accountId, resellerId });
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

    const { email, password, pin, recoveryContact, secretNotes, ...restData } = data;

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
        recoveryContact: recoveryContact !== undefined ? recoveryContact : account.vault?.recoveryContact,
        iv,
        authTag,
      };
    }

    Object.assign(account, restData);
    await account.save();
    return account;
  }

  /**
   * Supprimer un compte maître et ses slots associés
   */
  static async deleteMasterAccount(accountId: string, resellerId: string): Promise<void> {
    const account = await SharedMasterAccount.findOne({ _id: accountId, resellerId });
    if (!account) throw new AppError('Compte introuvable', 404);

    await SharedSlot.deleteMany({ masterAccountId: accountId });
    await SharedMasterAccount.deleteOne({ _id: accountId });
    logger.info(`Master account ${accountId} and associated slots deleted`);
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
    const account = await SharedMasterAccount.findOne({ _id: accountId, resellerId });
    if (!account) throw new AppError('Compte maître introuvable', 404);

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
    const slot = await SharedSlot.findOneAndUpdate(
      { _id: slotId, resellerId },
      { $set: data },
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
