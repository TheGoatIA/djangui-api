/**
 * MODULE DÉFIS — tests de bout en bout : inscription, dépôts d'épargne réels (wallet),
 * validation / report / saut de semaines, progression, récupération des fonds, abandon,
 * expiration, droits d'accès.
 */
import crypto from 'node:crypto';
import { useTestDB } from '../helpers/db';
import { anon, as } from '../helpers/http';
import { createUser } from '../helpers/factories';
import User from '../../src/models/User';
import Challenge from '../../src/models/Challenge';
import UserChallenge from '../../src/models/UserChallenge';
import { ChallengeService } from '../../src/services/challengeService';

jest.setTimeout(60000);

const balanceOf = async (u: { _id: unknown }) => (await User.findById(u._id))!.walletBalance;
const savingChallenge = () =>
  Challenge.create({
    title: 'Épargne 4 semaines',
    description: 'd',
    type: 'saving',
    targetAmount: 40000,
    durationDays: 28,
    difficulty: 'easy',
    rewardPoints: 100,
  });

async function joined(balance = 100000) {
  const user = await createUser({ walletBalance: balance });
  const ch = await savingChallenge();
  const res = await as(user)
    .post('/challenges/join')
    .send({ challengeId: String(ch._id) });
  expect(res.status).toBeLessThan(300);
  const uc = await UserChallenge.findOne({ userId: user._id });
  return { user, ucId: String(uc!._id) };
}
const validate = (
  u: { _id: unknown },
  id: string,
  weekNumber: number,
  extra: Record<string, unknown> = {},
) =>
  as(u)
    .post(`/challenges/${id}/validate-week`)
    .send({ weekNumber, ...extra });

