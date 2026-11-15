import mongoose, { Schema, Document } from 'mongoose';

export interface ITontineContribution extends Document {
  tontineId: mongoose.Types.ObjectId;
  memberId: mongoose.Types.ObjectId;
  turnIndex: number;
  amountPaid: number;
  currency: string;
  proofImage?: string;
  proofImageHash?: string;
  transactionRef?: string;
  /**
   * Where the money is. 'wallet' = debited from the member's Kauri wallet (real
   * money held by Kauri). 'receipt' = paid OUTSIDE the app, only proven by an
   * uploaded receipt: Kauri never received it, so it must never be paid out
   * from a wallet (see TontineService.rotateTurn).
   */
  source?: 'wallet' | 'receipt';
  validationStatus: 'pending' | 'ai_validated' | 'manual_pending' | 'completed' | 'rejected';
  rejectionReason?: string;
  aiAnalysis?: {
    detectedAmount: number;
    detectedDate: Date;
    detectedBeneficiary: string;
    detectedRef: string;
    rawText?: string;
    confidence: number;
  };
  lateFeesApplied: number;
  paidAt: Date;
}

const tontineContributionSchema = new Schema<ITontineContribution>(
  {
    tontineId: { type: Schema.Types.ObjectId, ref: 'Tontine', required: true, index: true },
    memberId: { type: Schema.Types.ObjectId, ref: 'TontineMember', required: true, index: true },
    turnIndex: { type: Number, required: true },
    amountPaid: { type: Number, required: true },
    currency: { type: String, required: true },
    proofImage: { type: String },
    // Fallback duplicate-receipt detector for when OCR can't extract a reliable
    // transactionRef (falls back to "UNKNOWN_<timestamp>", which never collides) —
    // see TontineAIService.isDuplicate. This field existed on the TS interface but
    // was missing here, so Mongoose's strict mode silently dropped it on every
    // `.create()` and the duplicate check could never actually match anything.
    proofImageHash: { type: String, index: true },
    transactionRef: { type: String, index: true }, // For duplicate detection
    source: { type: String, enum: ['wallet', 'receipt'] },
    validationStatus: {
      type: String,
      enum: ['pending', 'ai_validated', 'manual_pending', 'completed', 'rejected'],
      default: 'pending',
    },
    rejectionReason: { type: String },
    aiAnalysis: {
      detectedAmount: Number,
      detectedDate: Date,
      detectedBeneficiary: String,
      detectedRef: String,
      rawText: String,
      confidence: Number,
    },
    lateFeesApplied: { type: Number, default: 0 },
    paidAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

// One contribution per member per turn — excluding 'rejected' ones, so a member
// whose receipt was rejected can submit a new one for the same turn instead of
// being permanently blocked by the unique index.
tontineContributionSchema.index(
  { tontineId: 1, memberId: 1, turnIndex: 1 },
  { unique: true, partialFilterExpression: { validationStatus: { $ne: 'rejected' } } },
);

const TontineContribution = mongoose.model<ITontineContribution>(
  'TontineContribution',
  tontineContributionSchema,
);
export default TontineContribution;
