import mongoose, { Schema, Document } from 'mongoose';

export interface ISessionLog extends Document {
  userId: mongoose.Types.ObjectId;
  deviceId?: string;
  platform: 'android' | 'ios' | 'web';
  appVersion?: string;
  startTime: Date;
  endTime?: Date;
  durationSeconds?: number;
  ip?: string;
  isActive: boolean; // True if session is ongoing
}

const sessionLogSchema = new Schema<ISessionLog>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    deviceId: String,
    platform: {
      type: String,
      enum: ['android', 'ios', 'web'],
      default: 'android',
    },
    appVersion: String,
    startTime: {
      type: Date,
      default: Date.now,
      required: true,
    },
    endTime: Date,
    durationSeconds: Number,
    ip: String,
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  {
    timestamps: false,
  },
);

const SessionLog = mongoose.model<ISessionLog>('SessionLog', sessionLogSchema);

export default SessionLog;
