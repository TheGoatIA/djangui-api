import mongoose, { Document, Schema } from 'mongoose';

export interface IAIUsage extends Document {
  userId?: mongoose.Types.ObjectId;
  modelName: string;
  context: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
  durationMs: number;
  status: 'success' | 'failure';
  errorMessage?: string;
  timestamp: Date;
}

const aiUsageSchema = new Schema<IAIUsage>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    modelName: { type: String, required: true },
    context: { type: String, required: true },
    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },
    cost: { type: Number, default: 0 },
    durationMs: { type: Number, default: 0 },
    status: { type: String, enum: ['success', 'failure'], default: 'success' },
    errorMessage: { type: String },
    timestamp: { type: Date, default: Date.now },
  },
  {
    timestamps: true,
  },
);

// Indexes for faster stats querying
aiUsageSchema.index({ timestamp: -1 });
aiUsageSchema.index({ userId: 1 });
aiUsageSchema.index({ modelName: 1 });

const AIUsage = mongoose.model<IAIUsage>('AIUsage', aiUsageSchema);

export default AIUsage;
