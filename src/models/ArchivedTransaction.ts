import mongoose, { Schema, Document } from 'mongoose';

// Mirrors Transaction's field set/enums exactly (see models/Transaction.ts). This
// used to declare only `type: 'income' | 'expense'`, but ArchiveService.runArchiving
// copies EVERY Transaction older than 2 years regardless of type — deposits,
// withdrawals, tontine contributions/payouts, and saving transfers are the bulk of
// a fintech app's ledger. The first batch containing any of those types failed
// insertMany's schema validation and aborted before the delete step ran, so the
// archiving job could never actually succeed against a real dataset.
export interface IArchivedTransaction extends Document {
  userId: mongoose.Types.ObjectId;
  amount: number;
  currency: string;
  type:
    | 'income'
    | 'expense'
    | 'deposit'
    | 'withdrawal'
    | 'tontine_contribution'
    | 'tontine_payout'
    | 'saving_transfer';
  category: string;
  subcategory?: string;
  description: string;
  merchant?: string;
  location?: string;
  date: Date;
  status?: 'pending' | 'completed' | 'failed' | 'cancelled';
  reference?: string;
  externalReference?: string;
  paymentMethod?: 'stripe' | 'notchpay' | 'wallet' | 'cash';
  fees?: number;
  metadata?: any;
  receiptUrl?: string;
  tags?: string[];
  isRecurring: boolean;
  recurringFrequency?: string;
  isAutoCategorized: boolean;
  categorizationConfidence?: number;
  receipt?: string;
  linkedGoalId?: mongoose.Types.ObjectId;
  archivedAt: Date;
}

const archivedTransactionSchema = new Schema<IArchivedTransaction>(
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
    },
    currency: {
      type: String,
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
      required: true,
    },
    category: {
      type: String,
      required: true,
    },
    subcategory: String,
    description: String,
    merchant: String,
    location: String,
    date: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      enum: ['pending', 'completed', 'failed', 'cancelled'],
    },
    // Not unique here (unlike Transaction.reference): the live collection already
    // enforced uniqueness, and re-archiving must never fail on a duplicate-key error.
    reference: String,
    externalReference: String,
    paymentMethod: {
      type: String,
      enum: ['stripe', 'notchpay', 'wallet', 'cash'],
    },
    fees: Number,
    metadata: Schema.Types.Mixed,
    receiptUrl: String,
    tags: [String],
    isRecurring: {
      type: Boolean,
      default: false,
    },
    recurringFrequency: String,
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
    archivedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: false, // We use original date and archivedAt
  },
);

archivedTransactionSchema.index({ userId: 1, date: -1 });

const ArchivedTransaction = mongoose.model<IArchivedTransaction>(
  'ArchivedTransaction',
  archivedTransactionSchema,
);

export default ArchivedTransaction;
