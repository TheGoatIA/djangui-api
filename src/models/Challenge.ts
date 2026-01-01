import mongoose, { Schema, Document } from 'mongoose';

export interface IChallenge extends Document {
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

const challengeSchema = new Schema<IChallenge>(
    {
        title: { type: String, required: true, trim: true },
        description: { type: String, required: true },
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
    }
);

const Challenge = mongoose.model<IChallenge>('Challenge', challengeSchema);

export default Challenge;
