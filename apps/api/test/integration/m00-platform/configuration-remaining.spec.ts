import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import {
  FacilityTreeService,
  ConnectionsSummaryService,
  AcademicTreeService,
} from '@modules/m00-platform/configuration/configuration.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import { withTestTenant, TEST_SCHOOL_ID, TEST_SCHEMA } from '../helpers/tenant-context';

/**
 * Covers configuration.service.ts paths not exercised by the existing
 * configuration / configuration-trees / configuration-bulk-imports
 * specs:
 *
 *   - compareFloorKeys sort branches when fac_spaces carry mixed
 *     numeric / string / null floor values (lines 499-511)
 *   - ConnectionsSummaryService positionSchool + personPosition row
 *     mappings (lines 1078-1085, 1115-1122) — these execute only when
 *     the school has at least one position + filled assignment
 */
describe('integration:m00-platform/configuration-remaining', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let facility: FacilityTreeService;
  let connections: ConnectionsSummaryService;
  let academic: AcademicTreeService;

  const createdBuildingIds: string[] = [];
  const createdSpaceIds: string[] = [];
  const createdDepartmentIds: string[] = [];
  const createdPositionIds: string[] = [];
  const createdEmployeeIds: string[] = [];
  const createdPersonIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    facility = new FacilityTreeService(tenantPrisma);
    connections = new ConnectionsSummaryService(tenantPrisma);
    academic = new AcademicTreeService(tenantPrisma);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
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
    // hr_employee_positions cascades on position delete; explicit wipe
    // by employee for defensive cleanup.
    if (createdEmployeeIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.hr_employee_positions WHERE employee_id = ANY($1::uuid[])`,
        createdEmployeeIds,
      );
    }
    if (createdPositionIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.hr_positions WHERE id = ANY($1::uuid[])`,
        createdPositionIds.splice(0),
      );
    }
    if (createdEmployeeIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.hr_employees WHERE id = ANY($1::uuid[])`,
        createdEmployeeIds.splice(0),
      );
    }
    if (createdDepartmentIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sis_departments WHERE id = ANY($1::uuid[])`,
        createdDepartmentIds.splice(0),
      );
    }
    if (createdPersonIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.iam_person WHERE id = ANY($1::uuid[])`,
        createdPersonIds.splice(0),
      );
    }
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

  async function seedSpace(
    buildingId: string,
    name: string,
    floor: string | null,
  ): Promise<string> {
    const id = generateId();
    createdSpaceIds.push(id);
    if (floor === null) {
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.fac_spaces
           (id, building_id, name, floor, space_type, is_active)
         VALUES ($1::uuid, $2::uuid, $3, NULL, 'CLASSROOM', true)`,
        id,
        buildingId,
        name,
      );
    } else {
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.fac_spaces
           (id, building_id, name, floor, space_type, is_active)
         VALUES ($1::uuid, $2::uuid, $3, $4, 'CLASSROOM', true)`,
        id,
        buildingId,
        name,
        floor,
      );
    }
    return id;
  }

  // ─── compareFloorKeys sort branches ─────────────────────────

  describe('FacilityTreeService.getTree floor sort branches', () => {
    it('sorts numeric floors ascending, then string floors, then no-floor last', async () => {
      const buildingId = await seedBuilding('CFG-Sort-' + generateId().slice(-6));
      // Seed spaces with mixed floor keys to exercise every
      // compareFloorKeys branch:
      //  - numeric vs numeric ("1" < "2" → an - bn < 0)
      //  - numeric vs string ("2" < "Mezzanine" → aNumeric -1)
      //  - string vs numeric ("Mezzanine" > "1" → bNumeric 1)
      //  - string vs string ("Annex" < "Mezzanine" → localeCompare)
      //  - real floor vs no-floor → no-floor lands last
      await seedSpace(buildingId, 'Room 201', '2');
      await seedSpace(buildingId, 'Room 101', '1');
      await seedSpace(buildingId, 'Room Mezz', 'Mezzanine');
      await seedSpace(buildingId, 'Room Annex', 'Annex');
      await seedSpace(buildingId, 'Loose Room', null);

      const tree = await withTestTenant(async () => facility.getTree());
      const ourBuilding = tree.buildings.find((b) => b.id === buildingId);
      expect(ourBuilding).toBeDefined();
      // Floors are ordered: numeric ascending, then strings localeCompare,
      // then null (unfloored) last.
      const floorKeys = ourBuilding!.floors.map((f) => f.floor);
      const numericPositions = floorKeys.indexOf('2');
      const onePosition = floorKeys.indexOf('1');
      expect(onePosition).toBeGreaterThanOrEqual(0);
      expect(numericPositions).toBeGreaterThanOrEqual(0);
      expect(onePosition).toBeLessThan(numericPositions);
      // Null floor (unfloored / outdoor) lands at the end.
      expect(floorKeys[floorKeys.length - 1]).toBeNull();
    });
  });

  // ─── ConnectionsSummaryService row mappings ─────────────────

  describe('ConnectionsSummaryService.getSummary with seeded position + employee', () => {
    async function seedPersonAndEmployee(): Promise<{
      personId: string;
      employeeId: string;
    }> {
      const personId = generateId();
      const employeeId = generateId();
      const accountId = generateId();
      const suffix = generateId().slice(-8);
      createdPersonIds.push(personId);
      createdEmployeeIds.push(employeeId);
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
         VALUES ($1::uuid, 'CFG-Emp', $2, 'STAFF', true)`,
        personId,
        'Test-' + suffix,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.hr_employees
           (id, school_id, person_id, account_id, employee_number, hire_date,
            employment_type, employment_status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, CURRENT_DATE,
                 'FULL_TIME', 'ACTIVE')`,
        employeeId,
        TEST_SCHOOL_ID,
        personId,
        accountId,
        'CFG-EMP-' + suffix,
      );
      return { personId, employeeId };
    }

    it('positionSchool + personPosition mappings populate when a position is filled', async () => {
      const deptId = generateId();
      const positionId = generateId();
      createdDepartmentIds.push(deptId);
      createdPositionIds.push(positionId);
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_departments (id, school_id, name)
         VALUES ($1::uuid, $2::uuid, $3)`,
        deptId,
        TEST_SCHOOL_ID,
        'CFG-Dept-' + deptId.slice(-6),
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.hr_positions
           (id, school_id, title, department_id, is_teaching_role, is_active)
         VALUES ($1::uuid, $2::uuid, $3, $4::uuid, false, true)`,
        positionId,
        TEST_SCHOOL_ID,
        'CFG-Pos-' + positionId.slice(-6),
        deptId,
      );
      const { employeeId } = await seedPersonAndEmployee();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.hr_employee_positions
           (id, employee_id, position_id, effective_from)
         VALUES ($1::uuid, $2::uuid, $3::uuid, CURRENT_DATE)`,
        generateId(),
        employeeId,
        positionId,
      );
      const summary = await withTestTenant(async () => connections.getSummary());
      const ourPositionSchool = summary.positionSchool.find((p) => p.positionId === positionId);
      expect(ourPositionSchool).toBeDefined();
      expect(ourPositionSchool!.filledByName).toBeTruthy();
      expect(ourPositionSchool!.departmentName).toContain('CFG-Dept');

      const ourPersonPosition = summary.personPosition.find((p) => p.positionId === positionId);
      expect(ourPersonPosition).toBeDefined();
      expect(ourPersonPosition!.employeeId).toBe(employeeId);
      expect(ourPersonPosition!.isVacant).toBe(false);
      expect(ourPersonPosition!.startDate).toBeTruthy();
    });
  });

  // ─── AcademicTreeService unknown-year fallback ──────────────

  describe('AcademicTreeService.getTree with unknown academicYearId', () => {
    it('falls back to current year (does not throw)', async () => {
      const tree = await withTestTenant(async () => academic.getTree(generateId()));
      // The fixture seeds an academic year. Service falls back to
      // current-year branch even though the requested id is unknown.
      expect(tree.selectedYear).toBeTruthy();
    });
  });
});
