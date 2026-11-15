import mongoose from 'mongoose';
import dotenv from 'dotenv';
import User from '../src/models/User';
import { hashToken } from '../src/utils/cryptoUtils';

dotenv.config();

// One-time migration: refreshToken and sessions[].refreshToken used to be stored
// in plaintext. authService now stores/compares a SHA-256 hash instead. Without
// this migration, every existing session would be silently invalidated on its
// next refresh (forced re-login for all active users). Safe to re-run: a value
// already hashed (64 hex chars, no ".") is left untouched.
const looksLikeRawJwt = (value?: string): value is string =>
  typeof value === 'string' && value.includes('.');

async function migrate() {
  try {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/kauri';
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');

    const users = await User.find({
      $or: [{ refreshToken: { $exists: true, $ne: null } }, { 'sessions.0': { $exists: true } }],
    });

    let usersUpdated = 0;
    let tokensHashed = 0;

    for (const user of users) {
      let changed = false;

      if (looksLikeRawJwt(user.refreshToken)) {
        user.refreshToken = hashToken(user.refreshToken);
        changed = true;
        tokensHashed++;
      }

      for (const session of user.sessions) {
        if (looksLikeRawJwt(session.refreshToken)) {
          session.refreshToken = hashToken(session.refreshToken);
          changed = true;
          tokensHashed++;
        }
      }

      if (changed) {
        await user.save({ validateBeforeSave: false });
        usersUpdated++;
      }
    }

    console.log(`Migration completed: ${usersUpdated} users updated, ${tokensHashed} tokens hashed.`);
    process.exit(0);
  } catch (error) {
    console.error('Error migrating refresh tokens:', error);
    process.exit(1);
  }
}

migrate();
