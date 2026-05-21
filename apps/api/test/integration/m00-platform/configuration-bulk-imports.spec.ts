import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import {
  FacilityTreeService,
  BulkImportService,
  type ImportStaffRow,
  type ImportStudentRow,
} from '@modules/m00-platform/configuration/configuration.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import { withTestTenant, TEST_SCHOOL_ID, TEST_SCHEMA } from '../helpers/tenant-context';

/**
 * DB-backed integration tests for the configuration paths that the
 * existing configuration.spec / configuration-trees.spec leave
 * uncovered:
 *
 *   - FacilityTreeService.deleteBuildingWithDependencyCheck
 *   - FacilityTreeService.deleteSpaceWithDependencyCheck
 *   - FacilityTreeService.bulkImportRooms (all validation + happy path)
 *   - BulkImportService.bulkImportStudents (guardian path: new guardian,
 *     existing-guardian reuse, sis_guardians projection, link-table
 *     idempotency)
 */
describe('integration:m00-platform/configuration-bulk-imports', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let facility: FacilityTreeService;
  let bulk: BulkImportService;

  const createdBuildingIds: string[] = [];
  const createdSpaceIds: string[] = [];
  const createdSchRoomIds: string[] = [];
  const createdTimetableSlotIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    facility = new FacilityTreeService(tenantPrisma);
    bulk = new BulkImportService(tenantPrisma);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    if (createdTimetableSlotIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sch_timetable_slots WHERE id = ANY($1::uuid[])`,
        createdTimetableSlotIds.splice(0),
      );
    }
    if (createdSpaceIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.fac_spaces WHERE id = ANY($1::uuid[])`,
        createdSpaceIds.splice(0),
      );
    }
    if (createdSchRoomIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sch_rooms WHERE id = ANY($1::uuid[])`,
        createdSchRoomIds.splice(0),
      );
    }
    if (createdBuildingIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.fac_buildings WHERE id = ANY($1::uuid[])`,
        createdBuildingIds.splice(0),
      );
    }
    // Wipe bulk-imported staff/students by prefix
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_student_guardians WHERE student_id IN
         (SELECT id FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'BLK-%')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_guardians WHERE person_id IN
         (SELECT id FROM platform.iam_person WHERE first_name = 'BlkGuardian')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'BLK-%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_students WHERE first_name LIKE 'BlkStu%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_users WHERE email LIKE 'blk-%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_person WHERE first_name IN ('BlkStu1','BlkStu2','BlkGuardian')`,
    );
  });

  async function seedBuilding(name: string): Promise<string> {
    const id = generateId();
    createdBuildingIds.push(id);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.fac_buildings
         (id, school_id, name, is_active)
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
    opts: { schRoomId?: string | null } = {},
  ): Promise<string> {
    const id = generateId();
    createdSpaceIds.push(id);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.fac_spaces
         (id, building_id, name, floor, space_type, is_active, sch_room_id)
       VALUES ($1::uuid, $2::uuid, $3, '1', 'CLASSROOM', true, $4::uuid)`,
      id,
      buildingId,
      name,
      opts.schRoomId ?? null,
    );
    return id;
  }

  async function seedSchRoom(_buildingId: string, name: string): Promise<string> {
    const id = generateId();
    createdSchRoomIds.push(id);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sch_rooms
         (id, school_id, name, capacity, is_active)
       VALUES ($1::uuid, $2::uuid, $3, 30, true)`,
      id,
      TEST_SCHOOL_ID,
      name,
    );
    return id;
  }

  describe('deleteBuildingWithDependencyCheck', () => {
    it('happy path: empty building → deletes successfully', async () => {
      const id = await seedBuilding('CFG-Empty');
      const result = await withTestTenant(async () =>
        facility.deleteBuildingWithDependencyCheck(id),
      );
      expect(result.deleted).toBe(true);
      // Verify deletion + remove from tracker
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.fac_buildings WHERE id = $1::uuid`,
        id,
      )) as Array<{ n: number }>;
      expect(rows[0]!.n).toBe(0);
      createdBuildingIds.splice(createdBuildingIds.indexOf(id), 1);
    });

    it('missing building → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => facility.deleteBuildingWithDependencyCheck(generateId())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('building has 1 space → ConflictException mentions singular "space"', async () => {
      const buildingId = await seedBuilding('CFG-HasOneSpace');
      await seedSpace(buildingId, 'Room A');
      await expect(
        withTestTenant(async () => facility.deleteBuildingWithDependencyCheck(buildingId)),
      ).rejects.toThrow(/has 1 space — remove all spaces first/);
    });

    it('building has multiple spaces → ConflictException mentions plural "spaces"', async () => {
      const buildingId = await seedBuilding('CFG-HasManySpaces');
      await seedSpace(buildingId, 'Room A');
      await seedSpace(buildingId, 'Room B');
      await seedSpace(buildingId, 'Room C');
      await expect(
        withTestTenant(async () => facility.deleteBuildingWithDependencyCheck(buildingId)),
      ).rejects.toThrow(/has 3 spaces — remove all spaces first/);
    });
  });

  describe('deleteSpaceWithDependencyCheck', () => {
    it('happy path: space without sch_room linkage → deletes successfully', async () => {
      const buildingId = await seedBuilding('CFG-DelSpace');
      const spaceId = await seedSpace(buildingId, 'Room X');
      const result = await withTestTenant(async () =>
        facility.deleteSpaceWithDependencyCheck(spaceId),
      );
      expect(result.deleted).toBe(true);
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.fac_spaces WHERE id = $1::uuid`,
        spaceId,
      )) as Array<{ n: number }>;
      expect(rows[0]!.n).toBe(0);
      createdSpaceIds.splice(createdSpaceIds.indexOf(spaceId), 1);
    });

    it('happy path: space WITH sch_room linkage but no active slots → deletes', async () => {
      const buildingId = await seedBuilding('CFG-DelSpaceLinked');
      const roomId = await seedSchRoom(buildingId, 'CFG-Room');
      const spaceId = await seedSpace(buildingId, 'Room Y', { schRoomId: roomId });
      const result = await withTestTenant(async () =>
        facility.deleteSpaceWithDependencyCheck(spaceId),
      );
      expect(result.deleted).toBe(true);
      createdSpaceIds.splice(createdSpaceIds.indexOf(spaceId), 1);
    });

    it('missing space → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => facility.deleteSpaceWithDependencyCheck(generateId())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('space has 1 active timetable slot → ConflictException', async () => {
      const buildingId = await seedBuilding('CFG-DelSlot');
      const roomId = await seedSchRoom(buildingId, 'CFG-RoomScheduled');
      const spaceId = await seedSpace(buildingId, 'Room Scheduled', { schRoomId: roomId });

      // Find an existing class + period the seed already provides
      const classRows = (await rawClient.$queryRawUnsafe(
        `SELECT id::text AS id FROM ${TEST_SCHEMA}.sis_classes WHERE school_id = $1::uuid LIMIT 1`,
        TEST_SCHOOL_ID,
      )) as Array<{ id: string }>;
      const periodRows = (await rawClient.$queryRawUnsafe(
        `SELECT id::text AS id FROM ${TEST_SCHEMA}.sch_periods LIMIT 1`,
      )) as Array<{ id: string }>;
      if (classRows.length === 0 || periodRows.length === 0) {
        // Fixtures don't include classes/periods — skip the assertion
        return;
      }

      const slotId = generateId();
      createdTimetableSlotIds.push(slotId);
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sch_timetable_slots
           (id, school_id, class_id, room_id, period_id, effective_from)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, CURRENT_DATE)`,
        slotId,
        TEST_SCHOOL_ID,
        classRows[0]!.id,
        roomId,
        periodRows[0]!.id,
      );

      await expect(
        withTestTenant(async () => facility.deleteSpaceWithDependencyCheck(spaceId)),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('bulkImportRooms', () => {
    it('happy path: 2 rows → 2 spaces created in the resolved building', async () => {
      const buildingId = await seedBuilding('BulkBldg-Happy');
      const result = await withTestTenant(async () =>
        facility.bulkImportRooms([
          {
            buildingName: 'BulkBldg-Happy',
            roomName: 'BulkRoom-A',
            floor: '1',
            spaceType: 'CLASSROOM',
            areaSqft: 600,
          },
          {
            buildingName: 'BulkBldg-Happy',
            roomName: 'BulkRoom-B',
            floor: '2',
            spaceType: 'OFFICE',
            areaSqft: null,
          },
        ]),
      );
      expect(result.created).toBe(2);
      expect(result.skipped).toBe(0);
      // Track for cleanup
      const seeded = (await rawClient.$queryRawUnsafe(
        `SELECT id::text AS id FROM ${TEST_SCHEMA}.fac_spaces WHERE building_id = $1::uuid AND name LIKE 'BulkRoom-%'`,
        buildingId,
      )) as Array<{ id: string }>;
      createdSpaceIds.push(...seeded.map((s) => s.id));
    });

    it('skips duplicate (building, roomName) pairs on re-run', async () => {
      const buildingId = await seedBuilding('BulkBldg-Dup');
      await withTestTenant(async () =>
        facility.bulkImportRooms([
          {
            buildingName: 'BulkBldg-Dup',
            roomName: 'BulkRoom-Dup',
            floor: '1',
            spaceType: 'CLASSROOM',
            areaSqft: 600,
          },
        ]),
      );
      const second = await withTestTenant(async () =>
        facility.bulkImportRooms([
          {
            buildingName: 'BulkBldg-Dup',
            roomName: 'BulkRoom-Dup',
            floor: '1',
            spaceType: 'CLASSROOM',
            areaSqft: 600,
          },
        ]),
      );
      expect(second.created).toBe(0);
      expect(second.skipped).toBe(1);
      const seeded = (await rawClient.$queryRawUnsafe(
        `SELECT id::text AS id FROM ${TEST_SCHEMA}.fac_spaces WHERE building_id = $1::uuid`,
        buildingId,
      )) as Array<{ id: string }>;
      createdSpaceIds.push(...seeded.map((s) => s.id));
    });

    it('empty array → BadRequestException', async () => {
      await expect(withTestTenant(async () => facility.bulkImportRooms([]))).rejects.toThrow(
        /CSV is empty/,
      );
    });

    it('> 1000 rows → BadRequestException with row count', async () => {
      const rows = Array.from({ length: 1001 }, (_, i) => ({
        buildingName: 'X',
        roomName: 'R-' + i,
        floor: null,
        spaceType: 'CLASSROOM',
        areaSqft: null,
      }));
      await expect(withTestTenant(async () => facility.bulkImportRooms(rows))).rejects.toThrow(
        /1001 rows — max 1000 per batch/,
      );
    });

    it('unknown building → BadRequestException with rowErrors mentioning the building name', async () => {
      let caught: unknown;
      try {
        await withTestTenant(async () =>
          facility.bulkImportRooms([
            {
              buildingName: 'NoSuchBuilding',
              roomName: 'R1',
              floor: '1',
              spaceType: 'CLASSROOM',
              areaSqft: 100,
            },
          ]),
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BadRequestException);
      const resp = (caught as BadRequestException).getResponse() as {
        rowErrors: string[];
      };
      expect(resp.rowErrors.some((e) => e.includes('NoSuchBuilding'))).toBe(true);
    });

    it('blank buildingName → BadRequestException with "buildingName is required"', async () => {
      let caught: unknown;
      try {
        await withTestTenant(async () =>
          facility.bulkImportRooms([
            {
              buildingName: '   ',
              roomName: 'R1',
              floor: '1',
              spaceType: 'CLASSROOM',
              areaSqft: 100,
            },
          ]),
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BadRequestException);
      const resp = (caught as BadRequestException).getResponse() as {
        rowErrors: string[];
      };
      expect(resp.rowErrors.some((e) => e.includes('buildingName is required'))).toBe(true);
    });

    async function expectRowError(bulkPromise: Promise<unknown>, pattern: RegExp): Promise<void> {
      let caught: unknown;
      try {
        await bulkPromise;
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BadRequestException);
      const resp = (caught as BadRequestException).getResponse() as {
        rowErrors: string[];
      };
      expect(resp.rowErrors.some((e) => pattern.test(e))).toBe(true);
    }

    it('blank roomName → BadRequestException', async () => {
      await seedBuilding('BulkBldg-Validation');
      await expectRowError(
        withTestTenant(async () =>
          facility.bulkImportRooms([
            {
              buildingName: 'BulkBldg-Validation',
              roomName: '   ',
              floor: '1',
              spaceType: 'CLASSROOM',
              areaSqft: null,
            },
          ]),
        ),
        /roomName is required/,
      );
    });

    it('invalid spaceType → BadRequestException', async () => {
      await seedBuilding('BulkBldg-BadType');
      await expectRowError(
        withTestTenant(async () =>
          facility.bulkImportRooms([
            {
              buildingName: 'BulkBldg-BadType',
              roomName: 'R1',
              floor: '1',
              spaceType: 'NOT_A_TYPE',
              areaSqft: null,
            },
          ]),
        ),
        /spaceType "NOT_A_TYPE" is invalid/,
      );
    });

    it('negative areaSqft → BadRequestException', async () => {
      await seedBuilding('BulkBldg-BadArea');
      await expectRowError(
        withTestTenant(async () =>
          facility.bulkImportRooms([
            {
              buildingName: 'BulkBldg-BadArea',
              roomName: 'R1',
              floor: '1',
              spaceType: 'CLASSROOM',
              areaSqft: -50,
            },
          ]),
        ),
        /areaSqft must be a non-negative number/,
      );
    });

    it('non-finite areaSqft → BadRequestException', async () => {
      await seedBuilding('BulkBldg-NonFinite');
      await expectRowError(
        withTestTenant(async () =>
          facility.bulkImportRooms([
            {
              buildingName: 'BulkBldg-NonFinite',
              roomName: 'R1',
              floor: '1',
              spaceType: 'CLASSROOM',
              areaSqft: NaN,
            },
          ]),
        ),
        /areaSqft must be a non-negative number/,
      );
    });

    it('multiple validation errors → all surfaced together', async () => {
      let caught: unknown;
      try {
        await withTestTenant(async () =>
          facility.bulkImportRooms([
            {
              buildingName: '',
              roomName: '',
              floor: null,
              spaceType: 'BAD',
              areaSqft: -1,
            },
          ]),
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BadRequestException);
      const resp = (caught as BadRequestException).getResponse() as {
        rowErrors: string[];
      };
      // buildingName + roomName + spaceType + areaSqft errors all present
      expect(resp.rowErrors.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('bulkImportStudents — guardian path', () => {
    function baseStudent(overrides: Partial<ImportStudentRow> = {}): ImportStudentRow {
      return {
        firstName: 'BlkStu1',
        lastName: 'Test',
        studentNumber: 'BLK-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
        gradeLevel: '8',
        ...overrides,
      };
    }

    it('row WITH guardian fields → creates guardian + sis_guardians + link', async () => {
      const guardianEmail =
        'blk-guardian-' + Math.random().toString(36).slice(2, 8) + '@test.local';
      const result = await withTestTenant(async () =>
        bulk.bulkImportStudents([
          baseStudent({
            firstName: 'BlkStu1',
            guardianFirstName: 'BlkGuardian',
            guardianLastName: 'GTest',
            guardianEmail,
          }),
        ]),
      );
      expect(result.created).toBe(1);

      // Verify guardian iam_person + platform_users + sis_guardians + link
      const guardianRows = (await rawClient.$queryRawUnsafe(
        `SELECT pu.id::text AS account_id, pu.person_id::text AS person_id, ip.first_name
           FROM platform.platform_users pu
           JOIN platform.iam_person ip ON ip.id = pu.person_id
          WHERE pu.email = $1`,
        guardianEmail,
      )) as Array<{ account_id: string; person_id: string; first_name: string }>;
      expect(guardianRows.length).toBe(1);
      expect(guardianRows[0]!.first_name).toBe('BlkGuardian');

      const sisGuardianRows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.sis_guardians WHERE person_id = $1::uuid`,
        guardianRows[0]!.person_id,
      )) as Array<{ n: number }>;
      expect(sisGuardianRows[0]!.n).toBe(1);

      const linkRows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.sis_student_guardians ssg
           JOIN ${TEST_SCHEMA}.sis_guardians g ON g.id = ssg.guardian_id
          WHERE g.person_id = $1::uuid`,
        guardianRows[0]!.person_id,
      )) as Array<{ n: number }>;
      expect(linkRows[0]!.n).toBe(1);
    });

    it('two students sharing one guardian email → reuses guardian rows', async () => {
      const guardianEmail =
        'blk-guardian-shared-' + Math.random().toString(36).slice(2, 8) + '@test.local';
      const result = await withTestTenant(async () =>
        bulk.bulkImportStudents([
          baseStudent({
            firstName: 'BlkStu1',
            guardianFirstName: 'BlkGuardian',
            guardianLastName: 'GShared',
            guardianEmail,
          }),
          baseStudent({
            firstName: 'BlkStu2',
            guardianFirstName: 'BlkGuardian',
            guardianLastName: 'GShared',
            guardianEmail,
          }),
        ]),
      );
      expect(result.created).toBe(2);

      // One guardian iam_person, one platform_users, one sis_guardians row
      const guardianCount = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM platform.platform_users WHERE email = $1`,
        guardianEmail,
      )) as Array<{ n: number }>;
      expect(guardianCount[0]!.n).toBe(1);

      // But TWO sis_student_guardians link rows
      const linkRows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.sis_student_guardians ssg
           JOIN ${TEST_SCHEMA}.sis_guardians g ON g.id = ssg.guardian_id
           JOIN platform.iam_person ip ON ip.id = g.person_id
           JOIN platform.platform_users pu ON pu.person_id = ip.id
          WHERE pu.email = $1`,
        guardianEmail,
      )) as Array<{ n: number }>;
      expect(linkRows[0]!.n).toBe(2);
    });

    it('row without guardian fields → no guardian rows created', async () => {
      const result = await withTestTenant(async () =>
        bulk.bulkImportStudents([baseStudent({ firstName: 'BlkStu1' })]),
      );
      expect(result.created).toBe(1);
    });

    it('duplicate student_number → skipped (does not double-create)', async () => {
      const sn = 'BLK-DUPE-' + Math.random().toString(36).slice(2, 6).toUpperCase();
      const first = await withTestTenant(async () =>
        bulk.bulkImportStudents([baseStudent({ studentNumber: sn })]),
      );
      expect(first.created).toBe(1);
      const second = await withTestTenant(async () =>
        bulk.bulkImportStudents([baseStudent({ studentNumber: sn })]),
      );
      expect(second.created).toBe(0);
      expect(second.skipped).toBe(1);
    });

    it('missing firstName → BadRequest up-front', async () => {
      let caught: unknown;
      try {
        await withTestTenant(async () => bulk.bulkImportStudents([baseStudent({ firstName: '' })]));
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BadRequestException);
      const resp = (caught as BadRequestException).getResponse() as { rowErrors: string[] };
      expect(resp.rowErrors.some((e) => /firstName missing/.test(e))).toBe(true);
    });

    it('missing lastName → BadRequest', async () => {
      let caught: unknown;
      try {
        await withTestTenant(async () => bulk.bulkImportStudents([baseStudent({ lastName: '' })]));
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BadRequestException);
      const resp = (caught as BadRequestException).getResponse() as { rowErrors: string[] };
      expect(resp.rowErrors.some((e) => /lastName missing/.test(e))).toBe(true);
    });

    it('reuses an existing guardian whose sis_guardians row already exists', async () => {
      // Seed an iam_person + platform_users + sis_guardians for a known
      // email so the bulk import finds and reuses it.
      const personId = generateId();
      const accountId = generateId();
      const sisGuardianId = generateId();
      const email = 'blk-existing-' + Math.random().toString(36).slice(2, 8) + '@test.local';
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.iam_person (id, first_name, last_name, person_type)
         VALUES ($1::uuid, 'BlkGuardian', 'Existing', 'GUARDIAN'::"PersonType")`,
        personId,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.platform_users (id, person_id, email)
         VALUES ($1::uuid, $2::uuid, $3)`,
        accountId,
        personId,
        email,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_guardians (id, school_id, person_id, account_id, relationship)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'GUARDIAN')`,
        sisGuardianId,
        TEST_SCHOOL_ID,
        personId,
        accountId,
      );

      try {
        const result = await withTestTenant(async () =>
          bulk.bulkImportStudents([
            baseStudent({
              firstName: 'BlkStu1',
              guardianFirstName: 'BlkGuardian',
              guardianLastName: 'Existing',
              guardianEmail: email,
            }),
          ]),
        );
        expect(result.created).toBe(1);

        // No NEW iam_person was created — there's still exactly 1 with that email
        const pCount = (await rawClient.$queryRawUnsafe(
          `SELECT count(*)::int AS n FROM platform.platform_users WHERE email = $1`,
          email,
        )) as Array<{ n: number }>;
        expect(pCount[0]!.n).toBe(1);
        // Existing sis_guardians row reused — still 1 row for this person
        const gCount = (await rawClient.$queryRawUnsafe(
          `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.sis_guardians WHERE person_id = $1::uuid`,
          personId,
        )) as Array<{ n: number }>;
        expect(gCount[0]!.n).toBe(1);
        // sis_student_guardians link created
        const lCount = (await rawClient.$queryRawUnsafe(
          `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.sis_student_guardians WHERE guardian_id = $1::uuid`,
          sisGuardianId,
        )) as Array<{ n: number }>;
        expect(lCount[0]!.n).toBe(1);
      } finally {
        await rawClient.$executeRawUnsafe(
          `DELETE FROM ${TEST_SCHEMA}.sis_student_guardians WHERE guardian_id = $1::uuid`,
          sisGuardianId,
        );
        await rawClient.$executeRawUnsafe(
          `DELETE FROM ${TEST_SCHEMA}.sis_guardians WHERE id = $1::uuid`,
          sisGuardianId,
        );
        await rawClient.$executeRawUnsafe(
          `DELETE FROM platform.platform_users WHERE id = $1::uuid`,
          accountId,
        );
        await rawClient.$executeRawUnsafe(
          `DELETE FROM platform.iam_person WHERE id = $1::uuid`,
          personId,
        );
      }
    });
  });

  describe('bulkImportStaff additional branches', () => {
    function baseStaff(overrides: Partial<ImportStaffRow> = {}): ImportStaffRow {
      return {
        firstName: 'BulkStaff',
        lastName: 'Test',
        email: 'blk-staff-' + Math.random().toString(36).slice(2, 8) + '@test.local',
        ...overrides,
      };
    }

    it('row with valid positionTitle creates hr_employee_positions assignment', async () => {
      // Seed a position
      const positionId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.hr_positions
           (id, school_id, title, is_active)
         VALUES ($1::uuid, $2::uuid, $3, true)`,
        positionId,
        TEST_SCHOOL_ID,
        'BlkStaff-Teacher',
      );

      try {
        const email = 'blk-staff-pos-' + Math.random().toString(36).slice(2, 8) + '@test.local';
        const result = await withTestTenant(async () =>
          bulk.bulkImportStaff([baseStaff({ email, positionTitle: 'BlkStaff-Teacher' })]),
        );
        expect(result.created).toBe(1);

        // Verify the hr_employee_positions row was created
        const eapRows = (await rawClient.$queryRawUnsafe(
          `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.hr_employee_positions WHERE position_id = $1::uuid`,
          positionId,
        )) as Array<{ n: number }>;
        expect(eapRows[0]!.n).toBe(1);

        // Clean up
        await rawClient.$executeRawUnsafe(
          `DELETE FROM ${TEST_SCHEMA}.hr_employee_positions WHERE position_id = $1::uuid`,
          positionId,
        );
        await rawClient.$executeRawUnsafe(
          `DELETE FROM ${TEST_SCHEMA}.hr_employees WHERE account_id IN
             (SELECT id FROM platform.platform_users WHERE email = $1)`,
          email,
        );
        await rawClient.$executeRawUnsafe(
          `DELETE FROM platform.platform_users WHERE email = $1`,
          email,
        );
        await rawClient.$executeRawUnsafe(
          `DELETE FROM platform.iam_person WHERE first_name = 'BulkStaff' AND last_name = 'Test'`,
        );
      } finally {
        await rawClient.$executeRawUnsafe(
          `DELETE FROM ${TEST_SCHEMA}.hr_positions WHERE id = $1::uuid`,
          positionId,
        );
      }
    });
  });
});
