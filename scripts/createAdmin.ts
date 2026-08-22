import mongoose from 'mongoose';
import dotenv from 'dotenv';
import crypto from 'node:crypto';
import User from '../src/models/User';

dotenv.config();

async function createAdmin() {
  try {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/kauri';
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');

    const adminEmail = process.env.ADMIN_EMAIL || 'admin@kauri.app';
    const resetPassword = process.argv.includes('--reset-password');

    const admin = await User.findOne({ email: adminEmail });
    let generatedPassword: string | null = null;

    if (admin) {
      admin.role = 'admin';
      admin.isEmailVerified = true;
      admin.isActive = true;

      // Never silently overwrite an existing admin's password on a routine
      // re-run — a previously rotated strong password must not be reset to a
      // guessable/default value just because this script ran without env vars.
      if (resetPassword) {
        if (!process.env.ADMIN_PASSWORD) {
          console.error(
            'Error: --reset-password requires ADMIN_PASSWORD to be set in the environment.',
          );
          process.exit(1);
        }
        admin.password = process.env.ADMIN_PASSWORD;
      }

      await admin.save();
      console.log(`Admin user '${adminEmail}' updated successfully with role 'admin'.`);
      if (resetPassword) console.log('Password was reset to the provided ADMIN_PASSWORD.');
    } else {
      // No hardcoded fallback password: use the provided one, or generate a
      // random strong one so a script run without ADMIN_PASSWORD set (e.g. by
      // accident in prod) never creates an admin with a guessable credential.
      const password =
        process.env.ADMIN_PASSWORD ||
        (generatedPassword = crypto.randomBytes(18).toString('base64url'));

      await User.create({
        email: adminEmail,
        password,
        firstName: 'System',
        lastName: 'Admin',
        role: 'admin',
        isEmailVerified: true,
        isActive: true,
        country: 'CM',
        currency: 'XAF',
      });
      console.log(`Admin user '${adminEmail}' created successfully!`);
    }

    console.log(`-----------------------------------`);
    console.log(`Email    : ${adminEmail}`);
    if (generatedPassword) {
      console.log(`Password : ${generatedPassword}  (generated — save it now, shown only once)`);
    } else if (resetPassword) {
      console.log(`Password : reset to the value of ADMIN_PASSWORD`);
    } else {
      console.log(`Password : unchanged`);
    }
    console.log(`Role     : admin`);
    console.log(`-----------------------------------`);

    process.exit(0);
  } catch (error) {
    console.error('Error creating admin user:', error);
    process.exit(1);
  }
}

createAdmin();
