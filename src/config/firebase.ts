import * as admin from 'firebase-admin';
import logger from '../utils/logger';

const firebaseConfig = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
};

if (firebaseConfig.projectId && firebaseConfig.clientEmail && firebaseConfig.privateKey) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert(firebaseConfig),
    });
    logger.info('Firebase Admin initialized successfully');
  } catch (error: any) {
    logger.error(`Error initializing Firebase Admin: ${error.message}`);
  }
} else {
  logger.warn('Firebase credentials missing. Notifications will be logged instead of sent.');
}

export default admin;
