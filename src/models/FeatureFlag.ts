import mongoose, { Schema, Document } from 'mongoose';

export interface IFeatureFlag extends Document {
    name: string;
    slug: string;
    isEnabled: boolean;
    description?: string;
    minAppVersion?: string;
    updatedAt: Date;
    createdAt: Date;
}

const featureFlagSchema = new Schema<IFeatureFlag>(
    {
        name: {
            type: String,
            required: true,
            trim: true,
        },
        slug: {
            type: String,
            required: true,
            unique: true,
            trim: true,
            lowercase: true,
        },
        isEnabled: {
            type: Boolean,
            default: false,
        },
        description: {
            type: String,
            trim: true,
        },
        minAppVersion: {
            type: String,
            trim: true,
        },
    },
    {
        timestamps: true,
    }
);

const FeatureFlag = mongoose.model<IFeatureFlag>('FeatureFlag', featureFlagSchema);

export default FeatureFlag;
