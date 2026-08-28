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
      // > 0 : un objectif à 0 affiche 100% de progression dès sa création
      // (division par zéro côté app) sans qu'aucune épargne n'ait eu lieu.
      min: [0.01, 'Target amount must be greater than zero'],
    },
    currentAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Native currency of targetAmount/currentAmount/contributions[].amount —
    // always set server-side from the creating user's own currency (see
    // GoalService.createGoal), never trust a client-supplied value here.
    // Without this field, currencyMiddleware has no way to tell these amounts
    // are already in e.g. EUR and wrongly re-converts them as if they were XAF.
    currency: {
      type: String,
      default: 'XAF',
    },
    startDate: {
      type: Date,
      default: Date.now,
    },
    deadline: {
      type: Date,
      required: [true, 'Deadline is required'],
    },
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
      percentageIncome: { type: Number, default: 0, min: 0, max: 100 },
      // 1-28 : garantit un déclenchement identique tous les mois (certains
      // n'ont pas de 29/30/31).
      dayOfMonth: { type: Number, default: 1, min: 1, max: 28 },
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
    // Objectifs partagés : l'objectif reste possédé par `userId` (le créateur) —
    // inviteCode n'est généré qu'à la demande (GoalService.shareGoal), pas
    // systématiquement, car la plupart des objectifs ne sont jamais partagés.
    // `sparse` évite tout conflit d'unicité entre les nombreux objectifs sans code.
    inviteCode: { type: String, unique: true, sparse: true, index: true },
    isShared: { type: Boolean, default: false },
    contributions: [
      {
        // Non `required` : les contributions déjà en base avant l'ajout de
        // l'attribution n'en ont pas — tout nouveau code le renseigne toujours.
        userId: { type: Schema.Types.ObjectId, ref: 'User' },
        amount: { type: Number, required: true },
        date: { type: Date, default: Date.now },
        note: String,
        // 'contribution' par défaut : les entrées déjà en base avant l'ajout
        // des rachats à l'historique sont toutes des contributions.
        type: {
          type: String,
          enum: ['contribution', 'redemption'],
          default: 'contribution',
        },
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
