import mongoose, { Schema, Document } from 'mongoose';
import crypto from 'crypto';

export interface ITontine extends Document {
  name: string;
  creatorId: mongoose.Types.ObjectId;
  frequency: 'weekly' | 'bi-weekly' | 'monthly';
  startDate: Date;
  endDate?: Date;
  contributionAmount: number;
  currency: string;
  totalParts: number;
  rotationMode: 'fixed' | 'random';
  validationMode: 'ia_plus_manual';
  status: 'pending' | 'active' | 'completed' | 'suspended' | 'suspended_premium_required';
  sanctions: {
    lateFee: number;
    gracePeriodHours: number;
    absenceFee: number;
  };
  socialFund?: {
    enabled: boolean;
    amount: number;
    // Total réellement collecté (somme des paiements de fonds social des membres),
    // distinct de `amount` qui est le montant unitaire demandé à chaque membre.
    totalCollected: number;
  };
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
    // 'auction' retiré (V-02) : jamais implémenté, se comportait silencieusement
    // comme 'fixed' — voir startTontine, qui n'a jamais eu de branche dédiée.
    rotationMode: { type: String, enum: ['fixed', 'random'], default: 'fixed' },
    // 'ia_only' retiré (V-01) : la validation automatique sans revue humaine
    // permettait de créditer de l'argent réel sur la seule foi d'une lecture OCR
    // (confiance toujours fixée à 0.9, aucune confirmation de paiement réelle).
    // Toute cotisation passe désormais par une validation manuelle du créateur.
    validationMode: { type: String, enum: ['ia_plus_manual'], default: 'ia_plus_manual' },
    status: {
      type: String,
      enum: ['pending', 'active', 'completed', 'suspended', 'suspended_premium_required'],
      default: 'pending',
    },
    sanctions: {
      lateFee: { type: Number, default: 0 },
      gracePeriodHours: { type: Number, default: 24 },
      absenceFee: { type: Number, default: 0 },
    },
    socialFund: {
      enabled: { type: Boolean, default: false },
      amount: { type: Number, default: 0 },
      totalCollected: { type: Number, default: 0 },
    },
    autoRenew: { type: Boolean, default: false },
    inviteCode: { type: String, unique: true, index: true },
    currentTurn: { type: Number, default: 1 },
    rulesAcceptedByAll: { type: Boolean, default: false },
  },
  {
    timestamps: true,
    toJSON: { getters: true },
    toObject: { getters: true },
  },
);

// Pre-save to generate invite code if missing. Uses a CSPRNG (not Math.random, which is
// predictable and not suitable for anything access-control-adjacent) so codes can't be
// brute-forced/guessed in a feasible number of attempts.
tontineSchema.pre('save', function (next) {
  if (!this.inviteCode) {
    this.inviteCode = crypto.randomBytes(6).toString('hex').toUpperCase();
  }
  next();
});

const Tontine = mongoose.model<ITontine>('Tontine', tontineSchema);
export default Tontine;
