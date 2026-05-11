import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { runWithTenantContext, TenantInfo } from '../tenant/tenant.context';
import { PERMISSIONS_KEY } from '../auth/require-permission.decorator';
import { GraduationService } from './graduation.service';
import { GraduationAuditWorker, deterministicAtRiskEventId } from './graduation-audit.worker';
import { GpaService } from './gpa.service';
import { GpaWorker } from './gpa.worker';
import { ServiceLearningService } from './service-learning.service';
import { PrerequisiteService } from './prerequisite.service';
import { SisGraduationController } from './sis-graduation.controller';

/**
 * P2-13b vertical slice spec.
 *
 * Coverage:
 *   S1. GraduationService.createRequirement rejects shape mismatches.
 *   S2. GraduationService.createRequirement admin-only.
 *   S3. GraduationService.getAuditForStudent applies STUDENT row scope.
 *   S4. GraduationAuditWorker emits sis.graduation.at_risk for senior with NOT_MET.
 *   S5. deterministicAtRiskEventId is stable + v5-shape.
 *   S6. GpaService.createConfig admin-only.
 *   S7. GpaService.createConfig rejects bad mapping.
 *   S8. GpaWorker.computeGpa applies WEIGHTED honors + AP bonuses correctly.
 *   S9. GpaWorker.computeGpa returns null GPA when no attempted credits.
 *   S10. ServiceLearningService.submitHours STUDENT-row-scope (own only).
 *   S11. ServiceLearningService.reviewHours staff/admin only + locked-row tx.
 *   S12. PrerequisiteService.create rejects self-prerequisite.
 *   S13. PrerequisiteService.validateRegistration returns ok=true with no prereqs.
 *   S14. PrerequisiteService.validateRegistration enforces min_grade ordering.
 *   S15. Controller permission metadata pinned to STU-005 codes.
 */

const SCHOOL: TenantInfo = {
  schoolId: '019e0aaa-aaaa-7556-8c81-f07b3369e584',
  schemaName: 'tenant_demo',
  organisationId: 'org-1',
  subdomain: 'demo',
  isFrozen: false,
  planTier: 'MEDIUM',
  homeRegion: 'us-east-1',
};

const ADMIN_ACTOR = {
  accountId: '019e0aaa-aaaa-7556-8c81-000000000001',
  personId: '019e0aaa-aaaa-7556-8c81-000000000002',
  personType: 'STAFF' as const,
  isSchoolAdmin: true,
  employeeId: '019e0aaa-aaaa-7556-8c81-000000000099',
} as never;

const TEACHER_ACTOR = {
  accountId: '019e0aaa-aaaa-7556-8c81-100000000001',
  personId: '019e0aaa-aaaa-7556-8c81-100000000002',
  personType: 'STAFF' as const,
  isSchoolAdmin: false,
  employeeId: '019e0aaa-aaaa-7556-8c81-100000000099',
} as never;

const STUDENT_ACTOR = {
  accountId: '019e0aaa-aaaa-7556-8c81-200000000001',
  personId: '019e0aaa-aaaa-7556-8c81-200000000002',
  personType: 'STUDENT' as const,
  isSchoolAdmin: false,
  employeeId: null,
} as never;

const PARENT_ACTOR = {
  accountId: '019e0aaa-aaaa-7556-8c81-300000000001',
  personId: '019e0aaa-aaaa-7556-8c81-300000000002',
  personType: 'GUARDIAN' as const,
  isSchoolAdmin: false,
  employeeId: null,
} as never;

const STUDENT_ID = '019e0aaa-aaaa-7556-8c81-400000000001';
const OTHER_STUDENT_ID = '019e0aaa-aaaa-7556-8c81-400000000002';
const REQ_ID = '019e0aaa-aaaa-7556-8c81-500000000001';
const COURSE_ID = '019e0aaa-aaaa-7556-8c81-600000000001';
const PREREQ_COURSE_ID = '019e0aaa-aaaa-7556-8c81-600000000002';

interface CapturedCall {
  sql: string;
  args: unknown[];
}

