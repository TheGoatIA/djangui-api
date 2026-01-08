import jwt from 'jsonwebtoken';
import User, { IUserDocument } from '../models/User';
import { AppError } from '../middleware/errorHandler';
import logger from '../utils/logger';
import admin from '../config/firebase';
import crypto from 'crypto';
import { EmailService } from './emailService';
import { SlackService } from './slackService';

const signToken = (id: string, secret: string, expiresIn: any) => {
  return jwt.sign({ id }, secret, {
    expiresIn,
  });
};

export const createSendToken = (user: IUserDocument) => {
  const accessToken = signToken(
    user._id.toString(),
    process.env.JWT_ACCESS_SECRET || 'super-secret',
    process.env.JWT_ACCESS_EXPIRATION || '15m',
  );

  const refreshToken = signToken(
    user._id.toString(),
    process.env.JWT_REFRESH_SECRET || 'super-secret-refresh',
    process.env.JWT_REFRESH_EXPIRATION || '7d',
  );

  return { accessToken, refreshToken };
};

export class AuthService {
  static async register(userData: any) {
    const existingUser = await User.findOne({ email: userData.email });
    if (existingUser) {
      throw new AppError('Email already in use', 409);
    }

    const newUser = await User.create(userData);

    // Generate verification token
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(verificationToken).digest('hex');

    newUser.emailVerificationToken = hashedToken;
    newUser.emailVerificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
    await (newUser as any).save({ validateBeforeSave: false });

    // Send verification email
    try {
      await EmailService.sendVerificationEmail(newUser.email, verificationToken);
    } catch (err) {
      logger.error('Failed to send verification email');
    }

    const tokens = createSendToken(newUser);

    // Store refresh token in user
    newUser.refreshToken = tokens.refreshToken;
    await (newUser as any).save({ validateBeforeSave: false });

    // Slack notification for new user
    await SlackService.sendNotification(
      `🚀 *Nouvel Utilisateur* ! \n*Nom*: ${newUser.firstName} ${newUser.lastName}\n*Email*: ${newUser.email}`,
    );

    return { user: newUser, tokens };
  }

  static async firebaseAuth(idToken: string) {
    try {
      // 1) Verify Firebase ID Token
      const decodedToken = await admin.auth().verifyIdToken(idToken);
      const { email, name, picture, uid, phone_number } = decodedToken;

      // 2) Check if user exists by firebaseUid first
      let user = await User.findOne({ firebaseUid: uid });

      if (!user && email) {
        // Try to find by email if UID fails (maybe first login with Google/Email for existing account)
        user = await User.findOne({ email });
      } else if (!user && phone_number) {
        // Try to find by phone if UID fails
        user = await User.findOne({ phone: phone_number });
      }

      if (!user) {
        // 3) Create user if not exists
        const nameParts = (name || '').split(' ');
        user = await User.create({
          email: email || `${uid}@phone.djangui.com`, // Placeholder for phone-only users
          phone: phone_number,
          firstName: nameParts[0] || 'User',
          lastName: nameParts.slice(1).join(' ') || 'Firebase',
          avatar: picture,
          firebaseUid: uid,
          isActive: true,
          isEmailVerified: !!email,
          isPhoneVerified: !!phone_number,
        });
        logger.info(`New user created via Firebase Auth: ${user.email || phone_number}`);

        // Slack notification for new user
        await SlackService.sendNotification(
          `🚀 *Nouvel Utilisateur (Firebase)* ! \n*Nom*: ${user.firstName} ${user.lastName}\n*Email*: ${user.email}\n*Tel*: ${user.phone || 'N/A'}`,
        );
      } else {
        // Update user info
        user.firebaseUid = uid;
        if (phone_number && !user.phone) {
          user.phone = phone_number;
          user.isPhoneVerified = true;
        }
        if (email && !user.email) {
          user.email = email;
          user.isEmailVerified = true;
        }
        await (user as any).save({ validateBeforeSave: false });
        logger.info(`User logged in via Firebase Auth: ${user.email || user.phone}`);
      }

      // 4) Generate backend tokens
      const tokens = createSendToken(user);

      // Update refresh token and last login
      user.refreshToken = tokens.refreshToken;
      user.lastLogin = new Date();
      await (user as any).save({ validateBeforeSave: false });

      return { user, tokens };
    } catch (error: any) {
      logger.error(`Error in Firebase Auth: ${error.message}`);
      throw new AppError('Invalid or expired Firebase token', 401);
    }
  }

