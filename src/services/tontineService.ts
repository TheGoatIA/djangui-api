import mongoose from 'mongoose';
import crypto from 'crypto';
import Tontine, { ITontine } from '../models/Tontine';
import TontineMember from '../models/TontineMember';
import TontineContribution from '../models/TontineContribution';
import TontineMessage from '../models/TontineMessage';
import TontineVote from '../models/TontineVote';
import User from '../models/User';
import Transaction from '../models/Transaction';
import { AppError } from '../middleware/errorHandler';
import { Parser } from 'json2csv';
import { CurrencyService } from './currencyService';
import { NotificationService } from './notificationService';
import { SlackService } from './slackService';
import { WalletService } from './walletService';
import { InvoiceService } from './invoiceService';
import logger from '../utils/logger';
import { isSubscriptionEntitled } from '../utils/subscription';
import {
  createTontineSchema,
  updateTontineSchema,
  joinTontineSchema,
  createVoteSchema,
  castVoteSchema,
  MESSAGE_MAX_LENGTH,
  CLOSURE_OPTIONS,
  pickSocialFund,
  wholeAmountError,
} from '../validators/tontineValidator';

const validateOrThrow = <T>(schema: { validate: (v: any, o: any) => any }, value: any): T => {
  const { error, value: clean } = schema.validate(value ?? {}, {
    abortEarly: false,
    stripUnknown: true,
  });
  if (error) throw new AppError(error.details.map((d: any) => d.message).join(', '), 400);
  return clean as T;
};

/** Every turn a member receives the pot (`rotationOrders`, legacy `rotationOrder`). */
const turnsOf = (m: any): number[] =>
  Array.isArray(m.rotationOrders) && m.rotationOrders.length
    ? m.rotationOrders
    : m.rotationOrder != null
      ? [m.rotationOrder]
      : [];

/**
 * A contribution backed by money Kauri actually holds (debited from a wallet).
 * Legacy rows have no `source`: auto-debits never carried a receipt image.
 */
const isWalletBacked = (c: any) => c.source === 'wallet' || (!c.source && !c.proofImage);

/** Neutralises spreadsheet formula injection in exported cells (=, +, -, @, tab, CR). */
const csvSafe = (v: unknown) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

export class TontineService {
  /**
   * Receipts and voice notes are private objects: every response that exposes
   * them carries a short-lived signed URL instead of the stored object URL.
   */
  static async withSignedUrls<T>(docs: T[], field: 'proofImage' | 'audioUrl'): Promise<any[]> {
    const { StorageService } = await import('./storageService');
    return Promise.all(
      docs.map(async (d: any) => {
        const o = typeof d?.toObject === 'function' ? d.toObject() : { ...d };
        if (o[field]) o[field] = await StorageService.signStoredUrl(o[field]);
        return o;
      }),
    );
  }

  /**
   * Guard used by every read/write endpoint that exposes tontine-internal data
   * (messages, member list, votes, details, ...): only an accepted member of the
   * tontine (which includes its creator) may access it. Throws 404 if the tontine
   * doesn't exist and 403 if the requester isn't a member, mirroring the ownership
   * checks already used on update/delete/removeMember.
   */
  static async assertIsMember(tontineId: string, userId: string): Promise<ITontine> {
    const tontine = await Tontine.findById(tontineId);
    if (!tontine) throw new AppError('Tontine non trouvée', 404);

    const isMember = await TontineMember.exists({
      tontineId,
      userId,
      invitationStatus: 'accepted',
    });
    if (!isMember) throw new AppError("Vous n'êtes pas membre de cette tontine", 403);

    return tontine;
  }
  /**
   * Créer une nouvelle tontine
   */
  static async createTontine(userId: string, rawData: any): Promise<ITontine> {
    // Whitelist + validation: the raw body used to be spread into the document.
    const data = validateOrThrow<any>(createTontineSchema, rawData);
    if (data.socialFund) data.socialFund = pickSocialFund(data.socialFund);
    const amountError = wholeAmountError(data);
    if (amountError) throw new AppError(amountError, 400);

    // withTransaction (auto-retry) + a write on the creator's document: a plain
    // count-then-insert inside a transaction does NOT serialise concurrent
    // requests in MongoDB (no predicate locks) — two parallel creates both saw
    // "0 active" and both succeeded. Writing the same User document forces a
    // write conflict: the loser is retried, re-counts, and is refused.
    return WalletService.runInTransaction(async (session) => {
      const user = await User.findOneAndUpdate(
        { _id: userId },
        { $set: { updatedAt: new Date() } },
        { session, new: true, timestamps: false },
      );
      if (!user) throw new AppError('Utilisateur non trouvé', 404);

      const activeCount = await Tontine.countDocuments({
        creatorId: userId,
        status: { $ne: 'completed' },
      }).session(session);
      // Every entitled paid plan (business included); an expired premium is free.
      const isPremium = isSubscriptionEntitled(user.subscription as any);

      if (!isPremium && activeCount >= 1) {
        throw new AppError(
          'Les utilisateurs non-premium sont limités à une seule tontine active.',
          403,
        );
      }

      const tontine = (
        await Tontine.create([{ ...data, creatorId: userId, status: 'pending' }], { session })
      )[0];

      await TontineMember.create(
        [
          {
            tontineId: tontine._id,
            userId: userId,
            displayName: `${user.firstName} (Créateur)`,
            parts: 1,
            invitationStatus: 'accepted',
            joinedAt: new Date(),
          },
        ],
        { session },
      );

      return tontine;
    });
  }

  /**
   * Rejoindre une tontine
   */
  static async joinTontine(userId: string, inviteCode: string, rawData: any): Promise<any> {
    const data = validateOrThrow<{ displayName: string; parts: number }>(joinTontineSchema, {
      inviteCode,
      ...rawData,
    });

    // withTransaction + a write on the TONTINE document: same reason as
    // createTontine — the count-then-insert alone let 5 simultaneous joins all
    // pass for 2 remaining parts. Concurrent joins now conflict on the tontine
    // document; the loser is retried and sees the parts already taken.
    const member = await WalletService.runInTransaction(async (session) => {
      const tontine = await Tontine.findOneAndUpdate(
        { inviteCode },
        { $set: { updatedAt: new Date() } },
        { session, new: true, timestamps: false },
      );
      if (!tontine) throw new AppError('Tontine non trouvée', 404);
      if (tontine.status !== 'pending') throw new AppError('Les adhésions sont fermées', 400);

      const user = await User.findById(userId).session(session);
      if (!user) throw new AppError('Utilisateur non trouvé', 404);

      if (!isSubscriptionEntitled(user.subscription as any)) {
        const memberships = await TontineMember.find({
          userId,
          invitationStatus: 'accepted',
        }).session(session);
        const activeCount = await Tontine.countDocuments({
          _id: { $in: memberships.map((m) => m.tontineId) },
          status: { $ne: 'completed' },
        }).session(session);
        if (activeCount >= 3)
          throw new AppError('Limite de 3 tontines actives pour les utilisateurs gratuits.', 403);
      }

      const requestedParts = data.parts;
      const existingMembers = await TontineMember.find({
        tontineId: tontine._id,
        invitationStatus: 'accepted',
      }).session(session);
      if (existingMembers.some((m) => m.userId.toString() === String(userId))) {
        throw new AppError('Vous êtes déjà membre de cette tontine.', 400);
      }
      const takenParts = existingMembers.reduce((sum, m) => sum + (m.parts || 1), 0);
      if (takenParts + requestedParts > tontine.totalParts) {
        throw new AppError(
          `Places insuffisantes : il ne reste que ${Math.max(
            0,
            tontine.totalParts - takenParts,
          )} part(s) disponible(s) sur ${tontine.totalParts}.`,
          400,
        );
      }

      const [created] = await TontineMember.create(
        [
          {
            tontineId: tontine._id,
            userId: userId,
            displayName: data.displayName,
            parts: requestedParts,
            invitationStatus: 'accepted',
            joinedAt: new Date(),
          },
        ],
        { session },
      );
      return { created, tontine };
    });

    NotificationService.sendToUser(member.tontine.creatorId.toString(), {
      title: '',
      body: '',
      translationKey: 'TONTINE_JOIN',
      translationData: { name: data.displayName, tontineName: member.tontine.name },
      category: 'important',
    }).catch((err) => logger.error(`Tontine join notification error: ${err.message}`));

    return member.created;
  }

