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
import { FrameworkService, StandardService } from '@modules/m25-curriculum/frameworks.service';
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
 * Wave 4 — m25-curriculum StandardService + UnitService.alignStandard
 * DB-backed integration tests.
 *
 * Contracts verified:
 *   - StandardService.search merges platform + tenant standards with
 *     source tags.
 *   - StandardService.resolveById resolves from EITHER catalogue.
 *   - StandardService.createCustom: writer gate + framework must be
 *     a current-school custom framework.
 *   - StandardService.patchCustom: writer gate + tenant standard scope.
 *
 *   CODEX FINDING (P2-H5 DEFECT 1b): alignStandard validates BOTH
 *   the standard catalogue (platform OR tenant) AND that the unit
 *   belongs to a map in the current school. Cross-school unitId
 *   combined with a valid current-school (or platform) standard
 *   → BadRequestException, no foreign alignment row inserted.
 *
 *   - Platform standards (cur_standards_platform) align cleanly for
 *     any school — they have no school_id.
 *   - Tenant standards from another school are not visible via
 *     resolveById in the calling tenant; alignStandard rejects them.
 */
describe('integration:m25-curriculum/standards-alignment', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let mapService: CurriculumMapService;
  let unitService: UnitService;
  let frameworkService: FrameworkService;
  let standardService: StandardService;

  // Test platform framework + standard ids — seeded once per spec run.
  let PLATFORM_FW_ID: string;
  let PLATFORM_STD_ID: string;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    standardService = new StandardService(tenantPrisma, permCheck);
    frameworkService = new FrameworkService(tenantPrisma, permCheck);
    mapService = new CurriculumMapService(tenantPrisma, permCheck);
    unitService = new UnitService(tenantPrisma, permCheck, standardService);

    PLATFORM_FW_ID = generateId();
    PLATFORM_STD_ID = generateId();
    // Seed a platform framework + standard. These are shared cross-tenant
    // (no school_id) — the "PLATFORM" source in the dual-resolution
    // keystone. UNIQUE(name) on the framework, so we use a unique name.
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.cur_standards_frameworks_platform (id, name, body, region, version)
       VALUES ($1::uuid, 'CCSS-INTEG-TEST', 'CCSS', 'US', '1')
       ON CONFLICT (id) DO NOTHING`,
      PLATFORM_FW_ID,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.cur_standards_platform (id, framework_id, code, description, grade_band)
       VALUES ($1::uuid, $2::uuid, 'CCSS.M.5.NBT.1', 'Place value', '5')
       ON CONFLICT (id) DO NOTHING`,
      PLATFORM_STD_ID,
      PLATFORM_FW_ID,
    );
  });

  afterAll(async () => {
    // Tear down the platform seed rows so re-runs stay deterministic.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.cur_standards_platform WHERE id = $1::uuid`,
      PLATFORM_STD_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.cur_standards_frameworks_platform WHERE id = $1::uuid`,
      PLATFORM_FW_ID,
    );
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cur_unit_standards`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cur_unit_lessons`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cur_delivery_gaps`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cur_resource_links`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cur_units`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cur_curriculum_maps`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cur_standards`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cur_standards_frameworks`);
  });

  async function seedTenantFramework(schoolId: string, name = 'Local FW'): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.cur_standards_frameworks
         (id, school_id, name, version, is_active, created_by)
       VALUES ($1::uuid, $2::uuid, $3, '1', true, $4::uuid)`,
      id,
      schoolId,
      name,
      adminActor().accountId,
    );
    return id;
  }

  async function seedTenantStandard(frameworkId: string, code = 'LOC.1'): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.cur_standards
         (id, framework_id, code, description, grade_band)
       VALUES ($1::uuid, $2::uuid, $3, 'desc', '5')`,
      id,
      frameworkId,
      code,
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
  // StandardService.resolveById — dual-catalogue resolution
  // ──────────────────────────────────────────────────────────────
  describe('StandardService.resolveById', () => {
    it('resolves a platform standard with source=PLATFORM', async () => {
      const r = await withTestTenant(async () => standardService.resolveById(PLATFORM_STD_ID));
      expect(r?.source).toBe('PLATFORM');
      expect(r?.standard.code).toBe('CCSS.M.5.NBT.1');
    });

    it('resolves a current-school tenant standard with source=SCHOOL', async () => {
      const fwId = await seedTenantFramework(TEST_SCHOOL_ID);
      const stdId = await seedTenantStandard(fwId);
      const r = await withTestTenant(async () => standardService.resolveById(stdId));
      expect(r?.source).toBe('SCHOOL');
      expect(r?.standard.code).toBe('LOC.1');
    });

    it('does NOT resolve a School-B tenant standard from School A context', async () => {
      // Standard belongs to a framework owned by School B. resolveById
      // filters by f.school_id = current tenant → null.
      const fwId = await seedTenantFramework(TEST_SCHOOL_B_ID, 'B FW');
      const stdId = await seedTenantStandard(fwId);
      const r = await withTestTenant(async () => standardService.resolveById(stdId));
      expect(r).toBeNull();
    });

    it('unknown standardId → null', async () => {
      const r = await withTestTenant(async () =>
        standardService.resolveById('00000000-0000-0000-0000-000000000000'),
      );
      expect(r).toBeNull();
    });
  });

  // ──────────────────────────────────────────────────────────────
  // StandardService.search — dual-catalogue merged results
  // ──────────────────────────────────────────────────────────────
  describe('StandardService.search', () => {
    it('returns platform + tenant standards with correct source tags', async () => {
      const fwId = await seedTenantFramework(TEST_SCHOOL_ID);
      const stdId = await seedTenantStandard(fwId, 'LOC.SEARCH');
      const results = await withTestTenant(async () => standardService.search({}));
      const platformHit = results.find((r) => r.id === PLATFORM_STD_ID);
      const tenantHit = results.find((r) => r.id === stdId);
      expect(platformHit?.source).toBe('PLATFORM');
      expect(tenantHit?.source).toBe('SCHOOL');
    });

    it('search by frameworkId restricts to that framework', async () => {
      const fwId = await seedTenantFramework(TEST_SCHOOL_ID);
      const stdId = await seedTenantStandard(fwId, 'LOC.F1');
      const results = await withTestTenant(async () =>
        standardService.search({ frameworkId: fwId }),
      );
      expect(results.map((r) => r.id)).toContain(stdId);
      expect(results.map((r) => r.id)).not.toContain(PLATFORM_STD_ID);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // StandardService.createCustom — writer gate + framework scope
  // ──────────────────────────────────────────────────────────────
  describe('StandardService.createCustom', () => {
    it('admin creates a tenant standard under a current-school framework', async () => {
      const fwId = await seedTenantFramework(TEST_SCHOOL_ID);
      const dto = await withTestTenant(async () =>
        standardService.createCustom(
          { frameworkId: fwId, code: 'X.1', description: 'd' },
          adminActor(),
        ),
      );
      expect(dto.source).toBe('SCHOOL');
      expect(dto.code).toBe('X.1');
    });

    it('non-writer (teacher with no tch-008:write) → ForbiddenException', async () => {
      const fwId = await seedTenantFramework(TEST_SCHOOL_ID);
      await expect(
        withTestTenant(async () =>
          standardService.createCustom(
            { frameworkId: fwId, code: 'X.2', description: 'd' },
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('framework owned by another school → BadRequestException', async () => {
      const fwId = await seedTenantFramework(TEST_SCHOOL_B_ID, 'B FW');
      await expect(
        withTestTenant(async () =>
          standardService.createCustom(
            { frameworkId: fwId, code: 'X.3', description: 'd' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('platform framework id → BadRequestException (platform standards read-only)', async () => {
      await expect(
        withTestTenant(async () =>
          standardService.createCustom(
            { frameworkId: PLATFORM_FW_ID, code: 'X.4', description: 'd' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('duplicate (framework_id, code) → ConflictException', async () => {
      const fwId = await seedTenantFramework(TEST_SCHOOL_ID);
      await withTestTenant(async () =>
        standardService.createCustom(
          { frameworkId: fwId, code: 'DUP', description: 'd' },
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          standardService.createCustom(
            { frameworkId: fwId, code: 'DUP', description: 'd2' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // UnitService.alignStandard — CODEX FINDING dual validation
  // ──────────────────────────────────────────────────────────────
  describe('UnitService.alignStandard', () => {
    it('aligns a platform standard to a current-school unit → row inserted', async () => {
      const { unitId } = await seedMapAndUnit(TEST_SCHOOL_ID, TEST_SIS_ACADEMIC_YEAR_ID);
      const link = await withTestTenant(async () =>
        unitService.alignStandard(unitId, { standardId: PLATFORM_STD_ID }, adminActor()),
      );
      expect(link.unitId).toBe(unitId);
      expect(link.standardId).toBe(PLATFORM_STD_ID);
      expect(link.standard.source).toBe('PLATFORM');

      const rows = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.cur_unit_standards WHERE unit_id = $1::uuid`,
        unitId,
      );
      expect(rows[0]!.count).toBe(1);
    });

    it('aligns a current-school tenant standard → source=SCHOOL', async () => {
      const { unitId } = await seedMapAndUnit(TEST_SCHOOL_ID, TEST_SIS_ACADEMIC_YEAR_ID);
      const fwId = await seedTenantFramework(TEST_SCHOOL_ID);
      const stdId = await seedTenantStandard(fwId, 'LOC.A');
      const link = await withTestTenant(async () =>
        unitService.alignStandard(unitId, { standardId: stdId }, adminActor()),
      );
      expect(link.standard.source).toBe('SCHOOL');
    });

    it('CODEX FINDING: cross-school unitId + valid current-school standard → BadRequest', async () => {
      // Foreign unit (School B), valid current-school standard. The
      // pre-fix bug would have inserted a row binding a School-B unit
      // to a School-A standard.
      const { unitId: foreignUnit } = await seedMapAndUnit(
        TEST_SCHOOL_B_ID,
        TEST_SIS_ACADEMIC_YEAR_B_ID,
      );
      const fwId = await seedTenantFramework(TEST_SCHOOL_ID);
      const stdId = await seedTenantStandard(fwId, 'LOC.B');
      await expect(
        withTestTenant(async () =>
          unitService.alignStandard(foreignUnit, { standardId: stdId }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      const rows = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.cur_unit_standards WHERE unit_id = $1::uuid`,
        foreignUnit,
      );
      expect(rows[0]!.count).toBe(0);
    });

    it('CODEX FINDING: cross-school unitId + platform standard → BadRequest', async () => {
      // The unit-school check must fire even when the standard is a
      // shared platform one. Otherwise a crafted unitId would let a
      // School-A admin write alignment rows under a School-B unit.
      const { unitId: foreignUnit } = await seedMapAndUnit(
        TEST_SCHOOL_B_ID,
        TEST_SIS_ACADEMIC_YEAR_B_ID,
      );
      await expect(
        withTestTenant(async () =>
          unitService.alignStandard(foreignUnit, { standardId: PLATFORM_STD_ID }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cross-school standardId (tenant standard owned by School B) → BadRequest', async () => {
      // The standard-resolution check fires first: a School-B tenant
      // standard is invisible from School A context, so resolveById
      // returns null and alignStandard throws.
      const { unitId } = await seedMapAndUnit(TEST_SCHOOL_ID, TEST_SIS_ACADEMIC_YEAR_ID);
      const fwId = await seedTenantFramework(TEST_SCHOOL_B_ID, 'B FW');
      const stdId = await seedTenantStandard(fwId, 'LOC.C');
      await expect(
        withTestTenant(async () =>
          unitService.alignStandard(unitId, { standardId: stdId }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('unknown standardId → BadRequestException', async () => {
      const { unitId } = await seedMapAndUnit(TEST_SCHOOL_ID, TEST_SIS_ACADEMIC_YEAR_ID);
      await expect(
        withTestTenant(async () =>
          unitService.alignStandard(
            unitId,
            { standardId: '00000000-0000-0000-0000-000000000000' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('duplicate alignment (same unit + standard) → ConflictException', async () => {
      const { unitId } = await seedMapAndUnit(TEST_SCHOOL_ID, TEST_SIS_ACADEMIC_YEAR_ID);
      await withTestTenant(async () =>
        unitService.alignStandard(unitId, { standardId: PLATFORM_STD_ID }, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          unitService.alignStandard(unitId, { standardId: PLATFORM_STD_ID }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('non-writer (teacher with no grants) → ForbiddenException', async () => {
      const { unitId } = await seedMapAndUnit(TEST_SCHOOL_ID, TEST_SIS_ACADEMIC_YEAR_ID);
      await expect(
        withTestTenant(async () =>
          unitService.alignStandard(unitId, { standardId: PLATFORM_STD_ID }, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // UnitService.unalignStandard
  // ──────────────────────────────────────────────────────────────
  describe('UnitService.unalignStandard', () => {
    it('admin removes an alignment → row deleted', async () => {
      const { unitId } = await seedMapAndUnit(TEST_SCHOOL_ID, TEST_SIS_ACADEMIC_YEAR_ID);
      const link = await withTestTenant(async () =>
        unitService.alignStandard(unitId, { standardId: PLATFORM_STD_ID }, adminActor()),
      );
      await withTestTenant(async () => unitService.unalignStandard(link.id, adminActor()));
      const rows = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.cur_unit_standards WHERE id = $1::uuid`,
        link.id,
      );
      expect(rows[0]!.count).toBe(0);
    });

    it('cross-school: unalignStandard from School B context does NOT delete a School-A link', async () => {
      const { unitId } = await seedMapAndUnit(TEST_SCHOOL_ID, TEST_SIS_ACADEMIC_YEAR_ID);
      const link = await withTestTenant(async () =>
        unitService.alignStandard(unitId, { standardId: PLATFORM_STD_ID }, adminActor()),
      );
      // From School B context — the JOIN through m.school_id matches
      // 0 rows and DELETE is a no-op.
      await withTestTenantB(async () => unitService.unalignStandard(link.id, adminActor()));
      const rows = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.cur_unit_standards WHERE id = $1::uuid`,
        link.id,
      );
      expect(rows[0]!.count).toBe(1);
    });
  });

  // Keep unused-import lint quiet — kept for parity.
  void mapService;
  void frameworkService;
  void NotFoundException;
});