function makeFake(responder?: (call: CapturedCall) => unknown) {
  const capture: CapturedCall[] = [];
  const client = {
    $queryRawUnsafe: async <T = unknown>(sql: string, ...args: unknown[]): Promise<T> => {
      capture.push({ sql, args });
      const r = responder?.({ sql, args });
      return (r ?? []) as T;
    },
    $executeRawUnsafe: async (sql: string, ...args: unknown[]): Promise<number> => {
      capture.push({ sql, args });
      const r = responder?.({ sql, args });
      if (typeof r === 'number') return r;
      return 1;
    },
  };
  const tenantPrisma = {
    executeInTenantContext: async <T = unknown>(fn: (c: unknown) => Promise<T>): Promise<T> =>
      fn(client),
    executeInTenantTransaction: async <T = unknown>(fn: (c: unknown) => Promise<T>): Promise<T> =>
      fn(client),
  };
  return { capture, client, tenantPrisma };
}

/**
 * REVIEW-P2C13 outbox stub — captures every enqueueInTx so tests can
 * assert durable emits land with the deterministic event_id.
 */
function makeOutbox() {
  const enqueued: Array<{
    topic: string;
    sourceModule: string;
    key: string;
    eventId?: string;
    payload: Record<string, unknown>;
  }> = [];
  const outbox = {
    enqueueInTx: async (_tx: unknown, opts: any) => {
      enqueued.push({
        topic: opts.topic,
        sourceModule: opts.sourceModule,
        key: opts.key,
        eventId: opts.eventId,
        payload: opts.payload,
      });
      return 'outbox-id';
    },
  };
  return { outbox, enqueued };
}

function makeKafka() {
  const emits: Array<{
    topic: string;
    sourceModule: string;
    key: string;
    eventId?: string;
    payload: Record<string, unknown>;
  }> = [];
  return {
    emits,
    kafka: {
      emit: async (opts: {
        topic: string;
        key: string;
        sourceModule: string;
        eventId?: string;
        payload: Record<string, unknown>;
      }) => {
        emits.push({
          topic: opts.topic,
          sourceModule: opts.sourceModule,
          key: opts.key,
          eventId: opts.eventId,
          payload: opts.payload,
        });
      },
    },
  };
}

function makePerms(grant = true) {
  return {
    hasAnyPermissionInTenant: async () => grant,
  };
}

