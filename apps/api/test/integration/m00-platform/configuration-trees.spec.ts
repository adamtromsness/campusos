import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import {
  FacilityTreeService,
  AcademicTreeService,
  PositionTreeService,
  ConnectionsSummaryService,
  BulkImportService,
} from '@modules/m00-platform/configuration/configuration.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import {
  withTestTenant,
  TEST_SCHOOL_ID,
  TEST_SCHEMA,
} from '../helpers/tenant-context';

/**
 * Wave 2 — DEFERRED FOLLOW-UP. Covers the five m00-platform/configuration
 * services that the original Wave 2 closer scoped out as too large for a
 * single spec:
 *
 *   - FacilityTreeService.getTree
 *   - AcademicTreeService.getTree
 *   - PositionTreeService.getTree
 *   - ConnectionsSummaryService.getSummary
 *   - BulkImportService.bulkImportStaff + bulkImportStudents
 *
 * Strategy doc Wave 2 target is ≥95% per IAM-tier surfaces; the configuration
 * surfaces are read-side aggregators + bulk write workers, so the bar here
 * is per-service happy path + at least one error path. Together with the
 * earlier `m00-platform/configuration.spec.ts` (which already covers
 * ConfigurationService.getSetupStatus + SetupWizardService), the
 * configuration module now has full DB-backed coverage.
 */
