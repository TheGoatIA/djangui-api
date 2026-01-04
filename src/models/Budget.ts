import mongoose, { Schema, Document } from 'mongoose';
import { IBudget } from '../types/models';

export interface IBudgetDocument extends IBudget, Document {}

const budgetSchema = new Schema<IBudgetDocument>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    period: {
      type: {
        type: String,
        enum: ['monthly', 'yearly'],
        required: true,
      },
      month: {
        type: Number,
        min: 1,
        max: 12,
      },
      year: {
        type: Number,
        required: true,
      },
    },
    categories: [
      {
        name: { type: String, required: true },
        allocated: { type: Number, required: true, default: 0 },
        spent: { type: Number, required: true, default: 0 },
        percentage: { type: Number, default: 0 },
      },
    ],
    totalAllocated: {
      type: Number,
      required: true,
      default: 0,
    },
    totalSpent: {
      type: Number,
      required: true,
      default: 0,
    },
    status: {
      type: String,
      enum: ['active', 'completed', 'exceeded'],
      default: 'active',
    },
  },
  {
    timestamps: true,
  },
);

// Unique index for userId + year + month
budgetSchema.index({ userId: 1, 'period.year': 1, 'period.month': 1 }, { unique: true });

const Budget = mongoose.model<IBudgetDocument>('Budget', budgetSchema);

export default Budget;