describe('API /challenges', () => {
  useTestDB();

  it('liste des défis et inscription : 4 semaines de 10 000', async () => {
    const { user, ucId } = await joined();
    const uc = await UserChallenge.findById(ucId);
    expect(uc!.weeks).toHaveLength(4);
    expect(uc!.weeks[0].targetAmount).toBe(10000);
    expect((await as(user).get('/challenges/my-challenges')).body.data).toHaveLength(1);
  });

  it('double inscription (y compris simultanée) → une seule participation active', async () => {
    const user = await createUser();
    const ch = await savingChallenge();
    const r = await Promise.all(
      Array.from({ length: 3 }, () =>
        as(user)
          .post('/challenges/join')
          .send({ challengeId: String(ch._id) }),
      ),
    );
    expect(r.filter((x) => x.status < 300)).toHaveLength(1);
    expect(r.every((x) => x.status < 500)).toBe(true);
    expect(await UserChallenge.countDocuments({ userId: user._id, status: 'active' })).toBe(1);
  });

  it('défi inexistant / identifiant invalide → 4xx', async () => {
    const user = await createUser();
    expect(
      (await as(user).post('/challenges/join').send({ challengeId: '000000000000000000000000' }))
        .status,
    ).toBe(404);
    expect(
      (await as(user).post('/challenges/join').send({ challengeId: 'pas-un-id' })).status,
    ).toBeLessThan(500);
  });

  it('valider une semaine débite le reliquat du wallet', async () => {
    const { user, ucId } = await joined();
    expect((await validate(user, ucId, 1)).status).toBe(200);
    expect(await balanceOf(user)).toBe(90000);
    const uc = await UserChallenge.findById(ucId);
    expect(uc!.currentValue).toBe(10000);
    expect(uc!.progress).toBe(25);
  });

  it('dépôt partiel puis validation : seul le reliquat est débité (pas de double débit)', async () => {
    const { user, ucId } = await joined();
    await as(user)
      .post('/challenges/deposit')
      .send({ userChallengeId: ucId, weekNumber: 1, amount: 4000 });
    await validate(user, ucId, 1);
    expect(await balanceOf(user)).toBe(90000);
  });

  it('montant insuffisant / solde insuffisant → la semaine n’est pas validée', async () => {
    const { user, ucId } = await joined(5000);
    expect((await validate(user, ucId, 1)).status).toBe(400);
    expect((await validate(user, ucId, 1, { amount: 100 })).status).toBe(400);
    expect((await UserChallenge.findById(ucId))!.weeks[0].status).toBe('pending');
    expect(await balanceOf(user)).toBe(5000);
  });

  it('idempotence : même clé → 409, un seul débit', async () => {
    const { user, ucId } = await joined();
    const headers = { 'Idempotency-Key': crypto.randomUUID() };
    await as(user).post(`/challenges/${ucId}/validate-week`, { headers }).send({ weekNumber: 1 });
    expect(
      (
        await as(user)
          .post(`/challenges/${ucId}/validate-week`, { headers })
          .send({ weekNumber: 1 })
      ).status,
    ).toBe(409);
    expect(await balanceOf(user)).toBe(90000);
  });

  it('défi complet → statut "completed", fonds récupérables une seule fois', async () => {
    const { user, ucId } = await joined();
    for (const w of [1, 2, 3, 4]) await validate(user, ucId, w);
    expect((await UserChallenge.findById(ucId))!.status).toBe('completed');
    expect(await balanceOf(user)).toBe(60000);
    await Promise.all([
      as(user).post(`/challenges/${ucId}/redeem`),
      as(user).post(`/challenges/${ucId}/redeem`),
    ]);
    expect(await balanceOf(user)).toBe(100000);
    expect((await UserChallenge.findById(ucId))!.status).toBe('redeemed');
  });

  it('une semaine sautée puis les autres validées → défi terminé et fonds récupérables', async () => {
    const { user, ucId } = await joined();
    await as(user).post(`/challenges/${ucId}/skip`).send({ weekNumber: 2 });
    for (const w of [1, 3, 4]) await validate(user, ucId, w);
    expect((await UserChallenge.findById(ucId))!.status).toBe('completed');
    expect((await as(user).post(`/challenges/${ucId}/redeem`)).status).toBe(200);
    expect(await balanceOf(user)).toBe(100000);
  });

  it('récupérer avant la fin → 400', async () => {
    const { user, ucId } = await joined();
    await validate(user, ucId, 1);
    expect((await as(user).post(`/challenges/${ucId}/redeem`)).status).toBe(400);
  });

  it('report : +7 jours, limité à 2 ; saut limité à 3 ; uniquement une semaine en attente', async () => {
    const { user, ucId } = await joined();
    const before = (await UserChallenge.findById(ucId))!.endDate.getTime();
    expect(
      (await as(user).post(`/challenges/${ucId}/postpone`).send({ weekNumber: 1 })).status,
    ).toBe(200);
    expect((await UserChallenge.findById(ucId))!.endDate.getTime() - before).toBe(7 * 86400000);
    expect(
      (await as(user).post(`/challenges/${ucId}/postpone`).send({ weekNumber: 1 })).status,
    ).toBe(400);
    await as(user).post(`/challenges/${ucId}/postpone`).send({ weekNumber: 2 });
    expect(
      (await as(user).post(`/challenges/${ucId}/postpone`).send({ weekNumber: 3 })).status,
    ).toBe(400);
    expect((await as(user).post(`/challenges/${ucId}/skip`).send({ weekNumber: 9 })).status).toBe(
      404,
    );
  });

  it('abandon : remboursement de l’épargne moins 0,5 %', async () => {
    const { user, ucId } = await joined();
    await validate(user, ucId, 1);
    expect((await as(user).delete(`/challenges/${ucId}`)).status).toBeLessThan(300);
    expect(await balanceOf(user)).toBe(100000 - 50);
    expect(await UserChallenge.findById(ucId)).toBeNull();
  });

  it('expiration : défi "failed", plus de validation possible, épargne récupérable par abandon', async () => {
    const { user, ucId } = await joined();
    await validate(user, ucId, 1);
    await UserChallenge.updateOne({ _id: ucId }, { endDate: new Date(Date.now() - 1000) });
    expect(await ChallengeService.resolveExpiredChallenges()).toBe(1);
    expect((await UserChallenge.findById(ucId))!.status).toBe('failed');
    expect((await validate(user, ucId, 2)).status).toBe(400);
    await as(user).delete(`/challenges/${ucId}`);
    expect(await balanceOf(user)).toBe(100000 - 50);
  });

  it('SÉCURITÉ : lien de preuve javascript: refusé', async () => {
    const { user, ucId } = await joined();
    expect((await validate(user, ucId, 1, { proofImageUrl: 'javascript:alert(1)' })).status).toBe(
      400,
    );
    expect(await balanceOf(user)).toBe(100000);
  });

  it('SÉCURITÉ : impossible d’agir sur le défi d’un autre utilisateur', async () => {
    const { ucId } = await joined();
    const other = await createUser({ walletBalance: 50000 });
    expect((await validate(other, ucId, 1)).status).toBe(404);
    expect((await as(other).post(`/challenges/${ucId}/redeem`)).status).toBe(404);
    expect((await as(other).delete(`/challenges/${ucId}`)).status).toBe(404);
    expect(await balanceOf(other)).toBe(50000);
  });

  it('sans authentification → 401', async () => {
    expect((await anon().get('/challenges')).status).toBe(401);
  });
});
