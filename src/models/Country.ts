import mongoose, { Schema, Document } from 'mongoose';
import { ICountry } from '../types/models';

export interface ICountryDocument extends ICountry, Document {}

const countrySchema = new Schema<ICountryDocument>(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    currency: {
      type: String,
      required: true,
      uppercase: true,
    },
    currencySymbol: {
      type: String,
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  },
);

const Country = mongoose.model<ICountryDocument>('Country', countrySchema);

export default Country;
