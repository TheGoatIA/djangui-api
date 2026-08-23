import mongoose, { Schema, Document } from 'mongoose';
import { ISharedMasterAccount } from '../types/models';

export interface ISharedMasterAccountDocument extends ISharedMasterAccount, Document {}

const sharedMasterAccountSchema = new Schema<ISharedMasterAccountDocument>(
  {
    resellerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Le revendeur est requis'],
      index: true,
    },
    serviceName: {
      type: String,
      required: [true, 'Le nom du service est requis'],
      trim: true,
    },
    servicePreset: {
      type: String,
      trim: true,
    },
    category: {
      type: String,
      enum: [
        'video',
        'music',
        'productivity',
        'ai',
        'gaming',
        'vpn',
        'design',
        'education',
        'other',
      ],
      default: 'video',
    },
    iconUrl: {
      type: String,
      trim: true,
    },
    brandColor: {
      type: String,
      trim: true,
      default: '#059669',
    },
    billingCost: {
      type: Number,
      required: [true, 'Le coût de facturation est requis'],
      min: [0, 'Le coût ne peut pas être négatif'],
    },
    billingCurrency: {
      type: String,
      required: [true, 'La devise est requise'],
      default: 'XAF',
    },
    billingFrequency: {
      type: String,
      enum: ['monthly', 'quarterly', 'yearly'],
      default: 'monthly',
    },
    nextRenewalDate: {
      type: Date,
      required: [true, 'La date de renouvellement est requise'],
      index: true,
    },
    maxSlots: {
      type: Number,
      required: [true, 'Le nombre maximum de slots est requis'],
      min: [1, 'Le compte doit comporter au moins 1 slot'],
      default: 4,
    },
    vault: {
      encryptedEmail: String,
      encryptedPassword: String,
      encryptedPin: String,
      recoveryContact: String,
      encryptedNotes: String,
      iv: String,
      authTag: String,
    },
    status: {
      type: String,
      enum: ['active', 'expired', 'suspended'],
      default: 'active',
      index: true,
    },
    notes: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
  },
);

sharedMasterAccountSchema.index({ resellerId: 1, status: 1 });
sharedMasterAccountSchema.index({ resellerId: 1, nextRenewalDate: 1 });

const SharedMasterAccount = mongoose.model<ISharedMasterAccountDocument>(
  'SharedMasterAccount',
  sharedMasterAccountSchema,
);

export default SharedMasterAccount;
