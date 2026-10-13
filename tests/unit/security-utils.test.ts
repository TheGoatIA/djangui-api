import { safeEqual } from '../../src/utils/safeCompare';
import { requireClientApiKey } from '../../src/middleware/clientApiKey';
import { isCookieOnlyClient } from '../../src/utils/authCookies';

const mockRes = () => {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

describe('safeEqual', () => {
  it('matches identical strings and rejects different ones (any length)', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', 'x')).toBe(false);
  });
});

describe('requireClientApiKey', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('accepts the configured key', () => {
    process.env.MOBILE_CLIENT_API_KEY = 'k3y';
    const next = jest.fn();
    requireClientApiKey({ headers: { 'x-client-key': 'k3y' } } as any, mockRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it('rejects a wrong or missing key', () => {
    process.env.MOBILE_CLIENT_API_KEY = 'k3y';
    const res = mockRes();
    const next = jest.fn();
    requireClientApiKey({ headers: { 'x-client-key': 'nope' } } as any, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('fails closed in production when no key is configured', () => {
    delete process.env.MOBILE_CLIENT_API_KEY;
    process.env.NODE_ENV = 'production';
    const res = mockRes();
    const next = jest.fn();
    requireClientApiKey({ headers: {} } as any, res, next);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('isCookieOnlyClient', () => {
  it('detects the web client header only', () => {
    expect(isCookieOnlyClient({ headers: { 'x-client-type': 'web' } })).toBe(true);
    expect(isCookieOnlyClient({ headers: { 'x-client-type': 'WEB' } })).toBe(true);
    expect(isCookieOnlyClient({ headers: {} })).toBe(false);
    expect(isCookieOnlyClient({ headers: { 'x-client-type': 'mobile' } })).toBe(false);
  });
});

describe('createSendToken', () => {
  it('issues distinct tokens even within the same second (jti)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createSendToken } = require('../../src/services/authService');
    const user: any = { _id: { toString: () => '64b000000000000000000001' } };
    const a = createSendToken(user);
    const b = createSendToken(user);
    expect(a.refreshToken).not.toBe(b.refreshToken);
    expect(a.accessToken).not.toBe(b.accessToken);
  });
});
