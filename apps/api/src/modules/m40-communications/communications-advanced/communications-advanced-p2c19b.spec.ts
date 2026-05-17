import { describe, it, expect } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { runWithTenantContext, TenantInfo } from '@shared/tenant/tenant.context';
import { PERMISSIONS_KEY } from '@shared/auth/require-permission.decorator';
import { AiInferenceService } from './ai-inference.service';
import { ModerationService } from './moderation.service';
import { AppealService } from './appeal.service';
import { AIModerationService } from './ai-moderation.service';
import { PushCampaignService } from './push-campaign.service';
import { CommunicationsAdvancedController } from './communications-advanced.controller';

/**
 * Phase 2 Cycle 19 sub-cycle b (P2-19b) — Moderation + Push Campaigns
 * + Appeals keystone unit tests.
 *
 * Load-bearing invariants:
 *   1. Three-tier moderation: ModerationService.resolveDecision reads
 *      every active rule matching PLATFORM tier OR the calling tenant
 *      school and picks the most-restrictive action across all matches
 *      (BLOCK > ESCALATE > FLAG).
 *   2. Appeal OVERTURNED: AppealService.patch flips the appeal AND
 *      releases the parent moderation action in the same tenant tx.
 *   3. AI moderation cache: AIModerationService.analyze returns the
 *      cached row on the second call instead of re-calling the AI
 *      Inference service. UNIQUE(message_id) at the schema layer is
 *      the cache key.
 *   4. Push campaign schedule lockstep: SCHEDULED → SENT transition
 *      stamps sent_at atomically (schema sent_chk) and seeds analytics
 *      with total_targeted.
 *   5. Push analytics UPSERT: a duplicate webhook lands as an update
 *      rather than a new row; rates recompute on every upsert.
 *   6. Controller permission gates pin the documented codes.
 */

const SCHOOL: TenantInfo = {
  schoolId: '019e0e69-1111-7000-8000-000000000001',
  schemaName: 'tenant_demo',
  organisationId: 'org-1',
  subdomain: 'demo',
  isFrozen: false,
  planTier: 'MEDIUM',
  homeRegion: 'us-east-1',
};

const ADMIN_ACTOR = {
  accountId: '019e0e69-2222-7000-8000-000000000001',
  personId: '019e0e69-2222-7000-8000-000000000002',
  personType: 'STAFF' as const,
  isSchoolAdmin: true,
  employeeId: '019e0e69-2222-7000-8000-000000000099',
} as never;

const TEACHER_ACTOR = {
  accountId: '019e0e69-3333-7000-8000-000000000001',
  personId: '019e0e69-3333-7000-8000-000000000002',
  personType: 'STAFF' as const,
  isSchoolAdmin: false,
  employeeId: '019e0e69-3333-7000-8000-000000000088',
} as never;

interface CapturedCall {
  sql: string;
  args: unknown[];
  fn: 'q' | 'e';
}

function makeFake(handler: (call: CapturedCall) => unknown) {
  const capture: CapturedCall[] = [];
  const client = {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      const call: CapturedCall = { sql, args, fn: 'q' };
      capture.push(call);
      return handler(call) ?? [];
    },
    $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
      const call: CapturedCall = { sql, args, fn: 'e' };
      capture.push(call);
      return handler(call) ?? 0;
    },
  };
  const tenantPrisma = {
    executeInTenantContext: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
    executeInTenantTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
    getPlatformClient: () => ({}) as never,
  };
  return { capture, client, tenantPrisma };
}

