import Tontine, { ITontine } from '../models/Tontine';
import TontineMember from '../models/TontineMember';
import TontineAuction from '../models/TontineAuction';
import TontineContribution from '../models/TontineContribution';
import TontineMessage from '../models/TontineMessage';
import TontineVote from '../models/TontineVote';
import User from '../models/User';
import { AppError } from '../middleware/errorHandler';
import { Parser } from 'json2csv';
import { CurrencyService } from './currencyService';
import { NotificationService } from './notificationService';
import { SlackService } from './slackService';
import { WalletService } from './walletService';
import { InvoiceService } from './invoiceService';
import logger from '../utils/logger';

export class TontineService {
  /**
   * Créer une nouvelle tontine
   */
  static async createTontine(userId: string, data: Partial<ITontine>): Promise<ITontine> {
    const user = await User.findById(userId);
    if (!user) throw new AppError('Utilisateur non trouvé', 404);

    const activeCount = await Tontine.countDocuments({
      creatorId: userId,
      status: { $ne: 'completed' },
    });
    const isPremium = user.subscription?.plan === 'premium';

    if (!isPremium && activeCount >= 1) {
      throw new AppError(
        'Les utilisateurs non-premium sont limités à une seule tontine active.',
        403,
      );
    }

    const tontine = await Tontine.create({
      ...data,
      creatorId: userId,
      status: 'pending',
    });

    await TontineMember.create({
      tontineId: tontine._id,
      userId: userId,
      displayName: `${user.firstName} (Créateur)`,
      parts: 1,
      invitationStatus: 'accepted',
      joinedAt: new Date(),
    });

    return tontine;
  }

  /**
   * Rejoindre une tontine
   */
  static async joinTontine(
    userId: string,
    inviteCode: string,
    data: { displayName: string; parts: number; payoutDetails?: any },
  ): Promise<any> {
    const tontine = await Tontine.findOne({ inviteCode });
    if (!tontine) throw new AppError('Tontine non trouvée', 404);
    if (tontine.status !== 'pending') throw new AppError('Les adhésions sont fermées', 400);

    const user = await User.findById(userId);
    if (!user) throw new AppError('Utilisateur non trouvé', 404);

    const isPremium = user.subscription?.plan === 'premium';
    if (!isPremium) {
      const activeCount = await Tontine.countDocuments({
        _id: {
          $in: (await TontineMember.find({ userId, invitationStatus: 'accepted' })).map(
            (m) => m.tontineId,
          ),
        },
        status: { $ne: 'completed' },
      });
      if (activeCount >= 3)
        throw new AppError('Limite de 3 tontines actives pour les utilisateurs gratuits.', 403);
    }

    const member = await TontineMember.create({
      tontineId: tontine._id,
      userId: userId,
      displayName: data.displayName,
      parts: data.parts || 1,
      payoutDetails: data.payoutDetails,
      invitationStatus: 'accepted',
      joinedAt: new Date(),
    });

    await NotificationService.sendToUser(tontine.creatorId.toString(), {
      title: '',
      body: '',
      translationKey: 'TONTINE_JOIN',
      translationData: { name: data.displayName, tontineName: tontine.name },
      category: 'important',
    });

    return member;
  }

  static async updateTontine(
    tontineId: string,
    userId: string,
    data: Partial<ITontine>,
  ): Promise<ITontine> {
    const tontine = await Tontine.findById(tontineId);
    if (!tontine) throw new AppError('Tontine non trouvée', 404);
    if (tontine.creatorId.toString() !== userId) throw new AppError('Action non autorisée', 403);

    if (tontine.status === 'active') {
      const forbidden = ['contributionAmount', 'currency', 'totalParts', 'frequency'];
      if (Object.keys(data).some((f) => forbidden.includes(f)))
        throw new AppError('Modification interdite une fois lancée', 400);
    }

    Object.assign(tontine, data);
    await tontine.save();
    return tontine;
  }

  static async deleteTontine(tontineId: string, userId: string): Promise<void> {
    const tontine = await Tontine.findById(tontineId);
    if (!tontine || tontine.creatorId.toString() !== userId)
      throw new AppError('Non autorisé', 403);

    if (tontine.status === 'pending') {
      await TontineMember.deleteMany({ tontineId });
      await Tontine.findByIdAndDelete(tontineId);
    } else {
      tontine.status = 'completed';
      await tontine.save();
    }
  }

  static async removeMember(tontineId: string, creatorId: string, memberId: string): Promise<void> {
    const tontine = await Tontine.findById(tontineId);
    if (!tontine || tontine.creatorId.toString() !== creatorId)
      throw new AppError('Non autorisé', 403);
    const member = await TontineMember.findById(memberId);
    if (member?.userId.toString() === creatorId)
      throw new AppError("Le créateur ne peut s'auto-retirer", 400);
    await TontineMember.findByIdAndDelete(memberId);
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

    return {
      collectedAmount: contributions.reduce((s, c) => s + c.amountPaid, 0),
      expectedAmount: (tontine?.contributionAmount || 0) * members.reduce((s, m) => s + m.parts, 0),
      contributorsCount: contributions.length,
      totalMembers: members.length,
    };
  }