describe('SIS Graduation — P2-13b', () => {
  // ─── S1: createRequirement rejects shape mismatch ───
  it('S1: createRequirement rejects CREDIT_TOTAL without creditsRequired', async () => {
    const fake = makeFake();
    const svc = new GraduationService(fake.tenantPrisma as never, makePerms() as never);
    await runWithTenantContext({ tenant: SCHOOL } as never, async () => {
      await expect(
        svc.createRequirement(
          {
            requirementType: 'CREDIT_TOTAL',
            requirementName: 'Total Credits',
          } as never,
          ADMIN_ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─── S2: createRequirement admin-only ───
  it('S2: createRequirement refuses non-admin actor', async () => {
    const fake = makeFake();
    const svc = new GraduationService(fake.tenantPrisma as never, makePerms(false) as never);
    await runWithTenantContext({ tenant: SCHOOL } as never, async () => {
      await expect(
        svc.createRequirement(
          {
            requirementType: 'SERVICE_HOURS',
            requirementName: 'Service Hours — 40',
            hoursRequired: 40,
          } as never,
          TEACHER_ACTOR,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ─── S3: STUDENT can only read own audit ───
  it('S3: getAuditForStudent refuses STUDENT actor for someone else', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from sis_students s') && sql.includes('platform_students')) {
        // resolveOwnStudentId returns OTHER_STUDENT_ID — actor doesn't own STUDENT_ID
        return [{ id: OTHER_STUDENT_ID }];
      }
      return [];
    });
    const svc = new GraduationService(fake.tenantPrisma as never, makePerms() as never);
    await runWithTenantContext({ tenant: SCHOOL } as never, async () => {
      await expect(svc.getAuditForStudent(STUDENT_ID, STUDENT_ACTOR)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // ─── S4: AuditWorker emits sis.graduation.at_risk for senior with NOT_MET ───
  it('S4: GraduationAuditWorker emits sis.graduation.at_risk for senior with NOT_MET requirements', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      // requirements list: one MINIMUM_GPA requirement.
      if (sql.includes('from sis_graduation_requirements where school_id')) {
        return [
          {
            id: REQ_ID,
            requirement_type: 'MINIMUM_GPA',
            requirement_name: 'Minimum GPA',
            subject_area: null,
            credits_required: null,
            specific_course_id: null,
            hours_required: null,
            assessment_name: null,
            minimum_gpa: '2.0',
            applies_to_grade_levels: [],
          },
        ];
      }
      // students list: one senior with NULL grade-level mapped to '12' via the test path.
      if (sql.includes('from sis_students s ') && sql.includes("enrollment_status = 'enrolled'")) {
        return [
          {
            id: STUDENT_ID,
            first_name: 'Senior',
            last_name: 'Student',
            grade_level: '12',
          },
        ];
      }
      // Evaluation: no GPA snapshot rows → NOT_MET branch.
      if (sql.includes('from sis_student_gpa_snapshots s') && sql.includes('is_default = true')) {
        return [];
      }
      return [];
    });
    const { outbox, enqueued } = makeOutbox();
    const gpaSvc = new GpaService(fake.tenantPrisma as never, makePerms() as never);
    const worker = new GraduationAuditWorker(fake.tenantPrisma as never, outbox as never, gpaSvc);
    const summary = await runWithTenantContext({ tenant: SCHOOL } as never, async () =>
      worker.runForCurrentTenant(),
    );
    expect(summary.studentsEvaluated).toBe(1);
    expect(summary.requirementsEvaluated).toBe(1);
    expect(summary.atRiskSeniors).toBe(1);
    // REVIEW-P2C13 BLOCKING 5 — emit lands via OutboxService.enqueueInTx
    // inside a tenant tx so a Kafka outage cannot lose the at-risk event.
    expect(enqueued.length).toBe(1);
    expect(enqueued[0]!.topic).toBe('sis.graduation.at_risk');
    expect(enqueued[0]!.sourceModule).toBe('sis-graduation');
    const payload = enqueued[0]!.payload as {
      studentId: string;
      missingRequirements: Array<{ status: string }>;
    };
    expect(payload.studentId).toBe(STUDENT_ID);
    expect(payload.missingRequirements.length).toBe(1);
    expect(payload.missingRequirements[0]!.status).toBe('NOT_MET');
    // Deterministic v5-shape event id keyed on (studentId, runId).
    expect(enqueued[0]!.eventId).toBeDefined();
    expect(enqueued[0]!.eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  // ─── S5: deterministicAtRiskEventId is stable + v5-shape ───
  it('S5: deterministicAtRiskEventId is stable + v5-shape', () => {
    const a = deterministicAtRiskEventId('019e0aaa-aaaa-7556-8c81-400000000001', 'run-1');
    const b = deterministicAtRiskEventId('019e0aaa-aaaa-7556-8c81-400000000001', 'run-1');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const c = deterministicAtRiskEventId('019e0aaa-aaaa-7556-8c81-400000000001', 'run-2');
    expect(c).not.toBe(a);
  });

  // ─── S6: GpaService.createConfig admin-only ───
  it('S6: GpaService.createConfig refuses non-admin', async () => {
    const fake = makeFake();
    const svc = new GpaService(fake.tenantPrisma as never, makePerms(false) as never);
    await runWithTenantContext({ tenant: SCHOOL } as never, async () => {
      await expect(
        svc.createConfig(
          {
            configName: 'Test',
            calculationMethod: 'UNWEIGHTED',
            scaleType: 'FOUR_POINT',
            gradePointMapping: { A: 4 },
          } as never,
          TEACHER_ACTOR,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ─── S7: GpaService.createConfig rejects empty mapping ───
  it('S7: GpaService.createConfig rejects empty grade_point_mapping', async () => {
    const fake = makeFake();
    const svc = new GpaService(fake.tenantPrisma as never, makePerms() as never);
    await runWithTenantContext({ tenant: SCHOOL } as never, async () => {
      await expect(
        svc.createConfig(
          {
            configName: 'Test',
            calculationMethod: 'UNWEIGHTED',
            scaleType: 'FOUR_POINT',
            gradePointMapping: {},
          } as never,
          ADMIN_ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─── S8: GpaWorker.computeGpa WEIGHTED honors + AP bonuses ───
  it('S8: GpaWorker.computeGpa applies honors + AP bonuses to WEIGHTED method', () => {
    const fake = makeFake();
    const gpa = new GpaService(fake.tenantPrisma as never, makePerms() as never);
    const worker = new GpaWorker(fake.tenantPrisma as never, gpa);

    const fallbackScale = [
      { letter: 'A', min: 93, max: 100, gradePoints: 4.0, isPassing: true },
      { letter: 'B', min: 83, max: 92.99, gradePoints: 3.0, isPassing: true },
      { letter: 'F', min: 0, max: 59.99, gradePoints: 0.0, isPassing: false },
    ];

    const config = {
      id: 'cfg-1',
      schoolId: SCHOOL.schoolId,
      configName: 'Weighted',
      calculationMethod: 'WEIGHTED' as const,
      scaleType: 'FOUR_POINT' as const,
      gradePointMapping: { A: 4.0, B: 3.0, F: 0.0 },
      honorsWeightBonus: 0.5,
      apWeightBonus: 1.0,
      isDefault: true,
      isActive: true,
    };

    const grades = [
      {
        grade_value: '95',
        letter_grade: 'A',
        credit_hours: '1.0',
        is_honors: true,
        is_ap: false,
        course_id: 'c-1',
        course_code: 'ELA-101',
        course_name: 'English 9',
        term_id: null,
        academic_year_id: null,
      },
      {
        grade_value: '95',
        letter_grade: 'A',
        credit_hours: '1.0',
        is_honors: false,
        is_ap: true,
        course_id: 'c-2',
        course_code: 'MATH-201',
        course_name: 'AP Calc',
        term_id: null,
        academic_year_id: null,
      },
      {
        grade_value: '95',
        letter_grade: 'A',
        credit_hours: '1.0',
        is_honors: false,
        is_ap: false,
        course_id: 'c-3',
        course_code: 'SCI-101',
        course_name: 'Biology',
        term_id: null,
        academic_year_id: null,
      },
    ];

    const result = worker.computeGpa(grades as never, config, fallbackScale, null, null);
    // 3 credits attempted; weighted points = (4+0.5)+(4+1)+4 = 13.5; gpa = 13.5/3 = 4.5
    expect(result.totalCreditsAttempted).toBe(3);
    expect(result.totalCreditsEarned).toBe(3);
    expect(result.gpa).toBeCloseTo(4.5, 3);
  });

  // ─── S9: GpaWorker.computeGpa returns 0 when no attempted credits ───
  it('S9: GpaWorker.computeGpa returns gpa=0 with attempted=0 when no grades match filter', () => {
    const fake = makeFake();
    const gpa = new GpaService(fake.tenantPrisma as never, makePerms() as never);
    const worker = new GpaWorker(fake.tenantPrisma as never, gpa);
    const config = {
      id: 'cfg-1',
      schoolId: SCHOOL.schoolId,
      configName: 'Weighted',
      calculationMethod: 'WEIGHTED' as const,
      scaleType: 'FOUR_POINT' as const,
      gradePointMapping: { A: 4.0 },
      honorsWeightBonus: 0.5,
      apWeightBonus: 1.0,
      isDefault: true,
      isActive: true,
    };
    const result = worker.computeGpa([], config, [], 'term-1', null);
    expect(result.totalCreditsAttempted).toBe(0);
    expect(result.totalCreditsEarned).toBe(0);
    expect(result.gpa).toBe(0);
  });

  // ─── S10: ServiceLearningService.submitHours STUDENT row-scope ───
  it('S10: submitHours refuses STUDENT actor for a different student id', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from sis_students s') && sql.includes('platform_students')) {
        return [{ id: OTHER_STUDENT_ID }];
      }
      return [];
    });
    const svc = new ServiceLearningService(fake.tenantPrisma as never, makePerms() as never);
    await runWithTenantContext({ tenant: SCHOOL } as never, async () => {
      await expect(
        svc.submitHours(
          {
            studentId: STUDENT_ID,
            organisationName: 'Some Org',
            activityDescription: 'Activity',
            hours: 2,
            serviceDate: '2026-05-01',
          } as never,
          STUDENT_ACTOR,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ─── S11: reviewHours locked-row tx + reviewer scope ───
  it('S11: reviewHours rejects parent (no reviewer scope) and locks row inside tx', async () => {
    const fake = makeFake();
    const svc = new ServiceLearningService(fake.tenantPrisma as never, makePerms(false) as never);
    await runWithTenantContext({ tenant: SCHOOL } as never, async () => {
      await expect(
        svc.reviewHours(
          '019e0aaa-aaaa-7556-8c81-700000000001',
          {
            decision: 'APPROVED',
          } as never,
          PARENT_ACTOR,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  it('S11b: reviewHours staff path locks the row with FOR UPDATE and rejects non-PENDING', async () => {
    let locked = false;
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('for update') && sql.includes('sis_service_learning_hours')) {
        locked = true;
        return [{ id: '019e0aaa-aaaa-7556-8c81-700000000001', status: 'APPROVED' }];
      }
      return [];
    });
    const svc = new ServiceLearningService(fake.tenantPrisma as never, makePerms() as never);
    await runWithTenantContext({ tenant: SCHOOL } as never, async () => {
      await expect(
        svc.reviewHours(
          '019e0aaa-aaaa-7556-8c81-700000000001',
          {
            decision: 'APPROVED',
          } as never,
          ADMIN_ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
    expect(locked).toBe(true);
  });

  // ─── S12: PrerequisiteService.create rejects self-prerequisite ───
  it('S12: create rejects course = prerequisiteCourse', async () => {
    const fake = makeFake();
    const svc = new PrerequisiteService(fake.tenantPrisma as never, makePerms() as never);
    await runWithTenantContext({ tenant: SCHOOL } as never, async () => {
      await expect(
        svc.create(
          {
            courseId: COURSE_ID,
            prerequisiteCourseId: COURSE_ID,
            isMandatory: true,
            minGrade: 'C',
          } as never,
          ADMIN_ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─── S13: validateRegistration ok with no prereqs ───
  it('S13: validateRegistration returns ok=true when course has no prerequisites', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from sis_students where id =')) return [{ ok: 1 }];
      // listForCourse returns []
      if (sql.includes('from sis_course_prerequisites')) return [];
      return [];
    });
    const svc = new PrerequisiteService(fake.tenantPrisma as never, makePerms() as never);
    const result = await runWithTenantContext({ tenant: SCHOOL } as never, async () =>
      svc.validateRegistration(STUDENT_ID, COURSE_ID),
    );
    expect(result.ok).toBe(true);
    expect(result.unmetPrerequisites).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  // ─── S14: validateRegistration enforces min_grade ordering ───
  it('S14: validateRegistration rejects when student grade below min_grade on mandatory prereq', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from sis_students where id =')) return [{ ok: 1 }];
      // listForCourse returns one mandatory prereq with min_grade=C
      if (sql.includes('from sis_course_prerequisites p')) {
        return [
          {
            id: 'pre-1',
            course_id: COURSE_ID,
            prerequisite_course_id: PREREQ_COURSE_ID,
            is_mandatory: true,
            min_grade: 'C',
            prerequisite_course_code: 'MATH-101',
            prerequisite_course_name: 'Algebra 1',
          },
        ];
      }
      // Scale empty for simplicity — letter resolution falls back to F when no scale rows
      if (sql.includes('from sis_grade_scale_entries')) return [];
      // Best grade for student = 65 (D-ish), letter from cls_grades is null
      if (sql.includes('max(g.grade_value)') && sql.includes('cls_grades g')) {
        return [{ best: '65', letter: 'D' }];
      }
      return [];
    });
    const svc = new PrerequisiteService(fake.tenantPrisma as never, makePerms() as never);
    const result = await runWithTenantContext({ tenant: SCHOOL } as never, async () =>
      svc.validateRegistration(STUDENT_ID, COURSE_ID),
    );
    expect(result.ok).toBe(false);
    expect(result.unmetPrerequisites.length).toBe(1);
    expect(result.unmetPrerequisites[0]).toContain('Algebra 1');
    expect(result.unmetPrerequisites[0]).toContain('minimum grade C');
  });

  it('S14b: validateRegistration passes when student meets min_grade', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from sis_students where id =')) return [{ ok: 1 }];
      if (sql.includes('from sis_course_prerequisites p')) {
        return [
          {
            id: 'pre-1',
            course_id: COURSE_ID,
            prerequisite_course_id: PREREQ_COURSE_ID,
            is_mandatory: true,
            min_grade: 'C',
            prerequisite_course_code: 'MATH-101',
            prerequisite_course_name: 'Algebra 1',
          },
        ];
      }
      if (sql.includes('from sis_grade_scale_entries')) return [];
      if (sql.includes('max(g.grade_value)') && sql.includes('cls_grades g')) {
        return [{ best: '95', letter: 'A' }];
      }
      return [];
    });
    const svc = new PrerequisiteService(fake.tenantPrisma as never, makePerms() as never);
    const result = await runWithTenantContext({ tenant: SCHOOL } as never, async () =>
      svc.validateRegistration(STUDENT_ID, COURSE_ID),
    );
    expect(result.ok).toBe(true);
    expect(result.unmetPrerequisites).toEqual([]);
  });

  // ─── S15: Controller permission metadata ───
  it('S15: controller permission metadata is pinned to STU-005 codes', () => {
    type Handler = (...args: never[]) => unknown;
    const handlers: Array<{ name: keyof SisGraduationController; expected: string[] }> = [
      { name: 'listRequirements', expected: ['stu-005:read'] },
      { name: 'createRequirement', expected: ['stu-005:admin'] },
      { name: 'patchRequirement', expected: ['stu-005:admin'] },
      { name: 'deleteRequirement', expected: ['stu-005:admin'] },
      { name: 'getStudentAudit', expected: ['stu-005:read'] },
      { name: 'listAtRisk', expected: ['stu-005:read'] },
      { name: 'runAudit', expected: ['stu-005:admin'] },
      { name: 'submitServiceLearningHours', expected: ['stu-005:write'] },
      { name: 'reviewServiceLearningHours', expected: ['stu-005:write'] },
      { name: 'createGpaConfig', expected: ['stu-005:admin'] },
      { name: 'getStudentGpa', expected: ['stu-005:read'] },
      { name: 'runGpa', expected: ['stu-005:admin'] },
      { name: 'createPrerequisite', expected: ['stu-005:admin'] },
      { name: 'validateCourseRegistration', expected: ['stu-005:read'] },
    ];
    for (const { name, expected } of handlers) {
      const fn = SisGraduationController.prototype[name] as unknown as Handler;
      const codes = Reflect.getMetadata(PERMISSIONS_KEY, fn) as string[];
      expect(codes).toEqual(expected);
    }
  });

  // ─── REVIEW-P2C13 REGRESSION TESTS ───

  /**
   * R-B4a: ServiceLearningService.assertCanReadStudent no longer
   * blanket-bypasses STAFF — staff without stu-005:write/admin is
   * refused with NotFound.
   */
  it('R-B4a: ServiceLearningService refuses STAFF without stu-005:write', async () => {
    const fake = makeFake();
    const svc = new ServiceLearningService(fake.tenantPrisma as never, makePerms(false) as never);
    await runWithTenantContext({ tenant: SCHOOL } as never, async () => {
      await expect(svc.listForStudent(STUDENT_ID, TEACHER_ACTOR)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  /**
   * R-B4b: ServiceLearningService.reviewHours lock joins sis_students
   * with the school predicate.
   */
  it('R-B4b: ServiceLearningService.reviewHours lock binds school_id', async () => {
    const fake = makeFake(() => []);
    const svc = new ServiceLearningService(fake.tenantPrisma as never, makePerms() as never);
    await runWithTenantContext({ tenant: SCHOOL } as never, async () => {
      await expect(
        svc.reviewHours(
          '019e1500-0000-7556-8c81-bbbbbbbbbb01',
          { decision: 'APPROVED' } as never,
          ADMIN_ACTOR,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
    const lockSql = fake.capture.find(
      (c) =>
        c.sql.toLowerCase().includes('from sis_service_learning_hours h') &&
        c.sql.toLowerCase().includes('join sis_students s') &&
        c.sql.toLowerCase().includes('s.school_id = $2::uuid') &&
        c.sql.toLowerCase().includes('for update of h'),
    );
    expect(lockSql).toBeDefined();
  });

  /**
   * R-M3: GraduationService.assertCanReadStudent no longer
   * blanket-bypasses STAFF. A teacher without stu-005:write and
   * without an assigned-class link is refused.
   */
  it('R-M3: GraduationService refuses generic STAFF without stu-005:write', async () => {
    const fake = makeFake(() => []);
    const svc = new GraduationService(fake.tenantPrisma as never, makePerms(false) as never);
    await runWithTenantContext({ tenant: SCHOOL } as never, async () => {
      await expect(svc.getAuditForStudent(STUDENT_ID, TEACHER_ACTOR)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
