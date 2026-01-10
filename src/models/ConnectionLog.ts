import mongoose, { Schema, Document } from 'mongoose';

export interface IConnectionLog extends Document {
  userId: mongoose.Types.ObjectId;
  ip: string;
  country?: string;
  city?: string;
  device?: string;
  timestamp: Date;
}

const connectionLogSchema = new Schema<IConnectionLog>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    ip: {
      type: String,
      required: true,
    },
    country: String,
    city: String,
    device: String,
    timestamp: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: false, // We use custom timestamp field or rely on _id generation time, but explicit timestamp is asked
  },
);

// Index for cleanup if needed or fast sorting
connectionLogSchema.index({ timestamp: -1 });

const ConnectionLog = mongoose.model<IConnectionLog>('ConnectionLog', connectionLogSchema);

export default ConnectionLog;
