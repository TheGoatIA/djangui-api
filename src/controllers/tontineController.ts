import { Request, Response, NextFunction } from 'express';
import { TontineService } from '../services/tontineService';
import { TontineAIService } from '../services/ai/tontineAIService';
import TontineContribution from '../models/TontineContribution';
import Tontine from '../models/Tontine';
import TontineMember from '../models/TontineMember';
import { AppError } from '../middleware/errorHandler';
import logger from '../utils/logger';

export class TontineController {
    /**
     * Créer une tontine
     */
    static async create(req: Request, res: Response, next: NextFunction) {
        try {
            const tontine = await TontineService.createTontine((req as any).user.id, req.body);
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
            const tontine = await TontineService.updateTontine(req.params.id, (req as any).user.id, req.body);
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
            const { inviteCode, displayName, parts, payoutDetails } = req.body;

            // On vérifie les limites du créateur avant de laisser quelqu'un rejoindre
            const tontine = await Tontine.findOne({ inviteCode });
            if (tontine && tontine.status === 'suspended_premium_required') {
                throw new AppError('Les adhésions sont bloquées car le créateur doit renouveler son abonnement Premium.', 403);
            }

            const member = await TontineService.joinTontine((req as any).user.id, inviteCode, { displayName, parts, payoutDetails });
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
                throw new AppError('Cette tontine est suspendue car votre abonnement Premium a expiré.', 403);
            }
            if (tontine.status === 'suspended') {
                throw new AppError('Cette tontine est suspendue par un administrateur.', 403);
            }

            // 1. Analyse IA
            const analysis = await TontineAIService.analyzeReceipt(file.path, tontine.currency);

            // 2. Vérification Anti-Fraude (Doublon)
            const isDuplicate = await TontineAIService.isDuplicate(analysis.transactionRef);
            if (isDuplicate) {
                throw new AppError('Ce reçu a déjà été utilisé pour une autre cotisation.', 400);
            }

            // 3. Calculer le montant attendu et vérifier si en retard
            const memberInfo = await TontineService.getMemberContributionAmount(tontineId, (req as any).user.id);

            // 3b. Validation STRICTE pour le mode ia_only
            if (tontine.validationMode === 'ia_only') {
                if (analysis.amount < memberInfo.convertedAmount) {
                    throw new AppError(`Montant insuffisant. Attendu: ${memberInfo.convertedAmount} ${memberInfo.currency}, Détecté: ${analysis.amount} ${analysis.currency}`, 400);
                }
                // Optionnel: Vérifier aussi la devise si nécessaire, mais convertAmount est déjà dans la devise locale du membre
            }

            // Validation temporelle de la date du reçu par l'IA
            const isDateValid = TontineAIService.isDateValid(analysis.date, tontine.startDate);
            if (!isDateValid) {
                throw new AppError('La date de ce reçu est antérieure au début de ce tour de tontine.', 400);
            }

            // Fetch the member ID
            const member = await TontineMember.findOne({ tontineId, userId: (req as any).user.id });
            if (!member) throw new AppError('Vous n\'êtes pas membre de cette tontine', 403);

            // 4. Création de la contribution
            const isLate = memberInfo.lateFee > 0;
            const contribution = await TontineContribution.create({
                tontineId,
                memberId: member._id,
                turnIndex: tontine.currentTurn,
                amountPaid: analysis.amount,
                currency: tontine.currency,
                proofImage: file.path,
                transactionRef: analysis.transactionRef,
                aiAnalysis: {
                    detectedAmount: analysis.amount,
                    detectedDate: analysis.date,
                    detectedBeneficiary: analysis.beneficiaryName,
                    detectedRef: analysis.transactionRef,
                    confidence: analysis.confidence
                },
                lateFeesApplied: memberInfo.lateFee,
                validationStatus: 'ai_validated'
            });

            // 5. Mise à jour du Trust Score
            await TontineService.updateTrustScore(member._id.toString(), isLate);

            res.status(201).json({
                status: 'success',
                message: isLate ? 'Cotisation reçue avec retard (Sanction appliquée)' : 'Cotisation validée avec succès !',
                data: contribution
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * Obtenir les détails d'une tontine
     */
    static async getDetails(req: Request, res: Response, next: NextFunction) {
        try {
            const tontine = await Tontine.findById(req.params.id).populate('creatorId', 'firstName lastName');
            if (!tontine) throw new AppError('Tontine non trouvée', 404);

            // Vérification dynamique des limites du créateur
            await TontineService.enforcePremiumLimits(tontine.creatorId._id.toString());

            // Calcul du résumé du tour actuel
            const turnSummary = await TontineService.getTurnSummary(req.params.id);

            res.json({
                status: 'success',
                data: {
                    ...tontine.toObject(),
                    turnSummary
                }
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
     * Envoyer un message (Tchat)
     */
    static async postMessage(req: Request, res: Response, next: NextFunction) {
        try {
            const { content, type } = req.body;
            const message = await TontineService.sendMessage(req.params.id, (req as any).user.id, content, type);
            res.status(201).json({ status: 'success', data: message });
        } catch (error) {
            next(error);
        }
    }

    /**
     * Récupérer les messages
     */
    static async getMessages(req: Request, res: Response, next: NextFunction) {
        try {
            const messages = await TontineService.getMessages(req.params.id);
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
            const csv = await TontineService.exportTontineReport(req.params.id, turn);
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
            const members = await TontineService.getTontineMembers(req.params.id);
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
            const { question, options, durationHours } = req.body;
            const vote = await TontineService.createVote(req.params.id, (req as any).user.id, question, options, durationHours);
            res.status(201).json({ status: 'success', data: vote });
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
            const vote = await TontineService.castVote((req as any).user.id, req.params.voteId, optionIndex);
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
            const contributions = await TontineService.getTontineContributions(req.params.id, (req as any).user.id);
            res.json({ status: 'success', data: contributions });
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
