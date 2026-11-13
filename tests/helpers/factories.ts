/**
 * Fabriques de données de test. Chaque appel produit des valeurs UNIQUES (email,
 * téléphone…) pour que les tests n'aient jamais de dépendance d'ordre entre eux.
 */
import jwt from 'jsonwebtoken';
import User from '../../src/models/User';

let seq = 0;
const uid = () => `${Date.now().toString(36)}${(++seq).toString(36)}`;

export const STRONG_PASSWORD = 'Password123!';

export interface UserOverrides {
  email?: string;
  password?: string | null;
  firstName?: string;
  lastName?: string;
  role?: 'user' | 'admin' | 'support';
  plan?: 'free' | 'premium' | 'business';
  walletBalance?: number;
  isActive?: boolean;
  isEmailVerified?: boolean;
  country?: string;
  currency?: string;
  kycLevel?: string;
  [key: string]: unknown;
}

export async function createUser(overrides: UserOverrides = {}) {
  const { plan, password, ...rest } = overrides;
  const doc: Record<string, unknown> = {
    email: `user_${uid()}@example.com`,
    firstName: 'Test',
    lastName: 'User',
    country: 'CM',
    currency: 'XAF',
    isEmailVerified: true,
    ...rest,
  };
  if (password !== null) doc.password = password ?? STRONG_PASSWORD;
  if (plan && plan !== 'free') {
    doc.subscription = {
      plan,
      status: 'active',
      startDate: new Date(),
      endDate: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    };
  }
  return User.create(doc);
}

export const createAdmin = (o: UserOverrides = {}) => createUser({ role: 'admin', ...o });
export const createSupport = (o: UserOverrides = {}) => createUser({ role: 'support', ...o });
export const createPremium = (o: UserOverrides = {}) => createUser({ plan: 'premium', ...o });

/** Jeton d'accès signé exactement comme AuthService (HS256, même secret). */
export function accessTokenFor(user: { _id: unknown }, opts: { expiresIn?: string | number } = {}) {
  return jwt.sign({ id: String(user._id) }, process.env.JWT_ACCESS_SECRET as string, {
    algorithm: 'HS256',
    expiresIn: (opts.expiresIn ?? '15m') as any,
  });
}

export const uniqueEmail = () => `new_${uid()}@example.com`;
export const uniquePhone = () => `+2376${String(Date.now()).slice(-8)}`;
