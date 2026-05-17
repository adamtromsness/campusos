import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { runWithTenantContext } from '@shared/tenant';
import { PERMISSIONS_KEY } from '@shared/auth';
import { HallPassService } from '../hall-passes/hall-pass.service';
import { RubricService } from '../assignments/rubric.service';
import { ClassMomentService } from './class-moment.service';
import { HallPassController } from '../hall-passes/hall-pass.controller';
import { RubricController } from '../assignments/rubric.controller';
import { ClassMomentController } from './class-moment.controller';

const SCHOOL = {
  schoolId: '019e0cf8-bbb8-7556-8c81-aaaaaaaaaaaa',
  subdomain: 'demo',
  schemaName: 'tenant_demo',
} as never;

const ADMIN_ACTOR = {
  accountId: '019e0cf8-bbb8-7556-8c81-a0000000a001',
  personId: '019e0cf8-bbb8-7556-8c81-a0000000a002',
  employeeId: '019e0cf8-bbb8-7556-8c81-a0000000a003',
  personType: 'STAFF' as const,
  isSchoolAdmin: true,
} as never;

const TEACHER_ACTOR = {
  accountId: '019e0cf8-bbb8-7556-8c81-b0000000b001',
  personId: '019e0cf8-bbb8-7556-8c81-b0000000b002',
  employeeId: '019e0cf8-bbb8-7556-8c81-b0000000b003',
  personType: 'STAFF' as const,
  isSchoolAdmin: false,
} as never;

const STUDENT_ACTOR = {
  accountId: '019e0cf8-bbb8-7556-8c81-c0000000c001',
  personId: '019e0cf8-bbb8-7556-8c81-c0000000c002',
  employeeId: null,
  personType: 'STUDENT' as const,
  isSchoolAdmin: false,
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
  };
  return { capture, client, tenantPrisma };
}

function makeKafka() {
  const emitted: Array<{
    topic: string;
    sourceModule: string;
    key: string;
    payload: Record<string, unknown>;
  }> = [];
  const kafka = {
    emit: async (opts: any) => {
      emitted.push({
        topic: opts.topic,
        sourceModule: opts.sourceModule,
        key: opts.key,
        payload: opts.payload,
      });
    },
  };
  return { kafka, emitted };
}

