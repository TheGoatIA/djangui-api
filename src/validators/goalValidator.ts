import Joi from 'joi';

export const createGoalSchema = Joi.object({
  name: Joi.string().required(),
  description: Joi.string().optional().allow('', null),
  emoji: Joi.string().optional().allow('', null),
  type: Joi.string().valid('emergency', 'project', 'regular', 'challenge', 'debt').optional(),
  targetAmount: Joi.number().min(0).max(1_000_000_000_000).required(),
  deadline: Joi.date().optional().allow(null),
  priority: Joi.string().valid('high', 'medium', 'low').optional(),
  strategy: Joi.object({
    type: Joi.string()
      .valid(
        '50-30-20',
        'progressive',
        'roundup',
        'pay-yourself-first',
        'envelope',
        'custom',
        'snowball',
        'avalanche',
      )
      .optional(),
    details: Joi.any().optional(),
  }).optional(),
  autoSaveRules: Joi.object({
    enableSurplus: Joi.boolean().optional(),
    enableRoundup: Joi.boolean().optional(),
    percentageIncome: Joi.number().optional(),
    dayOfMonth: Joi.number().optional(),
  }).optional(),
  // Allow fields sent by frontend but not used in model logic to avoid validation errors
  currency: Joi.string().optional(),
  category: Joi.any().optional().allow(null),
  isShared: Joi.boolean().optional(),
  participants: Joi.array().optional(),
  image: Joi.any().optional().allow(null),
  // currentAmount/progress/status/contributions/createdAt/updatedAt are deliberately NOT
  // accepted here: a goal's real-money balance must only ever move through
  // GoalService.addContribution (which actually debits the wallet), never be set directly
  // by the client at creation — accepting currentAmount let a user fabricate a balance and
  // redeem/delete it for real wallet credit with nothing ever deposited.
});

export const updateGoalSchema = Joi.object({
  name: Joi.string().optional(),
  description: Joi.string().optional().allow('', null),
  emoji: Joi.string().optional().allow('', null),
  type: Joi.string().valid('emergency', 'project', 'regular', 'challenge', 'debt').optional(),
  targetAmount: Joi.number().min(0).max(1_000_000_000_000).optional(),
  deadline: Joi.date().optional().allow(null),
  priority: Joi.string().valid('high', 'medium', 'low').optional(),
  status: Joi.string().valid('active', 'completed', 'cancelled', 'paused').optional(),
});