  static async linkPhoneNumber(userId: string, idToken: string) {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const { phone_number, uid } = decodedToken;

    if (!phone_number) {
      throw new AppError('Token does not contain a phone number', 400);
    }

    const user = await User.findById(userId);
    if (!user) throw new AppError('User not found', 404);

    // Check if phone number is already used by another user
    const existingUserWithPhone = await User.findOne({ phone: phone_number, _id: { $ne: userId } });
    if (existingUserWithPhone) {
      throw new AppError('This phone number is already associated with another account', 409);
    }

    user.phone = phone_number;
    user.isPhoneVerified = true;
    // Optionally update firebaseUid if it was missing or different
    if (!user.firebaseUid) user.firebaseUid = uid;

    await (user as any).save({ validateBeforeSave: false });
    return user;
  }

  static async login(email: string, password: string, sessionData?: any) {
    // 1) Check if email and password exist
    if (!email || !password) {
      throw new AppError('Please provide email and password', 400);
    }

    // 2) Check if user exists && password is correct
    const user = await User.findOne({ email }).select('+password');
    if (!user || !(await user.comparePassword(password))) {
      throw new AppError('Incorrect email or password', 401);
    }

    // 3) Generate tokens
    const tokens = createSendToken(user);

    // 4) Manage sessions
    const session = {
      deviceId: sessionData?.deviceId,
      deviceInfo: sessionData?.deviceInfo,
      appVersion: sessionData?.appVersion,
      refreshToken: tokens.refreshToken,
      lastActive: new Date(),
      ipAddress: sessionData?.ipAddress,
    };

    if (sessionData?.deviceId) {
      // Update existing session for this device or add new
      const sessionIndex = user.sessions.findIndex((s) => s.deviceId === sessionData.deviceId);
      if (sessionIndex !== -1) {
        user.sessions[sessionIndex] = { ...user.sessions[sessionIndex], ...session };
      } else {
        user.sessions.push(session);
      }
    } else {
      user.sessions.push(session);
    }

    // Update legacy fields
    user.refreshToken = tokens.refreshToken;
    user.lastLogin = new Date();
    await (user as any).save({ validateBeforeSave: false });

    return { user, tokens };
  }

  static async refreshAccessToken(refreshToken: string) {
    if (!refreshToken) {
      throw new AppError('Refresh token is required', 400);
    }

    try {
      // 1) Verify refresh token
      const decoded = jwt.verify(
        refreshToken,
        process.env.JWT_REFRESH_SECRET || 'super-secret-refresh',
      ) as { id: string };

      // 2) Check if user still exists and HAS this session
      const user = await User.findById(decoded.id);
      if (!user) {
        throw new AppError('User no longer exists', 401);
      }

      const sessionIndex = user.sessions.findIndex((s) => s.refreshToken === refreshToken);
      if (sessionIndex === -1 && user.refreshToken !== refreshToken) {
        throw new AppError('Invalid or expired refresh token', 401);
      }

      // 3) Generate new tokens
      const tokens = createSendToken(user);

      // 4) Update session
      if (sessionIndex !== -1) {
        user.sessions[sessionIndex].refreshToken = tokens.refreshToken;
        user.sessions[sessionIndex].lastActive = new Date();
      }

      // Update legacy fields
      user.refreshToken = tokens.refreshToken;
      await (user as any).save({ validateBeforeSave: false });

      return tokens;
    } catch (err) {
      throw new AppError('Invalid or expired refresh token', 401);
    }
  }