describe('ModerationService — three-tier most-restrictive-wins (P2-19b BLOCKING)', () => {
  it('picks BLOCK over ESCALATE over FLAG when multiple rules match', async () => {
    const platformRuleId = 'aaaa-platform';
    const districtRuleId = 'bbbb-district';
    const buildingRuleId = 'cccc-building';
    let aiPassedToQuery: number | null = null;
    const { tenantPrisma } = makeFake((call) => {
      if (call.fn === 'q' && call.sql.includes('FROM msg_moderation_rules')) {
        // capture the AI value we pass through later
        aiPassedToQuery =
          (call.args[1] as string) === SCHOOL.schoolId ? aiPassedToQuery : aiPassedToQuery;
        return [
          {
            id: districtRuleId,
            school_id: SCHOOL.schoolId,
            scope: 'DISTRICT',
            scope_id: null,
            name: 'District flag rule',
            description: null,
            keywords: ['stupid'],
            keyword_action: 'FLAG_FOR_REVIEW',
            ai_sensitivity_threshold: null,
            escalation_rules: {},
            is_active: true,
            created_by: null,
            created_at: '2026-05-01T00:00:00Z',
            updated_at: '2026-05-01T00:00:00Z',
          },
          {
            id: platformRuleId,
            school_id: null,
            scope: 'PLATFORM',
            scope_id: null,
            name: 'Platform block rule',
            description: null,
            keywords: ['shit', 'fuck'],
            keyword_action: 'BLOCK',
            ai_sensitivity_threshold: null,
            escalation_rules: {},
            is_active: true,
            created_by: null,
            created_at: '2026-05-01T00:00:00Z',
            updated_at: '2026-05-01T00:00:00Z',
          },
          {
            id: buildingRuleId,
            school_id: SCHOOL.schoolId,
            scope: 'BUILDING',
            scope_id: null,
            name: 'Building escalate rule',
            description: null,
            keywords: ['kill myself'],
            keyword_action: 'ESCALATE_TO_COUNSELLOR',
            ai_sensitivity_threshold: null,
            escalation_rules: {},
            is_active: true,
            created_by: null,
            created_at: '2026-05-01T00:00:00Z',
            updated_at: '2026-05-01T00:00:00Z',
          },
        ];
      }
      return [];
    });
    const svc = new ModerationService(tenantPrisma as never);
    // Text matches all three rules: BLOCK on 'shit', FLAG on 'stupid',
    // ESCALATE on 'kill myself' — BLOCK must win.
    const decision = await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.resolveDecision('This is shit. You are a stupid loser. I want to kill myself.', null),
    );
    expect(decision).not.toBeNull();
    expect(decision!.ruleId).toBe(platformRuleId);
    expect(decision!.actionTaken).toBe('BLOCKED');
    expect(decision!.matchedKeywords).toContain('shit');
    void aiPassedToQuery;
  });

  it('returns null when no rule matches — worker materialises AUTO_APPROVED', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const svc = new ModerationService(tenantPrisma as never);
    const decision = await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.resolveDecision('Hello there, this is a benign greeting.', null),
    );
    expect(decision).toBeNull();
  });

  it('fires on AI threshold even without keyword match when ai_sensitivity_threshold is set', async () => {
    const districtRuleId = 'dddd-district-ai';
    const { tenantPrisma } = makeFake((call) => {
      if (call.fn === 'q' && call.sql.includes('FROM msg_moderation_rules')) {
        return [
          {
            id: districtRuleId,
            school_id: SCHOOL.schoolId,
            scope: 'DISTRICT',
            scope_id: null,
            name: 'AI district rule',
            description: null,
            keywords: ['nonexistent-keyword-xyz'],
            keyword_action: 'FLAG_FOR_REVIEW',
            ai_sensitivity_threshold: '0.70',
            escalation_rules: {},
            is_active: true,
            created_by: null,
            created_at: '2026-05-01T00:00:00Z',
            updated_at: '2026-05-01T00:00:00Z',
          },
        ];
      }
      return [];
    });
    const svc = new ModerationService(tenantPrisma as never);
    const decision = await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.resolveDecision('Some otherwise innocuous text', 0.85),
    );
    expect(decision).not.toBeNull();
    expect(decision!.ruleId).toBe(districtRuleId);
    expect(decision!.actionTaken).toBe('FLAGGED_FOR_REVIEW');
    expect(decision!.aiSensitivityScore).toBe(0.85);
  });

  it('queries with scope=PLATFORM OR school_id=$tenant — covers both tiers in one read', async () => {
    const { capture, tenantPrisma } = makeFake(() => []);
    const svc = new ModerationService(tenantPrisma as never);
    await runWithTenantContext({ tenant: SCHOOL }, () => svc.resolveDecision('hi', null));
    const ruleQuery = capture.find(
      (c) => c.fn === 'q' && c.sql.includes('FROM msg_moderation_rules'),
    );
    expect(ruleQuery).toBeDefined();
    expect(ruleQuery!.sql).toMatch(/scope = \$1 OR school_id = \$2::uuid/);
    expect(ruleQuery!.args[0]).toBe('PLATFORM');
    expect(ruleQuery!.args[1]).toBe(SCHOOL.schoolId);
  });
});

