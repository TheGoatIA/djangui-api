import mongoose, { Schema, Document } from 'mongoose';

export interface ITontineContribution extends Document {
    tontineId: mongoose.Types.ObjectId;
    memberId: mongoose.Types.ObjectId;
    turnIndex: number;
    amountPaid: number;
    currency: string;
    proofImage?: string;
    transactionRef?: string;
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
        transactionRef: { type: String, index: true }, // For duplicate detection
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
    { timestamps: true }
);

// One contribution per member per turn
tontineContributionSchema.index({ tontineId: 1, memberId: 1, turnIndex: 1 }, { unique: true });

const TontineContribution = mongoose.model<ITontineContribution>('TontineContribution', tontineContributionSchema);
export default TontineContribution;
