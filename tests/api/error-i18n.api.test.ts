/**
 * Messages d'erreur dans la langue de l'utilisateur (constat des E2E mobiles :
 * l'app en français affichait « Incorrect email or password »).
 */
import { useTestDB, resetRedis } from '../helpers/db';
import { anon, as } from '../helpers/http';
import { createUser } from '../helpers/factories';
import { localizeMessage } from '../../src/utils/errorI18n';

jest.setTimeout(60000);

describe('Erreurs localisées', () => {
  useTestDB();

  it('connexion refusée : français par défaut, anglais si Accept-Language: en', async () => {
    const u = await createUser();
    const fr = await anon()
      .post('/auth/login')
      .send({ email: u.email, password: 'Faux-Passw0rd!' });
    expect(fr.status).toBe(401);
    expect(fr.body.message).toBe('E-mail ou mot de passe incorrect.');
    const en = await anon()
      .post('/auth/login')
      .set('Accept-Language', 'en-US,en;q=0.9')
      .send({ email: u.email, password: 'Faux-Passw0rd!' });
    expect(en.body.message).toMatch(/^Incorrect email or password/);
  });

  it("la langue demandée par l'app (en-tête) prime ; sans en-tête, celle du profil", async () => {
    const u = await createUser({ language: 'fr' } as any);
    // App affichée en anglais, profil encore en français (pas resynchronisé).
    const en = await as(u).get('/forecast/balance').set('Accept-Language', 'en');
    expect(en.status).toBe(403);
    expect(en.body.message).not.toMatch(/Fonctionnalité/);
    expect(en.body.message).toMatch(/premium/i);
    // Sans en-tête : langue du profil.
    const u2 = await createUser({ language: 'en' } as any);
    const viaProfile = await as(u2).get('/forecast/balance');
    expect(viaProfile.body.message).not.toMatch(/Fonctionnalité/);
  });

  it('messages déjà en français → anglais pour un anglophone ; validation Joi traduite', () => {
    expect(localizeMessage('Solde insuffisant dans le portefeuille', 'en')).toBe(
      'Insufficient wallet balance.',
    );
    expect(localizeMessage('"type" must be one of [income, expense]', 'fr')).toBe(
      'Valeur invalide pour « type ».',
    );
    expect(localizeMessage('"amount" is required, "type" is required', 'fr')).toBe(
      'Le champ « amount » est requis. Le champ « type » est requis.',
    );
    expect(localizeMessage('Message totalement inconnu', 'fr')).toBe('Message totalement inconnu');
  });

  it('/config/features reflète le réglage système real_money_mode (pas seulement le drapeau)', async () => {
    const SystemSetting = (await import('../../src/models/SystemSetting')).default;
    const FeatureFlag = (await import('../../src/models/FeatureFlag')).default;
    await FeatureFlag.updateOne(
      { slug: 'feat_real_money' },
      { $set: { isEnabled: false, name: 'Argent réel' } },
      { upsert: true },
    );
    let res = await anon().get('/config/features');
    expect(res.body.data.feat_real_money.isEnabled).toBe(false);

    await SystemSetting.create({ key: 'real_money_mode', value: true });
    await resetRedis(); // vide le cache des drapeaux publics
    res = await anon().get('/config/features');
    expect(res.body.data.feat_real_money.isEnabled).toBe(true);
  });

  it('contenus traduits : défis (titleEn) et libellés de catégories selon la langue de l\x27app', async () => {
    const Challenge = (await import('../../src/models/Challenge')).default;
    await Challenge.create({
      title: 'Épargne de Secours',
      description: 'Épargnez 50 000 XAF',
      titleEn: 'Emergency Savings',
      descriptionEn: 'Save 50,000 XAF',
      durationDays: 28,
      type: 'saving',
      difficulty: 'easy',
    });
    const u = await createUser();
    const en = await as(u).get('/challenges').set('Accept-Language', 'en');
    expect(en.status).toBe(200);
    expect(en.body.data[0].title).toBe('Emergency Savings');
    const fr = await as(u).get('/challenges');
    expect(fr.body.data[0].title).toBe('Épargne de Secours');
    const { friendlyCategoryLabel } = await import('../../src/services/reportService');
    expect(friendlyCategoryLabel('withdrawal', 'en')).toBe('Withdrawals');
    expect(friendlyCategoryLabel('withdrawal', 'fr')).toBe('Retraits');
  });
});