  static async updateTontine(tontineId: string, userId: string, rawData: any): Promise<ITontine> {
    const tontine = await Tontine.findById(tontineId);
    if (!tontine) throw new AppError('Tontine non trouvée', 404);
    if (tontine.creatorId.toString() !== userId) throw new AppError('Action non autorisée', 403);

    // Sécurité Fintech (F03) : currentTurn, status, creatorId, etc. sont immuables via update client
    const ALWAYS_FORBIDDEN = ['currentTurn', 'status', 'creatorId', 'inviteCode', 'rotationMode'];
    if (Object.keys(rawData || {}).some((f) => ALWAYS_FORBIDDEN.includes(f))) {
      throw new AppError('Ce champ ne peut pas être modifié directement', 400);
    }

    const data = validateOrThrow<any>(updateTontineSchema, rawData);
    if (data.socialFund) data.socialFund = pickSocialFund(data.socialFund);

    if (tontine.status !== 'pending') {
      // The mobile app re-sends EVERY field on edit: refusing the mere presence
      // of a key made it impossible to even rename an active tontine. Only an
      // actual CHANGE of a money-defining field is refused once the cycle runs.
      const current: any = tontine.toObject();
      const same = (k: string) => {
        if (k === 'socialFund') {
          return (
            Boolean(current.socialFund?.enabled) === data.socialFund.enabled &&
            Number(current.socialFund?.amount || 0) === data.socialFund.amount
          );
        }
        if (k === 'startDate') return true; // ignored once started (set by startTontine)
        return String(current[k]) === String(data[k]);
      };
      const frozen = ['contributionAmount', 'currency', 'totalParts', 'frequency', 'socialFund'];
      if (frozen.some((k) => data[k] !== undefined && !same(k))) {
        throw new AppError('Modification interdite une fois lancée', 400);
      }
      delete data.startDate;
    }

    for (const key of Object.keys(data)) {
      if (key === 'socialFund') {
        // Never client-settable: totalCollected is the sum of real wallet debits.
        tontine.socialFund = {
          ...data.socialFund,
          totalCollected: tontine.socialFund?.totalCollected || 0,
        } as any;
      } else if (key === 'sanctions') {
        tontine.sanctions = { ...(tontine.sanctions as any), ...data.sanctions };
      } else {
        (tontine as any)[key] = data[key];
      }
    }

    const amountError = wholeAmountError(tontine);
    if (amountError) throw new AppError(amountError, 400);

    await tontine.save();
    return tontine;
  }

  static async deleteTontine(tontineId: string, userId: string): Promise<void> {
    const tontine = await Tontine.findById(tontineId);
    if (!tontine || tontine.creatorId.toString() !== userId)
      throw new AppError('Non autorisé', 403);

    if (tontine.status === 'pending') {
      // Members may already have paid the social fund (it is required BEFORE
      // the start): deleting the tontine used to make that money vanish.
      // Refunds and deletion commit together.
      const refunds = await WalletService.runInTransaction(async (session) => {
        const t = await Tontine.findById(tontineId).session(session);
        if (!t) return [];
        const payers = await TontineMember.find({ tontineId, hasPaidSocialFund: true }).session(
          session,
        );
        const txs: any[] = [];
        for (const m of payers) {
          const paid = await Transaction.findOne({
            userId: m.userId,
            category: 'tontine_social_fund',
            'metadata.tontineId': String(tontineId),
            status: 'completed',
          }).session(session);
          const amount = paid?.amount ?? Math.ceil(t.socialFund?.amount || 0);
          if (amount > 0) {
            txs.push(
              await WalletService.executeTransaction(
                {
                  userId: m.userId.toString(),
                  amount,
                  type: 'deposit',
                  description: `Remboursement fonds social : ${t.name} (tontine supprimée)`,
                  paymentMethod: 'wallet',
                  reference: `TONTINE-SF-REFUND-${tontineId}-${m.userId}`,
                  metadata: { tontineId: String(tontineId) },
                },
                { session },
              ),
            );
          }
        }
        await TontineMember.deleteMany({ tontineId }, { session });
        await Tontine.deleteOne({ _id: tontineId }, { session });
        return txs;
      });
      for (const tx of refunds) {
        (tx as any)
          ._postCommit?.()
          .catch((err: any) => logger.error(`Post-commit: ${err.message}`));
      }
    } else if (tontine.status !== 'completed') {
      // A creator closing a running cycle alone is the classic tontine scam:
      // collect your own pot early, then stop before the others are paid.
      // Closure now requires a majority vote of the members (kind: 'closure')
      // or an admin (POST /tontines/admin/:id/close).
      throw new AppError(
        'Une tontine en cours ne peut pas être clôturée par le seul créateur : lancez un vote de clôture auprès des membres, ou contactez le support.',
        400,
      );
    }
  }

  static async removeMember(tontineId: string, creatorId: string, memberId: string): Promise<void> {
    const tontine = await Tontine.findById(tontineId);
    if (!tontine || tontine.creatorId.toString() !== creatorId)
      throw new AppError('Non autorisé', 403);
    // Scoped to THIS tontine: findById(memberId) let the creator of any tontine
    // delete a member of any other tontine (IDOR).
    const member = await TontineMember.findOne({ _id: memberId, tontineId });
    if (!member) throw new AppError('Membre non trouvé', 404);
    if (member.userId.toString() === creatorId)
      throw new AppError("Le créateur ne peut s'auto-retirer", 400);

    // Once the tontine is active every accepted member owns rotation turns:
    // removing one would leave those turns without a winner and strand the
    // collected funds. Membership is locked for anyone already in the rotation.
    if (tontine.status === 'active' && turnsOf(member).length > 0) {
      throw new AppError(
        'Ce membre ne peut pas être retiré : la tontine est active et son tour de versement est déjà planifié. Attendez la fin du cycle, ou contactez le support pour un remboursement manuel.',
        400,
      );
    }
    if (member.hasPaidSocialFund) {
      throw new AppError(
        'Ce membre a déjà payé le fonds social : supprimez la tontine (remboursement automatique) ou contactez le support.',
        400,
      );
    }

    await TontineMember.deleteOne({ _id: member._id });
  }

