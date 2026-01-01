import mongoose, { Schema, Document } from 'mongoose';

export interface IUserChallenge extends Document {
    userId: mongoose.Types.ObjectId;
    challengeId: mongoose.Types.ObjectId;
    status: 'active' | 'completed' | 'failed' | 'abandoned';
    progress: number;
    currentValue: number;
    startDate: Date;
    endDate: Date;
    completedAt?: Date;
    createdAt: Date;
    updatedAt: Date;
}

const userChallengeSchema = new Schema<IUserChallenge>(
    {
        userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
        challengeId: { type: Schema.Types.ObjectId, ref: 'Challenge', required: true },
        status: {
            type: String,
            enum: ['active', 'completed', 'failed', 'abandoned'],
            default: 'active',
        },
        progress: { type: Number, default: 0 },
        currentValue: { type: Number, default: 0 },
        startDate: { type: Date, default: Date.now },
        endDate: { type: Date, required: true },
        completedAt: { type: Date },
    },
    {
        timestamps: true,
    }
);

userChallengeSchema.index({ userId: 1, status: 1 });

const UserChallenge = mongoose.model<IUserChallenge>('UserChallenge', userChallengeSchema);

export default UserChallenge;
