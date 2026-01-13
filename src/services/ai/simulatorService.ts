import User from '../../models/User';
import Transaction from '../../models/Transaction';
import Budget from '../../models/Budget';
import SavingGoal from '../../models/SavingGoal';
import { GeminiService } from './geminiService';
import { PromptBuilder } from './promptBuilder';
import { AppError } from '../../middleware/errorHandler';

export class SimulatorService {
    /**
     * Simulate a "What If?" scenario
     */
    static async simulateScenario(userId: string, scenario: string) {
        const user = await User.findById(userId);
        if (!user) throw new AppError('User not found', 404);

        // Get current financial context: budget, last 30 days transactions, and goals
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const [transactions, budgets, goals] = await Promise.all([
            Transaction.find({ userId, date: { $gte: thirtyDaysAgo } }).lean(),
            Budget.find({ userId, status: 'active' }).lean(),
            SavingGoal.find({ userId, status: 'active' }).lean(),
        ]);

        const context = {
            recentTransactions: transactions,
            activeBudgets: budgets,
            savingGoals: goals,
        };

        const prompt = PromptBuilder.buildSimulatorPrompt(user as any, scenario, context);
        const simulationResult = await GeminiService.generateJSON(prompt, 'what-if-simulator');

        return simulationResult;
    }
}
