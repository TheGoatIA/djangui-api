import { computeNewEndDate, isSubscriptionEntitled } from '../utils/subscription';

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-10-13T12:00:00Z');
const inDays = (n: number) => new Date(now.getTime() + n * DAY);

describe('isSubscriptionEntitled', () => {
  it('grants access to an active paid plan before its end date', () => {
    expect(
      isSubscriptionEntitled(
        { plan: 'premium', status: 'active', endDate: inDays(5) },
        undefined,
        now,
      ),
    ).toBe(true);
    expect(
      isSubscriptionEntitled(
        { plan: 'business', status: 'active', endDate: inDays(5) },
        undefined,
        now,
      ),
    ).toBe(true);
  });

  it('treats an active plan without endDate as open-ended (admin grant)', () => {
    expect(isSubscriptionEntitled({ plan: 'premium', status: 'active' }, undefined, now)).toBe(
      true,
    );
  });

  it('denies free, expired and past-due plans', () => {
    expect(isSubscriptionEntitled({ plan: 'free', status: 'active' }, undefined, now)).toBe(false);
    expect(
      isSubscriptionEntitled(
        { plan: 'premium', status: 'expired', endDate: inDays(5) },
        undefined,
        now,
      ),
    ).toBe(false);
    expect(
      isSubscriptionEntitled(
        { plan: 'premium', status: 'active', endDate: inDays(-1) },
        undefined,
        now,
      ),
    ).toBe(false);
  });

  it('keeps a cancelled plan entitled until endDate, never without one', () => {
    expect(
      isSubscriptionEntitled(
        { plan: 'premium', status: 'cancelled', endDate: inDays(10) },
        undefined,
        now,
      ),
    ).toBe(true);
    expect(
      isSubscriptionEntitled(
        { plan: 'premium', status: 'cancelled', endDate: inDays(-1) },
        undefined,
        now,
      ),
    ).toBe(false);
    expect(isSubscriptionEntitled({ plan: 'premium', status: 'cancelled' }, undefined, now)).toBe(
      false,
    );
  });

  it('restricts to the requested tiers', () => {
    const sub = { plan: 'premium', status: 'active', endDate: inDays(5) };
    expect(isSubscriptionEntitled(sub, ['business'], now)).toBe(false);
    expect(isSubscriptionEntitled(sub, ['premium'], now)).toBe(true);
  });
});

describe('computeNewEndDate', () => {
  it('starts from now when there is no current entitlement', () => {
    expect(computeNewEndDate(null, 'premium', 30, now).getTime()).toBe(inDays(30).getTime());
    expect(
      computeNewEndDate(
        { plan: 'premium', status: 'expired', endDate: inDays(-3) },
        'premium',
        30,
        now,
      ).getTime(),
    ).toBe(inDays(30).getTime());
  });

  it('appends to the remaining time when renewing the same plan', () => {
    const current = { plan: 'premium', status: 'active', endDate: inDays(10) };
    expect(computeNewEndDate(current, 'premium', 30, now).getTime()).toBe(inDays(40).getTime());
  });

  it('does not carry premium days over to a different plan', () => {
    const current = { plan: 'premium', status: 'active', endDate: inDays(10) };
    expect(computeNewEndDate(current, 'business', 30, now).getTime()).toBe(inDays(30).getTime());
  });
});
