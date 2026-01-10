import mongoose, { Schema, Document } from 'mongoose';

export interface IArchivedTransaction extends Document {
  userId: mongoose.Types.ObjectId;
  amount: number;
  type: 'income' | 'expense';
  category: string;
  subcategory?: string;
  description: string;
  merchant?: string;
  location?: string;
  date: Date;
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
    type: {
      type: String,
      enum: ['income', 'expense'],
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
