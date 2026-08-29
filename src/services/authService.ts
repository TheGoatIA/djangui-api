import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import User, { IUserDocument } from '../models/User';
import { AppError } from '../middleware/errorHandler';
import logger from '../utils/logger';
import admin from '../config/firebase';
import crypto from 'crypto';
import { MonitoringService } from './monitoringService';
import { EmailService } from './emailService';
import { SlackService } from './slackService';
import { AuditService } from './auditService';
import Country from '../models/Country';
import redis from '../config/redis';
import { hashToken } from '../utils/cryptoUtils';
import {
  generateBase32Secret,
  generateOtpauthUrl,
  verifyTotp,
  generateBackupCodes,
} from '../utils/totp';

const signToken = (id: string, secret: string, expiresIn: any) => {
  return jwt.sign({ id }, secret, {
    expiresIn,
  });
};

// The 2FA challenge token is deliberately signed with a DIFFERENT key than
// real access tokens (derived from, but distinct from, JWT_ACCESS_SECRET) —
// it proves only "this user got the password right", not "this user is
// logged in". If it reused JWT_ACCESS_SECRET with the same {id} shape, the
// `protect` middleware (which just checks {id} against that secret) would
// accept it as a full session before TOTP was ever verified.
const getTotpChallengeSecret = () =>
  crypto
    .createHash('sha256')
    .update(`${process.env.JWT_ACCESS_SECRET}:totp-challenge`)
    .digest('hex');

const signTotpChallengeToken = (id: string) =>
  jwt.sign({ id, purpose: '2fa_challenge' }, getTotpChallengeSecret(), { expiresIn: '2m' });

export const createSendToken = (user: IUserDocument) => {
  const accessToken = signToken(
    user._id.toString(),
    process.env.JWT_ACCESS_SECRET!,
    process.env.JWT_ACCESS_EXPIRATION || '15m',
  );

  const refreshToken = signToken(
    user._id.toString(),
    process.env.JWT_REFRESH_SECRET!,
    process.env.JWT_REFRESH_EXPIRATION || '7d',
  );

  return { accessToken, refreshToken };
};

export class AuthService {
  private static readonly LOGIN_LOCKOUT_THRESHOLD = 10;
  private static readonly LOGIN_LOCKOUT_WINDOW_SECONDS = 15 * 60;

  static async register(userData: any) {
    const existingUser = await User.findOne({ email: userData.email });
    if (existingUser) {
      throw new AppError('Email already in use', 409);
    }

    // Find country to set correct currency
    const countryCode = (userData.country || 'CM').toUpperCase();
    const country = await Country.findOne({ code: countryCode, isActive: true });

    if (!country && userData.country) {
      throw new AppError("Ce pays n'est pas encore supporté.", 400);
    }

    // Generate verification token
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(verificationToken).digest('hex');

    // Whitelist explicitly: never spread the raw request body into `new User(...)`.
    // Fields like role/walletBalance/kycLevel/isEmailVerified are valid schema
    // paths — spreading an untrusted object would let a caller set them directly.
    const newUser = new User({
      email: userData.email,
      password: userData.password,
      firstName: userData.firstName,
      lastName: userData.lastName,
      phone: userData.phone,
      country: countryCode,
      currency: country ? country.currency : 'XAF',
      emailVerificationToken: hashedToken,
      emailVerificationExpires: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
    });

    const tokens = createSendToken(newUser);
    newUser.refreshToken = hashToken(tokens.refreshToken);

    await newUser.save({ validateBeforeSave: false });

    // Send verification email
    try {
      await EmailService.sendVerificationEmail(newUser.email, verificationToken);
    } catch (err) {
      logger.error('Failed to send verification email');
    }

    // Audit Log for registration
    AuditService.record({
      userId: newUser._id as any,
      action: 'REGISTER',
      resource: 'USER',
      resourceId: newUser._id.toString(),
      status: 'success',
      metadata: { email: newUser.email },
    });

    // Notify Slack
    SlackService.sendNotification(
      `👤 *New User Registered*\n*Email*: ${newUser.email}\n*Country*: ${newUser.country}\n*Currency*: ${newUser.currency}`,
    );

    const platform = userData.deviceInfo?.platform || 'unknown';
    MonitoringService.recordUserSignup('email', newUser.country);
    MonitoringService.recordAuthEvent('register', 'email', 'success', newUser.country, platform);

    return { user: newUser, tokens };
  }

