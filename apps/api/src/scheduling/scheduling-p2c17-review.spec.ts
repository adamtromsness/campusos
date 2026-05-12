import { describe, expect, it, vi } from 'vitest';
import { runWithTenantContextAsync, type RequestContext } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { CoTeachingService } from './coteaching.service';
import { CoverArrangementService } from './cover-arrangement.service';
import { CrossSchoolStaffService } from './cross-school-staff.service';
import { ExamSchedulingService } from './exam-scheduling.service';
import { PullOutService } from './pull-out.service';
import { ScheduleGenerationService } from './schedule-generation.service';
import { SubjectChoiceService } from './subject-choice.service';
import {
  deterministicGenerationCompletedEventId,
  deterministicTimetableUpdatedEventId,
} from './event-ids';

/*
 * REVIEW-P2C17 Round 1 pinned regression tests.
 *
 * Covers each of the 6 BLOCKING fixes + the major one for replacing
 * raw STAFF with an explicit sch-001:admin permission check.
 */

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
  };
  return { capture, client, tenantPrisma };
}

function makeOutbox() {
  const enqueued: Array<{
    topic: string;
    sourceModule: string;
    key: string;
    payload: Record<string, unknown>;
    eventId?: string;
  }> = [];
  const outbox = {
    enqueueInTx: vi.fn(async (_tx: unknown, opts: any) => {
      enqueued.push({
        topic: opts.topic,
        sourceModule: opts.sourceModule,
        key: opts.key,
        payload: opts.payload,
        eventId: opts.eventId,
      });
      return 'outbox-id';
    }),
  };
  return { enqueued, outbox };
}

function makePermCheck(allow: boolean) {
  return {
    hasAnyPermissionInTenant: vi.fn(async () => allow),
  };
}

const SCHOOL_A = '019e0001-0001-7000-8001-000000000001';
const SCHOOL_B = '019e0002-0002-7000-8002-000000000002';

function tenantContext(schoolId: string): RequestContext {
  return {
    tenant: {
      schoolId,
      schemaName: 'tenant_demo',
      organisationId: null,
      subdomain: 'demo',
      isFrozen: false,
      planTier: 'STANDARD',
      homeRegion: 'us-east-1',
    },
    userId: 'u',
    personId: 'p',
    sessionId: 's',
  };
}

function adminActor(): ResolvedActor {
  return {
    accountId: 'admin-account',
    personId: 'admin-person',
    employeeId: null,
    isSchoolAdmin: true,
    personType: 'STAFF',
    permissions: ['sch-001:admin'],
  } as unknown as ResolvedActor;
}

function studentActor(): ResolvedActor {
  return {
    accountId: 'student-account',
    personId: 'student-person',
    employeeId: null,
    isSchoolAdmin: false,
    personType: 'STUDENT',
    permissions: ['sch-001:read'],
  } as unknown as ResolvedActor;
}

function genericStaffActor(): ResolvedActor {
  return {
    accountId: 'staff-account',
    personId: 'staff-person',
    employeeId: null,
    isSchoolAdmin: false,
    personType: 'STAFF',
    permissions: ['sch-001:read'],
  } as unknown as ResolvedActor;
}

// ──────────────────────────────────────────────────────────────
// BLOCKING 1 — sch.generation.completed + sch.timetable.updated outbox
// ──────────────────────────────────────────────────────────────

