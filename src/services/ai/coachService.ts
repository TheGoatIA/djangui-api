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
import { MonitoringService } from '../monitoringService';
import { SlackService } from '../slackService';
import { NotificationService } from '../notificationService';

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

    // AI Security Check
    if (user.status !== 'active') {
      throw new AppError(
        "Votre compte est suspendu suite à des activités suspectes avec l'IA.",
        403,
      );
    }

    if (GeminiService.detectAttack(userMessage)) {
      user.aiAttackCount = (user.aiAttackCount || 0) + 1;

      const isSuspended = user.aiAttackCount >= 3;
      if (isSuspended) {
        user.status = 'suspended';
      }
      await user.save();

      // Slack Alert
      await SlackService.sendNotification(
        `🚨 *Alerte Sécurité IA* 🚨\n*Utilisateur*: ${user.firstName} ${user.lastName} (${user.email})\n*Message*: "${userMessage}"\n*Tentatives*: ${user.aiAttackCount}/3\n*Action*: ${isSuspended ? '🔴 COMPTE SUSPENDU' : '⚠️ AVERTISSEMENT'}`,
        true,
      );

      if (isSuspended) {
        // Notification push au compte suspendu
        NotificationService.sendToUser(userId, {
          title: 'Compte Suspendu ⛔',
          body: "Votre compte a été suspendu définitivement suite à des tentatives répétées de manipulation de l'IA. Contactez le support.",
          category: 'important',
          data: { type: 'account_suspended' },
        }).catch((err: any) => logger.error(`AI Suspension Notification Error: ${err.message}`));

        throw new AppError(
          "Votre compte a été banni définitivement après 3 tentatives de manipulation de l'intelligence artificielle.",
          403,
        );
      }

      return JSON.stringify({
        text: `⚠️ **Avertissement de sécurité** : Votre message a été détecté comme une tentative de manipulation de mes instructions de base. Ceci est formellement interdit. \n\nEncore **${
          3 - user.aiAttackCount
        }** tentative(s) et votre compte sera **définitivement bloqué**.`,
        actions: [],
      });
    }

    // Measure Context Efficiency (System Prompt length vs User Message length)
    MonitoringService.recordAiContextEfficiency(systemPrompt.length, userMessage.length);

    // Prepare history for Gemini
    const history = conversation.messages.map((m) => ({
      role: m.role,
      parts: [{ text: m.content }],
    }));

    // Start chat with proper systemInstruction (isolated from history)
    const chat = await GeminiService.startChat(history, systemPrompt);

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
    const isPremium = (user as any).isPremium;
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const transactionQuery: any = { userId };
    if (!isPremium) {
      transactionQuery.date = { $gte: startOfMonth };
    }

    const [transactions, budget, goals, userChallenges, tontineMembers, subscriptions] =
      await Promise.all([
        Transaction.find(transactionQuery).sort({ date: -1 }).limit(isPremium ? 100 : 20).lean(),
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
      const data = await GeminiService.generateJSON(
        'Génère le conseil du jour.',
        'daily-advice',
        prompt,
      );

      // Track Activity
      UserActivity.create({
        userId,
        feature: 'AI_Coach',
        action: 'generate_daily_advice',
      }).catch((e) => logger.warn(`Failed to log advice activity: ${e}`));

      const isEn = user.language === 'en';
      return {
        title: data.title || (isEn ? "Anne's Advice 💡" : "Conseil d'Anne 💡"),
        body:
          data.body ||
          (isEn
            ? 'Take care of your finances today!'
            : 'Prends soin de tes finances aujourd’hui !'),
      };
    } catch (error) {
      logger.error(`Failed to generate AI advice for user ${userId}: ${error}`);
      const isEn = user.language === 'en';
      return {
        title: isEn ? "Anne's Advice 💡" : "Conseil d'Anne 💡",
        body: isEn
          ? 'Take care of your finances today!'
          : 'Prends soin de tes finances aujourd’hui !',
      };
    }
  }
}