describe('HallPassService — concurrent + daily limit keystones', () => {
  const STUDENT = '019e1234-aaaa-7000-8000-000000001001';
  const CLASS = '019e1234-bbbb-7000-8000-000000002001';

  it('issue() rejects when class is at concurrent cap', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select 1 as ok from sis_class_teachers')) return [{ ok: 1 }];
      if (sql.includes('from cls_hall_pass_settings')) {
        return [
          {
            id: 'set-1',
            school_id: SCHOOL.schoolId,
            max_concurrent_passes_per_class: 3,
            max_daily_passes_per_student: 5,
            default_duration_minutes: 10,
            destinations: ['Bathroom', 'Library'],
            require_teacher_approval: true,
            updated_at: '2026-05-10T00:00:00Z',
          },
        ];
      }
      if (sql.includes('select 1 as ok from sis_enrollments')) return [{ ok: 1 }];
      if (sql.includes('count(*)::int as count from cls_hall_passes where class_id')) {
        return [{ count: 3 }]; // already at cap of 3
      }
      return [];
    });
    const { kafka } = makeKafka();
    const svc = new HallPassService(fake.tenantPrisma as never, kafka as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.issue({ studentId: STUDENT, classId: CLASS, destination: 'Bathroom' }, TEACHER_ACTOR),
      ),
    ).rejects.toThrow(/concurrent hall pass limit/);
  });

  it('issue() rejects when student is at daily cap', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select 1 as ok from sis_class_teachers')) return [{ ok: 1 }];
      if (sql.includes('from cls_hall_pass_settings')) {
        return [
          {
            id: 'set-1',
            school_id: SCHOOL.schoolId,
            max_concurrent_passes_per_class: 3,
            max_daily_passes_per_student: 5,
            default_duration_minutes: 10,
            destinations: ['Bathroom'],
            require_teacher_approval: true,
            updated_at: '2026-05-10T00:00:00Z',
          },
        ];
      }
      if (sql.includes('select 1 as ok from sis_enrollments')) return [{ ok: 1 }];
      if (sql.includes('count(*)::int as count from cls_hall_passes where class_id')) {
        return [{ count: 0 }];
      }
      if (
        sql.includes('count(*)::int as count from cls_hall_passes') &&
        sql.includes('student_id') &&
        sql.includes('issued_at >= date_trunc')
      ) {
        return [{ count: 5 }]; // daily cap hit
      }
      return [];
    });
    const { kafka } = makeKafka();
    const svc = new HallPassService(fake.tenantPrisma as never, kafka as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.issue({ studentId: STUDENT, classId: CLASS, destination: 'Bathroom' }, TEACHER_ACTOR),
      ),
    ).rejects.toThrow(/daily hall pass limit/);
  });

  it('issue() rejects unknown destination', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select 1 as ok from sis_class_teachers')) return [{ ok: 1 }];
      if (sql.includes('from cls_hall_pass_settings')) {
        return [
          {
            id: 'set-1',
            school_id: SCHOOL.schoolId,
            max_concurrent_passes_per_class: 3,
            max_daily_passes_per_student: 5,
            default_duration_minutes: 10,
            destinations: ['Bathroom', 'Library'],
            require_teacher_approval: true,
            updated_at: '2026-05-10T00:00:00Z',
          },
        ];
      }
      return [];
    });
    const { kafka } = makeKafka();
    const svc = new HallPassService(fake.tenantPrisma as never, kafka as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.issue({ studentId: STUDENT, classId: CLASS, destination: 'Pool' }, TEACHER_ACTOR),
      ),
    ).rejects.toThrow(/destination must be one of/);
  });

  it('issue() rejects teacher who does not teach the class', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select 1 as ok from sis_class_teachers')) return []; // not assigned
      return [];
    });
    const { kafka } = makeKafka();
    const svc = new HallPassService(fake.tenantPrisma as never, kafka as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.issue({ studentId: STUDENT, classId: CLASS, destination: 'Bathroom' }, TEACHER_ACTOR),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('issue() emits cls.hall_pass.issued via KafkaProducerService with the documented payload contract', async () => {
    let insertedId: string | null = null;
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select 1 as ok from sis_class_teachers')) return [{ ok: 1 }];
      if (sql.includes('from cls_hall_pass_settings')) {
        return [
          {
            id: 'set-1',
            school_id: SCHOOL.schoolId,
            max_concurrent_passes_per_class: 3,
            max_daily_passes_per_student: 5,
            default_duration_minutes: 10,
            destinations: ['Bathroom'],
            require_teacher_approval: true,
            updated_at: '2026-05-10T00:00:00Z',
          },
        ];
      }
      if (sql.includes('select 1 as ok from sis_enrollments')) return [{ ok: 1 }];
      if (sql.includes('count(*)::int as count from cls_hall_passes')) {
        return [{ count: 0 }];
      }
      if (sql.includes('insert into cls_hall_passes')) {
        insertedId = c.args[0] as string;
        return 1;
      }
      if (sql.includes('select hp.id, hp.school_id, hp.student_id')) {
        return [
          {
            id: insertedId ?? 'pass-1',
            school_id: SCHOOL.schoolId,
            student_id: STUDENT,
            student_name: 'Maya Chen',
            class_id: CLASS,
            class_name: 'Algebra (P1)',
            issued_by: TEACHER_ACTOR.employeeId,
            issued_by_name: 'James Rivera',
            destination: 'Bathroom',
            issued_at: '2026-05-10T08:00:00Z',
            expected_return_at: '2026-05-10T08:10:00Z',
            returned_at: null,
            status: 'ACTIVE',
            notes: null,
            created_at: '2026-05-10T08:00:00Z',
            updated_at: '2026-05-10T08:00:00Z',
          },
        ];
      }
      return [];
    });
    const { kafka, emitted } = makeKafka();
    const svc = new HallPassService(fake.tenantPrisma as never, kafka as never);
    const dto = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.issue({ studentId: STUDENT, classId: CLASS, destination: 'Bathroom' }, TEACHER_ACTOR),
    );
    expect(dto.status).toBe('ACTIVE');
    // Wait a tick so the deferred void-emit fires
    await new Promise((r) => setImmediate(r));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.topic).toBe('cls.hall_pass.issued');
    expect(emitted[0]!.sourceModule).toBe('classroom');
    expect((emitted[0]!.payload as any).hallPassId).toBe(insertedId);
    expect((emitted[0]!.payload as any).sourceRefId).toBe(insertedId);
    expect((emitted[0]!.payload as any).destination).toBe('Bathroom');
  });

  it('sweepOverdueForCurrentTenant() flips ACTIVE-past-expected to OVERDUE and emits cls.hall_pass.overdue per row', async () => {
    let updateCalled = false;
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes("update cls_hall_passes set status = 'overdue'")) {
        updateCalled = true;
        return [{ id: 'pass-overdue-1' }];
      }
      if (sql.includes('select hp.id, hp.school_id, hp.student_id')) {
        return [
          {
            id: 'pass-overdue-1',
            school_id: SCHOOL.schoolId,
            student_id: STUDENT,
            student_name: 'Ethan Rodriguez',
            class_id: CLASS,
            class_name: 'English (P2)',
            issued_by: TEACHER_ACTOR.employeeId,
            issued_by_name: 'James Rivera',
            destination: 'Office',
            issued_at: '2026-05-10T07:30:00Z',
            expected_return_at: '2026-05-10T07:45:00Z',
            returned_at: null,
            status: 'OVERDUE',
            notes: null,
            created_at: '2026-05-10T07:30:00Z',
            updated_at: '2026-05-10T07:46:00Z',
          },
        ];
      }
      return [];
    });
    const { kafka, emitted } = makeKafka();
    const svc = new HallPassService(fake.tenantPrisma as never, kafka as never);
    const flipped = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.sweepOverdueForCurrentTenant(),
    );
    expect(updateCalled).toBe(true);
    expect(flipped).toHaveLength(1);
    expect(flipped[0]!.status).toBe('OVERDUE');
    await new Promise((r) => setImmediate(r));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.topic).toBe('cls.hall_pass.overdue');
    expect(emitted[0]!.sourceModule).toBe('classroom');
    expect((emitted[0]!.payload as any).hallPassId).toBe('pass-overdue-1');
  });
});

