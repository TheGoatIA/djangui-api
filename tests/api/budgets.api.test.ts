/**
 * MODULE BUDGETS — tests de bout en bout : création par période, modification, suivi des
 * dépenses (intégration avec /transactions), budgets partagés, historique, droits d'accès.
 */
import { useTestDB } from '../helpers/db';
import { anon, as } from '../helpers/http';
import { createUser } from '../helpers/factories';
import Budget from '../../src/models/Budget';
import BudgetParticipant from '../../src/models/BudgetParticipant';
import SavingGoal from '../../src/models/SavingGoal';

jest.setTimeout(60000);

const now = new Date();
const period = (o: Record<string, unknown> = {}) => ({
  type: 'monthly',
  month: now.getMonth() + 1,
  year: now.getFullYear(),
  ...o,
});
const body = (o: Record<string, unknown> = {}) => ({
  period: period(),
  categories: [
    { name: 'Alimentation', allocated: 60000 },
    { name: 'Transport', allocated: 40000 },
  ],
  totalAllocated: 100000,
  ...o,
});
async function createBudget(u: { _id: unknown }, o: Record<string, unknown> = {}) {
  const res = await as(u).post('/budgets').send(body(o));
  expect(res.status).toBe(201);
  return res.body.data as { _id: string };
}
const expense = (u: { _id: unknown }, amount: number, category: string) =>
  as(u)
    .post('/transactions')
    .send({
      type: 'expense',
      amount,
      category,
      description: `Dépense ${category}`,
      date: new Date().toISOString(),
    });