  static async startTontine(tontineId: string, creatorId: string) {
    const tontine = await Tontine.findById(tontineId);
    if (!tontine || tontine.creatorId.toString() !== creatorId)
      throw new AppError('Non autorisé', 403);
    const members = await TontineMember.find({ tontineId, invitationStatus: 'accepted' });
    if (members.length < 2) throw new AppError('Mini 2 membres', 400);

    // Attribution rotation
    if (tontine.rotationMode === 'random') members.sort(() => Math.random() - 0.5);
    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      (m as any).rotationOrder = i + 1;
      await m.save();
    }

    tontine.status = 'active';
    tontine.startDate = new Date();
    await tontine.save();
    return tontine;
  }

  /**
   * Passer au tour suivant
   */
  static async rotateTurn(tontineId: string): Promise<ITontine> {
    const tontine = await Tontine.findById(tontineId);
    if (!tontine) throw new AppError('Tontine non trouvée', 404);

    const members = await TontineMember.find({ tontineId, invitationStatus: 'accepted' });

    // --- LOGIQUE FINTECH : Versement ---
    try {
      const winner = members.find((m) => (m as any).rotationOrder === tontine.currentTurn);
      if (winner) {
        const summary = await this.getTurnSummary(tontineId);
        const kauriFee = Math.floor(summary.collectedAmount * 0.01);
        const transaction = await WalletService.executeTransaction({
          userId: winner.userId.toString(),
          amount: summary.collectedAmount,
          fees: kauriFee,
          type: 'tontine_payout',
          description: `Gain Tontine : ${tontine.name} (Tour ${tontine.currentTurn})`,
          paymentMethod: 'wallet',
        });
        await InvoiceService.generateForTransaction(transaction._id.toString());
      }
    } catch (err: any) {
      logger.error(`Rotation Payout Error: ${err.message}`);
    }

    tontine.currentTurn += 1;
    if (tontine.currentTurn > tontine.totalParts) {
      tontine.status = 'completed';
      if (tontine.autoRenew) await this.renewTontine(tontine);
    }

    await tontine.save();
    return tontine;
  }

  static async renewTontine(old: ITontine) {
    const newT = await Tontine.create({
      ...old.toObject(),
      _id: undefined,
      status: 'pending',
      currentTurn: 1,
      startDate: undefined,
    });
    const members = await TontineMember.find({ tontineId: old._id, invitationStatus: 'accepted' });
    for (const m of members)
      await TontineMember.create({ ...m.toObject(), _id: undefined, tontineId: newT._id });
    return newT;
  }

  static async sendMessage(
    tontineId: string,
    senderId: string,
    content: string,
    type: any = 'text',
  ) {
    return await TontineMessage.create({ tontineId, senderId, content, type });
  }

  static async getMessages(tontineId: string) {
    return await TontineMessage.find({ tontineId })
      .populate('senderId', 'firstName lastName')
      .sort({ createdAt: -1 });
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
            const tx = await WalletService.executeTransaction({
              userId: member.userId.toString(),
              amount: amounts.convertedAmount,
              type: 'tontine_contribution',
              description: `Cotisation : ${tontine.name}`,
              paymentMethod: 'wallet',
            });
            await TontineContribution.create({
              tontineId: tontine._id,
              memberId: member._id,
              turnIndex: tontine.currentTurn,
              amountPaid: amounts.convertedAmount,
              currency: amounts.currency,
              paidAt: new Date(),
              validationStatus: 'completed',
              transactionRef: tx.reference,
            });
            await InvoiceService.generateForTransaction(tx._id.toString());
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
    const contributions = await TontineContribution.find({ tontineId: id });
    return { tontine, members, contributions };
  }

  static async getTontineMembers(tontineId: string) {
    return TontineMember.find({ tontineId }).populate('userId', 'firstName lastName');
  }

  static async createVote(
    tontineId: string,
    creatorId: string,
    question: string,
    options: string[],
    durationHours: number,
  ) {
    return TontineVote.create({
      tontineId,
      creatorId,
      question,
      options: options.map((o) => ({ text: o, count: 0 })),
      expiresAt: new Date(Date.now() + durationHours * 3600000),
    });
  }

  static async castVote(userId: string, voteId: string, optionIndex: number) {
    const vote = await TontineVote.findById(voteId);
    if (!vote) throw new AppError('Vote non trouvé', 404);
    if (vote.voters.includes(userId as any)) throw new AppError('Déjà voté', 400);

    vote.options[optionIndex].count += 1;
    vote.voters.push(userId as any);
    await vote.save();
    return vote;
  }

  static async exportTontineReport(tontineId: string, turn?: number) {
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
    return parser.parse(contributions);
  }

  static async getTontineContributions(tontineId: string, userId: string) {
    const tontine = await Tontine.findById(tontineId);
    if (!tontine || tontine.creatorId.toString() !== userId)
      throw new AppError('Non autorisé', 403);
    return TontineContribution.find({ tontineId })
      .populate('memberId', 'displayName')
      .sort({ createdAt: -1 });
  }

  static async enforcePremiumLimits(userId: string) {
    const user = await User.findById(userId);
    if (user?.subscription.plan === 'free') {
      await Tontine.updateMany(
        { creatorId: userId, status: 'active' },
        { $set: { status: 'suspended_premium_required' } },
      );
    }
  }
}
