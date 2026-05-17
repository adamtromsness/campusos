import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { runWithTenantContext } from '@shared/tenant/tenant.context';
import {
  assertConferenceAdmin,
  assertEngagementAdmin,
  assertEngagementReader,
  isUniqueViolation,
} from '../access';
import {
  deterministicConferenceBookingOpenEventId,
  deterministicSurveyOpenedEventId,
} from '../event-ids';
import {
  computeCompositeScore,
  resolveEngagementLevel,
  DEFAULT_THRESHOLDS,
  DEFAULT_WEIGHTS,
  EngagementScoreService,
} from '../engagement-score.service';
import { ConferenceBookingService } from '../conference-booking.service';
import { ConferenceSlotService } from '../conference-slot.service';
import { ConferenceEventService } from '../conference-event.service';
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
  accountId: 'admin-account',
  personId: 'admin-person',
  employeeId: 'admin-emp',
  personType: 'STAFF' as const,
  isSchoolAdmin: true,
};

const TEACHER_ACTOR = {
  accountId: 'teacher-account',
  personId: 'teacher-person',
  employeeId: 'teacher-emp',
  personType: 'STAFF' as const,
  isSchoolAdmin: false,
};

const PARENT_ACTOR = {
  accountId: 'parent-account',
  personId: 'parent-person',
  employeeId: null,
  personType: 'GUARDIAN' as const,
  isSchoolAdmin: false,
};

const OTHER_PARENT_ACTOR = {
  accountId: 'parent-2-account',
  personId: 'parent-2-person',
  employeeId: null,
  personType: 'GUARDIAN' as const,
  isSchoolAdmin: false,
};

