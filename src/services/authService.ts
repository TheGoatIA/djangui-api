import jwt from 'jsonwebtoken';
import User, { IUserDocument } from '../models/User';
import { AppError } from '../middleware/errorHandler';
import logger from '../utils/logger';

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
}
