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
import logger from '../../utils/logger';
import { MonitoringService } from '../monitoringService';
import { SlackService } from '../slackService';
import { NotificationService } from '../notificationService';

export class CoachService {
  static async getOrCreateConversation(userId: string): Promise<IConversation> {
    let conversation = await Conversation.findOne({ userId, status: 'active' });
    conversation ??= await Conversation.create({ userId, messages: [] });
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

    // ── Sécurité IA : vérification de l'état du compte ──────────────────────
    if (user.status !== 'active') {
      throw new AppError(
        "Votre compte est suspendu. Contactez le support pour plus d'informations.",
        403,
      );
    }

    // ── Sécurité IA : vérification du blocage temporaire du coach ────────────
    const ai = user.aiSecurity || { attackCount: 0, suspensionPending: false };
    if (ai.coachBlockedUntil && new Date() < new Date(ai.coachBlockedUntil)) {
      const remainingMs = new Date(ai.coachBlockedUntil).getTime() - Date.now();
      const remainingMin = Math.ceil(remainingMs / 60000);
      throw new AppError(
        `Le coach Anne est temporairement désactivé suite à des activités suspectes. Réessayez dans ${remainingMin} minute(s).`,
        429,
      );
    }

    // ── Sécurité IA : détection d'attaque par injection de prompt ────────────
    if (GeminiService.detectAttack(userMessage)) {
      // Initialisation défensive
      if (!user.aiSecurity) {
        user.aiSecurity = { attackCount: 0, suspensionPending: false };
      }
      user.aiSecurity.attackCount = (user.aiSecurity.attackCount || 0) + 1;
      user.aiSecurity.lastAttackAt = new Date();
      const count = user.aiSecurity.attackCount;

      let responseMessage = '';
      let slackMessage = '';
      let actionLabel = '';

      if (count >= 10) {
        // ── Palier 3 : flag admin requis (jamais de suspension automatique) ──
        user.aiSecurity.suspensionPending = true;
        actionLabel = '🔴 REVUE ADMIN REQUISE';
        responseMessage = `⛔ **Accès au coach suspendu** : Le nombre de tentatives de manipulation a atteint un seuil critique. Votre dossier a été transmis à l'équipe Kauri. Contactez le support.`;
        await NotificationService.sendToUser(userId, {
          title: 'Accès coach suspendu ⛔',
          body: "Votre accès au coach Anne a été suspendu suite à des activités répétées. Contactez le support.",
          category: 'important',
          data: { type: 'coach_suspended_pending_review' },
        }).catch((err: any) => logger.error(`Notification erreur: ${err.message}`));
      } else if (count >= 6) {
        // ── Palier 2 : blocage coach 24h ────────────────────────────────────
        user.aiSecurity.coachBlockedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
        actionLabel = '🟠 COACH BLOQUÉ 24H';
        responseMessage = `🚫 **Coach temporairement bloqué (24h)** : Vos messages répétés ont déclenché notre système de sécurité. Le coach Anne sera de nouveau disponible demain.`;
      } else {
        // ── Palier 1 : avertissement + blocage coach 1h ──────────────────────
        user.aiSecurity.coachBlockedUntil = new Date(Date.now() + 60 * 60 * 1000);
        actionLabel = '⚠️ AVERTISSEMENT';
        const remaining = Math.max(0, 6 - count);
        responseMessage = `⚠️ **Avertissement de sécurité** : Votre message a été détecté comme une tentative de manipulation. Le coach est temporairement désactivé (1h).\n\nEncore **${remaining}** incident(s) avant une suspension prolongée.`;
      }

      slackMessage =
        `🚨 *Alerte Sécurité IA* 🚨\n` +
        `*Utilisateur* : ${user.firstName} ${user.lastName} (${user.email})\n` +
        `*Message* : "${userMessage.substring(0, 200)}"\n` +
        `*Tentatives* : ${count}\n` +
        `*Action* : ${actionLabel}`;

      await user.save();

      await SlackService.sendNotification(slackMessage, true).catch((err: any) =>
        logger.error(`Slack alert error: ${err.message}`),
      );

      return JSON.stringify({ text: responseMessage, actions: [] });
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
    conversation.messages.push(
      { role: 'user', content: userMessage, timestamp: new Date() },
      {
        role: 'model',
        content: text,
        actions: actions.length > 0 ? actions : undefined,
        timestamp: new Date(),
      },
    );
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
        Transaction.find(transactionQuery)
          .sort({ date: -1 })
          .limit(isPremium ? 100 : 20)
          .lean(),
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
