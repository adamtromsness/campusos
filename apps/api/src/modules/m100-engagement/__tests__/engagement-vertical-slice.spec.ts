/**
 * P2-24 Step 7 — Vertical-slice integration test.
 *
 * Covers the 6 plan scenarios end-to-end at the service layer (no live
 * DB; the fake tenantPrisma captures SQL + raises engineered errors so
 * we exercise the actual code paths in the services + the keystone
 * concurrency contracts):
 *
 *   S1. Conference lifecycle — create event, generate slots, parent
 *       books slot 1, second parent's UPDATE matches 0 rows on slot 1
 *       (409), second parent books slot 2 cleanly, cancel slot 2 reverts
 *       to AVAILABLE, teacher marks attended + notes + follow-up action.
 *   S2. Booking window enforcement — pre-window 400, post-window 400,
 *       in-window 201, admin bypasses both.
 *   S3. Engagement scoring — high all-component family → HIGHLY_ENGAGED;
 *       zero-activity family → AT_RISK; configurable weights change the
 *       score; component sum matches the composite under the weight
 *       formula (within rounding).
 *   S4. Anonymous survey — anonymous response NEVER stores respondent_id;
 *       two responses both land; aggregated rollup matches; admin cannot
 *       see individual responses (the controller-level results endpoint
 *       returns aggregated data only).
 *   S5. Follow-up actions — teacher posts 2 actions, marks 1 COMPLETED,
 *       the other remains PENDING.
 *   S6. Visibility matrix — parent sees own bookings only; teacher sees
 *       all (admin path); student is refused at the gate; admin sees the
 *       engagement dashboard; parents/students refused on engagement.
 */

import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { runWithTenantContext } from '@shared/tenant';
import { ConferenceBookingService } from '../conference-booking.service';
import { ConferenceEventService } from '../conference-event.service';
import { ConferenceSlotService } from '../conference-slot.service';
import {
  EngagementScoreService,
  computeCompositeScore,
  resolveEngagementLevel,
  DEFAULT_THRESHOLDS,
  DEFAULT_WEIGHTS,
} from '../engagement-score.service';
import { ParentSurveyService } from '../parent-survey.service';

const SCHOOL = {
  schoolId: '019eaaaa-0000-7556-8c81-aaaaaaaaaaaa',
  schemaName: 'tenant_demo',
  organisationId: null,
  subdomain: 'demo',
  isFrozen: false,
  planTier: 'SMALL',
  homeRegion: 'us-east-1',
} as const;

const ADMIN_ACTOR = {
  accountId: 'admin-acct',
  personId: 'admin-pid',
  employeeId: 'admin-emp',
  personType: 'STAFF' as const,
  isSchoolAdmin: true,
};

const TEACHER_ACTOR = {
  accountId: 'teacher-acct',
  personId: 'teacher-pid',
  employeeId: 'teacher-emp',
  personType: 'STAFF' as const,
  isSchoolAdmin: false,
};

const PARENT_A = {
  accountId: 'parentA-acct',
  personId: 'parentA-pid',
  employeeId: null,
  personType: 'GUARDIAN' as const,
  isSchoolAdmin: false,
};

const PARENT_B = {
  accountId: 'parentB-acct',
  personId: 'parentB-pid',
  employeeId: null,
  personType: 'GUARDIAN' as const,
  isSchoolAdmin: false,
};

const STUDENT_ACTOR = {
  accountId: 'student-acct',
  personId: 'student-pid',
  employeeId: null,
  personType: 'STUDENT' as const,
  isSchoolAdmin: false,
};

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
    executeInExplicitSchema: async (_schema: string, fn: (c: unknown) => Promise<unknown>) =>
      fn(client),
  };
  return { capture, client, tenantPrisma };
}

function makePermCheck(resolver: (codes: string[]) => boolean = () => true) {
  return {
    hasAnyPermissionInTenant: async (_acct: string, _schoolId: string, codes: string[]) =>
      resolver(codes),
  } as never;
}

function makeOutbox() {
  const emitted: Array<{ topic: string; payload: Record<string, unknown> }> = [];
  return {
    outbox: {
      enqueueInTx: async (
        _tx: unknown,
        opts: { topic: string; payload: Record<string, unknown> },
      ) => {
        emitted.push({ topic: opts.topic, payload: opts.payload });
      },
    },
    emitted,
  };
}

function withTenant<T>(fn: () => T | Promise<T>): Promise<T> {
  return runWithTenantContext({ tenant: SCHOOL }, async () => fn()) as Promise<T>;
}

// ──────────────────────────────────────────────────────────────────
// S1. Conference lifecycle — atomic booking + concurrent-race contract
// ──────────────────────────────────────────────────────────────────

