jest.mock('../../src/models/Payment', () => ({
  __esModule: true,
  default: { find: jest.fn(), updateOne: jest.fn() },
}));
jest.mock('../../src/services/paymentService', () => ({
  PaymentService: { verifyTransaction: jest.fn() },
}));

import Payment from '../../src/models/Payment';
import { PaymentService } from '../../src/services/paymentService';
import { PaymentPollingService } from '../../src/services/paymentPollingService';

const now = new Date('2026-10-14T12:00:00Z');
const mkPayment = (over: any = {}) => ({
  _id: 'id-' + Math.random(),
  reference: 'REF-' + Math.random(),
  createdAt: new Date(now.getTime() - 60_000),
  metadata: {},
  ...over,
});
const queue = (docs: any[]) => {
  const chain: any = { sort: () => chain, limit: () => Promise.resolve(docs) };
  (Payment.find as jest.Mock).mockReturnValue(chain);
};

describe('PaymentPollingService (confirmation sans webhook)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (Payment.updateOne as jest.Mock).mockResolvedValue({ modifiedCount: 1 });
  });

  it('finalise un paiement confirmé par le fournisseur', async () => {
    queue([mkPayment({ reference: 'A' })]);
    (PaymentService.verifyTransaction as jest.Mock).mockResolvedValue({ status: 'completed' });
    const r = await PaymentPollingService.pollPendingPayments(now);
    expect(PaymentService.verifyTransaction).toHaveBeenCalledWith('A');
    expect(r.completed).toBe(1);
  });

  it('marque échoué un paiement expiré/échoué côté fournisseur', async () => {
    queue([mkPayment({ reference: 'B' })]);
    (PaymentService.verifyTransaction as jest.Mock).mockResolvedValue({ status: 'expired' });
    const r = await PaymentPollingService.pollPendingPayments(now);
    expect(r.markedFailed).toBe(1);
    expect((Payment.updateOne as jest.Mock).mock.calls[0][1].$set.status).toBe('failed');
  });

  it("n'interroge pas un ancien paiement vérifié il y a moins de 10 min", async () => {
    queue([
      mkPayment({
        createdAt: new Date(now.getTime() - 3 * 3600_000),
        metadata: { lastPolledAt: new Date(now.getTime() - 60_000).toISOString() },
      }),
    ]);
    const r = await PaymentPollingService.pollPendingPayments(now);
    expect(PaymentService.verifyTransaction).not.toHaveBeenCalled();
    expect(r.checked).toBe(0);
  });

  it("une erreur fournisseur n'interrompt pas le lot", async () => {
    queue([mkPayment({ reference: 'C' }), mkPayment({ reference: 'D' })]);
    (PaymentService.verifyTransaction as jest.Mock)
      .mockRejectedValueOnce(new Error('502'))
      .mockResolvedValueOnce({ status: 'completed' });
    const r = await PaymentPollingService.pollPendingPayments(now);
    expect(r.errors).toBe(1);
    expect(r.completed).toBe(1);
  });
});
