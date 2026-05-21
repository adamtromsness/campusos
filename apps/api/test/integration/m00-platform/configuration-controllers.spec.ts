import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { ConfigurationController } from '@modules/m00-platform/configuration/configuration.controller';
import {
  AcademicTreeService,
  BulkImportService,
  ConfigurationService,
  ConnectionsSummaryService,
  FacilityTreeService,
  PositionTreeService,
  SetupWizardService,
} from '@modules/m00-platform/configuration/configuration.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import { withTestTenant, TEST_SCHOOL_ID, TEST_SCHEMA } from '../helpers/tenant-context';

/**
 * Controller-layer coverage for m00-platform/configuration.
 *
 * The ConfigurationController has 12 HTTP route handlers spread across
 * 7 wizard steps (setup-status, facility-tree, building delete, space
 * delete, room import, academic-tree, grade-bands, position-tree,
 * connections-summary, wizard-progress GET/PATCH, staff import, student
 * import). Each route simply forwards to one of seven services; the
 * services already have deep DB-backed coverage (configuration.spec,
 * configuration-trees.spec, configuration-grade-bands.spec,
 * configuration-remaining.spec, configuration-bulk-imports.spec). This
 * spec instantiates the controller with real services + a real
 * TenantPrismaService and exercises every route at least once, plus the
 * conditional branches inside the controller itself (the importRooms
 * BadRequestException + the row-normalisation map).
 *
 * No permission seed is required because the controller class itself
 * has no guards — @RequirePermission metadata is consumed by
 * PermissionGuard which is not in the test chain. Tests drive the
 * route handlers directly with DTO payloads cast to `any`.
 */
