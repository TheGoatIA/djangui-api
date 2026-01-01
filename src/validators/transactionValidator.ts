import Joi from 'joi';

export const createTransactionSchema = Joi.object({
    amount: Joi.number().min(0).required(),
    type: Joi.string().valid('income', 'expense').required(),
    category: Joi.string().required(),
    subcategory: Joi.string().optional(),
    description: Joi.string().required(),
    merchant: Joi.string().optional(),
    location: Joi.string().optional(),
    date: Joi.date().optional(),
    tags: Joi.array().items(Joi.string()).optional(),
    isRecurring: Joi.boolean().optional(),
    recurringFrequency: Joi.string().valid('daily', 'weekly', 'monthly', 'yearly').optional(),
    receipt: Joi.string().optional(),
    linkedGoalId: Joi.string().optional(),
});

export const updateTransactionSchema = Joi.object({
    amount: Joi.number().min(0).optional(),
    type: Joi.string().valid('income', 'expense').optional(),
    category: Joi.string().optional(),
    subcategory: Joi.string().optional(),
    description: Joi.string().optional(),
    merchant: Joi.string().optional(),
    location: Joi.string().optional(),
    date: Joi.date().optional(),
    tags: Joi.array().items(Joi.string()).optional(),
    isRecurring: Joi.boolean().optional(),
    recurringFrequency: Joi.string().valid('daily', 'weekly', 'monthly', 'yearly').optional(),
    receipt: Joi.string().optional(),
    linkedGoalId: Joi.string().optional(),
});