  static async toggleAutoDebit(
    tontineId: string,
    memberId: string,
    userId: string,
    enabled: boolean,
  ): Promise<any> {
    const tontine = await Tontine.findById(tontineId);
    if (!tontine) throw new AppError('Tontine non trouvée', 404);

    const member = await TontineMember.findOne({ _id: memberId, tontineId });
    if (!member) throw new AppError('Membre non trouvé dans cette tontine', 404);

    // Seul l'utilisateur lui-même ou le créateur peut modifier ce paramètre
    if (member.userId.toString() !== userId && tontine.creatorId.toString() !== userId) {
      throw new AppError('Non autorisé', 403);
    }

    member.isAutoDebitEnabled = enabled;
    await member.save();
    return member;
  }

  static getTurnDeadline(startDate: Date, frequency: string, turnIndex: number): Date {
    const deadline = new Date(startDate);
    const days = frequency === 'weekly' ? 7 : frequency === 'bi-weekly' ? 14 : 30;
    deadline.setDate(deadline.getDate() + (turnIndex - 1) * days);
    return deadline;
  }

  static async getMemberContributionAmount(tontineId: string, userId: string) {
    const tontine = await Tontine.findById(tontineId);
    const member = await TontineMember.findOne({ tontineId, userId });
    const user = await User.findById(userId);
    if (!tontine || !member || !user) throw new AppError('Données manquantes', 404);

    const base = tontine.contributionAmount * member.parts;
    let lateFee = 0;
    const deadline = this.getTurnDeadline(
      tontine.startDate,
      tontine.frequency,
      tontine.currentTurn,
    );
    if (new Date() > new Date(deadline.getTime() + tontine.sanctions.gracePeriodHours * 3600000)) {
      lateFee = tontine.sanctions.lateFee * member.parts;
    }

    const rate = CurrencyService.getRate(tontine.currency, user.currency || 'XAF');
    return {
      baseAmount: base,
      convertedAmount: Math.ceil((base + lateFee) * rate),
      currency: user.currency || 'XAF',
      lateFee,
    };
  }

  /**
   * Paiement du fonds social par un membre (V-04) — obligatoire une seule fois
   * avant le démarrage de la tontine si `socialFund.enabled` (voir garde dans
   * `startTontine`). Idempotent : un membre qui a déjà payé ne peut pas payer
   * une seconde fois. La somme collectée est uniquement suivie
   * (`socialFund.totalCollected`) ; sa redistribution reste une décision
   * manuelle du créateur en cas de coup dur, comme annoncé dans le guide.
   */
  static async payMandatorySocialFund(tontineId: string, userId: string) {
    const result = await WalletService.runInTransaction(async (session) => {
      const tontine = await Tontine.findById(tontineId).session(session);
      if (!tontine) throw new AppError('Tontine non trouvée', 404);
      if (!tontine.socialFund?.enabled) {
        throw new AppError("Le fonds social n'est pas activé pour cette tontine", 400);
      }

      const member = await TontineMember.findOne({
        tontineId,
        userId,
        invitationStatus: 'accepted',
      }).session(session);
      if (!member) throw new AppError("Vous n'êtes pas membre de cette tontine", 403);
      if (member.hasPaidSocialFund) {
        throw new AppError('Vous avez déjà payé le fonds social', 400);
      }

      const user = await User.findById(userId).session(session);
      if (!user) throw new AppError('Utilisateur non trouvé', 404);
      const rate = CurrencyService.getRate(tontine.currency, user.currency || 'XAF');
      const convertedAmount = Math.ceil(tontine.socialFund.amount * rate);

      const tx = await WalletService.executeTransaction(
        {
          userId,
          amount: convertedAmount,
          type: 'tontine_social_fund',
          description: `Fonds social : ${tontine.name}`,
          paymentMethod: 'wallet',
          // Lets deleteTontine refund exactly what was paid.
          metadata: { tontineId: String(tontineId) },
        },
        { session },
      );

      member.hasPaidSocialFund = true;
      await member.save({ session });

      tontine.socialFund.totalCollected =
        (tontine.socialFund.totalCollected || 0) + convertedAmount;
      await tontine.save({ session });

      return { tx, member };
    });

    (result.tx as any)
      ._postCommit?.()
      .catch((err: any) => logger.error(`Post-commit hook error: ${err.message}`));

    return result.member;
  }

  /**
   * Applique les frais d'absence (V-04) : pénalise les membres SANS auto-débit
   * qui n'ont soumis aucune cotisation validée pour le tour courant, une fois
   * le délai de grâce dépassé. Les membres en auto-débit ne sont jamais
   * "absents" — `processAutoDebits` les prélève déjà systématiquement. C'est
   * une pénalité distincte du `lateFee` (qui, lui, majore et compte comme
   * cotisation) : elle ne crée pas de `TontineContribution` et ne compte donc
   * pas dans le pot du tour — le membre reste compté comme n'ayant pas
   * contribué, en plus d'être sanctionné financièrement.
   *
   * Appelée par le cron juste avant `rotateTurn`, pour que la pénalité soit
   * appliquée avant que le pot du tour ne soit figé.
   */
  static async applyAbsenceFees(tontineId: string): Promise<void> {
    const tontine = await Tontine.findById(tontineId);
    if (!tontine || tontine.status !== 'active') return;
    if (!tontine.sanctions?.absenceFee) return;

    const deadline = this.getTurnDeadline(
      tontine.startDate,
      tontine.frequency,
      tontine.currentTurn,
    );
    const graceDeadline = new Date(
      deadline.getTime() + tontine.sanctions.gracePeriodHours * 3600000,
    );
    if (new Date() <= graceDeadline) return;

    const members = await TontineMember.find({
      tontineId,
      invitationStatus: 'accepted',
      isAutoDebitEnabled: false,
    });

    for (const member of members) {
      const existing = await TontineContribution.findOne({
        tontineId,
        memberId: member._id,
        turnIndex: tontine.currentTurn,
        validationStatus: { $in: ['completed', 'ai_validated'] },
      });
      if (existing) continue;

      try {
        const user = await User.findById(member.userId);
        if (!user) continue;
        const rate = CurrencyService.getRate(tontine.currency, user.currency || 'XAF');
        const feeAmount = Math.ceil(tontine.sanctions.absenceFee * member.parts * rate);
        if (feeAmount <= 0) continue;

        const tx = await WalletService.runInTransaction(async (session) => {
          // Re-vérifié dans la transaction : évite une double pénalité si ce
          // job est rejoué (ex: cron relancé après un crash partiel).
          const alreadyContributed = await TontineContribution.findOne({
            tontineId,
            memberId: member._id,
            turnIndex: tontine.currentTurn,
            validationStatus: { $in: ['completed', 'ai_validated'] },
          }).session(session);
          if (alreadyContributed) return null;

          // One fee per member per turn: the job charged again on every replay
          // (only "has contributed" was checked). Deterministic reference +
          // unique index on Transaction.reference make the charge idempotent.
          const reference = `TONTINE-ABSENCE-${tontineId}-${member._id}-T${tontine.currentTurn}`;
          if (await Transaction.exists({ reference }).session(session)) return null;

          const t = await WalletService.executeTransaction(
            {
              userId: member.userId.toString(),
              amount: feeAmount,
              type: 'tontine_absence_fee',
              description: `Frais d'absence : ${tontine.name} (Tour ${tontine.currentTurn})`,
              paymentMethod: 'wallet',
              reference,
            },
            { session },
          );

          // Pénalité de confiance plus sévère qu'un simple retard (-5) : une
          // absence complète est un signal plus fort qu'un paiement tardif.
          const freshMember = await TontineMember.findById(member._id).session(session);
          if (freshMember) {
            freshMember.trustScore = Math.max(0, freshMember.trustScore - 10);
            await freshMember.save({ session });
          }

          return t;
        });

        if (tx) {
          (tx as any)
            ._postCommit?.()
            .catch((err: any) => logger.error(`Post-commit hook error: ${err.message}`));
        }
      } catch (err: any) {
        // Solde insuffisant ou autre échec ponctuel : on logue et on continue
        // avec les autres membres, comme processAutoDebits.
        logger.warn(`Absence fee failed for member ${member._id}: ${err.message}`);
      }
    }
  }

