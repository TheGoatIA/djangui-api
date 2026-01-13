import mongoose, { Schema, Document } from 'mongoose';

export interface ITontineMessage extends Document {
    tontineId: mongoose.Schema.Types.ObjectId;
    senderId: mongoose.Schema.Types.ObjectId;
    content: string;
    type: 'text' | 'image' | 'system';
    createdAt: Date;
}

const TontineMessageSchema: Schema = new Schema({
    tontineId: { type: Schema.Types.ObjectId, ref: 'Tontine', required: true },
    senderId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    content: { type: String, required: true },
    type: { type: String, enum: ['text', 'image', 'system'], default: 'text' },
    createdAt: { type: Date, default: Date.now }
});

// Index pour recherche rapide par tontine et date
TontineMessageSchema.index({ tontineId: 1, createdAt: -1 });

export default mongoose.model<ITontineMessage>('TontineMessage', TontineMessageSchema);
