/**
 * NOTIFICATIONS, SUPPORT, EXPORTS, ABONNEMENTS SUIVIS — tests de bout en bout.
 */
import { useTestDB } from '../helpers/db';
import { as } from '../helpers/http';
import { createUser, createAdmin, createSupport } from '../helpers/factories';
import User from '../../src/models/User';
import Notification from '../../src/models/Notification';
import Subscription from '../../src/models/Subscription';
import SupportTicket from '../../src/models/SupportTicket';
import { NotificationService } from '../../src/services/notificationService';
import { SubscriptionService } from '../../src/services/subscriptionService';
import { ResellerAnalyticsService } from '../../src/services/resellerAnalyticsService';
import SlotPaymentHistory from '../../src/models/SlotPaymentHistory';
import admin from '../../src/config/firebase';

jest.setTimeout(60000);

describe('Notifications, support, exports', () => {
  useTestDB();

  describe('Notifications', () => {
    const pushSpy = () => {
      const send = jest
        .fn()
        .mockResolvedValue({ responses: [{ success: true }], successCount: 1, failureCount: 0 });
      jest.spyOn(admin, 'apps', 'get').mockReturnValue([{} as any]);
      jest.spyOn(admin, 'messaging').mockReturnValue({ sendEachForMulticast: send } as any);
      return send;
    };

    it.each([
      ['low', 'important', true],
      ['low', 'transactional', true],
      ['low', 'informational', false],
      ['medium', 'important', true],
      ['medium', 'informational', false],
      ['high', 'informational', true],
    ])(
      'fréquence %s / catégorie %s → push envoyé : %s (historique toujours enregistré)',
      async (freq, category, pushed) => {
        const send = pushSpy();
        const u = await createUser({
          fcmTokens: ['tok'],
          preferences: { notificationFrequency: freq },
        });
        await NotificationService.sendToUser(String(u._id), {
          title: 'T',
          body: 'B',
          category: category as any,
        });
        expect(send).toHaveBeenCalledTimes(pushed ? 1 : 0);
        expect(await Notification.countDocuments({ userId: u._id })).toBe(1);
      },
    );

    it('jetons FCM invalides retirés automatiquement', async () => {
      const send = jest.fn().mockResolvedValue({
        responses: [
          { success: false, error: { code: 'messaging/registration-token-not-registered' } },
          { success: true },
        ],
        successCount: 1,
        failureCount: 1,
      });
      jest.spyOn(admin, 'apps', 'get').mockReturnValue([{} as any]);
      jest.spyOn(admin, 'messaging').mockReturnValue({ sendEachForMulticast: send } as any);
      const u = await createUser({ fcmTokens: ['dead', 'alive'] });
      await NotificationService.sendToUser(String(u._id), {
        title: 'T',
        body: 'B',
        category: 'important',
      });
      expect((await User.findById(u._id))!.fcmTokens).toEqual(['alive']);
    });

    it('API : liste paginée (plafonnée), compteur, lecture, suppression — uniquement les siennes', async () => {
      const u = await createUser();
      const other = await createUser();
      for (let i = 0; i < 3; i++)
        await NotificationService.sendToUser(String(u._id), {
          title: `n${i}`,
          body: 'b',
          category: 'informational',
        });
      await NotificationService.sendToUser(String(other._id), {
        title: 'x',
        body: 'b',
        category: 'informational',
      });
      const list = await as(u).get('/notifications?limit=100000');
      expect(list.status).toBe(200);
      expect(JSON.stringify(list.body)).not.toContain('"x"');
      expect((await as(u).get('/notifications/unread-count')).status).toBe(200);
      const theirs = await Notification.findOne({ userId: other._id });
      expect((await as(u).patch(`/notifications/${theirs!._id}/read`)).status).toBe(404);
      expect((await as(u).delete(`/notifications/${theirs!._id}`)).status).toBe(404);
      expect((await as(u).patch('/notifications/mark-all-read')).status).toBe(200);
    });
  });

  describe('Support', () => {
    it('parcours complet : ticket utilisateur → réponse support → réponse utilisateur rouvre le ticket', async () => {
      const u = await createUser();
      const created = await as(u).post('/support/tickets').send({
        subject: 'Retrait bloqué',
        message: 'Mon retrait est en attente',
        category: 'payment',
      });
      expect(created.status).toBe(201);
      const id = created.body.data._id;
      const support = await createSupport();
      expect((await as(support).get('/admin/support/tickets?search=(a%2B)%2B')).status).toBe(200);
      expect(
        (
          await as(support)
            .post(`/admin/support/tickets/${id}/reply`)
            .send({ message: 'Nous vérifions' })
        ).status,
      ).toBeLessThan(300);
      expect(
        (await as(support).patch(`/admin/support/tickets/${id}/status`).send({ status: 'closed' }))
          .status,
      ).toBe(200);
      await as(u).post(`/support/tickets/${id}/reply`).send({ message: 'Merci, toujours bloqué' });
      expect((await SupportTicket.findById(id))!.status).toBe('open');
    });

    it('validation : 400 (et non 500) ; statut admin invalide refusé ; ticket d’autrui inaccessible', async () => {
      const u = await createUser();
      expect((await as(u).post('/support/tickets').send({ message: 'sans sujet' })).status).toBe(
        400,
      );
      expect(
        (await as(u).post('/support/tickets').send({ subject: 's', message: 'm', category: 'vip' }))
          .status,
      ).toBe(400);
      const t = await SupportTicket.create({
        userId: (await createUser())._id,
        subject: 's',
        message: 'm',
      });
      expect(
        (await as(u).post(`/support/tickets/${t._id}/reply`).send({ message: 'intrusion' })).status,
      ).toBe(404);
      const res = await as(await createAdmin())
        .patch(`/admin/support/tickets/${t._id}/status`)
        .send({ status: 'hacked' });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect((await SupportTicket.findById(t._id))!.status).toBe('open');
    });
  });

  describe('Exports et abonnements suivis', () => {
    it('CSV revendeur : guillemets échappés, formules neutralisées', async () => {
      const reseller = await createUser({ plan: 'business' });
      await SlotPaymentHistory.collection.insertOne({
        resellerId: reseller._id,
        amount: 2500,
        currency: 'XAF',
        paidAt: new Date(),
        periodCoveredStart: new Date(),
        periodCoveredEnd: new Date(),
        paymentMethod: 'momo',
        notes: '=HYPERLINK("http://evil","clic") et "guillemets"',
      });
      const csv = await ResellerAnalyticsService.exportAccountingCsv(String(reseller._id));
      expect(csv).not.toMatch(/(^|,)"?=HYPERLINK/m);
      expect(csv).toContain('""guillemets""');
    });

    it('export CSV des transactions : formules neutralisées', async () => {
      const u = await createUser();
      await as(u).post('/transactions').send({
        type: 'expense',
        amount: 100,
        category: 'Autres',
        description: '=cmd|"/c calc"!A1',
        date: new Date().toISOString(),
      });
      const res = await as(u).get('/reports/export/csv');
      expect(res.status).toBe(200);
      expect(res.text).not.toMatch(/(^|,)"?=cmd/m);
    });

    it('renouvellement des abonnements suivis : jamais avancé de deux périodes, même en parallèle', async () => {
      const u = await createUser();
      const past = new Date(Date.now() - 86400000);
      const sub = await Subscription.create({
        userId: u._id,
        name: 'Netflix',
        amount: 5000,
        currency: 'XAF',
        frequency: 'monthly',
        category: 'Divertissement',
        nextBillingDate: past,
        status: 'active',
      });
      await Promise.all([
        SubscriptionService.processAutoRenewals(),
        SubscriptionService.processAutoRenewals(),
      ]);
      const next = (await Subscription.findById(sub._id))!.nextBillingDate;
      const days = (next.getTime() - past.getTime()) / 86400000;
      expect(days).toBeGreaterThan(27);
      expect(days).toBeLessThan(32);
    });
  });
});
