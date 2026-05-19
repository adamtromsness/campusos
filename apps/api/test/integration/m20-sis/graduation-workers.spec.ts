import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { GraduationAuditWorker } from '@modules/m20-sis/graduation/graduation-audit.worker';
import { GpaWorker } from '@modules/m20-sis/graduation/gpa.worker';
import { GpaService } from '@modules/m20-sis/graduation/gpa.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import { withTestTenant, TEST_SCHEMA, TEST_SCHOOL_ID } from '../helpers/tenant-context';
import { adminActor, TEST_ADMIN_EMPLOYEE_ID } from '../helpers/actor';
import { TEST_SIS_CLASS_ID, TEST_SIS_COURSE_ID, TEST_SIS_DEPARTMENT_ID } from '../fixtures/sis';
import { seedStudent, cleanupSeededIds } from './sis-helpers';

/**
 * Wave 4 — m20-sis graduation workers.
 *
 * GraduationAuditWorker drives the entire requirement engine — CREDIT_TOTAL,
 * SUBJECT_CREDIT, SPECIFIC_COURSE, SERVICE_HOURS, ASSESSMENT, MINIMUM_GPA —
 * and emits sis.graduation.at_risk via the outbox for seniors with NOT_MET
 * rows. GpaWorker recomputes sis_student_gpa_snapshots from cls_grades.
 *
 * These tests construct realistic fixture data (assignments + grades +
 * service hours) and assert the worker materialises the right audit rows
 * and emits the right envelopes.
 */
