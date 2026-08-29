import FeatureFlag from '../models/FeatureFlag';
import logger from '../utils/logger';
import { RedisService } from './redisService';

const FEATURES_CACHE_KEY = 'config:features';
const REAL_MONEY_SETTING_KEY = 'real_money_mode';
const REAL_MONEY_FLAG_SLUG = 'feat_real_money';
const REAL_MONEY_COUNTRIES_KEY = 'real_money_countries';
// Launch scope: real money starts in Cameroon only. Every other country stays
// in virtual/simulation mode for real-money operations until explicitly added
// here (via an admin editing this SystemSetting — see getRealMoneyCountries),
// regardless of the global feat_real_money toggle.
const DEFAULT_REAL_MONEY_COUNTRIES = ['CM'];

export class FeatureFlagService {
  private static readonly flags = [
    {
      name: 'Connexion Google',
      slug: 'auth_google',
      isEnabled: true,
      description: 'Authentification via Google',
    },
    {
      name: 'Connexion Apple',
      slug: 'auth_apple',
      isEnabled: true,
      description: 'Authentification via Apple',
    },
    {
      name: 'Connexion Téléphone (OTP)',
      slug: 'auth_phone',
      isEnabled: true,
      description: 'Authentification via SMS OTP',
    },
    {
      name: 'Biométrie',
      slug: 'auth_biometric',
      isEnabled: true,
      description: 'Authentification biométrique',
    },
    {
      name: 'Chat avec Anne',
      slug: 'ai_coach_chat',
      isEnabled: true,
      description: 'Chat IA avec Anne',
    },
    {
      name: 'Génération de budget IA',
      slug: 'ai_budget_generation',
      isEnabled: true,
      description: "Génération automatique de budget par l'IA",
    },
    {
      name: 'Insights Financiers',
      slug: 'ai_insights',
      isEnabled: true,
      description: "Analyses financières par l'IA",
    },
    {
      name: 'Commandes Vocales',
      slug: 'ai_voice_commands',
      isEnabled: true,
      description: "Commandes vocales via l'IA",
    },
    { name: 'Budgets', slug: 'feat_budgets', isEnabled: true, description: 'Gestion des budgets' },
    {
      name: 'Objectifs (Goals)',
      slug: 'feat_goals',
      isEnabled: true,
      description: "Suivi des objectifs d'épargne",
    },
    {
      name: 'Investissements',
      slug: 'feat_investments',
      isEnabled: true,
      description: 'Suivi des investissements',
    },
    {
      name: 'Rapports & Exports',
      slug: 'feat_reports',
      isEnabled: true,
      description: 'Génération de rapports et exports PDF/CSV',
    },
    {
      name: 'Scan de Reçus',
      slug: 'feat_scan_upload',
      isEnabled: true,
      description: 'Scan de reçus via OCR',
    },
    {
      name: 'Saisie Transactions',
      slug: 'feat_manual_transactions',
      isEnabled: true,
      description: 'Saisie manuelle des transactions',
    },
    {
      name: 'Tontines',
      slug: 'feat_tontines',
      isEnabled: true,
      description: 'Gestion des tontines',
    },
    {
      name: 'Gamification (Points/XP)',
      slug: 'feat_gamification',
      isEnabled: true,
      description: 'Système de points et XP',
    },
    {
      name: 'Défis (Challenges)',
      slug: 'feat_challenges',
      isEnabled: true,
      description: 'Défis financiers',
    },
    {
      name: 'Notifications Push',
      slug: 'feat_notifications',
      isEnabled: true,
      description: 'Envoi de notifications push',
    },
    {
      name: 'Abonnements/Paywall',
      slug: 'feat_subscriptions',
      isEnabled: true,
      description: 'Gestion des abonnements premium',
    },
    {
      name: 'Argent Réel & Retraits Mobile Money',
      slug: 'feat_real_money',
      isEnabled: false,
      description:
        'Active les paiements réels Stripe/NotchPay et retraits Mobile Money (sinon mode virtuel simulation)',
    },
  ];

  static async seed() {
    try {
      for (const flag of this.flags) {
        await FeatureFlag.findOneAndUpdate({ slug: flag.slug }, flag, {
          upsert: true,
          new: true,
          setDefaultsOnInsert: true,
        });
      }
      logger.info('Feature Flags seeded successfully');
    } catch (error) {
      logger.error('Error seeding Feature Flags:', error);
    }
  }

  static async getFlags() {
    return FeatureFlag.find().sort({ name: 1 });
  }

  static async isEnabled(slug: string): Promise<boolean> {
    const flag = await FeatureFlag.findOne({ slug });
    return flag ? flag.isEnabled : false;
  }

