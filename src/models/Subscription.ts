import mongoose, { Schema, Document } from 'mongoose';
import { ISubscription } from '../types/models';

export interface ISubscriptionDocument extends ISubscription, Document { }

const subscriptionSchema = new Schema<ISubscriptionDocument>(
    {
        userId: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true,
        },
        name: {
            type: String,
            required: [true, 'Subscription name is required'],
            trim: true,
        },
        provider: String,
        amount: {
            type: Number,
            required: [true, 'Amount is required'],
            min: [0, 'Amount cannot be negative'],
        },
        currency: {
            type: String,
            required: true,
            default: 'XAF',
        },
        frequency: {
            type: String,
            enum: ['weekly', 'monthly', 'yearly'],
            required: true,
            default: 'monthly',
        },
        category: {
            type: String,
            required: [true, 'Category is required'],
            default: 'Utilities',
        },
        status: {
            type: String,
            enum: ['active', 'paused', 'cancelled'],
            default: 'active',
        },
        nextBillingDate: {
            type: Date,
            required: true,
        },
        trialEndDate: Date,
        remindMe: {
            type: Boolean,
            default: true,
        },
        notes: String,
    },
    {
        timestamps: true,
    },
);

// Indexes
subscriptionSchema.index({ userId: 1, nextBillingDate: 1 });
subscriptionSchema.index({ userId: 1, status: 1 });

const Subscription = mongoose.model<ISubscriptionDocument>('Subscription', subscriptionSchema);

export default Subscription;