  static async updateTrustScore(memberId: string, isLate: boolean) {
    const member = await TontineMember.findById(memberId);
    if (member) {
      member.trustScore = isLate
        ? Math.max(0, member.trustScore - 5)
        : Math.min(100, member.trustScore + 1);
      await member.save();
    }
  }

  static async getTurnSummary(tontineId: string) {
    const tontine = await Tontine.findById(tontineId);
    const members = await TontineMember.find({ tontineId, invitationStatus: 'accepted' });
    const contributions = await TontineContribution.find({
      tontineId,
      turnIndex: tontine?.currentTurn,
      validationStatus: { $in: ['ai_validated', 'completed'] },
    });

    // Same lookup rotateTurn uses to pick who gets paid this turn — surfaced
    // here so the app can show "who receives this turn's pot" instead of
    // leaving members to guess or check off-app.
    const beneficiary = members.find((m) => turnsOf(m).includes(tontine?.currentTurn as number));
    const walletContributions = contributions.filter(isWalletBacked);

    return {
      collectedAmount: contributions.reduce((s, c) => s + c.amountPaid, 0),
      // Only money actually debited from wallets can be paid out by Kauri.
      walletCollectedAmount: walletContributions.reduce((s, c) => s + c.amountPaid, 0),
      offAppCollectedAmount: contributions
        .filter((c) => !isWalletBacked(c))
        .reduce((s, c) => s + c.amountPaid, 0),
      expectedAmount: (tontine?.contributionAmount || 0) * members.reduce((s, m) => s + m.parts, 0),
      contributorsCount: contributions.length,
      totalMembers: members.length,
      currentBeneficiaryId: beneficiary?._id?.toString(),
      currentBeneficiaryName: beneficiary?.displayName,
    };
  }

  static async startTontine(tontineId: string, creatorId: string) {
    const tontine = await Tontine.findById(tontineId);
    if (!tontine || tontine.creatorId.toString() !== creatorId)
      throw new AppError('Non autorisé', 403);
    const members = await TontineMember.find({ tontineId, invitationStatus: 'accepted' });
    if (members.length < 2) throw new AppError('Mini 2 membres', 400);

    // Le fonds social n'a de sens que si tout le monde y a contribué avant que
    // le cycle ne commence — sinon un membre pourrait profiter de la caisse
    // d'entraide sans jamais y avoir mis d'argent (V-04).
    if (tontine.socialFund?.enabled) {
      const unpaidCount = members.filter((m) => !m.hasPaidSocialFund).length;
      if (unpaidCount > 0) {
        throw new AppError(
          `${unpaidCount} membre(s) n'ont pas encore payé le fonds social. Tous les membres doivent y contribuer avant le démarrage.`,
          400,
        );
      }
    }

    // One rotation SLOT per part: a member holding 2 parts pays twice per turn,
    // so they must also receive the pot twice. Turns used to be assigned per
    // MEMBER while the cycle length was totalParts: every extra part — and
    // every part never taken (10 parts, 3 members) — became a turn with no
    // winner, during which auto-debits kept collecting money nobody received.
    const slots: (typeof members)[number][] = [];
    for (const m of members) for (let p = 0; p < (m.parts || 1); p++) slots.push(m);

    // Attribution rotation avec Fisher-Yates cryptographique
    if (tontine.rotationMode === 'random') {
      for (let i = slots.length - 1; i > 0; i--) {
        const j = crypto.randomInt(0, i + 1);
        [slots[i], slots[j]] = [slots[j], slots[i]];
      }
    }
    const turns = new Map<string, number[]>();
    slots.forEach((m, i) => {
      const key = String(m._id);
      turns.set(key, [...(turns.get(key) || []), i + 1]);
    });
    for (const m of members) {
      const mine = turns.get(String(m._id)) || [];
      (m as any).rotationOrders = mine;
      (m as any).rotationOrder = mine[0];
      await m.save();
    }

    // The cycle lasts exactly as many turns as parts actually taken.
    tontine.totalParts = slots.length;
    tontine.status = 'active';
    tontine.startDate = new Date();
    await tontine.save();
    return tontine;
  }

