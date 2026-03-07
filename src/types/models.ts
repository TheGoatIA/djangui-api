import mongoose from 'mongoose';

export interface IUser {
  email: string;
  role: 'user' | 'admin';
  password?: string;
  firstName: string;
  lastName: string;
  phone?: string;
  avatar?: string;
  monthlyIncome: number;
  currency: string;
  country: string;
  language: string;
  firebaseUid?: string;
  preferences: {
    coachTone:
      | 'encouraging'
      | 'firm'
      | 'balanced'
      | 'billionaire_mentor'
      | 'strict_accountant'
      | 'kind_auntie';
    notificationFrequency: 'high' | 'medium' | 'low';
    budgetAlertThreshold: number;
  };
  subscription: {
    plan: 'free' | 'premium';
    status: 'active' | 'cancelled' | 'expired';
    startDate?: Date;
    endDate?: Date;
    autoRenew: boolean;
  };
  isEmailVerified: boolean;
  isPhoneVerified: boolean;
  isActive: boolean;
  emailVerificationToken?: string;
  emailVerificationExpires?: Date;
  passwordResetToken?: string;
  passwordResetExpires?: Date;
  isPremium: boolean;
  walletBalance: number;
  kycLevel: 'none' | 'pending' | 'verified';
  kycData?: {
    documentType: 'cni' | 'passport' | 'driver_license';
    documentNumber?: string;
    fullName?: string;
    documentImageUrl?: string;
    selfieImageUrl?: string;
    verifiedAt?: Date;
    rejectionReason?: string;
    aiReport?: string;
    aiConfidence?: number;
    aiAnalysisStatus?: 'pending' | 'completed' | 'failed';
  };
  xp: number;
  level: number;
  badges: {
    name: string;
    icon: string;
    awardedAt: Date;
  }[];
  fcmTokens: string[];
  sessions: {
    deviceId?: string;
    deviceInfo?: {
      model?: string;
      os?: string;
      osVersion?: string;
      platform: 'android' | 'ios' | 'web';
    };
    appVersion?: string;
    refreshToken?: string;
    lastActive: Date;
    createdAt: Date;
    ipAddress?: string;
  }[];
  deviceInfo?: {
    model?: string;
    os?: string;
    osVersion?: string;
    platform: 'android' | 'ios' | 'web';
  };
  appVersion?: string;
  lastLogin?: Date;
  refreshToken?: string;
  aiAttackCount: number;
  status: 'active' | 'suspended' | 'blocked';
  createdAt: Date;
  updatedAt: Date;
}

