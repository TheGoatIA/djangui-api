import Tontine, { ITontine } from '../models/Tontine';
import TontineMember from '../models/TontineMember';
import TontineAuction from '../models/TontineAuction';
import TontineContribution from '../models/TontineContribution';
import TontineMessage from '../models/TontineMessage';
import TontineVote from '../models/TontineVote';
import User from '../models/User';
import { AppError } from '../middleware/errorHandler';
// import mongoose from 'mongoose'; // Unused for now
import { Parser } from 'json2csv';
import { CurrencyService } from './currencyService';
import { NotificationService } from './notificationService';
import { SlackService } from './slackService';
// import logger from '../utils/logger'; // Unused for now

export class TontineService {
  /**
   * Créer une nouvelle tontine
   */
  static async createTontine(userId: string, data: Partial<ITontine>): Promise<ITontine> {
    const user = await User.findById(userId);
    if (!user) throw new AppError('Utilisateur non trouvé', 404);

    // Vérifier les limitations Premium
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

    // Le créateur est automatiquement membre (avec 1 part par défaut)
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
   * Rejoindre une tontine via code d'invitation
   */
  static async joinTontine(
    userId: string,
    inviteCode: string,
    data: { displayName: string; parts: number; payoutDetails?: any },
  ): Promise<any> {
    const tontine = await Tontine.findOne({ inviteCode });
    if (!tontine) throw new AppError('Tontine non trouvée ou code invalide', 404);
    if (tontine.status !== 'pending')
      throw new AppError('Les adhésions sont fermées pour cette tontine', 400);

    const user = await User.findById(userId);
    if (!user) throw new AppError('Utilisateur non trouvé', 404);

    // Vérifier les limitations d'adhésion pour les non-premium
    const isPremium = user.subscription?.plan === 'premium';
    if (!isPremium) {
      const memberships = await TontineMember.find({ userId, invitationStatus: 'accepted' }).select(
        'tontineId',
      );
      const tontineIds = memberships.map((m) => m.tontineId);

      const activeCount = await Tontine.countDocuments({
        _id: { $in: tontineIds },
        status: { $ne: 'completed' },
      });

      if (activeCount >= 3) {
        throw new AppError(
          'Les utilisateurs gratuits ne peuvent rejoindre que 3 tontines actives simultanément. Passez au Premium pour un accès illimité !',
          403,
        );
      }
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

    // Notification au créateur
    await NotificationService.sendToUser(tontine.creatorId.toString(), {
      title: '',
      body: '',
      translationKey: 'TONTINE_JOIN',
      translationData: { name: data.displayName, tontineName: tontine.name },
      data: { tontineId: tontine._id.toString(), type: 'TONTINE_JOIN' },
    });

    return member;
  }

  /**
   * Modifier une tontine (Paramètres)
   */
  static async updateTontine(
    tontineId: string,
    userId: string,
    data: Partial<ITontine>,
  ): Promise<ITontine> {
    const tontine = await Tontine.findById(tontineId);
    if (!tontine) throw new AppError('Tontine non trouvée', 404);
    if (tontine.creatorId.toString() !== userId)
      throw new AppError('Seul le créateur peut modifier la tontine', 403);
    if (tontine.status === 'completed')
      throw new AppError('Impossible de modifier une tontine terminée', 400);

    // Champs modifiables restreints si active
    if (tontine.status === 'active') {
      const forbiddenFields = ['contributionAmount', 'currency', 'totalParts', 'frequency'];
      const attemptedFields = Object.keys(data);
      const hasForbidden = attemptedFields.some((f) => forbiddenFields.includes(f));
      if (hasForbidden)
        throw new AppError(
          'Certains paramètres (montant, devise, parts, fréquence) ne peuvent plus être modifiés une fois la tontine lancée',
          400,
        );
    }

    Object.assign(tontine, data);
    await tontine.save();
    return tontine;
  }

  /**
   * Supprimer ou Clôturer une tontine
   */
  static async deleteTontine(tontineId: string, userId: string): Promise<void> {
    const tontine = await Tontine.findById(tontineId);
    if (!tontine) throw new AppError('Tontine non trouvée', 404);
    if (tontine.creatorId.toString() !== userId) throw new AppError('Action non autorisée', 403);

    if (tontine.status === 'pending') {
      // Suppression physique si pas encore démarrée
      await TontineMember.deleteMany({ tontineId });
      await Tontine.findByIdAndDelete(tontineId);
    } else {
      // Clôture forcée si active
      tontine.status = 'completed';
      await tontine.save();
    }
  }

  /**
   * Retirer un membre de la tontine
   */
  static async removeMember(tontineId: string, creatorId: string, memberId: string): Promise<void> {
    const tontine = await Tontine.findById(tontineId);
    if (!tontine) throw new AppError('Tontine non trouvée', 404);
    if (tontine.creatorId.toString() !== creatorId) throw new AppError('Action non autorisée', 403);
    if (tontine.status !== 'pending')
      throw new AppError("Impossible de retirer un membre d'une tontine en cours", 400);

    const member = await TontineMember.findById(memberId);
    if (!member) throw new AppError('Membre non trouvé', 404);
    if (member.userId.toString() === creatorId)
      throw new AppError(
        'Le créateur ne peut pas se retirer lui-même via cette méthode. Supprimez la tontine si nécessaire.',
        400,
      );

    await TontineMember.findByIdAndDelete(memberId);
  }

  /**
   * Calculer la date limite d'un tour
   */
  static getTurnDeadline(startDate: Date, frequency: string, turnIndex: number): Date {
    const deadline = new Date(startDate);
    const daysToAdd = frequency === 'weekly' ? 7 : frequency === 'bi-weekly' ? 14 : 30;
    deadline.setDate(deadline.getDate() + turnIndex * daysToAdd);
    return deadline;
  }

  /**
   * Calculer le montant converti pour un membre (incluant les amendes éventuelles)
   */
  static async getMemberContributionAmount(
    tontineId: string,
    userId: string,
  ): Promise<{ baseAmount: number; convertedAmount: number; currency: string; lateFee: number }> {
    const tontine = await Tontine.findById(tontineId);
    if (!tontine) throw new AppError('Tontine non trouvée', 404);

    const member = await TontineMember.findOne({ tontineId, userId });
    if (!member) throw new AppError('Membre non trouvé', 404);

    const user = await User.findById(userId);
    const userCurrency = user?.currency || 'XAF';

    const baseAmount = tontine.contributionAmount * member.parts;

    // Vérifier si un retard est déjà détecté (si le tour est en cours)
    let lateFee = 0;
    const deadline = this.getTurnDeadline(
      tontine.startDate,
      tontine.frequency,
      tontine.currentTurn,
    );
    const now = new Date();
    const gracePeriodMs = tontine.sanctions.gracePeriodHours * 3600000;

    if (now.getTime() > deadline.getTime() + gracePeriodMs) {
      lateFee = tontine.sanctions.lateFee * member.parts;
    }

    const totalBase = baseAmount + lateFee;
    const rate = CurrencyService.getRate(tontine.currency, userCurrency);
    const convertedAmount = Math.ceil(totalBase * rate);

    return {
      baseAmount,
      convertedAmount,
      currency: userCurrency,
      lateFee,
    };
  }

  /**
   * Mettre à jour le Trust Score d'un membre
   */
  static async updateTrustScore(memberId: string, isLate: boolean): Promise<void> {
    const member = await TontineMember.findById(memberId);
    if (!member) return;

    if (isLate) {
      member.trustScore = Math.max(0, member.trustScore - 5);
    } else {
      member.trustScore = Math.min(100, member.trustScore + 1);
    }

    await member.save();
  }

  /**
   * Calculer le résumé du tour actuel (Cumul récolté)
   */
  static async getTurnSummary(tontineId: string): Promise<{
    collectedAmount: number;
    expectedAmount: number;
    contributorsCount: number;
    totalMembers: number;
  }> {
    const tontine = await Tontine.findById(tontineId);
    if (!tontine) throw new AppError('Tontine non trouvée', 404);

    const members = await TontineMember.find({ tontineId, invitationStatus: 'accepted' });
    const contributions = await TontineContribution.find({
      tontineId,
      turnIndex: tontine.currentTurn,
      validationStatus: { $in: ['ai_validated', 'completed'] },
    });

    const collectedAmount = contributions.reduce((sum, c) => sum + c.amountPaid, 0);
    const expectedPerName = tontine.contributionAmount;
    const totalNames = members.reduce((sum, m) => sum + m.parts, 0);
    const expectedAmount = expectedPerName * totalNames;

    return {
      collectedAmount,
      expectedAmount,
      contributorsCount: contributions.length,
      totalMembers: members.length,
    };
  }

  /**
   * Lancer la tontine (Passer de pending à active)
   */
  static async startTontine(tontineId: string, creatorId: string): Promise<ITontine> {
    const tontine = await Tontine.findById(tontineId);
    if (!tontine) throw new AppError('Tontine non trouvée', 404);
    if (tontine.creatorId.toString() !== creatorId) throw new AppError('Action non autorisée', 403);

    const members = await TontineMember.find({ tontineId, invitationStatus: 'accepted' });
    if (members.length < 2)
      throw new AppError('Il faut au moins 2 membres pour démarrer une tontine', 400);

    // 1. Ajustement automatique du nombre de parts (Flexibilité)
    const actualTotalParts = members.reduce((sum, m) => sum + m.parts, 0);
    if (tontine.totalParts !== actualTotalParts) {
      tontine.totalParts = actualTotalParts;
    }

    // 2. Attribution des ordres de passage (Si Fixed ou Random)
    if (tontine.rotationMode === 'random') {
      // Mélanger les membres
      for (let i = members.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [members[i], members[j]] = [members[j], members[i]];
      }
    }
    // Pour 'fixed', on garde l'ordre d'arrivée (déjà trié par défaut ou par base de données) ou on pourrait trier par joinedAt

    // Sauvegarder l'ordre
    let currentOrder = 1;
    for (const member of members) {
      member.rotationOrder = currentOrder;
      // Si un membre a plusieurs parts, il prendra plusieurs "tours" de suite ou espacés ?
      // Simplification V1 : L'ordre est par membre. La logique de rotation devra gérer les parts multiples.
      // Pour l'instant on assigne juste un ordre séquentiel aux membres.
      await member.save();
      currentOrder++;
    }

    tontine.status = 'active';
    tontine.startDate = new Date();
    await tontine.save();

    // Notification à tous les membres
    for (const m of members) {
      await NotificationService.sendToUser(m.userId.toString(), {
        title: '',
        body: '',
        translationKey: 'TONTINE_STARTED',
        translationData: { tontineName: tontine.name },
        data: { tontineId: tontine._id.toString(), type: 'TONTINE_STARTED' },
      });
    }

    // Notify Slack
    SlackService.sendNotification(
      `🚀 *Tontine Started*\n*Name*: ${tontine.name}\n*Members*: ${members.length}\n*Total Parts*: ${tontine.totalParts}`,
    );

    return tontine;
  }

  /**
   * Ouvrir les enchères pour le tour actuel
   */
  static async openAuction(tontineId: string): Promise<any> {
    const tontine = await Tontine.findById(tontineId);
    if (!tontine || tontine.rotationMode !== 'auction') {
      throw new AppError("Cette tontine n'accepte pas les enchères", 400);
    }

    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 48); // 48h

    return await TontineAuction.create({
      tontineId,
      turnIndex: tontine.currentTurn,
      expiresAt,
    });
  }

  /**
   * Placer une enchère
   */
  static async placeBid(userId: string, tontineId: string, amount: number): Promise<any> {
    const member = await TontineMember.findOne({ tontineId, userId });
    if (!member) throw new AppError('Membre non trouvé', 404);

    const auction = await TontineAuction.findOne({ tontineId, status: 'open' });
    if (!auction) throw new AppError('Aucune enchère en cours', 404);

    auction.bids.push({
      memberId: member._id as any,
      amount,
      bidAt: new Date(),
    });

    await auction.save();
    return auction;
  }

  /**
   * Passer au tour suivant (Rotation)
   */
  static async rotateTurn(tontineId: string): Promise<ITontine> {
    const tontine = await Tontine.findById(tontineId);
    if (!tontine) throw new AppError('Tontine non trouvée', 404);

    tontine.currentTurn += 1;
    if (tontine.currentTurn > tontine.totalParts) {
      tontine.status = 'completed';

      // Notify Slack
      SlackService.sendNotification(
        `🎉 *Tontine Completed Successfully*\n*Name*: ${tontine.name}\n*Total Parts*: ${tontine.totalParts}\n*Creator ID*: ${tontine.creatorId}`,
      );

      // Gérer la reconduction automatique
      if (tontine.autoRenew) {
        await this.renewTontine(tontine);
      }
    }

    await tontine.save();

    // Notification à tous les membres pour le nouveau tour
    const members = await TontineMember.find({ tontineId, invitationStatus: 'accepted' });
    for (const m of members) {
      if (tontine.status === 'completed') {
        await NotificationService.sendToUser(m.userId.toString(), {
          title: '',
          body: '',
          translationKey: 'TONTINE_COMPLETED',
          translationData: { tontineName: tontine.name },
          data: { tontineId: tontine._id.toString(), type: 'TONTINE_ROTATION' },
        });
      } else {
        await NotificationService.sendToUser(m.userId.toString(), {
          title: '',
          body: '',
          translationKey: 'TONTINE_NEW_TURN',
          translationData: { turn: tontine.currentTurn },
          data: { tontineId: tontine._id.toString(), type: 'TONTINE_ROTATION' },
        });
      }
    }

    return tontine;
  }

  /**
   * Reconduire une tontine terminée
   */
  static async renewTontine(oldTontine: ITontine): Promise<ITontine> {
    const newTontine = await Tontine.create({
      name: `${oldTontine.name} (Nouveau Cycle)`,
      creatorId: oldTontine.creatorId,
      frequency: oldTontine.frequency,
      startDate: new Date(),
      contributionAmount: oldTontine.contributionAmount,
      currency: oldTontine.currency,
      totalParts: oldTontine.totalParts,
      rotationMode: oldTontine.rotationMode,
      validationMode: oldTontine.validationMode,
      sanctions: oldTontine.sanctions,
      socialFund: oldTontine.socialFund,
      escrowDetails: oldTontine.escrowDetails,
      autoRenew: oldTontine.autoRenew,
    });

    // Copier les membres
    const oldMembers = await TontineMember.find({
      tontineId: oldTontine._id,
      invitationStatus: 'accepted',
    });
    for (const m of oldMembers) {
      await TontineMember.create({
        tontineId: newTontine._id,
        userId: m.userId,
        displayName: m.displayName,
        parts: m.parts,
        payoutDetails: m.payoutDetails,
        invitationStatus: 'accepted',
      });
    }

    return newTontine;
  }

  /**
   * Obtenir des statistiques globales pour l'admin
   */
  static async getGlobalStats(): Promise<any> {
    const totalTontines = await Tontine.countDocuments();
    const activeTontines = await Tontine.countDocuments({ status: 'active' });

    const contributions = await TontineContribution.aggregate([
      { $match: { validationStatus: 'completed' } },
      {
        $group: {
          _id: null,
          totalVolume: { $sum: '$amountPaid' },
          totalLateFees: { $sum: '$lateFeesApplied' },
        },
      },
    ]);

    const totalVolume = contributions[0]?.totalVolume || 0;
    const totalLateFees = contributions[0]?.totalLateFees || 0;

    const latePayments = await TontineContribution.countDocuments({ lateFeesApplied: { $gt: 0 } });
    const totalPayments = await TontineContribution.countDocuments({
      validationStatus: 'completed',
    });
    const lateRate = totalPayments > 0 ? (latePayments / totalPayments) * 100 : 0;

    return {
      totalTontines,
      activeTontines,
      totalVolume,
      totalLateFees,
      lateRate,
    };
  }

  /**
   * Lister toutes les tontines (Admin)
   */
  static async listAllTontines(): Promise<ITontine[]> {
    return await Tontine.find()
      .populate('creatorId', 'firstName lastName email')
      .sort({ createdAt: -1 });
  }

  /**
   * Obtenir les détails complets d'une tontine pour l'administration
   */
  static async getAdminTontineDetails(tontineId: string): Promise<any> {
    const tontine = await Tontine.findById(tontineId).populate(
      'creatorId',
      'firstName lastName email',
    );
    if (!tontine) throw new AppError('Tontine non trouvée', 404);

    const [members, contributions, messages, votes, auctions] = await Promise.all([
      TontineMember.find({ tontineId }).populate('userId', 'firstName lastName email'),
      TontineContribution.find({ tontineId }).sort({ createdAt: -1 }),
      TontineMessage.find({ tontineId }).populate('senderId', 'firstName lastName').sort({ createdAt: 1 }),
      TontineVote.find({ tontineId }).sort({ createdAt: -1 }),
      TontineAuction.find({ tontineId }).sort({ createdAt: -1 }),
    ]);

    return {
      tontine,
      members,
      contributions,
      messages,
      votes,
      auctions,
    };
  }

  /**
   * Envoyer un message dans le tchat de la tontine
   */
  static async sendMessage(
    tontineId: string,
    senderId: string,
    content: string,
    type: 'text' | 'image' = 'text',
  ): Promise<any> {
    return await TontineMessage.create({
      tontineId,
      senderId,
      content,
      type,
    });
  }

  /**
   * Récupérer les messages d'une tontine
   */
  static async getMessages(tontineId: string, limit: number = 50): Promise<any[]> {
    return await TontineMessage.find({ tontineId })
      .populate('senderId', 'firstName lastName profilePicture')
      .sort({ createdAt: -1 })
      .limit(limit);
  }

  /**
   * Exporter le rapport de tontine en CSV (Global ou par Tour)
   */
  static async exportTontineReport(tontineId: string, turnIndex?: number): Promise<string> {
    const query: any = { tontineId, validationStatus: 'completed' };
    if (turnIndex !== undefined) {
      query.turnIndex = turnIndex;
    }

    const contributions = await TontineContribution.find(query)
      .populate('memberId', 'displayName')
      .sort({ turnIndex: 1 });

    const data = contributions.map((c) => ({
      Tour: c.turnIndex,
      Membre: (c.memberId as any).displayName,
      Montant: c.amountPaid,
      Devise: c.currency,
      Date: c.paidAt.toISOString().split('T')[0],
      Reference: c.transactionRef,
      Statut: c.validationStatus,
    }));

    const json2csvParser = new Parser();
    return json2csvParser.parse(data);
  }

  /**
   * Obtenir les membres d'une tontine
   */
  static async getTontineMembers(tontineId: string): Promise<any[]> {
    return await TontineMember.find({ tontineId, invitationStatus: 'accepted' })
      .populate('userId', 'firstName lastName profilePicture')
      .sort({ trustScore: -1 });
  }

  /**
   * Créer un vote (Gouvernance)
   */
  static async createVote(
    tontineId: string,
    creatorId: string,
    question: string,
    options: string[],
    durationHours: number = 48,
  ): Promise<any> {
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + durationHours);

    return await TontineVote.create({
      tontineId,
      creatorId,
      question,
      options: options.map((o) => ({ text: o, count: 0 })),
      expiresAt,
    });
  }

