import { GoogleGenerativeAI } from '@google/generative-ai';
import logger from '../utils/logger';

export const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

/*
// Deprecated: Model is now fetched dynamically from SystemSettings via GeminiService
export const model = genAI.getGenerativeModel({
  model: 'gemini-2.5-flash',
  generationConfig: {
    temperature: 0.7,
    maxOutputTokens: 2048,
  },
});
*/

logger.info('Gemini AI initialized (Model will be fetched dynamically)');