describe('ModerationService — recordAction stamps schema lockstep correctly', () => {
  it('AUTO_APPROVED actions land with review_status=RELEASED (queue stays clean)', async () => {
    const { capture, tenantPrisma } = makeFake((call) => {
      if (call.fn === 'q' && call.sql.includes('FROM msg_moderation_actions')) {
        return [
          {
            id: 'new-action-id',
            message_id: '019e0aaa-7777-7000-8000-000000000001',
            message_created_at: '2026-05-12T09:00:00Z',
            rule_id: 'platform-rule',
            action_taken: 'AUTO_APPROVED',
            matched_keywords: [],
            ai_sensitivity_score: null,
            review_status: 'RELEASED',
            reviewed_by: null,
            reviewed_at: null,
            reviewer_notes: null,
            created_at: '2026-05-12T09:00:00Z',
          },
        ];
      }
      return [];
    });
    const svc = new ModerationService(tenantPrisma as never);
    await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.recordAction({
        messageId: '019e0aaa-7777-7000-8000-000000000001',
        messageCreatedAt: '2026-05-12T09:00:00Z',
        decision: {
          ruleId: 'platform-rule',
          actionTaken: 'AUTO_APPROVED',
          matchedKeywords: [],
          aiSensitivityScore: null,
        },
      }),
    );
    const insert = capture.find(
      (c) => c.fn === 'e' && c.sql.includes('INSERT INTO msg_moderation_actions'),
    );
    expect(insert).toBeDefined();
    // 8th positional arg is review_status — AUTO_APPROVED → RELEASED.
    expect(insert!.args[7]).toBe('RELEASED');
  });

  it('BLOCKED actions land with review_status=PENDING (queue picks them up)', async () => {
    const { capture, tenantPrisma } = makeFake((call) => {
      if (call.fn === 'q' && call.sql.includes('FROM msg_moderation_actions')) {
        return [
          {
            id: 'new-action-id',
            message_id: '019e0aaa-8888-7000-8000-000000000002',
            message_created_at: '2026-05-12T09:00:00Z',
            rule_id: 'platform-rule',
            action_taken: 'BLOCKED',
            matched_keywords: ['shit'],
            ai_sensitivity_score: null,
            review_status: 'PENDING',
            reviewed_by: null,
            reviewed_at: null,
            reviewer_notes: null,
            created_at: '2026-05-12T09:00:00Z',
          },
        ];
      }
      return [];
    });
    const svc = new ModerationService(tenantPrisma as never);
    await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.recordAction({
        messageId: '019e0aaa-8888-7000-8000-000000000002',
        messageCreatedAt: '2026-05-12T09:00:00Z',
        decision: {
          ruleId: 'platform-rule',
          actionTaken: 'BLOCKED',
          matchedKeywords: ['shit'],
          aiSensitivityScore: null,
        },
      }),
    );
    const insert = capture.find(
      (c) => c.fn === 'e' && c.sql.includes('INSERT INTO msg_moderation_actions'),
    );
    expect(insert!.args[7]).toBe('PENDING');
  });
});