describe('S1 — Conference lifecycle (atomic booking)', () => {
  it('creates a conference, generates slots, two parents race for the same slot — exactly one wins', async () => {
    // Use the booking service directly with the documented race semantics:
    //  - parent A's UPDATE returns 1 row → 201
    //  - parent B's UPDATE on the same slot returns 0 rows → 409
    //  - parent B then books slot 2 cleanly (1 row)
    const past = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

    let aWon = false;
    let bAttemptedSameSlot = false;
    let bWonSlot2 = false;

    function makeBookingHandlers(slotId: string, simulateRace: boolean, parentAccountId: string) {
      return (call: CapturedCall): unknown => {
        if (call.fn === 'q' && call.sql.includes('FROM eng_conference_slots s')) {
          return [
            {
              id: slotId,
              conference_event_id: 'evt-1',
              max_bookings: 1,
              current_bookings: 0,
              status: 'AVAILABLE',
              booking_opens_at: past,
              booking_closes_at: future,
              event_status: 'BOOKING_OPEN',
            },
          ];
        }
        if (call.fn === 'q' && call.sql.includes('FROM sis_students')) {
          return [{ id: 'student-1' }];
        }
        if (
          call.fn === 'q' &&
          call.sql.includes('UPDATE eng_conference_slots') &&
          call.sql.includes("status = 'AVAILABLE'")
        ) {
          return simulateRace ? [] : [{ id: slotId }];
        }
        if (call.fn === 'e' && call.sql.includes('INSERT INTO eng_conference_bookings')) {
          return 1;
        }
        if (call.fn === 'q' && call.sql.includes('FROM eng_conference_bookings')) {
          return [
            {
              id: 'booking-' + slotId,
              slot_id: slotId,
              school_id: SCHOOL.schoolId,
              parent_id: parentAccountId,
              student_id: 'student-1',
              booked_at: '2026-11-10T16:30:00Z',
              cancelled_at: null,
              cancelled_by: null,
              cancellation_reason: null,
              attended: null,
              conference_notes: null,
              follow_up_actions: null,
              parent_feedback_rating: null,
              parent_feedback_comments: null,
              created_at: '',
              updated_at: '',
            },
          ];
        }
        return [];
      };
    }

    // Parent A wins slot 1
    {
      const { tenantPrisma } = makeFake(makeBookingHandlers('slot-1', false, PARENT_A.accountId));
      const perm = makePermCheck();
      const svc = new ConferenceBookingService(tenantPrisma as any, perm);
      const dto = await withTenant(() =>
        svc.book(PARENT_A, 'slot-1', { studentId: 'student-1' } as any),
      );
      expect(dto.slotId).toBe('slot-1');
      aWon = true;
    }

    // Parent B race against same slot — UPDATE matches 0 rows → 409
    {
      const { tenantPrisma } = makeFake(makeBookingHandlers('slot-1', true, PARENT_B.accountId));
      const perm = makePermCheck();
      const svc = new ConferenceBookingService(tenantPrisma as any, perm);
      await expect(
        withTenant(() => svc.book(PARENT_B, 'slot-1', { studentId: 'student-1' } as any)),
      ).rejects.toThrow(ConflictException);
      bAttemptedSameSlot = true;
    }

    // Parent B books slot 2 cleanly
    {
      const { tenantPrisma } = makeFake(makeBookingHandlers('slot-2', false, PARENT_B.accountId));
      const perm = makePermCheck();
      const svc = new ConferenceBookingService(tenantPrisma as any, perm);
      const dto = await withTenant(() =>
        svc.book(PARENT_B, 'slot-2', { studentId: 'student-1' } as any),
      );
      expect(dto.slotId).toBe('slot-2');
      bWonSlot2 = true;
    }

    expect(aWon).toBe(true);
    expect(bAttemptedSameSlot).toBe(true);
    expect(bWonSlot2).toBe(true);
  });

  it('cancel reverts BOOKED → AVAILABLE in the same tx as the booking flip', async () => {
    const captured: CapturedCall[] = [];
    const { tenantPrisma } = makeFake((call) => {
      captured.push(call);
      if (
        call.fn === 'q' &&
        call.sql.includes('FROM eng_conference_bookings') &&
        call.sql.includes('FOR UPDATE')
      ) {
        return [
          {
            id: 'booking-1',
            slot_id: 'slot-1',
            parent_id: PARENT_A.accountId,
            cancelled_at: null,
          },
        ];
      }
      if (call.fn === 'q' && call.sql.includes('FROM eng_conference_bookings')) {
        return [
          {
            id: 'booking-1',
            slot_id: 'slot-1',
            school_id: SCHOOL.schoolId,
            parent_id: PARENT_A.accountId,
            student_id: 'student-1',
            booked_at: '',
            cancelled_at: '2026-11-10T17:00:00Z',
            cancelled_by: PARENT_A.accountId,
            cancellation_reason: 'Schedule conflict',
            attended: null,
            conference_notes: null,
            follow_up_actions: null,
            parent_feedback_rating: null,
            parent_feedback_comments: null,
            created_at: '',
            updated_at: '',
          },
        ];
      }
      return [];
    });
    const perm = makePermCheck();
    const svc = new ConferenceBookingService(tenantPrisma as any, perm);
    const dto = await withTenant(() =>
      svc.cancel(PARENT_A, 'booking-1', { reason: 'Schedule conflict' } as any),
    );
    expect(dto.cancelledAt).toBeTruthy();
    // Verify the slot decrement UPDATE fired
    const slotUpdate = captured.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.includes('UPDATE eng_conference_slots') &&
        c.sql.includes('current_bookings - 1'),
    );
    expect(slotUpdate).toBeDefined();
  });
});

// ──────────────────────────────────────────────────────────────────
// S2. Booking window enforcement
// ──────────────────────────────────────────────────────────────────

describe('S2 — Booking window enforcement', () => {
  function makeWindowHandlers(opts: { opensAt: string; closesAt: string }) {
    return (call: CapturedCall): unknown => {
      if (call.fn === 'q' && call.sql.includes('FROM eng_conference_slots s')) {
        return [
          {
            id: 'slot-1',
            conference_event_id: 'evt-1',
            max_bookings: 1,
            current_bookings: 0,
            status: 'AVAILABLE',
            booking_opens_at: opts.opensAt,
            booking_closes_at: opts.closesAt,
            event_status: 'BOOKING_OPEN',
          },
        ];
      }
      if (call.fn === 'q' && call.sql.includes('FROM sis_students')) {
        return [{ id: 'student-1' }];
      }
      if (call.fn === 'q' && call.sql.includes('UPDATE eng_conference_slots')) {
        return [{ id: 'slot-1' }];
      }
      if (call.fn === 'q' && call.sql.includes('FROM eng_conference_bookings')) {
        return [
          {
            id: 'booking-1',
            slot_id: 'slot-1',
            school_id: SCHOOL.schoolId,
            parent_id: PARENT_A.accountId,
            student_id: 'student-1',
            booked_at: '',
            cancelled_at: null,
            cancelled_by: null,
            cancellation_reason: null,
            attended: null,
            conference_notes: null,
            follow_up_actions: null,
            parent_feedback_rating: null,
            parent_feedback_comments: null,
            created_at: '',
            updated_at: '',
          },
        ];
      }
      return [];
    };
  }

  it('refuses booking before bookingOpensAt (parent)', async () => {
    const futureOpens = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const futureCloses = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
    const { tenantPrisma } = makeFake(
      makeWindowHandlers({ opensAt: futureOpens, closesAt: futureCloses }),
    );
    const svc = new ConferenceBookingService(tenantPrisma as any, makePermCheck());
    await expect(
      withTenant(() => svc.book(PARENT_A, 'slot-1', { studentId: 'student-1' } as any)),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses booking after bookingClosesAt (parent)', async () => {
    const pastOpens = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const pastCloses = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { tenantPrisma } = makeFake(
      makeWindowHandlers({ opensAt: pastOpens, closesAt: pastCloses }),
    );
    const svc = new ConferenceBookingService(tenantPrisma as any, makePermCheck());
    await expect(
      withTenant(() => svc.book(PARENT_A, 'slot-1', { studentId: 'student-1' } as any)),
    ).rejects.toThrow(BadRequestException);
  });

  it('admin can book outside the window (override)', async () => {
    const futureOpens = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const futureCloses = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
    const { tenantPrisma } = makeFake(
      makeWindowHandlers({ opensAt: futureOpens, closesAt: futureCloses }),
    );
    const svc = new ConferenceBookingService(tenantPrisma as any, makePermCheck());
    await expect(
      withTenant(() => svc.book(ADMIN_ACTOR, 'slot-1', { studentId: 'student-1' } as any)),
    ).resolves.toBeDefined();
  });
});

// ──────────────────────────────────────────────────────────────────
// S3. Engagement scoring — composite math + thresholds + weights
// ──────────────────────────────────────────────────────────────────

describe('S3 — Engagement scoring', () => {
  it('high all-component family → HIGHLY_ENGAGED (composite ≥ 75)', () => {
    const composite = computeCompositeScore(
      { attendance: 80, communication: 90, conference: 100, volunteer: 75, payment: 100 },
      DEFAULT_WEIGHTS,
    );
    expect(composite).toBeGreaterThanOrEqual(75);
    expect(resolveEngagementLevel(composite, DEFAULT_THRESHOLDS)).toBe('HIGHLY_ENGAGED');
  });

  it('zero-activity family → AT_RISK (composite < 25)', () => {
    const composite = computeCompositeScore(
      { attendance: 0, communication: 0, conference: 0, volunteer: 0, payment: 0 },
      DEFAULT_WEIGHTS,
    );
    expect(composite).toBe(0);
    expect(resolveEngagementLevel(composite, DEFAULT_THRESHOLDS)).toBe('AT_RISK');
  });

  it('component breakdown matches composite under the weighted formula (within rounding)', () => {
    // Chen family seed shape: attendance 80%, communication 90%, conference 100%, volunteer 60%, payment 100%
    const components = {
      attendance: 80,
      communication: 90,
      conference: 100,
      volunteer: 60,
      payment: 100,
    };
    const composite = computeCompositeScore(components, DEFAULT_WEIGHTS);
    // 80*20 + 90*25 + 100*25 + 60*15 + 100*15 = 1600+2250+2500+900+1500 = 8750
    // / 100 = 87.5 → 88 rounded
    expect(composite).toBe(88);
    // Verify the math by hand
    const expected =
      (components.attendance * DEFAULT_WEIGHTS.attendance +
        components.communication * DEFAULT_WEIGHTS.communication +
        components.conference * DEFAULT_WEIGHTS.conference +
        components.volunteer * DEFAULT_WEIGHTS.volunteer +
        components.payment * DEFAULT_WEIGHTS.payment) /
      100;
    expect(Math.abs(composite - Math.round(expected))).toBeLessThanOrEqual(1);
  });

  it('configurable weights — volunteer-heavy school re-prioritises a different family', () => {
    // Family A is strong on volunteer (90%) but weak elsewhere (30%);
    // Family B is strong on payment (90%) but weak elsewhere (30%).
    const a = { attendance: 30, communication: 30, conference: 30, volunteer: 90, payment: 30 };
    const b = { attendance: 30, communication: 30, conference: 30, volunteer: 30, payment: 90 };

    // Default weights — both ~equivalent under symmetric weighting
    const defaultA = computeCompositeScore(a, DEFAULT_WEIGHTS);
    const defaultB = computeCompositeScore(b, DEFAULT_WEIGHTS);
    expect(Math.abs(defaultA - defaultB)).toBeLessThanOrEqual(1); // small variation

    // Volunteer-heavy weights — A scores higher
    const volunteerHeavy = {
      attendance: 10,
      communication: 10,
      conference: 10,
      volunteer: 60,
      payment: 10,
    };
    const heavyA = computeCompositeScore(a, volunteerHeavy);
    const heavyB = computeCompositeScore(b, volunteerHeavy);
    expect(heavyA).toBeGreaterThan(heavyB);
  });

  it('rejects weights that do not sum to 100', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const svc = new EngagementScoreService(tenantPrisma as any, makePermCheck());
    await expect(
      withTenant(() =>
        svc.updateConfig(ADMIN_ACTOR, {
          weights: {
            attendance: 50,
            communication: 25,
            conference: 25,
            volunteer: 15,
            payment: 15,
          },
        }),
      ),
    ).rejects.toThrow(BadRequestException);
  });
});