  /**
   * Passer au tour suivant.
   *
   * Le versement du gagnant et l'avancement de `currentTurn` sont exécutés dans
   * une seule transaction Mongo : si le versement échoue (limite AML, solde,
   * erreur DB...), toute la transaction est annulée, le tour ne bouge pas, et
   * l'erreur remonte à l'appelant (au lieu d'être avalée) pour qu'un crash ou
   * un échec de paiement ne fasse jamais perdre son tour à un gagnant. Un
   * même appel rejoué (retry après crash) ne peut donc jamais payer deux fois
   * le même tour : soit le versement + l'avancement ont été persistés
   * ensemble, soit aucun des deux ne l'a été.
   */
  static async rotateTurn(tontineId: string): Promise<ITontine> {
    const result = await WalletService.runInTransaction(async (session) => {
      const tontine = await Tontine.findById(tontineId).session(session);
      if (!tontine) throw new AppError('Tontine non trouvée', 404);

      if (tontine.status !== 'active') {
        // Déjà clôturée ou pas encore démarrée : no-op idempotent (utile si
        // le job cron est rejoué sur une tontine déjà traitée).
        return { tontine, transaction: null };
      }

      const members = await TontineMember.find({ tontineId, invitationStatus: 'accepted' }).session(
        session,
      );
      const winner = members.find((m) => turnsOf(m).includes(tontine.currentTurn));

      let transaction: any = null;
      if (!winner) {
        // Should no longer happen now that removeMember refuses to remove a member
        // already assigned a rotationOrder — kept as a loud safety net in case a
        // tontine reaches this state through older data or another path, since the
        // alternative (silently skipping) would strand any funds already collected
        // for this turn with no recipient.
        const summary = await this.getTurnSummary(tontineId);
        if (summary.collectedAmount > 0) {
          logger.error(
            `Tontine ${tontineId} tour ${tontine.currentTurn} : aucun gagnant trouvé mais ${summary.collectedAmount} déjà collecté — fonds immobilisés, intervention manuelle requise.`,
          );
          SlackService.sendAlert(
            `🚨 Tontine "${tontine.name}" (${tontineId}), tour ${tontine.currentTurn} : aucun gagnant trouvé alors que ${summary.collectedAmount} ${tontine.currency} ont été collectés. Intervention manuelle requise (remboursement des cotisants).`,
          ).catch(() => {});
        }
      } else {
        const summary = await this.getTurnSummary(tontineId);
        // ONLY wallet-backed contributions are paid out. Receipt contributions
        // were paid outside the app (Kauri never received that money): paying
        // them from a wallet minted withdrawable money from a screenshot
        // approved by the creator — a regular user who may be the winner.
        const payable = summary.walletCollectedAmount;
        if (payable > 0) {
          const kauriFee = Math.floor(payable * 0.01);
          // Référence déterministe : si ce même tour est traité deux fois en
          // parallèle, l'index unique sur Transaction.reference rejette la
          // seconde tentative au lieu de payer le gagnant deux fois.
          const payoutReference = `TONTINE-PAYOUT-${tontine._id}-T${tontine.currentTurn}`;
          transaction = await WalletService.executeTransaction(
            {
              userId: winner.userId.toString(),
              amount: payable,
              fees: kauriFee,
              type: 'tontine_payout',
              description: `Gain Tontine : ${tontine.name} (Tour ${tontine.currentTurn})`,
              paymentMethod: 'wallet',
              reference: payoutReference,
            },
            { session },
          );
        } else {
          logger.warn(
            `Tontine ${tontineId} tour ${tontine.currentTurn} : aucun fond collecté sur les wallets, versement ignoré.`,
          );
        }
      }

      tontine.currentTurn += 1;
      if (tontine.currentTurn > tontine.totalParts) {
        tontine.status = 'completed';
      }
      await tontine.save({ session });

      return { tontine, transaction };
    });

    if (result.transaction) {
      result.transaction
        ._postCommit?.()
        .catch((err: any) => logger.error(`Post-commit hook error: ${err.message}`));
      InvoiceService.generateForTransaction(result.transaction._id.toString()).catch((err: any) =>
        logger.error(`Invoice generation error: ${err.message}`),
      );
    }

    if (result.tontine.status === 'completed') {
      await this.settleEndedTontine(tontineId, 'fin du cycle').catch((err: any) =>
        logger.error(`Tontine settlement failed for ${tontineId}: ${err.message}`),
      );
    }

    // Le renouvellement automatique est volontairement hors de la transaction
    // ci-dessus : un renouvellement raté ne doit pas invalider le versement et
    // la clôture du cycle qui viennent d'être actés.
    if (result.tontine.status === 'completed' && result.tontine.autoRenew) {
      try {
        await this.renewTontine(result.tontine);
      } catch (err: any) {
        logger.error(`Tontine renewal failed for ${tontineId}: ${err.message}`);
        SlackService.sendAlert(
          `🚨 Le renouvellement automatique de la tontine "${result.tontine.name}" (${tontineId}) a échoué : ${err.message}`,
        ).catch(() => {});
      }
    }

    return result.tontine;
  }

  static async renewTontine(old: ITontine) {
    // On clone le document sans les champs qui doivent être uniques ou propres
    // à ce cycle : réutiliser l'inviteCode de l'ancienne tontine viole son
    // index unique et fait échouer la création (la tontine reste alors bloquée
    // sur son dernier tour, jamais renouvelée).
    const oldObj: any = old.toObject();
    delete oldObj._id;
    delete oldObj.inviteCode;
    delete oldObj.createdAt;
    delete oldObj.updatedAt;
    delete oldObj.__v;

    const newT = await Tontine.create({
      ...oldObj,
      status: 'pending',
      currentTurn: 1,
      // startDate is REQUIRED by the schema: `undefined` made every automatic
      // renewal fail validation (only logged) — autoRenew never worked.
      // startTontine resets it to the real start anyway.
      startDate: new Date(),
    });

    const members = await TontineMember.find({ tontineId: old._id, invitationStatus: 'accepted' });
    for (const m of members) {
      const mObj: any = m.toObject();
      delete mObj._id;
      delete mObj.createdAt;
      delete mObj.updatedAt;
      delete mObj.__v;
      await TontineMember.create({ ...mObj, tontineId: newT._id });
    }
    return newT;
  }

  /**
   * Valide ou rejette manuellement une cotisation en attente de révision
   * (tontines en mode `ia_plus_manual`). Seul le créateur de la tontine peut
   * trancher.
   */
  static async validateContribution(
    tontineId: string,
    contributionId: string,
    userId: string,
    decision: 'approve' | 'reject',
    reason?: string,
  ) {
    const tontine = await Tontine.findById(tontineId);
    if (!tontine) throw new AppError('Tontine non trouvée', 404);
    if (tontine.creatorId.toString() !== userId) {
      throw new AppError('Seul le créateur de la tontine peut valider les cotisations', 403);
    }

    const contribution = await TontineContribution.findOne({ _id: contributionId, tontineId });
    if (!contribution) throw new AppError('Cotisation non trouvée', 404);
    if (contribution.validationStatus !== 'manual_pending') {
      throw new AppError('Cette cotisation ne requiert pas de validation manuelle', 400);
    }

    if (decision === 'approve') {
      contribution.validationStatus = 'completed';
    } else {
      contribution.validationStatus = 'rejected';
      if (reason) contribution.rejectionReason = reason;
    }
    await contribution.save();

    const member = await TontineMember.findById(contribution.memberId);
    if (member) {
      NotificationService.sendToUser(member.userId.toString(), {
        title: '',
        body: '',
        translationKey:
          decision === 'approve'
            ? 'TONTINE_CONTRIBUTION_VALIDATED'
            : 'TONTINE_CONTRIBUTION_REJECTED',
        translationData: { turn: contribution.turnIndex, tontineName: tontine.name },
        data: {
          tontineId,
          type:
            decision === 'approve'
              ? 'TONTINE_CONTRIBUTION_VALIDATED'
              : 'TONTINE_CONTRIBUTION_REJECTED',
        },
      }).catch((err) => logger.error(`Contribution validation notification error: ${err.message}`));
    }

    return contribution;
  }

  static async sendMessage(
    tontineId: string,
    senderId: string,
    content: string,
    type: any = 'text',
    audioUrl?: string,
    audioDuration?: number,
  ) {
    const tontine = await this.assertIsMember(tontineId, senderId);
    if (type !== 'audio') {
      type = 'text';
      if (typeof content !== 'string' || !content.trim()) {
        throw new AppError('Le message est vide', 400);
      }
    }
    if (typeof content === 'string' && content.length > MESSAGE_MAX_LENGTH) {
      throw new AppError(`Message trop long (max ${MESSAGE_MAX_LENGTH} caractères)`, 400);
    }
    const message = await TontineMessage.create({
      tontineId,
      senderId,
      content,
      type,
      audioUrl,
      audioDuration,
    });

    // Notify every other member — fire-and-forget, mirrors the
    // TONTINE_CONTRIBUTION_PENDING_REVIEW pattern in tontineController.contribute().
    // category 'informational' respects the user's notification frequency preference
    // (no forced push for low/medium frequency) while still recording the in-app
    // notification history unconditionally.
    const sender = await User.findById(senderId).select('firstName lastName');
    const senderName = sender ? `${sender.firstName} ${sender.lastName}`.trim() : 'Un membre';
    const preview =
      type === 'audio'
        ? '🎤 Note vocale'
        : content.length > 60
          ? `${content.slice(0, 57)}...`
          : content;

    TontineMember.find({ tontineId, invitationStatus: 'accepted' })
      .then((members) => {
        members
          .filter((m) => m.userId.toString() !== senderId)
          .forEach((m) => {
            NotificationService.sendToUser(m.userId.toString(), {
              title: '',
              body: '',
              category: 'informational',
              translationKey: 'TONTINE_NEW_MESSAGE',
              translationData: { senderName, tontineName: tontine.name, preview },
              data: { tontineId, type: 'TONTINE_NEW_MESSAGE' },
            }).catch((err: any) => logger.error(`New message notification error: ${err.message}`));
          });
      })
      .catch((err: any) =>
        logger.error(`Failed to list tontine members for notification: ${err.message}`),
      );

    return message;
  }

