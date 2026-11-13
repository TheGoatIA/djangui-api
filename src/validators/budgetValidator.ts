import Joi from 'joi';

export const createBudgetSchema = Joi.object({
  period: Joi.object({
    type: Joi.string().valid('monthly', 'yearly').required(),
    // Required for a monthly budget: without it the "already exists" lookup
    // filtered on month: undefined (dropped by Mongoose) and matched ANY budget
    // of the year.
    month: Joi.number().integer().min(1).max(12).when('type', {
      is: 'monthly',
      then: Joi.required(),
      otherwise: Joi.optional(),
    }),
    year: Joi.number().required(),
  }).required(),
  categories: Joi.array()
    .items(
      Joi.object({
        name: Joi.string().required(),
        // Upper bound prevents an astronomically large client-supplied number from
        // producing Infinity/NaN in downstream percentage/aggregation math.
        allocated: Joi.number().min(0).max(1_000_000_000_000).required(),
      }),
    )
    .required(),
  totalAllocated: Joi.number().min(0).max(1_000_000_000_000).required(),
  linkedGoalId: Joi.string().hex().length(24).optional().allow(null),
});

export const updateBudgetSchema = Joi.object({
  categories: Joi.array()
    .items(
      Joi.object({
        name: Joi.string().required(),
        // Upper bound prevents an astronomically large client-supplied number from
        // producing Infinity/NaN in downstream percentage/aggregation math.
        allocated: Joi.number().min(0).max(1_000_000_000_000).required(),
      }),
    )
    .optional(),
  totalAllocated: Joi.number().min(0).max(1_000_000_000_000).optional(),
  status: Joi.string().valid('active', 'completed', 'exceeded').optional(),
  linkedGoalId: Joi.string().hex().length(24).optional().allow(null),
});

export const joinBudgetSchema = Joi.object({
  inviteCode: Joi.string().trim().min(6).max(32).required(),
});
