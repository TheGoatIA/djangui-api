import mongoose, { Schema, Document } from 'mongoose';

export interface ITontineVote extends Document {
  tontineId: mongoose.Schema.Types.ObjectId;
  creatorId: mongoose.Schema.Types.ObjectId;
  question: string;
  options: { text: string; count: number }[];
  voters: mongoose.Schema.Types.ObjectId[];
  expiresAt: Date;
  status: 'open' | 'closed';
  /** 'closure' = members decide whether an ACTIVE tontine stops mid-cycle. */
  kind: 'general' | 'closure';
  outcome?: 'approved' | 'rejected';
}

const TontineVoteSchema: Schema = new Schema(
  {
    tontineId: { type: Schema.Types.ObjectId, ref: 'Tontine', required: true },
    creatorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    question: { type: String, required: true },
    options: [
      {
        text: { type: String, required: true },
        count: { type: Number, default: 0 },
      },
    ],
    voters: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    expiresAt: { type: Date, required: true },
    status: { type: String, enum: ['open', 'closed'], default: 'open' },
    kind: { type: String, enum: ['general', 'closure'], default: 'general' },
    outcome: { type: String, enum: ['approved', 'rejected'] },
  },
  { timestamps: true },
);

export default mongoose.model<ITontineVote>('TontineVote', TontineVoteSchema);
