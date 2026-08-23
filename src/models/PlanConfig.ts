import mongoose, { Schema, Document } from 'mongoose';

export interface IPlanPricing {
  XAF: number;
  EUR: number;
  USD: number;
}

export interface IPlanFeatureItem {
  id: string;
  name: {
    fr: string;
    en: string;
  };
  included: boolean;
  highlight?: boolean;
  value?: {
    fr?: string;
    en?: string;
  };
}

export interface IPlanCategory {
  category: {
    fr: string;
    en: string;
  };
  items: IPlanFeatureItem[];
}

export interface IPlanConfigDocument extends Document {
  slug: 'free' | 'premium' | 'business';
  name: {
    fr: string;
    en: string;
  };
  badge?: {
    fr?: string;
    en?: string;
  };
  description: {
    fr: string;
    en: string;
  };
  pricing: {
    monthly: IPlanPricing;
    yearly: IPlanPricing;
  };
  highlight: boolean;
  order: number;
  featureSummary: {
    fr: string[];
    en: string[];
  };
  categories: IPlanCategory[];
  limits: {
    maxBudgets: number | null;
    maxGoals: number | null;
    maxActiveTontines: number | null;
    maxMasterAccounts: number | null;
    maxClientSlots: number | null;
    withdrawalFeePercentage: number;
    aiCoachHistoryLimit: number;
  };
  isActive: boolean;
}

const planConfigSchema = new Schema<IPlanConfigDocument>(
  {
    slug: {
      type: String,
      enum: ['free', 'premium', 'business'],
      required: true,
      unique: true,
    },
    name: {
      fr: { type: String, required: true },
      en: { type: String, required: true },
    },
    badge: {
      fr: String,
      en: String,
    },
    description: {
      fr: { type: String, required: true },
      en: { type: String, required: true },
    },
    pricing: {
      monthly: {
        XAF: { type: Number, required: true },
        EUR: { type: Number, required: true },
        USD: { type: Number, required: true },
      },
      yearly: {
        XAF: { type: Number, required: true },
        EUR: { type: Number, required: true },
        USD: { type: Number, required: true },
      },
    },
    highlight: {
      type: Boolean,
      default: false,
    },
    order: {
      type: Number,
      default: 0,
    },
    featureSummary: {
      fr: [String],
      en: [String],
    },
    categories: [
      {
        category: {
          fr: String,
          en: String,
        },
        items: [
          {
            id: String,
            name: {
              fr: String,
              en: String,
            },
            included: Boolean,
            highlight: Boolean,
            value: {
              fr: String,
              en: String,
            },
          },
        ],
      },
    ],
    limits: {
      maxBudgets: { type: Number, default: null },
      maxGoals: { type: Number, default: null },
      maxActiveTontines: { type: Number, default: null },
      maxMasterAccounts: { type: Number, default: null },
      maxClientSlots: { type: Number, default: null },
      withdrawalFeePercentage: { type: Number, default: 3.0 },
      aiCoachHistoryLimit: { type: Number, default: 20 },
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  },
);

const PlanConfig = mongoose.model<IPlanConfigDocument>('PlanConfig', planConfigSchema);

export default PlanConfig;
