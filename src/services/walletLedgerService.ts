import mongoose from 'mongoose';
import User from '../models/User';
import Transaction from '../models/Transaction';

/**
 * Solde « théorique » du portefeuille reconstruit à partir des écritures, avec
 * EXACTEMENT les règles de WalletService.executeTransaction :
 *
 * - Crédit (income/deposit/tontine_payout/challenge_reward) payé par wallet,
 *   Stripe ou NotchPay, statut 'completed' : + amount (amount est déjà NET des frais).
 * - Débit (tout autre type) payé par le wallet : − (amount + fees), car le wallet
 *   est débité du montant brut alors que `amount` stocke le net. Les statuts
 *   'pending' (retrait en cours chez l'opérateur, déjà débité) et 'failed'
 *   (retrait échoué : le remboursement est une écriture de crédit séparée)
 *   comptent aussi.
 * - Tout le reste est ignoré : les saisies manuelles du budget (paymentMethod
 *   'cash', forcé par TransactionService) et les achats payés directement chez
 *   l'opérateur (ex. abonnement NotchPay) ne touchent jamais walletBalance.
 *
 * L'ancien contrôle additionnait toutes les transactions de l'utilisateur : chaque
 * dépense saisie à la main (loyer payé en espèces…) apparaissait comme un écart.
 */
export const WALLET_CREDIT_TYPES = ['income', 'deposit', 'tontine_payout', 'challenge_reward'];
export const WALLET_CREDIT_METHODS = ['wallet', 'stripe', 'notchpay'];
export const WALLET_DEBIT_STATUSES = ['completed', 'pending', 'failed'];

/** Tolérance d'arrondi (1 unité de devise). */
export const WALLET_TOLERANCE = 1;

export interface WalletAnomaly {
  userId: mongoose.Types.ObjectId;
  email: string;
  walletBalance: number;
  calculatedBalance: number;
  diff: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export class WalletLedgerService {
  /** Solde théorique par utilisateur (une seule agrégation pour tous les comptes). */
  static async computeLedgerBalances(
    userIds?: mongoose.Types.ObjectId[],
  ): Promise<Map<string, number>> {
    const match: Record<string, unknown> = {
      $or: [
        {
          type: { $in: WALLET_CREDIT_TYPES },
          paymentMethod: { $in: WALLET_CREDIT_METHODS },
          status: 'completed',
        },
        {
          type: { $nin: WALLET_CREDIT_TYPES },
          paymentMethod: 'wallet',
          status: { $in: WALLET_DEBIT_STATUSES },
        },
      ],
    };
    if (userIds) match.userId = { $in: userIds };

    const rows = await Transaction.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$userId',
          balance: {
            $sum: {
              $cond: [
                { $in: ['$type', WALLET_CREDIT_TYPES] },
                '$amount',
                { $multiply: [-1, { $add: ['$amount', { $ifNull: ['$fees', 0] }] }] },
              ],
            },
          },
        },
      },
    ]);
    return new Map(
      rows.map((r: { _id: unknown; balance: number }) => [String(r._id), round2(r.balance)]),
    );
  }

  /** Comptes actifs dont walletBalance ne correspond pas aux écritures du portefeuille. */
  static async findAnomalies(): Promise<{ totalChecked: number; anomalies: WalletAnomaly[] }> {
    const users = await User.find({ isActive: true }).select('email walletBalance').lean();
    const ledger = await this.computeLedgerBalances();
    const anomalies: WalletAnomaly[] = [];
    for (const user of users) {
      const walletBalance = user.walletBalance || 0;
      const calculatedBalance = ledger.get(String(user._id)) ?? 0;
      const diff = round2(Math.abs(calculatedBalance - walletBalance));
      if (diff > WALLET_TOLERANCE) {
        anomalies.push({
          userId: user._id as mongoose.Types.ObjectId,
          email: user.email,
          walletBalance,
          calculatedBalance,
          diff,
        });
      }
    }
    return { totalChecked: users.length, anomalies };
  }
}
