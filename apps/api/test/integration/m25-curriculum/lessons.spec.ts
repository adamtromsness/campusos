import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { CurriculumMapService, UnitService } from '@modules/m25-curriculum/maps.service';
import { StandardService } from '@modules/m25-curriculum/frameworks.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import { adminActor, teacherActor, TEST_TEACHER_EMPLOYEE_ID } from '../helpers/actor';
import {
  TEST_SIS_ACADEMIC_YEAR_ID,
  TEST_SIS_ACADEMIC_YEAR_B_ID,
  TEST_SIS_CLASS_ID,
  TEST_SIS_CLASS_B_ID,
} from '../fixtures/sis';

/**
 * Wave 4 — m25-curriculum UnitService.linkLesson + unlinkLesson
 * DB-backed integration tests for the CROSS-CYCLE READ-BACK KEYSTONE.
 *
 * Contracts verified:
 *   - linkLesson admin-writer gate.
 *   - clsLessonId must exist in cls_lessons under the current school.
 *
 *   CODEX FINDING (P2-H5 DEFECT 1b): linkLesson validates BOTH the
 *   unit's owning school AND the lesson's school in the same
 *   transaction. Cross-school unitId combined with a valid
 *   current-school lesson → BadRequestException, no foreign link
 *   row inserted. Cross-school lessonId likewise rejected.
 *
 *   - Duplicate (unit, lesson) → ConflictException via the
 *     UNIQUE(unit_id, cls_lesson_id) constraint.
 *   - unlinkLesson is school-scoped via the JOIN through cur_units →
 *     cur_curriculum_maps.school_id — a cross-school DELETE is a no-op.
 */
