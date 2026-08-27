import Conversation, { IConversation } from '../../models/Conversation';
import User from '../../models/User';
import Transaction from '../../models/Transaction';
import Budget from '../../models/Budget';
import SavingGoal from '../../models/SavingGoal';
import UserChallenge from '../../models/UserChallenge';
import TontineMember from '../../models/TontineMember';
import Subscription from '../../models/Subscription';
import SharedMasterAccount from '../../models/SharedMasterAccount';
import SharedSlot from '../../models/SharedSlot';
import UserActivity from '../../models/UserActivity';
import { GeminiService } from './geminiService';
import { PromptBuilder } from './promptBuilder';
import { AppError } from '../../middleware/errorHandler';
import logger from '../../utils/logger';
import { MonitoringService } from '../monitoringService';
import { SlackService } from '../slackService';
import { NotificationService } from '../notificationService';

// Au-delà de ce nombre de messages, la conversation "active" est archivée et
// une nouvelle est créée au prochain message — évite qu'un unique document
// Mongo grossisse indéfiniment (limite dure de 16 Mo par document) et borne
// le coût de lecture/écriture d'une conversation très active dans la durée.
const MAX_CONVERSATION_MESSAGES = 300;

// Les 40 derniers messages seulement sont renvoyés à Gemini à chaque appel —
// `conversation.messages` grows unbounded in Mongo, et sans cette limite
// chaque nouveau message renverrait l'intégralité de l'historique au modèle,
// avec un coût et une latence qui grimperaient sans fin pour un compte actif
// depuis longtemps. L'historique complet reste conservé en base.
const MAX_HISTORY_MESSAGES = 40;

type CoachSecurityBlock = { securityBlock: string };
type CoachContextReady = { conversation: IConversation; context: any; user: any };

export class CoachService {
  static async getOrCreateConversation(userId: string): Promise<IConversation> {
    let conversation = await Conversation.findOne({ userId, status: 'active' });
    if (conversation && conversation.messages.length >= MAX_CONVERSATION_MESSAGES) {
      conversation.status = 'archived';
      await conversation.save();
      conversation = null;
    }
    conversation ??= await Conversation.create({ userId, messages: [] });
    return conversation;
  }

  /**
   * Vérifications de sécurité + rassemblement du contexte, partagés entre
   * `askCoach` (JSON, non-streamé) et `askCoachStream`. Si la requête est
   * bloquée pour raison de sécurité, retourne le message à afficher au lieu
   * de lancer l'appel IA — mais la conversation est quand même mise à jour
   * avec l'échange pour qu'il survive à un rechargement de l'historique.
   */
  private static async prepareCoachContext(
    userId: string,
    userMessage: string,
  ): Promise<CoachSecurityBlock | CoachContextReady> {
    const user = await User.findById(userId);
    if (!user) throw new AppError('User not found', 404);

    // ── Sécurité IA : vérification de l'état du compte ──────────────────────
    // Ces 3 vérifications sont volontairement faites AVANT toute requête de
    // contexte (transactions/budget/objectifs/tontines/revendeur — 8 requêtes
    // en parallèle) et avant la construction du prompt : un compte suspendu,
    // bloqué, ou une tentative d'injection ne doivent jamais déclencher ce
    // travail, qui serait de toute façon jeté.
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

    const conversation = await this.getOrCreateConversation(userId);

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

      // Persisté pour que l'avertissement survive à un rechargement de
      // l'historique au lieu de disparaître silencieusement (comportement
      // précédent : affiché une fois via la réponse directe, jamais stocké).
      conversation.messages.push(
        { role: 'user', content: userMessage, timestamp: new Date() },
        { role: 'model', content: responseMessage, timestamp: new Date() },
      );
      conversation.lastMessageAt = new Date();
      await (conversation as any).save();

      return { securityBlock: JSON.stringify({ text: responseMessage, actions: [] }) };
    }

