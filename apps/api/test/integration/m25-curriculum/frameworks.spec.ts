import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

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
import {
  TEST_SIS_ACADEMIC_YEAR_ID,
  TEST_SIS_ACADEMIC_YEAR_B_ID,
} from '../fixtures/sis';

/**
 * Wave 4 — m25-curriculum FrameworkService + StandardService.patchCustom
 * DB-backed integration tests covering the framework + adoption lifecycle
 * that maps-crud.spec / standards-alignment.spec leave uncovered.
 *
 * Contracts verified:
 *   - FrameworkService.list returns adopted-platform + school-custom
 *     frameworks tagged with source (PLATFORM/SCHOOL). includeUnadopted
 *     adds platform frameworks not yet adopted with isActive=false.
 *   - FrameworkService.list scope: only the current tenant's custom
 *     frameworks + adoptions. School B custom frameworks invisible
 *     from School A context.
 *   - FrameworkService.getById resolves platform OR tenant; returns a
 *     FrameworkDetailDto with the standards array populated.
 *   - FrameworkService.createCustom: admin gate; unique(school, name,
 *     version) violation → ConflictException.
 *   - FrameworkService.patchCustom: admin gate; cannot patch platform
 *     framework (404); cannot patch foreign-school custom framework (404).
 *   - FrameworkService.createAdoption: admin gate; platform framework
 *     must exist; duplicate (school, framework, year) → ConflictException.
 *   - FrameworkService.listAdoptions returns current tenant rows only.
 *   - StandardService.patchCustom: writer gate + tenant-only scope;
 *     code uniqueness preserved on update.
 */
