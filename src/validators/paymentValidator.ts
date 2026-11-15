import Joi from 'joi';

export const checkoutStripeSchema = Joi.object({
  amount: Joi.number().positive().max(1_000_000_000).when('type', {
    is: 'deposit',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  type: Joi.string().valid('deposit', 'subscription').required(),
  // 'free' is deliberately not accepted: it is not purchasable, and letting it
  // through charged the Premium price then downgraded the user to 'free' on completion.
  plan: Joi.string().valid('premium', 'business').optional(),
});

export const initNotchPaySchema = Joi.object({
  amount: Joi.number().positive().max(1_000_000_000).when('type', {
    is: 'deposit',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  type: Joi.string().valid('deposit', 'subscription').required(),
  phone: Joi.string().optional(),
  plan: Joi.string().valid('premium', 'business').optional(),
});

export const payWithWalletSchema = Joi.object({
  plan: Joi.string().valid('premium', 'business').required(),
});
