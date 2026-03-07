import mongoose, { Schema, Document } from 'mongoose';

export interface IMigration extends Document {
  migrationId: string;
  runAt: Date;
}

const migrationSchema = new Schema<IMigration>({
  migrationId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  runAt: {
    type: Date,
    default: Date.now,
  },
});

const Migration = mongoose.model<IMigration>('Migration', migrationSchema);

export default Migration;