describe('AppealService — OVERTURNED releases parent action in same tx (P2-19b KEYSTONE)', () => {
  it('OVERTURNED appeal flips parent action to RELEASED inside the same tenant tx', async () => {
    const appealId = 'aaaa-appeal';
    const actionId = 'bbbb-action';
    const actionCreatedAt = '2026-05-10T09:00:00Z';
    let appealStatus: 'SUBMITTED' | 'OVERTURNED' = 'SUBMITTED';
    const { capture, tenantPrisma } = makeFake((call) => {
      if (call.fn === 'q' && call.sql.includes('FROM msg_moderation_appeals')) {
        return [
          {
            id: appealId,
            action_id: actionId,
            action_created_at: actionCreatedAt,
            appealed_by: '019e0e69-bbbb-7000-8000-000000000002',
            appeal_reason: 'My message was misclassified.',
            status: appealStatus,
            reviewed_by: appealStatus === 'OVERTURNED' ? ADMIN_ACTOR.accountId : null,
            reviewed_at: appealStatus === 'OVERTURNED' ? '2026-05-12T09:00:00Z' : null,
            reviewer_notes: appealStatus === 'OVERTURNED' ? 'Released via appeal' : null,
            created_at: '2026-05-11T09:00:00Z',
          },
        ];
      }
      if (call.fn === 'e' && call.sql.includes('UPDATE msg_moderation_appeals')) {
        appealStatus = 'OVERTURNED';
      }
      if (call.fn === 'q' && call.sql.includes('FROM msg_moderation_actions')) {
        return [
          {
            id: actionId,
            message_id: '019e0aaa-cccc-7000-8000-000000000003',
            message_created_at: '2026-05-10T08:55:00Z',
            rule_id: 'platform-rule',
            action_taken: 'BLOCKED',
            matched_keywords: ['shit'],
            ai_sensitivity_score: '0.85',
            review_status: 'PENDING',
            reviewed_by: null,
            reviewed_at: null,
            reviewer_notes: null,
            created_at: actionCreatedAt,
          },
        ];
      }
      return [];
    });
    const moderation = new ModerationService(tenantPrisma as never);
    const appeals = new AppealService(tenantPrisma as never, moderation);
    await runWithTenantContext({ tenant: SCHOOL }, () =>
      appeals.patch(appealId, { status: 'OVERTURNED' }, ADMIN_ACTOR),
    );
    // Both the appeal UPDATE and the moderation action UPDATE must
    // fire inside the same tx — the moderation action transition
    // sets review_status=RELEASED with reviewer columns populated
    // atomically.
    const appealUpdate = capture.find(
      (c) => c.fn === 'e' && c.sql.includes('UPDATE msg_moderation_appeals'),
    );
    expect(appealUpdate).toBeDefined();
    expect(appealUpdate!.args[1]).toBe('OVERTURNED');
    const actionUpdate = capture.find(
      (c) => c.fn === 'e' && c.sql.includes('UPDATE msg_moderation_actions'),
    );
    expect(actionUpdate).toBeDefined();
    expect(actionUpdate!.args[1]).toBe('RELEASED');
    expect(actionUpdate!.args[2]).toBe(ADMIN_ACTOR.accountId);
  });

  it('UPHELD appeal leaves the parent action untouched', async () => {
    const appealId = 'aaaa-appeal-2';
    const actionId = 'bbbb-action-2';
    let appealStatus: 'SUBMITTED' | 'UPHELD' = 'SUBMITTED';
    const { capture, tenantPrisma } = makeFake((call) => {
      if (call.fn === 'q' && call.sql.includes('FROM msg_moderation_appeals')) {
        return [
          {
            id: appealId,
            action_id: actionId,
            action_created_at: '2026-05-10T09:00:00Z',
            appealed_by: '019e0e69-bbbb-7000-8000-000000000002',
            appeal_reason: 'Please reconsider.',
            status: appealStatus,
            reviewed_by: appealStatus === 'UPHELD' ? ADMIN_ACTOR.accountId : null,
            reviewed_at: appealStatus === 'UPHELD' ? '2026-05-12T09:00:00Z' : null,
            reviewer_notes: appealStatus === 'UPHELD' ? 'Upheld' : null,
            created_at: '2026-05-11T09:00:00Z',
          },
        ];
      }
      if (call.fn === 'e' && call.sql.includes('UPDATE msg_moderation_appeals')) {
        appealStatus = 'UPHELD';
      }
      return [];
    });
    const moderation = new ModerationService(tenantPrisma as never);
    const appeals = new AppealService(tenantPrisma as never, moderation);
    await runWithTenantContext({ tenant: SCHOOL }, () =>
      appeals.patch(appealId, { status: 'UPHELD' }, ADMIN_ACTOR),
    );
    const appealUpdate = capture.find(
      (c) => c.fn === 'e' && c.sql.includes('UPDATE msg_moderation_appeals'),
    );
    expect(appealUpdate!.args[1]).toBe('UPHELD');
    const actionUpdate = capture.find(
      (c) => c.fn === 'e' && c.sql.includes('UPDATE msg_moderation_actions'),
    );
    expect(actionUpdate).toBeUndefined();
  });

  it('rejects non-admin reviewer with ForbiddenException', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const moderation = new ModerationService(tenantPrisma as never);
    const appeals = new AppealService(tenantPrisma as never, moderation);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        appeals.patch('xxx', { status: 'OVERTURNED' }, TEACHER_ACTOR),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('AIModerationService — cache UNIQUE(message_id) keystone', () => {
  it('returns cached row on second analyze() call without re-calling AI', async () => {
    const messageId = '019e0aaa-eeee-7000-8000-000000000005';
    let aiCalls = 0;
    const ai = {
      analyzeSensitivity: async () => {
        aiCalls++;
        return {
          sensitivityScore: 0.92,
          categoriesDetected: { profanity: 0.92, bullying: 0.4 },
          modelVersion: 'stub-moderation-v1',
        };
      },
      translate: async () => ({
        translatedText: '',
        sourceLanguage: null,
        confidence: 1,
        modelVersion: '',
      }),
    } as AiInferenceService;

    let cacheEmpty = true;
    const { tenantPrisma } = makeFake((call) => {
      if (call.fn === 'q' && call.sql.includes('FROM msg_ai_moderation_results')) {
        if (cacheEmpty) return [];
        return [
          {
            id: 'cache-row',
            message_id: messageId,
            message_created_at: '2026-05-12T09:00:00Z',
            sensitivity_score: '0.92',
            categories_detected: { profanity: 0.92, bullying: 0.4 },
            model_version: 'stub-moderation-v1',
            computed_at: '2026-05-12T09:00:00Z',
          },
        ];
      }
      if (call.fn === 'q' && call.sql.includes('FROM msg_messages')) {
        return [
          {
            body: 'Hello, this is a test message.',
            created_at: '2026-05-12T09:00:00Z',
          },
        ];
      }
      if (call.fn === 'e' && call.sql.includes('INSERT INTO msg_ai_moderation_results')) {
        cacheEmpty = false;
      }
      return [];
    });
    const svc = new AIModerationService(tenantPrisma as never, ai);

    // First call — miss → AI invoked → INSERT.
    const first = await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.analyze(messageId, 'Hello'),
    );
    expect(first.cached).toBe(false);
    expect(aiCalls).toBe(1);

    // Second call — hit → no AI call.
    const second = await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.analyze(messageId, 'Hello'),
    );
    expect(second.cached).toBe(true);
    expect(aiCalls).toBe(1);
  });

  it('INSERTs with ON CONFLICT DO NOTHING to handle concurrent first-call race', async () => {
    let cacheReadCount = 0;
    const { capture, tenantPrisma } = makeFake((call) => {
      if (call.fn === 'q' && call.sql.includes('FROM msg_ai_moderation_results')) {
        cacheReadCount++;
        // First read (cache check): empty. Second read (post-INSERT): returns row.
        if (cacheReadCount === 1) return [];
        return [
          {
            id: 'cache-row',
            message_id: '019e0aaa-ffff-7000-8000-000000000006',
            message_created_at: '2026-05-12T09:00:00Z',
            sensitivity_score: '0.10',
            categories_detected: {},
            model_version: 'stub',
            computed_at: '2026-05-12T09:00:00Z',
          },
        ];
      }
      if (call.fn === 'q' && call.sql.includes('FROM msg_messages')) {
        return [{ body: 'Hello', created_at: '2026-05-12T09:00:00Z' }];
      }
      return [];
    });
    const ai = {
      analyzeSensitivity: async () => ({
        sensitivityScore: 0.1,
        categoriesDetected: {},
        modelVersion: 'stub',
      }),
      translate: async () => ({
        translatedText: '',
        sourceLanguage: null,
        confidence: 1,
        modelVersion: '',
      }),
    } as AiInferenceService;
    const svc = new AIModerationService(tenantPrisma as never, ai);
    await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.analyze('019e0aaa-ffff-7000-8000-000000000006', 'Hello'),
    );
    const insert = capture.find(
      (c) => c.fn === 'e' && c.sql.includes('INSERT INTO msg_ai_moderation_results'),
    );
    expect(insert).toBeDefined();
    expect(insert!.sql).toMatch(/ON CONFLICT \(message_id, message_created_at\) DO NOTHING/);
  });
});