  static async getMessages(tontineId: string, userId: string) {
    await this.assertIsMember(tontineId, userId);
    const messages = await TontineMessage.find({ tontineId })
      .populate('senderId', 'firstName lastName')
      .sort({ createdAt: -1 });
    return this.withSignedUrls(messages, 'audioUrl');
  }

  static async getUserTontines(userId: string) {
    const members = await TontineMember.find({ userId });
    const tontines = await Tontine.find({ _id: { $in: members.map((m) => m.tontineId) } }).sort({
      updatedAt: -1,
    });
    return tontines;
  }

  /**
   * Processus automatique de prélèvement
   */
  static async processAutoDebits(): Promise<void> {
    const tontines = await Tontine.find({ status: 'active' });
    for (const tontine of tontines) {
      const members = await TontineMember.find({
        tontineId: tontine._id,
        invitationStatus: 'accepted',
        isAutoDebitEnabled: { $ne: false }, // Actif par défaut ou si true
      });
      for (const member of members) {
        const existing = await TontineContribution.findOne({
          tontineId: tontine._id,
          memberId: member._id,
          turnIndex: tontine.currentTurn,
          validationStatus: { $in: ['completed', 'ai_validated'] },
        });
        if (!existing) {
          try {
            const amounts = await this.getMemberContributionAmount(
              tontine._id.toString(),
              member.userId.toString(),
            );

            // Le débit du wallet et la création de la cotisation doivent
            // réussir ou échouer ensemble : sans cela, un crash entre les deux
            // débite le membre sans qu'aucune cotisation ne soit enregistrée,
            // ce qui le sous-compte définitivement dans le calcul du pot.
            const result = await WalletService.runInTransaction(async (session) => {
              const alreadyPaid = await TontineContribution.findOne({
                tontineId: tontine._id,
                memberId: member._id,
                turnIndex: tontine.currentTurn,
                validationStatus: { $in: ['completed', 'ai_validated'] },
              }).session(session);
              if (alreadyPaid) return null;

              const tx = await WalletService.executeTransaction(
                {
                  userId: member.userId.toString(),
                  amount: amounts.convertedAmount,
                  type: 'tontine_contribution',
                  description: `Cotisation : ${tontine.name}`,
                  paymentMethod: 'wallet',
                },
                { session },
              );

              const [contribution] = await TontineContribution.create(
                [
                  {
                    tontineId: tontine._id,
                    memberId: member._id,
                    turnIndex: tontine.currentTurn,
                    amountPaid: amounts.convertedAmount,
                    currency: amounts.currency,
                    paidAt: new Date(),
                    validationStatus: 'completed',
                    source: 'wallet',
                    transactionRef: tx.reference,
                  },
                ],
                { session },
              );

              return { tx, contribution };
            });

            if (result) {
              (result.tx as any)
                ._postCommit?.()
                .catch((err: any) => logger.error(`Post-commit hook error: ${err.message}`));
              InvoiceService.generateForTransaction(result.tx._id.toString()).catch((err: any) =>
                logger.error(`Invoice generation error: ${err.message}`),
              );
            }
          } catch (err: any) {
            logger.warn(`Auto-debit fail for ${member.userId}: ${err.message}`);
          }
        }
      }
    }
  }

  /**
   * Statistiques globales pour le monitoring
   */
  static async getGlobalStats() {
    const activeCount = await Tontine.countDocuments({ status: 'active' });
    return {
      activeCount,
      lateRate: 5.5,
    };
  }

  static async listAllTontines() {
    return Tontine.find().sort({ createdAt: -1 }).populate('creatorId', 'firstName lastName');
  }

  static async getAdminTontineDetails(id: string) {
    const tontine = await Tontine.findById(id).populate('creatorId', 'firstName lastName');
    const members = await TontineMember.find({ tontineId: id }).populate(
      'userId',
      'firstName lastName',
    );
    const contributions = await this.withSignedUrls(
      await TontineContribution.find({ tontineId: id }),
      'proofImage',
    );
    return { tontine, members, contributions };
  }

  static async getTontineMembers(tontineId: string, userId: string) {
    await this.assertIsMember(tontineId, userId);
    return TontineMember.find({ tontineId }).populate('userId', 'firstName lastName');
  }

  static async createVote(
    tontineId: string,
    userId: string,
    question: string,
    options: string[],
    durationHours: number,
    kind: 'general' | 'closure' = 'general',
  ) {
    const tontine = await this.assertIsMember(tontineId, userId);
    const v = validateOrThrow<{
      kind: 'general' | 'closure';
      question?: string;
      options?: string[];
      durationHours: number;
    }>(createVoteSchema, { kind, question, options, durationHours });

    if (v.kind === 'closure') {
      // Any accepted member may ask the group to stop an ACTIVE cycle (e.g. a
      // creator who disappeared) — the decision itself belongs to the majority.
      if (tontine.status !== 'active') {
        throw new AppError("Seule une tontine active peut faire l'objet d'un vote de clôture", 400);
      }
      if (await TontineVote.exists({ tontineId, kind: 'closure', status: 'open' })) {
        throw new AppError('Un vote de clôture est déjà en cours', 400);
      }
      const created = await TontineVote.create({
        tontineId,
        creatorId: userId,
        kind: 'closure',
        question: v.question || `Clôturer la tontine "${tontine.name}" avant la fin du cycle ?`,
        options: CLOSURE_OPTIONS.map((o) => ({ text: o, count: 0 })),
        expiresAt: new Date(Date.now() + v.durationHours * 3600000),
      });
      return this.toPublicVote(created, userId, await this.closureMajority(tontineId));
    }

    // Proposing a general governance vote stays a creator action.
    if (tontine.creatorId.toString() !== userId) {
      throw new AppError('Seul le créateur de la tontine peut lancer un vote', 403);
    }
    return TontineVote.create({
      tontineId,
      creatorId: userId,
      question: v.question,
      options: v.options!.map((o) => ({ text: o, count: 0 })),
      expiresAt: new Date(Date.now() + v.durationHours * 3600000),
    });
  }

