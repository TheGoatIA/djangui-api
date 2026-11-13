import mongoose, { Schema, Document } from 'mongoose';

export interface ITontineMember extends Document {
  tontineId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  displayName: string;
  parts: number;
  trustScore: number;
  hasPaidSocialFund: boolean;
  invitationStatus: 'pending' | 'accepted' | 'declined' | 'removed';
  rotationOrder: number; // First turn of this member (kept for existing clients)
  rotationOrders: number[]; // Every turn this member receives the pot (one per part)
  isActive: boolean;
  isAutoDebitEnabled: boolean;
  joinedAt: Date;
}

const tontineMemberSchema = new Schema<ITontineMember>(
  {
    tontineId: { type: Schema.Types.ObjectId, ref: 'Tontine', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    displayName: { type: String, required: true, trim: true },
    parts: { type: Number, default: 1, min: 1 },
    trustScore: { type: Number, default: 100, min: 0, max: 100 },
    hasPaidSocialFund: { type: Boolean, default: false },
    invitationStatus: {
      type: String,
      enum: ['pending', 'accepted', 'declined', 'removed'],
      default: 'pending',
    },
    rotationOrder: { type: Number },
    // A member holding N parts receives the pot on N turns. A single number could
    // only ever give them one, leaving the other turns with no winner.
    rotationOrders: { type: [Number], default: undefined },
    isActive: { type: Boolean, default: true },
    isAutoDebitEnabled: { type: Boolean, default: true },
    joinedAt: { type: Date, default: Date.now },
  },
  {
    timestamps: true,
    toJSON: { getters: true },
    toObject: { getters: true },
  },
);

// Unique member per tontine
tontineMemberSchema.index({ tontineId: 1, userId: 1 }, { unique: true });

const TontineMember = mongoose.model<ITontineMember>('TontineMember', tontineMemberSchema);
export default TontineMember;