    // Get context (recent transactions, current budget, goals, challenges, tontines, personal subscriptions, reseller business)
    const now = new Date();
    const [
      transactions,
      budget,
      goals,
      userChallenges,
      tontineMembers,
      subscriptions,
      resellerAccounts,
      resellerSlots,
    ] = await Promise.all([
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
      SharedMasterAccount.find({ resellerId: userId, status: 'active' }).lean(),
      SharedSlot.find({ resellerId: userId }).lean(),
    ]);

    const context = {
      transactions,
      budget,
      goals,
      challenges: userChallenges,
      tontines: tontineMembers.map((m: any) => ({
        name: m.tontineId?.name || 'Tontine',
        role: m.tontineId?.creatorId?.toString() === userId ? 'Créateur' : 'Membre',
        nextAmount: (m.tontineId?.contributionAmount || 0) * (m.parts || 1),
        trustScore: m.trustScore,
        currentTurn: m.tontineId?.currentTurn,
      })),
      subscriptions,
      // N'est inclus dans le prompt que si l'utilisateur a effectivement une
      // activité revendeur (voir PromptBuilder.buildCoachSystemPrompt) — pour
      // ne pas gonfler inutilement le prompt des ~99% d'utilisateurs qui n'en
      // ont pas.
      resellerBusiness: {
        totalAccounts: resellerAccounts.length,
        totalMasterCost: resellerAccounts.reduce((sum, acc) => sum + (acc.billingCost || 0), 0),
        occupiedSlots: resellerSlots.filter((s) => s.status !== 'vacant').length,
        mrrRevenue: resellerSlots.reduce(
          (sum, s) => sum + (s.status !== 'vacant' ? s.price : 0),
          0,
        ),
        overdueClientsCount: resellerSlots.filter((s) => s.status === 'overdue' || s.status === 'blocked').length,
        dueSoonClientsCount: resellerSlots.filter((s) => s.status === 'due_soon').length,
        accounts: resellerAccounts.map((a) => ({
          service: a.serviceName,
          cost: a.billingCost,
          currency: a.billingCurrency,
          slots: a.maxSlots,
        })),
      },
    };