describe('PushCampaignService — schedule lockstep + analytics UPSERT keystones', () => {
  it('dispatchScheduled flips status SENT and seeds analytics with total_targeted', async () => {
    const campaignId = '019e0aaa-1111-7000-8000-000000000007';
    let statusInDb = 'SCHEDULED';
    let sentAtInDb: string | null = null;
    const { capture, tenantPrisma } = makeFake((call) => {
      if (call.fn === 'q' && call.sql.includes('FROM msg_push_campaigns')) {
        return [
          {
            id: campaignId,
            school_id: SCHOOL.schoolId,
            title: 'Test',
            body: 'Body',
            deep_link_url: null,
            image_s3_key: null,
            audience_segment_id: null,
            scheduled_at: '2026-05-12T09:00:00Z',
            sent_at: sentAtInDb,
            status: statusInDb,
            created_by: ADMIN_ACTOR.accountId,
            created_at: '2026-05-12T09:00:00Z',
            updated_at: '2026-05-12T09:00:00Z',
          },
        ];
      }
      if (call.fn === 'e' && call.sql.includes('UPDATE msg_push_campaigns')) {
        statusInDb = 'SENT';
        sentAtInDb = '2026-05-12T09:00:00Z';
      }
      return [];
    });
    const svc = new PushCampaignService(tenantPrisma as never);
    const dispatched = await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.dispatchScheduled(campaignId, 100),
    );
    expect(dispatched).not.toBeNull();
    expect(dispatched!.status).toBe('SENT');

    const update = capture.find((c) => c.fn === 'e' && c.sql.includes('UPDATE msg_push_campaigns'));
    expect(update).toBeDefined();
    expect(update!.args[1]).toBe('SENT');

    const insert = capture.find(
      (c) => c.fn === 'e' && c.sql.includes('INSERT INTO msg_push_analytics'),
    );
    expect(insert).toBeDefined();
    expect(insert!.args[2]).toBe(100); // total_targeted positional arg
    expect(insert!.sql).toMatch(/ON CONFLICT \(campaign_id\) DO NOTHING/);
  });

  it('recordDelivery UPSERTs with recomputed rates', async () => {
    const campaignId = '019e0aaa-2222-7000-8000-000000000008';
    const { capture, tenantPrisma } = makeFake((call) => {
      if (call.fn === 'q' && call.sql.includes('FROM msg_push_analytics')) {
        return [
          {
            id: 'analytics-id',
            campaign_id: campaignId,
            total_targeted: 100,
            total_delivered: 95,
            total_opened: 70,
            total_clicked: 30,
            delivery_rate: '0.9500',
            open_rate: '0.7368',
            click_rate: '0.4286',
            last_updated_at: '2026-05-11T09:00:00Z',
          },
        ];
      }
      return [];
    });
    const svc = new PushCampaignService(tenantPrisma as never);
    await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.recordDelivery({ campaignId, opened: 5, clicked: 2 }),
    );
    const update = capture.find((c) => c.fn === 'e' && c.sql.includes('UPDATE msg_push_analytics'));
    expect(update).toBeDefined();
    expect(update!.args[2]).toBe(75); // opened = 70 + 5
    expect(update!.args[3]).toBe(32); // clicked = 30 + 2
  });

  it('dispatchScheduled refuses non-SCHEDULED rows (idempotent worker tick)', async () => {
    const campaignId = '019e0aaa-3333-7000-8000-000000000009';
    const { tenantPrisma } = makeFake((call) => {
      if (call.fn === 'q' && call.sql.includes('FROM msg_push_campaigns')) {
        return [
          {
            id: campaignId,
            school_id: SCHOOL.schoolId,
            title: 'Test',
            body: 'Body',
            deep_link_url: null,
            image_s3_key: null,
            audience_segment_id: null,
            scheduled_at: '2026-05-12T09:00:00Z',
            sent_at: '2026-05-12T09:00:01Z',
            status: 'SENT',
            created_by: ADMIN_ACTOR.accountId,
            created_at: '2026-05-12T09:00:00Z',
            updated_at: '2026-05-12T09:00:00Z',
          },
        ];
      }
      return [];
    });
    const svc = new PushCampaignService(tenantPrisma as never);
    const result = await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.dispatchScheduled(campaignId, 100),
    );
    expect(result).toBeNull();
  });

  it('registerDevice with re-registered token UPDATES instead of duplicate INSERT', async () => {
    const existingToken = 'apns-existing-token';
    let updated = false;
    const { capture, tenantPrisma } = makeFake((call) => {
      if (call.fn === 'q' && call.sql.includes('FROM msg_push_device_tokens')) {
        return [
          {
            id: 'existing-id',
            user_id: ADMIN_ACTOR.accountId,
            device_token: existingToken,
            platform: 'IOS',
            device_name: 'Old',
            app_version: '16.0',
            is_active: false,
            registered_at: '2025-01-01T00:00:00Z',
            last_used_at: '2025-06-01T00:00:00Z',
          },
        ];
      }
      if (call.fn === 'e' && call.sql.includes('UPDATE msg_push_device_tokens')) {
        updated = true;
      }
      return [];
    });
    const svc = new PushCampaignService(tenantPrisma as never);
    await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.registerDevice(
        {
          deviceToken: existingToken,
          platform: 'IOS',
          deviceName: 'New iPhone',
          appVersion: '17.4',
        },
        ADMIN_ACTOR,
      ),
    );
    expect(updated).toBe(true);
    const inserts = capture.filter(
      (c) => c.fn === 'e' && c.sql.includes('INSERT INTO msg_push_device_tokens'),
    );
    expect(inserts).toHaveLength(0);
  });
});

