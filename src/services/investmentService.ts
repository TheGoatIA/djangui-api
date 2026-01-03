import Investment, { IInvestmentDocument } from '../models/Investment';
import User from '../models/User';
import { AppError } from '../middleware/errorHandler';
import logger from '../utils/logger';

export class InvestmentService {
    /**
     * Create a new investment
     */
    static async createInvestment(userId: string, data: Partial<IInvestmentDocument>) {
        try {
            const investment = await Investment.create({
                ...data,
                userId,
                history: [{ value: data.initialAmount || 0, date: new Date() }],
            });

            return investment;
        } catch (error: any) {
            logger.error(`Error creating investment: ${error.message}`);
            throw error;
        }
    }

    /**
     * List investments for a user
     */
    static async listInvestments(userId: string, status?: string) {
        const filter: any = { userId };
        if (status) filter.status = status;
        return Investment.find(filter).sort({ createdAt: -1 });
    }

    /**
     * Update investment value and history
     */
    static async updateValue(userId: string, investmentId: string, newValue: number) {
        const investment = await Investment.findOne({ _id: investmentId, userId });
        if (!investment) {
            throw new AppError('Investment not found', 404);
        }

        investment.currentValue = newValue;
        investment.lastUpdated = new Date();
        investment.history.push({ value: newValue, date: new Date() });

        await investment.save();
        return investment;
    }

    /**
     * Close an investment (sell/exit)
     */
    static async closeInvestment(userId: string, investmentId: string, finalValue: number) {
        const investment = await Investment.findOne({ _id: investmentId, userId });
        if (!investment) {
            throw new AppError('Investment not found', 404);
        }

        investment.currentValue = finalValue;
        investment.status = 'closed';
        investment.lastUpdated = new Date();
        investment.history.push({ value: finalValue, date: new Date() });

        await investment.save();

        // Optionally update user wallet balance if it was a liquid asset
        await User.findByIdAndUpdate(userId, { $inc: { walletBalance: finalValue } });

        return investment;
    }
}
