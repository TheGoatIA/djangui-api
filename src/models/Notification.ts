import mongoose, { Schema, Document } from 'mongoose';

export interface INotification extends Document {
    userId: mongoose.Types.ObjectId;
    title: string;
    body: string;
    data?: Record<string, any>;
    isRead: boolean;
    createdAt: Date;
}

const notificationSchema: Schema = new Schema(
    {
        userId: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            required: [true, 'Notification must belong to a user'],
            index: true,
        },
        title: {
            type: String,
            required: [true, 'Notification must have a title'],
        },
        body: {
            type: String,
            required: [true, 'Notification must have a body'],
        },
        data: {
            type: Schema.Types.Mixed,
            default: {},
        },
        isRead: {
            type: Boolean,
            default: false,
        },
    },
    {
        timestamps: { createdAt: true, updatedAt: false },
    },
);

// Index for performance on listing user notifications
notificationSchema.index({ userId: 1, createdAt: -1 });

const Notification = mongoose.model<INotification>('Notification', notificationSchema);

export default Notification;
