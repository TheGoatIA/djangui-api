import Conversation, { IConversation } from '../../models/Conversation';
import User from '../../models/User';
import Transaction from '../../models/Transaction';
import Budget from '../../models/Budget';
import SavingGoal from '../../models/SavingGoal';
import UserChallenge from '../../models/UserChallenge';
import TontineMember from '../../models/TontineMember';
import Subscription from '../../models/Subscription';
import UserActivity from '../../models/UserActivity';
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
    const [transactions, budget, goals, userChallenges, tontineMembers, subscriptions] =
      await Promise.all([
        Transaction.find({ userId }).sort({ date: -1 }).limit(10).lean(),
        Budget.findOne({
          userId,
          'period.month': now.getMonth() + 1,
          'period.year': now.getFullYear(),
        }).lean(),
        SavingGoal.find({ userId, status: 'active' }).lean(),
        UserChallenge.find({ userId, status: 'active' }).populate('challengeId').lean(),
        TontineMember.find({ userId, invitationStatus: 'accepted' }).populate('tontineId').lean(),
        Subscription.find({ userId, status: 'active' }).lean(),
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
        currentTurn: m.tontineId.currentTurn,
      })),
      subscriptions,
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
            text: "Compris. Bonjour, je suis Anne, ta coach financière. Comment puis-je t'aider aujourd'hui ?",
          },
        ],
      },
      ...history,
    ]);

    const result = await chat.sendMessage(userMessage);
    const rawAiResponse = result.response.text();

    let text = rawAiResponse;
    let actions = [];

    try {
      // Attempt to parse JSON even if it's currently a string
      // (GeminiService.getModel sets responseMimeType to application/json)
      const parsed = GeminiService.parseJSON(rawAiResponse);
      text = parsed.text || rawAiResponse;
      actions = parsed.actions || [];
    } catch (e) {
      logger.warn(`Failed to parse AI coach response as JSON: ${e}. Using raw text.`);
    }

    // Update conversation
    conversation.messages.push({ role: 'user', content: userMessage, timestamp: new Date() });
    conversation.messages.push({
      role: 'model',
      content: text,
      actions: actions.length > 0 ? actions : undefined,
      timestamp: new Date(),
    });
    conversation.lastMessageAt = new Date();
    await (conversation as any).save();

    // Track Activity
    await UserActivity.create({
      userId,
      feature: 'AI_Coach',
      action: 'ask_question',
      details: { messageLength: userMessage.length },
    }).catch((e) => logger.warn(`Failed to log coach activity: ${e}`));

    return rawAiResponse; // Return raw JSON so the client can decide how to handle it
  }

  static async generateDailyAdvice(userId: string): Promise<{ title: string; body: string }> {
    const user = await User.findById(userId);
    if (!user) throw new AppError('User not found', 404);

    const now = new Date();
    const [transactions, budget, goals, userChallenges, tontineMembers, subscriptions] =
      await Promise.all([
        Transaction.find({ userId }).sort({ date: -1 }).limit(10).lean(),
        Budget.findOne({
          userId,
          'period.month': now.getMonth() + 1,
          'period.year': now.getFullYear(),
        }).lean(),
        SavingGoal.find({ userId, status: 'active' }).lean(),
        UserChallenge.find({ userId, status: 'active' }).populate('challengeId').lean(),
        TontineMember.find({ userId, invitationStatus: 'accepted' }).populate('tontineId').lean(),
        Subscription.find({ userId, status: 'active' }).lean(),
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
        status: m.tontineId.status,
      })),
      subscriptions,
    };

    const prompt = PromptBuilder.buildDailyAdvicePrompt(user as any, context);

    try {
      const data = await GeminiService.generateJSON(prompt, 'daily-advice');

      // Track Activity
      UserActivity.create({
        userId,
        feature: 'AI_Coach',
        action: 'generate_daily_advice',
      }).catch((e) => logger.warn(`Failed to log advice activity: ${e}`));

      return {
        title: data.title || "Conseil d'Anne 💡",
        body: data.body || 'Prends soin de tes finances aujourd’hui !',
      };
    } catch (error) {
      logger.error(`Failed to generate AI advice for user ${userId}: ${error}`);
      return {
        title: "Conseil d'Anne 💡",
        body: 'Prends soin de tes finances aujourd’hui !',
      };
    }
  }
}