  static async firebaseAuth(
    idToken: string,
    options: { country?: string; currency?: string; platform?: string } = {},
  ) {
    try {
      // 1) Verify Firebase ID Token
      const decodedToken = await admin.auth().verifyIdToken(idToken);
      const { email, name, picture, uid, phone_number } = decodedToken;

      // 2) Check if user exists by firebaseUid first
      let user = await User.findOne({ firebaseUid: uid });
      let isNewUser = false;

      const isEmailVerified = !!decodedToken.email_verified;

      if (!user && email && isEmailVerified) {
        // Try to find by email if UID fails (maybe first login with Google/Email for existing account)
        user = await User.findOne({ email });
      } else if (!user && phone_number) {
        // Try to find by phone if UID fails
        user = await User.findOne({ phone: phone_number });
      }

      if (!user) {
        // 3) Create user if not exists
        isNewUser = true;
        const nameParts = (name || '').split(' ');
        let countryCode = (options.country || 'CM').toUpperCase();
        let currencyCode = options.currency || 'XAF';

        // Validate country if provided
        if (options.country) {
          const countryDoc = await Country.findOne({
            code: countryCode,
            isActive: true,
          });
          if (countryDoc) {
            currencyCode = countryDoc.currency;
          } else {
            // Fallback to default if country invalid/inactive
            countryCode = 'CM';
            currencyCode = 'XAF';
          }
        }

        user = await User.create({
          email: email || `${uid}@phone.kauri-app.com`, // Placeholder for phone-only users
          phone: phone_number,
          firstName: nameParts[0] || 'User',
          lastName: nameParts.slice(1).join(' ') || 'Firebase',
          avatar: picture,
          firebaseUid: uid,
          isActive: true,
          isEmailVerified: !!email,
          isPhoneVerified: !!phone_number,
          country: countryCode,
          currency: currencyCode,
        });
        // Audit Log for new user creation
        AuditService.record({
          userId: user._id as any,
          action: 'REGISTER_FIREBASE',
          resource: 'USER',
          resourceId: user._id.toString(),
          status: 'success',
          metadata: { email: user.email, provider: 'firebase' },
        });
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
        logger.info(`User logged in via Firebase Auth: ${user._id}`);
      }

      // 4) Generate backend tokens
      const tokens = createSendToken(user);

      // Audit Log for login
      AuditService.record({
        userId: user._id as any,
        action: 'LOGIN_FIREBASE',
        resource: 'USER',
        status: 'success',
      });

      const platform = decodedToken.device_platform || options.platform || 'unknown';
      if (isNewUser) {
        MonitoringService.recordUserSignup('firebase', user.country);
        MonitoringService.recordAuthEvent(
          'register',
          'firebase',
          'success',
          user.country,
          platform,
        );
      } else {
        MonitoringService.recordAuthEvent('login', 'firebase', 'success', user.country, platform);
        MonitoringService.updateActiveSessions(platform, 1);
      }

      return { user, tokens, isNewUser };
    } catch (error: any) {
      MonitoringService.recordAuthFailure('firebase_invalid', options.country);
      MonitoringService.recordAuthEvent(
        'login',
        'firebase',
        'failure',
        options.country,
        options.platform,
      );
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

    // Per-account lockout, independent of source IP: authLimiter on the route
    // only throttles per-IP, so a distributed attacker spreading attempts across
    // many IPs could still brute-force one specific account's password. Fails
    // open on a Redis error (consistent with idempotency.ts) rather than
    // blocking every login on an infrastructure outage.
    const lockKey = `login_attempts:${email.toLowerCase()}`;
    try {
      const attempts = await redis.get(lockKey);
      if (attempts && parseInt(attempts, 10) >= AuthService.LOGIN_LOCKOUT_THRESHOLD) {
        throw new AppError(
          'Trop de tentatives échouées sur ce compte. Réessayez dans quelques minutes.',
          429,
        );
      }
    } catch (err: any) {
      if (err instanceof AppError) throw err;
      logger.error(`Login lockout check Redis error: ${err.message}`);
    }

    // 2) Check if user exists && password is correct with constant-time comparison (F17)
    const DUMMY_HASH = '$2b$12$CwTycUXWue0Thq9StjUM0uJ8kTeC3W7Kd9tf59WsdG6b/H2fBb0lu';
    const user = await User.findOne({ email }).select('+password +security.totpEnabled');
    const passwordOk = await bcrypt.compare(password, user?.password || DUMMY_HASH);

    if (!user || !passwordOk) {
      if (user) {
        // Alert by user ID, not email/PII — this alert may flow into Slack, which
        // isn't scoped as a store for user PII.
        SlackService.sendNotification(
          `🔐 *Security Alert: Failed Login*\n*User ID*: ${user._id}\n*Reason*: Incorrect password\n*Time*: ${new Date().toISOString()}`,
        );
      }
      MonitoringService.recordAuthFailure(
        user ? 'wrong_password' : 'user_not_found',
        user?.country,
      );
      (async () => {
        try {
          await redis
            .multi()
            .incr(lockKey)
            .expire(lockKey, AuthService.LOGIN_LOCKOUT_WINDOW_SECONDS)
            .exec();
        } catch (err: any) {
          logger.error(`Login lockout increment Redis error: ${err.message}`);
        }
      })();
      throw new AppError('Incorrect email or password', 401);
    }

    // Successful login clears the counter for this account.
    redis
      .del(lockKey)
      .catch((err: any) => logger.error(`Login lockout clear Redis error: ${err.message}`));

    // 2FA is opt-in and currently only ever surfaced to admin/support
    // accounts (via the admin dashboard's Settings page) — never forced on
    // regular consumer-app users, who share this same login endpoint.
    if ((user.role === 'admin' || user.role === 'support') && user.security?.totpEnabled) {
      return { requiresTotp: true, challengeToken: signTotpChallengeToken(user._id.toString()) };
    }

    return AuthService.completeLogin(user, sessionData);
  }

  /** Verifies a TOTP/backup code against a login challenge and finishes the login. */
  static async verifyTotpAndLogin(challengeToken: string, code: string, sessionData?: any) {
    if (!challengeToken || typeof code !== 'string' || !code) {
      throw new AppError('Code de vérification requis', 400);
    }

    let decoded: { id: string; purpose: string };
    try {
      decoded = jwt.verify(challengeToken, getTotpChallengeSecret(), {
        algorithms: ['HS256'],
      }) as { id: string; purpose: string };
    } catch {
      throw new AppError('Session de vérification expirée, veuillez vous reconnecter', 401);
    }
    if (decoded.purpose !== '2fa_challenge') {
      throw new AppError('Jeton de vérification invalide', 401);
    }

    const user = await User.findById(decoded.id).select(
      '+security.totpSecret +security.totpEnabled +security.backupCodeHashes',
    );
    if (!user || !user.security?.totpEnabled || !user.security.totpSecret) {
      throw new AppError("La double authentification n'est plus disponible pour ce compte", 400);
    }

    let usedBackupCode = false;
    if (!verifyTotp(user.security.totpSecret, code)) {
      const hashes = user.security.backupCodeHashes || [];
      let matchedIndex = -1;
      for (let i = 0; i < hashes.length; i++) {
        // eslint-disable-next-line no-await-in-loop
        if (await bcrypt.compare(code.toUpperCase(), hashes[i])) {
          matchedIndex = i;
          break;
        }
      }
      if (matchedIndex === -1) {
        AuditService.record({
          userId: user._id as any,
          action: 'LOGIN_2FA_FAILED',
          resource: 'USER',
          status: 'failure',
        });
        throw new AppError('Code de vérification invalide', 401);
      }
      usedBackupCode = true;
      user.security.backupCodeHashes.splice(matchedIndex, 1);
      await (user as any).save({ validateBeforeSave: false });
    }

    const result = await AuthService.completeLogin(user, sessionData);
    AuditService.record({
      userId: user._id as any,
      action: usedBackupCode ? 'LOGIN_2FA_BACKUP_CODE_USED' : 'LOGIN_2FA_SUCCESS',
      resource: 'USER',
      status: 'success',
    });
    return result;
  }

  static async setupTotp(userId: string) {
    const user = await User.findById(userId);
    if (!user) throw new AppError('Utilisateur non trouvé', 404);

    const secret = generateBase32Secret();
    user.security = { ...(user.security as any), totpTempSecret: secret };
    await (user as any).save({ validateBeforeSave: false });

    return { secret, otpauthUrl: generateOtpauthUrl(secret, user.email) };
  }

  static async enableTotp(userId: string, code: string) {
    const user = await User.findById(userId).select('+security.totpTempSecret');
    if (!user?.security?.totpTempSecret) {
      throw new AppError('Aucune configuration 2FA en cours — relancez la configuration.', 400);
    }
    if (!verifyTotp(user.security.totpTempSecret, code)) {
      throw new AppError('Code invalide', 400);
    }

    const backupCodes = generateBackupCodes();
    const backupCodeHashes = await Promise.all(backupCodes.map((c) => bcrypt.hash(c, 10)));

    user.security.totpSecret = user.security.totpTempSecret;
    user.security.totpTempSecret = undefined;
    user.security.totpEnabled = true;
    user.security.backupCodeHashes = backupCodeHashes;
    await (user as any).save({ validateBeforeSave: false });

    AuditService.record({
      userId: user._id as any,
      action: '2FA_ENABLED',
      resource: 'USER',
      status: 'success',
    });
    return { backupCodes };
  }

  static async disableTotp(userId: string, code: string) {
    if (typeof code !== 'string' || !code) {
      throw new AppError('Code de vérification requis', 400);
    }
    const user = await User.findById(userId).select(
      '+security.totpSecret +security.backupCodeHashes',
    );
    if (!user?.security?.totpEnabled) {
      throw new AppError("La double authentification n'est pas activée", 400);
    }

    let valid = user.security.totpSecret ? verifyTotp(user.security.totpSecret, code) : false;
    if (!valid) {
      for (const hash of user.security.backupCodeHashes || []) {
        // eslint-disable-next-line no-await-in-loop
        if (await bcrypt.compare(code.toUpperCase(), hash)) {
          valid = true;
          break;
        }
      }
    }
    if (!valid) throw new AppError('Code invalide', 400);

    user.security.totpEnabled = false;
    user.security.totpSecret = undefined;
    user.security.totpTempSecret = undefined;
    user.security.backupCodeHashes = [];
    await (user as any).save({ validateBeforeSave: false });

    AuditService.record({
      userId: user._id as any,
      action: '2FA_DISABLED',
      resource: 'USER',
      status: 'success',
    });
    return { success: true };
  }

  /** Shared tail of both plain-password login and post-2FA login: issues tokens, records the session, audits. */
  private static async completeLogin(user: IUserDocument, sessionData?: any) {
    // 3) Generate tokens
    const tokens = createSendToken(user);

    // 4) Manage sessions
    const session = {
      deviceId: sessionData?.deviceId,
      deviceInfo: sessionData?.deviceInfo,
      appVersion: sessionData?.appVersion,
      refreshToken: hashToken(tokens.refreshToken),
      lastActive: new Date(),
      createdAt: new Date(),
      ipAddress: sessionData?.ipAddress,
    };

    const MAX_ACTIVE_SESSIONS = 3;
    if (!user.sessions) {
      user.sessions = [];
    }

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

    // Sécurité Fintech : Limitation stricte à 3 sessions simultanées maximum
    if (user.sessions.length > MAX_ACTIVE_SESSIONS) {
      user.sessions.sort(
        (a, b) =>
          new Date(a.lastActive || a.createdAt).getTime() -
          new Date(b.lastActive || b.createdAt).getTime(),
      );
      while (user.sessions.length > MAX_ACTIVE_SESSIONS) {
        user.sessions.shift();
      }
    }

    // Update legacy fields
    user.lastLogin = new Date();
    await (user as any).save({ validateBeforeSave: false });

    // Audit Log for login
    AuditService.record({
      userId: user._id as any,
      action: 'LOGIN',
      resource: 'USER',
      status: 'success',
      metadata: { deviceId: sessionData?.deviceId },
    });

    const platform = sessionData?.deviceInfo?.platform || 'unknown';
    MonitoringService.recordAuthEvent('login', 'email', 'success', user.country, platform);
    MonitoringService.updateActiveSessions(platform, 1);

    return { user, tokens };
  }

  static async refreshAccessToken(refreshToken: string) {
    if (!refreshToken) {
      throw new AppError('Refresh token is required', 400);
    }

    try {
      // 1) Verify refresh token (algorithm pinned — see middleware/auth.ts for why)
      const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET!, {
        algorithms: ['HS256'],
      }) as { id: string };

      // 2) Check if user still exists and HAS this session
      const user = await User.findById(decoded.id);
      if (!user) {
        throw new AppError('User no longer exists', 401);
      }

      const incomingHash = hashToken(refreshToken);
      const sessionIndex = user.sessions.findIndex((s) => s.refreshToken === incomingHash);
      if (sessionIndex === -1 && user.refreshToken !== incomingHash) {
        throw new AppError('Invalid or expired refresh token', 401);
      }

      // 3) Generate new tokens
      const tokens = createSendToken(user);

      // 4) Update session
      if (sessionIndex !== -1) {
        user.sessions[sessionIndex].refreshToken = hashToken(tokens.refreshToken);
        user.sessions[sessionIndex].lastActive = new Date();
      }

      // Update legacy fields
      user.refreshToken = hashToken(tokens.refreshToken);
      await (user as any).save({ validateBeforeSave: false });

      MonitoringService.recordAuthEvent('refresh', 'jwt', 'success', user.country);

      return tokens;
    } catch (err) {
      MonitoringService.recordAuthFailure('refresh_invalid', 'unknown');
      MonitoringService.recordAuthEvent('refresh', 'jwt', 'failure', 'unknown');
      throw new AppError('Invalid or expired refresh token', 401);
    }
  }

