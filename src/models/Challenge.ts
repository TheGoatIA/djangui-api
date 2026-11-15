import mongoose, { Schema, Document } from 'mongoose';

import { IChallenge } from '../types/models';

export interface IChallengeDocument extends IChallenge, Document {}

const challengeSchema = new Schema<IChallenge>(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, required: true },
    // Version anglaise (facultative) : servie aux utilisateurs anglophones.
    titleEn: { type: String, trim: true },
    descriptionEn: { type: String },
    type: { type: String, enum: ['saving', 'spending_cut', 'habit'], default: 'saving' },
    difficulty: { type: String, enum: ['easy', 'medium', 'hard'], default: 'medium' },
    targetAmount: { type: Number },
    durationDays: { type: Number, required: true },
    category: { type: String },
    icon: { type: String, default: '🏆' },
    rewardPoints: { type: Number, default: 10 },
    isCustom: { type: Boolean, default: false },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  {
    timestamps: true,
  },
);

const Challenge = mongoose.model<IChallenge>('Challenge', challengeSchema);

export default Challenge;