describe('integration:m25-curriculum/frameworks', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let frameworkService: FrameworkService;
  let standardService: StandardService;

  let PLATFORM_FW_ID: string;
  let PLATFORM_STD_ID: string;
  let PLATFORM_FW_ID_B: string; // unadopted second platform framework

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    standardService = new StandardService(tenantPrisma, permCheck);
    frameworkService = new FrameworkService(tenantPrisma, permCheck);

    PLATFORM_FW_ID = generateId();
    PLATFORM_STD_ID = generateId();
    PLATFORM_FW_ID_B = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.cur_standards_frameworks_platform (id, name, body, region, version)
       VALUES ($1::uuid, 'CCSS-FW-TEST', 'CCSS', 'US', '1')
       ON CONFLICT (id) DO NOTHING`,
      PLATFORM_FW_ID,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.cur_standards_platform (id, framework_id, code, description, grade_band)
       VALUES ($1::uuid, $2::uuid, 'CCSS.FW.5.NBT.1', 'Place value', '5')
       ON CONFLICT (id) DO NOTHING`,
      PLATFORM_STD_ID,
      PLATFORM_FW_ID,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.cur_standards_frameworks_platform (id, name, body, region, version)
       VALUES ($1::uuid, 'NGSS-FW-TEST', 'NGSS', 'US', '1')
       ON CONFLICT (id) DO NOTHING`,
      PLATFORM_FW_ID_B,
    );
  });

  afterAll(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.cur_standards_platform WHERE id = $1::uuid`,
      PLATFORM_STD_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.cur_standards_frameworks_platform WHERE id IN ($1::uuid, $2::uuid)`,
      PLATFORM_FW_ID,
      PLATFORM_FW_ID_B,
    );
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    // Wipe curriculum + adoption rows so each test sees a clean slate.
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

  async function seedCustomFramework(
    schoolId: string,
    name: string,
    version = '1',
  ): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.cur_standards_frameworks
         (id, school_id, name, version, is_active, created_by)
       VALUES ($1::uuid, $2::uuid, $3, $4, true, $5::uuid)`,
      id,
      schoolId,
      name,
      version,
      adminActor().accountId,
    );
    return id;
  }

  async function seedCustomStandard(
    frameworkId: string,
    code: string,
    description = 'desc',
  ): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.cur_standards
         (id, framework_id, code, description, grade_band)
       VALUES ($1::uuid, $2::uuid, $3, $4, '5')`,
      id,
      frameworkId,
      code,
      description,
    );
    return id;
  }

  // ──────────────────────────────────────────────────────────────
  // FrameworkService.list — dual-resolution merge + tenant scope
  // ──────────────────────────────────────────────────────────────
  describe('list', () => {
    it('returns school-custom frameworks tagged source=SCHOOL', async () => {
      const fwId = await seedCustomFramework(TEST_SCHOOL_ID, 'Local Math FW');
      const list = await withTestTenant(async () => frameworkService.list());
      const found = list.find((f) => f.id === fwId);
      expect(found).toBeDefined();
      expect(found!.source).toBe('SCHOOL');
      expect(found!.name).toBe('Local Math FW');
      expect(found!.schoolId).toBe(TEST_SCHOOL_ID);
      expect(found!.isActive).toBe(true);
      expect(found!.standardCount).toBe(0);
    });

    it('counts custom standards under each framework', async () => {
      const fwId = await seedCustomFramework(TEST_SCHOOL_ID, 'Counted FW');
      await seedCustomStandard(fwId, 'CNT.1');
      await seedCustomStandard(fwId, 'CNT.2');

      const list = await withTestTenant(async () => frameworkService.list());
      const found = list.find((f) => f.id === fwId);
      expect(found!.standardCount).toBe(2);
    });

    it('adopted platform framework appears as source=PLATFORM (active)', async () => {
      await withTestTenant(async () =>
        frameworkService.createAdoption(
          {
            platformFrameworkId: PLATFORM_FW_ID,
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
          },
          adminActor(),
        ),
      );

      const list = await withTestTenant(async () => frameworkService.list());
      const platformHit = list.find((f) => f.id === PLATFORM_FW_ID);
      expect(platformHit).toBeDefined();
      expect(platformHit!.source).toBe('PLATFORM');
      expect(platformHit!.isActive).toBe(true);
      expect(platformHit!.body).toBe('CCSS');
      expect(platformHit!.standardCount).toBe(1);
    });

    it('includeUnadopted=true surfaces every platform framework with isActive=false for non-adopted', async () => {
      // Adopt CCSS only — NGSS remains unadopted.
      await withTestTenant(async () =>
        frameworkService.createAdoption(
          {
            platformFrameworkId: PLATFORM_FW_ID,
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
          },
          adminActor(),
        ),
      );

      const list = await withTestTenant(async () => frameworkService.list(true));
      const adopted = list.find((f) => f.id === PLATFORM_FW_ID);
      const unadopted = list.find((f) => f.id === PLATFORM_FW_ID_B);
      expect(adopted!.isActive).toBe(true);
      expect(unadopted).toBeDefined();
      expect(unadopted!.source).toBe('PLATFORM');
      expect(unadopted!.isActive).toBe(false);
    });

    it('includeUnadopted=false hides non-adopted platform frameworks', async () => {
      const list = await withTestTenant(async () => frameworkService.list(false));
      expect(list.find((f) => f.id === PLATFORM_FW_ID_B)).toBeUndefined();
    });

    it('cross-school: School B custom frameworks invisible from School A', async () => {
      const fwId = await seedCustomFramework(TEST_SCHOOL_B_ID, 'B FW');
      const list = await withTestTenant(async () => frameworkService.list());
      expect(list.find((f) => f.id === fwId)).toBeUndefined();
    });

    it('cross-school: School A adoption invisible from School B', async () => {
      await withTestTenant(async () =>
        frameworkService.createAdoption(
          {
            platformFrameworkId: PLATFORM_FW_ID,
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
          },
          adminActor(),
        ),
      );

      const listFromB = await withTestTenantB(async () => frameworkService.list());
      // School B context — no adoption yet, no custom — the platform
      // hit visible to A should not show as adopted from B's view.
      const fromB = listFromB.find((f) => f.id === PLATFORM_FW_ID);
      expect(fromB).toBeUndefined();
    });
  });

  // ──────────────────────────────────────────────────────────────
  // FrameworkService.getById — platform-first then tenant
  // ──────────────────────────────────────────────────────────────
  describe('getById', () => {
    it('returns a platform framework with its standards', async () => {
      const dto = await withTestTenant(async () => frameworkService.getById(PLATFORM_FW_ID));
      expect(dto.source).toBe('PLATFORM');
      expect(dto.name).toBe('CCSS-FW-TEST');
      expect(dto.standardCount).toBe(1);
      expect(dto.standards).toHaveLength(1);
      expect(dto.standards[0]!.code).toBe('CCSS.FW.5.NBT.1');
      expect(dto.standards[0]!.source).toBe('PLATFORM');
    });

    it('returns a current-school custom framework with its standards', async () => {
      const fwId = await seedCustomFramework(TEST_SCHOOL_ID, 'Local Detail FW');
      await seedCustomStandard(fwId, 'X.1', 'First');
      await seedCustomStandard(fwId, 'X.2', 'Second');

      const dto = await withTestTenant(async () => frameworkService.getById(fwId));
      expect(dto.source).toBe('SCHOOL');
      expect(dto.name).toBe('Local Detail FW');
      expect(dto.standardCount).toBe(2);
      expect(dto.standards.map((s) => s.code).sort()).toEqual(['X.1', 'X.2']);
    });

    it('foreign-school custom framework → NotFoundException', async () => {
      // Custom framework owned by School B is only resolvable from
      // School B context.
      const fwId = await seedCustomFramework(TEST_SCHOOL_B_ID, 'B Detail FW');
      await expect(
        withTestTenant(async () => frameworkService.getById(fwId)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          frameworkService.getById('00000000-0000-0000-0000-000000000000'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // FrameworkService.createCustom — admin gate + uniqueness
  // ──────────────────────────────────────────────────────────────
  describe('createCustom', () => {
    it('admin creates a custom framework → returns detail DTO with empty standards', async () => {
      const dto = await withTestTenant(async () =>
        frameworkService.createCustom(
          {
            name: 'New Math FW',
            version: '1',
            description: 'A school-built framework',
          },
          adminActor(),
        ),
      );
      expect(dto.source).toBe('SCHOOL');
      expect(dto.name).toBe('New Math FW');
      expect(dto.version).toBe('1');
      expect(dto.description).toBe('A school-built framework');
      expect(dto.standards).toEqual([]);
      expect(dto.isActive).toBe(true);
    });

    it('admin can create two distinct frameworks (different names)', async () => {
      const a = await withTestTenant(async () =>
        frameworkService.createCustom({ name: 'A FW', version: '1' }, adminActor()),
      );
      const b = await withTestTenant(async () =>
        frameworkService.createCustom({ name: 'B FW', version: '1' }, adminActor()),
      );
      expect(a.id).not.toBe(b.id);
    });

    it('non-admin (teacher) → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          frameworkService.createCustom({ name: 'Denied FW' }, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('duplicate (school, name, version) → ConflictException', async () => {
      await withTestTenant(async () =>
        frameworkService.createCustom({ name: 'Dup FW', version: '1' }, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          frameworkService.createCustom({ name: 'Dup FW', version: '1' }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('same (name, version) allowed in a different school (cross-school isolation)', async () => {
      await withTestTenant(async () =>
        frameworkService.createCustom({ name: 'Cross FW', version: '1' }, adminActor()),
      );
      // Same name/version in School B — unique constraint is per
      // school_id, so this should succeed.
      const fromB = await withTestTenantB(async () =>
        frameworkService.createCustom({ name: 'Cross FW', version: '1' }, adminActor()),
      );
      expect(fromB.schoolId).toBe(TEST_SCHOOL_B_ID);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // FrameworkService.patchCustom — admin gate + tenant scope
  // ──────────────────────────────────────────────────────────────
  describe('patchCustom', () => {
    it('admin patches name + description + version + isActive', async () => {
      const fwId = await seedCustomFramework(TEST_SCHOOL_ID, 'Patchy', '1');
      const dto = await withTestTenant(async () =>
        frameworkService.patchCustom(
          fwId,
          {
            name: 'Renamed',
            description: 'updated',
            version: '2',
            isActive: false,
          },
          adminActor(),
        ),
      );
      expect(dto.name).toBe('Renamed');
      expect(dto.description).toBe('updated');
      expect(dto.version).toBe('2');
      expect(dto.isActive).toBe(false);
    });

    it('empty input is a no-op (returns current detail)', async () => {
      const fwId = await seedCustomFramework(TEST_SCHOOL_ID, 'NoOp FW');
      const dto = await withTestTenant(async () =>
        frameworkService.patchCustom(fwId, {}, adminActor()),
      );
      expect(dto.name).toBe('NoOp FW');
    });

    it('patching a platform framework id → NotFoundException', async () => {
      // Platform frameworks are read-only; patchCustom looks them up
      // in cur_standards_frameworks by school_id, so it 404s.
      await expect(
        withTestTenant(async () =>
          frameworkService.patchCustom(PLATFORM_FW_ID, { name: 'hijack' }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('patching a foreign-school custom framework → NotFoundException', async () => {
      const fwId = await seedCustomFramework(TEST_SCHOOL_B_ID, 'B FW');
      await expect(
        withTestTenant(async () =>
          frameworkService.patchCustom(fwId, { name: 'hijack' }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-admin → ForbiddenException', async () => {
      const fwId = await seedCustomFramework(TEST_SCHOOL_ID, 'Locked');
      await expect(
        withTestTenant(async () =>
          frameworkService.patchCustom(fwId, { name: 'denied' }, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // FrameworkService.listAdoptions
  // ──────────────────────────────────────────────────────────────
  describe('listAdoptions', () => {
    it('returns adopted frameworks for the current tenant', async () => {
      await withTestTenant(async () =>
        frameworkService.createAdoption(
          {
            platformFrameworkId: PLATFORM_FW_ID,
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            notes: 'Adopt for 2026-2027',
          },
          adminActor(),
        ),
      );

      const list = await withTestTenant(async () => frameworkService.listAdoptions());
      expect(list).toHaveLength(1);
      expect(list[0]!.platformFrameworkId).toBe(PLATFORM_FW_ID);
      expect(list[0]!.platformFrameworkName).toBe('CCSS-FW-TEST');
      expect(list[0]!.academicYearId).toBe(TEST_SIS_ACADEMIC_YEAR_ID);
      expect(list[0]!.schoolId).toBe(TEST_SCHOOL_ID);
      expect(list[0]!.notes).toBe('Adopt for 2026-2027');
    });

    it('cross-school: School A adoption invisible from School B', async () => {
      await withTestTenant(async () =>
        frameworkService.createAdoption(
          {
            platformFrameworkId: PLATFORM_FW_ID,
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
          },
          adminActor(),
        ),
      );
      const fromB = await withTestTenantB(async () => frameworkService.listAdoptions());
      expect(fromB).toHaveLength(0);
    });

    it('empty list when no adoptions exist', async () => {
      const list = await withTestTenant(async () => frameworkService.listAdoptions());
      expect(list).toEqual([]);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // FrameworkService.createAdoption — admin gate + validation
  // ──────────────────────────────────────────────────────────────
  describe('createAdoption', () => {
    it('admin adopts a platform framework for an academic year → row inserted', async () => {
      const dto = await withTestTenant(async () =>
        frameworkService.createAdoption(
          {
            platformFrameworkId: PLATFORM_FW_ID,
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
          },
          adminActor(),
        ),
      );
      expect(dto.platformFrameworkId).toBe(PLATFORM_FW_ID);
      expect(dto.platformFrameworkName).toBe('CCSS-FW-TEST');
      expect(dto.schoolId).toBe(TEST_SCHOOL_ID);

      const rows = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.cur_school_framework_adoptions
         WHERE school_id = $1::uuid AND platform_framework_id = $2::uuid`,
        TEST_SCHOOL_ID,
        PLATFORM_FW_ID,
      );
      expect(rows[0]!.count).toBe(1);
    });

    it('non-admin (teacher) → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          frameworkService.createAdoption(
            {
              platformFrameworkId: PLATFORM_FW_ID,
              academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            },
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('unknown platformFrameworkId → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          frameworkService.createAdoption(
            {
              platformFrameworkId: '00000000-0000-0000-0000-000000000000',
              academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('duplicate (school, framework, year) → ConflictException', async () => {
      await withTestTenant(async () =>
        frameworkService.createAdoption(
          {
            platformFrameworkId: PLATFORM_FW_ID,
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
          },
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          frameworkService.createAdoption(
            {
              platformFrameworkId: PLATFORM_FW_ID,
              academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('two distinct platform frameworks in the same year are both allowed', async () => {
      const a = await withTestTenant(async () =>
        frameworkService.createAdoption(
          {
            platformFrameworkId: PLATFORM_FW_ID,
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
          },
          adminActor(),
        ),
      );
      const b = await withTestTenant(async () =>
        frameworkService.createAdoption(
          {
            platformFrameworkId: PLATFORM_FW_ID_B,
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
          },
          adminActor(),
        ),
      );
      expect(a.id).not.toBe(b.id);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // StandardService.patchCustom — writer gate + tenant scope
  // ──────────────────────────────────────────────────────────────
  describe('StandardService.patchCustom', () => {
    it('admin patches description + gradeBand + domain + cluster', async () => {
      const fwId = await seedCustomFramework(TEST_SCHOOL_ID, 'Patch Std FW');
      const stdId = await seedCustomStandard(fwId, 'P.1', 'orig');

      const dto = await withTestTenant(async () =>
        standardService.patchCustom(
          stdId,
          {
            description: 'updated',
            gradeBand: '6',
            domain: 'Algebra',
            cluster: 'AC.1',
          },
          adminActor(),
        ),
      );
      expect(dto.description).toBe('updated');
      expect(dto.gradeBand).toBe('6');
      expect(dto.domain).toBe('Algebra');
      expect(dto.cluster).toBe('AC.1');
    });

    it('admin renames the code', async () => {
      const fwId = await seedCustomFramework(TEST_SCHOOL_ID, 'Code Patch FW');
      const stdId = await seedCustomStandard(fwId, 'OLD.1');

      const dto = await withTestTenant(async () =>
        standardService.patchCustom(stdId, { code: 'NEW.1' }, adminActor()),
      );
      expect(dto.code).toBe('NEW.1');
    });

    it('empty input is a no-op (resolveById still returns the current DTO)', async () => {
      const fwId = await seedCustomFramework(TEST_SCHOOL_ID, 'NoOp Std FW');
      const stdId = await seedCustomStandard(fwId, 'NOP.1', 'orig');

      const dto = await withTestTenant(async () =>
        standardService.patchCustom(stdId, {}, adminActor()),
      );
      expect(dto.code).toBe('NOP.1');
      expect(dto.description).toBe('orig');
    });

    it('rename to a duplicate code → ConflictException', async () => {
      const fwId = await seedCustomFramework(TEST_SCHOOL_ID, 'Dup Code FW');
      await seedCustomStandard(fwId, 'A.1');
      const stdB = await seedCustomStandard(fwId, 'B.1');

      await expect(
        withTestTenant(async () =>
          standardService.patchCustom(stdB, { code: 'A.1' }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('patching a foreign-school standard → NotFoundException', async () => {
      const fwB = await seedCustomFramework(TEST_SCHOOL_B_ID, 'B Std FW');
      const stdB = await seedCustomStandard(fwB, 'FOR.1');

      await expect(
        withTestTenant(async () =>
          standardService.patchCustom(stdB, { description: 'hijack' }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-writer (teacher) → ForbiddenException', async () => {
      const fwId = await seedCustomFramework(TEST_SCHOOL_ID, 'Locked Std FW');
      const stdId = await seedCustomStandard(fwId, 'L.1');

      await expect(
        withTestTenant(async () =>
          standardService.patchCustom(stdId, { description: 'denied' }, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // Suppress unused lint
  void BadRequestException;
});
