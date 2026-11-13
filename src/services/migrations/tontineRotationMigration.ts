import Tontine from '../../models/Tontine';
import TontineMember from '../../models/TontineMember';
import TontineContribution from '../../models/TontineContribution';
import Transaction from '../../models/Transaction';
import { WalletService } from '../walletService';
import logger from '../../utils/logger';

/**
 * One-time repair of tontines started BEFORE rotation slots were assigned per
 * part (see TontineService.startTontine):
 *
 *  - a member holding N parts had a single turn: they get N-1 more, appended
 *    after the turns already assigned (assigned turns never move — some were
 *    already paid out);
 *  - parts never taken produced turns with no winner, during which auto-debits
 *    kept collecting: every wallet-backed contribution of a PAST turn with no
 *    winner is refunded to its payer (deterministic reference → at most once);
 *  - the cycle length becomes the number of parts actually held; a tontine
 *    whose current turn is already past that length is completed.
 *
 * Idempotent: a tontine whose members already carry `rotationOrders` covering
 * all their parts, and whose length matches, is left untouched.
 */
export interface TontineRepair {
  tontineId: string;
  addedTurns: Record<string, number[]>;
  oldTotalParts: number;
  newTotalParts: number;
  refunded: { userId: string; amount: number; turn: number }[];
  completed: boolean;
}

const turnsOf = (m: any): number[] =>
  Array.isArray(m.rotationOrders) && m.rotationOrders.length
    ? [...m.rotationOrders]
    : m.rotationOrder != null
      ? [m.rotationOrder]
      : [];

const walletBacked = (c: any) => c.source === 'wallet' || (!c.source && !c.proofImage);

export async function repairTontineRotations(opts: { apply: boolean }): Promise<TontineRepair[]> {
  const repairs: TontineRepair[] = [];
  const tontines = await Tontine.find({ status: 'active' });

  for (const tontine of tontines) {
    const members = await TontineMember.find({
      tontineId: tontine._id,
      invitationStatus: 'accepted',
    }).sort({ rotationOrder: 1, joinedAt: 1 });

    const turns = new Map(members.map((m) => [String(m._id), turnsOf(m)]));
    let next = Math.max(0, ...[...turns.values()].flat(), tontine.currentTurn - 1) + 1;
    const addedTurns: Record<string, number[]> = {};
    for (const m of members) {
      const mine = turns.get(String(m._id))!;
      while (mine.length < (m.parts || 1)) {
        mine.push(next);
        (addedTurns[String(m._id)] ||= []).push(next);
        next++;
      }
    }
    const assigned = new Set([...turns.values()].flat());
    const newTotal = Math.max(0, ...assigned);
    const needsSchema = members.some(
      (m: any) => !Array.isArray(m.rotationOrders) || !m.rotationOrders.length,
    );

    // Wallet money collected on past turns that never had a winner.
    const refunds: TontineRepair['refunded'] = [];
    const orphanContribs: { c: any; member: any; turn: number }[] = [];
    for (let turn = 1; turn < tontine.currentTurn; turn++) {
      if (assigned.has(turn)) continue;
      const contribs = await TontineContribution.find({
        tontineId: tontine._id,
        turnIndex: turn,
        validationStatus: { $in: ['completed', 'ai_validated'] },
      });
      for (const c of contribs.filter(walletBacked)) {
        const member = members.find((m) => String(m._id) === String(c.memberId));
        if (!member) continue;
        // Already refunded by a previous run: neither redone nor reported.
        if (await Transaction.exists({ reference: `TONTINE-ORPHAN-REFUND-${c._id}` })) continue;
        orphanContribs.push({ c, member, turn });
        refunds.push({ userId: String(member.userId), amount: c.amountPaid, turn });
      }
    }

    const completed = tontine.currentTurn > newTotal;
    const changed =
      needsSchema ||
      Object.keys(addedTurns).length > 0 ||
      newTotal !== tontine.totalParts ||
      refunds.length > 0;
    if (!changed) continue;

    repairs.push({
      tontineId: String(tontine._id),
      addedTurns,
      oldTotalParts: tontine.totalParts,
      newTotalParts: newTotal,
      refunded: refunds,
      completed,
    });
    if (!opts.apply) continue;

    const txs = await WalletService.runInTransaction(async (session) => {
      for (const m of members) {
        const mine = turns.get(String(m._id))!;
        await TontineMember.updateOne(
          { _id: m._id },
          { $set: { rotationOrders: mine, rotationOrder: mine[0] } },
          { session },
        );
      }
      const created: any[] = [];
      for (const { c, member, turn } of orphanContribs) {
        const reference = `TONTINE-ORPHAN-REFUND-${c._id}`;
        if (await Transaction.exists({ reference }).session(session)) continue;
        created.push(
          await WalletService.executeTransaction(
            {
              userId: String(member.userId),
              amount: c.amountPaid,
              type: 'deposit',
              description: `Remboursement cotisation : ${tontine.name} (tour ${turn} sans bénéficiaire)`,
              paymentMethod: 'wallet',
              reference,
              metadata: { tontineId: String(tontine._id), turn, source: 'rotation-migration' },
            },
            { session },
          ),
        );
      }
      await Tontine.updateOne(
        { _id: tontine._id },
        { $set: { totalParts: newTotal, ...(completed ? { status: 'completed' } : {}) } },
        { session },
      );
      return created;
    });
    for (const tx of txs) {
      (tx as any)._postCommit?.().catch((err: any) => logger.error(`Post-commit: ${err.message}`));
    }
  }

  return repairs;
}
