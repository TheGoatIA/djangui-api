import Challenge, { IChallenge } from '../models/Challenge';
import UserChallenge from '../models/UserChallenge';
import { AppError } from '../middleware/errorHandler';
import logger from '../utils/logger';

export class ChallengeService {
    static async getAllChallenges() {
        return Challenge.find({ isCustom: false }).sort({ difficulty: 1 });
    }

    static async getUserChallenges(userId: string) {
        return UserChallenge.find({ userId }).populate('challengeId').sort({ createdAt: -1 });
    }

    static async joinChallenge(userId: string, challengeId: string) {
        const challenge = await Challenge.findById(challengeId);
        if (!challenge) throw new AppError('Challenge not found', 404);

        const existing = await UserChallenge.findOne({ userId, challengeId, status: 'active' });
        if (existing) throw new AppError('Challenge already active for this user', 400);

        const startDate = new Date();
        const endDate = new Date();
        endDate.setDate(startDate.getDate() + challenge.durationDays);

        const userChallenge = await UserChallenge.create({
            userId,
            challengeId,
            startDate,
            endDate,
        });

        return userChallenge;
    }

    static async updateProgress(userChallengeId: string, value: number) {
        const userChallenge = await UserChallenge.findById(userChallengeId).populate<{ challengeId: IChallenge }>('challengeId');
        if (!userChallenge) throw new AppError('User challenge participation not found', 404);
        if (userChallenge.status !== 'active') return userChallenge;

        userChallenge.currentValue += value;

        const target = userChallenge.challengeId.targetAmount || 0;
        if (target > 0) {
            userChallenge.progress = Math.min(100, (userChallenge.currentValue / target) * 100);
            if (userChallenge.progress >= 100) {
                userChallenge.status = 'completed';
                userChallenge.completedAt = new Date();
            }
        }

        await userChallenge.save();
        return userChallenge;
    }

    // Helper to create seed challenges if none exist
    static async seedChallenges() {
        const count = await Challenge.countDocuments();
        if (count === 0) {
            await Challenge.create([
                {
                    title: 'Sans Café (30 jours)',
                    description: 'Économise l\'argent de tes cafés quotidiens pendant un mois.',
                    type: 'spending_cut',
                    difficulty: 'medium',
                    durationDays: 30,
                    rewardPoints: 50,
                    icon: '☕',
                },
                {
                    title: 'Premier Pas',
                    description: 'Épargne tes premiers 5 000 XAF.',
                    type: 'saving',
                    difficulty: 'easy',
                    targetAmount: 5000,
                    durationDays: 7,
                    rewardPoints: 20,
                    icon: '🌱',
                },
                {
                    title: 'Champion de l\'Épargne',
                    description: 'Épargne 50 000 XAF ce mois-ci.',
                    type: 'saving',
                    difficulty: 'hard',
                    targetAmount: 50000,
                    durationDays: 30,
                    rewardPoints: 200,
                    icon: '💎',
                }
            ]);
            logger.info('Seed challenges created');
        }
    }
}
