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
    },
    paymentId: {
      type: Schema.Types.ObjectId,
      ref: 'Payment',
    },
    invoiceNumber: {
      type: String,
      required: true,
      unique: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
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
// Prevents two concurrent triggers (e.g. the automatic post-payment generation
// racing a client polling GET /fintech/invoice/:transactionId) from both passing
// a "does an invoice exist yet" check before either persists, which previously
// could create two Invoice documents — and two PDF/MinIO uploads — for one
// transaction/payment. Sparse so documents that only set the other reference
// (transactionId vs paymentId) aren't compared against each other.
invoiceSchema.index({ transactionId: 1 }, { unique: true, sparse: true });
invoiceSchema.index({ paymentId: 1 }, { unique: true, sparse: true });

const Invoice = mongoose.model<IInvoiceDocument>('Invoice', invoiceSchema);

export default Invoice;
