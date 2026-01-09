import mongoose, { Schema, Document } from 'mongoose';

export interface ISupportTicketResponse {
    sender: 'user' | 'admin';
    message: string;
    date: Date;
}

export interface ISupportTicket extends Document {
    userId: mongoose.Types.ObjectId;
    subject: string;
    message: string;
    category: 'bug' | 'payment' | 'account' | 'other';
    status: 'open' | 'in_progress' | 'closed';
    responses: ISupportTicketResponse[];
    createdAt: Date;
    updatedAt: Date;
}

const supportTicketSchema = new Schema<ISupportTicket>(
    {
        userId: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        subject: {
            type: String,
            required: true,
            trim: true,
        },
        message: {
            type: String,
            required: true,
        },
        category: {
            type: String,
            enum: ['bug', 'payment', 'account', 'other'],
            default: 'other',
        },
        status: {
            type: String,
            enum: ['open', 'in_progress', 'closed'],
            default: 'open',
        },
        responses: [
            {
                sender: { type: String, enum: ['user', 'admin'], required: true },
                message: { type: String, required: true },
                date: { type: Date, default: Date.now },
            },
        ],
    },
    {
        timestamps: true,
    }
);

const SupportTicket = mongoose.model<ISupportTicket>('SupportTicket', supportTicketSchema);

export default SupportTicket;
