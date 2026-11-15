import UserChallenge from '../../models/UserChallenge';
import Transaction from '../../models/Transaction';
import { WalletService } from '../walletService';
import logger from '../../utils/logger';

/**
 * Before the unique partial index { userId, challengeId } (status 'active'),
 * concurrent joins could create several ACTIVE participations of the same
 * challenge — each possibly holding saved money. The index cannot build while
 * such duplicates exist.
 *
 * For each duplicate group, the most advanced participation is kept (highest
 * progress, then highest saved value, then oldest). Every other one is refunded
 * IN FULL (no penalty: the duplicate came from a bug) and marked 'abandoned'.
 * Idempotent: deterministic refund reference + the group disappears once fixed.
 */
export async function dedupeActiveChallenges(opts: { apply: boolean }) {
  const groups = await UserChallenge.aggregate([
    { $match: { status: 'active' } },
    {
      $group: {
        _id: { userId: '$userId', challengeId: '$challengeId' },
        ids: { $push: '$_id' },
        n: { $sum: 1 },
      },
    },
    { $match: { n: { $gt: 1 } } },
  ]);

  const report: { userId: string; kept: string; abandoned: string[]; refunded: number }[] = [];
  for (const g of groups) {
    const docs = await UserChallenge.find({ _id: { $in: g.ids } });
    docs.sort(
      (a: any, b: any) =>
        b.progress - a.progress ||
        b.currentValue - a.currentValue ||
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    const [keep, ...extra] = docs;
    const entry = {
      userId: String(g._id.userId),
      kept: String(keep._id),
      abandoned: extra.map((d) => String(d._id)),
      refunded: extra.reduce((s, d: any) => s + (d.currentValue || 0), 0),
    };
    report.push(entry);
    if (!opts.apply) continue;

    for (const d of extra) {
      const tx = await WalletService.runInTransaction(async (session) => {
        const claimed = await UserChallenge.findOneAndUpdate(
          { _id: d._id, status: 'active' },
          { $set: { status: 'abandoned', currentValue: 0 } },
          { new: false, session },
        );
        if (!claimed || !(claimed.currentValue > 0)) return null;
        const reference = `CHALLENGE-DEDUPE-REFUND-${d._id}`;
        if (await Transaction.exists({ reference }).session(session)) return null;
        return WalletService.executeTransaction(
          {
            userId: String(claimed.userId),
            amount: claimed.currentValue,
            type: 'deposit',
            description: 'Remboursement : participation en double à un défi',
            paymentMethod: 'wallet',
            reference,
            metadata: { userChallengeId: String(d._id), source: 'dedupe-migration' },
          },
          { session },
        );
      });
      (tx as any)?._postCommit?.().catch((err: any) => logger.error(`Post-commit: ${err.message}`));
    }
  }

  if (opts.apply) await UserChallenge.syncIndexes();
  return report;
}
