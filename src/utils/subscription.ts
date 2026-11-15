export type PaidPlan = 'premium' | 'business';

export interface SubscriptionLike {
  plan?: string | null;
  status?: string | null;
  endDate?: Date | string | null;
}

/**
 * Single source of truth for "does this subscription currently grant paid-tier
 * access?".
 *
 * - `active`    → entitled until `endDate` (no `endDate` = open-ended, e.g. granted by an admin).
 * - `cancelled` → the user stopped auto-renewal but already paid for the current
 *                 cycle, so access runs until `endDate`. A cancelled subscription
 *                 with no `endDate` is NOT entitled (nothing was paid for).
 * - `expired`   → never entitled.
 *
 * Previously every call site re-implemented `status === 'active'`, which made a
 * "cancel" revoke Premium instantly despite the API telling the user they would
 * "remain premium until the end of the billing cycle".
 */
export const isSubscriptionEntitled = (
  sub?: SubscriptionLike | null,
  tiers: readonly PaidPlan[] = ['premium', 'business'],
  now: Date = new Date(),
): boolean => {
  if (!sub || !sub.plan || !tiers.includes(sub.plan as PaidPlan)) return false;

  const end = sub.endDate ? new Date(sub.endDate) : null;
  const notExpired = !end || end >= now;

  if (sub.status === 'active') return notExpired;
  if (sub.status === 'cancelled') return !!end && notExpired;
  return false;
};

export const SUBSCRIPTION_CYCLE_DAYS = 30;

/**
 * Compute the new `endDate` when (re)activating `plan`.
 *
 * If the user is still entitled to the same plan, the new cycle is appended to
 * the remaining time instead of resetting to `now + 30d` — otherwise paying
 * early (or an admin extending a plan) silently throws away paid days.
 */
export const computeNewEndDate = (
  current: SubscriptionLike | null | undefined,
  plan: PaidPlan,
  days: number = SUBSCRIPTION_CYCLE_DAYS,
  now: Date = new Date(),
): Date => {
  const base =
    current &&
    current.plan === plan &&
    current.endDate &&
    isSubscriptionEntitled(current, [plan], now)
      ? new Date(current.endDate)
      : now;
  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
};