export interface IChallenge {
  title: string;
  description: string;
  type: 'saving' | 'spending_cut' | 'habit';
  difficulty: 'easy' | 'medium' | 'hard';
  targetAmount?: number;
  durationDays: number;
  category?: string;
  icon?: string;
  rewardPoints: number;
  isCustom: boolean;
  createdBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export interface IUserChallenge {
  userId: mongoose.Types.ObjectId;
  challengeId: mongoose.Types.ObjectId;
  status: 'active' | 'completed' | 'failed' | 'abandoned';
  progress: number;
  currentValue: number;
  startDate: Date;
  endDate: Date;
  completedAt?: Date;
  stakeAmount: number; // Montant misé par l'utilisateur
  potentialReward: number; // Montant total à gagner si succès
  transactionId?: mongoose.Types.ObjectId; // Référence à la transaction de mise
  weeks: {
    weekNumber: number;
    targetAmount: number;
    savedAmount: number;
    status: 'pending' | 'completed' | 'late' | 'skipped' | 'postponed' | 'rejected';
    validatedAt?: Date;
    proofImageUrl?: string;
    transactionId?: string;
    transactionDate?: Date;
    verificationStatus?: 'pending' | 'verified' | 'rejected';
    verificationNote?: string;
  }[];
  flexibility: {
    skipsUsed: number;
    skipsMax: number;
    postponementsUsed: number;
    postponementsMax: number;
  };
  createdAt: Date;
  updatedAt: Date;
}

export interface IPayment {
  userId: mongoose.Types.ObjectId;
  amount: number;
  currency: string;
  method: 'stripe' | 'notchpay' | 'wallet';
  type: 'deposit' | 'subscription' | 'withdrawal';
  status: 'pending' | 'completed' | 'failed' | 'refunded';
  reference: string; // Internal reference
  externalReference?: string; // Stripe/NotchPay reference
  metadata?: any;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface IInvestment {
  userId: mongoose.Types.ObjectId;
  title: string;
  type: 'crypto' | 'stock' | 'real_estate' | 'other';
  initialAmount: number;
  currentValue: number;
  currency: string;
  startDate: Date;
  lastUpdated: Date;
  history: {
    value: number;
    date: Date;
  }[];
  status: 'active' | 'closed';
  createdAt: Date;
  updatedAt: Date;
}

export interface ITransaction {
  userId: mongoose.Types.ObjectId;
  amount: number;
  currency: string;
  type:
    | 'income'
    | 'expense'
    | 'deposit'
    | 'withdrawal'
    | 'tontine_contribution'
    | 'tontine_payout'
    | 'saving_transfer'
    | 'challenge_reward';
  category: string;
  subcategory?: string;
  description: string;
  merchant?: string;
  location?: string;
  date: Date;
  status: 'pending' | 'completed' | 'failed' | 'cancelled';
  reference: string;
  externalReference?: string;
  paymentMethod: 'stripe' | 'notchpay' | 'wallet' | 'cash';
  fees: number;
  metadata?: Record<string, any>;
  receiptUrl?: string; // Link to the generated invoice PDF
  tags: string[];
  isRecurring: boolean;
  recurringFrequency?: 'daily' | 'weekly' | 'monthly' | 'yearly';
  isAutoCategorized: boolean;
  categorizationConfidence?: number;
  receipt?: string;
  linkedGoalId?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export interface IInvoice {
  userId: mongoose.Types.ObjectId;
  transactionId: mongoose.Types.ObjectId;
  invoiceNumber: string;
  amount: number;
  currency: string;
  dueDate?: Date;
  status: 'draft' | 'issued' | 'paid' | 'cancelled';
  pdfUrl?: string;
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

export interface IBudget {
  userId: mongoose.Types.ObjectId;
  period: {
    type: 'monthly' | 'yearly';
    month?: number;
    year: number;
  };
  categories: {
    name: string;
    allocated: number;
    spent: number;
    percentage: number;
  }[];
  totalAllocated: number;
  totalSpent: number;
  status: 'active' | 'completed' | 'exceeded';
  createdAt: Date;
  updatedAt: Date;
}

export interface ISavingGoal {
  userId: mongoose.Types.ObjectId;
  name: string;
  description?: string;
  emoji?: string;
  type: 'emergency' | 'project' | 'regular' | 'challenge' | 'debt';
  targetAmount: number;
  currentAmount: number;
  startDate: Date;
  deadline?: Date;
  priority: 'high' | 'medium' | 'low';
  strategy: {
    type:
      | '50-30-20'
      | 'progressive'
      | 'roundup'
      | 'pay-yourself-first'
      | 'envelope'
      | 'custom'
      | 'snowball'
      | 'avalanche';
    details?: any;
  };
  autoSaveRules: {
    enableSurplus: boolean;
    enableRoundup: boolean;
    percentageIncome: number;
    dayOfMonth: number;
  };
  progress: number;
  status: 'active' | 'completed' | 'cancelled' | 'paused';
  contributions: {
    amount: number;
    date: Date;
    note?: string;
  }[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ICountry {
  code: string; // ISO 3166-1 alpha-2
  name: string;
  currency: string;
  currencySymbol: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ICountryChangeRequest {
  userId: mongoose.Types.ObjectId;
  requestedCountryCode: string;
  status: 'pending' | 'approved' | 'rejected';
  rejectionReason?: string;
  adminId?: mongoose.Types.ObjectId;
  processedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ISubscription {
  userId: mongoose.Types.ObjectId;
  name: string;
  provider?: string;
  amount: number;
  currency: string;
  frequency: 'weekly' | 'monthly' | 'yearly';
  category: string;
  status: 'active' | 'paused' | 'cancelled';
  nextBillingDate: Date;
  trialEndDate?: Date;
  remindMe: boolean;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}
export interface INotification {
  userId: mongoose.Types.ObjectId;
  title: string;
  body: string;
  category: 'transactional' | 'important' | 'informational';
  data?: Record<string, any>;
  isRead: boolean;
  createdAt: Date;
}
