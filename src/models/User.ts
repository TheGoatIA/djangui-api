import mongoose, { Schema, Document } from 'mongoose';
import bcrypt from 'bcrypt';
import { IUser } from '../types/models';
import { VaultCrypto } from '../utils/vaultCrypto';
import { isSubscriptionEntitled } from '../utils/subscription';

export interface IUserDocument extends IUser, Document {
  firebaseUid?: string;
  comparePassword(password: string): Promise<boolean>;
}

const userSchema = new Schema<IUserDocument>(
  {
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
    },
    role: {
      type: String,
      enum: ['user', 'admin', 'support'],
      default: 'user',
    },
    password: {
      type: String,
      minlength: 8,
      select: false,
    },
    firstName: {
      type: String,
      required: [true, 'First name is required'],
      trim: true,
    },
    lastName: {
      type: String,
      required: [true, 'Last name is required'],
      trim: true,
    },
    phone: String,
    avatar: String,
    monthlyIncome: {
      type: Number,
      default: 0,
    },
    currency: {
      type: String,
      default: 'XAF',
    },
    country: {
      type: String,
      default: 'CM', // Default to Cameroon as requested
    },
    language: {
      type: String,
      default: 'fr',
    },
    firebaseUid: {
      type: String,
      index: true,
    },
    preferences: {
      coachTone: {
        type: String,
        enum: [
          'encouraging',
          'firm',
          'balanced',
          'billionaire_mentor',
          'strict_accountant',
          'kind_auntie',
        ],
        default: 'balanced',
      },
      notificationFrequency: {
        type: String,
        enum: ['high', 'medium', 'low'],
        default: 'medium',
      },
      budgetAlertThreshold: {
        type: Number,
        default: 80,
      },
    },
    subscription: {
      plan: {
        type: String,
        // 'business' = Super Premium (Reseller Hub tier)
        enum: ['free', 'premium', 'business'],
        default: 'free',
      },
      status: {
        type: String,
        enum: ['active', 'cancelled', 'expired'],
        default: 'active',
      },
      startDate: Date,
      endDate: Date,
      autoRenew: {
        type: Boolean,
        default: false,
      },
    },
    isEmailVerified: {
      type: Boolean,
      default: false,
    },
    emailVerificationToken: String,
    emailVerificationExpires: Date,
    passwordResetToken: String,
    passwordResetExpires: Date,
    isActive: {
      type: Boolean,
      default: true,
    },
    isPhoneVerified: {
      type: Boolean,
      default: false,
    },
    walletBalance: {
      type: Number,
      default: 0,
      min: 0,
    },
    kycLevel: {
      type: String,
      enum: ['none', 'pending', 'verified', 'rejected', 'expired', 'update_required'],
      default: 'none',
      index: true,
    },
    kycData: {
      documentType: { type: String },
      documentNumber: {
        type: String,
        set: (val: string) => (val ? VaultCrypto.encryptSimple(val, 'kyc_doc') : val),
        get: (val: string) => (val ? VaultCrypto.decryptSimple(val, 'kyc_doc') : val),
      },
      fullName: String,
      documentImageUrl: String,
      documentBackImageUrl: String,
      documentExpiryDate: Date,
      selfieImageUrl: String,
      verifiedAt: Date,
      rejectionReason: String,
      aiReport: String,
      aiConfidence: Number,
      aiAnalysisStatus: {
        type: String,
        enum: ['pending', 'completed', 'failed'],
        default: 'pending',
      },
    },
    xp: {
      type: Number,
      default: 0,
    },
    level: {
      type: Number,
      default: 1,
    },
    badges: [
      {
        name: String,
        icon: String,
        awardedAt: { type: Date, default: Date.now },
      },
    ],
    fcmTokens: [String],
    sessions: [
      {
        deviceId: String,
        deviceInfo: {
          model: String,
          os: String,
          osVersion: String,
          platform: {
            type: String,
            enum: ['android', 'ios', 'web'],
          },
        },
        appVersion: String,
        refreshToken: String,
        lastActive: { type: Date, default: Date.now },
        createdAt: { type: Date, default: Date.now },
        ipAddress: String,
      },
    ],
    // Legacy fields (kept for compatibility during migration if needed)
    deviceInfo: {
      model: String,
      os: String,
      osVersion: String,
      platform: {
        type: String,
        enum: ['android', 'ios', 'web'],
      },
    },
    appVersion: String,
    lastLogin: Date,
    refreshToken: String,
    // AI Security — système de paliers (plus de suspension automatique de compte)
    aiSecurity: {
      attackCount: { type: Number, default: 0 },
      coachBlockedUntil: { type: Date, default: null },
      suspensionPending: { type: Boolean, default: false },
      lastAttackAt: { type: Date, default: null },
    },
    status: {
      type: String,
      enum: ['active', 'suspended', 'blocked'],
      default: 'active',
    },
    // TOTP 2FA — opt-in, currently only surfaced to admin/support accounts in
    // the admin dashboard (see AuthService.login). `totpTempSecret` holds a
    // freshly generated secret during setup, before the user has proven they
    // scanned it; it's promoted to `totpSecret` only once a valid code is
    // confirmed via /auth/2fa/enable.
    security: {
      totpSecret: { type: String, select: false },
      totpTempSecret: { type: String, select: false },
      totpEnabled: { type: Boolean, default: false },
      backupCodeHashes: { type: [String], select: false, default: [] },
    },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      getters: true,
      transform: function (doc, ret) {
        const userRet = ret as any;
        delete userRet.password;
        delete userRet.__v;
        // `security.totpSecret`/`totpTempSecret`/`backupCodeHashes` are
        // `select: false` at the schema level, but any query that explicitly
        // `.select('+security.totpSecret')` (as the 2FA verification flow
        // must, to check the submitted code) would otherwise serialize the
        // permanent TOTP seed straight back into the API response — which
        // hands out everything needed to forge valid codes forever. Strip
        // these unconditionally here so no call site can leak them by
        // omission, the same way `password` is handled above.
        if (userRet.security) {
          delete userRet.security.totpSecret;
          delete userRet.security.totpTempSecret;
          delete userRet.security.backupCodeHashes;
        }
        // Refresh tokens are hashed (not directly usable as a credential), but
        // there's no reason GET /me or any other serialized User should ever
        // return them to the client — strip unconditionally, same as password.
        delete userRet.refreshToken;
        if (Array.isArray(userRet.sessions)) {
          userRet.sessions = userRet.sessions.map((s: any) => {
            const { refreshToken, ...rest } = s;
            return rest;
          });
        }
        return userRet;
      },
    },
    toObject: { virtuals: true },
  },
);

// Virtual for isPremium — true for both 'premium' and 'business' plans
// A cancelled plan stays entitled until its endDate (see utils/subscription.ts).
userSchema.virtual('isPremium').get(function (this: IUserDocument) {
  return isSubscriptionEntitled(this.subscription as any);
});

// Virtual for isBusiness — true only for the 'business' (Super Premium) plan
userSchema.virtual('isBusiness').get(function (this: IUserDocument) {
  return isSubscriptionEntitled(this.subscription as any, ['business']);
});

// Pre-save hook for password hashing
userSchema.pre('save', async function (this: IUserDocument) {
  if (!this.isModified('password') || !this.password) return;

  try {
    const salt = await bcrypt.genSalt(12);
    this.password = await bcrypt.hash(this.password, salt);
  } catch (err: any) {
    throw err;
  }
});

// Instance method to compare password
userSchema.methods.comparePassword = async function (candidatePassword: string): Promise<boolean> {
  if (!this.password) return false;
  return bcrypt.compare(candidatePassword, this.password);
};

// Index for email is already defined in the field with unique: true

const User = mongoose.model<IUserDocument>('User', userSchema);

export default User;
