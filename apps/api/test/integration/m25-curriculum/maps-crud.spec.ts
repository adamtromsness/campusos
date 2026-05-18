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
import {
  FrameworkService,
  StandardService,
} from '@modules/m25-curriculum/frameworks.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import { adminActor, teacherActor } from '../helpers/actor';
import { TEST_SIS_ACADEMIC_YEAR_ID, TEST_SIS_ACADEMIC_YEAR_B_ID } from '../fixtures/sis';

/**
 * Wave 4 — m25-curriculum CurriculumMapService + UnitService
 * DB-backed integration tests for map CRUD + unit scaffolding.
 *
 * Contracts verified:
 *   - create / patch / list / getById admin-only (writer gate).
 *   - DRAFT → PUBLISHED / ARCHIVED transitions stamp the lockstep
 *     columns (status_lockstep_chk) atomically.
 *   - frameworkId validation: must be either a current-tenant custom
 *     framework OR a platform framework adopted by this school for
 *     the supplied academic year.
 *   - academicYearId validation: rejects an unknown year and a
 *     foreign-school year.
 *   - Cross-school isolation: a School-A admin reading from School B
 *     context (via withTestTenantB) does not see School A maps.
 *
 *   CODEX FINDING (P2-H5 DEFECT 1b): UnitService.create with a
 *   curriculum_map_id owned by another school → BadRequestException.
 *   The fix runs the school-ownership check inside the same tx as
 *   the unit INSERT, so a crafted cross-school mapId cannot land a
 *   foreign unit row.
 *
 *   CODEX FINDING: UnitService.reorder binds the parent map's
 *   school_id on every UPDATE so a cross-school mapId cannot
 *   re-order foreign units.
 */