  /**
   * Voter
   */
  static async castVote(userId: string, voteId: string, optionIndex: number): Promise<any> {
    const vote = await TontineVote.findById(voteId);
    if (!vote || vote.status === 'closed' || new Date() > vote.expiresAt) {
      throw new AppError('Vote non trouvé ou expiré', 404);
    }

    if (vote.voters.includes(userId as any)) {
      throw new AppError('Vous avez déjà voté', 400);
    }

    vote.options[optionIndex].count += 1;
    vote.voters.push(userId as any);
    await vote.save();
    return vote;
  }

  /**
   * Vérifier et appliquer les limites Premium (Suspension automatique)
   * Cette méthode est appelée lors de la connexion ou d'actions critiques.
   */
  static async enforcePremiumLimits(userId: string): Promise<void> {
    const user = await User.findById(userId);
    if (!user) return;

    const isPremium = user.subscription?.plan === 'premium';
    const activeTontines = await Tontine.find({
      creatorId: userId,
      status: { $in: ['active', 'pending', 'suspended_premium_required'] },
    }).sort({ createdAt: 1 }); // On garde les plus anciennes

    if (!isPremium && activeTontines.length > 1) {
      // Suspendre toutes sauf la première
      for (let i = 1; i < activeTontines.length; i++) {
        if (activeTontines[i].status !== 'suspended_premium_required') {
          activeTontines[i].status = 'suspended_premium_required';
          await activeTontines[i].save();
        }
      }
    } else if (isPremium) {
      // Réactiver les tontines suspendues si l'utilisateur est repassé Premium
      for (const tontine of activeTontines) {
        if (tontine.status === 'suspended_premium_required') {
          // On remet en 'active' ou 'pending' selon si elle avait commencé (on simplifie en active/pending selon startDate)
          tontine.status = tontine.startDate ? 'active' : 'pending';
          await tontine.save();
        }
      }
    }
  }