  static async logout(userId: string, refreshToken?: string, accessToken?: string) {
    const user = await User.findById(userId);
    if (user) {
      const incomingHash = refreshToken ? hashToken(refreshToken) : undefined;
      // Find the session to record duration
      const sessionIndex = incomingHash
        ? user.sessions.findIndex((s) => s.refreshToken === incomingHash)
        : -1;

      if (sessionIndex !== -1) {
        const session = user.sessions[sessionIndex];
        const platform = session.deviceInfo?.platform || 'unknown';
        const duration = (Date.now() - session.createdAt.getTime()) / 1000;

        MonitoringService.recordSessionDuration(duration);
        MonitoringService.updateActiveSessions(platform, -1);
        MonitoringService.recordAuthEvent('logout', 'jwt', 'success', user.country, platform);

        // Remove this session
        user.sessions.splice(sessionIndex, 1);
      } else {
        // Fallback for legacy logout
        MonitoringService.recordAuthEvent('logout', 'jwt', 'success', user.country, 'unknown');
        if (incomingHash && user.refreshToken === incomingHash) user.refreshToken = undefined;
      }

      await (user as any).save({ validateBeforeSave: false });

      AuditService.record({
        userId: user._id as any,
        action: 'LOGOUT',
        resource: 'USER',
        status: 'success',
      });

      MonitoringService.recordAuthEvent('logout', 'jwt', 'success', user.country);
    }

    // Blacklist the access token in Redis so it cannot be reused before its natural expiry.
    // TTL is set to the token's remaining validity window.
    if (accessToken) {
      try {
        const decoded = jwt.decode(accessToken) as { exp?: number } | null;
        if (decoded?.exp) {
          const ttlSeconds = decoded.exp - Math.floor(Date.now() / 1000);
          if (ttlSeconds > 0) {
            await redis.setex(`blacklist:${accessToken}`, ttlSeconds, '1');
          }
        }
      } catch {
        // Non-fatal — the token will expire naturally via its own exp claim
        logger.warn('Could not blacklist access token on logout');
      }
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

    // Return silently if user not found to prevent user enumeration.
    // The response is identical whether the email exists or not.
    if (!user) {
      MonitoringService.recordAuthEvent('forgot_password', 'email', 'not_found', 'unknown');
      return;
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');

    user.passwordResetToken = hashedToken;
    user.passwordResetExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    MonitoringService.recordAuthEvent('forgot_password', 'email', 'success', user.country);

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

    MonitoringService.recordAuthEvent('reset_password', 'email', 'success', user.country);

    await user.save();

    const tokens = createSendToken(user);
    user.refreshToken = hashToken(tokens.refreshToken);
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

    MonitoringService.recordAuthEvent('verify_email', 'email', 'success', user.country);

    const tokens = createSendToken(user);
    return { user, tokens };
  }

  /**
   * Renvoyer l'email de vérification.
   */
  static async resendVerificationEmail(email: string) {
    if (!email) throw new AppError('Email requis', 400);

    const user = await User.findOne({ email });
    if (!user) throw new AppError('Utilisateur non trouvé', 404);
    if (user.isEmailVerified) throw new AppError('Ce compte est déjà vérifié', 400);

    const verificationToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(verificationToken).digest('hex');

    user.emailVerificationToken = hashedToken;
    user.emailVerificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await (user as any).save({ validateBeforeSave: false });

    try {
      await EmailService.sendVerificationEmail(user.email, verificationToken);
      MonitoringService.recordAuthEvent('resend_verification', 'email', 'success', user.country);
    } catch (err) {
      user.emailVerificationToken = undefined;
      user.emailVerificationExpires = undefined;
      await (user as any).save({ validateBeforeSave: false });
      throw new AppError("Erreur lors de l'envoi de l'email", 500);
    }
  }

  static async updateMe(userId: string, updateData: any) {
    const user = await User.findById(userId);
    if (!user) throw new AppError('User not found', 404);

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

    if (updateData.firstName) user.firstName = updateData.firstName;
    if (updateData.lastName) user.lastName = updateData.lastName;
    if (updateData.country) user.country = updateData.country;
    if (updateData.currency) user.currency = updateData.currency;
    if (updateData.language) user.language = updateData.language;
    if (updateData.phone) user.phone = updateData.phone;
    if (updateData.monthlyIncome !== undefined) user.monthlyIncome = updateData.monthlyIncome;

    if (updateData.preferences) {
      // Get current values or defaults
      const currentPrefs = user.preferences || {
        coachTone: 'balanced',
        notificationFrequency: 'medium',
        budgetAlertThreshold: 80,
      };

      // Merge only provided values
      const newPrefs = {
        coachTone: updateData.preferences.coachTone || currentPrefs.coachTone || 'balanced',
        notificationFrequency:
          updateData.preferences.notificationFrequency ||
          currentPrefs.notificationFrequency ||
          'medium',
        budgetAlertThreshold:
          updateData.preferences.budgetAlertThreshold !== undefined
            ? updateData.preferences.budgetAlertThreshold
            : currentPrefs.budgetAlertThreshold !== undefined
              ? currentPrefs.budgetAlertThreshold
              : 80,
      };

      user.preferences = newPrefs;
      user.markModified('preferences');
    }

    await user.save({ validateBeforeSave: false });
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

    MonitoringService.recordSensitiveAction('password_change', 'success');

    return true;
  }

  static async deleteAccount(userId: string) {
    const user = await User.findById(userId);
    if (!user) throw new AppError('User not found', 404);

    // Prevent deletion if user has a positive wallet balance
    if (user.walletBalance > 0) {
      throw new AppError(
        "Impossible de supprimer un compte avec un solde positif. Veuillez d'abord retirer vos fonds.",
        400,
      );
    }

    // Cascade delete user data (RGPD right to erasure) while preserving AML financial records (F10, F20)
    const { default: Transaction } = await import('../models/Transaction');
    const { default: Payment } = await import('../models/Payment');
    const { default: TontineMember } = await import('../models/TontineMember');
    const { default: SharedSlot } = await import('../models/SharedSlot');
    const { default: SharedMasterAccount } = await import('../models/SharedMasterAccount');
    const { default: Subscription } = await import('../models/Subscription');
    const { default: Invoice } = await import('../models/Invoice');
    const { default: SupportTicket } = await import('../models/SupportTicket');

    await Promise.all([
      // Transactions manuelles supprimées, transactions financières réelles anonymisées
      Transaction.deleteMany({ userId, paymentMethod: 'cash' }),
      Transaction.updateMany(
        { userId },
        { $set: { userId: null, description: 'Anonymized User Transaction' } },
      ),
      // Rétention AML légale de 5 ans : Payment anonymisé (détachement de userId et PII)
      Payment.updateMany({ userId }, { $set: { userId: null, 'metadata.anonymized': true } }),
      // Nettoyage des collections associées (droit à l'oubli complet)
      TontineMember.deleteMany({ userId }),
      SharedSlot.deleteMany({ resellerId: userId }),
      SharedMasterAccount.deleteMany({ resellerId: userId }),
      Subscription.deleteMany({ userId }),
      Invoice.deleteMany({ userId }),
      SupportTicket.deleteMany({ userId }),
      User.findByIdAndDelete(userId),
    ]);

    MonitoringService.recordSensitiveAction('account_delete', 'success');
    return true;
  }

  static async getSessions(userId: string) {
    const user = await User.findById(userId).select('sessions');
    if (!user) throw new AppError('User not found', 404);
    // The client's SessionModel reads flat `deviceName`/`os` fields — the
    // stored shape is nested under `deviceInfo` (see the `sessions` schema),
    // so it must be flattened here rather than returned as-is, which
    // previously left every session showing as "Unknown Device"/"Unknown OS"
    // even when deviceInfo was actually populated.
    return (user.sessions || []).map((s: any) => ({
      _id: s._id,
      deviceName: s.deviceInfo?.model || null,
      os: s.deviceInfo?.os
        ? `${s.deviceInfo.os}${s.deviceInfo.osVersion ? ' ' + s.deviceInfo.osVersion : ''}`
        : null,
      ipAddress: s.ipAddress || null,
      lastActive: s.lastActive,
    }));
  }

  static async revokeSession(userId: string, sessionId: string) {
    const user = await User.findById(userId);
    if (!user) throw new AppError('User not found', 404);

    const sessionIndex = user.sessions.findIndex((s: any) => s._id.toString() === sessionId);
    if (sessionIndex !== -1) {
      user.sessions.splice(sessionIndex, 1);
      await (user as any).save({ validateBeforeSave: false });

      AuditService.record({
        userId: user._id as any,
        action: 'REVOKE_SESSION',
        resource: 'SESSION',
        resourceId: sessionId,
        status: 'success',
      });
    }
    return true;
  }

  static async revokeAllSessions(userId: string) {
    const user = await User.findById(userId);
    if (!user) throw new AppError('User not found', 404);

    user.sessions = [];
    user.refreshToken = undefined;
    await (user as any).save({ validateBeforeSave: false });

    AuditService.record({
      userId: user._id as any,
      action: 'REVOKE_ALL_SESSIONS',
      resource: 'USER',
      status: 'success',
    });

    return true;
  }

  static async updateDeviceInfo(
    userId: string,
    data: { deviceInfo: any; appVersion: string; deviceId?: string },
  ) {
    const user = await User.findByIdAndUpdate(
      userId,
      {
        // Legacy top-level fields — kept for compatibility with anything
        // still reading them, but GET /auth/sessions never did: it reads the
        // `sessions[]` subdocuments below, which this call previously never
        // touched, leaving every session's deviceInfo permanently empty.
        deviceInfo: data.deviceInfo,
        appVersion: data.appVersion,
      },
      { new: true, runValidators: true },
    );

    if (!user) throw new AppError('User not found', 404);

    if (user.sessions && user.sessions.length > 0) {
      // Prefer an exact deviceId match (set at login for the password flow);
      // social/phone/biometric-refresh logins don't send one yet, so fall
      // back to the most recently created session — this call always fires
      // right after a fresh login (see AuthBloc), so at that moment the
      // newest session is reliably this device's.
      let target = data.deviceId
        ? user.sessions.find((s: any) => s.deviceId === data.deviceId)
        : undefined;
      if (!target) {
        target = [...user.sessions].sort(
          (a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        )[0];
      }
      if (target) {
        (target as any).deviceInfo = data.deviceInfo;
        (target as any).appVersion = data.appVersion;
        if (data.deviceId) (target as any).deviceId = data.deviceId;
        await (user as any).save({ validateBeforeSave: false });
      }
    }

    return user;
  }
}