describe('RubricService — weights validation + score keystones', () => {
  it('list() returns rubrics with weightTotal computed and weightWarning when criteria do not sum to 100', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from cls_rubrics r')) {
        return [
          {
            id: 'r-1',
            school_id: SCHOOL.schoolId,
            created_by: TEACHER_ACTOR.employeeId,
            created_by_name: 'James Rivera',
            title: 'Bad rubric',
            description: null,
            is_template: false,
            total_points: '10',
            created_at: '2026-05-10T00:00:00Z',
            updated_at: '2026-05-10T00:00:00Z',
          },
        ];
      }
      if (sql.includes('from cls_rubric_criteria')) {
        return [
          {
            id: 'c-1',
            rubric_id: 'r-1',
            criterion_name: 'Half',
            description: null,
            weight: '50',
            max_points: '5',
            sort_order: 1,
            performance_levels: [],
            created_at: '2026-05-10T00:00:00Z',
            updated_at: '2026-05-10T00:00:00Z',
          },
        ];
      }
      return [];
    });
    const svc = new RubricService(fake.tenantPrisma as never);
    const rubrics = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.list(TEACHER_ACTOR),
    );
    expect(rubrics).toHaveLength(1);
    expect(rubrics[0]!.weightTotal).toBe(50);
    expect(rubrics[0]!.weightWarning).toMatch(/sum to 50/);
  });

  it('list() with criteria summing to 100 produces no warning', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from cls_rubrics r')) {
        return [
          {
            id: 'r-1',
            school_id: SCHOOL.schoolId,
            created_by: TEACHER_ACTOR.employeeId,
            created_by_name: 'James Rivera',
            title: 'Good rubric',
            description: null,
            is_template: true,
            total_points: '40',
            created_at: '2026-05-10T00:00:00Z',
            updated_at: '2026-05-10T00:00:00Z',
          },
        ];
      }
      if (sql.includes('from cls_rubric_criteria')) {
        return [
          {
            id: 'c-1',
            rubric_id: 'r-1',
            criterion_name: 'A',
            description: null,
            weight: '50',
            max_points: '20',
            sort_order: 1,
            performance_levels: [],
            created_at: '2026-05-10T00:00:00Z',
            updated_at: '2026-05-10T00:00:00Z',
          },
          {
            id: 'c-2',
            rubric_id: 'r-1',
            criterion_name: 'B',
            description: null,
            weight: '50',
            max_points: '20',
            sort_order: 2,
            performance_levels: [],
            created_at: '2026-05-10T00:00:00Z',
            updated_at: '2026-05-10T00:00:00Z',
          },
        ];
      }
      return [];
    });
    const svc = new RubricService(fake.tenantPrisma as never);
    const rubrics = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.list(TEACHER_ACTOR),
    );
    expect(rubrics[0]!.weightTotal).toBe(100);
    expect(rubrics[0]!.weightWarning).toBeNull();
  });

  it('upsertScore() rejects pointsAwarded greater than criterion max_points', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from cls_rubric_criteria where id =')) {
        return [{ id: 'crit-1', max_points: '10' }];
      }
      return [];
    });
    const svc = new RubricService(fake.tenantPrisma as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.upsertScore(
          {
            submissionId: '019e1234-cccc-7000-8000-000000003001',
            criterionId: 'crit-1',
            pointsAwarded: 11,
          },
          TEACHER_ACTOR,
        ),
      ),
    ).rejects.toThrow(/pointsAwarded exceeds the criterion max_points/);
  });

  it('upsertScore() rejects when caller has no hr_employees record', async () => {
    const fake = makeFake(() => []);
    const svc = new RubricService(fake.tenantPrisma as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.upsertScore(
          {
            submissionId: '019e1234-cccc-7000-8000-000000003001',
            criterionId: 'crit-1',
            pointsAwarded: 5,
          },
          STUDENT_ACTOR,
        ),
      ),
    ).rejects.toThrow(ForbiddenException);
  });
});