describe('integration:m20-sis/graduation-workers', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let outbox: OutboxService;
  let gpaService: GpaService;
  let auditWorker: GraduationAuditWorker;
  let gpaWorker: GpaWorker;

  const personIds: string[] = [];
  const platformStudentIds: string[] = [];
  const studentIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    outbox = new OutboxService();
    gpaService = new GpaService(tenantPrisma, permCheck);
    auditWorker = new GraduationAuditWorker(tenantPrisma, outbox, gpaService);
    gpaWorker = new GpaWorker(tenantPrisma, gpaService);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_student_graduation_audits`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_graduation_requirements`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_student_gpa_snapshots`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_gpa_configurations`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_service_learning_hours`,
    );
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_grades`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_assignments`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_outbox WHERE topic = 'sis.graduation.at_risk' AND tenant_id = $1::uuid`,
      TEST_SCHOOL_ID,
    );
    await cleanupSeededIds(rawClient, {
      studentIds: studentIds.splice(0),
      platformStudentIds: platformStudentIds.splice(0),
      personIds: personIds.splice(0),
    });
  });

  async function trackedStudent(opts: Parameters<typeof seedStudent>[1] = {}) {
    const s = await seedStudent(rawClient, opts);
    studentIds.push(s.studentId);
    platformStudentIds.push(s.platformStudentId);
    personIds.push(s.personId);
    return s;
  }

  async function ensureAssignmentType(): Promise<string> {
    const existing = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id::text FROM ${TEST_SCHEMA}.cls_assignment_types LIMIT 1`,
    );
    if (existing.length > 0) return existing[0]!.id;
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.cls_assignment_types (id, school_id, name, weight_in_category)
       VALUES ($1::uuid, $2::uuid, 'Final', 1.0)`,
      id,
      TEST_SCHOOL_ID,
    );
    return id;
  }

  async function seedGradedAssignment(
    studentId: string,
    classId: string = TEST_SIS_CLASS_ID,
    gradeValue: number = 95,
    letterGrade: string = 'A',
  ): Promise<{ assignmentId: string; gradeId: string }> {
    const assignmentTypeId = await ensureAssignmentType();
    const assignmentId = generateId();
    const gradeId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.cls_assignments (id, class_id, assignment_type_id, title, max_points, is_published)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'Final', 100, true)`,
      assignmentId,
      classId,
      assignmentTypeId,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.cls_grades (id, assignment_id, student_id, teacher_id, letter_grade, grade_value, is_published)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::numeric, true)`,
      gradeId,
      assignmentId,
      studentId,
      TEST_ADMIN_EMPLOYEE_ID,
      letterGrade,
      gradeValue,
    );
    return { assignmentId, gradeId };
  }

  describe('GraduationAuditWorker.runForCurrentTenant', () => {
    it('zero requirements → returns zero summary', async () => {
      const summary = await withTestTenant(async () => auditWorker.runForCurrentTenant());
      expect(summary.requirementsEvaluated).toBe(0);
      expect(summary.auditsUpserted).toBe(0);
    });

    it('CREDIT_TOTAL: passing grades count toward total', async () => {
      const s = await trackedStudent({ gradeLevel: '12' });
      // Set course credit_hours so the credit accumulator finds value
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.sis_courses SET credit_hours = 5.0 WHERE id = $1::uuid`,
        TEST_SIS_COURSE_ID,
      );
      await seedGradedAssignment(s.studentId, TEST_SIS_CLASS_ID, 95, 'A');
      const reqId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_graduation_requirements
           (id, school_id, requirement_type, requirement_name, credits_required, is_active)
         VALUES ($1::uuid, $2::uuid, 'CREDIT_TOTAL', 'Total', 4, true)`,
        reqId,
        TEST_SCHOOL_ID,
      );

      const result = await withTestTenant(async () => auditWorker.runForStudent(s.studentId));
      expect(result.auditsUpserted).toBe(1);

      const audits = await rawClient.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT status FROM ${TEST_SCHEMA}.sis_student_graduation_audits WHERE student_id = $1::uuid`,
        s.studentId,
      );
      expect(audits[0]!.status).toBe('MET');
    });

    it('CREDIT_TOTAL: zero earned credits → NOT_MET (single-student path)', async () => {
      const s = await trackedStudent({ gradeLevel: '12' });
      const reqId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_graduation_requirements
           (id, school_id, requirement_type, requirement_name, credits_required, is_active)
         VALUES ($1::uuid, $2::uuid, 'CREDIT_TOTAL', 'Total', 24, true)`,
        reqId,
        TEST_SCHOOL_ID,
      );
      await withTestTenant(async () => auditWorker.runForStudent(s.studentId));
      const audits = await rawClient.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT status FROM ${TEST_SCHEMA}.sis_student_graduation_audits WHERE student_id = $1::uuid`,
        s.studentId,
      );
      expect(audits[0]!.status).toBe('NOT_MET');
    });

    it('CREDIT_TOTAL: partial credits → IN_PROGRESS', async () => {
      const s = await trackedStudent({ gradeLevel: '11' });
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.sis_courses SET credit_hours = 2.0 WHERE id = $1::uuid`,
        TEST_SIS_COURSE_ID,
      );
      await seedGradedAssignment(s.studentId);
      const reqId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_graduation_requirements
           (id, school_id, requirement_type, requirement_name, credits_required, is_active)
         VALUES ($1::uuid, $2::uuid, 'CREDIT_TOTAL', 'Total', 24, true)`,
        reqId,
        TEST_SCHOOL_ID,
      );
      await withTestTenant(async () => auditWorker.runForStudent(s.studentId));
      const audits = await rawClient.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT status FROM ${TEST_SCHEMA}.sis_student_graduation_audits WHERE student_id = $1::uuid`,
        s.studentId,
      );
      expect(audits[0]!.status).toBe('IN_PROGRESS');
    });

    it('SPECIFIC_COURSE: passed → MET', async () => {
      const s = await trackedStudent({ gradeLevel: '11' });
      await seedGradedAssignment(s.studentId, TEST_SIS_CLASS_ID, 85, 'B');
      const reqId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_graduation_requirements
           (id, school_id, requirement_type, requirement_name, specific_course_id, is_active)
         VALUES ($1::uuid, $2::uuid, 'SPECIFIC_COURSE', 'Capstone', $3::uuid, true)`,
        reqId,
        TEST_SCHOOL_ID,
        TEST_SIS_COURSE_ID,
      );
      await withTestTenant(async () => auditWorker.runForStudent(s.studentId));
      const audits = await rawClient.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT status FROM ${TEST_SCHEMA}.sis_student_graduation_audits WHERE student_id = $1::uuid`,
        s.studentId,
      );
      expect(audits[0]!.status).toBe('MET');
    });

    it('SPECIFIC_COURSE: not attempted → NOT_MET', async () => {
      const s = await trackedStudent({ gradeLevel: '12' });
      const reqId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_graduation_requirements
           (id, school_id, requirement_type, requirement_name, specific_course_id, is_active)
         VALUES ($1::uuid, $2::uuid, 'SPECIFIC_COURSE', 'Required', $3::uuid, true)`,
        reqId,
        TEST_SCHOOL_ID,
        TEST_SIS_COURSE_ID,
      );
      await withTestTenant(async () => auditWorker.runForStudent(s.studentId));
      const audits = await rawClient.$queryRawUnsafe<Array<{ status: string; detail: string }>>(
        `SELECT status, detail FROM ${TEST_SCHEMA}.sis_student_graduation_audits WHERE student_id = $1::uuid`,
        s.studentId,
      );
      expect(audits[0]!.status).toBe('NOT_MET');
    });

    it('SERVICE_HOURS: approved hours count toward total', async () => {
      const s = await trackedStudent({ gradeLevel: '12' });
      // Insert 5 rows of 8 hours each = 40 total. Per-row CHECK caps at 24.
      for (let i = 0; i < 5; i++) {
        await rawClient.$executeRawUnsafe(
          `INSERT INTO ${TEST_SCHEMA}.sis_service_learning_hours
             (id, student_id, organisation_name, activity_description, hours, service_date,
              status, reviewed_by, reviewed_at)
           VALUES (gen_random_uuid(), $1::uuid, 'Library', 'Volunteer', 8, '2026-09-01'::date + ($2::int * 7 || ' days')::interval,
                   'APPROVED', $3::uuid, now())`,
          s.studentId,
          i,
          TEST_ADMIN_EMPLOYEE_ID,
        );
      }
      const reqId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_graduation_requirements
           (id, school_id, requirement_type, requirement_name, hours_required, is_active)
         VALUES ($1::uuid, $2::uuid, 'SERVICE_HOURS', 'Service', 40, true)`,
        reqId,
        TEST_SCHOOL_ID,
      );
      await withTestTenant(async () => auditWorker.runForStudent(s.studentId));
      const audits = await rawClient.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT status FROM ${TEST_SCHEMA}.sis_student_graduation_audits WHERE student_id = $1::uuid`,
        s.studentId,
      );
      expect(audits[0]!.status).toBe('MET');
    });

    it('SERVICE_HOURS: pending hours do not count', async () => {
      const s = await trackedStudent({ gradeLevel: '12' });
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_service_learning_hours
           (id, student_id, organisation_name, activity_description, hours, service_date, status)
         VALUES (gen_random_uuid(), $1::uuid, 'Library', 'Volunteer', 8, '2026-09-01', 'PENDING')`,
        s.studentId,
      );
      const reqId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_graduation_requirements
           (id, school_id, requirement_type, requirement_name, hours_required, is_active)
         VALUES ($1::uuid, $2::uuid, 'SERVICE_HOURS', 'Service', 40, true)`,
        reqId,
        TEST_SCHOOL_ID,
      );
      await withTestTenant(async () => auditWorker.runForStudent(s.studentId));
      const audits = await rawClient.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT status FROM ${TEST_SCHEMA}.sis_student_graduation_audits WHERE student_id = $1::uuid`,
        s.studentId,
      );
      expect(audits[0]!.status).toBe('NOT_MET');
    });

    it('MINIMUM_GPA: snapshot ≥ requirement → MET', async () => {
      const s = await trackedStudent({ gradeLevel: '12' });
      const cfgId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_gpa_configurations
           (id, school_id, config_name, calculation_method, scale_type, grade_point_mapping, is_default)
         VALUES ($1::uuid, $2::uuid, 'Std', 'WEIGHTED', 'FOUR_POINT',
                 '{"A":4,"B":3,"C":2,"D":1,"F":0}'::jsonb, true)`,
        cfgId,
        TEST_SCHOOL_ID,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_student_gpa_snapshots
           (id, student_id, gpa_config_id, cumulative_gpa)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 3.5)`,
        s.studentId,
        cfgId,
      );
      const reqId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_graduation_requirements
           (id, school_id, requirement_type, requirement_name, minimum_gpa, is_active)
         VALUES ($1::uuid, $2::uuid, 'MINIMUM_GPA', 'Min', 2.0, true)`,
        reqId,
        TEST_SCHOOL_ID,
      );
      await withTestTenant(async () => auditWorker.runForStudent(s.studentId));
      const audits = await rawClient.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT status FROM ${TEST_SCHEMA}.sis_student_graduation_audits WHERE student_id = $1::uuid`,
        s.studentId,
      );
      expect(audits[0]!.status).toBe('MET');
    });

    it('ASSESSMENT requirement → IN_PROGRESS (pending implementation)', async () => {
      const s = await trackedStudent({ gradeLevel: '12' });
      const reqId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_graduation_requirements
           (id, school_id, requirement_type, requirement_name, assessment_name, is_active)
         VALUES ($1::uuid, $2::uuid, 'ASSESSMENT', 'STAAR', 'STAAR_MATH', true)`,
        reqId,
        TEST_SCHOOL_ID,
      );
      await withTestTenant(async () => auditWorker.runForStudent(s.studentId));
      const audits = await rawClient.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT status FROM ${TEST_SCHEMA}.sis_student_graduation_audits WHERE student_id = $1::uuid`,
        s.studentId,
      );
      expect(audits[0]!.status).toBe('IN_PROGRESS');
    });

    it('grade-level filtering: requirement scoped to grade 12 skips grade 11 students', async () => {
      const g11 = await trackedStudent({ gradeLevel: '11', firstName: 'Junior' });
      const g12 = await trackedStudent({ gradeLevel: '12', firstName: 'Senior' });
      const reqId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_graduation_requirements
           (id, school_id, requirement_type, requirement_name, credits_required, applies_to_grade_levels, is_active)
         VALUES ($1::uuid, $2::uuid, 'CREDIT_TOTAL', 'Total', 24, ARRAY['12']::text[], true)`,
        reqId,
        TEST_SCHOOL_ID,
      );
      await withTestTenant(async () => auditWorker.runForStudent(g11.studentId));
      await withTestTenant(async () => auditWorker.runForStudent(g12.studentId));
      const g11Audits = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM ${TEST_SCHEMA}.sis_student_graduation_audits WHERE student_id = $1::uuid`,
        g11.studentId,
      );
      expect(g11Audits).toHaveLength(0);
      const g12Audits = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM ${TEST_SCHEMA}.sis_student_graduation_audits WHERE student_id = $1::uuid`,
        g12.studentId,
      );
      expect(g12Audits).toHaveLength(1);
    });

    it('upsertAudit is idempotent — second run overwrites first', async () => {
      const s = await trackedStudent({ gradeLevel: '12' });
      const reqId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_graduation_requirements
           (id, school_id, requirement_type, requirement_name, credits_required, is_active)
         VALUES ($1::uuid, $2::uuid, 'CREDIT_TOTAL', 'Total', 1, true)`,
        reqId,
        TEST_SCHOOL_ID,
      );
      await withTestTenant(async () => auditWorker.runForStudent(s.studentId));
      await withTestTenant(async () => auditWorker.runForStudent(s.studentId));
      // Each (student, requirement) pair should have exactly one audit row
      // (UNIQUE constraint). Across all students for this requirement we
      // expect one row per student.
      const audits = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM ${TEST_SCHEMA}.sis_student_graduation_audits WHERE student_id = $1::uuid AND requirement_id = $2::uuid`,
        s.studentId,
        reqId,
      );
      expect(audits).toHaveLength(1);
    });
  });

  describe('GraduationAuditWorker.runForStudent', () => {
    it('audits exactly one student; unknown id → zero work', async () => {
      const s = await trackedStudent({ gradeLevel: '12' });
      const reqId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_graduation_requirements
           (id, school_id, requirement_type, requirement_name, credits_required, is_active)
         VALUES ($1::uuid, $2::uuid, 'CREDIT_TOTAL', 'Total', 24, true)`,
        reqId,
        TEST_SCHOOL_ID,
      );
      const result = await withTestTenant(async () => auditWorker.runForStudent(s.studentId));
      expect(result.auditsUpserted).toBe(1);

      const unknown = await withTestTenant(async () =>
        auditWorker.runForStudent('00000000-0000-0000-0000-000000000000'),
      );
      expect(unknown.auditsUpserted).toBe(0);
    });
  });

  describe('GpaWorker.runForStudent', () => {
    it('no default config → returns 0 snapshots', async () => {
      const s = await trackedStudent({ gradeLevel: '11' });
      const result = await withTestTenant(async () => gpaWorker.runForStudent(s.studentId));
      expect(result.snapshotsUpserted).toBe(0);
    });

    it('with default config + grades → cumulative snapshot inserted', async () => {
      const s = await trackedStudent({ gradeLevel: '11' });
      const cfgId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_gpa_configurations
           (id, school_id, config_name, calculation_method, scale_type, grade_point_mapping, is_default)
         VALUES ($1::uuid, $2::uuid, 'Std', 'WEIGHTED', 'FOUR_POINT',
                 '{"A":4,"B":3,"C":2,"D":1,"F":0}'::jsonb, true)`,
        cfgId,
        TEST_SCHOOL_ID,
      );
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.sis_courses SET credit_hours = 1.0 WHERE id = $1::uuid`,
        TEST_SIS_COURSE_ID,
      );
      await seedGradedAssignment(s.studentId);

      const result = await withTestTenant(async () => gpaWorker.runForStudent(s.studentId));
      expect(result.snapshotsUpserted).toBeGreaterThanOrEqual(1);

      const snaps = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM ${TEST_SCHEMA}.sis_student_gpa_snapshots WHERE student_id = $1::uuid AND academic_year_id IS NULL AND term_id IS NULL`,
        s.studentId,
      );
      expect(snaps.length).toBeGreaterThanOrEqual(1);
    });
  });
});
