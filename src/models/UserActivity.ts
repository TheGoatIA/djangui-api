import mongoose, { Schema, Document } from 'mongoose';

export interface IUserActivity extends Document {
    userId: mongoose.Types.ObjectId;
    feature: string; // e.g., 'Tontine', 'Budget', 'Subscription'
    action: string; // e.g., 'view', 'create', 'update', 'delete', 'click'
    details?: any; // Metadata about the action
    platform: 'android' | 'ios' | 'web';
    appVersion?: string;
    createdAt: Date;
}

const userActivitySchema = new Schema<IUserActivity>(
    {
        userId: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true,
        },
        feature: {
            type: String,
            required: true,
            index: true,
        },
        action: {
            type: String,
            required: true,
        },
        details: Schema.Types.Mixed,
        platform: {
            type: String,
            enum: ['android', 'ios', 'web'],
            default: 'android',
        },
        appVersion: String,
    },
    {
        timestamps: { createdAt: true, updatedAt: false },
    }
);

// Indexes for analytics queries
userActivitySchema.index({ feature: 1, action: 1 });
userActivitySchema.index({ createdAt: 1 });

const UserActivity = mongoose.model<IUserActivity>('UserActivity', userActivitySchema);

export default UserActivity;
