import mongoose, { Schema, Document } from 'mongoose';
import { IPayment } from '../types/models';

export interface IPaymentDocument extends IPayment, Document {}

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
    // Contrôle à deux mains sur les relances de retrait MoMo : un admin
    // demande la relance, un AUTRE admin doit l'approuver avant que le statut
    // ne repasse à 'pending' (et ne déclenche réellement une nouvelle
    // tentative de transfert). Empêche un compte admin unique, compromis ou
    // malveillant, de relancer des transferts d'argent seul.
    retryApproval: {
      status: {
        type: String,
        enum: ['none', 'pending_approval', 'approved', 'rejected'],
        default: 'none',
      },
      requestedBy: { type: Schema.Types.ObjectId, ref: 'User' },
      requestedAt: Date,
      approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
      approvedAt: Date,
      reason: String,
    },
  },
  {
    timestamps: true,
  },
);

// Match the actual query patterns used elsewhere: PaymentService.getUserPayments
// (userId[, type], sorted by createdAt) and AdminController.getPayouts (type:
// 'withdrawal'[, status], sorted by createdAt) were previously unindexed for these
// shapes and would fall back to a collection scan + in-memory sort at scale.
paymentSchema.index({ userId: 1, createdAt: -1 });
paymentSchema.index({ type: 1, status: 1, createdAt: -1 });

const Payment = mongoose.model<IPaymentDocument>('Payment', paymentSchema);

export default Payment;