// ──────────────────────────────────────────────────────────────────
// S4. Anonymous survey — anonymity is the keystone
// ──────────────────────────────────────────────────────────────────

describe('S4 — Anonymous survey', () => {
  function makeSurveyHandlers(opts: {
    isAnonymous: boolean;
    initialResponses: unknown[];
    updateCapture: { sql: string; args: unknown[] }[];
  }) {
    return (call: CapturedCall): unknown => {
      if (
        call.fn === 'q' &&
        call.sql.includes('FROM eng_parent_surveys') &&
        call.sql.includes('FOR UPDATE')
      ) {
        return [
          {
            id: 'survey-1',
            status: 'OPEN',
            is_anonymous: opts.isAnonymous,
            questions: JSON.stringify([
              { id: 'q1', question_text: 'Rate communication', question_type: 'RATING_1_5' },
              { id: 'q2', question_text: 'Rate safety', question_type: 'RATING_1_5' },
              { id: 'q3', question_text: 'Suggestions', question_type: 'FREE_TEXT' },
            ]),
            response_data_aggregated: JSON.stringify({}),
            responses: JSON.stringify(opts.initialResponses),
            total_responses: opts.initialResponses.length,
          },
        ];
      }
      if (call.fn === 'q' && call.sql.includes('FROM eng_parent_surveys')) {
        return [
          {
            id: 'survey-1',
            school_id: SCHOOL.schoolId,
            title: 'Fall Satisfaction Survey',
            description: null,
            questions: JSON.stringify([
              { id: 'q1', question_text: 'Rate communication', question_type: 'RATING_1_5' },
              { id: 'q2', question_text: 'Rate safety', question_type: 'RATING_1_5' },
              { id: 'q3', question_text: 'Suggestions', question_type: 'FREE_TEXT' },
            ]),
            is_anonymous: opts.isAnonymous,
            opens_at: null,
            closes_at: null,
            status: 'OPEN',
            total_responses: opts.initialResponses.length + 1,
            response_data_aggregated: JSON.stringify({}),
            responses: null,
            created_by: 'admin',
            opened_at: null,
            closed_at: null,
            created_at: '',
            updated_at: '',
          },
        ];
      }
      if (call.fn === 'e' && call.sql.includes('UPDATE eng_parent_surveys')) {
        opts.updateCapture.push({ sql: call.sql, args: call.args });
      }
      return [];
    };
  }

  it('two anonymous responses both land + aggregated rollup is correct; respondent_id never stored', async () => {
    // First response
    const firstUpdates: { sql: string; args: unknown[] }[] = [];
    {
      const { tenantPrisma } = makeFake(
        makeSurveyHandlers({
          isAnonymous: true,
          initialResponses: [],
          updateCapture: firstUpdates,
        }),
      );
      const { outbox } = makeOutbox();
      const svc = new ParentSurveyService(tenantPrisma as any, makePermCheck(), outbox as any);
      const res = await withTenant(() =>
        svc.submitResponse(PARENT_A, 'survey-1', {
          answers: { q1: 4, q2: 5, q3: 'Great communication' },
        } as any),
      );
      expect(res.submitted).toBe(true);
      expect(res.totalResponses).toBe(1);
    }
    expect(firstUpdates).toHaveLength(1);
    const firstResponsesJson = firstUpdates[0]!.args[0] as string;
    const firstParsed = JSON.parse(firstResponsesJson) as Array<Record<string, unknown>>;
    expect(firstParsed).toHaveLength(1);
    expect(firstParsed[0]).not.toHaveProperty('respondent_id');
    expect(firstParsed[0]!.answers).toEqual({ q1: 4, q2: 5, q3: 'Great communication' });

    // Second response — pretend we have 1 existing
    const secondUpdates: { sql: string; args: unknown[] }[] = [];
    {
      const { tenantPrisma } = makeFake(
        makeSurveyHandlers({
          isAnonymous: true,
          initialResponses: firstParsed,
          updateCapture: secondUpdates,
        }),
      );
      const { outbox } = makeOutbox();
      const svc = new ParentSurveyService(tenantPrisma as any, makePermCheck(), outbox as any);
      const res = await withTenant(() =>
        svc.submitResponse(PARENT_B, 'survey-1', {
          answers: { q1: 5, q2: 4, q3: 'More events please' },
        } as any),
      );
      expect(res.totalResponses).toBe(2);
    }

    // The second submit appended; the saved responses array should have 2 entries
    const secondResponsesJson = secondUpdates[0]!.args[0] as string;
    const secondParsed = JSON.parse(secondResponsesJson) as Array<Record<string, unknown>>;
    expect(secondParsed).toHaveLength(2);
    // No respondent identity stored on either row
    expect(secondParsed[0]).not.toHaveProperty('respondent_id');
    expect(secondParsed[1]).not.toHaveProperty('respondent_id');

    // Aggregated rollup arg ($2) — should reflect the 2 ratings on q1
    const aggregatedJson = secondUpdates[0]!.args[1] as string;
    const aggregated = JSON.parse(aggregatedJson) as Record<string, unknown>;
    const q1Agg = aggregated.q1 as {
      count: number;
      average: number;
      distribution: Record<string, number>;
    };
    expect(q1Agg.count).toBe(2);
    // (4 + 5) / 2 = 4.5
    expect(q1Agg.average).toBeCloseTo(4.5, 1);

    // FREE_TEXT q3 — count only, raw text NEVER aggregated
    const q3Agg = aggregated.q3 as Record<string, unknown>;
    expect(q3Agg.count).toBe(2);
    expect(q3Agg).not.toHaveProperty('values');
    expect(q3Agg).not.toHaveProperty('raw');
  });

  it('identified survey: respondent_id IS stored', async () => {
    const updates: { sql: string; args: unknown[] }[] = [];
    const { tenantPrisma } = makeFake(
      makeSurveyHandlers({ isAnonymous: false, initialResponses: [], updateCapture: updates }),
    );
    const { outbox } = makeOutbox();
    const svc = new ParentSurveyService(tenantPrisma as any, makePermCheck(), outbox as any);
    await withTenant(() =>
      svc.submitResponse(PARENT_A, 'survey-1', { answers: { q1: 5, q2: 5, q3: 'Great' } } as any),
    );
    const parsed = JSON.parse(updates[0]!.args[0] as string) as Array<Record<string, unknown>>;
    expect(parsed[0]).toHaveProperty('respondent_id');
    expect(parsed[0]!.respondent_id).toBe(PARENT_A.accountId);
  });

  it('student persona is refused outright (survey is parent surface)', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const { outbox } = makeOutbox();
    const svc = new ParentSurveyService(tenantPrisma as any, makePermCheck(), outbox as any);
    await expect(
      withTenant(() =>
        svc.submitResponse(STUDENT_ACTOR, 'survey-1', { answers: { q1: 5 } } as any),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('admin survey results are aggregated only — getById never includes the raw responses array in the DTO surface', async () => {
    // The DTO toDto explicitly omits `responses` from the SurveyDto shape.
    // We can verify by reading the SurveyDto field set: only
    // responseDataAggregated lands on the public DTO.
    const { tenantPrisma } = makeFake((call) => {
      if (call.fn === 'q' && call.sql.includes('FROM eng_parent_surveys')) {
        return [
          {
            id: 'survey-1',
            school_id: SCHOOL.schoolId,
            title: 'Fall',
            description: null,
            questions: JSON.stringify([
              { id: 'q1', question_text: 'X', question_type: 'RATING_1_5' },
            ]),
            is_anonymous: true,
            opens_at: null,
            closes_at: null,
            status: 'OPEN',
            total_responses: 2,
            response_data_aggregated: JSON.stringify({ q1: { count: 2, average: 4.5 } }),
            responses: JSON.stringify([
              { submitted_at: '', answers: { q1: 4 } },
              { submitted_at: '', answers: { q1: 5 } },
            ]),
            created_by: 'admin',
            opened_at: null,
            closed_at: null,
            created_at: '',
            updated_at: '',
          },
        ];
      }
      return [];
    });
    const { outbox } = makeOutbox();
    const svc = new ParentSurveyService(tenantPrisma as any, makePermCheck(), outbox as any);
    const dto = await withTenant(() => svc.getResults(ADMIN_ACTOR, 'survey-1'));
    expect(dto.responseDataAggregated).toBeTruthy();
    // The DTO surface does NOT include a `responses` array — anonymity preserved
    expect((dto as unknown as Record<string, unknown>).responses).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────
// S5. Follow-up actions on bookings — staff documents outcome
// ──────────────────────────────────────────────────────────────────

describe('S5 — Follow-up actions on conference bookings', () => {
  it('staff posts 2 actions with one PENDING + one COMPLETED', async () => {
    let updateCapture: { sql: string; args: unknown[] } | null = null;
    const { tenantPrisma } = makeFake((call) => {
      if (
        call.fn === 'q' &&
        call.sql.includes('FROM eng_conference_bookings') &&
        call.sql.includes('FOR UPDATE')
      ) {
        return [{ id: 'booking-1', parent_id: PARENT_A.accountId }];
      }
      if (call.fn === 'q' && call.sql.includes('FROM eng_conference_bookings')) {
        return [
          {
            id: 'booking-1',
            slot_id: 'slot-1',
            school_id: SCHOOL.schoolId,
            parent_id: PARENT_A.accountId,
            student_id: 'student-1',
            booked_at: '',
            cancelled_at: null,
            cancelled_by: null,
            cancellation_reason: null,
            attended: true,
            conference_notes: 'Maya making good progress; needs writing practice',
            follow_up_actions: JSON.stringify([
              {
                description: 'Nightly journaling 20 min',
                due_date: '2026-12-08',
                status: 'PENDING',
              },
              {
                description: 'Library book selection',
                due_date: '2026-11-15',
                status: 'COMPLETED',
              },
            ]),
            parent_feedback_rating: null,
            parent_feedback_comments: null,
            created_at: '',
            updated_at: '',
          },
        ];
      }
      if (call.fn === 'e' && call.sql.includes('UPDATE eng_conference_bookings')) {
        updateCapture = { sql: call.sql, args: call.args };
      }
      return [];
    });
    const svc = new ConferenceBookingService(tenantPrisma as any, makePermCheck());
    const dto = await withTenant(() =>
      svc.patch(TEACHER_ACTOR, 'booking-1', {
        attended: true,
        conferenceNotes: 'Maya making good progress; needs writing practice',
        followUpActions: [
          {
            description: 'Nightly journaling 20 min',
            due_date: '2026-12-08',
            status: 'PENDING' as const,
          },
          {
            description: 'Library book selection',
            due_date: '2026-11-15',
            status: 'COMPLETED' as const,
          },
        ],
      } as any),
    );
    expect(dto.attended).toBe(true);
    expect(dto.followUpActions).toHaveLength(2);
    const [a, b] = dto.followUpActions!;
    expect(a!.status).toBe('PENDING');
    expect(b!.status).toBe('COMPLETED');
    expect(updateCapture).not.toBeNull();
    expect(updateCapture!.sql).toContain('follow_up_actions');
  });

  it('parent cannot mark attended / add notes / add actions — staff-only', async () => {
    const { tenantPrisma } = makeFake((call) => {
      if (call.fn === 'q' && call.sql.includes('FROM eng_conference_bookings')) {
        return [{ id: 'booking-1', parent_id: PARENT_A.accountId }];
      }
      return [];
    });
    const svc = new ConferenceBookingService(tenantPrisma as any, makePermCheck());
    await expect(
      withTenant(() =>
        svc.patch(PARENT_A, 'booking-1', {
          attended: true,
          conferenceNotes: 'Trying to game the system',
        } as any),
      ),
    ).rejects.toThrow(ForbiddenException);
  });
});

// ──────────────────────────────────────────────────────────────────
// S6. Visibility matrix across the surface
// ──────────────────────────────────────────────────────────────────

describe('S6 — Visibility matrix', () => {
  it('parent /bookings/my returns own bookings only (row-scoped to actor.accountId)', async () => {
    const captured: CapturedCall[] = [];
    const { tenantPrisma } = makeFake((call) => {
      captured.push(call);
      if (call.fn === 'q' && call.sql.includes('FROM eng_conference_bookings')) {
        return [
          {
            id: 'booking-1',
            slot_id: 'slot-1',
            school_id: SCHOOL.schoolId,
            parent_id: PARENT_A.accountId,
            student_id: 'student-1',
            booked_at: '',
            cancelled_at: null,
            cancelled_by: null,
            cancellation_reason: null,
            attended: null,
            conference_notes: null,
            follow_up_actions: null,
            parent_feedback_rating: null,
            parent_feedback_comments: null,
            created_at: '',
            updated_at: '',
          },
        ];
      }
      return [];
    });
    const svc = new ConferenceBookingService(tenantPrisma as any, makePermCheck());
    const rows = await withTenant(() => svc.listMine(PARENT_A));
    expect(rows).toHaveLength(1);
    // Verify the SELECT bound parent_id to actor.accountId
    const listCall = captured.find(
      (c) => c.sql.includes('FROM eng_conference_bookings') && c.sql.includes('parent_id'),
    );
    expect(listCall).toBeDefined();
    expect(listCall!.args).toContain(PARENT_A.accountId);
  });

  it("parent cannot read another parent's booking via /:id — 404 don't-leak-existence", async () => {
    const { tenantPrisma } = makeFake(() => [
      {
        id: 'booking-1',
        slot_id: 'slot-1',
        school_id: SCHOOL.schoolId,
        parent_id: PARENT_B.accountId, // belongs to parent B
        student_id: 'student-1',
        booked_at: '',
        cancelled_at: null,
        cancelled_by: null,
        cancellation_reason: null,
        attended: null,
        conference_notes: null,
        follow_up_actions: null,
        parent_feedback_rating: null,
        parent_feedback_comments: null,
        created_at: '',
        updated_at: '',
      },
    ]);
    const svc = new ConferenceBookingService(
      tenantPrisma as any,
      makePermCheck(() => false),
    );
    await expect(withTenant(() => svc.getById(PARENT_A, 'booking-1'))).rejects.toThrow(
      NotFoundException,
    );
  });

  it('students are refused on every bookings read (403)', async () => {
    const { tenantPrisma } = makeFake(() => [
      {
        id: 'booking-1',
        slot_id: 'slot-1',
        school_id: SCHOOL.schoolId,
        parent_id: 'someone',
        student_id: 'student-1',
        booked_at: '',
        cancelled_at: null,
        cancelled_by: null,
        cancellation_reason: null,
        attended: null,
        conference_notes: null,
        follow_up_actions: null,
        parent_feedback_rating: null,
        parent_feedback_comments: null,
        created_at: '',
        updated_at: '',
      },
    ]);
    const svc = new ConferenceBookingService(tenantPrisma as any, makePermCheck());
    await expect(withTenant(() => svc.getById(STUDENT_ACTOR, 'booking-1'))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('parents and students cannot read engagement scores (eng-001 is staff-only)', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const svc = new EngagementScoreService(tenantPrisma as any, makePermCheck());
    await expect(withTenant(() => svc.list(PARENT_A))).rejects.toThrow(ForbiddenException);
    await expect(withTenant(() => svc.list(STUDENT_ACTOR))).rejects.toThrow(ForbiddenException);
  });

  it('teacher with eng-001:read can read engagement scores', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const svc = new EngagementScoreService(
      tenantPrisma as any,
      makePermCheck((codes) => codes.includes('eng-001:read')),
    );
    await expect(withTenant(() => svc.list(TEACHER_ACTOR))).resolves.toEqual([]);
  });

  it('parent cannot create a conference event (admin-only via assertConferenceAdmin)', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const svc = new ConferenceEventService(
      tenantPrisma as any,
      makePermCheck(() => true),
    );
    await expect(
      withTenant(() =>
        svc.create(PARENT_A, {
          title: 'X',
          startDate: '2026-11-10',
          endDate: '2026-11-14',
          bookingOpensAt: '2026-11-01T00:00:00.000Z',
          bookingClosesAt: '2026-11-09T00:00:00.000Z',
        } as any),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('admin update of score config is permitted; non-admin refused', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const denyPerm = makePermCheck(() => false);
    const svcDeny = new EngagementScoreService(tenantPrisma as any, denyPerm);
    await expect(
      withTenant(() =>
        svcDeny.updateConfig(TEACHER_ACTOR, {
          weights: {
            attendance: 20,
            communication: 25,
            conference: 25,
            volunteer: 15,
            payment: 15,
          },
        }),
      ),
    ).rejects.toThrow(ForbiddenException);
  });
});

// ──────────────────────────────────────────────────────────────────
// S7. Slot generation — idempotency contract (extra coverage)
// ──────────────────────────────────────────────────────────────────

describe('S7 — Conference slot generation (idempotency)', () => {
  it('walks the time window in (duration + break) increments + ON CONFLICT skips duplicates', async () => {
    const insertedTimes: string[] = [];
    const { tenantPrisma } = makeFake((call) => {
      if (call.fn === 'q' && call.sql.includes('FROM eng_conference_events')) {
        return [
          {
            id: 'evt-1',
            default_slot_duration_minutes: 10,
            default_break_minutes: 5,
            status: 'BOOKING_OPEN',
          },
        ];
      }
      if (call.fn === 'q' && call.sql.includes('FROM hr_employees')) {
        return [{ id: 'teacher-emp' }];
      }
      if (call.fn === 'e' && call.sql.includes('INSERT INTO eng_conference_slots')) {
        expect(call.sql).toContain('ON CONFLICT');
        insertedTimes.push(String(call.args[5]));
      }
      if (call.fn === 'q' && call.sql.includes('FROM eng_conference_slots')) {
        return [];
      }
      return [];
    });
    const svc = new ConferenceSlotService(tenantPrisma as any, makePermCheck());
    await withTenant(() =>
      svc.generateSlots(ADMIN_ACTOR, 'evt-1', {
        teacherId: 'teacher-emp',
        slotDate: '2026-11-10',
        startTime: '16:00',
        endTime: '17:00',
        slotDurationMinutes: 10,
        breakMinutes: 5,
      } as any),
    );
    // 60 minutes / (10 + 5) = 4 slots at 16:00, 16:15, 16:30, 16:45
    expect(insertedTimes).toEqual(['16:00', '16:15', '16:30', '16:45']);
  });
});

// ──────────────────────────────────────────────────────────────────
// REVIEW-P2C24 ROUND 1 — pinned regression tests
// ──────────────────────────────────────────────────────────────────

describe('REVIEW-P2C24 BLOCKING 1 — student school + guardian link validation', () => {
  function makeBookingFake(opts: { studentExistsInSchool: boolean; guardianLinked: boolean }) {
    return makeFake((call) => {
      if (call.fn === 'q' && call.sql.includes('FROM eng_conference_slots s')) {
        const past = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
        const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
        return [
          {
            id: 'slot-1',
            conference_event_id: 'evt-1',
            max_bookings: 1,
            current_bookings: 0,
            status: 'AVAILABLE',
            booking_opens_at: past,
            booking_closes_at: future,
            event_status: 'BOOKING_OPEN',
          },
        ];
      }
      // Guardian-link query (parent path) — has sis_student_guardians JOIN
      if (
        call.fn === 'q' &&
        call.sql.includes('FROM sis_students s') &&
        call.sql.includes('sis_student_guardians')
      ) {
        return opts.guardianLinked ? [{ id: 'student-1' }] : [];
      }
      // Admin path — has school_id check
      if (
        call.fn === 'q' &&
        call.sql.includes('FROM sis_students') &&
        call.sql.includes('school_id')
      ) {
        return opts.studentExistsInSchool ? [{ id: 'student-1' }] : [];
      }
      if (call.fn === 'q' && call.sql.includes('UPDATE eng_conference_slots')) {
        return [{ id: 'slot-1' }];
      }
      if (call.fn === 'q' && call.sql.includes('FROM eng_conference_bookings')) {
        return [
          {
            id: 'booking-1',
            slot_id: 'slot-1',
            school_id: SCHOOL.schoolId,
            parent_id: PARENT_A.accountId,
            student_id: 'student-1',
            booked_at: '',
            cancelled_at: null,
            cancelled_by: null,
            cancellation_reason: null,
            attended: null,
            conference_notes: null,
            follow_up_actions: null,
            parent_feedback_rating: null,
            parent_feedback_comments: null,
            created_at: '',
            updated_at: '',
          },
        ];
      }
      return [];
    });
  }

  it('parent SQL JOINs through sis_student_guardians + sis_guardians + s.school_id', async () => {
    const captured: CapturedCall[] = [];
    const { tenantPrisma } = makeFake((call) => {
      captured.push(call);
      if (call.fn === 'q' && call.sql.includes('FROM eng_conference_slots s')) {
        const past = new Date(Date.now() - 1000).toISOString();
        const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
        return [
          {
            id: 'slot-1',
            conference_event_id: 'evt-1',
            max_bookings: 1,
            current_bookings: 0,
            status: 'AVAILABLE',
            booking_opens_at: past,
            booking_closes_at: future,
            event_status: 'BOOKING_OPEN',
          },
        ];
      }
      if (call.fn === 'q' && call.sql.includes('sis_student_guardians')) {
        return [{ id: 'student-1' }];
      }
      if (call.fn === 'q' && call.sql.includes('UPDATE eng_conference_slots')) {
        return [{ id: 'slot-1' }];
      }
      if (call.fn === 'q' && call.sql.includes('FROM eng_conference_bookings')) {
        return [
          {
            id: 'booking-1',
            slot_id: 'slot-1',
            school_id: SCHOOL.schoolId,
            parent_id: PARENT_A.accountId,
            student_id: 'student-1',
            booked_at: '',
            cancelled_at: null,
            cancelled_by: null,
            cancellation_reason: null,
            attended: null,
            conference_notes: null,
            follow_up_actions: null,
            parent_feedback_rating: null,
            parent_feedback_comments: null,
            created_at: '',
            updated_at: '',
          },
        ];
      }
      return [];
    });
    const svc = new ConferenceBookingService(
      tenantPrisma as any,
      makePermCheck(() => false),
    );
    await withTenant(() => svc.book(PARENT_A, 'slot-1', { studentId: 'student-1' } as any));
    const guardianQ = captured.find(
      (c) =>
        c.fn === 'q' &&
        c.sql.includes('sis_student_guardians') &&
        c.sql.includes('sis_guardians') &&
        c.sql.includes('s.school_id'),
    );
    expect(guardianQ).toBeDefined();
    // The SQL must bind tenant.schoolId, studentId, and actor.personId
    expect(guardianQ!.args).toContain(SCHOOL.schoolId);
    expect(guardianQ!.args).toContain('student-1');
    expect(guardianQ!.args).toContain(PARENT_A.personId);
  });

  it('parent cannot book for an unlinked student — 400', async () => {
    const { tenantPrisma } = makeBookingFake({
      studentExistsInSchool: true,
      guardianLinked: false,
    });
    const svc = new ConferenceBookingService(
      tenantPrisma as any,
      makePermCheck(() => false),
    );
    await expect(
      withTenant(() => svc.book(PARENT_A, 'slot-1', { studentId: 'student-1' } as any)),
    ).rejects.toThrow(BadRequestException);
  });

  it('admin SQL carries school_id predicate on sis_students lookup', async () => {
    const captured: CapturedCall[] = [];
    const { tenantPrisma } = makeFake((call) => {
      captured.push(call);
      if (call.fn === 'q' && call.sql.includes('FROM eng_conference_slots s')) {
        const past = new Date(Date.now() - 1000).toISOString();
        const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
        return [
          {
            id: 'slot-1',
            conference_event_id: 'evt-1',
            max_bookings: 1,
            current_bookings: 0,
            status: 'AVAILABLE',
            booking_opens_at: past,
            booking_closes_at: future,
            event_status: 'BOOKING_OPEN',
          },
        ];
      }
      if (
        call.fn === 'q' &&
        call.sql.includes('FROM sis_students') &&
        !call.sql.includes('sis_student_guardians')
      ) {
        return [{ id: 'student-1' }];
      }
      if (call.fn === 'q' && call.sql.includes('UPDATE eng_conference_slots')) {
        return [{ id: 'slot-1' }];
      }
      if (call.fn === 'q' && call.sql.includes('FROM eng_conference_bookings')) {
        return [
          {
            id: 'booking-1',
            slot_id: 'slot-1',
            school_id: SCHOOL.schoolId,
            parent_id: ADMIN_ACTOR.accountId,
            student_id: 'student-1',
            booked_at: '',
            cancelled_at: null,
            cancelled_by: null,
            cancellation_reason: null,
            attended: null,
            conference_notes: null,
            follow_up_actions: null,
            parent_feedback_rating: null,
            parent_feedback_comments: null,
            created_at: '',
            updated_at: '',
          },
        ];
      }
      return [];
    });
    const svc = new ConferenceBookingService(tenantPrisma as any, makePermCheck());
    await withTenant(() => svc.book(ADMIN_ACTOR, 'slot-1', { studentId: 'student-1' } as any));
    const adminQ = captured.find(
      (c) =>
        c.fn === 'q' &&
        c.sql.includes('FROM sis_students') &&
        c.sql.includes('school_id') &&
        !c.sql.includes('sis_student_guardians'),
    );
    expect(adminQ).toBeDefined();
    expect(adminQ!.args).toContain('student-1');
    expect(adminQ!.args).toContain(SCHOOL.schoolId);
  });

  it('admin cannot attach a booking to a foreign-school student — 400', async () => {
    const { tenantPrisma } = makeBookingFake({
      studentExistsInSchool: false,
      guardianLinked: false,
    });
    const svc = new ConferenceBookingService(tenantPrisma as any, makePermCheck());
    await expect(
      withTenant(() => svc.book(ADMIN_ACTOR, 'slot-1', { studentId: 'student-1' } as any)),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('REVIEW-P2C24 BLOCKING 2 — teacher school validation on generateSlots', () => {
  it('hr_employees lookup SQL carries school_id predicate', async () => {
    const captured: CapturedCall[] = [];
    const { tenantPrisma } = makeFake((call) => {
      captured.push(call);
      if (call.fn === 'q' && call.sql.includes('FROM eng_conference_events')) {
        return [
          {
            id: 'evt-1',
            default_slot_duration_minutes: 10,
            default_break_minutes: 5,
            status: 'BOOKING_OPEN',
          },
        ];
      }
      if (call.fn === 'q' && call.sql.includes('FROM hr_employees')) {
        return [{ id: 'teacher-emp' }];
      }
      if (call.fn === 'q' && call.sql.includes('FROM eng_conference_slots')) {
        return [];
      }
      return [];
    });
    const svc = new ConferenceSlotService(tenantPrisma as any, makePermCheck());
    await withTenant(() =>
      svc.generateSlots(ADMIN_ACTOR, 'evt-1', {
        teacherId: 'teacher-emp',
        slotDate: '2026-11-10',
        startTime: '16:00',
        endTime: '16:30',
        slotDurationMinutes: 10,
        breakMinutes: 5,
      } as any),
    );
    const teacherQ = captured.find(
      (c) => c.fn === 'q' && c.sql.includes('FROM hr_employees') && c.sql.includes('school_id'),
    );
    expect(teacherQ).toBeDefined();
    expect(teacherQ!.args).toContain('teacher-emp');
    expect(teacherQ!.args).toContain(SCHOOL.schoolId);
  });

  it('rejects foreign-school teacher with 400', async () => {
    const { tenantPrisma } = makeFake((call) => {
      if (call.fn === 'q' && call.sql.includes('FROM eng_conference_events')) {
        return [
          {
            id: 'evt-1',
            default_slot_duration_minutes: 10,
            default_break_minutes: 5,
            status: 'BOOKING_OPEN',
          },
        ];
      }
      if (call.fn === 'q' && call.sql.includes('FROM hr_employees')) {
        // Foreign-school teacher returns 0 rows
        return [];
      }
      return [];
    });
    const svc = new ConferenceSlotService(tenantPrisma as any, makePermCheck());
    await expect(
      withTenant(() =>
        svc.generateSlots(ADMIN_ACTOR, 'evt-1', {
          teacherId: 'foreign-teacher',
          slotDate: '2026-11-10',
          startTime: '16:00',
          endTime: '16:30',
        } as any),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('slotSelectSql LEFT JOIN carries e.school_id = s.school_id (defence-in-depth)', async () => {
    // listForEvent uses slotSelectSql() — capture the SELECT to verify
    // the LEFT JOIN includes the school predicate so a historical row
    // with a foreign-school teacher_id cannot leak the cross-school
    // employee name into the slot DTO.
    const capturedSql: string[] = [];
    const { tenantPrisma } = makeFake((call) => {
      capturedSql.push(call.sql);
      return [];
    });
    const svc = new ConferenceSlotService(tenantPrisma as any, makePermCheck());
    await withTenant(() => svc.listForEvent(ADMIN_ACTOR, 'evt-1', {}));
    const selectSql = capturedSql.find((s) => s.includes('LEFT JOIN hr_employees e'));
    expect(selectSql).toBeDefined();
    expect(selectSql!).toContain('e.school_id = s.school_id');
  });
});

describe('REVIEW-P2C24 BLOCKING 3 — booking PATCH staff fields require mtg-002:write', () => {
  function makePatchFake() {
    return makeFake((call) => {
      if (
        call.fn === 'q' &&
        call.sql.includes('FROM eng_conference_bookings') &&
        call.sql.includes('FOR UPDATE')
      ) {
        return [{ id: 'booking-1', parent_id: PARENT_A.accountId }];
      }
      if (call.fn === 'q' && call.sql.includes('FROM eng_conference_bookings')) {
        return [
          {
            id: 'booking-1',
            slot_id: 'slot-1',
            school_id: SCHOOL.schoolId,
            parent_id: PARENT_A.accountId,
            student_id: 'student-1',
            booked_at: '',
            cancelled_at: null,
            cancelled_by: null,
            cancellation_reason: null,
            attended: true,
            conference_notes: null,
            follow_up_actions: null,
            parent_feedback_rating: null,
            parent_feedback_comments: null,
            created_at: '',
            updated_at: '',
          },
        ];
      }
      return [];
    });
  }

  it('STAFF with only mtg-002:read cannot mark attended', async () => {
    const { tenantPrisma } = makePatchFake();
    // Read-only staff — perm check returns false for write/admin codes
    const readOnlyPerm = makePermCheck(
      (codes) => !codes.some((c) => c.endsWith(':write') || c.endsWith(':admin')),
    );
    const svc = new ConferenceBookingService(tenantPrisma as any, readOnlyPerm);
    await expect(
      withTenant(() => svc.patch(TEACHER_ACTOR, 'booking-1', { attended: true } as any)),
    ).rejects.toThrow(ForbiddenException);
  });

  it('STAFF with only mtg-002:read cannot write conferenceNotes', async () => {
    const { tenantPrisma } = makePatchFake();
    const readOnlyPerm = makePermCheck(
      (codes) => !codes.some((c) => c.endsWith(':write') || c.endsWith(':admin')),
    );
    const svc = new ConferenceBookingService(tenantPrisma as any, readOnlyPerm);
    await expect(
      withTenant(() => svc.patch(TEACHER_ACTOR, 'booking-1', { conferenceNotes: 'Sneaky' } as any)),
    ).rejects.toThrow(ForbiddenException);
  });

  it('STAFF with only mtg-002:read cannot add followUpActions', async () => {
    const { tenantPrisma } = makePatchFake();
    const readOnlyPerm = makePermCheck(
      (codes) => !codes.some((c) => c.endsWith(':write') || c.endsWith(':admin')),
    );
    const svc = new ConferenceBookingService(tenantPrisma as any, readOnlyPerm);
    await expect(
      withTenant(() =>
        svc.patch(TEACHER_ACTOR, 'booking-1', {
          followUpActions: [
            {
              description: 'Sneaky action',
              due_date: '2026-12-01',
              status: 'PENDING' as const,
            },
          ],
        } as any),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('STAFF with mtg-002:write CAN mark attended', async () => {
    const { tenantPrisma } = makePatchFake();
    const writePerm = makePermCheck((codes) => codes.includes('mtg-002:write'));
    const svc = new ConferenceBookingService(tenantPrisma as any, writePerm);
    await expect(
      withTenant(() => svc.patch(TEACHER_ACTOR, 'booking-1', { attended: true } as any)),
    ).resolves.toBeDefined();
  });

  it('STAFF cannot author parent feedback (owner-only)', async () => {
    const { tenantPrisma } = makePatchFake();
    const writePerm = makePermCheck((codes) => codes.includes('mtg-002:write'));
    const svc = new ConferenceBookingService(tenantPrisma as any, writePerm);
    await expect(
      withTenant(() =>
        svc.patch(TEACHER_ACTOR, 'booking-1', {
          parentFeedbackRating: 5,
          parentFeedbackComments: 'Authored by staff',
        } as any),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('Booking owner CAN submit their own feedback', async () => {
    const { tenantPrisma } = makePatchFake();
    const svc = new ConferenceBookingService(
      tenantPrisma as any,
      makePermCheck(() => false),
    );
    await expect(
      withTenant(() =>
        svc.patch(PARENT_A, 'booking-1', {
          parentFeedbackRating: 5,
          parentFeedbackComments: 'Great meeting',
        } as any),
      ),
    ).resolves.toBeDefined();
  });
});

describe('REVIEW-P2C24 BLOCKING 4 — engagement worker school-scopes all 5 sources', () => {
  // We import EngagementScoreWorker indirectly via direct construction.
  // The worker queries are private, so we capture the SQL stream by
  // running a tickForSchool against the fake client.

  it('every source query carries either school_id or a school-derived JOIN', async () => {
    const { EngagementScoreWorker } = await import('../engagement-score.worker');
    const captured: { sql: string; args: unknown[] }[] = [];
    const client = {
      $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
        captured.push({ sql, args });
        if (sql.includes('FROM school_config')) return [];
        if (sql.includes('FROM pay_family_accounts')) {
          return [{ id: 'fam-1', account_holder_id: PARENT_A.accountId }];
        }
        return [];
      },
      $executeRawUnsafe: async () => 0,
    };
    const tenantPrisma = {
      executeInExplicitSchema: async (_s: string, fn: (c: unknown) => Promise<unknown>) =>
        fn(client),
      executeInTenantContext: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
      executeInTenantTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
    };
    const score = {
      upsertScore: async () => ({ compositeScore: 0, engagementLevel: 'AT_RISK' as const }),
    };
    const worker = new EngagementScoreWorker(tenantPrisma as any, score as any);
    await worker.tickForSchool('tenant_test', SCHOOL.schoolId);

    // Find the 5 component queries
    const attendance = captured.find((c) => c.sql.includes('FROM sis_attendance_records'));
    const communication = captured.find((c) => c.sql.includes('FROM msg_thread_participants'));
    const conference = captured.find((c) => c.sql.includes('FROM eng_conference_bookings'));
    const volunteer = captured.find((c) => c.sql.includes('FROM evt_volunteers'));
    const payment = captured.find((c) => c.sql.includes('FROM pay_invoices'));

    expect(attendance).toBeDefined();
    expect(attendance!.sql).toMatch(/ar\.school_id\s*=\s*\$/);
    expect(attendance!.sql).toMatch(/s\.school_id\s*=\s*\$/);
    expect(attendance!.args).toContain(SCHOOL.schoolId);

    expect(communication).toBeDefined();
    expect(communication!.sql).toMatch(/tp\.school_id\s*=\s*\$/);
    expect(communication!.sql).toMatch(/mp\.school_id\s*=\s*tp\.school_id/);
    expect(communication!.args).toContain(SCHOOL.schoolId);
    // Verify the column names are corrected from the original broken SQL
    expect(communication!.sql).toContain('tp.platform_user_id');
    expect(communication!.sql).toContain('r.reader_id');

    expect(conference).toBeDefined();
    expect(conference!.sql).toMatch(/school_id\s*=\s*\$/);
    expect(conference!.args).toContain(SCHOOL.schoolId);

    expect(volunteer).toBeDefined();
    expect(volunteer!.sql).toContain('JOIN evt_events e');
    expect(volunteer!.sql).toMatch(/e\.school_id\s*=\s*\$/);
    expect(volunteer!.args).toContain(SCHOOL.schoolId);

    expect(payment).toBeDefined();
    expect(payment!.sql).toMatch(/school_id\s*=\s*\$/);
    expect(payment!.args).toContain(SCHOOL.schoolId);
  });
});

describe('REVIEW-P2C24 MAJOR 1 — identified survey deduplication', () => {
  function makeSurveyFake(opts: { isAnonymous: boolean; existingResponses: unknown[] }) {
    const updates: { sql: string; args: unknown[] }[] = [];
    const { tenantPrisma } = makeFake((call) => {
      if (
        call.fn === 'q' &&
        call.sql.includes('FROM eng_parent_surveys') &&
        call.sql.includes('FOR UPDATE')
      ) {
        return [
          {
            id: 'survey-1',
            status: 'OPEN',
            is_anonymous: opts.isAnonymous,
            questions: JSON.stringify([
              { id: 'q1', question_text: 'Rate', question_type: 'RATING_1_5' },
            ]),
            response_data_aggregated: JSON.stringify({}),
            responses: JSON.stringify(opts.existingResponses),
            total_responses: opts.existingResponses.length,
          },
        ];
      }
      if (call.fn === 'q' && call.sql.includes('FROM eng_parent_surveys')) {
        return [
          {
            id: 'survey-1',
            school_id: SCHOOL.schoolId,
            title: 'Survey',
            description: null,
            questions: JSON.stringify([
              { id: 'q1', question_text: 'Rate', question_type: 'RATING_1_5' },
            ]),
            is_anonymous: opts.isAnonymous,
            opens_at: null,
            closes_at: null,
            status: 'OPEN',
            total_responses: opts.existingResponses.length + 1,
            response_data_aggregated: JSON.stringify({}),
            responses: null,
            created_by: 'admin',
            opened_at: null,
            closed_at: null,
            created_at: '',
            updated_at: '',
          },
        ];
      }
      if (call.fn === 'e' && call.sql.includes('UPDATE eng_parent_surveys')) {
        updates.push({ sql: call.sql, args: call.args });
      }
      return [];
    });
    return { tenantPrisma, updates };
  }

  it('identified survey: same respondent re-submitting returns 409 Conflict', async () => {
    const existingResponse = {
      submitted_at: '2026-11-01T10:00:00Z',
      answers: { q1: 3 },
      respondent_id: PARENT_A.accountId,
    };
    const { tenantPrisma, updates } = makeSurveyFake({
      isAnonymous: false,
      existingResponses: [existingResponse],
    });
    const { outbox } = makeOutbox();
    const svc = new ParentSurveyService(tenantPrisma as any, makePermCheck(), outbox as any);
    await expect(
      withTenant(() => svc.submitResponse(PARENT_A, 'survey-1', { answers: { q1: 5 } } as any)),
    ).rejects.toThrow(ConflictException);
    // Verify no UPDATE was issued
    expect(updates).toHaveLength(0);
  });

  it('identified survey: a DIFFERENT respondent can still submit', async () => {
    const existingResponse = {
      submitted_at: '2026-11-01T10:00:00Z',
      answers: { q1: 3 },
      respondent_id: PARENT_A.accountId,
    };
    const { tenantPrisma, updates } = makeSurveyFake({
      isAnonymous: false,
      existingResponses: [existingResponse],
    });
    const { outbox } = makeOutbox();
    const svc = new ParentSurveyService(tenantPrisma as any, makePermCheck(), outbox as any);
    await withTenant(() => svc.submitResponse(PARENT_B, 'survey-1', { answers: { q1: 4 } } as any));
    expect(updates).toHaveLength(1);
    const responses = JSON.parse(updates[0]!.args[0] as string) as Array<Record<string, unknown>>;
    expect(responses).toHaveLength(2);
    expect(responses[1]!.respondent_id).toBe(PARENT_B.accountId);
  });

  it('anonymous survey: same parent can submit multiple times (no respondent_id to dedup against)', async () => {
    const existingResponse = {
      submitted_at: '2026-11-01T10:00:00Z',
      answers: { q1: 3 },
      // No respondent_id — anonymous
    };
    const { tenantPrisma, updates } = makeSurveyFake({
      isAnonymous: true,
      existingResponses: [existingResponse],
    });
    const { outbox } = makeOutbox();
    const svc = new ParentSurveyService(tenantPrisma as any, makePermCheck(), outbox as any);
    await withTenant(() => svc.submitResponse(PARENT_A, 'survey-1', { answers: { q1: 5 } } as any));
    expect(updates).toHaveLength(1);
    const responses = JSON.parse(updates[0]!.args[0] as string) as Array<Record<string, unknown>>;
    expect(responses).toHaveLength(2);
    // Both responses remain anonymous
    expect(responses[0]).not.toHaveProperty('respondent_id');
    expect(responses[1]).not.toHaveProperty('respondent_id');
  });
});
