import mongoose, { Schema, Document } from 'mongoose';

export interface IBudgetParticipant extends Document {
  budgetId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  displayName: string;
  invitationStatus: 'pending' | 'accepted' | 'declined' | 'removed';
  joinedAt: Date;
}

const budgetParticipantSchema = new Schema<IBudgetParticipant>(
  {
    budgetId: { type: Schema.Types.ObjectId, ref: 'Budget', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    displayName: { type: String, required: true, trim: true },
    invitationStatus: {
      type: String,
      enum: ['pending', 'accepted', 'declined', 'removed'],
      default: 'accepted',
    },
    joinedAt: { type: Date, default: Date.now },
  },
  {
    timestamps: true,
  },
);

// Un utilisateur ne peut rejoindre le même budget qu'une seule fois.
budgetParticipantSchema.index({ budgetId: 1, userId: 1 }, { unique: true });

const BudgetParticipant = mongoose.model<IBudgetParticipant>(
  'BudgetParticipant',
  budgetParticipantSchema,
);

export default BudgetParticipant;
