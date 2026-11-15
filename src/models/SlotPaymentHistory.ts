import mongoose, { Schema, Document } from 'mongoose';
import { ISlotPaymentHistory } from '../types/models';

export interface ISlotPaymentHistoryDocument extends ISlotPaymentHistory, Document {}

const slotPaymentHistorySchema = new Schema<ISlotPaymentHistoryDocument>(
  {
    slotId: {
      type: Schema.Types.ObjectId,
      ref: 'SharedSlot',
      required: true,
      index: true,
    },
    masterAccountId: {
      type: Schema.Types.ObjectId,
      ref: 'SharedMasterAccount',
      required: true,
      index: true,
    },
    resellerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    amount: {
      type: Number,
      required: [true, 'Le montant payé est requis'],
      min: [0, 'Le montant ne peut pas être négatif'],
    },
    currency: {
      type: String,
      required: true,
      default: 'XAF',
    },
    periodCoveredStart: {
      type: Date,
      required: true,
    },
    periodCoveredEnd: {
      type: Date,
      required: true,
    },
    paidAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    paymentMethod: {
      type: String,
      enum: ['cash', 'momo', 'om', 'bank_transfer', 'card', 'other'],
      default: 'momo',
    },
    notes: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
  },
);

slotPaymentHistorySchema.index({ resellerId: 1, paidAt: -1 });

const SlotPaymentHistory = mongoose.model<ISlotPaymentHistoryDocument>(
  'SlotPaymentHistory',
  slotPaymentHistorySchema,
);

export default SlotPaymentHistory;