  /**
   * Applies a closure vote as soon as its outcome is certain: an absolute
   * majority of accepted members (counted per member, not per part) for or
   * against. Closing stops future auto-debits/rotations; turns already paid
   * stay paid.
   */
  private static async settleClosureVote(vote: any): Promise<void> {
    const membersCount = await TontineMember.countDocuments({
      tontineId: vote.tontineId,
      invitationStatus: 'accepted',
    });
    const yes = vote.options[0].count;
    const no = vote.options[1].count;
    const majority = Math.floor(membersCount / 2) + 1;
    if (yes < majority && no < majority) return;

    const approved = yes >= majority;
    const settled = await TontineVote.findOneAndUpdate(
      { _id: vote._id, status: 'open' },
      { $set: { status: 'closed', outcome: approved ? 'approved' : 'rejected' } },
      { new: true },
    );
    if (!settled || !approved) return;

    const tontine = await Tontine.findOneAndUpdate(
      { _id: vote.tontineId, status: 'active' },
      { $set: { status: 'completed', endDate: new Date() } },
      { new: true },
    );
    if (!tontine) return;
    logger.info(`Tontine ${tontine._id} clôturée par vote des membres (${yes}/${membersCount}).`);
    await this.settleEndedTontine(String(tontine._id), 'clôture par vote').catch((err: any) =>
      logger.error(`Tontine settlement failed for ${tontine._id}: ${err.message}`),
    );
    const members = await TontineMember.find({
      tontineId: tontine._id,
      invitationStatus: 'accepted',
    });
    for (const m of members) {
      NotificationService.sendToUser(m.userId.toString(), {
        title: 'Tontine clôturée',
        body: `La tontine "${tontine.name}" a été clôturée par vote des membres.`,
        category: 'important',
        data: { tontineId: String(tontine._id), type: 'TONTINE_CLOSED_BY_VOTE' },
      }).catch((err: any) => logger.error(`Closure notification error: ${err.message}`));
    }
  }

  /**
   * Admin-only closure of a running tontine (dispute, fraud, support request).
   * Always audit-logged with the admin and the reason.
   */
  static async adminCloseTontine(tontineId: string, adminId: string, reason: string) {
    if (typeof reason !== 'string' || reason.trim().length < 5) {
      throw new AppError('Un motif (5 caractères minimum) est obligatoire', 400);
    }
    const tontine = await Tontine.findOneAndUpdate(
      { _id: tontineId, status: { $in: ['active', 'suspended', 'suspended_premium_required'] } },
      { $set: { status: 'completed', endDate: new Date() } },
      { new: true },
    );
    if (!tontine) throw new AppError('Tontine introuvable ou déjà terminée', 404);
    const { AuditService } = await import('./auditService');
    await AuditService.recordSync({
      userId: adminId as any,
      action: 'TONTINE_ADMIN_CLOSE',
      resource: 'TONTINE',
      resourceId: String(tontineId),
      status: 'success',
      metadata: { reason: reason.trim() },
    });
    await this.settleEndedTontine(String(tontine._id), `clôture admin : ${reason.trim()}`).catch(
      (err: any) => {
        logger.error(`Tontine settlement failed for ${tontine._id}: ${err.message}`);
        SlackService.sendAlert(
          `🚨 Règlement de la tontine ${tontine._id} en échec : ${err.message}`,
        ).catch(() => {});
      },
    );
    return tontine;
  }

  /**
   * Règlement financier d'une tontine qui se termine (clôture par vote, par
   * l'admin, ou fin normale du cycle). Sans lui, de l'argent restait bloqué :
   *  - les cotisations wallet du tour en cours (et celles payées d'avance) ne
   *    sont versées qu'à la rotation, qui ne passe plus après une clôture ;
   *  - le fonds social n'est que comptabilisé, rien ne permet de le dépenser.
   * Règles : on rembourse intégralement ces sommes à ceux qui les ont payées.
   * Un membre qui a déjà touché la cagnotte sans avoir tout cotisé n'est PAS
   * débité d'office (pas de prélèvement sans consentement) : sa dette est
   * signalée à l'équipe (Slack + audit) pour recouvrement, et il est notifié.
   * Idempotent : références déterministes, vérifiées avant chaque versement.
   */
  static async settleEndedTontine(tontineId: string, reason: string) {
    const outcome = await WalletService.runInTransaction(async (session) => {
      const tontine = await Tontine.findById(tontineId).session(session);
      if (!tontine || tontine.status !== 'completed') return null;

      const members = await TontineMember.find({ tontineId }).session(session);
      const byMember = new Map(members.map((m) => [String(m._id), m]));
      const txs: any[] = [];
      const refunded = new Map<string, number>();

      const refund = async (userId: string, amount: number, reference: string, label: string) => {
        if (amount <= 0) return;
        if (await Transaction.exists({ reference }).session(session)) return;
        txs.push(
          await WalletService.executeTransaction(
            {
              userId,
              amount,
              type: 'deposit',
              category: 'tontine_refund',
              description: `${label} : ${tontine.name}`,
              paymentMethod: 'wallet',
              reference,
              metadata: { tontineId: String(tontineId) },
            } as any,
            { session },
          ),
        );
        refunded.set(userId, (refunded.get(userId) || 0) + amount);
      };

      // 1. Cotisations wallet des tours non versés (tour courant et suivants).
      const unpaid = await TontineContribution.find({
        tontineId,
        turnIndex: { $gte: tontine.currentTurn },
        validationStatus: { $in: ['ai_validated', 'completed'] },
      }).session(session);
      for (const c of unpaid.filter(isWalletBacked)) {
        const m = byMember.get(String(c.memberId));
        if (!m) continue;
        await refund(
          m.userId.toString(),
          c.amountPaid,
          `TONTINE-REFUND-${c._id}`,
          `Remboursement cotisation (tour ${c.turnIndex} non versé)`,
        );
      }

      // 2. Fonds social : rendu à chaque payeur (montant réellement payé).
      for (const m of members.filter((x) => x.hasPaidSocialFund)) {
        const paid = await Transaction.findOne({
          userId: m.userId,
          category: 'tontine_social_fund',
          'metadata.tontineId': String(tontineId),
          status: 'completed',
        }).session(session);
        if (paid?.amount) {
          await refund(
            m.userId.toString(),
            paid.amount,
            `TONTINE-SF-REFUND-${tontineId}-${m.userId}`,
            'Remboursement fonds social',
          );
        }
      }
      if (tontine.socialFund?.enabled) {
        tontine.socialFund.totalCollected = 0;
        tontine.markModified('socialFund');
        await tontine.save({ session });
      }

      // 3. Bilan : qui a touché plus qu'il n'a cotisé (dette à recouvrer).
      const paidContribs = await TontineContribution.find({
        tontineId,
        turnIndex: { $lt: tontine.currentTurn },
        validationStatus: { $in: ['ai_validated', 'completed'] },
      }).session(session);
      const payouts = await Transaction.find({
        reference: { $regex: `^TONTINE-PAYOUT-${tontineId}-T` },
        status: 'completed',
      }).session(session);
      const debts: { userId: string; name: string; amount: number }[] = [];
      for (const m of members) {
        const contributed = paidContribs
          .filter((c) => String(c.memberId) === String(m._id) && isWalletBacked(c))
          .reduce((s, c) => s + c.amountPaid, 0);
        const received = payouts
          .filter((p) => String(p.userId) === String(m.userId))
          .reduce((s, p) => s + p.amount, 0);
        if (received > contributed) {
          debts.push({
            userId: m.userId.toString(),
            name: m.displayName || String(m.userId),
            amount: received - contributed,
          });
        }
      }
      return { tontine, txs, refunded, debts };
    });

    if (!outcome) return null;
    for (const tx of outcome.txs) {
      (tx as any)._postCommit?.().catch((err: any) => logger.error(`Post-commit: ${err.message}`));
    }
    const { tontine, refunded, debts } = outcome;
    for (const [userId, amount] of refunded) {
      NotificationService.sendToUser(userId, {
        title: 'Remboursement tontine',
        body: `${amount.toLocaleString('fr-FR')} ${tontine.currency} vous ont été remboursés suite à la fin de la tontine "${tontine.name}".`,
        category: 'transactional',
        data: { tontineId: String(tontineId), type: 'TONTINE_REFUND' },
      }).catch((err: any) => logger.error(`Refund notification error: ${err.message}`));
    }
    for (const d of debts) {
      NotificationService.sendToUser(d.userId, {
        title: 'Tontine clôturée : solde à régulariser',
        body: `Vous avez reçu ${d.amount.toLocaleString('fr-FR')} ${tontine.currency} de plus que vos cotisations dans la tontine "${tontine.name}". Notre équipe va vous contacter pour la régularisation.`,
        category: 'important',
        data: { tontineId: String(tontineId), type: 'TONTINE_DEBT' },
      }).catch((err: any) => logger.error(`Debt notification error: ${err.message}`));
    }
    if (debts.length > 0) {
      SlackService.sendAlert(
        `⚠️ Tontine "${tontine.name}" (${tontineId}) terminée (${reason}) avec des soldes à recouvrer : ` +
          debts.map((d) => `${d.name} ${d.amount} ${tontine.currency}`).join(', '),
      ).catch(() => {});
    }
    const { AuditService } = await import('./auditService');
    await AuditService.recordSync({
      action: 'TONTINE_SETTLEMENT',
      resource: 'TONTINE',
      resourceId: String(tontineId),
      status: 'success',
      metadata: {
        reason,
        refunds: Object.fromEntries(refunded),
        debts: debts.map((d) => ({ userId: d.userId, amount: d.amount })),
      },
    } as any);
    return { refunded: Object.fromEntries(refunded), debts };
  }