  static async isRealMoneyEnabled(): Promise<boolean> {
    const SystemSetting = (await import('../models/SystemSetting')).default;
    const setting = await SystemSetting.findOne({ key: REAL_MONEY_SETTING_KEY });
    if (setting && setting.value !== undefined) {
      return Boolean(setting.value);
    }
    const flag = await FeatureFlag.findOne({ slug: REAL_MONEY_FLAG_SLUG });
    if (flag && flag.isEnabled !== undefined) {
      return Boolean(flag.isEnabled);
    }
    return false;
  }

  /**
   * Countries where real-money operations (deposit/subscription/withdrawal)
   * are actually allowed, even when the global real-money mode is on.
   * Defaults to Cameroon-only — the deliberate launch scope. Admin-editable
   * via the generic `PATCH /admin/settings` with key `real_money_countries`
   * and an array value (e.g. `["CM", "SN"]`) once expansion to another
   * country is actually ready (licensing, a working payment provider there,
   * etc.) — never a code change.
   */
  static async getRealMoneyCountries(): Promise<string[]> {
    const SystemSetting = (await import('../models/SystemSetting')).default;
    const setting = await SystemSetting.findOne({ key: REAL_MONEY_COUNTRIES_KEY });
    if (setting && Array.isArray(setting.value) && setting.value.length > 0) {
      return setting.value.map((c: string) => String(c).toUpperCase());
    }
    return DEFAULT_REAL_MONEY_COUNTRIES;
  }

  /**
   * Whether a given user's country is currently allowed to move real money.
   * Callers must ALSO check isRealMoneyEnabled() separately — this only
   * narrows further, it doesn't replace the global on/off switch.
   */
  static async isCountryAllowedForRealMoney(countryCode?: string | null): Promise<boolean> {
    if (!countryCode) return false;
    const allowed = await this.getRealMoneyCountries();
    return allowed.includes(countryCode.toUpperCase());
  }

  /**
   * Single, authoritative way to switch the whole platform between real-money
   * mode (Stripe/NotchPay deposits + Mobile Money withdrawals actually move
   * money) and virtual/simulation mode (deposits and withdrawals are blocked;
   * everything else — tontines, goals, challenges, budgets, investments —
   * keeps working on whatever wallet balance already exists, for demoing/
   * testing the app without real funds).
   *
   * Writes both the SystemSetting (authoritative for `isRealMoneyEnabled`)
   * and the FeatureFlag document (so the public `GET /config/features` the
   * mobile app reads reflects the change immediately without needing to know
   * which internal mechanism was used), invalidates the features cache, and
   * broadcasts a notification to every user — this is a decision the business
   * owner deliberately wants to control and have users informed about, not
   * something that should ever flip silently.
   */
  static async setRealMoneyMode(enabled: boolean, adminUserId?: string): Promise<boolean> {
    const SystemSetting = (await import('../models/SystemSetting')).default;
    const { AuditService } = await import('./auditService');
    const { NotificationService } = await import('./notificationService');

    const previous = await this.isRealMoneyEnabled();

    await SystemSetting.findOneAndUpdate(
      { key: REAL_MONEY_SETTING_KEY },
      {
        value: enabled,
        group: 'payment',
        description: 'Active les paiements réels (Stripe/NotchPay) et les retraits Mobile Money',
        isPublic: false,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    await FeatureFlag.findOneAndUpdate(
      { slug: REAL_MONEY_FLAG_SLUG },
      { isEnabled: enabled },
      { upsert: false },
    );

    await RedisService.del(FEATURES_CACHE_KEY);

    if (previous !== enabled) {
      logger.warn(
        `[REAL MONEY MODE] Basculé à ${enabled ? 'RÉEL' : 'VIRTUEL/SIMULATION'} par l'admin ${adminUserId || 'system'}`,
      );

      AuditService.record({
        userId: adminUserId as any,
        action: 'REAL_MONEY_MODE_CHANGE',
        resource: 'SystemSetting',
        resourceId: REAL_MONEY_SETTING_KEY,
        oldValue: { value: previous },
        newValue: { value: enabled },
        status: 'success',
      });

      const title = enabled ? 'Paiements Réels Activés 🚀' : 'Mode Portefeuille Virtuel 💡';
      const body = enabled
        ? 'Les transactions en argent réel et les retraits Mobile Money sont désormais actifs sur Kauri.'
        : 'Kauri fonctionne en mode Portefeuille Virtuel. Vous pouvez tester toutes les fonctionnalités sans argent réel.';

      NotificationService.sendToTopic('all_users', {
        title,
        body,
        category: 'informational',
        data: { type: 'real_money_mode_changed', isEnabled: String(enabled) },
      }).catch((err: any) =>
        logger.error(`Broadcast real-money-mode change error: ${err.message}`),
      );
    }

    return enabled;
  }
}
