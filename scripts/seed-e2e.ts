/**
 * Seed for the END-TO-END tests (admin dashboard Playwright suite, mobile E2E).
 *
 * Refuses to run unless MONGODB_URI points at a database whose name contains
 * "e2e": it DROPS that database first. Never point it at dev/staging/prod.
 *
 *   MONGODB_URI=mongodb://127.0.0.1:27037/kauri_e2e?directConnection=true \
 *     npx ts-node --transpile-only scripts/seed-e2e.ts
 */
import mongoose from 'mongoose';
import Redis from 'ioredis';
import User from '../src/models/User';
import Transaction from '../src/models/Transaction';
import Tontine from '../src/models/Tontine';
import TontineMember from '../src/models/TontineMember';
import SupportTicket from '../src/models/SupportTicket';
import SavingGoal from '../src/models/SavingGoal';
import Payment from '../src/models/Payment';
import SystemSetting from '../src/models/SystemSetting';

export const E2E_PASSWORD = 'E2e-Passw0rd!';

async function main() {
  const uri = process.env.MONGODB_URI || '';
  const dbName = new URL(uri.replace('mongodb://', 'http://')).pathname.replace('/', '');
  if (!/e2e/i.test(dbName)) {
    throw new Error(`Refus : la base "${dbName}" n'est pas une base e2e (le seed la vide).`);
  }
  await mongoose.connect(uri);
  await mongoose.connection.db!.dropDatabase();

  // Fresh rate-limit / lockout / idempotency state for every run (Redis is real).
  if (process.env.REDIS_URL) {
    const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 });
    await redis.flushdb();
    redis.disconnect();
  }

  const mk = (o: Record<string, unknown>) =>
    User.create({ password: E2E_PASSWORD, country: 'CM', currency: 'XAF', isEmailVerified: true, ...o });

  const admin = await mk({ email: 'admin@kauri-e2e.com', firstName: 'Ada', lastName: 'Admin', role: 'admin' });
  await mk({ email: 'admin2@kauri-e2e.com', firstName: 'Bob', lastName: 'Second', role: 'admin' });
  // Dedicated to login/logout tests (logout revokes the session: never the shared admin).
  await mk({ email: 'authflow@kauri-e2e.com', firstName: 'Auth', lastName: 'Flow', role: 'admin' });
  await mk({ email: 'support@kauri-e2e.com', firstName: 'Sam', lastName: 'Support', role: 'support' });
  await mk({ email: 'user@kauri-e2e.com', firstName: 'Ulla', lastName: 'User', role: 'user' });

  const customer = await mk({
    email: 'client@kauri-e2e.com', firstName: 'Awa', lastName: 'Ngono', walletBalance: 25000,
    phone: '+237670000000', kycLevel: 'verified',
  });
  const banned = await mk({ email: 'banme@kauri-e2e.com', firstName: 'Ban', lastName: 'Me' });

  // KYC pending (document URLs point at the e2e storage; images are not needed for the list)
  await mk({
    email: 'kyc@kauri-e2e.com', firstName: 'Kofi', lastName: 'Kyc', kycLevel: 'pending',
    kycData: {
      documentType: 'cni', documentNumber: 'CM-E2E-001', fullName: 'Kofi Kyc',
      documentImageUrl: `${process.env.MINIO_PUBLIC_URL}/kauri-uploads/documents/x/doc.png`,
      selfieImageUrl: `${process.env.MINIO_PUBLIC_URL}/kauri-uploads/documents/x/selfie.png`,
      aiAnalysisStatus: 'completed', aiConfidence: 88, aiReport: 'Concordant',
    },
  });

  // A pending withdrawal (wallet transaction) for the Payouts screen
  await Transaction.create({
    userId: customer._id, amount: 5000, fees: 150, currency: 'XAF', type: 'expense', category: 'withdrawal',
    description: 'Retrait MoMo Kauri', status: 'pending', reference: 'TXN-E2E-WD1', paymentMethod: 'wallet',
    externalReference: 'trf.test_e2e', metadata: { phone: '+237670000000', provider: 'cm.mtn' },
  });
  await Transaction.create({
    userId: customer._id, amount: 25000, currency: 'XAF', type: 'income', category: 'deposit',
    description: 'Recharge', status: 'completed', reference: 'TXN-E2E-DEP1', paymentMethod: 'notchpay',
  });
  await Payment.create({
    userId: customer._id, amount: 2000, currency: 'XAF', method: 'notchpay', type: 'subscription',
    reference: 'NTP-E2E0001', status: 'pending', externalReference: 'trx.test_e2e', metadata: { plan: 'premium' },
  });

  const tontine = await Tontine.create({
    name: 'Tontine E2E', creatorId: customer._id, frequency: 'monthly', startDate: new Date(),
    contributionAmount: 10000, totalParts: 2, status: 'active',
  });
  await TontineMember.create([
    { tontineId: tontine._id, userId: customer._id, displayName: 'Awa', invitationStatus: 'accepted', rotationOrder: 1, rotationOrders: [1] },
    { tontineId: tontine._id, userId: banned._id, displayName: 'Ban', invitationStatus: 'accepted', rotationOrder: 2, rotationOrders: [2] },
  ]);

  await SavingGoal.create({
    userId: customer._id, name: 'Objectif E2E', targetAmount: 100000, currentAmount: 0,
    deadline: new Date(Date.now() + 90 * 86400000),
  });
  await SupportTicket.create({ userId: customer._id, subject: 'Ticket E2E', message: 'Aide svp', category: 'payment' });

  // Mobile user journeys (integration_test/journeys): a fresh, KYC-verified
  // account with money to spend, and a friend to invite into a tontine.
  await mk({
    email: 'mobile@kauri-e2e.com', firstName: 'Mia', lastName: 'Mobile', walletBalance: 100000,
    phone: '+237690000001', kycLevel: 'verified', isPhoneVerified: true,
  });
  await mk({
    email: 'friend@kauri-e2e.com', firstName: 'Fred', lastName: 'Friend', walletBalance: 50000,
    phone: '+237690000002', kycLevel: 'verified', isPhoneVerified: true,
  });

  // E2E_REAL_MONEY=1 → real-money mode ON (wallet recharge/withdraw flows).
  // Written directly (NOT via FeatureFlagService.setRealMoneyMode) so the
  // one-time "reset simulated balances" migration does not wipe the seed.
  if (process.env.E2E_REAL_MONEY === '1') {
    await SystemSetting.create({ key: 'real_money_mode', value: true });
  }

  console.log(JSON.stringify({ seeded: true, admin: String(admin._id), tontine: String(tontine._id) }));
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
