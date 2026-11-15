import mongoose, { Schema, Document } from 'mongoose';

export interface IGoalParticipant extends Document {
  goalId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  displayName: string;
  invitationStatus: 'pending' | 'accepted' | 'declined' | 'removed';
  joinedAt: Date;
}

const goalParticipantSchema = new Schema<IGoalParticipant>(
  {
    goalId: { type: Schema.Types.ObjectId, ref: 'SavingGoal', required: true, index: true },
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

// Un utilisateur ne peut rejoindre le même objectif qu'une seule fois.
goalParticipantSchema.index({ goalId: 1, userId: 1 }, { unique: true });

const GoalParticipant = mongoose.model<IGoalParticipant>('GoalParticipant', goalParticipantSchema);

export default GoalParticipant;
