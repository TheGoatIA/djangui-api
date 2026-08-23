import PlanConfig from '../models/PlanConfig';
import logger from '../utils/logger';

export const SEED_PLANS = [
  {
    slug: 'free',
    name: {
      fr: 'Gratuit',
      en: 'Free',
    },
    badge: {
      fr: 'DÉCOUVERTE',
      en: 'STARTER',
    },
    description: {
      fr: 'Pour démarrer la gestion de son budget et tester le partage de comptes.',
      en: 'To start budgeting and test account sharing.',
    },
    pricing: {
      monthly: { XAF: 0, EUR: 0, USD: 0 },
      yearly: { XAF: 0, EUR: 0, USD: 0 },
    },
    highlight: false,
    order: 1,
    featureSummary: {
      fr: [
        'Jusqu’à 3 budgets actifs',
        '1 objectif d’épargne actif',
        '1 tontine active (participation)',
        'Découverte Revendeur : 2 services & 3 slots clients',
        'Frais de retrait standards (3%)',
      ],
      en: [
        'Up to 3 active budgets',
        '1 active saving goal',
        '1 active tontine (member)',
        'Reseller Starter: 2 services & 3 client slots',
        'Standard withdrawal fees (3%)',
      ],
    },
    categories: [
      {
        category: {
          fr: 'Gestion Budgétaire & Dépenses',
          en: 'Budgeting & Expense Tracking',
        },
        items: [
          { id: 'budgets', name: { fr: 'Nombre de budgets actifs', en: 'Active budgets limit' }, included: true, value: { fr: '3 budgets', en: '3 budgets' } },
          { id: 'goals', name: { fr: 'Objectifs d’épargne', en: 'Saving goals' }, included: true, value: { fr: '1 objectif', en: '1 goal' } },
          { id: 'transactions', name: { fr: 'Suivi et saisie des dépenses', en: 'Expense tracking' }, included: true, value: { fr: 'Illimité', en: 'Unlimited' } },
          { id: 'ocr', name: { fr: 'Scan de reçus / OCR basique', en: 'Receipt scan / Basic OCR' }, included: true, value: { fr: '5 scans/mois', en: '5 scans/mo' } },
          { id: 'import_sms', name: { fr: 'Import automatique SMS (MoMo/OM)', en: 'Automatic SMS Import (MoMo/OM)' }, included: true },
        ],
      },
      {
        category: {
          fr: 'Intelligence Artificielle & Coach Anne',
          en: 'Artificial Intelligence & AI Coach Anne',
        },
        items: [
          { id: 'coach_chat', name: { fr: 'Coach Financier IA Anne', en: 'AI Financial Coach Anne' }, included: true, value: { fr: '20 msgs d’historique', en: '20 messages history' } },
          { id: 'ai_insights', name: { fr: 'Analyses de dépenses intelligentes', en: 'Smart spending insights' }, included: true, value: { fr: 'Standards', en: 'Standard' } },
          { id: 'auto_budget', name: { fr: 'Génération automatique de budget IA', en: 'AI Auto-Budget generation' }, included: false },
          { id: 'style_magazine', name: { fr: 'Rapport mensuel "Style Magazine"', en: 'Monthly "Style Magazine" report' }, included: false },
          { id: 'voice_input', name: { fr: 'Commandes et saisie vocale IA', en: 'AI Voice commands & input' }, included: false },
        ],
      },
      {
        category: {
          fr: 'Tontines & Épargne Communautaire',
          en: 'Tontines & Community Savings',
        },
        items: [
          { id: 'tontine_join', name: { fr: 'Participation aux tontines', en: 'Join tontine groups' }, included: true, value: { fr: '1 tontine active', en: '1 active tontine' } },
          { id: 'tontine_create', name: { fr: 'Création et gestion de tontines', en: 'Create & manage tontines' }, included: false },
          { id: 'tontine_auto_debit', name: { fr: 'Prélèvement automatique des cotisations', en: 'Automatic contribution debits' }, included: false },
          { id: 'tontine_trust', name: { fr: 'Trust Score & Badge de fiabilité', en: 'Trust Score & Trust badge' }, included: true },
        ],
      },
      {
        category: {
          fr: 'Portefeuille Kauri & Retraits',
          en: 'Kauri Wallet & Cashout',
        },
        items: [
          { id: 'wallet', name: { fr: 'Solde Portefeuille MoMo/OM', en: 'MoMo/OM Wallet balance' }, included: true },
          { id: 'withdrawal_fee', name: { fr: 'Frais de retrait portefeuille', en: 'Wallet cashout fees' }, included: true, value: { fr: '3% (standard)', en: '3% (standard)' } },
          { id: 'payment_methods', name: { fr: 'Moyens de recharge (MTN, Orange, Carte)', en: 'Top-up methods (MTN, Orange, Card)' }, included: true },
        ],
      },
      {
        category: {
          fr: 'Reseller Hub (Revente d’Abonnements)',
          en: 'Reseller Hub (Shared Subscriptions)',
        },
        items: [
          { id: 'master_accounts', name: { fr: 'Services & Comptes Maîtres', en: 'Master Accounts & Services' }, included: true, value: { fr: '2 comptes max', en: '2 accounts max' } },
          { id: 'client_slots', name: { fr: 'Profils / Slots clients gérés', en: 'Managed client slots' }, included: true, value: { fr: '3 slots max', en: '3 slots max' } },
          { id: 'vault_crypto', name: { fr: 'Coffre-fort chiffré AES-256', en: 'AES-256 Encrypted Vault' }, included: true },
          { id: 'auto_reminders', name: { fr: 'Relances automatiques programmées (J-3/J-0)', en: 'Scheduled Auto-Reminders (D-3/D-0)' }, included: false },
          { id: 'accounting_export', name: { fr: 'Exports comptables & fiscaux CSV', en: 'CSV Accounting & Tax Export' }, included: false },
        ],
      },
      {
        category: {
          fr: 'Personnalisation & Confort',
          en: 'Customization & Comfort',
        },
        items: [
          { id: 'dark_mode', name: { fr: 'Mode Sombre & Thème Kauri', en: 'Dark Mode & Kauri Theme' }, included: true },
          { id: 'premium_themes', name: { fr: 'Thèmes exclusifs (Obsidian Gold, Polar Night...)', en: 'Exclusive themes (Obsidian Gold...)' }, included: false },
          { id: 'custom_fonts', name: { fr: 'Typographies personnalisées', en: 'Custom fonts' }, included: false },
          { id: 'support_priority', name: { fr: 'Support client prioritaire', en: 'Priority Customer Support' }, included: false },
        ],
      },
    ],
    limits: {
      maxBudgets: 3,
      maxGoals: 1,
      maxActiveTontines: 1,
      maxMasterAccounts: 2,
      maxClientSlots: 3,
      withdrawalFeePercentage: 3.0,
      aiCoachHistoryLimit: 20,
    },
    isActive: true,
  },
  {
    slug: 'premium',
    name: {
      fr: 'Premium',
      en: 'Premium',
    },
    badge: {
      fr: 'POPULAIRE',
      en: 'MOST POPULAR',
    },
    description: {
      fr: 'Pour maîtriser ses finances, automatiser son épargne et profiter de l’IA complète.',
      en: 'To master your finances, automate savings, and enjoy full AI capabilities.',
    },
    pricing: {
      monthly: { XAF: 2000, EUR: 5, USD: 8 },
      yearly: { XAF: 19200, EUR: 48, USD: 75 }, // ~20% discount
    },
    highlight: true,
    order: 2,
    featureSummary: {
      fr: [
        '5 Budgets & 5 Objectifs d\'épargne simultanés',
        'Coach IA Anne Avancé & Auto-Budgeting',
        'Jusqu\'à 2 tontines créées (Participation libre)',
        'Frais de retrait réduits de 50% (1.5%)',
        'Revendeur Hub : Jusqu\'à 3 comptes maîtres & 10 profils clients',
        'Thèmes de luxe exclusifs (Obsidian Gold...)',
      ],
      en: [
        '5 Active Budgets & 5 Simultaneous Goals',
        'Advanced AI Coach Anne & Auto-Budgeting',
        'Up to 2 created tontines (Unlimited joining)',
        '50% reduced cashout fees (1.5%)',
        'Reseller Hub: Up to 3 master accounts & 10 client slots',
        'Exclusive luxury themes (Obsidian Gold...)',
      ],
    },
    categories: [
      {
        category: {
          fr: 'Gestion Budgétaire & Dépenses',
          en: 'Budgeting & Expense Tracking',
        },
        items: [
          { id: 'budgets', name: { fr: 'Nombre de budgets actifs', en: 'Active budgets limit' }, included: true, highlight: true, value: { fr: '5 Budgets actifs', en: '5 Active budgets' } },
          { id: 'goals', name: { fr: 'Objectifs d’épargne & Dettes', en: 'Saving & Debt goals' }, included: true, highlight: true, value: { fr: '5 Objectifs simultanés', en: '5 Simultaneous goals' } },
          { id: 'transactions', name: { fr: 'Suivi et saisie des dépenses', en: 'Expense tracking' }, included: true, value: { fr: 'Illimité', en: 'Unlimited' } },
          { id: 'ocr', name: { fr: 'Scan de reçus / OCR intelligent', en: 'Smart Receipt Scan / OCR' }, included: true, value: { fr: '15 scans / mois', en: '15 scans / month' } },
          { id: 'import_sms', name: { fr: 'Import automatique SMS (MoMo/OM)', en: 'Automatic SMS Import (MoMo/OM)' }, included: true },
        ],
      },
      {
        category: {
          fr: 'Intelligence Artificielle & Coach Anne',
          en: 'Artificial Intelligence & AI Coach Anne',
        },
        items: [
          { id: 'coach_chat', name: { fr: 'Coach Financier IA Anne', en: 'AI Financial Coach Anne' }, included: true, highlight: true, value: { fr: '50 requêtes & 30j d’historique', en: '50 requests & 30d history' } },
          { id: 'ai_insights', name: { fr: 'Analyses de dépenses intelligentes', en: 'Smart spending insights' }, included: true, value: { fr: 'Avancées & Prédictives', en: 'Advanced & Predictive' } },
          { id: 'auto_budget', name: { fr: 'Génération automatique de budget IA', en: 'AI Auto-Budget generation' }, included: true, highlight: true },
          { id: 'style_magazine', name: { fr: 'Rapport mensuel "Style Magazine"', en: 'Monthly "Style Magazine" report' }, included: true },
          { id: 'voice_input', name: { fr: 'Commandes et saisie vocale IA', en: 'AI Voice commands & input' }, included: true },
        ],
      },
      {
        category: {
          fr: 'Tontines & Épargne Communautaire',
          en: 'Tontines & Community Savings',
        },
        items: [
          { id: 'tontine_join', name: { fr: 'Participation aux tontines', en: 'Join tontine groups' }, included: true, value: { fr: 'Illimité', en: 'Unlimited' } },
          { id: 'tontine_create', name: { fr: 'Création et gestion de tontines', en: 'Create & manage tontines' }, included: true, highlight: true },
          { id: 'tontine_auto_debit', name: { fr: 'Prélèvement automatique des cotisations', en: 'Automatic contribution debits' }, included: true },
          { id: 'tontine_trust', name: { fr: 'Trust Score & Badge de fiabilité', en: 'Trust Score & Trust badge' }, included: true },
        ],
      },
      {
        category: {
          fr: 'Portefeuille Kauri & Retraits',
          en: 'Kauri Wallet & Cashout',
        },
        items: [
          { id: 'wallet', name: { fr: 'Solde Portefeuille MoMo/OM', en: 'MoMo/OM Wallet balance' }, included: true },
          { id: 'withdrawal_fee', name: { fr: 'Frais de retrait portefeuille', en: 'Wallet cashout fees' }, included: true, highlight: true, value: { fr: '1.5% (-50% réduction)', en: '1.5% (-50% discount)' } },
          { id: 'payment_methods', name: { fr: 'Moyens de recharge (MTN, Orange, Carte)', en: 'Top-up methods (MTN, Orange, Card)' }, included: true },
        ],
      },
      {
        category: {
          fr: 'Reseller Hub (Revente d’Abonnements)',
          en: 'Reseller Hub (Shared Subscriptions)',
        },
        items: [
          { id: 'master_accounts', name: { fr: 'Services & Comptes Maîtres', en: 'Master Accounts & Services' }, included: true, highlight: true, value: { fr: '3 comptes maîtres max', en: '3 master accounts max' } },
          { id: 'client_slots', name: { fr: 'Profils / Slots clients gérés', en: 'Managed client slots' }, included: true, value: { fr: '10 profils clients max', en: '10 profils clients max' } },
          { id: 'vault_crypto', name: { fr: 'Coffre-fort chiffré AES-256', en: 'AES-256 Encrypted Vault' }, included: true },
          { id: 'auto_reminders', name: { fr: 'Relances automatiques programmées (J-3/J-0)', en: 'Scheduled Auto-Reminders (D-3/D-0)' }, included: true, highlight: true },
          { id: 'accounting_export', name: { fr: 'Exports comptables & fiscaux CSV', en: 'CSV Accounting & Tax Export' }, included: false },
        ],
      },
      {
        category: {
          fr: 'Personnalisation & Confort',
          en: 'Customization & Comfort',
        },
        items: [
          { id: 'dark_mode', name: { fr: 'Mode Sombre & Thème Kauri', en: 'Dark Mode & Kauri Theme' }, included: true },
          { id: 'premium_themes', name: { fr: 'Thèmes exclusifs (Obsidian Gold, Polar Night...)', en: 'Exclusive themes (Obsidian Gold...)' }, included: true, highlight: true },
          { id: 'custom_fonts', name: { fr: 'Typographies personnalisées (Outfit, Inter...)', en: 'Custom typography' }, included: true },
          { id: 'support_priority', name: { fr: 'Support client prioritaire WhatsApp/Email', en: 'Priority WhatsApp/Email Support' }, included: true },
        ],
      },
    ],
    limits: {
      maxBudgets: 5,
      maxGoals: 5,
      maxActiveTontines: 2,
      maxMasterAccounts: 3,
      maxClientSlots: 10,
      withdrawalFeePercentage: 1.5,
      aiCoachHistoryLimit: 50,
    },
    isActive: true,
  },
  {
    slug: 'business',
    name: {
      fr: 'Business (Reseller Hub Pro)',
      en: 'Business (Reseller Hub Pro)',
    },
    badge: {
      fr: 'ENTREPRENEUR',
      en: 'PRO RESELLER',
    },
    description: {
      fr: 'La suite complète tout-en-un pour gérer son activité de revente d’abonnements sans limite.',
      en: 'The complete all-in-one suite to run an unlimited shared subscription business.',
    },
    pricing: {
      monthly: { XAF: 5000, EUR: 10, USD: 15 },
      yearly: { XAF: 48000, EUR: 96, USD: 144 }, // ~20% discount
    },
    highlight: false,
    order: 3,
    featureSummary: {
      fr: [
        'TOUT ce qui est inclus dans le plan Premium',
        'Services & Comptes Maîtres Illimités',
        'Slots & Profils Clients Illimités (Aucun plafond)',
        'Relances Automatisées Multi-canaux (WhatsApp / SMS / Push)',
        'Exports Comptables & Fiscaux (CSV / Excel)',
        'Tableau de Bord & Analyses Financières en Temps Réel (MRR)',
        'Support VIP dédié 24/7',
      ],
      en: [
        'EVERYTHING included in the Premium plan',
        'Unlimited Master Accounts & Services',
        'Unlimited Client Slots & Profiles (No limits)',
        'Multi-channel Auto Reminders (WhatsApp / SMS / Push)',
        'CSV / Excel Accounting & Tax Exports',
        'Live Real-time Financial Dashboard (MRR & Margins)',
        'Dedicated VIP 24/7 Support',
      ],
    },
    categories: [
      {
        category: {
          fr: 'Gestion Budgétaire & Dépenses',
          en: 'Budgeting & Expense Tracking',
        },
        items: [
          { id: 'budgets', name: { fr: 'Nombre de budgets actifs', en: 'Active budgets limit' }, included: true, highlight: true, value: { fr: 'Illimité', en: 'Unlimited' } },
          { id: 'goals', name: { fr: 'Objectifs d’épargne & Dettes', en: 'Saving & Debt goals' }, included: true, highlight: true, value: { fr: 'Illimité', en: 'Unlimited' } },
          { id: 'transactions', name: { fr: 'Suivi et saisie des dépenses', en: 'Expense tracking' }, included: true, value: { fr: 'Illimité', en: 'Unlimited' } },
          { id: 'ocr', name: { fr: 'Scan de reçus / OCR intelligent', en: 'Smart Receipt Scan / OCR' }, included: true, value: { fr: 'Illimité', en: 'Unlimited' } },
          { id: 'import_sms', name: { fr: 'Import automatique SMS (MoMo/OM)', en: 'Automatic SMS Import (MoMo/OM)' }, included: true },
        ],
      },
      {
        category: {
          fr: 'Intelligence Artificielle & Coach Anne',
          en: 'Artificial Intelligence & AI Coach Anne',
        },
        items: [
          { id: 'coach_chat', name: { fr: 'Coach Financier & Business IA Anne', en: 'AI Financial & Business Coach' }, included: true, highlight: true, value: { fr: 'Historique Illimité', en: 'Unlimited History' } },
          { id: 'ai_insights', name: { fr: 'Analyses de rentabilité & dépenses', en: 'Profitability & Spending Analytics' }, included: true, highlight: true, value: { fr: 'Optimisation de Marge', en: 'Margin Optimization' } },
          { id: 'auto_budget', name: { fr: 'Génération automatique de budget IA', en: 'AI Auto-Budget generation' }, included: true },
          { id: 'style_magazine', name: { fr: 'Rapport mensuel "Style Magazine"', en: 'Monthly "Style Magazine" report' }, included: true },
          { id: 'voice_input', name: { fr: 'Commandes et saisie vocale IA', en: 'AI Voice commands & input' }, included: true },
        ],
      },
      {
        category: {
          fr: 'Tontines & Épargne Communautaire',
          en: 'Tontines & Community Savings',
        },
        items: [
          { id: 'tontine_join', name: { fr: 'Participation aux tontines', en: 'Join tontine groups' }, included: true, value: { fr: 'Illimité', en: 'Unlimited' } },
          { id: 'tontine_create', name: { fr: 'Création et gestion de tontines', en: 'Create & manage tontines' }, included: true, value: { fr: '2 tontines créées max', en: '2 managed tontines max' } },
          { id: 'tontine_auto_debit', name: { fr: 'Prélèvement automatique des cotisations', en: 'Automatic contribution debits' }, included: true },
          { id: 'tontine_trust', name: { fr: 'Trust Score & Badge de fiabilité', en: 'Trust Score & Trust badge' }, included: true },
        ],
      },
      {
        category: {
          fr: 'Portefeuille Kauri & Retraits',
          en: 'Kauri Wallet & Cashout',
        },
        items: [
          { id: 'wallet', name: { fr: 'Solde Portefeuille MoMo/OM', en: 'MoMo/OM Wallet balance' }, included: true },
          { id: 'withdrawal_fee', name: { fr: 'Frais de retrait portefeuille', en: 'Wallet cashout fees' }, included: true, highlight: true, value: { fr: '1.0% (Taux VIP le plus bas)', en: '1.0% (Lowest VIP rate)' } },
          { id: 'payment_methods', name: { fr: 'Moyens de recharge (MTN, Orange, Carte)', en: 'Top-up methods (MTN, Orange, Card)' }, included: true },
        ],
      },
      {
        category: {
          fr: 'Reseller Hub (Revente d’Abonnements Pro)',
          en: 'Reseller Hub (Pro Reseller Suite)',
        },
        items: [
          { id: 'master_accounts', name: { fr: 'Services & Comptes Maîtres', en: 'Master Accounts & Services' }, included: true, highlight: true, value: { fr: 'Illimité', en: 'Unlimited' } },
          { id: 'client_slots', name: { fr: 'Profils / Slots clients gérés', en: 'Managed client slots' }, included: true, highlight: true, value: { fr: '10 profils clients max', en: '10 client slots max' } },
          { id: 'vault_crypto', name: { fr: 'Coffre-fort chiffré AES-256 militaire', en: 'Military-grade AES-256 Vault' }, included: true, highlight: true },
          { id: 'auto_reminders', name: { fr: 'Relances programmées (J-3/J-0 & Impayés)', en: 'Automated Reminders (D-3/D-0 & Overdue)' }, included: true, highlight: true },
          { id: 'accounting_export', name: { fr: 'Exports comptables & fiscaux CSV / Excel', en: 'CSV / Excel Accounting Export' }, included: true, highlight: true },
          { id: 'business_analytics', name: { fr: 'KPIs en direct : MRR, Marges Nettes, Taux d’occupation', en: 'Live KPIs: MRR, Net Margins, Occupancy' }, included: true, highlight: true },
        ],
      },
      {
        category: {
          fr: 'Personnalisation & Confort VIP',
          en: 'VIP Customization & Comfort',
        },
        items: [
          { id: 'dark_mode', name: { fr: 'Mode Sombre & Thème Kauri', en: 'Dark Mode & Kauri Theme' }, included: true },
          { id: 'premium_themes', name: { fr: 'Tous les thèmes de luxe débloqués', en: 'All luxury themes unlocked' }, included: true, highlight: true },
          { id: 'custom_fonts', name: { fr: 'Toutes les polices débloquées', en: 'All premium fonts unlocked' }, included: true },
          { id: 'support_priority', name: { fr: 'Gestionnaire de compte & Support VIP 24/7', en: 'Dedicated Account Manager & 24/7 VIP' }, included: true, highlight: true },
        ],
      },
    ],
    limits: {
      maxBudgets: null,
      maxGoals: null,
      maxActiveTontines: null,
      maxMasterAccounts: null,
      maxClientSlots: null,
      withdrawalFeePercentage: 1.0,
      aiCoachHistoryLimit: 500,
    },
    isActive: true,
  },
];

export class PlanConfigService {
  /**
   * Initialiser / Mettre à jour les plans de base dans MongoDB
   */
  static async seedPlans(): Promise<void> {
    for (const planData of SEED_PLANS) {
      await PlanConfig.findOneAndUpdate(
        { slug: planData.slug },
        { $set: planData },
        { upsert: true, new: true },
      );
    }
    logger.info('[PlanConfigService] 3 plans bilingues synchronisés avec les tarifs 0/2000/5000 XAF, 0/5/10 EUR, 0/8/15 USD.');
  }

  /**
   * Récupérer tous les forfaits actifs triés par ordre
   */
  static async getActivePlans(): Promise<any[]> {
    await this.seedPlans();
    let plans = await PlanConfig.find({ isActive: true }).sort({ order: 1 });
    if (plans.length === 0) {
      await this.seedPlans();
      plans = await PlanConfig.find({ isActive: true }).sort({ order: 1 });
    }
    return plans;
  }

  /**
   * Mettre à jour un plan depuis l'Admin
   */
  static async updatePlan(slug: string, updateData: any): Promise<any> {
    return PlanConfig.findOneAndUpdate({ slug }, { $set: updateData }, { new: true });
  }
}
