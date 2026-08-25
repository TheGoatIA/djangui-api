import { genAI } from '../../config/gemini';
import { GeminiService } from './geminiService';
import { StorageService } from '../storageService';
import { AppError } from '../../middleware/errorHandler';
import redis from '../../config/redis';
import logger from '../../utils/logger';
import User from '../../models/User';

// Curated presets rather than a raw free-text prompt: keeps quality/output
// consistent, avoids exposing full prompt control (moderation risk) while
// still letting the user personalize via the `refinement` free-text add-on.
const STYLE_PROMPTS: Record<string, string> = {
  professional:
    'Portrait professionnel de type photo corporate pour photo de profil, éclairage studio doux, fond neutre uni, expression confiante et avenante, cadrage buste, rendu photoréaliste haute qualité.',
  illustrated:
    'Avatar en illustration numérique moderne pour photo de profil, style flat design épuré, couleurs vives et harmonieuses, contours nets, composition centrée sur le visage.',
  cyberpunk:
    'Portrait futuriste style cyberpunk pour photo de profil, éclairage néon violet et cyan, ambiance urbaine nocturne high-tech, détails futuristes, cadrage buste.',
  minimalist:
    'Avatar minimaliste et épuré pour photo de profil, formes géométriques simples, palette de couleurs limitée à deux ou trois teintes, style vectoriel moderne, fond uni.',
  fantasy:
    'Portrait style fantaisie héroïque pour photo de profil, ambiance épique et lumineuse, détails soignés, inspiration art fantastique, cadrage buste.',
  watercolor:
    'Portrait en aquarelle artistique pour photo de profil, textures douces peintes à la main, couleurs fondues, style artisanal chaleureux, cadrage buste.',
  cartoon:
    'Avatar de style cartoon/bande dessinée pour photo de profil, traits simplifiés et expressifs, couleurs franches et lumineuses, contours nets façon dessin animé, cadrage buste, rendu chaleureux et amical.',
};

const MAX_GENERATIONS_PER_DAY = 5;
const MAX_REFINEMENT_LENGTH = 200;

export class AvatarGenerationService {
  static getAvailableStyles(): string[] {
    return Object.keys(STYLE_PROMPTS);
  }

  static async generate(userId: string, style: string, refinement?: string): Promise<string> {
    const basePrompt = STYLE_PROMPTS[style];
    if (!basePrompt) {
      throw new AppError('Style d\'avatar invalide', 400);
    }

    if (refinement) {
      if (refinement.length > MAX_REFINEMENT_LENGTH) {
        throw new AppError(
          `La description ne doit pas dépasser ${MAX_REFINEMENT_LENGTH} caractères`,
          400,
        );
      }
      if (GeminiService.detectAttack(refinement)) {
        throw new AppError('Description non autorisée', 400);
      }
    }

    // Real per-call cost (image generation, not text) — a daily cap per user
    // independent of the route's IP-based rate limiter, which only guards
    // against short bursts, not sustained abuse across a day.
    const quotaKey = `avatar_gen:${userId}:${new Date().toISOString().slice(0, 10)}`;
    try {
      const count = await redis.incr(quotaKey);
      if (count === 1) await redis.expire(quotaKey, 86400);
      if (count > MAX_GENERATIONS_PER_DAY) {
        throw new AppError(
          `Limite de ${MAX_GENERATIONS_PER_DAY} générations par jour atteinte. Réessayez demain.`,
          429,
        );
      }
    } catch (err: any) {
      if (err instanceof AppError) throw err;
      logger.error(`Avatar generation quota check Redis error: ${err.message}`);
      // Fail open on infra outage — consistent with the login-lockout check
      // in authService.ts, so a Redis blip doesn't lock every user out.
    }

    const prompt = refinement
      ? `${basePrompt} Détails supplémentaires demandés par l'utilisateur : ${refinement}`
      : basePrompt;

    const startTime = Date.now();
    try {
      const model = genAI.getGenerativeModel({
        model: 'gemini-2.5-flash-image',
        generationConfig: {
          responseModalities: ['IMAGE'],
        } as any,
      });

      const result = await model.generateContent(prompt);
      const response = result.response;
      const parts: any[] = (response.candidates?.[0]?.content?.parts as any[]) || [];
      const imagePart = parts.find((p) => p.inlineData?.data);

      if (!imagePart?.inlineData?.data) {
        const blockReason = response.promptFeedback?.blockReason;
        throw new Error(
          blockReason
            ? `AI response blocked due to safety filters: ${blockReason}`
            : 'No image returned by the AI model',
        );
      }

      const buffer = Buffer.from(imagePart.inlineData.data, 'base64');
      const mimeType = imagePart.inlineData.mimeType || 'image/png';
      const ext = mimeType.split('/')[1] || 'png';
      // Not yet applied to the user's profile here on purpose: the mobile UI
      // shows this as a preview the user can regenerate or discard before
      // committing to it via `applyAvatar`. A generation the user rejects
      // simply stays an orphaned object in storage — acceptable, avoids the
      // flicker of a real avatar swap the user didn't ask for yet.
      const destinationKey = `avatars/ai-${userId}-${Date.now()}.${ext}`;
      const avatarUrl = await StorageService.uploadBuffer(
        buffer,
        'kauri-uploads',
        destinationKey,
        mimeType,
      );

      logger.info(
        `AI avatar generated (preview) for user ${userId} (style: ${style}) in ${Date.now() - startTime}ms`,
      );
      return avatarUrl;
    } catch (error: any) {
      logger.error(`Avatar generation error: ${error.message}`, { stack: error.stack });
      // Surface the real reason outside production — this is a brand new
      // integration (Gemini image generation) never yet exercised against a
      // real API key, so a generic message would hide exactly what's needed
      // to fix a first-run failure (wrong model id, no image-gen access on
      // this key, unexpected response shape, etc.).
      const detail = process.env.NODE_ENV !== 'production' ? ` (${error.message})` : '';
      throw new AppError(
        `La génération de l'avatar a échoué. Réessayez avec un style différent.${detail}`,
        503,
      );
    }
  }

  /**
   * Commits a previously generated preview as the user's actual avatar.
   * Restricted to URLs this service itself produced for this exact user
   * (the `ai-${userId}-` key prefix) so a user can't pass an arbitrary URL
   * (e.g. another user's generated preview) and have it applied as their own.
   */
  static async applyAvatar(userId: string, avatarUrl: string): Promise<string> {
    if (typeof avatarUrl !== 'string' || !avatarUrl.includes(`ai-${userId}-`)) {
      throw new AppError('Avatar invalide ou expiré. Générez-en un nouveau.', 400);
    }
    await User.findByIdAndUpdate(userId, { avatar: avatarUrl });
    return avatarUrl;
  }
}
