import mongoose, { Schema, Document } from 'mongoose';

export interface ITontine extends Document {
    name: string;
    creatorId: mongoose.Types.ObjectId;
    frequency: 'weekly' | 'bi-weekly' | 'monthly';
    startDate: Date;
    endDate?: Date;
    contributionAmount: number;
    currency: string;
    totalParts: number;
    rotationMode: 'fixed' | 'random' | 'auction';
    validationMode: 'ia_only' | 'ia_plus_manual';
    status: 'pending' | 'active' | 'completed' | 'suspended' | 'suspended_premium_required';
    sanctions: {
        lateFee: number;
        gracePeriodHours: number;
        absenceFee: number;
    };
    socialFund?: {
        enabled: boolean;
        amount: number;
    };
    escrowDetails: {
        type: 'mobile_money' | 'bank';
        provider: string; // e.g. 'Orange Money', 'MTN MoMo', 'UBA'
        accountNumber: string;
        accountName: string;
    }[];
    autoRenew: boolean;
    inviteCode: string;
    currentTurn: number;
    rulesAcceptedByAll: boolean;
    createdAt: Date;
    updatedAt: Date;
}

const tontineSchema = new Schema<ITontine>(
    {
        name: { type: String, required: true, trim: true },
        creatorId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
        frequency: { type: String, enum: ['weekly', 'bi-weekly', 'monthly'], required: true },
        startDate: { type: Date, required: true },
        endDate: { type: Date },
        contributionAmount: { type: Number, required: true, min: 0 },
        currency: { type: String, default: 'XAF' },
        totalParts: { type: Number, required: true, min: 2 },
        rotationMode: { type: String, enum: ['fixed', 'random', 'auction'], default: 'fixed' },
        validationMode: { type: String, enum: ['ia_only', 'ia_plus_manual'], default: 'ia_only' },
        status: {
            type: String,
            enum: ['pending', 'active', 'completed', 'suspended', 'suspended_premium_required'],
            default: 'pending'
        },
        sanctions: {
            lateFee: { type: Number, default: 0 },
            gracePeriodHours: { type: Number, default: 24 },
            absenceFee: { type: Number, default: 0 },
        },
        socialFund: {
            enabled: { type: Boolean, default: false },
            amount: { type: Number, default: 0 },
        },
        escrowDetails: [{
            type: { type: String, enum: ['mobile_money', 'bank'], required: true },
            provider: { type: String, required: true },
            accountNumber: { type: String, required: true },
            accountName: { type: String, required: true },
        }],
        autoRenew: { type: Boolean, default: false },
        inviteCode: { type: String, unique: true, index: true },
        currentTurn: { type: Number, default: 1 },
        rulesAcceptedByAll: { type: Boolean, default: false },
    },
    { timestamps: true }
);

// Pre-save to generate invite code if missing
tontineSchema.pre('save', function (next) {
    if (!this.inviteCode) {
        this.inviteCode = Math.random().toString(36).substring(2, 10).toUpperCase();
    }
    next();
});

const Tontine = mongoose.model<ITontine>('Tontine', tontineSchema);
export default Tontine;