    return { conversation, context, user };
  }

  private static buildHistory(conversation: IConversation) {
    const recentMessages = conversation.messages.slice(-MAX_HISTORY_MESSAGES);
    return recentMessages.map((m) => ({
      role: m.role,
      parts: [{ text: m.content }],
    }));
  }

  static async askCoach(userId: string, userMessage: string): Promise<string> {
    const prep = await this.prepareCoachContext(userId, userMessage);
    if ('securityBlock' in prep) return prep.securityBlock;
    const { conversation, context, user } = prep;

    const systemPrompt = PromptBuilder.buildCoachSystemPrompt(user, context);

    // Measure Context Efficiency (System Prompt length vs User Message length)
    MonitoringService.recordAiContextEfficiency(systemPrompt.length, userMessage.length);

    // Start chat with proper systemInstruction (isolated from history)
    const chat = await GeminiService.startChat(this.buildHistory(conversation), systemPrompt);

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

  /**
   * Variante streaming : `onDelta` est appelé au fil de l'eau avec des
   * fragments de texte affichables directement (Markdown), jamais avec le
   * marqueur d'actions ni ce qui le suit. Voir buildCoachSystemPrompt
   * (streamMode=true) pour le format attendu du modèle.
   */
  static async askCoachStream(
    userId: string,
    userMessage: string,
    onDelta: (delta: string) => void,
  ): Promise<{ text: string; actions: any[] }> {
    const prep = await this.prepareCoachContext(userId, userMessage);
    if ('securityBlock' in prep) {
      const parsed = JSON.parse(prep.securityBlock);
      onDelta(parsed.text);
      return { text: parsed.text, actions: [] };
    }
    const { conversation, context, user } = prep;

    const systemPrompt = PromptBuilder.buildCoachSystemPrompt(user, context, true);
    MonitoringService.recordAiContextEfficiency(systemPrompt.length, userMessage.length);

    const { chat, modelName } = await GeminiService.startChatStream(
      this.buildHistory(conversation),
      systemPrompt,
      true, // enableSearch — voir buildCoachSystemPrompt pour la consigne associée
    );

    const ACTIONS_SENTINEL = '%%%ACTIONS%%%';
    let fullRaw = '';
    // Fenêtre glissante : ne jamais transmettre les derniers caractères tant
    // qu'ils pourraient être le début du marqueur d'actions — sinon un
    // marqueur coupé entre deux chunks du flux Gemini apparaîtrait
    // brièvement dans le texte affiché à l'utilisateur.
    let pendingTail = '';
    let sentinelFound = false;
    const startTime = Date.now();
    let groundingSources: { type: string; label: string; payload: { url: string } }[] = [];

    try {
      const result = await chat.sendMessageStream(userMessage);
      for await (const chunk of result.stream) {
        const chunkText = chunk.text();
        if (!chunkText) continue;
        fullRaw += chunkText;
        if (sentinelFound) continue;

        pendingTail += chunkText;
        const sentinelIdx = pendingTail.indexOf(ACTIONS_SENTINEL);
        if (sentinelIdx !== -1) {
          const toFlush = pendingTail.slice(0, sentinelIdx).trimEnd();
          if (toFlush) onDelta(toFlush);
          sentinelFound = true;
          pendingTail = '';
          continue;
        }

        const holdBack = Math.min(pendingTail.length, ACTIONS_SENTINEL.length - 1);
        const safeToFlush = pendingTail.slice(0, pendingTail.length - holdBack);
        if (safeToFlush) {
          onDelta(safeToFlush);
          pendingTail = pendingTail.slice(safeToFlush.length);
        }
      }
      if (!sentinelFound && pendingTail) {
        onDelta(pendingTail);
      }

      const response = await result.response;
      GeminiService.saveUsage(
        modelName,
        'chat-stream',
        response.usageMetadata,
        Date.now() - startTime,
        'success',
      );

      // Quand Gemini a effectivement cherché sur le web, ses sources sont
      // exposées ici — traduites en `actions` de type 'url' pour réutiliser
      // tel quel le bouton déjà affiché côté mobile, sans rien changer côté
      // client. Absent si aucune recherche n'a eu lieu pour cette réponse.
      const groundingChunks = (response as any).candidates?.[0]?.groundingMetadata
        ?.groundingChunks as { web?: { uri?: string; title?: string } }[] | undefined;
      if (groundingChunks?.length) {
        groundingSources = groundingChunks
          .filter((c) => c.web?.uri)
          .slice(0, 5)
          .map((c) => ({
            type: 'url',
            label: c.web!.title?.slice(0, 40) || 'Source',
            payload: { url: c.web!.uri! },
          }));
      }
    } catch (error: any) {
      GeminiService.saveUsage(
        modelName,
        'chat-stream',
        {},
        Date.now() - startTime,
        'failure',
        error.message,
      );
      logger.error(`Gemini coach stream error: ${error.message}`);
      throw new AppError('AI Chat Service currently unavailable', 503);
    }

    // Extrait les actions éventuelles du texte brut accumulé.
    let text = fullRaw;
    let actions: any[] = [];
    const sentinelIndex = fullRaw.indexOf(ACTIONS_SENTINEL);
    if (sentinelIndex !== -1) {
      text = fullRaw.slice(0, sentinelIndex).trimEnd();
      const actionsRaw = fullRaw.slice(sentinelIndex + ACTIONS_SENTINEL.length).trim();
      try {
        actions = JSON.parse(actionsRaw);
        if (!Array.isArray(actions)) actions = [];
      } catch (e) {
        logger.warn(`Failed to parse streamed coach actions: ${e}`);
      }
    }
    if (groundingSources.length > 0) {
      actions = [...actions, ...groundingSources];
    }

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

    await UserActivity.create({
      userId,
      feature: 'AI_Coach',
      action: 'ask_question',
      details: { messageLength: userMessage.length },
    }).catch((e) => logger.warn(`Failed to log coach activity: ${e}`));

    return { text, actions };
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
