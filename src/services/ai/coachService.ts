import Conversation, { IConversation } from '../../models/Conversation';
import User from '../../models/User';
import Transaction from '../../models/Transaction';
import Budget from '../../models/Budget';
import SavingGoal from '../../models/SavingGoal';
import UserChallenge from '../../models/UserChallenge';
import TontineMember from '../../models/TontineMember';
import { GeminiService } from './geminiService';
import { PromptBuilder } from './promptBuilder';
import { AppError } from '../../middleware/errorHandler';
import mongoose from 'mongoose';
import logger from '../../utils/logger';

export class CoachService {
  static async getOrCreateConversation(userId: string): Promise<IConversation> {
    let conversation = await Conversation.findOne({ userId, status: 'active' });
    if (!conversation) {
      conversation = await Conversation.create({ userId, messages: [] });
    }
    return conversation;
  }

  static async askCoach(userId: string, userMessage: string): Promise<string> {
    const user = await User.findById(userId);
    if (!user) throw new AppError('User not found', 404);

    const conversation = await this.getOrCreateConversation(userId);

    // Get context (recent transactions, current budget, goals, challenges, tontines)
    const now = new Date();
    const [transactions, budget, goals, userChallenges, tontineMembers] = await Promise.all([
      Transaction.find({ userId }).sort({ date: -1 }).limit(10).lean(),
      Budget.findOne({
        userId,
        'period.month': now.getMonth() + 1,
        'period.year': now.getFullYear(),
      }).lean(),
      SavingGoal.find({ userId, status: 'active' }).lean(),
      UserChallenge.find({ userId, status: 'active' }).populate('challengeId').lean(),
      TontineMember.find({ userId, invitationStatus: 'accepted' }).populate('tontineId').lean(),
    ]);

    const context = {
      transactions,
      budget,
      goals,
      challenges: userChallenges,
      tontines: tontineMembers.map((m: any) => ({
        name: m.tontineId.name,
        role: m.tontineId.creatorId.toString() === userId ? 'Créateur' : 'Membre',
        nextAmount: m.tontineId.contributionAmount * m.parts,
        trustScore: m.trustScore,
        currentTurn: m.tontineId.currentTurn
      }))
    };
    const systemPrompt = PromptBuilder.buildCoachSystemPrompt(user, context);

    // Prepare history for Gemini
    const history = conversation.messages.map((m) => ({
      role: m.role,
      parts: [{ text: m.content }],
    }));

    // Start chat with context as the first message if history is empty
    const chat = await GeminiService.startChat([
      {
        role: 'user',
        parts: [
          { text: `Initialise ton rôle de coach à partir de ces instructions: ${systemPrompt}` },
        ],
      },
      {
        role: 'model',
        parts: [
          {
            text: "Compris. Bonjour, je suis Kauri, ton coach financier. Comment puis-je t'aider aujourd'hui ?",
          },
        ],
      },
      ...history,
    ]);

    const result = await chat.sendMessage(userMessage);
    const aiResponse = result.response.text();

    // Update conversation
    conversation.messages.push({ role: 'user', content: userMessage, timestamp: new Date() });
    conversation.messages.push({ role: 'model', content: aiResponse, timestamp: new Date() });
    conversation.lastMessageAt = new Date();
    await (conversation as any).save();

    return aiResponse;
  }

  static async generateDailyAdvice(userId: string): Promise<{ title: string; body: string }> {
    const user = await User.findById(userId);
    if (!user) throw new AppError('User not found', 404);

    const now = new Date();
    const [transactions, budget, goals, userChallenges, tontineMembers] = await Promise.all([
      Transaction.find({ userId }).sort({ date: -1 }).limit(10).lean(),
      Budget.findOne({
        userId,
        'period.month': now.getMonth() + 1,
        'period.year': now.getFullYear(),
      }).lean(),
      SavingGoal.find({ userId, status: 'active' }).lean(),
      UserChallenge.find({ userId, status: 'active' }).populate('challengeId').lean(),
      TontineMember.find({ userId, invitationStatus: 'accepted' }).populate('tontineId').lean(),
    ]);

    const context = {
      walletBalance: user.walletBalance,
      transactions,
      budget,
      goals,
      challenges: userChallenges,
      tontines: tontineMembers.map((m: any) => ({
        name: m.tontineId.name,
        role: m.tontineId.creatorId.toString() === userId ? 'Créateur' : 'Membre',
        nextAmount: m.tontineId.contributionAmount * m.parts,
        trustScore: m.trustScore,
        currentTurn: m.tontineId.currentTurn,
        status: m.tontineId.status
      }))
    };

    const prompt = PromptBuilder.buildDailyAdvicePrompt(user as any, context);

    try {
      const data = await GeminiService.generateJSON(prompt, 'daily-advice');
      return {
        title: data.title || 'Conseil Kauri 💡',
        body: data.body || 'Prends soin de tes finances aujourd’hui !'
      };
    } catch (error) {
      logger.error(`Failed to generate AI advice for user ${userId}: ${error}`);
      return {
        title: 'Conseil Kauri 💡',
        body: 'Prends soin de tes finances aujourd’hui !'
      };
    }
  }
}
