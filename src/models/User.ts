import mongoose, { Schema, Document } from 'mongoose';
import bcrypt from 'bcrypt';
import { IUser } from '../types/models';

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
        enum: ['encouraging', 'firm', 'balanced'],
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
        enum: ['free', 'premium'],
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
    lastLogin: Date,
    refreshToken: String,
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: function (doc, ret) {
        const userRet = ret as any;
        delete userRet.password;
        delete userRet.__v;
        return userRet;
      },
    },
    toObject: { virtuals: true },
  },
);

// Virtual for isPremium
userSchema.virtual('isPremium').get(function (this: IUserDocument) {
  return this.subscription?.plan === 'premium' && this.subscription?.status === 'active';
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

// Index for email
userSchema.index({ email: 1 });

const User = mongoose.model<IUserDocument>('User', userSchema);

export default User;
