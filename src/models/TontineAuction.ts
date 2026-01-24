import mongoose, { Schema, Document } from 'mongoose';

export interface ITontineAuction extends Document {
  tontineId: mongoose.Types.ObjectId;
  turnIndex: number;
  bids: {
    memberId: mongoose.Types.ObjectId;
    amount: number;
    bidAt: Date;
  }[];
  winningBid?: {
    memberId: mongoose.Types.ObjectId;
    amount: number;
  };
  status: 'open' | 'closed' | 'cancelled';
  expiresAt: Date;
}

const tontineAuctionSchema = new Schema<ITontineAuction>(
  {
    tontineId: { type: Schema.Types.ObjectId, ref: 'Tontine', required: true, index: true },
    turnIndex: { type: Number, required: true },
    bids: [
      {
        memberId: { type: Schema.Types.ObjectId, ref: 'TontineMember', required: true },
        amount: { type: Number, required: true },
        bidAt: { type: Date, default: Date.now },
      },
    ],
    winningBid: {
      memberId: { type: Schema.Types.ObjectId, ref: 'TontineMember' },
      amount: { type: Number },
    },
    status: { type: String, enum: ['open', 'closed', 'cancelled'], default: 'open' },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

// One auction per turn
tontineAuctionSchema.index({ tontineId: 1, turnIndex: 1 }, { unique: true });

const TontineAuction = mongoose.model<ITontineAuction>('TontineAuction', tontineAuctionSchema);
export default TontineAuction;
