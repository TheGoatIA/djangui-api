import mongoose from 'mongoose';
import crypto from 'crypto';
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
  static async createTontine(userId: string, data: Partial<ITontine>): Promise<ITontine> {
    // Wrapped in a transaction so the free-tier "1 active tontine" count-then-create
    // can't be raced by two concurrent create requests both passing the check.
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const user = await User.findById(userId).session(session);
      if (!user) throw new AppError('Utilisateur non trouvé', 404);

      const activeCount = await Tontine.countDocuments({
        creatorId: userId,
        status: { $ne: 'completed' },
      }).session(session);
      const isPremium = user.subscription?.plan === 'premium';

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

      await session.commitTransaction();
      return tontine;
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  /**
   * Rejoindre une tontine
   */
  static async joinTontine(
    userId: string,
    inviteCode: string,
    data: { displayName: string; parts: number; payoutDetails?: any },
  ): Promise<any> {
    // Wrapped in a transaction: the free-tier count check, the member-already-in-tontine
    // check, and the remaining-slots check must all be consistent with the actual insert,
    // otherwise two concurrent joins can both pass and over-fill the tontine or the
    // free-tier limit.
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const tontine = await Tontine.findOne({ inviteCode }).session(session);
      if (!tontine) throw new AppError('Tontine non trouvée', 404);
      if (tontine.status !== 'pending') throw new AppError('Les adhésions sont fermées', 400);

      const user = await User.findById(userId).session(session);
      if (!user) throw new AppError('Utilisateur non trouvé', 404);

      const isPremium = user.subscription?.plan === 'premium';
      if (!isPremium) {
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

      const requestedParts = data.parts || 1;
      const existingMembers = await TontineMember.find({
        tontineId: tontine._id,
        invitationStatus: 'accepted',
      }).session(session);
      if (existingMembers.some((m) => m.userId.toString() === userId)) {
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

      const member = (
        await TontineMember.create(
          [
            {
              tontineId: tontine._id,
              userId: userId,
              displayName: data.displayName,
              parts: requestedParts,
              payoutDetails: data.payoutDetails,
              invitationStatus: 'accepted',
              joinedAt: new Date(),
            },
          ],
          { session },
        )
      )[0];

      await session.commitTransaction();

      NotificationService.sendToUser(tontine.creatorId.toString(), {
        title: '',
        body: '',
        translationKey: 'TONTINE_JOIN',
        translationData: { name: data.displayName, tontineName: tontine.name },
        category: 'important',
      }).catch((err) => logger.error(`Tontine join notification error: ${err.message}`));

      return member;
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  static async updateTontine(
    tontineId: string,
    userId: string,
    data: Partial<ITontine>,
  ): Promise<ITontine> {
    const tontine = await Tontine.findById(tontineId);
    if (!tontine) throw new AppError('Tontine non trouvée', 404);
    if (tontine.creatorId.toString() !== userId) throw new AppError('Action non autorisée', 403);

    // Sécurité Fintech (F03) : currentTurn, status, creatorId, etc. sont immuables via update client
    const ALWAYS_FORBIDDEN = ['currentTurn', 'status', 'creatorId', 'inviteCode', 'rotationMode'];
    if (Object.keys(data).some((f) => ALWAYS_FORBIDDEN.includes(f))) {
      throw new AppError('Ce champ ne peut pas être modifié directement', 400);
    }

    if (tontine.status === 'active') {
      const forbiddenWhenActive = ['contributionAmount', 'currency', 'totalParts', 'frequency'];
      if (Object.keys(data).some((f) => forbiddenWhenActive.includes(f))) {
        throw new AppError('Modification interdite une fois lancée', 400);
      }
    }

    const ALLOWED = [
      'name',
      'description',
      'category',
      'rules',
      'sanctions',
      'socialFund',
      'escrowDetails',
      'autoRenew',
      'rulesAcceptedByAll',
      'contributionAmount',
      'currency',
      'totalParts',
      'frequency',
      'startDate',
    ];

    for (const key of Object.keys(data)) {
      if (ALLOWED.includes(key)) {
        (tontine as any)[key] = (data as any)[key];
      }
    }

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
    if (!member) throw new AppError('Membre non trouvé', 404);
    if (member.userId.toString() === creatorId)
      throw new AppError("Le créateur ne peut s'auto-retirer", 400);

    // Once the tontine is active, every accepted member has a `rotationOrder`
    // assigned by startTontine — removing ANY of them (not just one whose turn
    // already happened) leaves that turn number permanently without an owner.
    // rotateTurn/processAutoDebits would then still collect contributions for
    // that turn from the remaining members but never find a winner to pay out,
    // silently stranding the collected funds. So membership is locked for
    // anyone already in the rotation once the tontine has started.
    if (tontine.status === 'active' && (member as any).rotationOrder != null) {
      throw new AppError(
        "Ce membre ne peut pas être retiré : la tontine est active et son tour de versement est déjà planifié. Attendez la fin du cycle, ou contactez le support pour un remboursement manuel.",
        400,
      );
    }

    await TontineMember.findByIdAndDelete(memberId);
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

    // Attribution rotation avec Fisher-Yates cryptographique
    if (tontine.rotationMode === 'random') {
      for (let i = members.length - 1; i > 0; i--) {
        const j = crypto.randomInt(0, i + 1);
        [members[i], members[j]] = [members[j], members[i]];
      }
    }
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
      const winner = members.find((m) => (m as any).rotationOrder === tontine.currentTurn);

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
          SlackService.sendNotification(
            `🚨 Tontine "${tontine.name}" (${tontineId}), tour ${tontine.currentTurn} : aucun gagnant trouvé alors que ${summary.collectedAmount} ${tontine.currency} ont été collectés. Intervention manuelle requise (remboursement des cotisants).`,
            true,
          ).catch(() => {});
        }
      } else {
        const summary = await this.getTurnSummary(tontineId);
        if (summary.collectedAmount > 0) {
          const kauriFee = Math.floor(summary.collectedAmount * 0.01);
          // Référence déterministe : si ce même tour est traité deux fois en
          // parallèle, l'index unique sur Transaction.reference rejette la
          // seconde tentative au lieu de payer le gagnant deux fois.
          const payoutReference = `TONTINE-PAYOUT-${tontine._id}-T${tontine.currentTurn}`;
          transaction = await WalletService.executeTransaction(
            {
              userId: winner.userId.toString(),
              amount: summary.collectedAmount,
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
            `Tontine ${tontineId} tour ${tontine.currentTurn} : aucun fond collecté, versement ignoré.`,
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
      result.transaction._postCommit?.().catch((err: any) =>
        logger.error(`Post-commit hook error: ${err.message}`),
      );
      InvoiceService.generateForTransaction(result.transaction._id.toString()).catch((err: any) =>
        logger.error(`Invoice generation error: ${err.message}`),
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
        SlackService.sendNotification(
          `🚨 Le renouvellement automatique de la tontine "${result.tontine.name}" (${tontineId}) a échoué : ${err.message}`,
          true,
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
      startDate: undefined,
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
          decision === 'approve' ? 'TONTINE_CONTRIBUTION_VALIDATED' : 'TONTINE_CONTRIBUTION_REJECTED',
        translationData: { turn: contribution.turnIndex, tontineName: tontine.name },
        data: {
          tontineId,
          type: decision === 'approve' ? 'TONTINE_CONTRIBUTION_VALIDATED' : 'TONTINE_CONTRIBUTION_REJECTED',
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
  ) {
    await this.assertIsMember(tontineId, senderId);
    return await TontineMessage.create({ tontineId, senderId, content, type });
  }

  static async getMessages(tontineId: string, userId: string) {
    await this.assertIsMember(tontineId, userId);
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
                    transactionRef: tx.reference,
                  },
                ],
                { session },
              );

              return { tx, contribution };
            });

            if (result) {
              (result.tx as any)._postCommit?.().catch((err: any) =>
                logger.error(`Post-commit hook error: ${err.message}`),
              );
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
    const contributions = await TontineContribution.find({ tontineId: id });
    return { tontine, members, contributions };
  }

  static async getTontineMembers(tontineId: string, userId: string) {
    await this.assertIsMember(tontineId, userId);
    return TontineMember.find({ tontineId }).populate('userId', 'firstName lastName');
  }

  static async createVote(
    tontineId: string,
    creatorId: string,
    question: string,
    options: string[],
    durationHours: number,
  ) {
    await this.assertIsMember(tontineId, creatorId);
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
    await this.assertIsMember(vote.tontineId.toString(), userId);
    // `voters` holds Mongoose ObjectIds; userId here is a plain string. Array.includes
    // compares objects by reference, so it never matched — every member could vote
    // an unlimited number of times. Compare by string value instead.
    if (vote.voters.some((v) => v.toString() === userId)) throw new AppError('Déjà voté', 400);
    if (
      !Number.isInteger(optionIndex) ||
      optionIndex < 0 ||
      optionIndex >= vote.options.length
    ) {
      throw new AppError('Option de vote invalide', 400);
    }
    if (vote.status === 'closed' || vote.expiresAt < new Date()) {
      throw new AppError('Ce vote est clos', 400);
    }

    vote.options[optionIndex].count += 1;
    vote.voters.push(userId as any);
    await vote.save();
    return vote;
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
