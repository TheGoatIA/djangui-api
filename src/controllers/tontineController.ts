import { Request, Response, NextFunction } from 'express';
import { TontineService } from '../services/tontineService';
import { TontineAIService, TontineAIUnavailableError } from '../services/ai/tontineAIService';
import { NotificationService } from '../services/notificationService';
import TontineContribution from '../models/TontineContribution';
import Tontine from '../models/Tontine';
import TontineMember from '../models/TontineMember';
import { AppError } from '../middleware/errorHandler';
import logger from '../utils/logger';
import { MonitoringService } from '../services/monitoringService';
import { StorageService } from '../services/storageService';
import fs from 'fs';

export class TontineController {
  /**
   * Créer une tontine
   */
  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const tontine = await TontineService.createTontine((req as any).user.id, req.body);

      // Metrique business
      MonitoringService.recordTontineAction('create');

      res.status(201).json({ status: 'success', data: tontine });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Modifier une tontine
   */
  static async update(req: Request, res: Response, next: NextFunction) {
    try {
      const tontine = await TontineService.updateTontine(
        req.params.id,
        (req as any).user.id,
        req.body,
      );
      res.json({ status: 'success', data: tontine });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Supprimer une tontine
   */
  static async delete(req: Request, res: Response, next: NextFunction) {
    try {
      await TontineService.deleteTontine(req.params.id, (req as any).user.id);
      res.json({ status: 'success', message: 'Tontine supprimée ou clôturée avec succès' });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Rejoindre une tontine
   */
  static async join(req: Request, res: Response, next: NextFunction) {
    try {
      const { inviteCode, displayName, parts } = req.body;

      // On vérifie les limites du créateur avant de laisser quelqu'un rejoindre
      const tontine = await Tontine.findOne({ inviteCode });
      if (tontine && tontine.status === 'suspended_premium_required') {
        throw new AppError(
          'Les adhésions sont bloquées car le créateur doit renouveler son abonnement Premium.',
          403,
        );
      }

      const member = await TontineService.joinTontine((req as any).user.id, inviteCode, {
        displayName,
        parts,
      });

      // Metrique business
      MonitoringService.recordTontineAction('join');

      res.status(200).json({ status: 'success', data: member });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Soumettre une contribution avec preuve (Screenshot)
   */
  static async contribute(req: Request, res: Response, next: NextFunction) {
    try {
      const { tontineId, amount } = req.body;
      const file = req.file;

      if (!file) throw new AppError('Le reçu de paiement est obligatoire', 400);

      const tontine = await Tontine.findById(tontineId);
      if (!tontine) throw new AppError('Tontine non trouvée', 404);

      if (tontine.status === 'suspended_premium_required') {
        throw new AppError(
          'Cette tontine est suspendue car votre abonnement Premium a expiré.',
          403,
        );
      }
      if (tontine.status === 'suspended') {
        throw new AppError('Cette tontine est suspendue par un administrateur.', 403);
      }

      // Le membre doit exister avant même l'analyse IA (évite de payer un appel IA
      // pour un utilisateur qui n'appartient de toute façon pas à cette tontine).
      const member = await TontineMember.findOne({
        tontineId,
        userId: (req as any).user.id,
        invitationStatus: 'accepted',
      });
      if (!member) throw new AppError("Vous n'êtes pas membre de cette tontine", 403);

      // 1. Analyse IA — si l'IA est INDISPONIBLE (panne, quota, clé absente),
      // la cotisation n'est plus refusée : elle part en validation manuelle du
      // créateur (qui voit le reçu), avec le montant attendu et aiAnalysis.unavailable.
      // Avant, une panne Gemini bloquait TOUTES les cotisations (constaté en E2E).
      let analysis: Awaited<ReturnType<typeof TontineAIService.analyzeReceipt>> | null = null;
      try {
        analysis = await TontineAIService.analyzeReceipt(file.path, tontine.currency);
      } catch (err) {
        if (!(err instanceof TontineAIUnavailableError)) throw err;
      }

      // 2. Vérification Anti-Fraude (Doublon) — par référence détectée ET par empreinte
      // du fichier, car un reçu illisible retombe sur une référence "UNKNOWN_<timestamp>"
      // qui ne collisionne jamais et laisserait le même reçu réutilisable à l'infini.
      const imageHash = TontineAIService.hashReceiptFile(file.path);
      const isDuplicate = await TontineAIService.isDuplicate(
        analysis?.transactionRef ?? `UNREAD_${imageHash}`,
        imageHash,
      );
      if (isDuplicate) {
        throw new AppError('Ce reçu a déjà été utilisé pour une autre cotisation.', 400);
      }

      // 3. Calculer le montant attendu et vérifier si en retard
      const memberInfo = await TontineService.getMemberContributionAmount(
        tontineId,
        (req as any).user.id,
      );

      // 3b. Le montant minimum est TOUJOURS vérifié, quel que soit le mode de
      // validation : un versement de vraie monnaie déclenchera plus tard un vrai
      // versement du gagnant du tour (voir rotateTurn), donc accepter un montant
      // insuffisant serait exploitable même en mode "ia_plus_manual".
      if (analysis && analysis.amount < memberInfo.convertedAmount) {
        throw new AppError(
          `Montant insuffisant. Attendu: ${memberInfo.convertedAmount} ${memberInfo.currency}, Détecté: ${analysis.amount} ${analysis.currency}`,
          400,
        );
      }

      // Validation temporelle de la date du reçu par l'IA
      const isDateValid =
        !analysis || TontineAIService.isDateValid(analysis.date, tontine.startDate);
      if (!isDateValid) {
        throw new AppError(
          'La date de ce reçu est antérieure au début de ce tour de tontine.',
          400,
        );
      }

      // 4. Téléversement vers MinIO
      const bucket = 'kauri-uploads';
      const destinationKey = `tontines/${tontineId}/${file.filename}`;
      // Private: a receipt shows names, phone numbers and amounts. It is only
      // ever served through short-lived signed URLs (TontineService.withSignedUrls).
      const minioUrl = await StorageService.uploadFile(
        file.path,
        bucket,
        destinationKey,
        'private',
      );

      // Nettoyage local immédiat
      try {
        fs.unlinkSync(file.path);
      } catch (e) {}

      // 5. Création de la contribution — TOUJOURS en attente de validation
      // manuelle par le créateur (V-01) : l'IA reste une aide à la décision
      // (aiAnalysis, affiché au créateur) mais n'est plus jamais autoritaire
      // sur un mouvement d'argent réel. Ne compte dans le pot du tour
      // (getTurnSummary) qu'une fois explicitement approuvée.
      const isLate = memberInfo.lateFee > 0;
      const contribution = await TontineContribution.create({
        tontineId,
        memberId: member._id,
        turnIndex: tontine.currentTurn,
        amountPaid: analysis ? analysis.amount : memberInfo.convertedAmount,
        currency: tontine.currency,
        proofImage: minioUrl,
        proofImageHash: imageHash,
        transactionRef: analysis?.transactionRef ?? `UNREAD_${imageHash}`,
        aiAnalysis: analysis
          ? {
              detectedAmount: analysis.amount,
              detectedDate: analysis.date,
              detectedBeneficiary: analysis.beneficiaryName,
              detectedRef: analysis.transactionRef,
              confidence: analysis.confidence,
            }
          : {
              // Aucune lecture automatique : le créateur vérifie le reçu lui-même.
              detectedAmount: 0,
              detectedRef: `UNREAD_${imageHash}`,
              detectedBeneficiary: 'Analyse IA indisponible',
              confidence: 0,
            },
        lateFeesApplied: memberInfo.lateFee,
        // Paid outside the app: tracked, never paid out from a wallet.
        source: 'receipt',
        validationStatus: 'manual_pending',
      });

      // 5. Mise à jour du Trust Score
      await TontineService.updateTrustScore(member._id.toString(), isLate);

      // 6. Notifie le créateur qu'une cotisation attend sa validation — essentiel
      // maintenant que la revue manuelle est obligatoire pour tout le monde (V-01) :
      // sans ce signal, une cotisation pourrait rester "en attente" indéfiniment.
      await NotificationService.sendToUser(tontine.creatorId.toString(), {
        title: '',
        body: '',
        translationKey: 'TONTINE_CONTRIBUTION_PENDING_REVIEW',
        translationData: { turn: tontine.currentTurn, tontineName: tontine.name },
        data: { tontineId: tontineId, type: 'TONTINE_CONTRIBUTION_PENDING_REVIEW' },
      }).catch((err: any) => logger.error(`Notification error: ${err.message}`));

      // Metrique business
      MonitoringService.recordTontineAction('contribution', isLate ? 'late' : 'success');

      res.status(201).json({
        status: 'success',
        message:
          'Cotisation reçue, en attente de validation manuelle par le créateur de la tontine.',
        data: (await TontineService.withSignedUrls([contribution], 'proofImage'))[0],
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Valider ou rejeter manuellement une cotisation en attente (mode ia_plus_manual)
   */
  static async validateContribution(req: Request, res: Response, next: NextFunction) {
    try {
      const { id, contributionId } = req.params;
      const { decision, reason } = req.body;
      if (!['approve', 'reject'].includes(decision)) {
        throw new AppError("Le champ 'decision' doit être 'approve' ou 'reject'", 400);
      }

      const contribution = await TontineService.validateContribution(
        id,
        contributionId,
        (req as any).user.id,
        decision,
        reason,
      );

      res.json({ status: 'success', data: contribution });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Force la rotation du tour courant immédiatement, sans attendre le cron
   * quotidien (03h00). Réutilise `TontineService.rotateTurn`, déjà idempotent
   * et transactionnel — un déclenchement manuel n'introduit donc aucun risque
   * de double versement, même si le cron tourne au même moment.
   */
  static async rotateTurnNow(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const tontine = await Tontine.findById(id);
      if (!tontine) throw new AppError('Tontine non trouvée', 404);
      if (tontine.creatorId.toString() !== (req as any).user.id) {
        throw new AppError('Seul le créateur de la tontine peut lancer la rotation', 403);
      }
      if (tontine.status !== 'active') {
        throw new AppError('La tontine doit être active pour lancer une rotation', 400);
      }

      const updated = await TontineService.rotateTurn(id);
      res.json({ status: 'success', data: updated });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Paiement (obligatoire, une seule fois) du fonds social par un membre.
   */
  static async paySocialFund(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const member = await TontineService.payMandatorySocialFund(id, (req as any).user.id);
      res.json({ status: 'success', data: member });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Obtenir les détails d'une tontine
   */
  static async getDetails(req: Request, res: Response, next: NextFunction) {
    try {
      // Seul un membre accepté de la tontine (créateur inclus) peut consulter ses détails.
      await TontineService.assertIsMember(req.params.id, (req as any).user.id);

      const tontine = await Tontine.findById(req.params.id).populate(
        'creatorId',
        'firstName lastName',
      );
      if (!tontine) throw new AppError('Tontine non trouvée', 404);

      // Vérification dynamique des limites du créateur
      await TontineService.enforcePremiumLimits(tontine.creatorId._id.toString());

      // Calcul du résumé du tour actuel
      const turnSummary = await TontineService.getTurnSummary(req.params.id);

      res.json({
        status: 'success',
        data: {
          ...tontine.toObject(),
          turnSummary,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Obtenir les statistiques globales (Admin seulement)
   */
  static async getAdminStats(req: Request, res: Response, next: NextFunction) {
    try {
      const stats = await TontineService.getGlobalStats();
      res.json({ status: 'success', data: stats });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Liste toutes les tontines (Admin seulement)
   */
  static async getAllTontines(req: Request, res: Response, next: NextFunction) {
    try {
      const tontines = await TontineService.listAllTontines();
      res.json({ status: 'success', data: tontines });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Rechercher les détails complets d'une tontine (Admin seulement)
   */
  static async getAdminTontineDetails(req: Request, res: Response, next: NextFunction) {
    try {
      const details = await TontineService.getAdminTontineDetails(req.params.id);
      res.json({ status: 'success', data: details });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Envoyer un message (Tchat)
   */
  static async postMessage(req: Request, res: Response, next: NextFunction) {
    try {
      const tontineId = req.params.id;
      const file = req.file;
      let { content, type } = req.body;
      let audioUrl: string | undefined;
      let audioDuration: number | undefined;

      if (file) {
        const bucket = 'kauri-uploads';
        const destinationKey = `tontines/${tontineId}/voice/${file.filename}`;
        // Private group conversation: served through signed URLs only.
        audioUrl = await StorageService.uploadFile(file.path, bucket, destinationKey, 'private');
        try {
          fs.unlinkSync(file.path);
        } catch (e) {}
        type = 'audio';
        audioDuration = req.body.duration ? Number(req.body.duration) : undefined;
        content = content || '🎤 Note vocale';
      }

      const message = await TontineService.sendMessage(
        tontineId,
        (req as any).user.id,
        content,
        type,
        audioUrl,
        audioDuration,
      );
      res.status(201).json({
        status: 'success',
        data: (await TontineService.withSignedUrls([message], 'audioUrl'))[0],
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Récupérer les messages
   */
  static async getMessages(req: Request, res: Response, next: NextFunction) {
    try {
      const messages = await TontineService.getMessages(req.params.id, (req as any).user.id);
      res.json({ status: 'success', data: messages });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Exporter le rapport CSV d'une tontine
   */
  static async exportReport(req: Request, res: Response, next: NextFunction) {
    try {
      const turn = req.query.turn ? parseInt(req.query.turn as string) : undefined;
      const csv = await TontineService.exportTontineReport(
        req.params.id,
        (req as any).user.id,
        turn,
      );
      res.header('Content-Type', 'text/csv');
      res.attachment(`tontine_report_${req.params.id}${turn ? '_turn_' + turn : ''}.csv`);
      res.send(csv);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Obtenir la liste des membres
   */
  static async getMembers(req: Request, res: Response, next: NextFunction) {
    try {
      const members = await TontineService.getTontineMembers(req.params.id, (req as any).user.id);
      res.json({ status: 'success', data: members });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Retirer un membre
   */
  static async removeMember(req: Request, res: Response, next: NextFunction) {
    try {
      await TontineService.removeMember(req.params.id, (req as any).user.id, req.params.memberId);
      res.json({ status: 'success', message: 'Membre retiré avec succès' });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Créer un vote
   */
  static async createVote(req: Request, res: Response, next: NextFunction) {
    try {
      const { question, options, durationHours, kind } = req.body;
      const vote = await TontineService.createVote(
        req.params.id,
        (req as any).user.id,
        question,
        options,
        durationHours,
        kind,
      );
      res.status(201).json({ status: 'success', data: vote });
    } catch (error) {
      next(error);
    }
  }

  /** Lister les votes d'une tontine (membres) */
  static async listVotes(req: Request, res: Response, next: NextFunction) {
    try {
      const votes = await TontineService.listVotes(req.params.id, (req as any).user.id);
      res.json({ status: 'success', data: votes });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Voter
   */
  static async castVote(req: Request, res: Response, next: NextFunction) {
    try {
      const { optionIndex } = req.body;
      const vote = await TontineService.castVote(
        (req as any).user.id,
        req.params.voteId,
        optionIndex,
      );
      res.json({ status: 'success', data: vote });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Démarrer la tontine (Passage à l'état actif)
   */
  static async start(req: Request, res: Response, next: NextFunction) {
    try {
      const tontine = await TontineService.startTontine(req.params.id, (req as any).user.id);
      res.json({ status: 'success', message: 'Tontine démarrée avec succès', data: tontine });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Obtenir toutes les contributions (Reçus) pour le créateur
   */
  static async getContributions(req: Request, res: Response, next: NextFunction) {
    try {
      const contributions = await TontineService.getTontineContributions(
        req.params.id,
        (req as any).user.id,
      );
      res.json({ status: 'success', data: contributions });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Activer/Désactiver l'auto-débit
   */
  static async toggleAutoDebit(req: Request, res: Response, next: NextFunction) {
    try {
      const { id, memberId } = req.params;
      const { enabled } = req.body;
      const member = await TontineService.toggleAutoDebit(
        id,
        memberId,
        (req as any).user.id,
        enabled,
      );
      res.json({ status: 'success', data: member });
    } catch (error) {
      next(error);
    }
  }

  /** Clôture administrative d'une tontine en cours (litige, fraude, support). */
  static async adminClose(req: Request, res: Response, next: NextFunction) {
    try {
      const tontine = await TontineService.adminCloseTontine(
        req.params.id,
        (req as any).user.id,
        req.body?.reason,
      );
      res.json({ status: 'success', data: tontine });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Obtenir la liste des tontines de l'utilisateur courant
   */
  static async getUserTontines(req: Request, res: Response, next: NextFunction) {
    try {
      const tontines = await TontineService.getUserTontines((req as any).user.id);
      res.json({ status: 'success', data: tontines });
    } catch (error) {
      next(error);
    }
  }
}

export default TontineController;
