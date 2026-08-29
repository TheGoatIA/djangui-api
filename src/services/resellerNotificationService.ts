import SharedSlot, { ISharedSlotDocument } from '../models/SharedSlot';
import SharedMasterAccount from '../models/SharedMasterAccount';
import User from '../models/User';
import { NotificationService } from './notificationService';
import logger from '../utils/logger';

export interface INotificationProvider {
  sendReminder(
    slot: ISharedSlotDocument,
    accountName: string,
    type: 'J-3' | 'J-0' | 'OVERDUE',
  ): Promise<boolean>;
}

/**
 * 1. WhatsApp DeepLink Generator Provider
 */
export class WhatsAppDeepLinkProvider implements INotificationProvider {
  async sendReminder(
    slot: ISharedSlotDocument,
    accountName: string,
    type: 'J-3' | 'J-0' | 'OVERDUE',
  ): Promise<boolean> {
    // Generate text template
    const phone = slot.client.whatsappNumber || slot.client.phone;
    const formattedDate = new Date(slot.currentPeriodEnd).toLocaleDateString('fr-FR');

    let msg = '';
    if (type === 'J-3') {
      msg = `Bonjour ${slot.client.fullName} 👋,\n\nVotre accès à *${accountName}* (${slot.profileName}) arrive à expiration dans 3 jours (le *${formattedDate}*).\nMontant du renouvellement : *${slot.price} ${slot.currency}*.\nMerci de régulariser pour éviter toute coupure !`;
    } else if (type === 'J-0') {
      msg = `Bonjour ${slot.client.fullName} 🔔,\n\nVotre accès à *${accountName}* (${slot.profileName}) expire *aujourd'hui* (*${formattedDate}*).\nMontant à régler : *${slot.price} ${slot.currency}*.\nMerci pour votre fidélité !`;
    } else {
      msg = `Attention ${slot.client.fullName} ⚠️,\n\nVotre abonnement *${accountName}* (${slot.profileName}) est arrivé à échéance.\nMerci de procéder au paiement de *${slot.price} ${slot.currency}* dès que possible pour réactiver votre profil.`;
    }

    logger.info(
      `[WhatsApp Provider] Deep link created for client ${slot.client.fullName} (${phone})`,
    );
    return true;
  }

  static getDeepLink(
    slot: ISharedSlotDocument,
    accountName: string,
    resellerPhone?: string,
    lang: string = 'fr',
  ): string {
    const phone = (slot.client.whatsappNumber || slot.client.phone || '').replace(/[^0-9]/g, '');
    const formattedDate = new Date(slot.currentPeriodEnd).toLocaleDateString(
      lang === 'fr' ? 'fr-FR' : 'en-US',
    );

    const paymentInfo = resellerPhone ? `\nMoyen de paiement (OM/MOMO) : *${resellerPhone}*` : '';

    const textFr = `Bonjour ${slot.client.fullName} 👋,\n\nVotre accès à *${accountName}* (${slot.profileName}) expire le *${formattedDate}*.\nMontant : *${slot.price} ${slot.currency}*${paymentInfo}\n\nMerci de confirmer votre renouvellement !`;
    const textEn = `Hello ${slot.client.fullName} 👋,\n\nYour access to *${accountName}* (${slot.profileName}) expires on *${formattedDate}*.\nAmount : *${slot.price} ${slot.currency}*${paymentInfo}\n\nThank you for renewing!`;

    const message = lang === 'fr' ? textFr : textEn;
    return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
  }
}

/**
 * 2. Push Notification Provider (Sends notification to Reseller and/or Client)
 */
export class PushNotificationProvider implements INotificationProvider {
  async sendReminder(
    slot: ISharedSlotDocument,
    accountName: string,
    type: 'J-3' | 'J-0' | 'OVERDUE',
  ): Promise<boolean> {
    try {
      // Notify the reseller on their device
      await NotificationService.sendToUser(slot.resellerId.toString(), {
        title: `Rappel d'échéance : ${slot.client.fullName}`,
        body: `Le slot ${slot.profileName} sur ${accountName} expire (${type}). Pensez à relancer le client.`,
        category: 'important',
        data: {
          type: 'RESELLER_SLOT_REMINDER',
          slotId: slot._id.toString(),
          masterAccountId: slot.masterAccountId.toString(),
        },
      });

      return true;
    } catch (err: any) {
      logger.error(`Push notification reminder failed: ${err.message}`);
      return false;
    }
  }
}

/**
 * 3. Local SMS Provider (Plug-and-play adapter ready for future local aggregator)
 */
export class LocalSmsProvider implements INotificationProvider {
  private isConfigured: boolean = false;

  constructor() {
    this.isConfigured = !!process.env.LOCAL_SMS_API_KEY;
  }

  async sendReminder(
    slot: ISharedSlotDocument,
    accountName: string,
    type: 'J-3' | 'J-0' | 'OVERDUE',
  ): Promise<boolean> {
    if (!this.isConfigured) {
      logger.debug(`[LocalSmsProvider] Local SMS provider skipped (not configured yet).`);
      return false;
    }

    // TODO: Plug your local aggregator HTTP POST call here when ready
    logger.info(`[LocalSmsProvider] Would send SMS to ${slot.client.phone} for ${accountName}`);
    return true;
  }
}

/**
 * 4. Dispatcher Strategy Pattern
 */
export class ResellerNotificationDispatcher {
  private static pushProvider = new PushNotificationProvider();
  private static whatsAppProvider = new WhatsAppDeepLinkProvider();
  private static smsProvider = new LocalSmsProvider();

  static async dispatch(slot: ISharedSlotDocument, type: 'J-3' | 'J-0' | 'OVERDUE'): Promise<void> {
    try {
      const account = await SharedMasterAccount.findById(slot.masterAccountId);
      const accountName = account?.serviceName || 'Service Partagé';

      // Always push-notify the reseller
      await this.pushProvider.sendReminder(slot, accountName, type);

      // Trigger target channel according to client's preference
      if (slot.client.preferredReminderChannel === 'whatsapp') {
        await this.whatsAppProvider.sendReminder(slot, accountName, type);
      } else if (slot.client.preferredReminderChannel === 'push') {
        // In-app push if client user ID exists in Kauri
      }

      // Mark slot last reminder sent
      slot.lastReminderSentAt = new Date();
      slot.lastReminderType = type;
      await slot.save();
    } catch (error: any) {
      logger.error(`ResellerNotificationDispatcher failed: ${error.message}`);
    }
  }
}