describe('integration:m25-curriculum/lessons', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let mapService: CurriculumMapService;
  let unitService: UnitService;
  let standardService: StandardService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    standardService = new StandardService(tenantPrisma, permCheck);
    mapService = new CurriculumMapService(tenantPrisma, permCheck);
    unitService = new UnitService(tenantPrisma, permCheck, standardService);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cur_unit_lessons`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cur_unit_standards`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cur_delivery_gaps`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cur_resource_links`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cur_units`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cur_curriculum_maps`);
    // Wipe lessons we seed below — be surgical so we don't disturb
    // fixtures owned by other suites that share tenant_test.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.cls_lessons WHERE title LIKE 'CUR-LESSON-%'`,
    );
  });

  async function seedLesson(opts: {
    schoolId: string;
    classId: string;
    title?: string;
    status?: string;
    date?: string | null;
  }): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.cls_lessons
         (id, school_id, class_id, teacher_id, title, status, date)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::date)`,
      id,
      opts.schoolId,
      opts.classId,
      TEST_TEACHER_EMPLOYEE_ID,
      opts.title ?? 'CUR-LESSON-' + id.slice(0, 8),
      opts.status ?? 'PUBLISHED',
      opts.date ?? null,
    );
    return id;
  }

  async function seedMapAndUnit(
    schoolId: string,
    yearId: string,
  ): Promise<{ mapId: string; unitId: string }> {
    const mapId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.cur_curriculum_maps
         (id, school_id, academic_year_id, subject, grade_level, title, created_by, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'Math', '5', 'M', $4::uuid, 'DRAFT')`,
      mapId,
      schoolId,
      yearId,
      adminActor().accountId,
    );
    const unitId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.cur_units (id, curriculum_map_id, title, sequence_order)
       VALUES ($1::uuid, $2::uuid, 'U1', 1)`,
      unitId,
      mapId,
    );
    return { mapId, unitId };
  }

  // ──────────────────────────────────────────────────────────────
  // linkLesson — happy path
  // ──────────────────────────────────────────────────────────────
  describe('linkLesson', () => {
    it('admin links a current-school lesson to a current-school unit', async () => {
      const { unitId } = await seedMapAndUnit(TEST_SCHOOL_ID, TEST_SIS_ACADEMIC_YEAR_ID);
      const lessonId = await seedLesson({
        schoolId: TEST_SCHOOL_ID,
        classId: TEST_SIS_CLASS_ID,
        title: 'CUR-LESSON-A',
        status: 'PUBLISHED',
        date: '2026-09-01',
      });

      const link = await withTestTenant(async () =>
        unitService.linkLesson(unitId, { clsLessonId: lessonId }, adminActor()),
      );
      expect(link.unitId).toBe(unitId);
      expect(link.clsLessonId).toBe(lessonId);
      expect(link.lessonTitle).toBe('CUR-LESSON-A');
      expect(link.lessonStatus).toBe('PUBLISHED');
      expect(link.lessonDate).toBe('2026-09-01');

      const row = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.cur_unit_lessons WHERE unit_id = $1::uuid AND cls_lesson_id = $2::uuid`,
        unitId,
        lessonId,
      );
      expect(row[0]!.count).toBe(1);
    });

    it('non-writer (teacher with no grants) → ForbiddenException', async () => {
      const { unitId } = await seedMapAndUnit(TEST_SCHOOL_ID, TEST_SIS_ACADEMIC_YEAR_ID);
      const lessonId = await seedLesson({
        schoolId: TEST_SCHOOL_ID,
        classId: TEST_SIS_CLASS_ID,
      });
      await expect(
        withTestTenant(async () =>
          unitService.linkLesson(unitId, { clsLessonId: lessonId }, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('unknown clsLessonId → BadRequestException', async () => {
      const { unitId } = await seedMapAndUnit(TEST_SCHOOL_ID, TEST_SIS_ACADEMIC_YEAR_ID);
      await expect(
        withTestTenant(async () =>
          unitService.linkLesson(
            unitId,
            { clsLessonId: '00000000-0000-0000-0000-000000000000' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('CODEX FINDING: cross-school lessonId → BadRequest, no link inserted', async () => {
      // Unit is School A, lesson is School B. The pre-fix code already
      // checked the lesson; this assertion verifies the contract holds.
      const { unitId } = await seedMapAndUnit(TEST_SCHOOL_ID, TEST_SIS_ACADEMIC_YEAR_ID);
      const foreignLesson = await seedLesson({
        schoolId: TEST_SCHOOL_B_ID,
        classId: TEST_SIS_CLASS_B_ID,
        title: 'CUR-LESSON-FOREIGN',
      });
      await expect(
        withTestTenant(async () =>
          unitService.linkLesson(unitId, { clsLessonId: foreignLesson }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      const rows = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.cur_unit_lessons WHERE unit_id = $1::uuid`,
        unitId,
      );
      expect(rows[0]!.count).toBe(0);
    });

    it('CODEX FINDING: cross-school unitId + current-school lesson → BadRequest', async () => {
      // The CODEX bug was exactly this shape — School A admin crafts
      // a foreign unitId, supplies a valid current-school lessonId,
      // and pre-fix the link landed under the foreign unit.
      const { unitId: foreignUnit } = await seedMapAndUnit(
        TEST_SCHOOL_B_ID,
        TEST_SIS_ACADEMIC_YEAR_B_ID,
      );
      const lessonId = await seedLesson({
        schoolId: TEST_SCHOOL_ID,
        classId: TEST_SIS_CLASS_ID,
        title: 'CUR-LESSON-LOCAL',
      });
      await expect(
        withTestTenant(async () =>
          unitService.linkLesson(foreignUnit, { clsLessonId: lessonId }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      const rows = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.cur_unit_lessons WHERE unit_id = $1::uuid`,
        foreignUnit,
      );
      expect(rows[0]!.count).toBe(0);
    });

    it('CODEX FINDING: both unitId and lessonId foreign → BadRequest', async () => {
      const { unitId: foreignUnit } = await seedMapAndUnit(
        TEST_SCHOOL_B_ID,
        TEST_SIS_ACADEMIC_YEAR_B_ID,
      );
      const foreignLesson = await seedLesson({
        schoolId: TEST_SCHOOL_B_ID,
        classId: TEST_SIS_CLASS_B_ID,
      });
      await expect(
        withTestTenant(async () =>
          unitService.linkLesson(
            foreignUnit,
            { clsLessonId: foreignLesson },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('unknown unitId → BadRequestException', async () => {
      const lessonId = await seedLesson({
        schoolId: TEST_SCHOOL_ID,
        classId: TEST_SIS_CLASS_ID,
      });
      await expect(
        withTestTenant(async () =>
          unitService.linkLesson(
            '00000000-0000-0000-0000-000000000000',
            { clsLessonId: lessonId },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('duplicate (unit, lesson) → ConflictException', async () => {
      const { unitId } = await seedMapAndUnit(TEST_SCHOOL_ID, TEST_SIS_ACADEMIC_YEAR_ID);
      const lessonId = await seedLesson({
        schoolId: TEST_SCHOOL_ID,
        classId: TEST_SIS_CLASS_ID,
        title: 'CUR-LESSON-DUP',
      });
      await withTestTenant(async () =>
        unitService.linkLesson(unitId, { clsLessonId: lessonId }, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          unitService.linkLesson(unitId, { clsLessonId: lessonId }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('lesson with NULL date → linked DTO returns lessonDate=null', async () => {
      const { unitId } = await seedMapAndUnit(TEST_SCHOOL_ID, TEST_SIS_ACADEMIC_YEAR_ID);
      const lessonId = await seedLesson({
        schoolId: TEST_SCHOOL_ID,
        classId: TEST_SIS_CLASS_ID,
        title: 'CUR-LESSON-NODATE',
        date: null,
      });
      const link = await withTestTenant(async () =>
        unitService.linkLesson(unitId, { clsLessonId: lessonId }, adminActor()),
      );
      expect(link.lessonDate).toBeNull();
    });

    it('TEMPLATE lesson (status=TEMPLATE, no class_id) can be linked', async () => {
      // Templates are valid lesson rows — cls_lessons_status_chk allows
      // TEMPLATE, cls_lessons_template_class_chk requires class_id NULL
      // when is_template=true. Seed one and verify the service accepts.
      const { unitId } = await seedMapAndUnit(TEST_SCHOOL_ID, TEST_SIS_ACADEMIC_YEAR_ID);
      const lessonId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.cls_lessons
           (id, school_id, class_id, teacher_id, title, status, is_template)
         VALUES ($1::uuid, $2::uuid, NULL, $3::uuid, 'CUR-LESSON-TPL', 'TEMPLATE', true)`,
        lessonId,
        TEST_SCHOOL_ID,
        TEST_TEACHER_EMPLOYEE_ID,
      );
      const link = await withTestTenant(async () =>
        unitService.linkLesson(unitId, { clsLessonId: lessonId }, adminActor()),
      );
      expect(link.clsLessonId).toBe(lessonId);
      expect(link.lessonStatus).toBe('TEMPLATE');
    });
  });

  // ──────────────────────────────────────────────────────────────
  // unlinkLesson
  // ──────────────────────────────────────────────────────────────
  describe('unlinkLesson', () => {
    it('admin removes a link → row deleted', async () => {
      const { unitId } = await seedMapAndUnit(TEST_SCHOOL_ID, TEST_SIS_ACADEMIC_YEAR_ID);
      const lessonId = await seedLesson({
        schoolId: TEST_SCHOOL_ID,
        classId: TEST_SIS_CLASS_ID,
        title: 'CUR-LESSON-UNLINK',
      });
      const link = await withTestTenant(async () =>
        unitService.linkLesson(unitId, { clsLessonId: lessonId }, adminActor()),
      );
      await withTestTenant(async () => unitService.unlinkLesson(link.id, adminActor()));
      const rows = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.cur_unit_lessons WHERE id = $1::uuid`,
        link.id,
      );
      expect(rows[0]!.count).toBe(0);
    });

    it('cross-school: unlinkLesson from School B context does NOT delete a School-A link', async () => {
      const { unitId } = await seedMapAndUnit(TEST_SCHOOL_ID, TEST_SIS_ACADEMIC_YEAR_ID);
      const lessonId = await seedLesson({
        schoolId: TEST_SCHOOL_ID,
        classId: TEST_SIS_CLASS_ID,
        title: 'CUR-LESSON-PROTECTED',
      });
      const link = await withTestTenant(async () =>
        unitService.linkLesson(unitId, { clsLessonId: lessonId }, adminActor()),
      );
      // Switching tenant context to School B should not be able to
      // delete School A's link — the JOIN through m.school_id matches
      // nothing.
      await withTestTenantB(async () => unitService.unlinkLesson(link.id, adminActor()));
      const rows = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.cur_unit_lessons WHERE id = $1::uuid`,
        link.id,
      );
      expect(rows[0]!.count).toBe(1);
    });

    it('non-writer (teacher with no grants) → ForbiddenException', async () => {
      const { unitId } = await seedMapAndUnit(TEST_SCHOOL_ID, TEST_SIS_ACADEMIC_YEAR_ID);
      const lessonId = await seedLesson({
        schoolId: TEST_SCHOOL_ID,
        classId: TEST_SIS_CLASS_ID,
      });
      const link = await withTestTenant(async () =>
        unitService.linkLesson(unitId, { clsLessonId: lessonId }, adminActor()),
      );
      await expect(
        withTestTenant(async () => unitService.unlinkLesson(link.id, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('unknown linkId → no-op (DELETE matches zero rows, no throw)', async () => {
      await expect(
        withTestTenant(async () =>
          unitService.unlinkLesson('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).resolves.toBeUndefined();
    });
  });

  // Keep unused-import lint quiet — kept for parity.
  void mapService;
  void NotFoundException;
});