describe('integration:m25-curriculum/maps-crud', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let mapService: CurriculumMapService;
  let unitService: UnitService;
  let frameworkService: FrameworkService;
  let standardService: StandardService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    standardService = new StandardService(tenantPrisma, permCheck);
    frameworkService = new FrameworkService(tenantPrisma, permCheck);
    mapService = new CurriculumMapService(tenantPrisma, permCheck);
    unitService = new UnitService(tenantPrisma, permCheck, standardService);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    // Wipe curriculum data in dependency order. cur_curriculum_maps
    // CASCADEs to cur_units, cur_unit_standards, cur_unit_lessons,
    // cur_delivery_gaps, cur_resource_links.
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cur_delivery_gaps`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cur_unit_lessons`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cur_unit_standards`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cur_resource_links`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cur_units`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cur_curriculum_maps`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cur_school_framework_adoptions`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cur_standards`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cur_standards_frameworks`);
  });

  // ──────────────────────────────────────────────────────────────
  // CurriculumMapService.create
  // ──────────────────────────────────────────────────────────────
  describe('CurriculumMapService.create', () => {
    it('admin creates a DRAFT map → row inserted, status=DRAFT', async () => {
      const dto = await withTestTenant(async () =>
        mapService.create(
          {
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            subject: 'Math',
            gradeLevel: '5',
            title: 'Grade 5 Math',
            description: 'desc',
          },
          adminActor(),
        ),
      );
      expect(dto.schoolId).toBe(TEST_SCHOOL_ID);
      expect(dto.subject).toBe('Math');
      expect(dto.gradeLevel).toBe('5');
      expect(dto.status).toBe('DRAFT');
      expect(dto.publishedAt).toBeNull();
      expect(dto.archivedAt).toBeNull();

      const row = await rawClient.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT status FROM ${TEST_SCHEMA}.cur_curriculum_maps WHERE id = $1::uuid`,
        dto.id,
      );
      expect(row[0]!.status).toBe('DRAFT');
    });

    it('non-staff (parent) cannot create → ForbiddenException', async () => {
      // teacherActor has no `tch-008:write` granted in this test → 403
      await expect(
        withTestTenant(async () =>
          mapService.create(
            {
              academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
              subject: 'Math',
              gradeLevel: '5',
              title: 'denied',
            },
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('unknown academicYearId → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          mapService.create(
            {
              academicYearId: '00000000-0000-0000-0000-000000000000',
              subject: 'Math',
              gradeLevel: '5',
              title: 'x',
            },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('foreign-school academicYearId (School B year) → BadRequestException', async () => {
      // School A admin, but passes School B's year id — the create
      // path validates the year belongs to the current school.
      await expect(
        withTestTenant(async () =>
          mapService.create(
            {
              academicYearId: TEST_SIS_ACADEMIC_YEAR_B_ID,
              subject: 'Math',
              gradeLevel: '5',
              title: 'x',
            },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('frameworkId for a non-adopted platform framework → BadRequestException', async () => {
      const phantomFrameworkId = generateId();
      await expect(
        withTestTenant(async () =>
          mapService.create(
            {
              academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
              frameworkId: phantomFrameworkId,
              subject: 'Math',
              gradeLevel: '5',
              title: 'x',
            },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('frameworkId for a current-school custom framework → succeeds', async () => {
      const fwId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.cur_standards_frameworks
           (id, school_id, name, version, is_active, created_by)
         VALUES ($1::uuid, $2::uuid, 'Local Math', '1', true, $3::uuid)`,
        fwId,
        TEST_SCHOOL_ID,
        adminActor().accountId,
      );
      const dto = await withTestTenant(async () =>
        mapService.create(
          {
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            frameworkId: fwId,
            subject: 'Math',
            gradeLevel: '5',
            title: 'using custom fw',
          },
          adminActor(),
        ),
      );
      expect(dto.frameworkId).toBe(fwId);
      expect(dto.frameworkSource).toBe('SCHOOL');
    });

    it('frameworkId for a School-B custom framework → BadRequestException', async () => {
      // Cross-school: framework belongs to School B (different school_id)
      // — visible by school_id, the assertion must reject.
      const fwId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.cur_standards_frameworks
           (id, school_id, name, version, is_active, created_by)
         VALUES ($1::uuid, $2::uuid, 'B Math', '1', true, $3::uuid)`,
        fwId,
        TEST_SCHOOL_B_ID,
        adminActor().accountId,
      );
      await expect(
        withTestTenant(async () =>
          mapService.create(
            {
              academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
              frameworkId: fwId,
              subject: 'Math',
              gradeLevel: '5',
              title: 'x',
            },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // CurriculumMapService.list + getById
  // ──────────────────────────────────────────────────────────────
  describe('CurriculumMapService.list + getById', () => {
    it('list returns the created map; getById returns the same row', async () => {
      const dto = await withTestTenant(async () =>
        mapService.create(
          {
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            subject: 'Sci',
            gradeLevel: '6',
            title: 'Sci 6',
          },
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () => mapService.list(adminActor()));
      expect(list.map((m) => m.id)).toContain(dto.id);
      const got = await withTestTenant(async () => mapService.getById(dto.id, adminActor()));
      expect(got.id).toBe(dto.id);
    });

    it('cross-school: a School-A map is invisible from School B context', async () => {
      const dto = await withTestTenant(async () =>
        mapService.create(
          {
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            subject: 'Sci',
            gradeLevel: '6',
            title: 'School A only',
          },
          adminActor(),
        ),
      );
      const listFromB = await withTestTenantB(async () => mapService.list(adminActor()));
      expect(listFromB.map((m) => m.id)).not.toContain(dto.id);
      await expect(
        withTestTenantB(async () => mapService.getById(dto.id, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById on an unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          mapService.getById('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // CurriculumMapService.patch — status transitions + school-scope
  // ──────────────────────────────────────────────────────────────
  describe('CurriculumMapService.patch', () => {
    async function seedMap(): Promise<string> {
      const dto = await withTestTenant(async () =>
        mapService.create(
          {
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            subject: 'Math',
            gradeLevel: '5',
            title: 'PatchMe',
          },
          adminActor(),
        ),
      );
      return dto.id;
    }

    it('DRAFT → PUBLISHED stamps published_at; archived_at stays null', async () => {
      const id = await seedMap();
      const dto = await withTestTenant(async () =>
        mapService.patch(id, { status: 'PUBLISHED' }, adminActor()),
      );
      expect(dto.status).toBe('PUBLISHED');
      expect(dto.publishedAt).not.toBeNull();
      expect(dto.archivedAt).toBeNull();
    });

    it('PUBLISHED → ARCHIVED stamps archived_at', async () => {
      const id = await seedMap();
      await withTestTenant(async () =>
        mapService.patch(id, { status: 'PUBLISHED' }, adminActor()),
      );
      const dto = await withTestTenant(async () =>
        mapService.patch(id, { status: 'ARCHIVED' }, adminActor()),
      );
      expect(dto.status).toBe('ARCHIVED');
      expect(dto.archivedAt).not.toBeNull();
    });

    it('cross-school: patching from School B context → NotFoundException', async () => {
      const id = await seedMap();
      await expect(
        withTestTenantB(async () =>
          mapService.patch(id, { title: 'hijack' }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('patch other fields (title, description) is allowed', async () => {
      const id = await seedMap();
      const dto = await withTestTenant(async () =>
        mapService.patch(id, { title: 'Renamed', description: 'D' }, adminActor()),
      );
      expect(dto.title).toBe('Renamed');
      expect(dto.description).toBe('D');
    });
  });

  // ──────────────────────────────────────────────────────────────
  // UnitService.create — CODEX FINDING cross-school map id
  // ──────────────────────────────────────────────────────────────
  describe('UnitService.create', () => {
    async function seedMap(schoolId: string, yearId: string): Promise<string> {
      const id = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.cur_curriculum_maps
           (id, school_id, academic_year_id, subject, grade_level, title, created_by, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Math', '5', 'M', $4::uuid, 'DRAFT')`,
        id,
        schoolId,
        yearId,
        adminActor().accountId,
      );
      return id;
    }

    it('admin creates a unit under their own school map → sequenceOrder=1', async () => {
      const mapId = await seedMap(TEST_SCHOOL_ID, TEST_SIS_ACADEMIC_YEAR_ID);
      const unit = await withTestTenant(async () =>
        unitService.create(mapId, { title: 'U1' }, adminActor()),
      );
      expect(unit.sequenceOrder).toBe(1);
      expect(unit.curriculumMapId).toBe(mapId);
    });

    it('second unit auto-increments sequence_order to 2', async () => {
      const mapId = await seedMap(TEST_SCHOOL_ID, TEST_SIS_ACADEMIC_YEAR_ID);
      const a = await withTestTenant(async () =>
        unitService.create(mapId, { title: 'U1' }, adminActor()),
      );
      const b = await withTestTenant(async () =>
        unitService.create(mapId, { title: 'U2' }, adminActor()),
      );
      expect(a.sequenceOrder).toBe(1);
      expect(b.sequenceOrder).toBe(2);
    });

    it('CODEX FINDING: cross-school map id → BadRequestException', async () => {
      const foreignMapId = await seedMap(TEST_SCHOOL_B_ID, TEST_SIS_ACADEMIC_YEAR_B_ID);
      // Caller is in School A tenant context with admin; the parent
      // map belongs to School B → BadRequest, no unit inserted.
      await expect(
        withTestTenant(async () =>
          unitService.create(foreignMapId, { title: 'hijack' }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      const rows = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.cur_units WHERE curriculum_map_id = $1::uuid`,
        foreignMapId,
      );
      expect(rows[0]!.count).toBe(0);
    });

    it('non-writer (teacher with no tch-008:write) → ForbiddenException', async () => {
      const mapId = await seedMap(TEST_SCHOOL_ID, TEST_SIS_ACADEMIC_YEAR_ID);
      await expect(
        withTestTenant(async () =>
          unitService.create(mapId, { title: 'denied' }, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // UnitService.reorder — CODEX FINDING parent map school_id check
  // ──────────────────────────────────────────────────────────────
  describe('UnitService.reorder', () => {
    async function seedMapWithUnits(
      schoolId: string,
      yearId: string,
    ): Promise<{ mapId: string; u1: string; u2: string }> {
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
      const u1 = generateId();
      const u2 = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.cur_units (id, curriculum_map_id, title, sequence_order)
         VALUES ($1::uuid, $2::uuid, 'U1', 1)`,
        u1,
        mapId,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.cur_units (id, curriculum_map_id, title, sequence_order)
         VALUES ($1::uuid, $2::uuid, 'U2', 2)`,
        u2,
        mapId,
      );
      return { mapId, u1, u2 };
    }

    it('swaps sequence_order via two-phase renumber', async () => {
      const { mapId, u1, u2 } = await seedMapWithUnits(
        TEST_SCHOOL_ID,
        TEST_SIS_ACADEMIC_YEAR_ID,
      );
      const list = await withTestTenant(async () =>
        unitService.reorder(
          mapId,
          {
            order: [
              { unitId: u1, sequenceOrder: 2 },
              { unitId: u2, sequenceOrder: 1 },
            ],
          },
          adminActor(),
        ),
      );
      const byId = new Map(list.map((u) => [u.id, u.sequenceOrder]));
      expect(byId.get(u1)).toBe(2);
      expect(byId.get(u2)).toBe(1);
    });

    it('CODEX FINDING: reorder with foreign-school mapId → BadRequest, no foreign rows mutated', async () => {
      // Seed a B-school map + units. School A admin should not be able
      // to renumber them.
      const { mapId, u1, u2 } = await seedMapWithUnits(
        TEST_SCHOOL_B_ID,
        TEST_SIS_ACADEMIC_YEAR_B_ID,
      );
      await expect(
        withTestTenant(async () =>
          unitService.reorder(
            mapId,
            {
              order: [
                { unitId: u1, sequenceOrder: 9 },
                { unitId: u2, sequenceOrder: 8 },
              ],
            },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      const rows = await rawClient.$queryRawUnsafe<Array<{ id: string; seq: number }>>(
        `SELECT id::text AS id, sequence_order AS seq FROM ${TEST_SCHEMA}.cur_units WHERE curriculum_map_id = $1::uuid ORDER BY sequence_order`,
        mapId,
      );
      expect(rows.map((r) => r.seq)).toEqual([1, 2]);
    });
  });

  // Suppress unused-import lint for FrameworkService — kept for parity
  // with other curriculum specs that wire the same dependency graph.
  void frameworkService;
  void ConflictException;
});