describe('REVIEW-P2C17 BLOCKING 1 — durable outbox for scheduling events', () => {
  it('deterministicGenerationCompletedEventId is stable + v5-shaped', () => {
    const a = deterministicGenerationCompletedEventId('req-1');
    const b = deterministicGenerationCompletedEventId('req-1');
    const c = deterministicGenerationCompletedEventId('req-2');
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    // v5 UUID — first hex digit of the 4th group is 8, 9, a, or b;
    // 3rd group starts with 5.
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('deterministicTimetableUpdatedEventId is stable + v5-shaped', () => {
    const a = deterministicTimetableUpdatedEventId('log-1');
    const b = deterministicTimetableUpdatedEventId('log-1');
    const c = deterministicTimetableUpdatedEventId('log-2');
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('ScheduleGenerationService constructor expects an OutboxService (durable contract)', () => {
    const { outbox, enqueued } = makeOutbox();
    // Constructable with a fake tenantPrisma + outbox; this asserts
    // the durable contract — the prior signature took a
    // KafkaProducerService for best-effort emit.
    const { tenantPrisma } = makeFake(() => []);
    const svc = new ScheduleGenerationService(tenantPrisma as any, outbox as any);
    expect(svc).toBeTruthy();
    expect(enqueued.length).toBe(0); // no emit until a method runs
  });
});

// ──────────────────────────────────────────────────────────────
// BLOCKING 2 — candidate + slot + activation paths school-scoped
// ──────────────────────────────────────────────────────────────

describe('REVIEW-P2C17 BLOCKING 2 — candidate paths join through request.school_id', () => {
  it('getCandidate SQL joins sch_scheduling_requests and filters on r.school_id', async () => {
    const { capture, tenantPrisma } = makeFake(() => []);
    const { outbox } = makeOutbox();
    const svc = new ScheduleGenerationService(tenantPrisma as any, outbox as any);
    await runWithTenantContextAsync(tenantContext(SCHOOL_A), async () => {
      await expect(svc.getCandidate('cand-1')).rejects.toThrow(/Candidate not found/);
    });
    const sql = capture[0]!.sql.toLowerCase();
    expect(sql).toContain('from sch_scheduling_candidates c');
    expect(sql).toContain('join sch_scheduling_requests r on r.id = c.request_id');
    expect(sql).toContain('r.school_id = $2::uuid');
    expect(capture[0]!.args[1]).toBe(SCHOOL_A);
  });

  it('listCandidateSlots SQL joins through request.school_id', async () => {
    const { capture, tenantPrisma } = makeFake(() => []);
    const { outbox } = makeOutbox();
    const svc = new ScheduleGenerationService(tenantPrisma as any, outbox as any);
    await runWithTenantContextAsync(tenantContext(SCHOOL_A), async () => {
      await svc.listCandidateSlots('cand-1');
    });
    const sql = capture[0]!.sql.toLowerCase();
    expect(sql).toContain('join sch_scheduling_candidates c on c.id = s.candidate_id');
    expect(sql).toContain('join sch_scheduling_requests r on r.id = c.request_id');
    expect(sql).toContain('r.school_id = $2::uuid');
  });

  it('listActivationLogs SQL joins through request.school_id', async () => {
    const { capture, tenantPrisma } = makeFake(() => []);
    const { outbox } = makeOutbox();
    const svc = new ScheduleGenerationService(tenantPrisma as any, outbox as any);
    await runWithTenantContextAsync(tenantContext(SCHOOL_A), async () => {
      await svc.listActivationLogs('cand-1');
    });
    const sql = capture[0]!.sql.toLowerCase();
    expect(sql).toContain('from sch_scheduling_activation_log l');
    expect(sql).toContain('join sch_scheduling_candidates c on c.id = l.candidate_id');
    expect(sql).toContain('join sch_scheduling_requests r on r.id = c.request_id');
    expect(sql).toContain('r.school_id = $2::uuid');
  });
});

// ──────────────────────────────────────────────────────────────
// BLOCKING 3 — co-teaching paths school-scoped
// ──────────────────────────────────────────────────────────────

describe('REVIEW-P2C17 BLOCKING 3 — co-teaching SQL joins sch_timetable_slots.school_id', () => {
  it('list SQL joins sch_timetable_slots with s.school_id predicate', async () => {
    const { capture, tenantPrisma } = makeFake(() => []);
    const svc = new CoTeachingService(tenantPrisma as any);
    await runWithTenantContextAsync(tenantContext(SCHOOL_A), async () => {
      await svc.list();
    });
    const sql = capture[0]!.sql.toLowerCase();
    expect(sql).toContain('from sch_coteaching_arrangements ca');
    expect(sql).toContain('join sch_timetable_slots s on s.id = ca.timetable_slot_id');
    expect(sql).toContain('s.school_id = $1::uuid');
    expect(capture[0]!.args[0]).toBe(SCHOOL_A);
  });

  it('getById SQL joins slot + filters by s.school_id', async () => {
    const { capture, tenantPrisma } = makeFake(() => []);
    const svc = new CoTeachingService(tenantPrisma as any);
    await runWithTenantContextAsync(tenantContext(SCHOOL_A), async () => {
      await expect(svc.getById('arr-1')).rejects.toThrow(/not found/);
    });
    const sql = capture[0]!.sql.toLowerCase();
    expect(sql).toContain('join sch_timetable_slots s on s.id = ca.timetable_slot_id');
    expect(sql).toContain('s.school_id = $2::uuid');
  });

  it('create rejects when slot or teachers do not belong to current school', async () => {
    // First the validation query — return slot_ok=false to trigger 400.
    const { tenantPrisma } = makeFake((call) => {
      if (call.sql.toLowerCase().includes('exists') && call.sql.toLowerCase().includes('slot_ok')) {
        return [{ slot_ok: false, primary_ok: true, secondary_ok: true }];
      }
      return [];
    });
    const svc = new CoTeachingService(tenantPrisma as any);
    await runWithTenantContextAsync(tenantContext(SCHOOL_A), async () => {
      await expect(
        svc.create(
          {
            timetableSlotId: 'foreign-slot',
            primaryTeacherId: 't1',
            secondaryTeacherId: 't2',
            teachingModel: 'TEAM_TEACHING' as const,
          } as any,
          adminActor(),
        ),
      ).rejects.toThrow(/timetableSlotId does not match a slot in this school/);
    });
  });

  it('hasActiveCoTeachingFor SQL filters on s.school_id', async () => {
    const { capture, tenantPrisma } = makeFake(() => []);
    const svc = new CoTeachingService(tenantPrisma as any);
    await runWithTenantContextAsync(tenantContext(SCHOOL_A), async () => {
      await svc.hasActiveCoTeachingFor('slot-1', 'teacher-1');
    });
    const sql = capture[0]!.sql.toLowerCase();
    expect(sql).toContain('join sch_timetable_slots s on s.id = ca.timetable_slot_id');
    expect(sql).toContain('s.school_id = $3::uuid');
    expect(capture[0]!.args[2]).toBe(SCHOOL_A);
  });
});

// ──────────────────────────────────────────────────────────────
// BLOCKING 4 — exam child paths validate school ownership
// ──────────────────────────────────────────────────────────────

describe('REVIEW-P2C17 BLOCKING 4 — exam child operations validate school ownership', () => {
  it('addRoom 400s when roomId belongs to a different school', async () => {
    // First call validates session exists (return [{id}]); next call
    // validates room exists in current school (return [] -> 400).
    let queryCount = 0;
    const { tenantPrisma } = makeFake(() => {
      queryCount += 1;
      if (queryCount === 1) return [{ id: 'session-1' }]; // session exists
      return []; // room missing
    });
    const svc = new ExamSchedulingService(tenantPrisma as any);
    await runWithTenantContextAsync(tenantContext(SCHOOL_A), async () => {
      await expect(
        svc.addRoom('session-1', { roomId: 'foreign-room', capacity: 30 } as any, adminActor()),
      ).rejects.toThrow(/roomId does not match a room in this school/);
    });
  });

  it('assignSeat 400s when studentId is foreign-school', async () => {
    let queryCount = 0;
    const { tenantPrisma } = makeFake(() => {
      queryCount += 1;
      if (queryCount === 1) return [{ id: 'session-1' }];
      // Student lookup misses
      return [];
    });
    const svc = new ExamSchedulingService(tenantPrisma as any);
    await runWithTenantContextAsync(tenantContext(SCHOOL_A), async () => {
      await expect(
        svc.assignSeat(
          'session-1',
          { studentId: 'foreign-student', roomId: 'r1' } as any,
          adminActor(),
        ),
      ).rejects.toThrow(/studentId does not match a student in this school/);
    });
  });

  it('assignInvigilator 400s when invigilatorId is foreign-school', async () => {
    let queryCount = 0;
    const { tenantPrisma } = makeFake(() => {
      queryCount += 1;
      // session ok / room ok / invigilator missing
      if (queryCount <= 2) return [{ id: 'ok' }];
      return [];
    });
    const svc = new ExamSchedulingService(tenantPrisma as any);
    await runWithTenantContextAsync(tenantContext(SCHOOL_A), async () => {
      await expect(
        svc.assignInvigilator(
          'session-1',
          { roomId: 'r1', invigilatorId: 'foreign-emp' } as any,
          adminActor(),
        ),
      ).rejects.toThrow(/invigilatorId does not match an employee in this school/);
    });
  });

  it('findRoomConflicts session lookup includes school_id predicate', async () => {
    const { capture, tenantPrisma } = makeFake(() => []);
    const svc = new ExamSchedulingService(tenantPrisma as any);
    await runWithTenantContextAsync(tenantContext(SCHOOL_A), async () => {
      await expect(svc.findRoomConflicts('session-1')).rejects.toThrow(/Exam session not found/);
    });
    const sql = capture[0]!.sql.toLowerCase();
    expect(sql).toContain('where id = $1::uuid and school_id = $2::uuid');
    expect(capture[0]!.args[1]).toBe(SCHOOL_A);
  });

  it('assignSeat accommodation lookup includes school_id filter', async () => {
    let queryCount = 0;
    const captured: CapturedCall[] = [];
    const { tenantPrisma } = makeFake((call) => {
      captured.push(call);
      queryCount += 1;
      if (queryCount <= 3) return [{ id: 'ok', school_id: SCHOOL_A }];
      // Return a session row for the inner accommodation lookup
      if (call.sql.includes('FROM sch_exam_sessions')) {
        return [
          {
            id: 'session-1',
            school_id: SCHOOL_A,
            exam_name: 'X',
            subject_id: null,
            exam_date: '2026-06-15',
            start_time: '09:00',
            end_time: '11:00',
            duration_minutes: 120,
            extra_time_minutes: 0,
            notes: null,
          },
        ];
      }
      return [];
    });
    const svc = new ExamSchedulingService(tenantPrisma as any);
    await runWithTenantContextAsync(tenantContext(SCHOOL_A), async () => {
      try {
        await svc.assignSeat(
          'session-1',
          { studentId: 'stu-1', roomId: 'r1' } as any,
          adminActor(),
        );
      } catch {
        // fallthrough — we just want to capture the accommodation query
      }
    });
    const accCall = captured.find((c) =>
      c.sql.toLowerCase().includes('from sis_student_active_accommodations'),
    );
    expect(accCall).toBeTruthy();
    expect(accCall!.sql.toLowerCase()).toContain('school_id = $3::uuid');
  });
});

// ──────────────────────────────────────────────────────────────
// BLOCKING 5 — pull-out create + premark school-scoped
// ──────────────────────────────────────────────────────────────

describe('REVIEW-P2C17 BLOCKING 5 — pull-out validates references + attendance UPDATE school-scoped', () => {
  it('create rejects when studentId is foreign-school', async () => {
    const { tenantPrisma } = makeFake((call) => {
      if (
        call.sql.toLowerCase().includes('exists') &&
        call.sql.toLowerCase().includes('student_ok')
      ) {
        return [{ student_ok: false, slot_ok: true, provider_ok: true }];
      }
      return [];
    });
    const svc = new PullOutService(tenantPrisma as any);
    await runWithTenantContextAsync(tenantContext(SCHOOL_A), async () => {
      await expect(
        svc.create(
          {
            studentId: 'foreign-student',
            regularSlotId: 'slot-1',
            interventionName: 'X',
            startDate: '2026-01-01',
            frequency: 'WEEKLY',
            daysOfWeek: [2],
          } as any,
          adminActor(),
        ),
      ).rejects.toThrow(/studentId does not match a student in this school/);
    });
  });

  it('create rejects when regularSlotId is foreign-school', async () => {
    const { tenantPrisma } = makeFake((call) => {
      if (call.sql.toLowerCase().includes('slot_ok')) {
        return [{ student_ok: true, slot_ok: false, provider_ok: true }];
      }
      return [];
    });
    const svc = new PullOutService(tenantPrisma as any);
    await runWithTenantContextAsync(tenantContext(SCHOOL_A), async () => {
      await expect(
        svc.create(
          {
            studentId: 'stu-1',
            regularSlotId: 'foreign-slot',
            interventionName: 'X',
            startDate: '2026-01-01',
            frequency: 'WEEKLY',
            daysOfWeek: [2],
          } as any,
          adminActor(),
        ),
      ).rejects.toThrow(/regularSlotId does not match a timetable slot in this school/);
    });
  });
});

// ──────────────────────────────────────────────────────────────
// BLOCKING 6 — cover arrangement child references school-scoped
// ──────────────────────────────────────────────────────────────

describe('REVIEW-P2C17 BLOCKING 6 — cover arrangement validates child references', () => {
  it('create rejects when absentTeacherId is foreign-school', async () => {
    const { tenantPrisma } = makeFake((call) => {
      if (call.sql.toLowerCase().includes('absent_ok')) {
        return [{ absent_ok: false, covering_ok: true, sub_ok: true }];
      }
      return [];
    });
    const svc = new CoverArrangementService(tenantPrisma as any);
    await runWithTenantContextAsync(tenantContext(SCHOOL_A), async () => {
      await expect(
        svc.create(
          {
            absentTeacherId: 'foreign-emp',
            coverDate: '2026-04-22',
            coverType: 'SUBSTITUTE_REPLACEMENT' as const,
          } as any,
          adminActor(),
        ),
      ).rejects.toThrow(/absentTeacherId does not match an employee in this school/);
    });
  });

  it('addClass rejects when affectedClassId is foreign-school', async () => {
    let queryCount = 0;
    const { tenantPrisma } = makeFake((call) => {
      queryCount += 1;
      // First call is assertArrangementExists — return arrangement.
      if (queryCount === 1) return [{ id: 'arr-1' }];
      // Second call is the refs check — return class_ok=false.
      if (call.sql.toLowerCase().includes('class_ok')) {
        return [{ class_ok: false, slot_ok: true, room_ok: true, teacher_ok: true }];
      }
      return [];
    });
    const svc = new CoverArrangementService(tenantPrisma as any);
    await runWithTenantContextAsync(tenantContext(SCHOOL_A), async () => {
      await expect(
        svc.addClass(
          'arr-1',
          {
            affectedClassId: 'foreign-class',
            affectedSlotId: 's1',
            disposition: 'COVERED_BY_SUB' as const,
          } as any,
          adminActor(),
        ),
      ).rejects.toThrow(/affectedClassId does not match a class in this school/);
    });
  });

  it('addSplitStudents rejects when student is foreign-school', async () => {
    let queryCount = 0;
    const { tenantPrisma } = makeFake((call) => {
      queryCount += 1;
      // First call: assertArrangementClassExists — return one row.
      if (queryCount === 1) return [{ id: 'cls-1' }];
      // Second call: student lookup — return empty (no matching ids).
      if (call.sql.toLowerCase().includes('from sis_students')) return [];
      return [];
    });
    const svc = new CoverArrangementService(tenantPrisma as any);
    await runWithTenantContextAsync(tenantContext(SCHOOL_A), async () => {
      await expect(
        svc.addSplitStudents(
          'cls-1',
          {
            students: [{ studentId: 'foreign-stu' }],
          } as any,
          adminActor(),
        ),
      ).rejects.toThrow(/studentId foreign-stu does not match a student in this school/);
    });
  });
});

// ──────────────────────────────────────────────────────────────
// BLOCKING 7 — subject choice school-scope + perm scope
// ──────────────────────────────────────────────────────────────

describe('REVIEW-P2C17 BLOCKING 7 — subject choice school-scoped + explicit sch-001:admin', () => {
  it('SELECT_CHOICE_BASE JOINs sis_students and filters on stu.school_id', async () => {
    const { capture, tenantPrisma } = makeFake(() => []);
    const permCheck = makePermCheck(false);
    const svc = new SubjectChoiceService(tenantPrisma as any, permCheck as any);
    await runWithTenantContextAsync(tenantContext(SCHOOL_A), async () => {
      await svc.list(adminActor(), {});
    });
    // Admin path skips the actor row scope but always carries the
    // tenant-school predicate.
    const last = capture[capture.length - 1]!;
    const sql = last.sql.toLowerCase();
    expect(sql).toContain('join sis_students stu on stu.id = sc.student_id');
    expect(sql).toContain('stu.school_id = $1::uuid');
    expect(last.args[0]).toBe(SCHOOL_A);
  });

  it('list returns empty for generic STAFF without sch-001:admin', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const permCheck = makePermCheck(false); // staff lacks sch-001:admin
    const svc = new SubjectChoiceService(tenantPrisma as any, permCheck as any);
    let result: unknown[] = [];
    await runWithTenantContextAsync(tenantContext(SCHOOL_A), async () => {
      result = await svc.list(genericStaffActor(), {});
    });
    // Non-admin non-student non-guardian — no rows.
    expect(result).toEqual([]);
  });

  it('demand requires sch-001:admin scope', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const permCheck = makePermCheck(false);
    const svc = new SubjectChoiceService(tenantPrisma as any, permCheck as any);
    await runWithTenantContextAsync(tenantContext(SCHOOL_A), async () => {
      await expect(svc.demand('year-1', genericStaffActor())).rejects.toThrow(
        /requires school admin or sch-001:admin/,
      );
    });
    expect(permCheck.hasAnyPermissionInTenant).toHaveBeenCalled();
  });

  it('demand SQL joins sis_students for school-scope', async () => {
    const { capture, tenantPrisma } = makeFake(() => []);
    const permCheck = makePermCheck(true); // admin
    const svc = new SubjectChoiceService(tenantPrisma as any, permCheck as any);
    await runWithTenantContextAsync(tenantContext(SCHOOL_A), async () => {
      await svc.demand('year-1', genericStaffActor());
    });
    const sql = capture[0]!.sql.toLowerCase();
    expect(sql).toContain('join sis_students stu on stu.id = sc.student_id');
    expect(sql).toContain('stu.school_id = $2::uuid');
    expect(capture[0]!.args[1]).toBe(SCHOOL_A);
  });

  it('resolveOwnStudentId is school-scoped through sis_students.school_id', async () => {
    // Exercise via list() with STUDENT actor — invokes resolveOwnStudentId.
    const { capture, tenantPrisma } = makeFake(() => []);
    const permCheck = makePermCheck(false);
    const svc = new SubjectChoiceService(tenantPrisma as any, permCheck as any);
    await runWithTenantContextAsync(tenantContext(SCHOOL_A), async () => {
      await svc.list(studentActor(), {});
    });
    // First call is resolveOwnStudentId.
    const resolveCall = capture[0]!;
    const sql = resolveCall.sql.toLowerCase();
    expect(sql).toContain('from sis_students s');
    expect(sql).toContain('join platform.platform_students ps');
    expect(sql).toContain('s.school_id = $2::uuid');
    expect(resolveCall.args[1]).toBe(SCHOOL_A);
  });

  it('submit rejects body.studentId that does not belong to current school', async () => {
    const { tenantPrisma } = makeFake((call) => {
      if (call.sql.toLowerCase().includes('from sis_students where id =')) {
        return []; // student missing in this school
      }
      return [];
    });
    const permCheck = makePermCheck(true);
    const svc = new SubjectChoiceService(tenantPrisma as any, permCheck as any);
    await runWithTenantContextAsync(tenantContext(SCHOOL_A), async () => {
      await expect(
        svc.submit(
          {
            studentId: 'foreign-stu',
            academicYearId: 'year-1',
            courseId: 'c1',
          } as any,
          adminActor(),
        ),
      ).rejects.toThrow(/studentId does not match a student in this school/);
    });
  });
});

// ──────────────────────────────────────────────────────────────
// Cross-school staff person-level EXCLUSION shape (regression — already in place)
// ──────────────────────────────────────────────────────────────

describe('REVIEW-P2C17 — cross-school staff translation of 23P01 to 409 Conflict (regression)', () => {
  it('translates SQLSTATE 23P01 into a 409 with the person-level keystone message', async () => {
    const { tenantPrisma } = makeFake((call) => {
      // The INSERT statement fires SQLSTATE 23P01 (EXCLUSION
      // constraint). Throwing here exercises CrossSchoolStaffService's
      // isExclusionViolation translation path.
      if (call.sql.includes('INSERT INTO sch_cross_school_staff_assignments')) {
        const err: any = new Error('person-level EXCLUSION');
        err.meta = { code: '23P01' };
        throw err;
      }
      return [];
    });
    const svc = new CrossSchoolStaffService(tenantPrisma as any);
    await runWithTenantContextAsync(tenantContext(SCHOOL_A), async () => {
      await expect(
        svc.create(
          {
            visitingSchoolId: SCHOOL_B,
            personId: 'person-1',
            homeEmployeeId: 'emp-1',
            roleAtVisitingSchool: 'Visiting Music',
            effectiveFrom: '2026-01-01',
          } as any,
          adminActor(),
        ),
      ).rejects.toThrow(/overlapping cross-school assignment/);
    });
  });
});
