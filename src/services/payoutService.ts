import Transaction from '../models/Transaction';
import User from '../models/User';
import { AppError } from '../middleware/errorHandler';
import logger from '../utils/logger';
import { MonitoringService } from './monitoringService';
import { WalletService } from './walletService';
import { NotificationService } from './notificationService';
import { FraudService } from './fraudService';
import { notchpayAdminApi } from '../config/notchpay';

/**
 * Codes d'erreur réseau qui indiquent que la requête n'a JAMAIS atteint NotchPay.
 * Dans ce cas, il est sûr de rembourser le solde car aucun transfert n'a été initié.
 */
const SAFE_TO_REFUND_CODES = new Set([
  'ECONNREFUSED',   // Le serveur a activement refusé la connexion (backend off)
  'ENOTFOUND',      // DNS non résolu
  'ECONNRESET',     // Connexion réinitialisée avant envoi
  'ECONNABORTED',   // Connexion avortée avant envoi
]);

export class PayoutService {
  /**
   * Initie un transfert d'argent (Retrait) via NotchPay.
   *
   * Ordre des opérations :
   *   1. Vérifications préalables (feature flag, géo-fencing, KYC, fraude)
   *   2. Débit du solde + création de la transaction interne (status: 'pending')
   *   3. Appel NotchPay
   *      - Succès  → marquer la transaction 'completed'
   *      - Erreur connexion pure (ECONNREFUSED etc.) → marquer 'failed' + rembourser
   *      - Erreur ambiguë (5xx, timeout après envoi) → laisser 'pending' pour audit/webhook
   */
  static async initiatePayout(
    userId: string,
    amount: number,
    data: {
      phone: string;
      provider: 'cm.orange' | 'cm.mtn';
      description?: string;
    },
  ) {
    const user = await User.findById(userId);
    if (!user) throw new AppError('Utilisateur non trouvé', 404);

    // 0. Vérification du mode Argent Réel
    const { FeatureFlagService } = await import('./featureFlagService');
    const isRealMoney = await FeatureFlagService.isRealMoneyEnabled();
    if (!isRealMoney) {
      throw new AppError(
        'Les retraits en argent réel sont actuellement désactivés (Mode Portefeuille Virtuel / Simulation).',
        400,
      );
    }

    // 1. Géo-fencing strict
    if (!(await FeatureFlagService.isCountryAllowedForRealMoney(user.country))) {
      throw new AppError("Les retraits Mobile Money ne sont disponibles qu'au Cameroun.", 400);
    }

    // 2. Double vérification KYC
    if (user.kycLevel !== 'verified') {
      throw new AppError(
        'Vous devez avoir un compte vérifié (KYC) pour effectuer des retraits.',
        403,
      );
    }

    // 2.5. Évaluation anti-fraude
    const fraud = await FraudService.assess(userId, amount, 'withdrawal', user.currency || 'XAF');
    if (fraud.block) {
      throw new AppError(
        'Opération temporairement suspendue par notre système de sécurité. Veuillez contacter le support.',
        403,
      );
    }

    // 2.7. Validation stricte du numéro et de l'opérateur AVANT tout débit de portefeuille
    const { channel, formattedPhone } = PayoutService._resolveCameroonChannel(
      data.phone,
      data.provider,
    );

    // 3. Calcul des frais et débit du solde (ACID) + transaction en 'pending'
    const kauriFeePercent = user.subscription?.plan === 'premium' ? 0.015 : 0.03;
    const kauriFees = Math.max(100, amount * kauriFeePercent);
    const totalAmount = amount + kauriFees;

    // Débit + création de la transaction interne (silent = pas de notif auto)
    const transaction = await WalletService.executeTransaction({
      userId,
      amount: totalAmount,
      type: 'withdrawal',
      description: data.description || 'Retrait MoMo Kauri',
      paymentMethod: 'wallet',
      fees: kauriFees,
      metadata: { phone: formattedPhone, provider: channel },
      silent: true,
    });

    const transactionId = (transaction as any)._id?.toString() || (transaction as any).id;
    const transactionRef = (transaction as any).reference;

    // Immédiatement après le débit, on force le status à 'pending'.
    await Transaction.findByIdAndUpdate(transactionId, { status: 'pending' });

    const start = Date.now();
    const transferPayload = {
      description: data.description || 'MANUAL_CASHOUT',
      amount: amount.toString(),
      currency: user.currency || 'XAF',
      channel,
      reference: transactionRef,
      recipient: {
        account_number: formattedPhone,
        country: 'CM',
        name: user.kycData?.fullName || `${user.firstName} ${user.lastName}`,
      },
      metadata: {
        reference: transactionRef,
        source: 'kauri_app',
      },
    };
    logger.debug(`NotchPay Transfer Payload: ${JSON.stringify(transferPayload)}`);

    try {
      const response = await notchpayAdminApi.post('/transfers', transferPayload, {
        headers: { 'Content-Type': 'application/json' },
      });

      MonitoringService.recordPaymentGateway('notchpay', 'transfer', 'success');

      // Marquer la transaction comme complétée maintenant que NotchPay a confirmé
      await Transaction.findByIdAndUpdate(transactionId, { status: 'completed' });

      NotificationService.sendToUser(userId, {
        title: 'Retrait Initié 💸',
        body: `Votre demande de retrait de ${amount} ${user.currency || 'XAF'} a été envoyée vers ${formattedPhone}.`,
        category: 'transactional',
        data: { transactionRef: transactionRef, type: 'withdrawal' },
      }).catch((err: any) => logger.error(`Payout Success Notification Error: ${err.message}`));

      const transferId =
        response.data.transfer?.reference || response.data.transfer?.id || response.data.id;
      return {
        status: 'pending',
        transferId,
        reference: transactionRef,
        fees: kauriFees,
      };
    } catch (error: any) {
      MonitoringService.recordPaymentGateway('notchpay', 'transfer', 'failure');
      const errorCode: string = error.code || '';
      const httpStatus: number = error.response?.status || 0;
      const errorMessage = error.response?.data?.message || error.message;
      const errorDetails = error.response?.data?.errors
        ? JSON.stringify(error.response.data.errors)
        : '';
      logger.error(`NotchPay Transfer Error [${errorCode || httpStatus}]: ${errorMessage} ${errorDetails}`);

      if (error.response?.data) {
        logger.debug(`NotchPay Full Error Response: ${JSON.stringify(error.response.data)}`);
      }

      // ── Rejet explicite NotchPay (400, 422) : Aucune transaction n'a été initiée côté opérateur ──
      if (httpStatus === 400 || httpStatus === 422) {
        logger.warn(
          `[PAYOUT] Transfert rejeté par NotchPay (HTTP ${httpStatus}: ${errorMessage}) — remboursement automatique immédiat de ${totalAmount} XAF pour user ${userId}`,
        );
        await PayoutService._refundTransaction(
          transactionId,
          userId,
          totalAmount,
          `Rejet opérateur : ${errorMessage}`,
        );
        NotificationService.sendToUser(userId, {
          title: 'Retrait Échoué ❌',
          body: `Le retrait vers ${formattedPhone} a été refusé par l'opérateur (${errorMessage}). Votre solde a été rétabli.`,
          category: 'important',
          data: { transactionRef: transactionRef, type: 'withdrawal_cancelled' },
        }).catch((err: any) => logger.error(`Payout Cancel Notification Error: ${err.message}`));

        throw new AppError(
          `Le transfert a été refusé par l'opérateur : ${errorMessage}. Votre solde a été immédiatement rétabli.`,
          400,
        );
      }

      // ── Erreur de connexion PURE : NotchPay n'a jamais reçu la requête ──────────
      if (SAFE_TO_REFUND_CODES.has(errorCode) || !error.response) {
        logger.warn(
          `[PAYOUT] Connexion échouée avant envoi (${errorCode || 'no response'}) — remboursement automatique de ${totalAmount} XAF pour user ${userId}`,
        );
        await PayoutService._refundTransaction(
          transactionId,
          userId,
          totalAmount,
          `Échec connexion: ${errorCode || 'réseau indisponible'}`,
        );
        NotificationService.sendToUser(userId, {
          title: 'Retrait Annulé ❌',
          body: `Le retrait vers ${formattedPhone} a échoué (service temporairement indisponible). Votre solde a été rétabli.`,
          category: 'important',
          data: { transactionRef: transactionRef, type: 'withdrawal_cancelled' },
        }).catch((err: any) => logger.error(`Payout Cancel Notification Error: ${err.message}`));
        throw new AppError("Service de paiement temporairement indisponible. Votre solde n'a pas été débité.", 503);
      }

      // ── Erreur ambiguë (5xx, timeout après envoi, réponse inattendue) ──────────────
      logger.error(
        `[PAYOUT] Erreur ambiguë NotchPay — transaction ${transactionRef} laissée en 'pending' pour audit. User: ${userId}`,
      );
      NotificationService.sendToUser(userId, {
        title: 'Retrait en cours de vérification ⚠️',
        body: `Le retrait vers ${formattedPhone} est en cours de vérification. Votre solde sera rétabli si l'opération échoue. Contactez le support si nécessaire.`,
        category: 'important',
        data: { transactionRef: transactionRef, type: 'withdrawal_pending_review' },
      }).catch((err: any) => logger.error(`Payout Ambiguous Notification Error: ${err.message}`));

      throw new AppError(`Retrait en cours de vérification. Référence : ${transactionRef}`, 500);
    } finally {
      MonitoringService.observePaymentGatewayDuration(
        'notchpay',
        'transfer',
        (Date.now() - start) / 1000,
      );
    }
  }

