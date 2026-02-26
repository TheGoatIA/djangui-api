import mongoose, { Schema, Document } from 'mongoose';
import { ITransaction } from '../types/models';

export interface ITransactionDocument extends ITransaction, Document { }

const transactionSchema = new Schema<ITransactionDocument>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
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
    type: {
      type: String,
      enum: [
        'income',
        'expense',
        'deposit',
        'withdrawal',
        'tontine_contribution',
        'tontine_payout',
        'saving_transfer',
      ],
      required: [true, 'Type is required'],
    },
    category: {
      type: String,
      required: [true, 'Category is required'],
    },
    subcategory: String,
    description: {
      type: String,
      required: [true, 'Description is required'],
    },
    merchant: String,
    location: String,
    date: {
      type: Date,
      default: Date.now,
      required: true,
    },
    status: {
      type: String,
      enum: ['pending', 'completed', 'failed', 'cancelled'],
      default: 'completed',
    },
    reference: {
      type: String,
      unique: true,
      sparse: true,
    },
    externalReference: String,
    paymentMethod: {
      type: String,
      enum: ['stripe', 'notchpay', 'wallet', 'cash'],
    },
    fees: {
      type: Number,
      default: 0,
    },
    metadata: Schema.Types.Mixed,
    receiptUrl: String,
    tags: [String],
    isRecurring: {
      type: Boolean,
      default: false,
    },
    recurringFrequency: {
      type: String,
      enum: ['daily', 'weekly', 'monthly', 'yearly'],
    },
    isAutoCategorized: {
      type: Boolean,
      default: false,
    },
    categorizationConfidence: Number,
    receipt: String,
    linkedGoalId: {
      type: Schema.Types.ObjectId,
      ref: 'SavingGoal',
    },
  },
  {
    timestamps: true,
  },
);

// Indexes for performance
transactionSchema.index({ userId: 1, date: -1 });
transactionSchema.index({ userId: 1, category: 1 });
transactionSchema.index({ userId: 1, type: 1, date: -1 });

const Transaction = mongoose.model<ITransactionDocument>('Transaction', transactionSchema);

export default Transaction;
