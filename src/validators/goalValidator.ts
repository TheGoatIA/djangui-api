import Joi from 'joi';

export const createGoalSchema = Joi.object({
  name: Joi.string().required(),
  description: Joi.string().optional(),
  emoji: Joi.string().optional(),
  type: Joi.string().valid('emergency', 'project', 'regular', 'challenge').optional(),
  targetAmount: Joi.number().min(0).required(),
  deadline: Joi.date().optional(),
  priority: Joi.string().valid('high', 'medium', 'low').optional(),
  strategy: Joi.object({
    type: Joi.string()
      .valid('50-30-20', 'progressive', 'roundup', 'pay-yourself-first', 'envelope', 'custom')
      .optional(),
    details: Joi.any().optional(),
  }).optional(),
  autoSaveRules: Joi.object({
    enableSurplus: Joi.boolean().optional(),
    enableRoundup: Joi.boolean().optional(),
    percentageIncome: Joi.number().optional(),
    dayOfMonth: Joi.number().optional(),
  }).optional(),
});

export const updateGoalSchema = Joi.object({
  name: Joi.string().optional(),
  description: Joi.string().optional(),
  emoji: Joi.string().optional(),
  type: Joi.string().valid('emergency', 'project', 'regular', 'challenge').optional(),
  targetAmount: Joi.number().min(0).optional(),
  deadline: Joi.date().optional(),
  priority: Joi.string().valid('high', 'medium', 'low').optional(),
  status: Joi.string().valid('active', 'completed', 'cancelled', 'paused').optional(),
});