describe('CommunicationsAdvancedController P2-19b — permission gates pin the documented codes', () => {
  const controller = CommunicationsAdvancedController.prototype;
  function gateFor(methodName: keyof typeof controller): string[] {
    return Reflect.getMetadata(PERMISSIONS_KEY, controller[methodName] as never) as string[];
  }

  it('moderation rules read on com-003:read, writes on com-003:admin', () => {
    expect(gateFor('listModerationRules')).toEqual(['com-003:read']);
    expect(gateFor('getModerationRule')).toEqual(['com-003:read']);
    expect(gateFor('createModerationRule')).toEqual(['com-003:admin']);
    expect(gateFor('patchModerationRule')).toEqual(['com-003:admin']);
  });

  it('moderation queue + action review on com-003:write', () => {
    expect(gateFor('listModerationQueue')).toEqual(['com-003:write']);
    expect(gateFor('patchModerationAction')).toEqual(['com-003:write']);
  });

  it('appeals: create on com-001:write (user surface), review on com-003:write', () => {
    expect(gateFor('createAppeal')).toEqual(['com-001:write']);
    expect(gateFor('patchAppeal')).toEqual(['com-003:write']);
    expect(gateFor('listAppeals')).toEqual(['com-003:write']);
  });

  it('AI moderation analyze on com-003:write, read cached on com-003:read', () => {
    expect(gateFor('analyzeAi')).toEqual(['com-003:write']);
    expect(gateFor('getAiModerationResult')).toEqual(['com-003:read']);
  });

  it('push campaigns: reads on com-002:read, writes on com-002:write', () => {
    expect(gateFor('listPushCampaigns')).toEqual(['com-002:read']);
    expect(gateFor('createPushCampaign')).toEqual(['com-002:write']);
    expect(gateFor('patchPushCampaign')).toEqual(['com-002:write']);
    expect(gateFor('getPushAnalytics')).toEqual(['com-002:read']);
  });

  it('push devices: self-service on com-001', () => {
    expect(gateFor('registerPushDevice')).toEqual(['com-001:write']);
    expect(gateFor('listMyPushDevices')).toEqual(['com-001:read']);
    expect(gateFor('deregisterPushDevice')).toEqual(['com-001:write']);
  });
});
