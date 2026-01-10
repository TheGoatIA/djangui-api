import Conversation, { IConversation } from '../../models/Conversation';
import User from '../../models/User';
import Transaction from '../../models/Transaction';
import Budget from '../../models/Budget';
import { GeminiService } from './geminiService';
import { PromptBuilder } from './promptBuilder';
import { AppError } from '../../middleware/errorHandler';
import mongoose from 'mongoose';

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

    // Get context (recent transactions, current budget)
    const now = new Date();
    const transactions = await Transaction.find({ userId }).sort({ date: -1 }).limit(5).lean();
    const budget = await Budget.findOne({
      userId,
      'period.month': now.getMonth() + 1,
      'period.year': now.getFullYear(),
    }).lean();

    const context = { transactions, budget };
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
}
