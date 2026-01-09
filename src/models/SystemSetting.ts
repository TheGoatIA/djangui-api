import mongoose, { Schema, Document } from 'mongoose';

export interface ISystemSetting extends Document {
  key: string;
  value: any;
  group: 'general' | 'maintenance' | 'payment' | 'app_version' | 'legal' | 'app_info' | 'mobile';
  description?: string;
  isPublic: boolean; // Accessible by non-admins? (e.g. min version)
  updatedAt: Date;
}

const systemSettingSchema = new Schema<ISystemSetting>(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    value: {
      type: Schema.Types.Mixed,
      required: true,
    },
    group: {
      type: String,
      enum: ['general', 'maintenance', 'payment', 'app_version', 'legal', 'app_info', 'mobile'], // Enhanced groups
      default: 'general',
    },
    description: String,
    isPublic: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  },
);

const SystemSetting = mongoose.model<ISystemSetting>('SystemSetting', systemSettingSchema);

export default SystemSetting;
