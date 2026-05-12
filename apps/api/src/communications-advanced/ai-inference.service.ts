import { Injectable } from '@nestjs/common';

/**
 * AI Inference service stub — Phase 2 Cycle 19.
 *
 * The plan calls for an external AI Inference service for both
 * translation (P2-19a) and moderation sensitivity scoring (P2-19b).
 * Cycle 19 ships the contract surface plus a deterministic stub so the
 * services downstream of it (TranslationService, the future
 * AIModerationService) can be exercised end-to-end without the
 * extracted service being deployed.
 *
 * The stub is deterministic — for a given (text, target_language)
 * tuple it returns the same translation every call. That is enough to
 * verify caching keystone: two requests for the same (message_id,
 * target_language) MUST return the same row, regardless of whether
 * the stub or a real model produced it.
 *
 * When the real service ships, swap this for an HTTP client. The
 * shape of `translate()` and `analyzeSensitivity()` stays the same.
 */
export interface TranslationResult {
  translatedText: string;
  sourceLanguage: string | null;
  confidence: number;
  modelVersion: string;
}

export interface SensitivityResult {
  sensitivityScore: number;
  categoriesDetected: Record<string, number>;
  modelVersion: string;
}

@Injectable()
export class AiInferenceService {
  private readonly modelVersion = 'stub-translation-v1';

  /**
   * Translate a text into the target language. Deterministic stub for
   * dev / test: prefixes the source with a language tag so the cache
   * test can verify same-in-same-out. Production swap-in will call an
   * extracted service over HTTP.
   */
  async translate(
    sourceText: string,
    targetLanguage: string,
    sourceLanguage: string | null = null,
  ): Promise<TranslationResult> {
    if (!sourceText || sourceText.trim().length === 0) {
      throw new Error('Cannot translate empty source text');
    }
    if (!targetLanguage || targetLanguage.trim().length === 0) {
      throw new Error('Target language must be provided');
    }
    const normalisedTarget = targetLanguage.trim().toLowerCase();
    // Deterministic stub: prefix with target tag so test fixtures stay
    // stable across runs. Real model returns a free-form translation.
    const translatedText = `[${normalisedTarget}] ${sourceText}`;
    return {
      translatedText,
      sourceLanguage: sourceLanguage ?? 'en',
      confidence: 0.95,
      modelVersion: this.modelVersion,
    };
  }

  /**
   * Sensitivity analysis — used by the Phase 2 Cycle 19 sub-cycle b
   * ModerationService. Cycle 19a ships the contract; the keystone
   * unit test does not exercise this method.
   */
  async analyzeSensitivity(text: string): Promise<SensitivityResult> {
    if (!text || text.trim().length === 0) {
      throw new Error('Cannot analyze empty text');
    }
    return {
      sensitivityScore: 0.05,
      categoriesDetected: { profanity: 0.0, bullying: 0.0, self_harm: 0.0 },
      modelVersion: 'stub-moderation-v1',
    };
  }
}