  /**
   * Obtenir toutes les contributions d'une tontine (Reçus)
   * Accessible au créateur pour le suivi et la validation manuelle
   */
  static async getTontineContributions(tontineId: string, userId: string): Promise<any[]> {
    const tontine = await Tontine.findById(tontineId);
    if (!tontine) throw new AppError('Tontine non trouvée', 404);

    // Seul le créateur peut consulter tous les reçus pour l'instant (Suivi)
    if (tontine.creatorId.toString() !== userId) {
      throw new AppError("Seul le créateur peut consulter l'historique complet des reçus.", 403);
    }

    return await TontineContribution.find({ tontineId })
      .populate('memberId', 'displayName')
      .sort({ turnIndex: -1, paidAt: -1 });
  }

  /**
   * Obtenir les tontines de l'utilisateur (Membre ou Créateur)
   */
  static async getUserTontines(userId: string): Promise<any[]> {
    // 1. Trouver toutes les adhésions de l'utilisateur
    const memberships = await TontineMember.find({ userId }).select(
      'tontineId invitationStatus parts',
    );

    if (memberships.length === 0) return [];

    const tontineIds = memberships.map((m) => m.tontineId);

    // 2. Récupérer les détails des tontines
    const tontines = await Tontine.find({ _id: { $in: tontineIds } })
      .populate('creatorId', 'firstName lastName')
      .sort({ updatedAt: -1 });

    // 3. Fusionner les infos (statut membre + infos tontine)
    return tontines.map((tontine) => {
      const membership = memberships.find((m) => m.tontineId.toString() === tontine._id.toString());
      return {
        ...tontine.toObject(),
        userMembership: {
          status: membership?.invitationStatus,
          parts: membership?.parts,
        },
      };
    });
  }
}
