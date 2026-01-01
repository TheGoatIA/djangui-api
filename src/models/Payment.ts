import mongoose, { Schema, Document } from 'mongoose';
import { IPayment } from '../types/models';

export interface IPaymentDocument extends IPayment, Document { }

const paymentSchema = new Schema<IPaymentDocument>(
    {
        userId: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true,
        },
        amount: {
            type: Number,
            required: true,
            min: 0,
        },
        currency: {
            type: String,
            default: 'XAF',
        },
        method: {
            type: String,
            enum: ['stripe', 'notchpay', 'wallet'],
            required: true,
        },
        type: {
            type: String,
            enum: ['deposit', 'subscription', 'withdrawal'],
            required: true,
        },
        status: {
            type: String,
            enum: ['pending', 'completed', 'failed', 'refunded'],
            default: 'pending',
            index: true,
        },
        reference: {
            type: String,
            required: true,
            unique: true,
        },
        externalReference: String,
        metadata: Schema.Types.Mixed,
        completedAt: Date,
    },
    {
        timestamps: true,
    }
);

const Payment = mongoose.model<IPaymentDocument>('Payment', paymentSchema);

export default Payment;