const STUDENT_ACTOR = {
  accountId: 'student-account',
  personId: 'student-person',
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

function makeOutbox() {
  const emitted: Array<{
    topic: string;
    sourceModule: string;
    key?: string;
    eventId?: string;
    payload: Record<string, unknown>;
  }> = [];
  const outbox = {
    enqueueInTx: async (_tx: unknown, opts: any) => {
      emitted.push({
        topic: opts.topic,
        sourceModule: opts.sourceModule,
        key: opts.key,
        eventId: opts.eventId,
        payload: opts.payload,
      });
    },
  };
  return { outbox, emitted };
}

function makePermCheck(resolver: (accountId: string, codes: string[]) => boolean = () => false) {
  return {
    hasAnyPermissionInTenant: async (accountId: string, _schoolId: string, codes: string[]) =>
      resolver(accountId, codes),
  } as never;
}

function withTenant<T>(fn: () => T | Promise<T>): Promise<T> {
  return runWithTenantContext({ tenant: SCHOOL }, async () => fn()) as Promise<T>;
}

// ─────────────────────────────────────────────────────────────────
// 1. Access helpers
// ─────────────────────────────────────────────────────────────────

describe('engagement access helpers', () => {
  it('assertConferenceAdmin allows admin bypass', async () => {
    const perm = makePermCheck(() => false);
    await expect(
      withTenant(() => assertConferenceAdmin(ADMIN_ACTOR, perm, 'X')),
    ).resolves.not.toThrow();
  });

  it('assertConferenceAdmin allows teacher with mtg-002:write', async () => {
    const perm = makePermCheck((_, codes) => codes.includes('mtg-002:write'));
    await expect(
      withTenant(() => assertConferenceAdmin(TEACHER_ACTOR, perm, 'X')),
    ).resolves.not.toThrow();
  });

  it('assertConferenceAdmin refuses parent (GUARDIAN)', async () => {
    const perm = makePermCheck(() => true);
    await expect(withTenant(() => assertConferenceAdmin(PARENT_ACTOR, perm, 'X'))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('assertConferenceAdmin refuses student', async () => {
    const perm = makePermCheck(() => true);
    await expect(withTenant(() => assertConferenceAdmin(STUDENT_ACTOR, perm, 'X'))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('assertEngagementAdmin requires eng-001:admin', async () => {
    const allow = makePermCheck((_, codes) => codes.includes('eng-001:admin'));
    const deny = makePermCheck(() => false);
    await expect(
      withTenant(() => assertEngagementAdmin(TEACHER_ACTOR, allow, 'X')),
    ).resolves.not.toThrow();
    await expect(withTenant(() => assertEngagementAdmin(TEACHER_ACTOR, deny, 'X'))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('assertEngagementReader refuses parents + students', async () => {
    const perm = makePermCheck(() => true);
    await expect(withTenant(() => assertEngagementReader(PARENT_ACTOR, perm, 'X'))).rejects.toThrow(
      ForbiddenException,
    );
    await expect(
      withTenant(() => assertEngagementReader(STUDENT_ACTOR, perm, 'X')),
    ).rejects.toThrow(ForbiddenException);
  });

  it('isUniqueViolation matches Prisma P2002', () => {
    expect(isUniqueViolation({ code: 'P2002' })).toBe(true);
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
    expect(isUniqueViolation({ code: 'P2025' })).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────
// 2. Deterministic event ids
// ─────────────────────────────────────────────────────────────────

describe('deterministic event ids', () => {
  it('booking_open id is v5-shape UUID', () => {
    const id = deterministicConferenceBookingOpenEventId('019dabcd-0000-7000-8000-000000000001');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(id[14]).toBe('5');
    expect(['8', '9', 'a', 'b']).toContain(id[19]!.toLowerCase());
  });

  it('survey_opened id is v5-shape UUID', () => {
    const id = deterministicSurveyOpenedEventId('019dabcd-0000-7000-8000-000000000001');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(id[14]).toBe('5');
  });

  it('both helpers are stable across calls', () => {
    expect(deterministicConferenceBookingOpenEventId('e1')).toBe(
      deterministicConferenceBookingOpenEventId('e1'),
    );
    expect(deterministicSurveyOpenedEventId('s1')).toBe(deterministicSurveyOpenedEventId('s1'));
  });

  it('booking_open and survey_opened produce distinct ids for the same input', () => {
    const a = deterministicConferenceBookingOpenEventId('00000000-0000-0000-0000-000000000001');
    const b = deterministicSurveyOpenedEventId('00000000-0000-0000-0000-000000000001');
    expect(a).not.toBe(b);
  });
});

// ─────────────────────────────────────────────────────────────────
// 3. Engagement score math
// ─────────────────────────────────────────────────────────────────

describe('engagement score math', () => {
  it('computes weighted composite from 5 components with default weights', () => {
    const composite = computeCompositeScore(
      { attendance: 80, communication: 90, conference: 100, volunteer: 75, payment: 100 },
      DEFAULT_WEIGHTS,
    );
    // 80*20 + 90*25 + 100*25 + 75*15 + 100*15 = 1600 + 2250 + 2500 + 1125 + 1500 = 8975
    // / 100 = 89.75 → 90 rounded
    expect(composite).toBe(90);
  });

  it('high activity across all components → HIGHLY_ENGAGED', () => {
    const composite = computeCompositeScore(
      { attendance: 90, communication: 95, conference: 100, volunteer: 80, payment: 100 },
      DEFAULT_WEIGHTS,
    );
    expect(composite).toBeGreaterThanOrEqual(75);
    expect(resolveEngagementLevel(composite, DEFAULT_THRESHOLDS)).toBe('HIGHLY_ENGAGED');
  });

  it('zero activity → AT_RISK', () => {
    const composite = computeCompositeScore(
      { attendance: 0, communication: 0, conference: 0, volunteer: 0, payment: 0 },
      DEFAULT_WEIGHTS,
    );
    expect(composite).toBe(0);
    expect(resolveEngagementLevel(composite, DEFAULT_THRESHOLDS)).toBe('AT_RISK');
  });

  it('configurable weights change the score', () => {
    const components = {
      attendance: 100,
      communication: 0,
      conference: 0,
      volunteer: 0,
      payment: 0,
    };
    const attendanceHeavy = computeCompositeScore(components, {
      attendance: 80,
      communication: 5,
      conference: 5,
      volunteer: 5,
      payment: 5,
    });
    const attendanceLight = computeCompositeScore(components, {
      attendance: 5,
      communication: 80,
      conference: 5,
      volunteer: 5,
      payment: 5,
    });
    expect(attendanceHeavy).toBeGreaterThan(attendanceLight);
  });

  it('component clamping protects against out-of-range inputs', () => {
    const composite = computeCompositeScore(
      { attendance: 150, communication: -10, conference: 50, volunteer: 50, payment: 50 },
      DEFAULT_WEIGHTS,
    );
    // 150 clamped to 100, -10 clamped to 0
    // 100*20 + 0*25 + 50*25 + 50*15 + 50*15 = 2000+0+1250+750+750=4750 / 100 = 47.5 → 48
    expect(composite).toBe(48);
  });

  it('thresholds boundary at exactly 75 → HIGHLY_ENGAGED', () => {
    expect(resolveEngagementLevel(75, DEFAULT_THRESHOLDS)).toBe('HIGHLY_ENGAGED');
    expect(resolveEngagementLevel(74, DEFAULT_THRESHOLDS)).toBe('ENGAGED');
    expect(resolveEngagementLevel(50, DEFAULT_THRESHOLDS)).toBe('ENGAGED');
    expect(resolveEngagementLevel(49, DEFAULT_THRESHOLDS)).toBe('MINIMAL');
    expect(resolveEngagementLevel(25, DEFAULT_THRESHOLDS)).toBe('MINIMAL');
    expect(resolveEngagementLevel(24, DEFAULT_THRESHOLDS)).toBe('AT_RISK');
  });
});

// ─────────────────────────────────────────────────────────────────
// 4. Conference event service
// ─────────────────────────────────────────────────────────────────

describe('ConferenceEventService.create', () => {
  it('refuses endDate before startDate', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const perm = makePermCheck(() => true);
    const svc = new ConferenceEventService(tenantPrisma as any, perm as any);
    await expect(
      withTenant(() =>
        svc.create(ADMIN_ACTOR, {
          title: 'X',
          startDate: '2026-05-10',
          endDate: '2026-05-08',
          bookingOpensAt: '2026-05-01T00:00:00.000Z',
          bookingClosesAt: '2026-05-05T00:00:00.000Z',
        } as any),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses bookingClosesAt <= bookingOpensAt', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const perm = makePermCheck(() => true);
    const svc = new ConferenceEventService(tenantPrisma as any, perm as any);
    await expect(
      withTenant(() =>
        svc.create(ADMIN_ACTOR, {
          title: 'X',
          startDate: '2026-05-10',
          endDate: '2026-05-12',
          bookingOpensAt: '2026-05-05T00:00:00.000Z',
          bookingClosesAt: '2026-05-05T00:00:00.000Z',
        } as any),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('admin path issues an INSERT then a SELECT for the new row', async () => {
    const { capture, tenantPrisma } = makeFake((call) => {
      if (call.fn === 'q') {
        // SELECT for getById after create
        return [
          {
            id: 'event-1',
            school_id: SCHOOL.schoolId,
            title: 'PTC Week',
            description: null,
            start_date: '2026-05-10',
            end_date: '2026-05-12',
            booking_opens_at: '2026-05-05T00:00:00Z',
            booking_closes_at: '2026-05-09T00:00:00Z',
            default_slot_duration_minutes: 10,
            default_break_minutes: 5,
            status: 'DRAFT',
            created_by: 'admin-account',
            created_at: '2026-05-01T00:00:00Z',
            updated_at: '2026-05-01T00:00:00Z',
          },
        ];
      }
      return 1;
    });
    const perm = makePermCheck(() => true);
    const svc = new ConferenceEventService(tenantPrisma as any, perm as any);
    const dto = await withTenant(() =>
      svc.create(ADMIN_ACTOR, {
        title: 'PTC Week',
        startDate: '2026-05-10',
        endDate: '2026-05-12',
        bookingOpensAt: '2026-05-05T00:00:00.000Z',
        bookingClosesAt: '2026-05-09T00:00:00.000Z',
      } as any),
    );
    expect(dto.status).toBe('DRAFT');
    const insert = capture.find((c) => c.fn === 'e');
    expect(insert?.sql).toContain('INSERT INTO eng_conference_events');
  });

  it('refuses an illegal status transition COMPLETED → BOOKING_OPEN', async () => {
    let phase = 0;
    const { tenantPrisma } = makeFake((call) => {
      if (call.fn === 'q' && phase === 0) {
        phase = 1;
        // locked SELECT
        return [
          {
            status: 'COMPLETED',
            start_date: '2026-05-10',
            end_date: '2026-05-12',
            booking_opens_at: '2026-05-05T00:00:00Z',
            booking_closes_at: '2026-05-09T00:00:00Z',
          },
        ];
      }
      return [];
    });
    const perm = makePermCheck(() => true);
    const svc = new ConferenceEventService(tenantPrisma as any, perm as any);
    await expect(
      withTenant(() => svc.patch(ADMIN_ACTOR, 'event-1', { status: 'BOOKING_OPEN' } as any)),
    ).rejects.toThrow(BadRequestException);
  });
});

// ─────────────────────────────────────────────────────────────────
// 5. Conference slot service — atomic booking pattern lives here
// ─────────────────────────────────────────────────────────────────

describe('ConferenceSlotService.generateSlots', () => {
  it('walks the time window in (duration+break) increments', async () => {
    const inserts: string[] = [];
    const { tenantPrisma } = makeFake((call) => {
      if (call.fn === 'q') {
        if (call.sql.includes('FROM eng_conference_events')) {
          return [
            {
              id: 'event-1',
              default_slot_duration_minutes: 10,
              default_break_minutes: 5,
              status: 'BOOKING_OPEN',
            },
          ];
        }
        if (call.sql.includes('FROM hr_employees')) {
          return [{ id: 'teacher-emp' }];
        }
        if (call.sql.includes('eng_conference_slots')) {
          // listForEvent at end — return what we inserted
          return inserts.map((t, i) => ({
            id: 'slot-' + i,
            conference_event_id: 'event-1',
            school_id: SCHOOL.schoolId,
            teacher_id: 'teacher-emp',
            teacher_name: 'James Rivera',
            slot_date: '2026-05-10',
            start_time: t,
            end_time: t,
            location: null,
            meeting_url: null,
            status: 'AVAILABLE',
            max_bookings: 1,
            current_bookings: 0,
            notes: null,
            created_at: '',
            updated_at: '',
          }));
        }
      }
      if (call.fn === 'e' && call.sql.includes('INSERT INTO eng_conference_slots')) {
        inserts.push(String(call.args[5]));
      }
      return [];
    });
    const perm = makePermCheck(() => true);
    const svc = new ConferenceSlotService(tenantPrisma as any, perm as any);
    await withTenant(() =>
      svc.generateSlots(ADMIN_ACTOR, 'event-1', {
        teacherId: 'teacher-emp',
        slotDate: '2026-05-10',
        startTime: '16:00',
        endTime: '17:00',
        slotDurationMinutes: 10,
        breakMinutes: 5,
      } as any),
    );
    // 16:00, 16:15, 16:30, 16:45 — 4 slots over 1h with 10+5 increments
    expect(inserts).toContain('16:00');
    expect(inserts).toContain('16:15');
    expect(inserts).toContain('16:30');
    expect(inserts).toContain('16:45');
  });

  it('refuses endTime <= startTime', async () => {
    const { tenantPrisma } = makeFake((call) => {
      if (call.fn === 'q' && call.sql.includes('FROM eng_conference_events')) {
        return [
          {
            id: 'event-1',
            default_slot_duration_minutes: 10,
            default_break_minutes: 5,
            status: 'BOOKING_OPEN',
          },
        ];
      }
      if (call.fn === 'q' && call.sql.includes('FROM hr_employees')) {
        return [{ id: 'teacher-emp' }];
      }
      return [];
    });
    const perm = makePermCheck(() => true);
    const svc = new ConferenceSlotService(tenantPrisma as any, perm as any);
    await expect(
      withTenant(() =>
        svc.generateSlots(ADMIN_ACTOR, 'event-1', {
          teacherId: 'teacher-emp',
          slotDate: '2026-05-10',
          startTime: '17:00',
          endTime: '16:00',
        } as any),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses generation on a COMPLETED conference', async () => {
    const { tenantPrisma } = makeFake((call) => {
      if (call.fn === 'q' && call.sql.includes('FROM eng_conference_events')) {
        return [
          {
            id: 'event-1',
            default_slot_duration_minutes: 10,
            default_break_minutes: 5,
            status: 'COMPLETED',
          },
        ];
      }
      return [];
    });
    const perm = makePermCheck(() => true);
    const svc = new ConferenceSlotService(tenantPrisma as any, perm as any);
    await expect(
      withTenant(() =>
        svc.generateSlots(ADMIN_ACTOR, 'event-1', {
          teacherId: 'teacher-emp',
          slotDate: '2026-05-10',
          startTime: '16:00',
          endTime: '17:00',
        } as any),
      ),
    ).rejects.toThrow(BadRequestException);
  });
});

// ─────────────────────────────────────────────────────────────────
// 6. Conference booking — THE ATOMIC KEYSTONE
// ─────────────────────────────────────────────────────────────────

describe('ConferenceBookingService.book — atomic UPDATE pattern', () => {
  function buildBookingHandlers(opts: {
    windowOpensAt: string;
    windowClosesAt: string;
    eventStatus?: string;
    initialSlotStatus?: string;
    updateMatched: boolean;
    insertedAlready?: boolean;
  }) {
    return (call: CapturedCall): unknown => {
      if (call.fn === 'q' && call.sql.includes('FROM eng_conference_slots s')) {
        // Pre-flight slot lookup with event JOIN
        return [
          {
            id: 'slot-1',
            conference_event_id: 'event-1',
            max_bookings: 1,
            current_bookings: 0,
            status: opts.initialSlotStatus ?? 'AVAILABLE',
            booking_opens_at: opts.windowOpensAt,
            booking_closes_at: opts.windowClosesAt,
            event_status: opts.eventStatus ?? 'BOOKING_OPEN',
          },
        ];
      }
      if (call.fn === 'q' && call.sql.includes('FROM sis_students')) {
        return [{ id: 'student-1' }];
      }
      // The atomic UPDATE — RETURNING id
      if (
        call.fn === 'q' &&
        call.sql.includes("status = 'AVAILABLE'") &&
        call.sql.includes('UPDATE eng_conference_slots')
      ) {
        return opts.updateMatched ? [{ id: 'slot-1' }] : [];
      }
      if (call.fn === 'e' && call.sql.includes('INSERT INTO eng_conference_bookings')) {
        if (opts.insertedAlready) {
          throw { code: '23505' };
        }
        return 1;
      }
      // Final getById SELECT
      if (call.fn === 'q' && call.sql.includes('FROM eng_conference_bookings')) {
        return [
          {
            id: 'booking-1',
            slot_id: 'slot-1',
            school_id: SCHOOL.schoolId,
            parent_id: PARENT_ACTOR.accountId,
            student_id: 'student-1',
            booked_at: '2026-05-05T00:00:00Z',
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

  it('happy path: AVAILABLE → BOOKED via atomic UPDATE', async () => {
    const past = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const { capture, tenantPrisma } = makeFake(
      buildBookingHandlers({
        windowOpensAt: past,
        windowClosesAt: future,
        updateMatched: true,
      }),
    );
    const perm = makePermCheck(() => true);
    const svc = new ConferenceBookingService(tenantPrisma as any, perm as any);
    const dto = await withTenant(() =>
      svc.book(PARENT_ACTOR, 'slot-1', { studentId: 'student-1' } as any),
    );
    expect(dto.slotId).toBe('slot-1');
    // Verify the atomic UPDATE shape ran
    const atomic = capture.find(
      (c) =>
        c.fn === 'q' &&
        c.sql.includes('UPDATE eng_conference_slots') &&
        c.sql.includes("status = 'AVAILABLE'"),
    );
    expect(atomic).toBeDefined();
    expect(atomic!.sql).toContain('current_bookings < max_bookings');
    expect(atomic!.sql).toContain('RETURNING id');
  });

  it('UPDATE matched 0 rows → 409 Conflict (slot already booked)', async () => {
    const past = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const { tenantPrisma } = makeFake(
      buildBookingHandlers({
        windowOpensAt: past,
        windowClosesAt: future,
        updateMatched: false,
      }),
    );
    const perm = makePermCheck(() => true);
    const svc = new ConferenceBookingService(tenantPrisma as any, perm as any);
    await expect(
      withTenant(() => svc.book(PARENT_ACTOR, 'slot-1', { studentId: 'student-1' } as any)),
    ).rejects.toThrow(ConflictException);
  });

  it('refuses booking before booking_opens_at (window enforcement)', async () => {
    const futureOpens = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const futureCloses = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
    const { tenantPrisma } = makeFake(
      buildBookingHandlers({
        windowOpensAt: futureOpens,
        windowClosesAt: futureCloses,
        updateMatched: true,
      }),
    );
    const perm = makePermCheck(() => true);
    const svc = new ConferenceBookingService(tenantPrisma as any, perm as any);
    await expect(
      withTenant(() => svc.book(PARENT_ACTOR, 'slot-1', { studentId: 'student-1' } as any)),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses booking after booking_closes_at (window enforcement)', async () => {
    const pastOpens = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const pastCloses = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { tenantPrisma } = makeFake(
      buildBookingHandlers({
        windowOpensAt: pastOpens,
        windowClosesAt: pastCloses,
        updateMatched: true,
      }),
    );
    const perm = makePermCheck(() => true);
    const svc = new ConferenceBookingService(tenantPrisma as any, perm as any);
    await expect(
      withTenant(() => svc.book(PARENT_ACTOR, 'slot-1', { studentId: 'student-1' } as any)),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses booking on a COMPLETED conference event', async () => {
    const past = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const { tenantPrisma } = makeFake(
      buildBookingHandlers({
        windowOpensAt: past,
        windowClosesAt: future,
        eventStatus: 'COMPLETED',
        updateMatched: true,
      }),
    );
    const perm = makePermCheck(() => true);
    const svc = new ConferenceBookingService(tenantPrisma as any, perm as any);
    await expect(
      withTenant(() => svc.book(PARENT_ACTOR, 'slot-1', { studentId: 'student-1' } as any)),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses STUDENT booking attempts outright', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const perm = makePermCheck(() => true);
    const svc = new ConferenceBookingService(tenantPrisma as any, perm as any);
    await expect(
      withTenant(() => svc.book(STUDENT_ACTOR, 'slot-1', { studentId: 'student-1' } as any)),
    ).rejects.toThrow(ForbiddenException);
  });

  it('admin can book outside the window (override)', async () => {
    const futureOpens = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const futureCloses = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
    const { tenantPrisma } = makeFake(
      buildBookingHandlers({
        windowOpensAt: futureOpens,
        windowClosesAt: futureCloses,
        updateMatched: true,
      }),
    );
    const perm = makePermCheck(() => true);
    const svc = new ConferenceBookingService(tenantPrisma as any, perm as any);
    await expect(
      withTenant(() => svc.book(ADMIN_ACTOR, 'slot-1', { studentId: 'student-1' } as any)),
    ).resolves.toBeDefined();
  });
});

describe('ConferenceBookingService.cancel', () => {
  it('refuses cancellation by non-owner non-admin', async () => {
    const { tenantPrisma } = makeFake((call) => {
      if (call.fn === 'q' && call.sql.includes('FROM eng_conference_bookings')) {
        return [
          {
            id: 'booking-1',
            slot_id: 'slot-1',
            parent_id: PARENT_ACTOR.accountId,
            cancelled_at: null,
          },
        ];
      }
      return [];
    });
    const perm = makePermCheck(() => false);
    const svc = new ConferenceBookingService(tenantPrisma as any, perm as any);
    await expect(
      withTenant(() => svc.cancel(OTHER_PARENT_ACTOR, 'booking-1', {} as any)),
    ).rejects.toThrow(ForbiddenException);
  });

  it('refuses cancelling an already-cancelled booking', async () => {
    const { tenantPrisma } = makeFake((call) => {
      if (call.fn === 'q' && call.sql.includes('FROM eng_conference_bookings')) {
        return [
          {
            id: 'booking-1',
            slot_id: 'slot-1',
            parent_id: PARENT_ACTOR.accountId,
            cancelled_at: '2026-05-04T00:00:00Z',
          },
        ];
      }
      return [];
    });
    const perm = makePermCheck(() => true);
    const svc = new ConferenceBookingService(tenantPrisma as any, perm as any);
    await expect(
      withTenant(() => svc.cancel(PARENT_ACTOR, 'booking-1', {} as any)),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('ConferenceBookingService.getById row scope', () => {
  it('parent sees own booking', async () => {
    const { tenantPrisma } = makeFake(() => [
      {
        id: 'booking-1',
        slot_id: 'slot-1',
        school_id: SCHOOL.schoolId,
        parent_id: PARENT_ACTOR.accountId,
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
    const perm = makePermCheck(() => false);
    const svc = new ConferenceBookingService(tenantPrisma as any, perm as any);
    const dto = await withTenant(() => svc.getById(PARENT_ACTOR, 'booking-1'));
    expect(dto.parentId).toBe(PARENT_ACTOR.accountId);
  });

  it("parent cannot see another parent's booking — 404", async () => {
    const { tenantPrisma } = makeFake(() => [
      {
        id: 'booking-1',
        slot_id: 'slot-1',
        school_id: SCHOOL.schoolId,
        parent_id: OTHER_PARENT_ACTOR.accountId,
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
    const perm = makePermCheck(() => false);
    const svc = new ConferenceBookingService(tenantPrisma as any, perm as any);
    await expect(withTenant(() => svc.getById(PARENT_ACTOR, 'booking-1'))).rejects.toThrow(
      NotFoundException,
    );
  });

  it('students cannot view bookings', async () => {
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
    const perm = makePermCheck(() => false);
    const svc = new ConferenceBookingService(tenantPrisma as any, perm as any);
    await expect(withTenant(() => svc.getById(STUDENT_ACTOR, 'booking-1'))).rejects.toThrow(
      ForbiddenException,
    );
  });
});

// ─────────────────────────────────────────────────────────────────
// 7. Engagement score weight + threshold config validation
// ─────────────────────────────────────────────────────────────────

describe('EngagementScoreService.updateConfig', () => {
  it('refuses weights that do not sum to 100', async () => {
    const { tenantPrisma } = makeFake((call) => {
      if (call.fn === 'q' && call.sql.includes('FROM school_config')) {
        return []; // fall through to defaults
      }
      return [];
    });
    const perm = makePermCheck(() => true);
    const svc = new EngagementScoreService(tenantPrisma as any, perm as any);
    await expect(
      withTenant(() =>
        svc.updateConfig(ADMIN_ACTOR, {
          weights: {
            attendance: 50,
            communication: 50,
            conference: 50,
            volunteer: 50,
            payment: 50,
          },
        }),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses thresholds that are not strictly decreasing', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const perm = makePermCheck(() => true);
    const svc = new EngagementScoreService(tenantPrisma as any, perm as any);
    await expect(
      withTenant(() =>
        svc.updateConfig(ADMIN_ACTOR, {
          thresholds: { highlyEngaged: 50, engaged: 60, minimal: 70 },
        }),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses non-admin update', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const perm = makePermCheck(() => false);
    const svc = new EngagementScoreService(tenantPrisma as any, perm as any);
    await expect(
      withTenant(() =>
        svc.updateConfig(TEACHER_ACTOR, {
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

// ─────────────────────────────────────────────────────────────────
// 8. Parent survey — anonymity contract is the keystone
// ─────────────────────────────────────────────────────────────────

describe('ParentSurveyService.submitResponse — anonymity keystone', () => {
  function buildSurveyHandlers(opts: {
    isAnonymous: boolean;
    updateCapture: { sql: string; args: unknown[] }[];
  }) {
    return (call: CapturedCall): unknown => {
      if (call.fn === 'q' && call.sql.includes('FROM eng_parent_surveys')) {
        if (call.sql.includes('FOR UPDATE')) {
          return [
            {
              id: 'survey-1',
              status: 'OPEN',
              is_anonymous: opts.isAnonymous,
              questions: JSON.stringify([
                { id: 'q1', question_text: 'Rate communication', question_type: 'RATING_1_5' },
              ]),
              response_data_aggregated: JSON.stringify({}),
              responses: JSON.stringify([]),
              total_responses: 0,
            },
          ];
        }
        // final getById
        return [
          {
            id: 'survey-1',
            school_id: SCHOOL.schoolId,
            title: 'Survey',
            description: null,
            questions: JSON.stringify([
              { id: 'q1', question_text: 'Rate communication', question_type: 'RATING_1_5' },
            ]),
            is_anonymous: opts.isAnonymous,
            opens_at: null,
            closes_at: null,
            status: 'OPEN',
            total_responses: 1,
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

  it('anonymous survey: respondent_id is NEVER stored on the response row', async () => {
    const updates: { sql: string; args: unknown[] }[] = [];
    const { tenantPrisma } = makeFake(
      buildSurveyHandlers({ isAnonymous: true, updateCapture: updates }),
    );
    const perm = makePermCheck(() => true);
    const { outbox } = makeOutbox();
    const svc = new ParentSurveyService(tenantPrisma as any, perm as any, outbox as any);
    const result = await withTenant(() =>
      svc.submitResponse(PARENT_ACTOR, 'survey-1', { answers: { q1: 5 } } as any),
    );
    expect(result.submitted).toBe(true);
    expect(updates).toHaveLength(1);
    const responsesJson = updates[0]!.args[0] as string;
    const parsed = JSON.parse(responsesJson);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toHaveProperty('answers');
    expect(parsed[0]).not.toHaveProperty('respondent_id');
  });

  it('identified survey: respondent_id IS stored', async () => {
    const updates: { sql: string; args: unknown[] }[] = [];
    const { tenantPrisma } = makeFake(
      buildSurveyHandlers({ isAnonymous: false, updateCapture: updates }),
    );
    const perm = makePermCheck(() => true);
    const { outbox } = makeOutbox();
    const svc = new ParentSurveyService(tenantPrisma as any, perm as any, outbox as any);
    await withTenant(() =>
      svc.submitResponse(PARENT_ACTOR, 'survey-1', { answers: { q1: 4 } } as any),
    );
    const responsesJson = updates[0]!.args[0] as string;
    const parsed = JSON.parse(responsesJson);
    expect(parsed[0]).toHaveProperty('respondent_id', PARENT_ACTOR.accountId);
  });

  it('refuses submission on a non-OPEN survey', async () => {
    const { tenantPrisma } = makeFake((call) => {
      if (call.fn === 'q' && call.sql.includes('FROM eng_parent_surveys')) {
        return [
          {
            id: 'survey-1',
            status: 'DRAFT',
            is_anonymous: true,
            questions: JSON.stringify([
              { id: 'q1', question_text: 'X', question_type: 'RATING_1_5' },
            ]),
            response_data_aggregated: JSON.stringify({}),
            responses: JSON.stringify([]),
            total_responses: 0,
          },
        ];
      }
      return [];
    });
    const perm = makePermCheck(() => true);
    const { outbox } = makeOutbox();
    const svc = new ParentSurveyService(tenantPrisma as any, perm as any, outbox as any);
    await expect(
      withTenant(() => svc.submitResponse(PARENT_ACTOR, 'survey-1', { answers: { q1: 5 } } as any)),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects answers to unknown question ids', async () => {
    const updates: { sql: string; args: unknown[] }[] = [];
    const { tenantPrisma } = makeFake(
      buildSurveyHandlers({ isAnonymous: true, updateCapture: updates }),
    );
    const perm = makePermCheck(() => true);
    const { outbox } = makeOutbox();
    const svc = new ParentSurveyService(tenantPrisma as any, perm as any, outbox as any);
    await expect(
      withTenant(() =>
        svc.submitResponse(PARENT_ACTOR, 'survey-1', { answers: { bogus: 5 } } as any),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects out-of-range RATING_1_5 answers', async () => {
    const updates: { sql: string; args: unknown[] }[] = [];
    const { tenantPrisma } = makeFake(
      buildSurveyHandlers({ isAnonymous: true, updateCapture: updates }),
    );
    const perm = makePermCheck(() => true);
    const { outbox } = makeOutbox();
    const svc = new ParentSurveyService(tenantPrisma as any, perm as any, outbox as any);
    await expect(
      withTenant(() => svc.submitResponse(PARENT_ACTOR, 'survey-1', { answers: { q1: 9 } } as any)),
    ).rejects.toThrow(BadRequestException);
  });

  it('students cannot submit survey responses', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const perm = makePermCheck(() => false);
    const { outbox } = makeOutbox();
    const svc = new ParentSurveyService(tenantPrisma as any, perm as any, outbox as any);
    await expect(
      withTenant(() =>
        svc.submitResponse(STUDENT_ACTOR, 'survey-1', { answers: { q1: 4 } } as any),
      ),
    ).rejects.toThrow(ForbiddenException);
  });
});

describe('ParentSurveyService.patch — emits eng.survey.opened on DRAFT→OPEN', () => {
  it('emits the survey.opened outbox row when status flips DRAFT→OPEN', async () => {
    const { tenantPrisma } = makeFake((call) => {
      if (
        call.fn === 'q' &&
        call.sql.includes('FROM eng_parent_surveys') &&
        call.sql.includes('FOR UPDATE')
      ) {
        return [{ status: 'DRAFT', opens_at: null, closes_at: null }];
      }
      if (call.fn === 'q' && call.sql.includes('FROM eng_parent_surveys')) {
        return [
          {
            id: 'survey-1',
            school_id: SCHOOL.schoolId,
            title: 'Survey',
            description: null,
            questions: JSON.stringify([
              { id: 'q1', question_text: 'X', question_type: 'RATING_1_5' },
            ]),
            is_anonymous: true,
            opens_at: null,
            closes_at: null,
            status: 'OPEN',
            total_responses: 0,
            response_data_aggregated: JSON.stringify({}),
            responses: null,
            created_by: 'admin',
            opened_at: '2026-05-01T00:00:00Z',
            closed_at: null,
            created_at: '',
            updated_at: '',
          },
        ];
      }
      return [];
    });
    const perm = makePermCheck(() => true);
    const { outbox, emitted } = makeOutbox();
    const svc = new ParentSurveyService(tenantPrisma as any, perm as any, outbox as any);
    await withTenant(() => svc.patch(ADMIN_ACTOR, 'survey-1', { status: 'OPEN' } as any));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.topic).toBe('eng.survey.opened');
    expect(emitted[0]!.sourceModule).toBe('engagement');
    expect(emitted[0]!.payload.surveyId).toBe('survey-1');
    expect(emitted[0]!.eventId).toBe(deterministicSurveyOpenedEventId('survey-1'));
  });

  it('refuses illegal transition OPEN → DRAFT', async () => {
    const { tenantPrisma } = makeFake((call) => {
      if (
        call.fn === 'q' &&
        call.sql.includes('FROM eng_parent_surveys') &&
        call.sql.includes('FOR UPDATE')
      ) {
        return [{ status: 'OPEN', opens_at: null, closes_at: null }];
      }
      return [];
    });
    const perm = makePermCheck(() => true);
    const { outbox } = makeOutbox();
    const svc = new ParentSurveyService(tenantPrisma as any, perm as any, outbox as any);
    await expect(
      withTenant(() => svc.patch(ADMIN_ACTOR, 'survey-1', { status: 'DRAFT' } as any)),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('ParentSurveyService.create validation', () => {
  it('refuses empty question list', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const perm = makePermCheck(() => true);
    const { outbox } = makeOutbox();
    const svc = new ParentSurveyService(tenantPrisma as any, perm as any, outbox as any);
    await expect(
      withTenant(() => svc.create(ADMIN_ACTOR, { title: 'X', questions: [] } as any)),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses duplicate question ids', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const perm = makePermCheck(() => true);
    const { outbox } = makeOutbox();
    const svc = new ParentSurveyService(tenantPrisma as any, perm as any, outbox as any);
    await expect(
      withTenant(() =>
        svc.create(ADMIN_ACTOR, {
          title: 'X',
          questions: [
            { id: 'q1', question_text: 'A', question_type: 'RATING_1_5' },
            { id: 'q1', question_text: 'B', question_type: 'RATING_1_5' },
          ],
        } as any),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses MULTIPLE_CHOICE with < 2 options', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const perm = makePermCheck(() => true);
    const { outbox } = makeOutbox();
    const svc = new ParentSurveyService(tenantPrisma as any, perm as any, outbox as any);
    await expect(
      withTenant(() =>
        svc.create(ADMIN_ACTOR, {
          title: 'X',
          questions: [
            { id: 'q1', question_text: 'A', question_type: 'MULTIPLE_CHOICE', options: ['only'] },
          ],
        } as any),
      ),
    ).rejects.toThrow(BadRequestException);
  });
});