  /**
   * Valide et résout l'opérateur Mobile Money Camerounais à partir du préfixe officiel.
   */
  private static _resolveCameroonChannel(
    phone: string,
    requestedProvider?: string,
  ): { channel: 'cm.orange' | 'cm.mtn'; formattedPhone: string } {
    const rawDigits = phone.replace(/\D/g, '');
    const localNumber = rawDigits.startsWith('237') ? rawDigits.slice(3) : rawDigits;

    if (localNumber.length !== 9 || !localNumber.startsWith('6')) {
      throw new AppError(
        'Numéro de téléphone camerounais invalide. Il doit comporter 9 chiffres (ex: 697000000 ou 670000000).',
        400,
      );
    }

    // Plan de numérotation ART Cameroun :
    // MTN : 670-679, 680-689, 650-654
    // Orange : 690-699, 655-659
    let detectedChannel: 'cm.orange' | 'cm.mtn';
    if (/^6(7\d|8\d|5[0-4])\d{6}$/.test(localNumber)) {
      detectedChannel = 'cm.mtn';
    } else if (/^6(9\d|5[5-9])\d{6}$/.test(localNumber)) {
      detectedChannel = 'cm.orange';
    } else {
      throw new AppError('Ce numéro ne correspond à aucun opérateur Mobile Money supporté (MTN ou Orange).', 400);
    }

    const prov = requestedProvider?.toLowerCase();
    if (prov && (prov === 'mtn' || prov === 'cm.mtn') && detectedChannel !== 'cm.mtn') {
      throw new AppError(
        `Le numéro ${phone} est un numéro Orange Money (préfixe 69x/655-659). Veuillez sélectionner Orange Money ou saisir un numéro MTN.`,
        400,
      );
    }
    if (prov && (prov === 'orange' || prov === 'cm.orange') && detectedChannel !== 'cm.orange') {
      throw new AppError(
        `Le numéro ${phone} est un numéro MTN Mobile Money (préfixe 67x/68x/650-654). Veuillez sélectionner MTN ou saisir un numéro Orange.`,
        400,
      );
    }

    return {
      channel: detectedChannel,
      formattedPhone: `+237${localNumber}`,
    };
  }

  /**
   * Rembourse un retrait échoué :
   *  - Marque la transaction interne comme 'failed'
   *  - Recrédite le solde de l'utilisateur
   */
  private static async _refundTransaction(
    transactionId: string,
    userId: string,
    amount: number,
    reason: string,
  ): Promise<void> {
    try {
      // 1. Marquer la transaction comme échouée
      await Transaction.findByIdAndUpdate(transactionId, {
        status: 'failed',
        metadata: { refundReason: reason, refundedAt: new Date().toISOString() },
      });

      // 2. Recréditer le solde (dépôt interne sans passer par NotchPay)
      await WalletService.executeTransaction({
        userId,
        amount,
        type: 'deposit',
        description: `Remboursement retrait échoué – ${reason}`,
        paymentMethod: 'wallet',
        silent: true,
      });

      logger.info(`[PAYOUT] Remboursement effectué pour transaction ${transactionId} — ${amount} XAF recrédités pour user ${userId}`);
    } catch (refundError: any) {
      logger.error(
        `[PAYOUT] CRITIQUE: Échec du remboursement pour transaction ${transactionId} user ${userId}: ${refundError.message}`,
      );
    }
  }
}
