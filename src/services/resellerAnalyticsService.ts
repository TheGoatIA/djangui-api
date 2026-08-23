import mongoose from 'mongoose';
import SharedMasterAccount from '../models/SharedMasterAccount';
import SharedSlot from '../models/SharedSlot';
import SlotPaymentHistory from '../models/SlotPaymentHistory';

export class ResellerAnalyticsService {
  /**
   * Get reseller executive dashboard statistics
   */
  static async getResellerDashboardStats(resellerId: string) {
    const resellerObjectId = new mongoose.Types.ObjectId(resellerId);

    const [accounts, slots, payments] = await Promise.all([
      SharedMasterAccount.find({ resellerId: resellerObjectId }),
      SharedSlot.find({ resellerId: resellerObjectId }),
      SlotPaymentHistory.find({ resellerId: resellerObjectId }).sort({ paidAt: -1 }).limit(10),
    ]);

    const totalAccounts = accounts.length;
    const totalSlotsCapacity = accounts.reduce((sum, acc) => sum + acc.maxSlots, 0);
    const occupiedSlots = slots.filter((s) => s.status !== 'vacant').length;
    const vacantSlots = Math.max(0, totalSlotsCapacity - occupiedSlots);
    const occupancyRate = totalSlotsCapacity > 0 ? Math.round((occupiedSlots / totalSlotsCapacity) * 100) : 0;

    // Monthly Recurring Revenue (MRR)
    const mrr = slots.reduce((sum, s) => sum + (s.status !== 'vacant' ? s.price : 0), 0);

    // Total Master Accounts Cost
    const totalMasterCost = accounts.reduce((sum, acc) => sum + acc.billingCost, 0);

    // Net Monthly Profit
    const netProfit = mrr - totalMasterCost;
    const netMarginPercentage = mrr > 0 ? Math.round((netProfit / mrr) * 100) : 0;

    // Status breakdown
    const statusCounts = {
      active: slots.filter((s) => s.status === 'active').length,
      due_soon: slots.filter((s) => s.status === 'due_soon').length,
      overdue: slots.filter((s) => s.status === 'overdue').length,
      blocked: slots.filter((s) => s.status === 'blocked').length,
    };

    return {
      totalAccounts,
      totalSlotsCapacity,
      occupiedSlots,
      vacantSlots,
      occupancyRate,
      financials: {
        mrr,
        totalMasterCost,
        netProfit,
        netMarginPercentage,
        currency: accounts[0]?.billingCurrency || 'XAF',
      },
      statusCounts,
      recentPayments: payments,
    };
  }

  /**
   * Export accounting report as CSV string
   */
  static async exportAccountingCsv(resellerId: string): Promise<string> {
    const payments = await SlotPaymentHistory.find({ resellerId })
      .populate('masterAccountId', 'serviceName')
      .populate('slotId', 'profileName client.fullName client.phone')
      .sort({ paidAt: -1 });

    const headers = [
      'Date de Paiement',
      'Service',
      'Profil/Slot',
      'Client',
      'Telephone',
      'Montant',
      'Devise',
      'Periode Debut',
      'Periode Fin',
      'Methode',
      'Notes',
    ];

    const rows = payments.map((p: any) => [
      new Date(p.paidAt).toISOString().split('T')[0],
      `"${p.masterAccountId?.serviceName || 'N/A'}"`,
      `"${p.slotId?.profileName || 'N/A'}"`,
      `"${p.slotId?.client?.fullName || 'N/A'}"`,
      `"${p.slotId?.client?.phone || 'N/A'}"`,
      p.amount,
      p.currency,
      new Date(p.periodCoveredStart).toISOString().split('T')[0],
      new Date(p.periodCoveredEnd).toISOString().split('T')[0],
      p.paymentMethod,
      `"${p.notes || ''}"`,
    ]);

    return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  }
}