  static async logout(userId: string) {
    const user = await User.findById(userId);
    if (user) {
      user.refreshToken = undefined;
      await (user as any).save({ validateBeforeSave: false });
    }
    return true;
  }

  static async addFCMToken(userId: string, fcmToken: string) {
    const user = await User.findById(userId);
    if (!user) throw new AppError('User not found', 404);

    if (!user.fcmTokens.includes(fcmToken)) {
      user.fcmTokens.push(fcmToken);
      await (user as any).save({ validateBeforeSave: false });
    }
    return true;
  }

  static async forgotPassword(email: string) {
    const user = await User.findOne({ email });
    if (!user) {
      throw new AppError('There is no user with this email address.', 404);
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');

    user.passwordResetToken = hashedToken;
    user.passwordResetExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    await (user as any).save({ validateBeforeSave: false });

    try {
      await EmailService.sendPasswordResetEmail(user.email, resetToken);
    } catch (err) {
      user.passwordResetToken = undefined;
      user.passwordResetExpires = undefined;
      await (user as any).save({ validateBeforeSave: false });
      throw new AppError('There was an error sending the email. Try again later!', 500);
    }
  }

  static async resetPassword(token: string, password: string) {
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    const user = await User.findOne({
      passwordResetToken: hashedToken,
      passwordResetExpires: { $gt: Date.now() },
    });

    if (!user) {
      throw new AppError('Token is invalid or has expired', 400);
    }

    user.password = password;
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save();

    const tokens = createSendToken(user);
    user.refreshToken = tokens.refreshToken;
    await (user as any).save({ validateBeforeSave: false });

    return { user, tokens };
  }

  static async verifyEmail(token: string) {
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    const user = await User.findOne({
      emailVerificationToken: hashedToken,
      emailVerificationExpires: { $gt: Date.now() },
    });

    if (!user) {
      throw new AppError('Token is invalid or has expired', 400);
    }

    user.isEmailVerified = true;
    user.emailVerificationToken = undefined;
    user.emailVerificationExpires = undefined;
    await (user as any).save({ validateBeforeSave: false });

    const tokens = createSendToken(user);
    return { user, tokens };
  }

  static async updateMe(userId: string, updateData: any) {
    const allowedFields = [
      'firstName',
      'lastName',
      'country',
      'currency',
      'language',
      'preferences',
      'phone',
      'monthlyIncome',
    ];

    const filteredUpdate: any = {};
    Object.keys(updateData).forEach((key) => {
      if (allowedFields.includes(key)) {
        filteredUpdate[key] = updateData[key];
      }
    });

    const user = await User.findByIdAndUpdate(userId, filteredUpdate, {
      new: true,
      runValidators: true,
    });

    if (!user) throw new AppError('User not found', 404);
    return user;
  }

  static async changePassword(userId: string, data: any) {
    const { currentPassword, newPassword } = data;
    if (!currentPassword || !newPassword) {
      throw new AppError('Please provide current and new password', 400);
    }

    const user = await User.findById(userId).select('+password');
    if (!user || !(await user.comparePassword(currentPassword))) {
      throw new AppError('Current password is incorrect', 401);
    }

    user.password = newPassword;
    await user.save();

    return true;
  }

  static async deleteAccount(userId: string) {
    const user = await User.findByIdAndDelete(userId);
    if (!user) throw new AppError('User not found', 404);

    // TODO: Cleanup other user data (transactions, goals, etc.) if needed
    return true;
  }

  static async getSessions(userId: string) {
    const user = await User.findById(userId).select('sessions');
    if (!user) throw new AppError('User not found', 404);
    return user.sessions || [];
  }

  static async updateDeviceInfo(userId: string, data: { deviceInfo: any; appVersion: string }) {
    const user = await User.findByIdAndUpdate(
      userId,
      {
        deviceInfo: data.deviceInfo,
        appVersion: data.appVersion,
      },
      { new: true, runValidators: true },
    );

    if (!user) throw new AppError('User not found', 404);
    return user;
  }
}
