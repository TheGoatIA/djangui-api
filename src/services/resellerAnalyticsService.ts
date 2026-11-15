import mongoose from 'mongoose';
import SharedMasterAccount from '../models/SharedMasterAccount';
import SharedSlot from '../models/SharedSlot';
import SlotPaymentHistory from '../models/SlotPaymentHistory';

export class ResellerAnalyticsService {
  /**
   * Get reseller executive dashboard statistics. `resellerId: null` = platform-wide
   * figures across every reseller (admin dashboard supervision mode).
   */
  static async getResellerDashboardStats(resellerId: string | null) {
    const scope = resellerId ? { resellerId: new mongoose.Types.ObjectId(resellerId) } : {};

    const [accounts, slots, payments] = await Promise.all([
      SharedMasterAccount.find(scope),
      SharedSlot.find(scope),
      SlotPaymentHistory.find(scope).sort({ paidAt: -1 }).limit(10),
    ]);

    const totalAccounts = accounts.length;
    const totalSlotsCapacity = accounts.reduce((sum, acc) => sum + acc.maxSlots, 0);
    const occupiedSlots = slots.filter((s) => s.status !== 'vacant').length;
    const vacantSlots = Math.max(0, totalSlotsCapacity - occupiedSlots);
    const occupancyRate =
      totalSlotsCapacity > 0 ? Math.round((occupiedSlots / totalSlotsCapacity) * 100) : 0;

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
   * Export accounting report as CSV string. `resellerId: null` = every
   * reseller's payment history (admin accounting export).
   */
  static async exportAccountingCsv(resellerId: string | null): Promise<string> {
    const scope = resellerId ? { resellerId } : {};
    const payments = await SlotPaymentHistory.find(scope)
      .populate('masterAccountId', 'serviceName')
      .populate('slotId', 'profileName client.fullName client.phone')
      .populate(resellerId ? [] : [{ path: 'resellerId', select: 'firstName lastName email' }])
      .sort({ paidAt: -1 });

    const headers = [
      ...(resellerId ? [] : ['Revendeur']),
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

    // Every free-text cell is quoted with inner quotes doubled (RFC 4180) and
    // neutralised against spreadsheet formula injection (=, +, -, @, tab, CR):
    // a client named  =HYPERLINK(...)  or containing a quote broke the file /
    // ran a formula in the reseller's Excel.
    const cell = (v: unknown) => {
      let t = v === undefined || v === null ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
      return `"${t.replace(/"/g, '""')}"`;
    };

    const rows = payments.map((p: any) => {
      const resellerLabel = resellerId
        ? null
        : `${p.resellerId?.firstName || ''} ${p.resellerId?.lastName || ''}`.trim() ||
          p.resellerId?.email ||
          'N/A';

      return [
        ...(resellerLabel === null ? [] : [cell(resellerLabel)]),
        new Date(p.paidAt).toISOString().split('T')[0],
        cell(p.masterAccountId?.serviceName || 'N/A'),
        cell(p.slotId?.profileName || 'N/A'),
        cell(p.slotId?.client?.fullName || 'N/A'),
        cell(p.slotId?.client?.phone || 'N/A'),
        p.amount,
        p.currency,
        new Date(p.periodCoveredStart).toISOString().split('T')[0],
        new Date(p.periodCoveredEnd).toISOString().split('T')[0],
        cell(p.paymentMethod),
        cell(p.notes || ''),
      ];
    });

    return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  }
}
