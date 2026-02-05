import mongoose from 'mongoose';
import dotenv from 'dotenv';
import FeatureFlag from '../src/models/FeatureFlag';
import redis from '../src/config/redis';

dotenv.config();

async function debug() {
    try {
        const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/kauri';
        await mongoose.connect(mongoUri);
        console.log('Connected to MongoDB');

        const count = await FeatureFlag.countDocuments();
        console.log(`Number of feature flags in DB: ${count}`);

        if (count > 0) {
            const flags = await FeatureFlag.find({}).limit(1);
            console.log('Sample flag:', JSON.stringify(flags[0], null, 2));
        }

        const cacheKey = 'config:features';
        const cached = await redis.get(cacheKey);
        console.log(`Cache content for ${cacheKey}:`, cached);

        // Optional: clear cache to be sure
        await redis.del(cacheKey);
        console.log('Cache cleared');

        process.exit(0);
    } catch (error) {
        console.error('Debug error:', error);
        process.exit(1);
    }
}

debug();
