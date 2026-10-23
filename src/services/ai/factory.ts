import { CloudflareBindings } from '../../env';
import { AIService } from './types';
import { GroqService } from './groq';
import { GeminiService } from '../gemini';

export type { AIService };
export { GroqService, GeminiService };

/**
 * Factory function to retrieve the configured AI Service based on environment bindings.
 * Defaults to 'groq' (Groq Free Tier).
 * Configurable via env.AI_PROVIDER ('groq' | 'gemini').
 *
 * NOTE: As requested by the user, there is no automatic failover between providers.
 * If the active provider fails, errors are surfaced clearly in chat.
 */
export function getAIService(env: CloudflareBindings): AIService {
  const provider = (env.AI_PROVIDER || 'groq').toLowerCase().trim();

  if (provider === 'gemini') {
    if (!env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY is missing in environment, but AI_PROVIDER is set to "gemini".');
    }
    return new GeminiService(env.GEMINI_API_KEY);
  }

  // Default provider: Groq
  if (env.GROQ_API_KEY) {
    return new GroqService(env.GROQ_API_KEY, {
      visionModel: env.GROQ_VISION_MODEL,
      chatModel: env.GROQ_CHAT_MODEL,
    });
  }

  // If GROQ_API_KEY is not configured yet but GEMINI_API_KEY exists, initialize Gemini with warning
  if (env.GEMINI_API_KEY) {
    console.warn('[AIServiceFactory] GROQ_API_KEY not found; defaulting to GEMINI_API_KEY.');
    return new GeminiService(env.GEMINI_API_KEY);
  }

  throw new Error('No AI provider credentials found. Please configure GROQ_API_KEY or GEMINI_API_KEY.');
}
