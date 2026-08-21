import mongoose from 'mongoose';
import dotenv from 'dotenv';
import User from '../src/models/User';

dotenv.config();

async function createAdmin() {
  try {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/kauri';
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');

    const adminEmail = process.env.ADMIN_EMAIL || 'admin@kauri.app';
    const adminPassword = process.env.ADMIN_PASSWORD || 'AdminPass123!';

    let admin = await User.findOne({ email: adminEmail });

    if (admin) {
      admin.role = 'admin';
      admin.password = adminPassword;
      admin.isEmailVerified = true;
      admin.isActive = true;
      await admin.save();
      console.log(`Admin user '${adminEmail}' updated successfully with role 'admin'.`);
    } else {
      await User.create({
        email: adminEmail,
        password: adminPassword,
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
    console.log(`Password : ${adminPassword}`);
    console.log(`Role     : admin`);
    console.log(`-----------------------------------`);

    process.exit(0);
  } catch (error) {
    console.error('Error creating admin user:', error);
    process.exit(1);
  }
}

createAdmin();
