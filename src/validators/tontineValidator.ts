import Joi from 'joi';

/**
 * Tontine payloads used to be spread straight into the Mongoose document, so a
 * client could set `inviteCode`, `currentTurn`, `status` or a fake
 * `socialFund.totalCollected`, and amounts were never checked beyond `min: 0`.
 * Only these fields are accepted. The mobile app sends the user's own currency
 * (EUR for a user in France), so any ISO code is allowed; whole amounts for
 * zero-decimal currencies are enforced by `assertWholeAmounts`.
 */
const money = Joi.number().min(0).max(10_000_000).precision(2);
const positiveMoney = Joi.number().greater(0).max(10_000_000).precision(2);
const currency = Joi.string()
  .trim()
  .uppercase()
  .pattern(/^[A-Z]{3}$/);

export const ZERO_DECIMAL = ['XAF', 'XOF', 'GNF', 'RWF', 'BIF', 'KMF', 'DJF', 'MGA', 'UGX'];

const sanctions = Joi.object({
  lateFee: money.default(0),
  gracePeriodHours: Joi.number()
    .integer()
    .min(0)
    .max(24 * 30)
    .default(24),
  absenceFee: money.default(0),
});

const socialFund = Joi.object({
  enabled: Joi.boolean().required(),
  amount: money.default(0),
}).unknown(true); // totalCollected & co. are stripped below, never trusted

export const createTontineSchema = Joi.object({
  name: Joi.string().trim().min(1).max(80).required(),
  frequency: Joi.string().valid('weekly', 'bi-weekly', 'monthly').required(),
  startDate: Joi.date().required(),
  contributionAmount: positiveMoney.required(),
  currency: currency.default('XAF'),
  totalParts: Joi.number().integer().min(2).max(100).required(),
  rotationMode: Joi.string().valid('fixed', 'random').default('fixed'),
  sanctions: sanctions.optional(),
  socialFund: socialFund.optional(),
  autoRenew: Joi.boolean().default(false),
});

export const updateTontineSchema = Joi.object({
  name: Joi.string().trim().min(1).max(80),
  frequency: Joi.string().valid('weekly', 'bi-weekly', 'monthly'),
  startDate: Joi.date(),
  contributionAmount: positiveMoney,
  currency,
  totalParts: Joi.number().integer().min(2).max(100),
  sanctions,
  socialFund,
  autoRenew: Joi.boolean(),
  rulesAcceptedByAll: Joi.boolean(),
});

export const joinTontineSchema = Joi.object({
  inviteCode: Joi.string().trim().max(32).required(),
  displayName: Joi.string().trim().min(1).max(60).required(),
  parts: Joi.number().integer().min(1).max(100).default(1),
});

export const createVoteSchema = Joi.object({
  kind: Joi.string().valid('general', 'closure').default('general'),
  question: Joi.string().trim().min(1).max(300).when('kind', {
    is: 'closure',
    then: Joi.optional(),
    otherwise: Joi.required(),
  }),
  options: Joi.array()
    .items(Joi.string().trim().min(1).max(100))
    .min(2)
    .max(10)
    .unique()
    .when('kind', { is: 'closure', then: Joi.optional(), otherwise: Joi.required() }),
  durationHours: Joi.number()
    .min(1)
    .max(24 * 30)
    .required(),
});

/** Fixed ballot of a closure vote: option 0 = close. */
export const CLOSURE_OPTIONS = ['Oui, clôturer la tontine', 'Non, continuer'];

export const castVoteSchema = Joi.object({
  optionIndex: Joi.number().integer().min(0).required(),
});

export const MESSAGE_MAX_LENGTH = 5000;

/** Strips everything but the client-settable social fund fields. */
export const pickSocialFund = (sf: any) =>
  sf ? { enabled: Boolean(sf.enabled), amount: Number(sf.amount) || 0 } : undefined;

/** Whole amounts only for zero-decimal currencies (contribution, fees, social fund). */
export function wholeAmountError(t: {
  currency?: string;
  contributionAmount?: number;
  sanctions?: { lateFee?: number; absenceFee?: number };
  socialFund?: { amount?: number };
}): string | null {
  if (!ZERO_DECIMAL.includes((t.currency || 'XAF').toUpperCase())) return null;
  const amounts = [
    t.contributionAmount,
    t.sanctions?.lateFee,
    t.sanctions?.absenceFee,
    t.socialFund?.amount,
  ].filter((a) => a !== undefined);
  return amounts.every((a) => Number.isInteger(a))
    ? null
    : `Les montants en ${t.currency || 'XAF'} doivent être des nombres entiers.`;
}
