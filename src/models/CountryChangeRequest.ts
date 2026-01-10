import mongoose, { Schema, Document } from 'mongoose';
import { ICountryChangeRequest } from '../types/models';

export interface ICountryChangeRequestDocument extends ICountryChangeRequest, Document { }

const countryChangeRequestSchema = new Schema<ICountryChangeRequestDocument>(
    {
        userId: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        requestedCountryCode: {
            type: String,
            required: true,
            uppercase: true,
        },
        status: {
            type: String,
            enum: ['pending', 'approved', 'rejected'],
            default: 'pending',
        },
        rejectionReason: String,
        adminId: {
            type: Schema.Types.ObjectId,
            ref: 'User',
        },
        processedAt: Date,
    },
    {
        timestamps: true,
    },
);

const CountryChangeRequest = mongoose.model<ICountryChangeRequestDocument>(
    'CountryChangeRequest',
    countryChangeRequestSchema,
);

export default CountryChangeRequest;
