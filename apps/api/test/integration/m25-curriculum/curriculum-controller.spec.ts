import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { CurriculumController } from '@modules/m25-curriculum/curriculum.controller';
import { FrameworkService, StandardService } from '@modules/m25-curriculum/frameworks.service';
import { CurriculumMapService, UnitService } from '@modules/m25-curriculum/maps.service';
import { DeliveryGapService, ResourceLinkService } from '@modules/m25-curriculum/gaps.service';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import { withTestTenant, TEST_SCHEMA, TEST_SCHOOL_ID } from '../helpers/tenant-context';
import {
  TEST_ADMIN_PERSON_ID,
  TEST_ADMIN_ACCOUNT_ID,
} from '../helpers/actor';
import { TEST_SIS_ACADEMIC_YEAR_ID } from '../fixtures/sis';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';

/**
 * Wave 4 — m25-curriculum CurriculumController DB-backed integration.
 *
 * Tests the controller's HTTP-style entry points by constructing the
 * controller with real services and invoking methods with synthetic
 * AuthedRequest objects. This is a lightweight alternative to a
 * supertest harness — exercises the controller code paths (delegation
 * + actor resolution + query/body marshalling) without spinning up an
 * HTTP listener.
 *
 * Controller methods are mostly thin pass-throughs to services that
 * the existing maps-crud / standards-alignment / lessons / frameworks /
 * gaps specs already cover deeply. The value here is bumping the
 * controller from 0% to ≥80% so the module-level coverage hits the
 * Wave 4 target.
 */
