import mongoose, { Schema, Document } from 'mongoose';
import { ISharedSlot } from '../types/models';

export interface ISharedSlotDocument extends ISharedSlot, Document {}

const sharedSlotSchema = new Schema<ISharedSlotDocument>(
  {
    masterAccountId: {
      type: Schema.Types.ObjectId,
      ref: 'SharedMasterAccount',
      required: [true, 'Le compte maître est requis'],
      index: true,
    },
    resellerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Le revendeur est requis'],
      index: true,
    },
    profileName: {
      type: String,
      required: [true, 'Le nom du profil/slot est requis'],
      trim: true,
    },
    encryptedPin: String,
    pinIv: String,
    pinAuthTag: String,
    client: {
      fullName: {
        type: String,
        required: [true, 'Le nom du client est requis'],
        trim: true,
      },
      phone: {
        type: String,
        required: [true, 'Le numéro de téléphone du client est requis'],
        trim: true,
      },
      email: {
        type: String,
        lowercase: true,
        trim: true,
      },
      whatsappNumber: {
        type: String,
        trim: true,
      },
      preferredReminderChannel: {
        type: String,
        enum: ['whatsapp', 'push', 'email'],
        default: 'whatsapp',
      },
      notes: {
        type: String,
        trim: true,
      },
    },
    price: {
      type: Number,
      required: [true, 'Le prix du slot est requis'],
      min: [0, 'Le prix ne peut pas être négatif'],
    },
    currency: {
      type: String,
      required: [true, 'La devise est requise'],
      default: 'XAF',
    },
    billingCycle: {
      type: String,
      enum: ['monthly', 'quarterly', 'yearly'],
      default: 'monthly',
    },
    startDate: {
      type: Date,
      default: Date.now,
    },
    currentPeriodStart: {
      type: Date,
      required: [true, 'Le début de la période courante est requis'],
      default: Date.now,
    },
    currentPeriodEnd: {
      type: Date,
      required: [true, "L'échéance du client est requise"],
      index: true,
    },
    gracePeriodDays: {
      type: Number,
      default: 2,
      min: 0,
    },
    autoSendReminders: {
      type: Boolean,
      default: true,
    },
    lastReminderSentAt: Date,
    lastReminderType: {
      type: String,
      enum: ['J-3', 'J-0', 'OVERDUE'],
    },
    status: {
      type: String,
      enum: ['active', 'due_soon', 'overdue', 'blocked', 'vacant'],
      default: 'active',
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

sharedSlotSchema.index({ resellerId: 1, status: 1 });
sharedSlotSchema.index({ resellerId: 1, currentPeriodEnd: 1 });
sharedSlotSchema.index({ masterAccountId: 1, status: 1 });

const SharedSlot = mongoose.model<ISharedSlotDocument>('SharedSlot', sharedSlotSchema);

export default SharedSlot;
