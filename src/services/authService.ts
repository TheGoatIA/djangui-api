import jwt from 'jsonwebtoken';
import User, { IUserDocument } from '../models/User';
import { AppError } from '../middleware/errorHandler';
import logger from '../utils/logger';
import admin from '../config/firebase';

const signToken = (id: string, secret: string, expiresIn: any) => {
    return jwt.sign({ id }, secret, {
        expiresIn,
    });
};

export const createSendToken = (user: IUserDocument) => {
    const accessToken = signToken(
        user._id.toString(),
        process.env.JWT_SECRET || 'super-secret',
        process.env.JWT_ACCESS_EXPIRATION || '15m'
    );

    const refreshToken = signToken(
        user._id.toString(),
        process.env.JWT_SECRET || 'super-secret-refresh',
        process.env.JWT_REFRESH_EXPIRATION || '7d'
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
        const tokens = createSendToken(newUser);

        // Store refresh token in user
        newUser.refreshToken = tokens.refreshToken;
        await (newUser as any).save({ validateBeforeSave: false });

        return { user: newUser, tokens };
    }

    static async googleAuth(idToken: string) {
        try {
            // 1) Verify Firebase ID Token
            const decodedToken = await admin.auth().verifyIdToken(idToken);
            const { email, name, picture, uid } = decodedToken;

            if (!email) {
                throw new AppError('Google account must have an email', 400);
            }

            // 2) Check if user exists
            let user = await User.findOne({ email });

            if (!user) {
                // 3) Create user if not exists
                const nameParts = (name || '').split(' ');
                user = await User.create({
                    email,
                    firstName: nameParts[0] || 'User',
                    lastName: nameParts.slice(1).join(' ') || 'Google',
                    avatar: picture,
                    firebaseUid: uid,
                    isActive: true,
                });
                logger.info(`New user created via Google Auth: ${email}`);
            } else {
                // Update Firebase UID if missing
                if (!user.firebaseUid) {
                    user.firebaseUid = uid;
                    await (user as any).save({ validateBeforeSave: false });
                }
                logger.info(`Existing user logged in via Google Auth: ${email}`);
            }

            // 4) Generate backend tokens
            const tokens = createSendToken(user);

            // Update refresh token and last login
            user.refreshToken = tokens.refreshToken;
            user.lastLogin = new Date();
            await (user as any).save({ validateBeforeSave: false });

            return { user, tokens };
        } catch (error: any) {
            logger.error(`Error in Google Auth: ${error.message}`);
            throw new AppError('Invalid or expired Google token', 401);
        }
    }

    static async login(email: string, password: string) {
        // 1) Check if email and password exist
        if (!email || !password) {
            throw new AppError('Please provide email and password', 400);
        }

        // 2) Check if user exists && password is correct
        const user = await User.findOne({ email }).select('+password');
        if (!user || !(await user.comparePassword(password))) {
            throw new AppError('Incorrect email or password', 401);
        }

        // 3) If everything ok, send token to client
        const tokens = createSendToken(user);

        // Update refresh token and last login
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
                process.env.JWT_SECRET || 'super-secret-refresh'
            ) as { id: string };

            // 2) Check if user still exists
            const user = await User.findById(decoded.id);
            if (!user || user.refreshToken !== refreshToken) {
                throw new AppError('Invalid or expired refresh token', 401);
            }

            // 3) Generate new tokens
            const tokens = createSendToken(user);

            // Update refresh token
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
}
