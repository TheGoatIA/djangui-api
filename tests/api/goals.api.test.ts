/**
 * MODULE OBJECTIFS D'ÉPARGNE — tests de bout en bout (HTTP → services → MongoDB + Redis réels).
 * Création, contributions depuis le wallet, paliers, rachat (pénalité anticipée), suppression
 * (remboursement), partage (code, participants, départ, retrait), droits d'accès.
 */
import crypto from 'node:crypto';
import { useTestDB } from '../helpers/db';
import { anon, as } from '../helpers/http';
import { createUser } from '../helpers/factories';
import User from '../../src/models/User';
import SavingGoal from '../../src/models/SavingGoal';
import GoalParticipant from '../../src/models/GoalParticipant';
import Transaction from '../../src/models/Transaction';

jest.setTimeout(60000);

const inDays = (d: number) => new Date(Date.now() + d * 86400000).toISOString();
const goalBody = (o: Record<string, unknown> = {}) => ({
  name: 'Voyage Douala',
  targetAmount: 100000,
  deadline: inDays(90),
  type: 'project',
  ...o,
});
const balanceOf = async (u: { _id: unknown }) => (await User.findById(u._id))!.walletBalance;

async function createGoal(user: { _id: unknown }, o: Record<string, unknown> = {}) {
  const res = await as(user).post('/goals').send(goalBody(o));
  expect(res.status).toBe(201);
  return (res.body.data ?? res.body.goal ?? res.body) as { _id: string };
}
const contribute = (
  u: { _id: unknown },
  id: string,
  amount: unknown,
  headers: Record<string, string> = {},
) => as(u).post(`/goals/${id}/contribute`, { headers }).send({ amount, note: 'épargne' });

async function sharedGoal() {
  const owner = await createUser({ walletBalance: 100000 });
  const friend = await createUser({ walletBalance: 100000 });
  const g = await createGoal(owner);
  const { inviteCode } = (await as(owner).post(`/goals/${g._id}/share`)).body.data;
  expect((await as(friend).post('/goals/join').send({ inviteCode })).status).toBe(200);
  return { owner, friend, goalId: g._id, inviteCode };
}