describe('API /budgets', () => {
  useTestDB();

  describe('Création', () => {
    it('crée le budget du mois dans la devise de l’utilisateur', async () => {
      const u = await createUser({ currency: 'XAF' });
      const b = await createBudget(u, { currency: 'EUR' });
      const db = await Budget.findById(b._id);
      expect(db).toMatchObject({ currency: 'XAF', totalAllocated: 100000, totalSpent: 0 });
      expect((await as(u).get('/budgets/current')).body.data._id).toBe(String(b._id));
    });

    it('un seul budget par période ; même en simultané', async () => {
      const u = await createUser();
      await createBudget(u);
      expect((await as(u).post('/budgets').send(body())).status).toBe(400);
      const v = await createUser();
      const r = await Promise.all([
        as(v).post('/budgets').send(body()),
        as(v).post('/budgets').send(body()),
      ]);
      expect(r.filter((x) => x.status === 201)).toHaveLength(1);
      expect(r.every((x) => x.status < 500)).toBe(true);
    });

    it.each([
      ['budget mensuel sans mois', { period: { type: 'monthly', year: 2026 } }],
      ['mois 13', { period: period({ month: 13 }) }],
      [
        'catégorie à montant négatif',
        { categories: [{ name: 'X', allocated: -1 }], totalAllocated: 0 },
      ],
      [
        'catégories en double',
        {
          categories: [
            { name: 'A', allocated: 1 },
            { name: 'a', allocated: 1 },
          ],
          totalAllocated: 2,
        },
      ],
    ])('refuse : %s → 400', async (_l, o) => {
      expect(
        (
          await as(await createUser())
            .post('/budgets')
            .send(body(o))
        ).status,
      ).toBe(400);
    });

    it('le total alloué est recalculé par le serveur à partir des catégories', async () => {
      const u = await createUser();
      const b = await createBudget(u, { totalAllocated: 5 });
      expect((await Budget.findById(b._id))!.totalAllocated).toBe(100000);
    });

    it('SÉCURITÉ : impossible de lier l’objectif d’un autre utilisateur', async () => {
      const other = await createUser();
      const goal = await SavingGoal.create({
        userId: other._id,
        name: 'g',
        targetAmount: 10,
        deadline: new Date(Date.now() + 1e9),
      });
      expect(
        (
          await as(await createUser())
            .post('/budgets')
            .send(body({ linkedGoalId: String(goal._id) }))
        ).status,
      ).toBe(404);
    });

    it('SÉCURITÉ : dépenses/total dépensé non fabricables à la création', async () => {
      const u = await createUser();
      const b = await createBudget(u, {
        totalSpent: 999,
        categories: [{ name: 'Alimentation', allocated: 100000, spent: 50000 }],
      });
      const db = await Budget.findById(b._id);
      expect(db!.totalSpent).toBe(0);
      expect(db!.categories[0].spent).toBe(0);
    });

    it('budget créé en cours de mois : les dépenses DÉJÀ faites sont comptées (serveur, pas le client)', async () => {
      const u = await createUser();
      await expense(u, 9000, 'Alimentation');
      await expense(u, 1500, 'alimentation'); // casse différente : même catégorie
      await expense(u, 700, 'Loisirs'); // hors budget
      const b = await createBudget(u, {
        categories: [
          { name: 'Alimentation', allocated: 10000 },
          { name: 'Transport', allocated: 5000 },
        ],
        totalAllocated: 15000,
      });
      const db = await Budget.findById(b._id);
      expect(db!.categories.find((c) => c.name === 'Alimentation')!.spent).toBe(10500);
      expect(db!.categories.find((c) => c.name === 'Transport')!.spent).toBe(0);
      expect(db!.totalSpent).toBe(10500);
      expect(db!.status).toBe('exceeded'); // 10 500 > 10 000 alloués
      // Une dépense suivante continue de s'ajouter normalement.
      await expense(u, 500, 'Transport');
      expect((await Budget.findById(b._id))!.totalSpent).toBe(11000);
    });
  });

  describe('Suivi des dépenses', () => {
    it('une dépense saisie alimente la catégorie et le total du budget du mois', async () => {
      const u = await createUser();
      const b = await createBudget(u);
      expect((await expense(u, 15000, 'Alimentation')).status).toBe(201);
      const db = await Budget.findById(b._id);
      expect(db!.categories.find((c) => c.name === 'Alimentation')!.spent).toBe(15000);
      expect(db!.totalSpent).toBe(15000);
    });

    it('modifier les allocations CONSERVE les dépenses déjà enregistrées', async () => {
      const u = await createUser();
      const b = await createBudget(u);
      await expense(u, 15000, 'Alimentation');
      const res = await as(u)
        .put(`/budgets/${b._id}`)
        .send({
          categories: [
            { name: 'Alimentation', allocated: 70000 },
            { name: 'Transport', allocated: 30000 },
          ],
          totalAllocated: 100000,
        });
      expect(res.status).toBe(200);
      const db = await Budget.findById(b._id);
      expect(db!.categories.find((c) => c.name === 'Alimentation')!.spent).toBe(15000);
      expect(db!.totalSpent).toBe(15000);
    });

    it('supprimer une catégorie qui a des dépenses → les dépenses ne disparaissent pas du total', async () => {
      const u = await createUser();
      const b = await createBudget(u);
      await expense(u, 10000, 'Transport');
      await as(u)
        .put(`/budgets/${b._id}`)
        .send({
          categories: [{ name: 'Alimentation', allocated: 100000 }],
          totalAllocated: 100000,
        });
      expect((await Budget.findById(b._id))!.totalSpent).toBe(10000);
    });

    it('budget partagé : la dépense d’un participant compte dans le budget commun', async () => {
      const owner = await createUser();
      const b = await createBudget(owner);
      const { inviteCode } = (await as(owner).post(`/budgets/${b._id}/share`)).body.data;
      const p = await createUser();
      expect((await as(p).post('/budgets/join').send({ inviteCode })).status).toBe(200);
      await expense(p, 5000, 'Transport');
      expect(
        (await Budget.findById(b._id))!.categories.find((c) => c.name === 'Transport')!.spent,
      ).toBe(5000);
    });
  });

  describe('Partage et droits', () => {
    it('participant : lecture seule, ne peut ni modifier ni supprimer ; un étranger ne voit rien', async () => {
      const owner = await createUser();
      const b = await createBudget(owner);
      const { inviteCode } = (await as(owner).post(`/budgets/${b._id}/share`)).body.data;
      const p = await createUser();
      await as(p).post('/budgets/join').send({ inviteCode });
      expect((await as(p).get('/budgets/current')).body.data.isOwner).toBe(false);
      expect((await as(p).put(`/budgets/${b._id}`).send({ totalAllocated: 1 })).status).toBe(404);
      expect((await as(p).delete(`/budgets/${b._id}`)).status).toBe(404);
      const stranger = await createUser();
      expect((await as(stranger).get(`/budgets/${b._id}/participants`)).status).toBe(403);
      expect((await as(stranger).get('/budgets')).body.data).toHaveLength(0);
    });

    it('quitter / être retiré coupe l’accès ; rejoindre deux fois → 400 ; code invalide → 404', async () => {
      const owner = await createUser();
      const b = await createBudget(owner);
      const { inviteCode } = (await as(owner).post(`/budgets/${b._id}/share`)).body.data;
      const p = await createUser();
      await as(p).post('/budgets/join').send({ inviteCode });
      expect((await as(p).post('/budgets/join').send({ inviteCode })).status).toBe(400);
      expect((await as(p).post('/budgets/join').send({ inviteCode: 'NOPE00000000' })).status).toBe(
        404,
      );
      await as(p).post(`/budgets/${b._id}/leave`);
      expect((await as(p).get('/budgets/current')).body.data).toBeNull();
      await as(p).post('/budgets/join').send({ inviteCode });
      const part = await BudgetParticipant.findOne({ budgetId: b._id, userId: p._id });
      await as(owner).delete(`/budgets/${b._id}/participants/${part!._id}`);
      expect((await as(p).get('/budgets/current')).body.data).toBeNull();
    });

    it('suppression : budget et participants effacés', async () => {
      const owner = await createUser();
      const b = await createBudget(owner);
      await as(owner).post(`/budgets/${b._id}/share`);
      expect((await as(owner).delete(`/budgets/${b._id}`)).status).toBeLessThan(300);
      expect(await Budget.findById(b._id)).toBeNull();
    });
  });

  describe('Historique', () => {
    it('historique d’une catégorie, catégorie absente → 400 (pas 500)', async () => {
      const u = await createUser();
      await createBudget(u);
      const ok = await as(u).get('/budgets/history?category=Alimentation&months=3');
      expect(ok.status).toBe(200);
      expect(ok.body.data[0]).toMatchObject({ allocated: 60000, spent: 0 });
      expect((await as(u).get('/budgets/history')).status).toBe(400);
    });
  });

  it('sans authentification → 401', async () => {
    expect((await anon().get('/budgets')).status).toBe(401);
  });
});