describe('integration:m25-curriculum/curriculum-controller', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let actorContext: ActorContextService;
  let frameworkService: FrameworkService;
  let standardService: StandardService;
  let mapService: CurriculumMapService;
  let unitService: UnitService;
  let gapsService: DeliveryGapService;
  let resourceService: ResourceLinkService;
  let controller: CurriculumController;

  // Stable per-spec ids
  let frameworkId: string;
  let mapId: string;
  let unitId: string;

  const cleanupIds = {
    frameworkIds: [] as string[],
    standardIds: [] as string[],
    mapIds: [] as string[],
    unitIds: [] as string[],
    unitStandardIds: [] as string[],
    unitLessonIds: [] as string[],
    resourceIds: [] as string[],
    adoptionIds: [] as string[],
  };

  // Synthetic AuthedRequest for the admin caller. The controller calls
  // actors.resolveActor(req.user.sub, req.user.personId); admin has
  // isSchoolAdmin=true via PermissionCheckService scope chain.
  function fakeAdminReq(): any {
    return {
      user: {
        sub: TEST_ADMIN_ACCOUNT_ID,
        personId: TEST_ADMIN_PERSON_ID,
        email: 'admin@test.integration.local',
        displayName: 'Integration Admin',
        sessionId: 'test-session',
      },
    };
  }

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    actorContext = new ActorContextService(rawClient, permCheck, tenantPrisma);
    const outbox = new OutboxService();

    frameworkService = new FrameworkService(tenantPrisma, permCheck);
    standardService = new StandardService(tenantPrisma, permCheck);
    mapService = new CurriculumMapService(tenantPrisma, permCheck);
    unitService = new UnitService(tenantPrisma, permCheck, standardService);
    const kafkaStub = { emit: async () => {} } as any;
    gapsService = new DeliveryGapService(tenantPrisma, permCheck, kafkaStub, standardService);
    resourceService = new ResourceLinkService(tenantPrisma, permCheck);
    void outbox;

    controller = new CurriculumController(
      frameworkService,
      standardService,
      mapService,
      unitService,
      gapsService,
      resourceService,
      actorContext,
    );

    // Seed admin permission cache so isSchoolAdmin resolves to true.
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, ARRAY['sch-001:admin','tch-008:write','tch-008:admin','tch-008:read']::text[], now(), 'test')
       ON CONFLICT (account_id, scope_id) DO UPDATE
         SET permission_codes = EXCLUDED.permission_codes`,
      TEST_ADMIN_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
    );
  });

  afterAll(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE account_id = $1::uuid`,
      TEST_ADMIN_ACCOUNT_ID,
    );
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    if (cleanupIds.resourceIds.length) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.cur_unit_resources WHERE id = ANY($1::uuid[])`,
        cleanupIds.resourceIds.splice(0),
      );
    }
    if (cleanupIds.unitLessonIds.length) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.cur_unit_lessons WHERE id = ANY($1::uuid[])`,
        cleanupIds.unitLessonIds.splice(0),
      );
    }
    if (cleanupIds.unitStandardIds.length) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.cur_unit_standards WHERE id = ANY($1::uuid[])`,
        cleanupIds.unitStandardIds.splice(0),
      );
    }
    if (cleanupIds.unitIds.length) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.cur_units WHERE id = ANY($1::uuid[])`,
        cleanupIds.unitIds.splice(0),
      );
    }
    if (cleanupIds.mapIds.length) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.cur_curriculum_maps WHERE id = ANY($1::uuid[])`,
        cleanupIds.mapIds.splice(0),
      );
    }
    if (cleanupIds.standardIds.length) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.cur_standards WHERE id = ANY($1::uuid[])`,
        cleanupIds.standardIds.splice(0),
      );
    }
    if (cleanupIds.adoptionIds.length) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.cur_framework_adoptions WHERE id = ANY($1::uuid[])`,
        cleanupIds.adoptionIds.splice(0),
      );
    }
    if (cleanupIds.frameworkIds.length) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.cur_standards_frameworks WHERE id = ANY($1::uuid[])`,
        cleanupIds.frameworkIds.splice(0),
      );
    }

    // Seed a per-spec framework + map + unit so controller methods that
    // need them have something to act on.
    frameworkId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.cur_standards_frameworks
         (id, school_id, name, version, description, created_by)
       VALUES ($1::uuid, $2::uuid, 'Ctrl FW ' || gen_random_uuid()::text, '1.0', 'Test', $3::uuid)`,
      frameworkId,
      TEST_SCHOOL_ID,
      TEST_ADMIN_PERSON_ID,
    );
    cleanupIds.frameworkIds.push(frameworkId);

    mapId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.cur_curriculum_maps
         (id, school_id, academic_year_id, subject, grade_level, title, status, created_by)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'MATH', '5', 'Ctrl Map', 'DRAFT', $4::uuid)`,
      mapId,
      TEST_SCHOOL_ID,
      TEST_SIS_ACADEMIC_YEAR_ID,
      TEST_ADMIN_PERSON_ID,
    );
    cleanupIds.mapIds.push(mapId);

    unitId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.cur_units (id, curriculum_map_id, title, sequence_order)
       VALUES ($1::uuid, $2::uuid, 'Ctrl Unit', 1)`,
      unitId,
      mapId,
    );
    cleanupIds.unitIds.push(unitId);
  });

  describe('frameworks', () => {
    it('listFrameworks delegates to FrameworkService.list', async () => {
      const list = await withTestTenant(async () => controller.listFrameworks());
      expect(Array.isArray(list)).toBe(true);
    });

    it('listFrameworks with includeUnadopted=true', async () => {
      const list = await withTestTenant(async () => controller.listFrameworks('true'));
      expect(Array.isArray(list)).toBe(true);
    });

    it('getFramework returns detail', async () => {
      const detail = await withTestTenant(async () => controller.getFramework(frameworkId));
      expect(detail.id).toBe(frameworkId);
    });

    it('createCustomFramework + patchCustomFramework delegate', async () => {
      const created = await withTestTenant(async () =>
        controller.createCustomFramework(
          {
            name: 'Custom FW',
            code: 'CTRL-CUST-' + Date.now(),
            version: '1.0',
            jurisdiction: 'School',
            subject: 'SCIENCE',
            description: null,
          } as any,
          fakeAdminReq(),
        ),
      );
      cleanupIds.frameworkIds.push(created.id);

      const patched = await withTestTenant(async () =>
        controller.patchCustomFramework(
          created.id,
          { description: 'updated' } as any,
          fakeAdminReq(),
        ),
      );
      expect(patched.description).toBe('updated');
    });

    it('listAdoptions returns array', async () => {
      const list = await withTestTenant(async () => controller.listAdoptions());
      expect(Array.isArray(list)).toBe(true);
    });
  });

  describe('standards', () => {
    it('searchStandards with various filters', async () => {
      const list = await withTestTenant(async () =>
        controller.searchStandards(undefined, undefined, undefined, undefined, '10'),
      );
      expect(Array.isArray(list)).toBe(true);

      const filtered = await withTestTenant(async () =>
        controller.searchStandards('test', frameworkId, 'K-5', 'Algebra', '5'),
      );
      expect(Array.isArray(filtered)).toBe(true);
    });

    it('createCustomStandard + patchCustomStandard delegate', async () => {
      const created = await withTestTenant(async () =>
        controller.createCustomStandard(
          {
            frameworkId,
            code: 'STD-' + Date.now(),
            description: 'Test standard',
            gradeBand: 'K-5',
            domain: 'Algebra',
          } as any,
          fakeAdminReq(),
        ),
      );
      cleanupIds.standardIds.push(created.id);
      expect(created.code).toMatch(/^STD-/);

      const patched = await withTestTenant(async () =>
        controller.patchCustomStandard(
          created.id,
          { description: 'updated desc' } as any,
          fakeAdminReq(),
        ),
      );
      expect(patched.description).toBe('updated desc');
    });
  });

  describe('curriculum maps', () => {
    it('listMaps + getMap', async () => {
      const list = await withTestTenant(async () =>
        controller.listMaps(fakeAdminReq(), 'MATH', '5', TEST_SIS_ACADEMIC_YEAR_ID, 'DRAFT'),
      );
      expect(list.map((m) => m.id)).toContain(mapId);

      const detail = await withTestTenant(async () =>
        controller.getMap(mapId, fakeAdminReq()),
      );
      expect(detail.id).toBe(mapId);
    });

    it('createMap + patchMap', async () => {
      const created = await withTestTenant(async () =>
        controller.createMap(
          {
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            subject: 'SCIENCE',
            gradeLevel: '6',
            title: 'New Map',
            frameworkId,
          } as any,
          fakeAdminReq(),
        ),
      );
      cleanupIds.mapIds.push(created.id);
      expect(created.title).toBe('New Map');

      const patched = await withTestTenant(async () =>
        controller.patchMap(created.id, { title: 'Renamed' } as any, fakeAdminReq()),
      );
      expect(patched.title).toBe('Renamed');
    });
  });

  describe('units', () => {
    it('listUnitsForMap + getUnit', async () => {
      const list = await withTestTenant(async () =>
        controller.listUnitsForMap(mapId, fakeAdminReq()),
      );
      expect(list.map((u) => u.id)).toContain(unitId);

      const detail = await withTestTenant(async () =>
        controller.getUnit(unitId, fakeAdminReq()),
      );
      expect(detail.id).toBe(unitId);
    });

    it('createUnit + patchUnit + reorderUnits', async () => {
      const created = await withTestTenant(async () =>
        controller.createUnit(
          mapId,
          { title: 'Unit B', sequenceOrder: 2 } as any,
          fakeAdminReq(),
        ),
      );
      cleanupIds.unitIds.push(created.id);
      expect(created.title).toBe('Unit B');

      const patched = await withTestTenant(async () =>
        controller.patchUnit(
          created.id,
          { description: 'patched' } as any,
          fakeAdminReq(),
        ),
      );
      expect(patched.description).toBe('patched');

      const reordered = await withTestTenant(async () =>
        controller.reorderUnits(
          mapId,
          { order: [{ unitId: created.id, sequenceOrder: 1 }, { unitId: unitId, sequenceOrder: 2 }] } as any,
          fakeAdminReq(),
        ),
      );
      expect(reordered.length).toBeGreaterThanOrEqual(2);
    });

    it('alignStandard + unalignStandard', async () => {
      // Create a standard first
      const std = await withTestTenant(async () =>
        controller.createCustomStandard(
          {
            frameworkId,
            code: 'ALIGN-' + Date.now(),
            description: 'Test',
          } as any,
          fakeAdminReq(),
        ),
      );
      cleanupIds.standardIds.push(std.id);

      const aligned = await withTestTenant(async () =>
        controller.alignStandard(
          unitId,
          { standardId: std.id, coverage: 'FULL' } as any,
          fakeAdminReq(),
        ),
      );
      cleanupIds.unitStandardIds.push(aligned.id);
      expect(aligned.unitId).toBe(unitId);
      expect(aligned.standardId).toBe(std.id);

      await withTestTenant(async () =>
        controller.unalignStandard(aligned.id, fakeAdminReq()),
      );
    });
  });

  describe('delivery gaps', () => {
    it('listGaps + listGapsForUnit + refreshGaps', async () => {
      const listAll = await withTestTenant(async () =>
        controller.listGaps(fakeAdminReq(), mapId, unitId, undefined),
      );
      expect(Array.isArray(listAll)).toBe(true);

      const listUnit = await withTestTenant(async () =>
        controller.listGapsForUnit(unitId, fakeAdminReq()),
      );
      expect(Array.isArray(listUnit)).toBe(true);

      const result = await withTestTenant(async () =>
        controller.refreshGaps(fakeAdminReq()),
      );
      expect(typeof result.unitsScanned).toBe('number');
      expect(typeof result.gapsWritten).toBe('number');
    });
  });

  describe('resources', () => {
    it('listResources + createResource + patchResource + removeResource', async () => {
      const empty = await withTestTenant(async () =>
        controller.listResources(unitId, fakeAdminReq()),
      );
      expect(empty).toHaveLength(0);

      const created = await withTestTenant(async () =>
        controller.createResource(
          unitId,
          {
            resourceType: 'URL',
            title: 'Reference',
            url: 'https://example.com',
            isTeacherOnly: false,
          } as any,
          fakeAdminReq(),
        ),
      );
      cleanupIds.resourceIds.push(created.id);
      expect(created.title).toBe('Reference');

      const patched = await withTestTenant(async () =>
        controller.patchResource(
          created.id,
          { title: 'Renamed Ref' } as any,
          fakeAdminReq(),
        ),
      );
      expect(patched.title).toBe('Renamed Ref');

      await withTestTenant(async () =>
        controller.removeResource(created.id, fakeAdminReq()),
      );
      const after = await withTestTenant(async () =>
        controller.listResources(unitId, fakeAdminReq()),
      );
      expect(after).toHaveLength(0);
    });
  });
});
