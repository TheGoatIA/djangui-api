import Joi from 'joi';

export const createBudgetSchema = Joi.object({
  period: Joi.object({
    type: Joi.string().valid('monthly', 'yearly').required(),
    month: Joi.number().min(1).max(12).optional(),
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
});
