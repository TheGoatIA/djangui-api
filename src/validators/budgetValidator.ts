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
        allocated: Joi.number().min(0).required(),
      }),
    )
    .required(),
  totalAllocated: Joi.number().min(0).required(),
});

export const updateBudgetSchema = Joi.object({
  categories: Joi.array()
    .items(
      Joi.object({
        name: Joi.string().required(),
        allocated: Joi.number().min(0).required(),
      }),
    )
    .optional(),
  totalAllocated: Joi.number().min(0).optional(),
  status: Joi.string().valid('active', 'completed', 'exceeded').optional(),
});
