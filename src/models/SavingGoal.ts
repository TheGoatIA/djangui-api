import mongoose, { Schema, Document } from 'mongoose';
import { ISavingGoal } from '../types/models';

export interface ISavingGoalDocument extends ISavingGoal, Document {}

const savingGoalSchema = new Schema<ISavingGoalDocument>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: [true, 'Goal name is required'],
      trim: true,
    },
    description: String,
    emoji: String,
    type: {
      type: String,
      enum: ['emergency', 'project', 'regular', 'challenge', 'debt'],
      default: 'regular',
    },
    targetAmount: {
      type: Number,
      required: [true, 'Target amount is required'],
      min: [0, 'Target amount cannot be negative'],
    },
    currentAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    startDate: {
      type: Date,
      default: Date.now,
    },
    deadline: Date,
    priority: {
      type: String,
      enum: ['high', 'medium', 'low'],
      default: 'medium',
    },
    strategy: {
      type: {
        type: String,
        enum: [
          '50-30-20',
          'progressive',
          'roundup',
          'pay-yourself-first',
          'envelope',
          'custom',
          'snowball',
          'avalanche',
        ],
        default: 'custom',
      },
      details: Schema.Types.Mixed,
    },
    autoSaveRules: {
      enableSurplus: { type: Boolean, default: false },
      enableRoundup: { type: Boolean, default: false },
      percentageIncome: { type: Number, default: 0 },
      dayOfMonth: { type: Number, default: 1 },
    },
    progress: {
      type: Number,
      default: 0,
    },
    status: {
      type: String,
      enum: ['active', 'completed', 'cancelled', 'paused'],
      default: 'active',
    },
    contributions: [
      {
        amount: { type: Number, required: true },
        date: { type: Date, default: Date.now },
        note: String,
      },
    ],
  },
  {
    timestamps: true,
  },
);

// Pre-save hook to calculate progress
savingGoalSchema.pre('save', function () {
  const goal = this as any;
  if (goal.targetAmount > 0) {
    goal.progress = Math.min(100, (goal.currentAmount / goal.targetAmount) * 100);
  } else {
    goal.progress = 0;
  }
});

savingGoalSchema.index({ userId: 1, status: 1 });
savingGoalSchema.index({ userId: 1, type: 1 });

const SavingGoal = mongoose.model<ISavingGoalDocument>('SavingGoal', savingGoalSchema);

export default SavingGoal;
