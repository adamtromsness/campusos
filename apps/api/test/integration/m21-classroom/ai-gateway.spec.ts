import { describe, it, expect } from 'vitest';

import { AIGatewayService } from '@modules/m21-classroom/ai-tutoring/ai-gateway.service';

/**
 * Wave 4 — AIGatewayService coverage. This service is a thin stub in
 * dev/test/CI (isStub() returns true) and a remote HTTP call in
 * production. Tests verify the stub paths produce sensible payloads.
 */
describe('integration:m21-classroom/ai-gateway', () => {
  const gateway = new AIGatewayService();

  describe('tutoringReply', () => {
    it('returns a stubbed response shaped like the real one', async () => {
      const result = await gateway.tutoringReply({
        anonymousStudentId: 'anon-1',
        subject: 'MATH',
        history: [],
        newMessage: 'Why does 2+2=4?',
      });
      expect(typeof result.content).toBe('string');
      expect(result.content).toContain('MATH');
      expect(result.content).toContain('Why does 2+2');
      expect(result.tokensUsed).toBeGreaterThanOrEqual(50);
      expect(result.costUsd).toBe(0);
    });

    it('handles long messages', async () => {
      const long = 'word '.repeat(500);
      const result = await gateway.tutoringReply({
        anonymousStudentId: 'anon-2',
        subject: 'SCIENCE',
        history: [{ role: 'STUDENT', content: 'prior' }],
        newMessage: long,
      });
      expect(result.tokensUsed).toBeGreaterThan(50);
    });
  });

  describe('extractLearningSignals', () => {
    it('empty transcript → empty signals', async () => {
      const result = await gateway.extractLearningSignals({
        anonymousStudentId: 'anon-1',
        subject: 'MATH',
        transcript: [],
      });
      expect(result.signals).toHaveLength(0);
      expect(result.tokensUsed).toBe(200);
    });

    it('transcript with student messages → at least 1 INTEREST signal', async () => {
      const result = await gateway.extractLearningSignals({
        anonymousStudentId: 'anon-1',
        subject: 'MATH',
        transcript: [
          { role: 'STUDENT', content: 'Hello' },
          { role: 'ASSISTANT', content: 'Hi' },
        ],
      });
      expect(result.signals.some((s) => s.signalType === 'INTEREST')).toBe(true);
    });

    it('transcript with question words → ENGAGEMENT signal', async () => {
      const result = await gateway.extractLearningSignals({
        anonymousStudentId: 'anon-1',
        subject: 'SCIENCE',
        transcript: [
          { role: 'STUDENT', content: 'Why does this work?' },
          { role: 'ASSISTANT', content: 'Because...' },
        ],
      });
      expect(result.signals.some((s) => s.signalType === 'INTEREST')).toBe(true);
      expect(result.signals.some((s) => s.signalType === 'ENGAGEMENT')).toBe(true);
    });
  });

  describe('summariseLesson', () => {
    it('summarises a transcript with subject context', async () => {
      const result = await gateway.summariseLesson({
        transcript: 'lorem ipsum dolor sit amet '.repeat(20),
        subject: 'BIOLOGY',
      });
      expect(result.summaryText).toContain('BIOLOGY');
      expect(result.keyTopics).toContain('BIOLOGY');
      expect(result.actionItems).toContain('Review notes');
      expect(result.modelVersion).toBe('stub-v1');
      expect(result.tokensUsed).toBeGreaterThanOrEqual(100);
    });

    it('summarises without subject (generic)', async () => {
      const result = await gateway.summariseLesson({
        transcript: 'a b c d e f',
      });
      expect(result.keyTopics).toEqual(['lesson', 'review']);
      expect(result.summaryText).toContain('6-word lesson transcript');
    });
  });
});
