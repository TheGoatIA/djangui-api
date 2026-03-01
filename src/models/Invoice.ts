import mongoose, { Schema, Document } from 'mongoose';
import { IInvoice } from '../types/models';

export interface IInvoiceDocument extends IInvoice, Document {}

const invoiceSchema = new Schema<IInvoiceDocument>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    transactionId: {
      type: Schema.Types.ObjectId,
      ref: 'Transaction',
      required: true,
      unique: true,
    },
    invoiceNumber: {
      type: String,
      required: true,
      unique: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    currency: {
      type: String,
      required: true,
      default: 'XAF',
    },
    dueDate: Date,
    status: {
      type: String,
      enum: ['draft', 'issued', 'paid', 'cancelled'],
      default: 'issued',
    },
    pdfUrl: String,
    metadata: Schema.Types.Mixed,
  },
  {
    timestamps: true,
  },
);

invoiceSchema.index({ userId: 1, createdAt: -1 });

const Invoice = mongoose.model<IInvoiceDocument>('Invoice', invoiceSchema);

export default Invoice;
