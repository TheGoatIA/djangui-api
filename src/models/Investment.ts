import mongoose, { Schema, Document } from 'mongoose';
import { IInvestment } from '../types/models';

export interface IInvestmentDocument extends IInvestment, Document {}

const investmentSchema = new Schema<IInvestmentDocument>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      enum: ['crypto', 'stock', 'real_estate', 'other'],
      required: true,
    },
    initialAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    currentValue: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      default: 'XAF',
    },
    startDate: {
      type: Date,
      default: Date.now,
    },
    lastUpdated: {
      type: Date,
      default: Date.now,
    },
    history: [
      {
        value: { type: Number, required: true },
        date: { type: Date, default: Date.now },
      },
    ],
    status: {
      type: String,
      enum: ['active', 'closed'],
      default: 'active',
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

investmentSchema.index({ userId: 1, type: 1 });

const Investment = mongoose.model<IInvestmentDocument>('Investment', investmentSchema);

export default Investment;
