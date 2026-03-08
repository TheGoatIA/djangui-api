import mongoose, { Schema, Document } from 'mongoose';

import { IUserChallenge } from '../types/models';

export interface IUserChallengeDocument extends IUserChallenge, Document {}

const userChallengeSchema = new Schema<IUserChallenge>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    challengeId: { type: Schema.Types.ObjectId, ref: 'Challenge', required: true },
    status: {
      type: String,
      enum: ['active', 'completed', 'failed', 'abandoned', 'redeemed'],
      default: 'active',
    },
    progress: { type: Number, default: 0 },
    currentValue: { type: Number, default: 0 },
    startDate: { type: Date, default: Date.now },
    endDate: { type: Date, required: true },
    completedAt: { type: Date },
    stakeAmount: { type: Number, default: 0 },
    potentialReward: { type: Number, default: 0 },
    transactionId: { type: Schema.Types.ObjectId, ref: 'Transaction' },
    weeks: [
      {
        weekNumber: { type: Number, required: true },
        targetAmount: { type: Number, required: true },
        savedAmount: { type: Number, default: 0 },
        status: {
          type: String,
          enum: ['pending', 'completed', 'late', 'skipped', 'postponed', 'rejected'],
          default: 'pending',
        },
        validatedAt: Date,
        proofImageUrl: String,
        transactionId: { type: String, index: true },
        transactionDate: Date,
        verificationStatus: {
          type: String,
          enum: ['pending', 'verified', 'rejected'],
        },
        verificationNote: String,
      },
    ],
    flexibility: {
      skipsUsed: { type: Number, default: 0 },
      skipsMax: { type: Number, default: 3 },
      postponementsUsed: { type: Number, default: 0 },
      postponementsMax: { type: Number, default: 2 },
    },
  },
  {
    timestamps: true,
  },
);

userChallengeSchema.index({ userId: 1, status: 1 });

const UserChallenge = mongoose.model<IUserChallenge>('UserChallenge', userChallengeSchema);

export default UserChallenge;
