import { Injectable } from '@nestjs/common';

export interface TutoringReplyInput {
  /**
   * Anonymised student id — output of AITutoringService.toAnonymousId.
   * The AI Gateway sees only this opaque token, never the real
   * sis_students.id or any PII per ADR-004 SAFETY RULE 2.
   */
  anonymousStudentId: string;
  subject: string;
  history: Array<{ role: 'STUDENT' | 'ASSISTANT'; content: string }>;
  newMessage: string;
}

export interface TutoringReplyOutput {
  content: string;
  tokensUsed: number;
  costUsd: number;
}

export interface ExtractSignalsInput {
  anonymousStudentId: string;
  subject: string;
  transcript: Array<{ role: 'STUDENT' | 'ASSISTANT'; content: string }>;
}

export interface ExtractSignalsOutput {
  signals: Array<{
    signalType: 'MISCONCEPTION' | 'STRENGTH' | 'STRUGGLE' | 'INTEREST' | 'ENGAGEMENT';
    description: string;
    standardId?: string | null;
    confidence?: number | null;
  }>;
  tokensUsed: number;
  costUsd: number;
}

export interface SummariseLessonInput {
  /**
   * Anonymised lesson context — uses recordingId hash, never the
   * teacher name or any PII.
   */
  anonymousRecordingId: string;
  className: string | null;
  subject: string | null;
  transcript: string;
}

export interface SummariseLessonOutput {
  summaryText: string;
  keyTopics: string[];
  actionItems: string[];
  modelVersion: string;
  tokensUsed: number;
  costUsd: number;
}

/**
 * AIGatewayService — P2-7c Step 6 stub for the AI Inference extracted
 * service per ADR-004.
 *
 * In production this service is the thin client over the AI Gateway
 * (HTTP / gRPC out to the model). For dev / demo / CAT scripts, the
 * AI Inference service is not yet deployed — every method returns a
 * deterministic placeholder so the rest of the pipeline (queue, opt-out
 * gate, usage logging, message persistence) ships and can be exercised
 * end-to-end. When the real service lands, swap the implementation
 * for an HTTP client without changing any caller.
 *
 * SAFETY RULE 1 — this service NEVER touches cls_grades. The dev
 * stub never sends prompts at all. The production implementation
 * will gate any grading-suggestion flow at the AIUsageService.recordUsage
 * tier and route the result back as a teacher recommendation, not a
 * write.
 *
 * SAFETY RULE 2 — every input field above is either anonymised
 * (anonymousStudentId, anonymousRecordingId) or non-PII (subject,
 * className, transcript text — transcripts are intentionally raw
 * because the speaker identity is the teacher publishing the lesson,
 * not a student PII surface).
 */
@Injectable()
export class AIGatewayService {
  /**
   * Generate a tutoring reply. Stubbed in dev; production swaps this
   * for an HTTP call to the AI Gateway with the appropriate model +
   * system prompt enforcing the educator-tone guard rails.
   */
  async tutoringReply(input: TutoringReplyInput): Promise<TutoringReplyOutput> {
    if (this.isStub()) {
      const word = input.newMessage.split(/\s+/).slice(0, 3).join(' ');
      return {
        content:
          'Great question about ' +
          input.subject +
          '. Let me help you think through "' +
          word +
          '". (This is a stubbed AI response — the production AI Gateway is not deployed yet.)',
        tokensUsed: Math.max(50, input.newMessage.length / 4) | 0,
        costUsd: 0,
      };
    }
    throw new Error('AIGatewayService.tutoringReply: production implementation not wired yet.');
  }

  /**
   * Extract learning signals from a completed conversation. Stubbed in dev.
   */
  async extractLearningSignals(input: ExtractSignalsInput): Promise<ExtractSignalsOutput> {
    if (this.isStub()) {
      const studentMessages = input.transcript.filter((m) => m.role === 'STUDENT');
      const signals: ExtractSignalsOutput['signals'] = [];
      if (studentMessages.length > 0) {
        signals.push({
          signalType: 'INTEREST',
          description:
            'Stub signal: student engaged in ' +
            studentMessages.length +
            ' message(s) on ' +
            input.subject +
            '.',
          confidence: 0.6,
        });
      }
      if (studentMessages.some((m) => /why|how|what/i.test(m.content))) {
        signals.push({
          signalType: 'ENGAGEMENT',
          description: 'Stub signal: student asked clarifying questions.',
          confidence: 0.7,
        });
      }
      return {
        signals,
        tokensUsed: 200,
        costUsd: 0,
      };
    }
    throw new Error('AIGatewayService.extractLearningSignals: production not wired.');
  }

  /**
   * Summarise a lesson transcript. Stubbed in dev.
   */
  async summariseLesson(input: SummariseLessonInput): Promise<SummariseLessonOutput> {
    if (this.isStub()) {
      const wordCount = input.transcript.split(/\s+/).length;
      return {
        summaryText:
          'Stub summary: a ' +
          wordCount +
          '-word lesson transcript' +
          (input.subject ? ' on ' + input.subject : '') +
          '. The production AI Gateway will replace this with an LLM-generated summary.',
        keyTopics: input.subject ? [input.subject, 'review', 'practice'] : ['lesson', 'review'],
        actionItems: ['Review notes', 'Practice problems'],
        modelVersion: 'stub-v1',
        tokensUsed: Math.max(100, wordCount * 2),
        costUsd: 0,
      };
    }
    throw new Error('AIGatewayService.summariseLesson: production not wired.');
  }

  /**
   * Gate that returns true when the AI Gateway is not deployed (dev /
   * test / demo). Production swaps this to false once the AI Inference
   * service is live and the env flag is set.
   */
  private isStub(): boolean {
    return !process.env.AI_GATEWAY_URL || process.env.AI_GATEWAY_STUB === '1';
  }
}