describe('API /goals', () => {
  useTestDB();

  describe('Création', () => {
    it('crée un objectif à 0, dans la devise de l’utilisateur', async () => {
      const user = await createUser({ currency: 'XAF' });
      const g = await createGoal(user);
      const db = await SavingGoal.findById(g._id);
      expect(db).toMatchObject({
        currentAmount: 0,
        progress: 0,
        currency: 'XAF',
        status: 'active',
      });
    });

    it.each([
      ['montant cible nul', { targetAmount: 0 }],
      ['montant cible négatif', { targetAmount: -10 }],
      ['échéance passée', { deadline: inDays(-2) }],
      ['échéance absente', { deadline: undefined }],
      ['nom absent', { name: undefined }],
      ['type inconnu', { type: 'casino' }],
    ])('refuse : %s → 400', async (_l, o) => {
      expect(
        (
          await as(await createUser())
            .post('/goals')
            .send(goalBody(o))
        ).status,
      ).toBe(400);
    });

    it('SÉCURITÉ : impossible de créer un objectif avec un solde/statut fabriqué', async () => {
      const user = await createUser();
      const g = await createGoal(user, {
        currentAmount: 999999,
        status: 'completed',
        isShared: true,
        contributions: [{ amount: 5 }],
      });
      const db = await SavingGoal.findById(g._id);
      expect(db!.currentAmount).toBe(0);
      expect(db!.status).toBe('active');
      expect(db!.isShared).toBeFalsy();
      expect(db!.contributions).toHaveLength(0);
    });
  });

  describe('Contributions', () => {
    it('débite le wallet, crédite l’objectif, trace la transaction et la progression', async () => {
      const user = await createUser({ walletBalance: 50000 });
      const g = await createGoal(user);
      const res = await contribute(user, g._id, 25000);
      expect(res.status).toBe(200);
      expect(await balanceOf(user)).toBe(25000);
      const db = await SavingGoal.findById(g._id);
      expect(db!.currentAmount).toBe(25000);
      expect(db!.progress).toBe(25);
      expect(
        await Transaction.countDocuments({ userId: user._id, category: 'goal_contribution' }),
      ).toBe(1);
    });

    it.each([
      ['nul', 0],
      ['négatif', -100],
      ['texte', 'mille'],
      ['absent', undefined],
    ])('montant %s → 400, rien ne bouge', async (_l, amount) => {
      const user = await createUser({ walletBalance: 50000 });
      const g = await createGoal(user);
      expect((await contribute(user, g._id, amount)).status).toBe(400);
      expect(await balanceOf(user)).toBe(50000);
    });

    it('solde insuffisant → 400, objectif inchangé', async () => {
      const user = await createUser({ walletBalance: 100 });
      const g = await createGoal(user);
      expect((await contribute(user, g._id, 1000)).status).toBe(400);
      expect((await SavingGoal.findById(g._id))!.currentAmount).toBe(0);
    });

    it('idempotence : double soumission avec la même clé → un seul débit', async () => {
      const user = await createUser({ walletBalance: 50000 });
      const g = await createGoal(user);
      const headers = { 'Idempotency-Key': crypto.randomUUID() };
      await contribute(user, g._id, 1000, headers);
      expect((await contribute(user, g._id, 1000, headers)).status).toBe(409);
      expect(await balanceOf(user)).toBe(49000);
    });

    it('CONCURRENCE : contributions simultanées → aucun montant perdu ni solde négatif', async () => {
      const user = await createUser({ walletBalance: 3000 });
      const g = await createGoal(user);
      const r = await Promise.all(Array.from({ length: 5 }, () => contribute(user, g._id, 1000)));
      const ok = r.filter((x) => x.status === 200).length;
      expect(ok).toBe(3);
      expect(await balanceOf(user)).toBe(0);
      expect((await SavingGoal.findById(g._id))!.currentAmount).toBe(3000);
    });

    it('SÉCURITÉ : un étranger ne peut ni voir ni alimenter l’objectif (404)', async () => {
      const owner = await createUser();
      const g = await createGoal(owner);
      const stranger = await createUser({ walletBalance: 5000 });
      expect((await as(stranger).get(`/goals/${g._id}`)).status).toBe(404);
      expect((await contribute(stranger, g._id, 1000)).status).toBe(404);
      expect(await balanceOf(stranger)).toBe(5000);
    });
  });

  describe('Modification', () => {
    it('changer le montant cible recalcule la progression', async () => {
      const user = await createUser({ walletBalance: 50000 });
      const g = await createGoal(user);
      await contribute(user, g._id, 50000);
      await as(user).put(`/goals/${g._id}`).send({ targetAmount: 50000 });
      expect((await SavingGoal.findById(g._id))!.progress).toBe(100);
    });

    it('SÉCURITÉ : le client ne peut pas se déclarer "completed" pour échapper à la pénalité', async () => {
      const user = await createUser({ walletBalance: 50000 });
      const g = await createGoal(user);
      await contribute(user, g._id, 10000);
      expect((await as(user).put(`/goals/${g._id}`).send({ status: 'completed' })).status).toBe(
        400,
      );
    });

    it('seul le propriétaire modifie l’objectif', async () => {
      const { friend, goalId } = await sharedGoal();
      expect((await as(friend).put(`/goals/${goalId}`).send({ name: 'pirate' })).status).toBe(404);
    });
  });

  describe('Rachat et suppression', () => {
    it('rachat anticipé : pénalité de 0,5 %', async () => {
      const user = await createUser({ walletBalance: 20000 });
      const g = await createGoal(user);
      await contribute(user, g._id, 20000);
      expect((await as(user).post(`/goals/${g._id}/redeem`).send({ amount: 10000 })).status).toBe(
        200,
      );
      expect(await balanceOf(user)).toBe(10000 - 50);
      expect((await SavingGoal.findById(g._id))!.currentAmount).toBe(10000);
    });

    it('objectif ATTEINT avant l’échéance : rachat sans pénalité', async () => {
      const user = await createUser({ walletBalance: 100000 });
      const g = await createGoal(user);
      await contribute(user, g._id, 100000);
      await as(user).post(`/goals/${g._id}/redeem`).send({});
      expect(await balanceOf(user)).toBe(100000);
    });

    it('rachat supérieur au solde ou négatif → 400', async () => {
      const user = await createUser({ walletBalance: 5000 });
      const g = await createGoal(user);
      await contribute(user, g._id, 5000);
      expect((await as(user).post(`/goals/${g._id}/redeem`).send({ amount: 6000 })).status).toBe(
        400,
      );
      expect((await as(user).post(`/goals/${g._id}/redeem`).send({ amount: -1 })).status).toBe(400);
    });

    it('CONCURRENCE : deux rachats simultanés du solde complet → crédité une seule fois', async () => {
      const user = await createUser({ walletBalance: 100000 });
      const g = await createGoal(user, { targetAmount: 10000 });
      await contribute(user, g._id, 10000);
      await Promise.all([
        as(user).post(`/goals/${g._id}/redeem`).send({}),
        as(user).post(`/goals/${g._id}/redeem`).send({}),
      ]);
      expect(await balanceOf(user)).toBe(100000);
      expect((await SavingGoal.findById(g._id))!.currentAmount).toBe(0);
    });

    it('suppression : remboursement du solde (pénalité si anticipée), participants nettoyés', async () => {
      const user = await createUser({ walletBalance: 10000 });
      const g = await createGoal(user);
      await contribute(user, g._id, 10000);
      expect((await as(user).delete(`/goals/${g._id}`)).status).toBe(200);
      expect(await balanceOf(user)).toBe(10000 - 50);
      expect(await SavingGoal.findById(g._id)).toBeNull();
    });
  });

  describe('Objectifs partagés', () => {
    it('partage : code CSPRNG, le participant voit et alimente l’objectif commun', async () => {
      const { owner, friend, goalId, inviteCode } = await sharedGoal();
      expect(inviteCode).toMatch(/^[0-9A-F]{12}$/);
      expect((await as(friend).get(`/goals/${goalId}`)).body.data.isOwner).toBe(false);
      await contribute(friend, goalId, 30000);
      await contribute(owner, goalId, 10000);
      expect((await SavingGoal.findById(goalId))!.currentAmount).toBe(40000);
      expect((await as(friend).get(`/goals/${goalId}/participants`)).body.data).toHaveLength(1);
    });

    it('rejoindre deux fois → 400 ; propriétaire → 400 ; code invalide → 404', async () => {
      const { owner, friend, inviteCode } = await sharedGoal();
      expect((await as(friend).post('/goals/join').send({ inviteCode })).status).toBe(400);
      expect((await as(owner).post('/goals/join').send({ inviteCode })).status).toBe(400);
      expect(
        (await as(friend).post('/goals/join').send({ inviteCode: 'ZZZZZZZZZZZZ' })).status,
      ).toBe(404);
    });

    it('le participant ne peut ni racheter ni supprimer le pot commun', async () => {
      const { friend, goalId } = await sharedGoal();
      await contribute(friend, goalId, 30000);
      expect((await as(friend).post(`/goals/${goalId}/redeem`).send({})).status).toBe(404);
      expect((await as(friend).delete(`/goals/${goalId}`)).status).toBe(404);
      expect(await balanceOf(friend)).toBe(70000);
    });

    it('ARGENT : supprimer un objectif partagé rembourse CHAQUE contributeur de sa part', async () => {
      const { owner, friend, goalId } = await sharedGoal();
      await contribute(friend, goalId, 30000);
      await contribute(owner, goalId, 10000);
      await as(owner).delete(`/goals/${goalId}`);
      expect(await balanceOf(friend)).toBe(100000 - 150); // 30 000 rendus, pénalité anticipée 0,5 %
      expect(await balanceOf(owner)).toBe(100000 - 50);
    });

    it('retrait d’un participant par le propriétaire ; départ volontaire ; accès coupé ensuite', async () => {
      const { owner, friend, goalId } = await sharedGoal();
      const p = await GoalParticipant.findOne({ goalId, userId: friend._id });
      expect([200, 204]).toContain(
        (await as(owner).delete(`/goals/${goalId}/participants/${p!._id}`)).status,
      );
      expect((await as(friend).get(`/goals/${goalId}`)).status).toBe(404);
      expect((await as(friend).post(`/goals/${goalId}/leave`)).status).toBe(404);
    });

    it('SÉCURITÉ : le participant d’un objectif ne peut pas retirer les participants', async () => {
      const { friend, goalId } = await sharedGoal();
      const p = await GoalParticipant.findOne({ goalId, userId: friend._id });
      expect((await as(friend).delete(`/goals/${goalId}/participants/${p!._id}`)).status).toBe(404);
    });
  });

  it('sans authentification → 401', async () => {
    expect((await anon().get('/goals')).status).toBe(401);
  });
  describe('Objectifs partagés — propriété de l’argent', () => {
    it('le propriétaire ne peut racheter que SA part', async () => {
      const { owner, friend, goalId } = await sharedGoal();
      await contribute(friend, goalId, 30000);
      await contribute(owner, goalId, 10000);
      expect((await as(owner).post(`/goals/${goalId}/redeem`).send({ amount: 20000 })).status).toBe(
        400,
      );
      expect((await as(owner).post(`/goals/${goalId}/redeem`).send({})).status).toBe(200); // sa part : 10 000
      expect(await balanceOf(owner)).toBe(100000 - 50);
      expect((await SavingGoal.findById(goalId))!.currentAmount).toBe(30000);
    });

    it('départ volontaire : le participant récupère sa part (pénalité anticipée 0,5 %)', async () => {
      const { friend, goalId } = await sharedGoal();
      await contribute(friend, goalId, 30000);
      expect((await as(friend).post(`/goals/${goalId}/leave`)).status).toBeLessThan(300);
      expect(await balanceOf(friend)).toBe(100000 - 150);
      expect((await SavingGoal.findById(goalId))!.currentAmount).toBe(0);
    });

    it('retrait par le propriétaire : part remboursée SANS pénalité ; rien ne reste au propriétaire', async () => {
      const { owner, friend, goalId } = await sharedGoal();
      await contribute(friend, goalId, 30000);
      const p = await GoalParticipant.findOne({ goalId, userId: friend._id });
      await as(owner).delete(`/goals/${goalId}/participants/${p!._id}`);
      expect(await balanceOf(friend)).toBe(100000);
      expect((await as(owner).post(`/goals/${goalId}/redeem`).send({ amount: 1 })).status).toBe(
        400,
      );
    });

    it('CONCURRENCE : départ simultané en double → remboursé une seule fois', async () => {
      const { friend, goalId } = await sharedGoal();
      await contribute(friend, goalId, 30000);
      await Promise.all([
        as(friend).post(`/goals/${goalId}/leave`),
        as(friend).post(`/goals/${goalId}/leave`),
      ]);
      expect(await balanceOf(friend)).toBe(100000 - 150);
    });

    it('revenir après un départ : la part repart de zéro (pas de double remboursement)', async () => {
      const { owner, friend, goalId, inviteCode } = await sharedGoal();
      await contribute(friend, goalId, 30000);
      await as(friend).post(`/goals/${goalId}/leave`);
      await as(friend).post('/goals/join').send({ inviteCode });
      await contribute(friend, goalId, 5000);
      await as(owner).delete(`/goals/${goalId}`);
      expect(await balanceOf(friend)).toBe(100000 - 150 - 25); // 5 000 rendus moins 0,5 %
    });
  });
});