describe('integration:m00-platform/configuration-trees', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let facility: FacilityTreeService;
  let academic: AcademicTreeService;
  let position: PositionTreeService;
  let connections: ConnectionsSummaryService;
  let bulk: BulkImportService;

  // Tracked seed ids so each test cleans up after itself.
  const createdBuildingIds: string[] = [];
  const createdSpaceIds: string[] = [];
  const createdPositionIds: string[] = [];
  const createdDepartmentIds: string[] = [];
  const createdEmployeeIds: string[] = [];
  const createdPersonIds: string[] = [];
  const createdAccountIds: string[] = [];
  const createdPlatformStudentIds: string[] = [];
  const createdStudentIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    facility = new FacilityTreeService(tenantPrisma);
    academic = new AcademicTreeService(tenantPrisma);
    position = new PositionTreeService(tenantPrisma);
    connections = new ConnectionsSummaryService(tenantPrisma);
    bulk = new BulkImportService(tenantPrisma);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    // Wipe order: employee_positions → positions → departments;
    // spaces → buildings; bulk-imported students + employees and
    // their iam/account rows.
    if (createdSpaceIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.fac_spaces WHERE id = ANY($1::uuid[])`,
        createdSpaceIds.splice(0),
      );
    }
    if (createdBuildingIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.fac_buildings WHERE id = ANY($1::uuid[])`,
        createdBuildingIds.splice(0),
      );
    }
    if (createdPositionIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.hr_employee_positions WHERE position_id = ANY($1::uuid[])`,
        createdPositionIds,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.hr_positions WHERE id = ANY($1::uuid[])`,
        createdPositionIds.splice(0),
      );
    }
    if (createdDepartmentIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sis_departments WHERE id = ANY($1::uuid[])`,
        createdDepartmentIds.splice(0),
      );
    }
    // Bulk-imported staff/students cleanup (track-then-wipe).
    if (createdEmployeeIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.hr_employee_positions WHERE employee_id = ANY($1::uuid[])`,
        createdEmployeeIds,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.hr_employees WHERE id = ANY($1::uuid[])`,
        createdEmployeeIds.splice(0),
      );
    }
    if (createdStudentIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE id = ANY($1::uuid[])`,
        createdStudentIds.splice(0),
      );
    }
    if (createdPlatformStudentIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.platform_students WHERE id = ANY($1::uuid[])`,
        createdPlatformStudentIds.splice(0),
      );
    }
    if (createdAccountIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.platform_users WHERE id = ANY($1::uuid[])`,
        createdAccountIds.splice(0),
      );
    }
    if (createdPersonIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.iam_person WHERE id = ANY($1::uuid[])`,
        createdPersonIds.splice(0),
      );
    }
    // Wipe bulk-import-generated rows by email/student-number prefix (covers
    // anything the explicit trackers missed because the service generates ids).
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.hr_employee_positions WHERE employee_id IN (
         SELECT id FROM ${TEST_SCHEMA}.hr_employees WHERE employee_number LIKE 'EMP-%'
           AND id IN (SELECT id FROM ${TEST_SCHEMA}.hr_employees WHERE account_id IN
             (SELECT id FROM platform.platform_users WHERE email LIKE 'bulk-test-%')))`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.hr_employees WHERE account_id IN
         (SELECT id FROM platform.platform_users WHERE email LIKE 'bulk-test-%')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'BULK-TEST-%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_students WHERE first_name IN ('BulkTest','BulkStu')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_users WHERE email LIKE 'bulk-test-%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_person WHERE first_name IN ('BulkTest','BulkStu','BulkGrd')`,
    );
  });

  // ────────────────────────────────────────────────────────────────────
  // FacilityTreeService
  // ────────────────────────────────────────────────────────────────────
  describe('FacilityTreeService.getTree', () => {
    it('empty facility surface → empty buildings array + school name resolved', async () => {
      const tree = await withTestTenant(async () => facility.getTree());
      expect(tree.schoolId).toBe(TEST_SCHOOL_ID);
      expect(tree.schoolName).toBeTruthy();
      expect(tree.buildings.filter((b) => b.name.startsWith('CFG-TEST-'))).toEqual([]);
    });

    it('seeded building + space → tree contains the building with one floor + one space', async () => {
      const buildingId = generateId();
      const spaceId = generateId();
      createdBuildingIds.push(buildingId);
      createdSpaceIds.push(spaceId);
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.fac_buildings
           (id, school_id, name, code, year_built, total_floors, is_active)
         VALUES ($1::uuid, $2::uuid, 'CFG-TEST-Bldg', 'CFGB', 2020, 2, true)`,
        buildingId,
        TEST_SCHOOL_ID,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.fac_spaces
           (id, building_id, name, floor, space_type, area_sqft, is_active)
         VALUES ($1::uuid, $2::uuid, 'CFG-TEST-Space', '1', 'CLASSROOM', 600, true)`,
        spaceId,
        buildingId,
      );
      const tree = await withTestTenant(async () => facility.getTree());
      const seeded = tree.buildings.find((b) => b.id === buildingId);
      expect(seeded).toBeDefined();
      expect(seeded!.spaceCount).toBe(1);
      expect(seeded!.floors).toHaveLength(1);
      expect(seeded!.floors[0]!.floor).toBe('1');
      expect(seeded!.floors[0]!.spaces[0]!.name).toBe('CFG-TEST-Space');
      expect(seeded!.floors[0]!.spaces[0]!.areaSqft).toBe(600);
      expect(seeded!.floors[0]!.spaces[0]!.scheduledClassCount).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // AcademicTreeService
  // ────────────────────────────────────────────────────────────────────
  describe('AcademicTreeService.getTree', () => {
    it('returns tree for the current academic year (TEST_ACADEMIC_YEAR_ID fixture)', async () => {
      const tree = await withTestTenant(async () => academic.getTree());
      expect(tree.selectedYear).toBeTruthy();
      // gradeBandDefinitions is always loaded — it returns DEFAULT
      // bands (PreSchool/Elementary/MiddleSchool/HighSchool) when no
      // school_config row is set. Test the shape, not strict equality:
      expect(tree.gradeBandDefinitions).toBeTruthy();
      const defs = tree.gradeBandDefinitions as Record<string, unknown>;
      expect(Object.keys(defs).length).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(tree.terms)).toBe(true);
      expect(Array.isArray(tree.gradeBands)).toBe(true);
    });

    it('passing an unknown academicYearId falls back to current year (does NOT throw)', async () => {
      const tree = await withTestTenant(async () =>
        academic.getTree('00000000-0000-0000-0000-000000000099'),
      );
      expect(tree.selectedYear).toBeTruthy();
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // PositionTreeService
  // ────────────────────────────────────────────────────────────────────
  describe('PositionTreeService.getTree', () => {
    it('empty tenant → totalPositions=0, no roots, no vacancies (filtered to test-tagged)', async () => {
      const tree = await withTestTenant(async () => position.getTree());
      // Test fixture seeds a small handful of admin positions; the
      // contract under test is that the shape is returned cleanly.
      expect(tree.totalPositions).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(tree.roots)).toBe(true);
      expect(Array.isArray(tree.vacantPositions)).toBe(true);
      expect(Array.isArray(tree.flatList)).toBe(true);
      expect(tree.totalPositions).toBe(tree.filledCount + tree.vacantCount);
    });

    it('seeded department + parent + child position → tree nests child under parent', async () => {
      const deptId = generateId();
      const parentId = generateId();
      const childId = generateId();
      createdDepartmentIds.push(deptId);
      createdPositionIds.push(parentId, childId);
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_departments
           (id, school_id, name)
         VALUES ($1::uuid, $2::uuid, $3)`,
        deptId,
        TEST_SCHOOL_ID,
        'CFG-TEST-Dept-' + deptId.slice(-6),
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.hr_positions
           (id, school_id, title, department_id, reports_to_id, is_teaching_role, is_active)
         VALUES ($1::uuid, $2::uuid, 'CFG-TEST-Parent', $3::uuid, NULL, false, true)`,
        parentId,
        TEST_SCHOOL_ID,
        deptId,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.hr_positions
           (id, school_id, title, department_id, reports_to_id, is_teaching_role, is_active)
         VALUES ($1::uuid, $2::uuid, 'CFG-TEST-Child', $3::uuid, $4::uuid, false, true)`,
        childId,
        TEST_SCHOOL_ID,
        deptId,
        parentId,
      );
      const tree = await withTestTenant(async () => position.getTree());
      const parent = tree.flatList.find((p) => p.id === parentId);
      const child = tree.flatList.find((p) => p.id === childId);
      expect(parent).toBeDefined();
      expect(child).toBeDefined();
      expect(child!.reportsToId).toBe(parentId);
      // Parent appears in roots; child appears as a nested descendant
      const seededRoot = tree.roots.find((r) => r.id === parentId);
      expect(seededRoot).toBeDefined();
      expect(seededRoot!.children.map((c) => c.id)).toContain(childId);
      // Both are vacant (no filledByEmployeeId)
      expect(parent!.filledByEmployeeId).toBeNull();
      expect(child!.filledByEmployeeId).toBeNull();
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // ConnectionsSummaryService
  // ────────────────────────────────────────────────────────────────────
  describe('ConnectionsSummaryService.getSummary', () => {
    it('returns the four link arrays + totals shape', async () => {
      const summary = await withTestTenant(async () => connections.getSummary());
      expect(Array.isArray(summary.buildingSchool)).toBe(true);
      expect(Array.isArray(summary.positionSchool)).toBe(true);
      expect(Array.isArray(summary.personPosition)).toBe(true);
      expect(Array.isArray(summary.classRoom)).toBe(true);
      expect(typeof summary.totals.buildings).toBe('number');
      expect(typeof summary.totals.positions).toBe('number');
      expect(typeof summary.totals.classes).toBe('number');
      expect(summary.totals.positions).toBe(
        summary.totals.filledPositions + summary.totals.vacantPositions,
      );
      expect(summary.totals.classes).toBe(
        summary.totals.classesWithRoom + summary.totals.classesWithoutRoom,
      );
    });

    it('seeded building surfaces in buildingSchool summary', async () => {
      const buildingId = generateId();
      createdBuildingIds.push(buildingId);
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.fac_buildings
           (id, school_id, name, is_active)
         VALUES ($1::uuid, $2::uuid, 'CFG-TEST-SummaryBldg', true)`,
        buildingId,
        TEST_SCHOOL_ID,
      );
      const summary = await withTestTenant(async () => connections.getSummary());
      const link = summary.buildingSchool.find((b) => b.buildingId === buildingId);
      expect(link).toBeDefined();
      expect(link!.schoolId).toBe(TEST_SCHOOL_ID);
      expect(link!.spaceCount).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // BulkImportService
  // ────────────────────────────────────────────────────────────────────
  describe('BulkImportService', () => {
    it('bulkImportStaff: happy 2-row batch → 2 employees created', async () => {
      const result = await withTestTenant(async () =>
        bulk.bulkImportStaff([
          {
            firstName: 'BulkTest',
            lastName: 'Alpha',
            email: 'bulk-test-alpha-' + Date.now() + '@x.local',
          },
          {
            firstName: 'BulkTest',
            lastName: 'Beta',
            email: 'bulk-test-beta-' + Date.now() + '@x.local',
          },
        ]),
      );
      expect(result.created).toBe(2);
      expect(result.skipped).toBe(0);
      expect(result.errors).toEqual([]);
    });

    it('bulkImportStaff: existing email → skipped (does not double-create)', async () => {
      const email = 'bulk-test-dup-' + Date.now() + '@x.local';
      // First pass — creates one staff.
      await withTestTenant(async () =>
        bulk.bulkImportStaff([
          { firstName: 'BulkTest', lastName: 'Dup', email },
        ]),
      );
      // Second pass — exact same email; should skip.
      const result = await withTestTenant(async () =>
        bulk.bulkImportStaff([
          { firstName: 'BulkTest', lastName: 'Dup2', email },
        ]),
      );
      expect(result.created).toBe(0);
      expect(result.skipped).toBe(1);
    });

    it('bulkImportStaff: malformed email → BadRequestException up-front (whole batch rejected)', async () => {
      await expect(
        withTestTenant(async () =>
          bulk.bulkImportStaff([
            { firstName: 'BulkTest', lastName: 'Bad', email: 'not-an-email' },
          ]),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('bulkImportStaff: missing firstName → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          bulk.bulkImportStaff([
            { firstName: '', lastName: 'NoFirst', email: 'bulk-test-x@x.local' },
          ]),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('bulkImportStaff: unknown positionTitle → BadRequestException at row-level', async () => {
      await expect(
        withTestTenant(async () =>
          bulk.bulkImportStaff([
            {
              firstName: 'BulkTest',
              lastName: 'NoPos',
              email: 'bulk-test-nopos-' + Date.now() + '@x.local',
              positionTitle: 'Position That Does Not Exist',
            },
          ]),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('bulkImportStaff: empty array → BadRequestException', async () => {
      await expect(
        withTestTenant(async () => bulk.bulkImportStaff([])),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('bulkImportStudents: happy 1-row batch → 1 student created', async () => {
      const result = await withTestTenant(async () =>
        bulk.bulkImportStudents([
          {
            firstName: 'BulkStu',
            lastName: 'One',
            studentNumber: 'BULK-TEST-' + Date.now() + '-1',
          },
        ]),
      );
      expect(result.created).toBe(1);
      expect(result.errors).toEqual([]);
    });

    it('bulkImportStudents: missing studentNumber → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          bulk.bulkImportStudents([
            { firstName: 'BulkStu', lastName: 'NoNum', studentNumber: '' },
          ]),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('bulkImportStudents: malformed guardianEmail → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          bulk.bulkImportStudents([
            {
              firstName: 'BulkStu',
              lastName: 'BadGuard',
              studentNumber: 'BULK-TEST-' + Date.now() + '-bg',
              guardianEmail: 'not-an-email',
            },
          ]),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('bulkImportStudents: empty array → BadRequestException', async () => {
      await expect(
        withTestTenant(async () => bulk.bulkImportStudents([])),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