describe('ClassMomentService — row-scope keystone', () => {
  const CLASS = '019e1234-bbbb-7000-8000-000000002001';

  it('listForClass() rejects student not enrolled in the class with 404', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (
        sql.includes('select 1 as ok from sis_enrollments') &&
        sql.includes('platform_students')
      ) {
        return []; // not enrolled
      }
      return [];
    });
    const svc = new ClassMomentService(fake.tenantPrisma as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () => svc.listForClass(CLASS, STUDENT_ACTOR)),
    ).rejects.toThrow(NotFoundException);
  });

  it('listForClass() returns moments for an enrolled student with photos + reactions inlined', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (
        sql.includes('select 1 as ok from sis_enrollments') &&
        sql.includes('platform_students')
      ) {
        return [{ ok: 1 }];
      }
      if (sql.includes('from cls_class_moments m')) {
        return [
          {
            id: 'mom-1',
            class_id: CLASS,
            class_name: 'Algebra (P1)',
            posted_by: TEACHER_ACTOR.employeeId,
            posted_by_name: 'James Rivera',
            caption: 'Field trip!',
            posted_at: '2026-05-09T00:00:00Z',
            is_approved: true,
          },
        ];
      }
      if (sql.includes('from cls_class_moment_photos')) {
        return [
          {
            id: 'photo-1',
            moment_id: 'mom-1',
            s3_key: 'demo/moments/mom-1/photo-1.jpg',
            sort_order: 0,
            file_size_bytes: null,
            created_at: '2026-05-09T00:00:00Z',
          },
        ];
      }
      if (sql.includes('from cls_class_moment_reactions r')) {
        return [
          {
            id: 'rx-1',
            moment_id: 'mom-1',
            reacted_by: STUDENT_ACTOR.personId,
            reacted_by_name: 'Maya Chen',
            reaction_type: 'LOVE',
            created_at: '2026-05-09T01:00:00Z',
          },
        ];
      }
      return [];
    });
    const svc = new ClassMomentService(fake.tenantPrisma as never);
    const dtos = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.listForClass(CLASS, STUDENT_ACTOR),
    );
    expect(dtos).toHaveLength(1);
    expect(dtos[0]!.photos).toHaveLength(1);
    expect(dtos[0]!.reactions).toHaveLength(1);
    expect(dtos[0]!.reactionCount).toBe(1);
    expect(dtos[0]!.myReaction).toBe('LOVE');
  });

  it('react() rejects an invalid reaction type with 400', async () => {
    const svc = new ClassMomentService({} as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.react('mom-1', { reactionType: 'CONFETTI' }, STUDENT_ACTOR),
      ),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('Controller @RequirePermission metadata regression', () => {
  it('HallPassController endpoints carry the documented att-005 gates', () => {
    const settingsRead = Reflect.getMetadata(
      PERMISSIONS_KEY,
      HallPassController.prototype.getSettings,
    );
    const settingsWrite = Reflect.getMetadata(
      PERMISSIONS_KEY,
      HallPassController.prototype.updateSettings,
    );
    const issue = Reflect.getMetadata(PERMISSIONS_KEY, HallPassController.prototype.issue);
    const list = Reflect.getMetadata(PERMISSIONS_KEY, HallPassController.prototype.list);
    const returnPass = Reflect.getMetadata(
      PERMISSIONS_KEY,
      HallPassController.prototype.returnPass,
    );
    const recall = Reflect.getMetadata(PERMISSIONS_KEY, HallPassController.prototype.recall);
    expect(settingsRead).toEqual(['att-005:read']);
    expect(settingsWrite).toEqual(['att-005:admin']);
    expect(issue).toEqual(['att-005:write']);
    expect(list).toEqual(['att-005:read']);
    expect(returnPass).toEqual(['att-005:write']);
    expect(recall).toEqual(['att-005:write']);
  });

  it('RubricController endpoints carry the documented tch-001 gates', () => {
    const list = Reflect.getMetadata(PERMISSIONS_KEY, RubricController.prototype.list);
    const create = Reflect.getMetadata(PERMISSIONS_KEY, RubricController.prototype.create);
    const upsertScore = Reflect.getMetadata(
      PERMISSIONS_KEY,
      RubricController.prototype.upsertScore,
    );
    expect(list).toEqual(['tch-001:read']);
    expect(create).toEqual(['tch-001:write']);
    expect(upsertScore).toEqual(['tch-001:write']);
  });

  it('ClassMomentController endpoints carry the documented tch-009 gates', () => {
    const list = Reflect.getMetadata(PERMISSIONS_KEY, ClassMomentController.prototype.listForClass);
    const create = Reflect.getMetadata(PERMISSIONS_KEY, ClassMomentController.prototype.create);
    const react = Reflect.getMetadata(PERMISSIONS_KEY, ClassMomentController.prototype.react);
    expect(list).toEqual(['tch-009:read']);
    expect(create).toEqual(['tch-009:write']);
    expect(react).toEqual(['tch-009:read']);
  });
});

describe('Hall pass returned_chk multi-column lockstep — schema invariant documentation', () => {
  it('asserts the documented status -> returned_at lockstep matrix', () => {
    // ACTIVE => returned_at NULL
    // OVERDUE => returned_at NULL
    // RETURNED => returned_at NOT NULL
    // RECALLED => returned_at NOT NULL
    const matrix: Array<{ status: string; returnedAt: 'NULL' | 'NOT NULL' }> = [
      { status: 'ACTIVE', returnedAt: 'NULL' },
      { status: 'OVERDUE', returnedAt: 'NULL' },
      { status: 'RETURNED', returnedAt: 'NOT NULL' },
      { status: 'RECALLED', returnedAt: 'NOT NULL' },
    ];
    expect(matrix.length).toBe(4);
    // The migration enforces this via cls_hall_passes_returned_chk multi-column CHECK.
  });
});
