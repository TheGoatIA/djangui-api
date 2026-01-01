import { GoogleGenerativeAI } from '@google/generative-ai';
import logger from '../utils/logger';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

export const model = genAI.getGenerativeModel({
    model: 'gemini-2.0-flash',
    generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 2048,
    },
});

logger.info('Gemini AI initialized with gemini-2.0-flash');
