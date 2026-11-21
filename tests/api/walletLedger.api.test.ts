/**
 * Contrôle quotidien des portefeuilles (nov. 2026) : l'ancien calcul additionnait
 * TOUTES les transactions, y compris les dépenses saisies à la main (espèces), et
 * signalait 59 « anomalies » en prod alors qu'aucun argent n'avait bougé.
 * Le contrôle doit suivre exactement les règles de WalletService.executeTransaction.
 */
import { useTestDB } from '../helpers/db';
import { createUser } from '../helpers/factories';
import Transaction from '../../src/models/Transaction';
import User from '../../src/models/User';
import { WalletService } from '../../src/services/walletService';
import { WalletLedgerService } from '../../src/services/walletLedgerService';
import { ReportService } from '../../src/services/reportService';
import { TransactionService } from '../../src/services/transactionService';

const balanceOf = async (id: unknown) => (await User.findById(id).lean())!.walletBalance;

describe('WalletLedgerService — réconciliation des portefeuilles', () => {
  useTestDB();

  it('ignore les dépenses et revenus saisis à la main (espèces)', async () => {
    const u = await createUser({ walletBalance: 0 });
    await Transaction.create([
      { userId: u._id, amount: 435000, type: 'expense', category: 'Logement', description: 'Loyer', paymentMethod: 'cash' },
      { userId: u._id, amount: 20000, type: 'income', category: 'Salaire', description: 'Prime', paymentMethod: 'cash' },
    ]);
    const { anomalies } = await WalletLedgerService.findAnomalies();
    expect(anomalies).toHaveLength(0);
  });

  it('ignore un achat payé directement chez l’opérateur (abonnement NotchPay)', async () => {
    const u = await createUser({ walletBalance: 0 });
    await Transaction.create({
      userId: u._id, amount: 2000, type: 'expense', category: 'subscription',
      description: 'Abonnement Kauri Premium', paymentMethod: 'notchpay', status: 'completed',
    });
    expect((await WalletLedgerService.findAnomalies()).anomalies).toHaveLength(0);
  });

  it('reste cohérent après de vrais mouvements : dépôt, retrait avec frais, retrait échoué remboursé, cotisation', async () => {
    const u = await createUser({ walletBalance: 0 });
    const id = u._id.toString();
    await WalletService.executeTransaction({ userId: id, amount: 40000, type: 'deposit', description: 'Dépôt', paymentMethod: 'notchpay', fees: 500 });
    await WalletService.executeTransaction({ userId: id, amount: 10300, type: 'withdrawal', description: 'Retrait', paymentMethod: 'wallet', fees: 300 });
    // Retrait en cours chez l'opérateur : déjà débité, statut 'pending'
    const pending = await WalletService.executeTransaction({ userId: id, amount: 5100, type: 'withdrawal', description: 'Retrait 2', paymentMethod: 'wallet', fees: 100 });
    await Transaction.findByIdAndUpdate(pending._id, { status: 'pending' });
    // Retrait échoué : marqué 'failed' puis remboursé par une écriture de crédit séparée
    const failed = await WalletService.executeTransaction({ userId: id, amount: 3100, type: 'withdrawal', description: 'Retrait 3', paymentMethod: 'wallet', fees: 100 });
    await Transaction.findByIdAndUpdate(failed._id, { status: 'failed' });
    await WalletService.executeTransaction({ userId: id, amount: 3100, type: 'deposit', description: 'Remboursement', paymentMethod: 'wallet' });
    await WalletService.executeTransaction({ userId: id, amount: 2000, type: 'tontine_contribution', description: 'Cotisation', paymentMethod: 'wallet' });
    // Une dépense saisie à la main en plus ne change rien
    await TransactionService.createTransaction(id, { amount: 7000, type: 'expense', category: 'Transport', description: 'Taxi' });

    expect(await balanceOf(u._id)).toBe(40000 - 500 - 10300 - 5100 - 3100 + 3100 - 2000);
    const ledger = await WalletLedgerService.computeLedgerBalances([u._id]);
    expect(ledger.get(id)).toBe(await balanceOf(u._id));
    expect((await WalletLedgerService.findAnomalies()).anomalies).toHaveLength(0);
  });

  it('signale un vrai écart (solde modifié sans écriture) et un solde négatif sans mouvement', async () => {
    const touched = await createUser({ walletBalance: 0 });
    await WalletService.executeTransaction({ userId: touched._id.toString(), amount: 10000, type: 'deposit', description: 'Dépôt', paymentMethod: 'stripe' });
    await User.updateOne({ _id: touched._id }, { $inc: { walletBalance: 5000 } });
    const legacy = await createUser({ walletBalance: 0 });
    await User.updateOne({ _id: legacy._id }, { $set: { walletBalance: -3000 } });

    const anomalies = await ReportService.checkFinancialIntegrity();
    const byId = new Map(anomalies.map((a) => [String(a.userId), a]));
    expect(anomalies).toHaveLength(2);
    expect(byId.get(String(touched._id))).toMatchObject({ walletBalance: 15000, calculatedBalance: 10000, diff: 5000 });
    expect(byId.get(String(legacy._id))).toMatchObject({ walletBalance: -3000, calculatedBalance: 0, diff: 3000 });
  });
});