describe('integration:m00-platform/configuration-controllers', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let controller: ConfigurationController;

  const createdBuildingIds: string[] = [];
  const createdSpaceIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();

    const configSvc = new ConfigurationService(tenantPrisma);
    const facilityTree = new FacilityTreeService(tenantPrisma);
    const academicTree = new AcademicTreeService(tenantPrisma);
    const positionTree = new PositionTreeService(tenantPrisma);
    const connections = new ConnectionsSummaryService(tenantPrisma);
    const setupWizard = new SetupWizardService(tenantPrisma, configSvc);
    const bulkImport = new BulkImportService(tenantPrisma);

    controller = new ConfigurationController(
      configSvc,
      facilityTree,
      academicTree,
      positionTree,
      connections,
      setupWizard,
      bulkImport,
    );
  });

  afterAll(async () => {
    // Final wipe of any controller-created fixtures
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.fac_spaces WHERE name LIKE 'CTRL-%' OR building_id IN
         (SELECT id FROM ${TEST_SCHEMA}.fac_buildings WHERE name LIKE 'CTRL-%')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.fac_buildings WHERE name LIKE 'CTRL-%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.school_config WHERE config_key IN
         ('setup_wizard_progress', 'grade_band_definitions')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.hr_employees WHERE account_id IN
         (SELECT id FROM platform.platform_users WHERE email LIKE 'ctrl-staff-%')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_users WHERE email LIKE 'ctrl-staff-%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'CTRL-STU-%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_students WHERE first_name = 'CtrlStu'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_person WHERE first_name IN ('CtrlStaff', 'CtrlStu', 'CtrlGrd')`,
    );
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    // Wipe wizard + grade-band config rows so each test starts clean.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.school_config WHERE config_key IN
         ('setup_wizard_progress', 'grade_band_definitions')`,
    );
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
    // Defensive wipe of any controller-imported rows by name pattern.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.fac_spaces WHERE name LIKE 'CTRL-Room-%' OR name LIKE 'CTRL-IMP-%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.fac_buildings WHERE name LIKE 'CTRL-Bldg-%'`,
    );
    // Defensive wipe of any controller-imported staff / students.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.hr_employees WHERE account_id IN
         (SELECT id FROM platform.platform_users WHERE email LIKE 'ctrl-staff-%')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_users WHERE email LIKE 'ctrl-staff-%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'CTRL-STU-%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_students WHERE first_name = 'CtrlStu'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_person WHERE first_name IN ('CtrlStaff', 'CtrlStu', 'CtrlGrd')`,
    );
  });

  async function seedBuilding(name: string): Promise<string> {
    const id = generateId();
    createdBuildingIds.push(id);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.fac_buildings (id, school_id, name, is_active)
       VALUES ($1::uuid, $2::uuid, $3, true)`,
      id,
      TEST_SCHOOL_ID,
      name,
    );
    return id;
  }

  async function seedSpace(buildingId: string, name: string): Promise<string> {
    const id = generateId();
    createdSpaceIds.push(id);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.fac_spaces
         (id, building_id, name, space_type, is_active)
       VALUES ($1::uuid, $2::uuid, $3, 'CLASSROOM', true)`,
      id,
      buildingId,
      name,
    );
    return id;
  }

  // ─── Step 1: setup-status ─────────────────────────────────────────
  describe('GET setup-status', () => {
    it('returns the 7-item checklist', async () => {
      const result = await withTestTenant(() => controller.setupStatus());
      expect(result.totalCount).toBe(7);
      expect(result.items.length).toBe(7);
      for (const item of result.items) {
        expect(['DONE', 'PARTIAL', 'NOT_STARTED']).toContain(item.status);
      }
    });
  });

  // ─── Step 2: facility-tree + building/space delete + import/rooms ─
  describe('GET facility-tree', () => {
    it('returns full facility hierarchy with schoolId + buildings array', async () => {
      const tree = await withTestTenant(() => controller.facilityTreeView());
      expect(tree.schoolId).toBe(TEST_SCHOOL_ID);
      expect(Array.isArray(tree.buildings)).toBe(true);
    });
  });

  describe('DELETE buildings/:id', () => {
    it('successfully deletes a building with no spaces', async () => {
      const id = await seedBuilding('CTRL-Bldg-Empty-' + generateId().slice(-6));
      const result = await withTestTenant(() => controller.deleteBuilding(id));
      expect(result.deleted).toBe(true);
      // Pop from tracker — already gone.
      createdBuildingIds.splice(createdBuildingIds.indexOf(id), 1);
      // Confirm DB row is gone.
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT 1 AS x FROM ${TEST_SCHEMA}.fac_buildings WHERE id = $1::uuid`,
        id,
      )) as Array<{ x: number }>;
      expect(rows).toHaveLength(0);
    });

    it('refuses delete when building has spaces (409 ConflictException)', async () => {
      const id = await seedBuilding('CTRL-Bldg-Busy-' + generateId().slice(-6));
      await seedSpace(id, 'CTRL-Room-1');
      await expect(withTestTenant(() => controller.deleteBuilding(id))).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('rejects unknown building id (404 NotFoundException)', async () => {
      await expect(
        withTestTenant(() => controller.deleteBuilding(generateId())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('DELETE spaces/:id', () => {
    it('successfully deletes a space with no scheduled timetable slots', async () => {
      const buildingId = await seedBuilding('CTRL-Bldg-Space-' + generateId().slice(-6));
      const spaceId = await seedSpace(buildingId, 'CTRL-Room-Delete');
      const result = await withTestTenant(() => controller.deleteSpace(spaceId));
      expect(result.deleted).toBe(true);
      createdSpaceIds.splice(createdSpaceIds.indexOf(spaceId), 1);
    });

    it('rejects unknown space id (404 NotFoundException)', async () => {
      await expect(
        withTestTenant(() => controller.deleteSpace(generateId())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('POST import/rooms', () => {
    it('imports rooms successfully', async () => {
      const buildingName = 'CTRL-Bldg-Imp-' + generateId().slice(-6);
      await seedBuilding(buildingName);
      const result = await withTestTenant(() =>
        controller.importRooms({
          rows: [
            {
              buildingName,
              roomName: 'CTRL-IMP-A',
              floor: '1',
              spaceType: 'CLASSROOM',
              areaSqft: 500,
            },
            {
              buildingName,
              roomName: 'CTRL-IMP-B',
              // floor + areaSqft omitted → normalised to null
              spaceType: 'CLASSROOM',
            },
          ],
        } as any),
      );
      expect(result.created).toBe(2);
      expect(result.skipped).toBe(0);
      // Surface the row-normalisation map: floor=null was applied.
      const stored = (await rawClient.$queryRawUnsafe(
        `SELECT name, floor FROM ${TEST_SCHEMA}.fac_spaces
           WHERE name IN ('CTRL-IMP-A', 'CTRL-IMP-B')
           ORDER BY name`,
      )) as Array<{ name: string; floor: string | null }>;
      expect(stored).toHaveLength(2);
      expect(stored[0]!.floor).toBe('1');
      expect(stored[1]!.floor).toBeNull();
    });

    it('throws BadRequestException when body is null', async () => {
      await expect(
        withTestTenant(() => controller.importRooms(null as any)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws BadRequestException when body.rows is not an array', async () => {
      await expect(
        withTestTenant(() => controller.importRooms({ rows: 'not-array' } as any)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws BadRequestException on row-validation failure (unknown building)', async () => {
      await expect(
        withTestTenant(() =>
          controller.importRooms({
            rows: [
              {
                buildingName: 'CTRL-Bldg-DoesNotExist-' + generateId().slice(-6),
                roomName: 'CTRL-IMP-X',
                floor: null,
                spaceType: 'CLASSROOM',
                areaSqft: null,
              },
            ],
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─── Step 3: academic-tree + grade-bands ──────────────────────────
  describe('GET academic-tree', () => {
    it('returns current-year tree when no academicYearId is passed', async () => {
      const tree = await withTestTenant(() => controller.academicTreeView());
      expect(tree.selectedYear).toBeTruthy();
      expect(Array.isArray(tree.terms)).toBe(true);
      expect(Array.isArray(tree.gradeBands)).toBe(true);
    });

    it('accepts academicYearId query parameter (falls back to current if unknown)', async () => {
      const tree = await withTestTenant(() =>
        controller.academicTreeView('00000000-0000-0000-0000-000000000099'),
      );
      expect(tree.selectedYear).toBeTruthy();
    });
  });

  describe('PATCH grade-bands', () => {
    it('replaces grade-band definitions and returns the persisted shape', async () => {
      const result = await withTestTenant(() =>
        controller.updateGradeBands({
          bands: [
            { key: 'elem', label: 'Elementary', grades: ['1', '2', '3'] },
            { key: 'mid', label: 'Middle', grades: ['6', '7', '8'] },
          ],
        } as any),
      );
      expect(result.bands).toHaveLength(2);
      expect(result.bands[0]!.key).toBe('elem');
      expect(result.bands[1]!.grades).toEqual(['6', '7', '8']);
    });

    it('rejects duplicate band keys', async () => {
      await expect(
        withTestTenant(() =>
          controller.updateGradeBands({
            bands: [
              { key: 'dup', label: 'A', grades: ['1'] },
              { key: 'dup', label: 'B', grades: ['2'] },
            ],
          } as any),
        ),
      ).rejects.toThrow(/Duplicate band key/);
    });
  });

  // ─── Step 4: position-tree ────────────────────────────────────────
  describe('GET position-tree', () => {
    it('returns the position forest with roots + flatList + vacantPositions', async () => {
      const tree = await withTestTenant(() => controller.positionTreeView());
      expect(Array.isArray(tree.roots)).toBe(true);
      expect(Array.isArray(tree.flatList)).toBe(true);
      expect(Array.isArray(tree.vacantPositions)).toBe(true);
      expect(tree.totalPositions).toBe(tree.filledCount + tree.vacantCount);
    });
  });

  // ─── Step 5: connections-summary ──────────────────────────────────
  describe('GET connections-summary', () => {
    it('returns the four link arrays + totals shape', async () => {
      const summary = await withTestTenant(() => controller.connectionsSummary());
      expect(Array.isArray(summary.buildingSchool)).toBe(true);
      expect(Array.isArray(summary.positionSchool)).toBe(true);
      expect(Array.isArray(summary.personPosition)).toBe(true);
      expect(Array.isArray(summary.classRoom)).toBe(true);
      expect(typeof summary.totals.buildings).toBe('number');
      expect(typeof summary.totals.positions).toBe('number');
      expect(summary.totals.classes).toBe(
        summary.totals.classesWithRoom + summary.totals.classesWithoutRoom,
      );
    });
  });

  // ─── Step 6: wizard-progress GET + PATCH ──────────────────────────
  describe('GET wizard-progress', () => {
    it('returns default progress (currentStep=1, completedSteps=[]) plus setupStatus', async () => {
      const result = await withTestTenant(() => controller.getWizardProgress());
      expect(result.currentStep).toBe(1);
      expect(result.completedSteps).toEqual([]);
      expect(result.setupStatus.items.length).toBe(7);
    });
  });

  describe('PATCH wizard-progress', () => {
    it('updates currentStep + markStepComplete in one call', async () => {
      const result = await withTestTenant(() =>
        controller.patchWizardProgress({ currentStep: 4, markStepComplete: 2 } as any),
      );
      expect(result.currentStep).toBe(4);
      expect(result.completedSteps).toEqual([2]);
    });

    it('empty body is a no-op', async () => {
      const result = await withTestTenant(() => controller.patchWizardProgress({} as any));
      expect(result.currentStep).toBe(1);
      expect(result.completedSteps).toEqual([]);
    });

    it('rejects out-of-range currentStep', async () => {
      await expect(
        withTestTenant(() => controller.patchWizardProgress({ currentStep: 99 } as any)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─── Step 7: import/staff + import/students ───────────────────────
  describe('POST import/staff', () => {
    it('imports a 1-row staff batch successfully', async () => {
      const result = await withTestTenant(() =>
        controller.importStaff({
          rows: [
            {
              firstName: 'CtrlStaff',
              lastName: 'Alpha',
              email: 'ctrl-staff-alpha-' + Date.now() + '@x.local',
            },
          ],
        } as any),
      );
      expect(result.created).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.errors).toEqual([]);
    });

    it('skips an existing email (idempotent re-import)', async () => {
      const email = 'ctrl-staff-dup-' + Date.now() + '@x.local';
      await withTestTenant(() =>
        controller.importStaff({
          rows: [{ firstName: 'CtrlStaff', lastName: 'First', email }],
        } as any),
      );
      const result = await withTestTenant(() =>
        controller.importStaff({
          rows: [{ firstName: 'CtrlStaff', lastName: 'Second', email }],
        } as any),
      );
      expect(result.created).toBe(0);
      expect(result.skipped).toBe(1);
    });
  });

  describe('POST import/students', () => {
    it('imports a 1-row student batch successfully', async () => {
      const studentNumber = 'CTRL-STU-' + Date.now();
      const result = await withTestTenant(() =>
        controller.importStudents({
          rows: [
            {
              firstName: 'CtrlStu',
              lastName: 'Solo',
              studentNumber,
            },
          ],
        } as any),
      );
      expect(result.created).toBe(1);
      expect(result.skipped).toBe(0);
    });

    it('imports a student with guardian reuse + grade level', async () => {
      const studentNumber = 'CTRL-STU-G-' + Date.now();
      const guardianEmail = 'ctrl-staff-grd-' + Date.now() + '@x.local';
      const result = await withTestTenant(() =>
        controller.importStudents({
          rows: [
            {
              firstName: 'CtrlStu',
              lastName: 'WithGuardian',
              studentNumber,
              gradeLevel: '7',
              guardianFirstName: 'CtrlGrd',
              guardianLastName: 'Parent',
              guardianEmail,
            },
          ],
        } as any),
      );
      expect(result.created).toBe(1);
    });

    it('skips a duplicate student_number on second import', async () => {
      const studentNumber = 'CTRL-STU-DUP-' + Date.now();
      await withTestTenant(() =>
        controller.importStudents({
          rows: [{ firstName: 'CtrlStu', lastName: 'First', studentNumber }],
        } as any),
      );
      const result = await withTestTenant(() =>
        controller.importStudents({
          rows: [{ firstName: 'CtrlStu', lastName: 'Second', studentNumber }],
        } as any),
      );
      expect(result.created).toBe(0);
      expect(result.skipped).toBe(1);
    });
  });
});