  /**
   * Votes of a tontine for its members (most recent first). There was no way to
   * LIST votes: the app could create/cast them but never display them, so a
   * closure vote (the only way to stop a running cycle) was unusable.
   * Ballot secrecy: `voters` is never returned, only whether the requester voted.
   */
  static async listVotes(tontineId: string, userId: string) {
    await this.assertIsMember(tontineId, userId);
    const votes = await TontineVote.find({ tontineId }).sort({ createdAt: -1 }).limit(20).lean();
    const majority = await this.closureMajority(tontineId);
    return votes.map((v: any) => this.toPublicVote(v, userId, majority));
  }

  /** Absolute majority of accepted members (per member, not per part). */
  private static async closureMajority(tontineId: any): Promise<number> {
    const membersCount = await TontineMember.countDocuments({
      tontineId,
      invitationStatus: 'accepted',
    });
    return Math.floor(membersCount / 2) + 1;
  }

  /**
   * Public shape of a vote: `voters` (who voted) is NEVER sent — castVote used
   * to return the raw document, leaking the list of member ids who voted.
   */
  private static toPublicVote(vote: any, userId: string, majority?: number) {
    const raw = typeof vote?.toObject === 'function' ? vote.toObject() : vote;
    const { voters, ...rest } = raw;
    return {
      ...rest,
      hasVoted: (voters || []).some((x: any) => String(x) === String(userId)),
      votersCount: (voters || []).length,
      ...(majority !== undefined ? { majority } : {}),
    };
  }

  static async castVote(userId: string, voteId: string, optionIndex: number) {
    const { optionIndex: index } = validateOrThrow<{ optionIndex: number }>(castVoteSchema, {
      optionIndex,
    });
    const vote = await TontineVote.findById(voteId);
    if (!vote) throw new AppError('Vote non trouvé', 404);
    await this.assertIsMember(vote.tontineId.toString(), userId);
    if (index >= vote.options.length) throw new AppError('Option de vote invalide', 400);
    if (vote.status === 'closed' || vote.expiresAt < new Date()) {
      throw new AppError('Ce vote est clos', 400);
    }

    // Atomic: "not yet in voters" is part of the update filter. The previous
    // read-check-save let simultaneous requests from one member each pass the
    // check and each add a vote.
    const updated = await TontineVote.findOneAndUpdate(
      {
        _id: voteId,
        voters: { $ne: new mongoose.Types.ObjectId(userId) },
        status: 'open',
        expiresAt: { $gt: new Date() },
      },
      {
        $inc: { [`options.${index}.count`]: 1 },
        $push: { voters: new mongoose.Types.ObjectId(userId) },
      },
      { new: true },
    );
    if (!updated) throw new AppError('Déjà voté', 400);
    const majority = await this.closureMajority(updated.tontineId);
    if (updated.kind === 'closure') {
      await this.settleClosureVote(updated);
      return this.toPublicVote((await TontineVote.findById(voteId))!, userId, majority);
    }
    return this.toPublicVote(updated, userId, majority);
  }

  static async exportTontineReport(tontineId: string, userId: string, turn?: number) {
    const tontine = await Tontine.findById(tontineId);
    if (!tontine || tontine.creatorId.toString() !== userId) {
      throw new AppError('Non autorisé', 403);
    }
    const query: any = { tontineId };
    if (turn) query.turnIndex = turn;
    const contributions = await TontineContribution.find(query).populate('memberId');
    const fields = [
      'memberId.displayName',
      'turnIndex',
      'amountPaid',
      'currency',
      'paidAt',
      'validationStatus',
    ];
    const parser = new Parser({ fields });
    // Member display names are user-controlled: a name like =HYPERLINK(...)
    // would run as a formula when the creator opens the export in Excel.
    const rows = contributions.map((c: any) => {
      const o = c.toObject();
      if (o.memberId) o.memberId.displayName = csvSafe(o.memberId.displayName);
      return o;
    });
    return parser.parse(rows);
  }

  static async getTontineContributions(tontineId: string, userId: string) {
    const tontine = await Tontine.findById(tontineId);
    if (!tontine || tontine.creatorId.toString() !== userId)
      throw new AppError('Non autorisé', 403);
    const contributions = await TontineContribution.find({ tontineId })
      .populate('memberId', 'displayName')
      .sort({ createdAt: -1 });
    return this.withSignedUrls(contributions, 'proofImage');
  }

  /**
   * A creator without an entitled paid plan keeps ONE running tontine (the
   * free-tier allowance enforced at creation). This used to suspend ALL of a
   * free creator's active tontines — including the single one the free plan
   * allows — the moment anyone opened its details; and an expired premium
   * (plan still "premium") was never suspended at all.
   */
  static async enforcePremiumLimits(userId: string) {
    const user = await User.findById(userId);
    if (!user || isSubscriptionEntitled(user.subscription as any)) return;
    const active = await Tontine.find({ creatorId: userId, status: 'active' })
      .sort({ createdAt: 1 })
      .select('_id');
    const overLimit = active.slice(1).map((t) => t._id);
    if (overLimit.length) {
      await Tontine.updateMany(
        { _id: { $in: overLimit } },
        { $set: { status: 'suspended_premium_required' } },
      );
    }
  }
}
