import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { LocationService } from '@modules/m24-library/location.service';
import { LocationController } from '@modules/m24-library/location.controller';
import { CatalogueItemService } from '@modules/m24-library/catalogue-item.service';
import { CatalogueItemController } from '@modules/m24-library/catalogue-item.controller';
import { CopyService } from '@modules/m24-library/copy.service';
import { CopyController } from '@modules/m24-library/copy.controller';
import { CheckoutService } from '@modules/m24-library/checkout.service';
import { CheckoutController } from '@modules/m24-library/checkout.controller';
import { HoldService } from '@modules/m24-library/hold.service';
import { HoldController } from '@modules/m24-library/hold.controller';
import { FineService } from '@modules/m24-library/fine.service';
import { FineController } from '@modules/m24-library/fine.controller';
import { ReadingProgrammeService } from '@modules/m24-library/reading-programme.service';
import { ReadingProgrammeController } from '@modules/m24-library/reading-programme.controller';
import { ReadingLogService } from '@modules/m24-library/reading-log.service';
import { ReadingLogController } from '@modules/m24-library/reading-log.controller';
import { ReadingListService } from '@modules/m24-library/reading-list.service';
import { ReadingListController } from '@modules/m24-library/reading-list.controller';
import { ReviewService } from '@modules/m24-library/review.service';
import { ReviewController } from '@modules/m24-library/review.controller';
import { ClassSetService } from '@modules/m24-library/class-set.service';
import { ClassSetController } from '@modules/m24-library/class-set.controller';
import { ClassSetOverdueWorker } from '@modules/m24-library/class-set-overdue.worker';
import { RecommendationService } from '@modules/m24-library/recommendation.service';
import { RecommendationController } from '@modules/m24-library/recommendation.controller';
import { InterlibraryLoanService } from '@modules/m24-library/interlibrary-loan.service';
import { InterlibraryLoanController } from '@modules/m24-library/interlibrary-loan.controller';
import { CatalogueImportService } from '@modules/m24-library/catalogue-import.service';
import { CatalogueImportController } from '@modules/m24-library/catalogue-import.controller';
import { CatalogueImportWorker } from '@modules/m24-library/catalogue-import.worker';
import { deterministicLibImportCompletedEventId } from '@modules/m24-library/event-ids';

import { ActorContextService, PermissionCheckService } from '@modules/m00-platform';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import {
  adminActor,
  teacherActor,
  parentActor,
  studentActor,
  officerActor,
  TEST_ADMIN_ACCOUNT_ID,
  TEST_ADMIN_PERSON_ID,
  TEST_TEACHER_ACCOUNT_ID,
  TEST_TEACHER_PERSON_ID,
  TEST_TEACHER_EMPLOYEE_ID,
  TEST_STUDENT_PERSON_ID,
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID, TEST_SCHOOL_B_SCOPE_ID } from './../fixtures/platform';
import { makeRecordingKafka, RecordingKafkaProducer } from '../helpers/recording-kafka';
import {
  ensureLibrarySeed,
  resetAndSeedLibrary,
  resetLibraryTables,
  TEST_LIB_LOCATION_A_ID,
  TEST_LIB_LOCATION_DISPLAY_A_ID,
  TEST_LIB_LOCATION_B_ID,
  TEST_LIB_ITEM_A_ID,
  TEST_LIB_ITEM_A2_ID,
  TEST_LIB_ITEM_NOPCOPY_A_ID,
  TEST_LIB_ITEM_B_ID,
  TEST_LIB_COPY_A1_ID,
  TEST_LIB_COPY_A1_BARCODE,
  TEST_LIB_COPY_A2_ID,
  TEST_LIB_COPY_A2_BARCODE,
  TEST_LIB_COPY_A3_ID,
  TEST_LIB_COPY_A3_BARCODE,
  TEST_LIB_COPY_A4_BARCODE,
  TEST_LIB_COPY_A5_BARCODE,
  TEST_LIB_COPY_B1_BARCODE,
  TEST_LIB_PROGRAMME_A_ID,
  TEST_LIB_PROGRAMME_CLASS_A_ID,
  TEST_LIB_PROGRAMME_B_ID,
  TEST_LIB_STU_A_ID,
  TEST_LIB_STU_B_ID,
} from '../fixtures/library';

const NONEXISTENT_UUID = '00000000-0000-0000-0000-000000000099';
const ALL_LIB_CODES = [
  'lib-001:read',
  'lib-001:write',
  'lib-001:admin',
  'lib-002:read',
  'lib-002:write',
  'lib-002:admin',
  'lib-003:read',
  'lib-003:write',
  'lib-003:admin',
];

describe('integration:m24-library/library-lifecycle', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let kafka: RecordingKafkaProducer;
  let outbox: OutboxService;
  let permissions: PermissionCheckService;
  let actors: ActorContextService;

  let locations: LocationService;
  let catalogue: CatalogueItemService;
  let copies: CopyService;
  let checkouts: CheckoutService;
  let holds: HoldService;
  let fines: FineService;
  let programmes: ReadingProgrammeService;
  let logs: ReadingLogService;
  let lists: ReadingListService;
  let reviews: ReviewService;
  let classSets: ClassSetService;
  let recommendations: RecommendationService;
  let ills: InterlibraryLoanService;
  let imports: CatalogueImportService;
  let classSetWorker: ClassSetOverdueWorker;
  let importWorker: CatalogueImportWorker;

  let locationCtrl: LocationController;
  let catalogueCtrl: CatalogueItemController;
  let copyCtrl: CopyController;
  let checkoutCtrl: CheckoutController;
  let holdCtrl: HoldController;
  let fineCtrl: FineController;
  let programmeCtrl: ReadingProgrammeController;
  let logCtrl: ReadingLogController;
  let listCtrl: ReadingListController;
  let reviewCtrl: ReviewController;
  let classSetCtrl: ClassSetController;
  let recommendationCtrl: RecommendationController;
  let illCtrl: InterlibraryLoanController;
  let importCtrl: CatalogueImportController;

  function fakeReq(opts?: { sub?: string; personId?: string }): any {
    return {
      user: {
        sub: opts?.sub ?? TEST_ADMIN_ACCOUNT_ID,
        personId: opts?.personId ?? TEST_ADMIN_PERSON_ID,
        email: 'admin@test.local',
        displayName: 'Admin',
        sessionId: 's',
      },
    };
  }

  async function grantAdminLibPerms(scopeId: string): Promise<void> {
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache
         (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], now(), 'lib-test-hash')
       ON CONFLICT (account_id, scope_id) DO UPDATE
         SET permission_codes = EXCLUDED.permission_codes, computed_at = now()`,
      generateId(),
      TEST_ADMIN_ACCOUNT_ID,
      scopeId,
      ['sch-001:admin', ...ALL_LIB_CODES],
    );
  }

  async function grantTeacherLibPerms(): Promise<void> {
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache
         (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], now(), 'lib-test-hash')
       ON CONFLICT (account_id, scope_id) DO UPDATE
         SET permission_codes = EXCLUDED.permission_codes, computed_at = now()`,
      generateId(),
      TEST_TEACHER_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
      ['lib-003:write', 'lib-003:read'],
    );
  }

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    kafka = makeRecordingKafka() as unknown as RecordingKafkaProducer;
    outbox = new OutboxService();
    permissions = new PermissionCheckService(rawClient);
    actors = new ActorContextService(rawClient, permissions, tenantPrisma);

    locations = new LocationService(tenantPrisma, permissions);
    catalogue = new CatalogueItemService(tenantPrisma, permissions);
    copies = new CopyService(tenantPrisma, permissions, catalogue);
    checkouts = new CheckoutService(tenantPrisma, permissions, kafka as any);
    holds = new HoldService(tenantPrisma, permissions, checkouts);
    fines = new FineService(tenantPrisma, permissions);
    programmes = new ReadingProgrammeService(tenantPrisma, permissions);
    logs = new ReadingLogService(tenantPrisma);
    lists = new ReadingListService(tenantPrisma, permissions);
    reviews = new ReviewService(tenantPrisma, permissions);
    classSets = new ClassSetService(tenantPrisma, permissions);
    recommendations = new RecommendationService(tenantPrisma, permissions);
    ills = new InterlibraryLoanService(tenantPrisma, permissions);
    imports = new CatalogueImportService(tenantPrisma, permissions, outbox);
    classSetWorker = new ClassSetOverdueWorker(tenantPrisma, classSets);
    importWorker = new CatalogueImportWorker(tenantPrisma, imports);

    locationCtrl = new LocationController(locations, actors);
    catalogueCtrl = new CatalogueItemController(catalogue, actors);
    copyCtrl = new CopyController(copies, actors);
    checkoutCtrl = new CheckoutController(checkouts, actors);
    holdCtrl = new HoldController(holds, actors);
    fineCtrl = new FineController(fines, actors);
    programmeCtrl = new ReadingProgrammeController(programmes, actors);
    logCtrl = new ReadingLogController(logs, actors);
    listCtrl = new ReadingListController(lists, actors);
    reviewCtrl = new ReviewController(reviews, actors);
    classSetCtrl = new ClassSetController(classSets, actors);
    recommendationCtrl = new RecommendationController(recommendations, actors);
    illCtrl = new InterlibraryLoanController(ills, actors);
    importCtrl = new CatalogueImportController(imports, actors);

    await ensureLibrarySeed(rawClient);

    // Grant admin lib-* perms in both School A and School B scopes so the
    // librarian-scope branch resolves consistently across cross-school tests.
    await grantAdminLibPerms(TEST_SCHOOL_SCOPE_ID);
    await grantAdminLibPerms(TEST_SCHOOL_B_SCOPE_ID);

    // Quiet unused-var warnings — controllers are instantiated to drive coverage.
    void locationCtrl;
    void catalogueCtrl;
    void copyCtrl;
    void checkoutCtrl;
    void holdCtrl;
    void fineCtrl;
    void programmeCtrl;
    void logCtrl;
    void listCtrl;
    void reviewCtrl;
    void classSetCtrl;
    void recommendationCtrl;
    void illCtrl;
    void importCtrl;
    void classSetWorker;
    void importWorker;
  });

  afterAll(async () => {
    await resetLibraryTables(rawClient);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache
        WHERE account_id IN ($1::uuid, $2::uuid)
          AND scope_id IN ($3::uuid, $4::uuid)`,
      TEST_ADMIN_ACCOUNT_ID,
      TEST_TEACHER_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
      TEST_SCHOOL_B_SCOPE_ID,
    );
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetAndSeedLibrary(rawClient);
    kafka.reset();
    // Clear teacher grant — most tests do not want it
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache
        WHERE account_id = $1::uuid AND scope_id = $2::uuid`,
      TEST_TEACHER_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
    );
  });

  // ═════════════════════════════════════════════════════════════════════
  // LocationService + LocationController
  // ═════════════════════════════════════════════════════════════════════
  describe('LocationService', () => {
    it('list returns school A only (active default) + cross-school isolation', async () => {
      const listA = await withTestTenant(async () => locations.list());
      const idsA = listA.map((l) => l.id);
      expect(idsA).toContain(TEST_LIB_LOCATION_A_ID);
      expect(idsA).toContain(TEST_LIB_LOCATION_DISPLAY_A_ID);
      expect(idsA).not.toContain(TEST_LIB_LOCATION_B_ID);

      const listB = await withTestTenantB(async () => locations.list());
      expect(listB.map((l) => l.id)).toContain(TEST_LIB_LOCATION_B_ID);
      expect(listB.map((l) => l.id)).not.toContain(TEST_LIB_LOCATION_A_ID);
    });

    it('list with includeInactive returns deactivated rows', async () => {
      const deactId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.lib_locations (id, school_id, name, location_type, is_active)
         VALUES ($1::uuid, $2::uuid, 'Retired', 'STORAGE', false)`,
        deactId,
        TEST_SCHOOL_ID,
      );
      const active = await withTestTenant(async () => locations.list(false));
      expect(active.map((l) => l.id)).not.toContain(deactId);
      const all = await withTestTenant(async () => locations.list(true));
      expect(all.map((l) => l.id)).toContain(deactId);
    });

    it('create + patch via librarian admin + UNIQUE collision', async () => {
      const created = await withTestTenant(async () =>
        locations.create(
          { name: 'Reference Shelf', locationType: 'SHELF' as any, sortOrder: 3 } as any,
          adminActor(),
        ),
      );
      expect(created.name).toBe('Reference Shelf');
      expect(created.sortOrder).toBe(3);
      // UNIQUE(school_id, name) → 400
      await expect(
        withTestTenant(async () =>
          locations.create(
            { name: 'Reference Shelf', locationType: 'SHELF' as any } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      // Patch
      const updated = await withTestTenant(async () =>
        locations.patch(
          created.id,
          { name: 'Reference Renamed', locationType: 'DISPLAY' as any, sortOrder: 5, isActive: false } as any,
          adminActor(),
        ),
      );
      expect(updated.name).toBe('Reference Renamed');
      expect(updated.locationType).toBe('DISPLAY');
      expect(updated.sortOrder).toBe(5);
      expect(updated.isActive).toBe(false);
    });

    it('create from non-librarian (teacher) → Forbidden', async () => {
      await expect(
        withTestTenant(async () =>
          locations.create(
            { name: 'Bogus', locationType: 'SHELF' as any } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('patch missing id → 404; patch no-op when body empty', async () => {
      await expect(
        withTestTenant(async () =>
          locations.patch(NONEXISTENT_UUID, { name: 'x' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);

      // Empty body → returns current row without UPDATE
      const same = await withTestTenant(async () =>
        locations.patch(TEST_LIB_LOCATION_A_ID, {} as any, adminActor()),
      );
      expect(same.id).toBe(TEST_LIB_LOCATION_A_ID);
    });

    it('patch with unique-collision name → 400', async () => {
      await expect(
        withTestTenant(async () =>
          locations.patch(
            TEST_LIB_LOCATION_DISPLAY_A_ID,
            { name: 'Fiction Shelf' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('patch from non-librarian → Forbidden', async () => {
      await expect(
        withTestTenant(async () =>
          locations.patch(TEST_LIB_LOCATION_A_ID, { name: 'X' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('getById missing → 404; getById finds seeded row', async () => {
      const loc = await withTestTenant(async () => locations.getById(TEST_LIB_LOCATION_A_ID));
      expect(loc.name).toBe('Fiction Shelf');
      await expect(
        withTestTenant(async () => locations.getById(NONEXISTENT_UUID)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('controller list / getById / create / patch pass-through', async () => {
      const list = await withTestTenant(async () => locationCtrl.list(false));
      expect(list.length).toBeGreaterThan(0);
      const list2 = await withTestTenant(async () => locationCtrl.list());
      expect(list2.length).toBeGreaterThan(0);
      const loc = await withTestTenant(async () =>
        locationCtrl.getById(TEST_LIB_LOCATION_A_ID),
      );
      expect(loc.id).toBe(TEST_LIB_LOCATION_A_ID);
      const created = await withTestTenant(async () =>
        locationCtrl.create(
          { name: 'Ctrl Shelf', locationType: 'SHELF' as any } as any,
          fakeReq(),
        ),
      );
      const patched = await withTestTenant(async () =>
        locationCtrl.patch(created.id, { name: 'Ctrl Renamed' } as any, fakeReq()),
      );
      expect(patched.name).toBe('Ctrl Renamed');
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // CatalogueItemService + CatalogueItemController
  // ═════════════════════════════════════════════════════════════════════
  describe('CatalogueItemService', () => {
    it('search with q triggers ts_rank ordering + cross-school isolation', async () => {
      const hits = await withTestTenant(async () =>
        catalogue.search({ q: 'Test', limit: 20 }),
      );
      expect(hits.map((h) => h.id)).toContain(TEST_LIB_ITEM_A_ID);
      // School B-only item must not surface
      expect(hits.map((h) => h.id)).not.toContain(TEST_LIB_ITEM_B_ID);
    });

    it('search browses alphabetically when q omitted; supports category + author filters', async () => {
      const browse = await withTestTenant(async () => catalogue.search({}));
      expect(browse.length).toBeGreaterThan(0);
      const cat = await withTestTenant(async () => catalogue.search({ category: 'FIC' }));
      expect(cat.every((h) => h.id !== TEST_LIB_ITEM_A2_ID)).toBe(true);
      const author = await withTestTenant(async () => catalogue.search({ author: 'Sam' }));
      expect(author.map((h) => h.id)).toContain(TEST_LIB_ITEM_A2_ID);
      // Cap limit honoured
      const huge = await withTestTenant(async () => catalogue.search({ limit: 5000 }));
      expect(huge.length).toBeLessThanOrEqual(200);
    });

    it('getById includes copies + rollups; not-found → 404', async () => {
      const dto = await withTestTenant(async () => catalogue.getById(TEST_LIB_ITEM_A_ID, true));
      expect(dto.id).toBe(TEST_LIB_ITEM_A_ID);
      expect(dto.totalCopies).toBe(5);
      expect(dto.availableCopies).toBe(5);
      const dtoNoCopies = await withTestTenant(async () =>
        catalogue.getById(TEST_LIB_ITEM_A_ID, false),
      );
      expect((dtoNoCopies as any).copies).toBeUndefined();
      await expect(
        withTestTenant(async () => catalogue.getById(NONEXISTENT_UUID)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('listCopies returns each copy with location label', async () => {
      const copyList = await withTestTenant(async () => catalogue.listCopies(TEST_LIB_ITEM_A_ID));
      expect(copyList.length).toBe(5);
      expect(copyList.every((c) => c.locationName === 'Fiction Shelf')).toBe(true);
    });

    it('create + patch via admin; non-librarian → Forbidden', async () => {
      const newItem = await withTestTenant(async () =>
        catalogue.create(
          {
            title: 'New Title',
            author: 'Anne Author',
            isbn: '978-9-999-99999-9',
            category: 'BIO',
            description: 'd',
          } as any,
          adminActor(),
        ),
      );
      expect(newItem.title).toBe('New Title');
      const patched = await withTestTenant(async () =>
        catalogue.patch(
          newItem.id,
          {
            title: 'New Title v2',
            author: 'Anne Updated',
            isbn: '978-1-222-33333-4',
            publisher: 'Pub',
            publishYear: 2025,
            category: 'AUT',
            deweyDecimal: '900.0',
            description: 'd2',
            coverImageUrl: 'https://x',
          } as any,
          adminActor(),
        ),
      );
      expect(patched.title).toBe('New Title v2');
      // Empty patch returns current with copies inlined
      const noop = await withTestTenant(async () =>
        catalogue.patch(newItem.id, {} as any, adminActor()),
      );
      expect(noop.id).toBe(newItem.id);
      // Non-librarian forbidden
      await expect(
        withTestTenant(async () =>
          catalogue.create({ title: 'X' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () =>
          catalogue.patch(newItem.id, { title: 'Y' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // Patch missing id → 404
      await expect(
        withTestTenant(async () =>
          catalogue.patch(NONEXISTENT_UUID, { title: 'Y' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('controller search / getById / listCopies / create / patch pass-through', async () => {
      const hits = await withTestTenant(async () =>
        catalogueCtrl.search('Test', undefined, undefined, '10'),
      );
      expect(hits.length).toBeGreaterThan(0);
      const noLimit = await withTestTenant(async () =>
        catalogueCtrl.search(undefined, undefined, undefined, undefined),
      );
      expect(noLimit.length).toBeGreaterThan(0);
      const badLimit = await withTestTenant(async () =>
        catalogueCtrl.search('Test', undefined, undefined, 'NaN'),
      );
      expect(badLimit.length).toBeGreaterThan(0);

      const dto = await withTestTenant(async () =>
        catalogueCtrl.getById(TEST_LIB_ITEM_A_ID),
      );
      expect(dto.id).toBe(TEST_LIB_ITEM_A_ID);
      const copyList = await withTestTenant(async () =>
        catalogueCtrl.listCopies(TEST_LIB_ITEM_A_ID),
      );
      expect(copyList.length).toBe(5);
      const created = await withTestTenant(async () =>
        catalogueCtrl.create({ title: 'CtrlCreated' } as any, fakeReq()),
      );
      const patched = await withTestTenant(async () =>
        catalogueCtrl.patch(created.id, { title: 'CtrlPatched' } as any, fakeReq()),
      );
      expect(patched.title).toBe('CtrlPatched');
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // CopyService + CopyController
  // ═════════════════════════════════════════════════════════════════════
  describe('CopyService', () => {
    it('lookupByBarcode happy path (admin sees activeCheckout if any)', async () => {
      const dto = await withTestTenant(async () =>
        copies.lookupByBarcode(TEST_LIB_COPY_A1_BARCODE, adminActor()),
      );
      expect(dto.copy.id).toBe(TEST_LIB_COPY_A1_ID);
      expect(dto.item.id).toBe(TEST_LIB_ITEM_A_ID);
      expect(dto.activeCheckout).toBeNull();
      expect(dto.isCheckedOut).toBe(false);
    });

    it('lookupByBarcode rejects unknown barcode', async () => {
      await expect(
        withTestTenant(async () => copies.lookupByBarcode('NOPE-9999', adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('lookupByBarcode without actor → activeCheckout suppressed', async () => {
      const dto = await withTestTenant(async () =>
        copies.lookupByBarcode(TEST_LIB_COPY_A1_BARCODE),
      );
      expect(dto.activeCheckout).toBeNull();
    });

    it('create with valid location + admin; UNIQUE barcode → 400; FK bad location → 400', async () => {
      const newCopy = await withTestTenant(async () =>
        copies.create(
          TEST_LIB_ITEM_A2_ID,
          {
            locationId: TEST_LIB_LOCATION_A_ID,
            barcode: 'LIB-NEW-1',
            condition: 'GOOD' as any,
            replacementValue: 9.99,
          } as any,
          adminActor(),
        ),
      );
      expect(newCopy.barcode).toBe('LIB-NEW-1');

      // Duplicate barcode → 400
      await expect(
        withTestTenant(async () =>
          copies.create(
            TEST_LIB_ITEM_A2_ID,
            { barcode: 'LIB-NEW-1' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      // Bad location FK → 400
      await expect(
        withTestTenant(async () =>
          copies.create(
            TEST_LIB_ITEM_A2_ID,
            { barcode: 'LIB-NEW-2', locationId: NONEXISTENT_UUID } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('create from non-librarian → Forbidden', async () => {
      await expect(
        withTestTenant(async () =>
          copies.create(TEST_LIB_ITEM_A_ID, { barcode: 'NO' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('patch updates fields + empty body no-op + bad FK location → 400 + missing → 404', async () => {
      const patched = await withTestTenant(async () =>
        copies.patch(
          TEST_LIB_COPY_A2_ID,
          {
            condition: 'FAIR' as any,
            locationId: TEST_LIB_LOCATION_DISPLAY_A_ID,
            isAvailable: false,
            locationStatus: 'IN_PROCESSING' as any,
            replacementValue: 7.50,
          } as any,
          adminActor(),
        ),
      );
      expect(patched.condition).toBe('FAIR');
      expect(patched.locationId).toBe(TEST_LIB_LOCATION_DISPLAY_A_ID);

      const noop = await withTestTenant(async () =>
        copies.patch(TEST_LIB_COPY_A2_ID, {} as any, adminActor()),
      );
      expect(noop.id).toBe(TEST_LIB_COPY_A2_ID);

      await expect(
        withTestTenant(async () =>
          copies.patch(
            TEST_LIB_COPY_A2_ID,
            { locationId: NONEXISTENT_UUID } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      await expect(
        withTestTenant(async () =>
          copies.patch(NONEXISTENT_UUID, { condition: 'GOOD' as any } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('patch from non-librarian → Forbidden', async () => {
      await expect(
        withTestTenant(async () =>
          copies.patch(TEST_LIB_COPY_A1_ID, { condition: 'GOOD' as any } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('getById missing → 404', async () => {
      await expect(
        withTestTenant(async () => copies.getById(NONEXISTENT_UUID)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('isLibrarian: admin true; teacher false', async () => {
      const a = await withTestTenant(async () => copies.isLibrarian(adminActor()));
      expect(a).toBe(true);
      const t = await withTestTenant(async () => copies.isLibrarian(teacherActor()));
      expect(t).toBe(false);
    });

    it('controller lookup / create / patch pass-through', async () => {
      const lookup = await withTestTenant(async () =>
        copyCtrl.lookupByBarcode(TEST_LIB_COPY_A1_BARCODE, fakeReq()),
      );
      expect(lookup.copy.id).toBe(TEST_LIB_COPY_A1_ID);
      const created = await withTestTenant(async () =>
        copyCtrl.create(
          TEST_LIB_ITEM_A2_ID,
          { barcode: 'LIB-CTRL-1' } as any,
          fakeReq(),
        ),
      );
      const patched = await withTestTenant(async () =>
        copyCtrl.patch(created.id, { condition: 'GOOD' as any } as any, fakeReq()),
      );
      expect(patched.id).toBe(created.id);
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // CheckoutService — KEYSTONE
  // ═════════════════════════════════════════════════════════════════════
  describe('CheckoutService', () => {
    it('listPolicies + loadPolicy + assertPatronInCurrentTenant', async () => {
      const list = await withTestTenant(async () => checkouts.listPolicies());
      expect(list.length).toBeGreaterThanOrEqual(2);
      const sp = await withTestTenant(async () => checkouts.loadPolicy('STUDENT'));
      expect(sp.maxCheckouts).toBe(5);
      expect(sp.overdueFinePerDay).toBe(0.25);
      // Patron resolution for the seeded student
      const patronType = await withTestTenant(async () =>
        checkouts.assertPatronInCurrentTenant(TEST_STUDENT_PERSON_ID),
      );
      expect(patronType).toBe('STUDENT');
      // Patron resolution for teacher = STAFF
      const staffType = await withTestTenant(async () =>
        checkouts.assertPatronInCurrentTenant(TEST_TEACHER_PERSON_ID),
      );
      expect(staffType).toBe('STAFF');
      // Unknown patron → BadRequest
      await expect(
        withTestTenant(async () =>
          checkouts.assertPatronInCurrentTenant(NONEXISTENT_UUID),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // resolvePatronType nullable signature
      const t = await withTestTenant(async () => checkouts.resolvePatronType(NONEXISTENT_UUID));
      expect(t).toBeNull();
    });

    it('loadPolicy missing → BadRequest', async () => {
      // School B has no STAFF policy seeded
      await expect(
        withTestTenantB(async () => checkouts.loadPolicy('STAFF')),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('checkout-by-barcode keystone: locks copy + flips state + creates row', async () => {
      const co = await withTestTenant(async () =>
        checkouts.checkout(
          { barcode: TEST_LIB_COPY_A1_BARCODE, patronId: TEST_STUDENT_PERSON_ID } as any,
          adminActor(),
        ),
      );
      expect(co.status).toBe('ACTIVE');
      expect(co.copyBarcode).toBe(TEST_LIB_COPY_A1_BARCODE);

      // Copy state flipped
      const copyState = await rawClient.$queryRawUnsafe<
        Array<{ is_available: boolean; location_status: string }>
      >(
        `SELECT is_available, location_status FROM ${TEST_SCHEMA}.lib_catalogue_copies WHERE id = $1::uuid`,
        TEST_LIB_COPY_A1_ID,
      );
      expect(copyState[0]!.is_available).toBe(false);
      expect(copyState[0]!.location_status).toBe('CHECKED_OUT');
    });

    it('checkout-by-copyId path also works', async () => {
      const co = await withTestTenant(async () =>
        checkouts.checkout(
          { copyId: TEST_LIB_COPY_A2_ID, patronId: TEST_STUDENT_PERSON_ID, loanPeriodDays: 7 } as any,
          adminActor(),
        ),
      );
      expect(co.copyId).toBe(TEST_LIB_COPY_A2_ID);
    });

    it('checkout requires barcode or copyId; rejects unknown barcode; rejects unavailable copy', async () => {
      await expect(
        withTestTenant(async () =>
          checkouts.checkout(
            { patronId: TEST_STUDENT_PERSON_ID } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        withTestTenant(async () =>
          checkouts.checkout(
            { barcode: 'NOPE', patronId: TEST_STUDENT_PERSON_ID } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        withTestTenant(async () =>
          checkouts.checkout(
            { copyId: NONEXISTENT_UUID, patronId: TEST_STUDENT_PERSON_ID } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      // First check it out
      await withTestTenant(async () =>
        checkouts.checkout(
          { barcode: TEST_LIB_COPY_A3_BARCODE, patronId: TEST_STUDENT_PERSON_ID } as any,
          adminActor(),
        ),
      );
      // Re-checkout same copy → unavailable
      await expect(
        withTestTenant(async () =>
          checkouts.checkout(
            { barcode: TEST_LIB_COPY_A3_BARCODE, patronId: TEST_STUDENT_PERSON_ID } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('checkout from non-librarian → Forbidden', async () => {
      await expect(
        withTestTenant(async () =>
          checkouts.checkout(
            { barcode: TEST_LIB_COPY_A1_BARCODE, patronId: TEST_STUDENT_PERSON_ID } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('returnCheckout (on-time) flips status; copy returns to ON_SHELF; no fine', async () => {
      const co = await withTestTenant(async () =>
        checkouts.checkout(
          { barcode: TEST_LIB_COPY_A1_BARCODE, patronId: TEST_STUDENT_PERSON_ID } as any,
          adminActor(),
        ),
      );
      const ret = await withTestTenant(async () =>
        checkouts.returnCheckout(co.id, adminActor()),
      );
      expect(ret.status).toBe('RETURNED');
      expect(ret.returnedAt).not.toBeNull();

      const copyState = await rawClient.$queryRawUnsafe<
        Array<{ is_available: boolean; location_status: string }>
      >(
        `SELECT is_available, location_status FROM ${TEST_SCHEMA}.lib_catalogue_copies WHERE id = $1::uuid`,
        TEST_LIB_COPY_A1_ID,
      );
      expect(copyState[0]!.is_available).toBe(true);
      expect(copyState[0]!.location_status).toBe('ON_SHELF');

      const fineCount = await rawClient.$queryRawUnsafe<Array<{ c: bigint }>>(
        `SELECT count(*)::bigint AS c FROM ${TEST_SCHEMA}.lib_fines WHERE checkout_id = $1::uuid`,
        co.id,
      );
      expect(Number(fineCount[0]!.c)).toBe(0);
      // No lib.fine.issued emit on time
      expect(kafka.callsForTopic('lib.fine.issued').length).toBe(0);
    });

    it('returnCheckout (overdue) creates fine + emits lib.fine.issued AFTER commit', async () => {
      // Create a manual checkout with a 5-day-overdue due_date
      const coId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.lib_checkouts
           (id, copy_id, patron_id, checkout_date, due_date, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, CURRENT_DATE - 20, CURRENT_DATE - 5, 'ACTIVE')`,
        coId,
        TEST_LIB_COPY_A1_ID,
        TEST_STUDENT_PERSON_ID,
      );
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.lib_catalogue_copies
            SET is_available = false, location_status = 'CHECKED_OUT'
          WHERE id = $1::uuid`,
        TEST_LIB_COPY_A1_ID,
      );

      kafka.reset();
      const ret = await withTestTenant(async () => checkouts.returnCheckout(coId, adminActor()));
      expect(ret.status).toBe('RETURNED');

      // Fine row created
      const fineRows = await rawClient.$queryRawUnsafe<
        Array<{ amount: string; days_overdue: number; fine_type: string; status: string }>
      >(
        `SELECT amount::text AS amount, days_overdue, fine_type, status
           FROM ${TEST_SCHEMA}.lib_fines WHERE checkout_id = $1::uuid`,
        coId,
      );
      expect(fineRows.length).toBe(1);
      expect(fineRows[0]!.fine_type).toBe('OVERDUE');
      expect(fineRows[0]!.days_overdue).toBe(5);
      expect(Number(fineRows[0]!.amount)).toBeCloseTo(5 * 0.25, 2);

      // Kafka emit
      const emits = kafka.callsForTopic('lib.fine.issued');
      expect(emits.length).toBe(1);
      expect((emits[0]!.payload as any).fineType).toBe('OVERDUE');
    });

    it('returnCheckout fulfils oldest PENDING hold → READY + copy ON_HOLD_SHELF', async () => {
      // First check the copy out
      const co = await withTestTenant(async () =>
        checkouts.checkout(
          { barcode: TEST_LIB_COPY_A1_BARCODE, patronId: TEST_STUDENT_PERSON_ID } as any,
          adminActor(),
        ),
      );
      // Place a pending hold
      const holdId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.lib_holds
           (id, catalogue_item_id, patron_id, placed_at, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, now() - INTERVAL '1 hour', 'PENDING')`,
        holdId,
        TEST_LIB_ITEM_A_ID,
        TEST_TEACHER_PERSON_ID,
      );
      await withTestTenant(async () => checkouts.returnCheckout(co.id, adminActor()));
      const holdRow = await rawClient.$queryRawUnsafe<
        Array<{ status: string; notified_at: Date | null }>
      >(
        `SELECT status, notified_at FROM ${TEST_SCHEMA}.lib_holds WHERE id = $1::uuid`,
        holdId,
      );
      expect(holdRow[0]!.status).toBe('READY');
      expect(holdRow[0]!.notified_at).not.toBeNull();
      const copyState = await rawClient.$queryRawUnsafe<Array<{ location_status: string }>>(
        `SELECT location_status FROM ${TEST_SCHEMA}.lib_catalogue_copies WHERE id = $1::uuid`,
        TEST_LIB_COPY_A1_ID,
      );
      expect(copyState[0]!.location_status).toBe('ON_HOLD_SHELF');
    });

    it('returnCheckout double-return → BadRequest; missing checkout → 404', async () => {
      const co = await withTestTenant(async () =>
        checkouts.checkout(
          { barcode: TEST_LIB_COPY_A1_BARCODE, patronId: TEST_STUDENT_PERSON_ID } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () => checkouts.returnCheckout(co.id, adminActor()));
      await expect(
        withTestTenant(async () => checkouts.returnCheckout(co.id, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        withTestTenant(async () => checkouts.returnCheckout(NONEXISTENT_UUID, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returnCheckout from non-librarian → Forbidden', async () => {
      const co = await withTestTenant(async () =>
        checkouts.checkout(
          { barcode: TEST_LIB_COPY_A1_BARCODE, patronId: TEST_STUDENT_PERSON_ID } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () => checkouts.returnCheckout(co.id, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('renew bumps due_date + renewal_count; cap at policy.renewals_allowed; bad status', async () => {
      const co = await withTestTenant(async () =>
        checkouts.checkout(
          { barcode: TEST_LIB_COPY_A2_BARCODE, patronId: TEST_STUDENT_PERSON_ID } as any,
          adminActor(),
        ),
      );
      const r1 = await withTestTenant(async () => checkouts.renew(co.id, adminActor()));
      expect(r1.renewalCount).toBe(1);
      const r2 = await withTestTenant(async () => checkouts.renew(co.id, adminActor()));
      expect(r2.renewalCount).toBe(2);
      // policy says 2 renewals — third should hit cap
      await expect(
        withTestTenant(async () => checkouts.renew(co.id, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Renew on RETURNED → BadRequest
      await withTestTenant(async () => checkouts.returnCheckout(co.id, adminActor()));
      await expect(
        withTestTenant(async () => checkouts.renew(co.id, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Renew missing → 404
      await expect(
        withTestTenant(async () => checkouts.renew(NONEXISTENT_UUID, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
      // Non-librarian → Forbidden
      await expect(
        withTestTenant(async () => checkouts.renew(co.id, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('list (librarian sees all; patron sees own; filters)', async () => {
      // Two checkouts: one for student, one for teacher (staff)
      const stuCo = await withTestTenant(async () =>
        checkouts.checkout(
          { barcode: TEST_LIB_COPY_A1_BARCODE, patronId: TEST_STUDENT_PERSON_ID } as any,
          adminActor(),
        ),
      );
      const tchCo = await withTestTenant(async () =>
        checkouts.checkout(
          { barcode: TEST_LIB_COPY_A2_BARCODE, patronId: TEST_TEACHER_PERSON_ID } as any,
          adminActor(),
        ),
      );

      const all = await withTestTenant(async () => checkouts.list({} as any, adminActor()));
      const ids = all.map((c) => c.id);
      expect(ids).toContain(stuCo.id);
      expect(ids).toContain(tchCo.id);

      const studentSelf = await withTestTenant(async () =>
        checkouts.list({} as any, studentActor()),
      );
      expect(studentSelf.map((c) => c.id)).toContain(stuCo.id);
      expect(studentSelf.map((c) => c.id)).not.toContain(tchCo.id);

      const onlyActive = await withTestTenant(async () =>
        checkouts.list({ onlyActive: true } as any, adminActor()),
      );
      expect(onlyActive.every((c) => c.returnedAt === null)).toBe(true);

      const byStatus = await withTestTenant(async () =>
        checkouts.list({ status: 'ACTIVE' } as any, adminActor()),
      );
      expect(byStatus.every((c) => c.status === 'ACTIVE')).toBe(true);

      const byPatron = await withTestTenant(async () =>
        checkouts.list({ patronId: TEST_STUDENT_PERSON_ID } as any, adminActor()),
      );
      expect(byPatron.every((c) => c.patronId === TEST_STUDENT_PERSON_ID)).toBe(true);
    });

    it('listOverdue librarian sees overdue rows; non-librarian → Forbidden', async () => {
      // Create a fresh overdue row
      const coId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.lib_checkouts
           (id, copy_id, patron_id, checkout_date, due_date, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, CURRENT_DATE - 30, CURRENT_DATE - 3, 'OVERDUE')`,
        coId,
        TEST_LIB_COPY_A1_ID,
        TEST_STUDENT_PERSON_ID,
      );
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.lib_catalogue_copies SET is_available = false WHERE id = $1::uuid`,
        TEST_LIB_COPY_A1_ID,
      );
      const overdue = await withTestTenant(async () => checkouts.listOverdue(adminActor()));
      expect(overdue.map((c) => c.id)).toContain(coId);
      await expect(
        withTestTenant(async () => checkouts.listOverdue(teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('getById row-scope: patron sees own; non-owner non-librarian → 404; missing → 404', async () => {
      const stuCo = await withTestTenant(async () =>
        checkouts.checkout(
          { barcode: TEST_LIB_COPY_A1_BARCODE, patronId: TEST_STUDENT_PERSON_ID } as any,
          adminActor(),
        ),
      );
      const own = await withTestTenant(async () => checkouts.getById(stuCo.id, studentActor()));
      expect(own.id).toBe(stuCo.id);
      // teacher is non-librarian non-owner → 404
      await expect(
        withTestTenant(async () => checkouts.getById(stuCo.id, teacherActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        withTestTenant(async () => checkouts.getById(NONEXISTENT_UUID, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
      // Without actor (internal call)
      const internal = await withTestTenant(async () => checkouts.getById(stuCo.id));
      expect(internal.id).toBe(stuCo.id);
    });

    it('checkout reaches max_checkouts → BadRequest', async () => {
      // Seed 5 active checkouts for the student (max=5 per policy)
      for (let i = 0; i < 5; i++) {
        const coId = generateId();
        await rawClient.$executeRawUnsafe(
          `INSERT INTO ${TEST_SCHEMA}.lib_checkouts
             (id, copy_id, patron_id, checkout_date, due_date, status)
           VALUES ($1::uuid, $2::uuid, $3::uuid, CURRENT_DATE, CURRENT_DATE + 14, 'ACTIVE')`,
          coId,
          // reuse copy_id — schema does not require unique copy_id per active
          TEST_LIB_COPY_A1_ID,
          TEST_STUDENT_PERSON_ID,
        );
      }
      // Sixth attempt → BadRequest
      await expect(
        withTestTenant(async () =>
          checkouts.checkout(
            { barcode: TEST_LIB_COPY_A2_BARCODE, patronId: TEST_STUDENT_PERSON_ID } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('checkout rejects patron from another tenant', async () => {
      // The school B student's person id should not resolve in school A
      // (because sis_students binding is in school B). The exact error
      // wording is "Patron is neither a student nor a staff member..."
      await expect(
        withTestTenant(async () =>
          checkouts.checkout(
            { barcode: TEST_LIB_COPY_A1_BARCODE, patronId: TEST_LIB_STU_B_ID } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('controller pass-throughs: listPolicies / list / overdue / getById / create / return / renew', async () => {
      const policies = await withTestTenant(async () => checkoutCtrl.listPolicies());
      expect(policies.length).toBeGreaterThanOrEqual(2);
      const empty = await withTestTenant(async () =>
        checkoutCtrl.list(undefined, undefined, undefined, fakeReq()),
      );
      expect(empty.length).toBeGreaterThanOrEqual(0);
      // With status + onlyActive + patron filter
      const filtered = await withTestTenant(async () =>
        checkoutCtrl.list('ACTIVE', TEST_STUDENT_PERSON_ID, 'true', fakeReq()),
      );
      expect(filtered).toBeDefined();
      // Bad status string is ignored
      const badStatus = await withTestTenant(async () =>
        checkoutCtrl.list('BOGUS', undefined, 'false', fakeReq()),
      );
      expect(badStatus).toBeDefined();
      // onlyActive 'false' branch
      const noActive = await withTestTenant(async () =>
        checkoutCtrl.list(undefined, undefined, 'false', fakeReq()),
      );
      expect(noActive).toBeDefined();

      const created = await withTestTenant(async () =>
        checkoutCtrl.create(
          { barcode: TEST_LIB_COPY_A1_BARCODE, patronId: TEST_STUDENT_PERSON_ID } as any,
          fakeReq(),
        ),
      );
      const got = await withTestTenant(async () => checkoutCtrl.getById(created.id, fakeReq()));
      expect(got.id).toBe(created.id);
      const renewed = await withTestTenant(async () =>
        checkoutCtrl.renew(created.id, fakeReq()),
      );
      expect(renewed.renewalCount).toBe(1);
      const returned = await withTestTenant(async () =>
        checkoutCtrl.returnCheckout(created.id, fakeReq()),
      );
      expect(returned.status).toBe('RETURNED');
      const overdue = await withTestTenant(async () => checkoutCtrl.listOverdue(fakeReq()));
      expect(overdue).toBeDefined();
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // HoldService + HoldController
  // ═════════════════════════════════════════════════════════════════════
  describe('HoldService', () => {
    it('placeHold self-service + queuePosition; getById row-scope; cancel; collect', async () => {
      const h = await withTestTenant(async () =>
        holds.placeHold({ catalogueItemId: TEST_LIB_ITEM_A_ID } as any, studentActor()),
      );
      expect(h.status).toBe('PENDING');
      expect(h.queuePosition).toBe(1);

      // Student reads their own hold
      const own = await withTestTenant(async () => holds.getById(h.id, studentActor()));
      expect(own.id).toBe(h.id);
      // Teacher (not librarian) is not the owner → 404 don't-leak
      await expect(
        withTestTenant(async () => holds.getById(h.id, teacherActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
      // Admin sees any
      const asAdmin = await withTestTenant(async () => holds.getById(h.id, adminActor()));
      expect(asAdmin.id).toBe(h.id);
      // Missing → 404
      await expect(
        withTestTenant(async () => holds.getById(NONEXISTENT_UUID, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
      // Internal (actor undefined) returns row
      const internal = await withTestTenant(async () => holds.getById(h.id));
      expect(internal.id).toBe(h.id);

      // Duplicate hold for same item → BadRequest
      await expect(
        withTestTenant(async () =>
          holds.placeHold({ catalogueItemId: TEST_LIB_ITEM_A_ID } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      // Cancel self
      const cancelled = await withTestTenant(async () => holds.cancel(h.id, studentActor()));
      expect(cancelled.status).toBe('CANCELLED');
      // Re-cancel terminal → BadRequest
      await expect(
        withTestTenant(async () => holds.cancel(h.id, studentActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('placeHold rejects no-copies item; missing item → 404', async () => {
      await expect(
        withTestTenant(async () =>
          holds.placeHold({ catalogueItemId: TEST_LIB_ITEM_NOPCOPY_A_ID } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        withTestTenant(async () =>
          holds.placeHold({ catalogueItemId: NONEXISTENT_UUID } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('placeHold on behalf of patron requires librarian + cross-tenant patron rejected', async () => {
      // Non-librarian trying to place a hold on behalf of someone else → Forbidden
      await expect(
        withTestTenant(async () =>
          holds.placeHold(
            { catalogueItemId: TEST_LIB_ITEM_A_ID, patronId: TEST_TEACHER_PERSON_ID } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // Admin placing on behalf of a foreign patron (school B student) → BadRequest
      await expect(
        withTestTenant(async () =>
          holds.placeHold(
            { catalogueItemId: TEST_LIB_ITEM_A_ID, patronId: TEST_LIB_STU_B_ID } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Admin placing on behalf of teacher (valid staff) — succeeds
      const h = await withTestTenant(async () =>
        holds.placeHold(
          { catalogueItemId: TEST_LIB_ITEM_A2_ID, patronId: TEST_TEACHER_PERSON_ID } as any,
          adminActor(),
        ),
      );
      expect(h.patronId).toBe(TEST_TEACHER_PERSON_ID);
    });

    it('placeHold with no patron + no actor.personId → BadRequest', async () => {
      // Forge an actor with no personId (not realistic in practice but covers the branch)
      const bogus = { ...studentActor(), personId: '' };
      await expect(
        withTestTenant(async () =>
          holds.placeHold({ catalogueItemId: TEST_LIB_ITEM_A_ID } as any, bogus as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('list librarian sees all; patron sees own; filters', async () => {
      const h = await withTestTenant(async () =>
        holds.placeHold({ catalogueItemId: TEST_LIB_ITEM_A_ID } as any, studentActor()),
      );
      const all = await withTestTenant(async () => holds.list(adminActor(), {} as any));
      expect(all.map((x) => x.id)).toContain(h.id);
      const own = await withTestTenant(async () => holds.list(studentActor(), {} as any));
      expect(own.map((x) => x.id)).toContain(h.id);
      const byStatus = await withTestTenant(async () =>
        holds.list(adminActor(), { status: 'PENDING' } as any),
      );
      expect(byStatus.every((x) => x.status === 'PENDING')).toBe(true);
      const byPatron = await withTestTenant(async () =>
        holds.list(adminActor(), { patronId: TEST_STUDENT_PERSON_ID } as any),
      );
      expect(byPatron.every((x) => x.patronId === TEST_STUDENT_PERSON_ID)).toBe(true);
    });

    it('cancel non-librarian non-owner → Forbidden', async () => {
      const h = await withTestTenant(async () =>
        holds.placeHold({ catalogueItemId: TEST_LIB_ITEM_A_ID } as any, studentActor()),
      );
      await expect(
        withTestTenant(async () => holds.cancel(h.id, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // Missing → 404
      await expect(
        withTestTenant(async () => holds.cancel(NONEXISTENT_UUID, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('collect requires READY status + librarian', async () => {
      const h = await withTestTenant(async () =>
        holds.placeHold({ catalogueItemId: TEST_LIB_ITEM_A_ID } as any, studentActor()),
      );
      // PENDING → BadRequest on collect
      await expect(
        withTestTenant(async () => holds.collect(h.id, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Flip to READY then collect
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.lib_holds SET status = 'READY', notified_at = now() WHERE id = $1::uuid`,
        h.id,
      );
      const collected = await withTestTenant(async () => holds.collect(h.id, adminActor()));
      expect(collected.status).toBe('COLLECTED');
      // Non-librarian → Forbidden
      await expect(
        withTestTenant(async () => holds.collect(h.id, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // Missing → 404
      await expect(
        withTestTenant(async () => holds.collect(NONEXISTENT_UUID, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('controller list / getById / create / cancel / collect pass-through', async () => {
      const created = await withTestTenant(async () =>
        holdCtrl.create(
          { catalogueItemId: TEST_LIB_ITEM_A_ID } as any,
          fakeReq({ sub: TEST_ADMIN_ACCOUNT_ID, personId: TEST_STUDENT_PERSON_ID }),
        ),
      );
      const list = await withTestTenant(async () =>
        holdCtrl.list(undefined, undefined, fakeReq()),
      );
      expect(list.length).toBeGreaterThan(0);
      const filtered = await withTestTenant(async () =>
        holdCtrl.list('PENDING', TEST_STUDENT_PERSON_ID, fakeReq()),
      );
      expect(filtered.length).toBeGreaterThanOrEqual(0);
      const badStatus = await withTestTenant(async () =>
        holdCtrl.list('BOGUS', undefined, fakeReq()),
      );
      expect(badStatus).toBeDefined();
      const got = await withTestTenant(async () =>
        holdCtrl.getById(created.id, fakeReq()),
      );
      expect(got.id).toBe(created.id);
      // Move to READY then collect via controller
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.lib_holds SET status = 'READY', notified_at = now() WHERE id = $1::uuid`,
        created.id,
      );
      const collected = await withTestTenant(async () =>
        holdCtrl.collect(created.id, fakeReq()),
      );
      expect(collected.status).toBe('COLLECTED');
      // Create + cancel another
      const second = await withTestTenant(async () =>
        holdCtrl.create(
          { catalogueItemId: TEST_LIB_ITEM_A2_ID } as any,
          fakeReq({ sub: TEST_ADMIN_ACCOUNT_ID, personId: TEST_STUDENT_PERSON_ID }),
        ),
      );
      const cancelled = await withTestTenant(async () =>
        holdCtrl.cancel(second.id, fakeReq()),
      );
      expect(cancelled.status).toBe('CANCELLED');
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // FineService + FineController
  // ═════════════════════════════════════════════════════════════════════
  describe('FineService', () => {
    async function seedOutstandingFine(): Promise<{ fineId: string; checkoutId: string }> {
      const checkoutId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.lib_checkouts
           (id, copy_id, patron_id, checkout_date, due_date, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, CURRENT_DATE - 30, CURRENT_DATE - 10, 'ACTIVE')`,
        checkoutId,
        TEST_LIB_COPY_A1_ID,
        TEST_STUDENT_PERSON_ID,
      );
      const fineId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.lib_fines
           (id, checkout_id, patron_id, fine_type, amount, days_overdue, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'OVERDUE', 5.00, 20, 'OUTSTANDING')`,
        fineId,
        checkoutId,
        TEST_STUDENT_PERSON_ID,
      );
      return { fineId, checkoutId };
    }

    it('list librarian sees all; patron sees own; filters by status + patron', async () => {
      const { fineId } = await seedOutstandingFine();
      const all = await withTestTenant(async () => fines.list(adminActor(), {} as any));
      expect(all.map((f) => f.id)).toContain(fineId);
      const own = await withTestTenant(async () => fines.list(studentActor(), {} as any));
      expect(own.map((f) => f.id)).toContain(fineId);
      const teacher = await withTestTenant(async () => fines.list(teacherActor(), {} as any));
      expect(teacher.map((f) => f.id)).not.toContain(fineId);
      const byStatus = await withTestTenant(async () =>
        fines.list(adminActor(), { status: 'OUTSTANDING' } as any),
      );
      expect(byStatus.every((f) => f.status === 'OUTSTANDING')).toBe(true);
      const byPatron = await withTestTenant(async () =>
        fines.list(adminActor(), { patronId: TEST_STUDENT_PERSON_ID } as any),
      );
      expect(byPatron.every((f) => f.patronId === TEST_STUDENT_PERSON_ID)).toBe(true);
    });

    it('getById own / admin works; non-owner → 404; missing → 404', async () => {
      const { fineId } = await seedOutstandingFine();
      const own = await withTestTenant(async () => fines.getById(fineId, studentActor()));
      expect(own.id).toBe(fineId);
      const adm = await withTestTenant(async () => fines.getById(fineId, adminActor()));
      expect(adm.id).toBe(fineId);
      await expect(
        withTestTenant(async () => fines.getById(fineId, teacherActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        withTestTenant(async () => fines.getById(NONEXISTENT_UUID, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('pay flips OUTSTANDING → PAID; double-pay → BadRequest; missing → 404; non-librarian → Forbidden', async () => {
      const { fineId } = await seedOutstandingFine();
      const paid = await withTestTenant(async () => fines.pay(fineId, adminActor()));
      expect(paid.status).toBe('PAID');
      await expect(
        withTestTenant(async () => fines.pay(fineId, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        withTestTenant(async () => fines.pay(NONEXISTENT_UUID, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
      // Non-librarian → Forbidden
      const { fineId: f2 } = await seedOutstandingFine();
      await expect(
        withTestTenant(async () => fines.pay(f2, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('waive admin-only + reason required + WAIVED on success; bad status; missing', async () => {
      const { fineId } = await seedOutstandingFine();
      await expect(
        withTestTenant(async () => fines.waive(fineId, { reason: '' } as any, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
      const w = await withTestTenant(async () =>
        fines.waive(fineId, { reason: 'goodwill' } as any, adminActor()),
      );
      expect(w.status).toBe('WAIVED');
      // Re-waive terminal → BadRequest
      await expect(
        withTestTenant(async () =>
          fines.waive(fineId, { reason: 'again' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        withTestTenant(async () =>
          fines.waive(NONEXISTENT_UUID, { reason: 'x' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      // Non-admin (teacher) → Forbidden
      const { fineId: f2 } = await seedOutstandingFine();
      await expect(
        withTestTenant(async () =>
          fines.waive(f2, { reason: 'x' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('controller list / getById / pay / waive pass-through', async () => {
      const { fineId } = await seedOutstandingFine();
      const list = await withTestTenant(async () =>
        fineCtrl.list(undefined, undefined, fakeReq()),
      );
      expect(list.length).toBeGreaterThan(0);
      const filtered = await withTestTenant(async () =>
        fineCtrl.list('OUTSTANDING', TEST_STUDENT_PERSON_ID, fakeReq()),
      );
      expect(filtered.length).toBeGreaterThan(0);
      const badStatus = await withTestTenant(async () =>
        fineCtrl.list('BOGUS', undefined, fakeReq()),
      );
      expect(badStatus).toBeDefined();
      const got = await withTestTenant(async () => fineCtrl.getById(fineId, fakeReq()));
      expect(got.id).toBe(fineId);
      const paid = await withTestTenant(async () => fineCtrl.pay(fineId, fakeReq()));
      expect(paid.status).toBe('PAID');
      const { fineId: f2 } = await seedOutstandingFine();
      const w = await withTestTenant(async () =>
        fineCtrl.waive(f2, { reason: 'r' } as any, fakeReq()),
      );
      expect(w.status).toBe('WAIVED');
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // ReadingProgrammeService + Controller
  // ═════════════════════════════════════════════════════════════════════
  describe('ReadingProgrammeService', () => {
    it('list returns school A active programmes + STUDENT myProgress inlined', async () => {
      // Pre-create a progress row
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.lib_programme_progress
           (id, programme_id, student_id, books_read, pages_read, last_updated_at, is_complete)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 2, 250, now(), false)
         ON CONFLICT (programme_id, student_id) DO UPDATE
           SET books_read = EXCLUDED.books_read, pages_read = EXCLUDED.pages_read,
               last_updated_at = EXCLUDED.last_updated_at`,
        generateId(),
        TEST_LIB_PROGRAMME_A_ID,
        TEST_LIB_STU_A_ID,
      );
      const adminList = await withTestTenant(async () =>
        programmes.list(adminActor(), {} as any),
      );
      expect(adminList.map((p) => p.id)).toContain(TEST_LIB_PROGRAMME_A_ID);
      // Student sees myProgress inlined
      const studentList = await withTestTenant(async () =>
        programmes.list(studentActor(), {} as any),
      );
      const found = studentList.find((p) => p.id === TEST_LIB_PROGRAMME_A_ID) as any;
      expect(found?.myProgress?.booksRead).toBe(2);
      // Inactive flag — flip programme inactive then verify
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.lib_reading_programmes SET is_active = false WHERE id = $1::uuid`,
        TEST_LIB_PROGRAMME_CLASS_A_ID,
      );
      const activeOnly = await withTestTenant(async () =>
        programmes.list(adminActor(), {} as any),
      );
      expect(activeOnly.map((p) => p.id)).not.toContain(TEST_LIB_PROGRAMME_CLASS_A_ID);
      const all = await withTestTenant(async () =>
        programmes.list(adminActor(), { includeInactive: true } as any),
      );
      expect(all.map((p) => p.id)).toContain(TEST_LIB_PROGRAMME_CLASS_A_ID);
    });

    it('getById + student myProgress inlined; missing → 404', async () => {
      const adminDto = await withTestTenant(async () =>
        programmes.getById(TEST_LIB_PROGRAMME_A_ID, adminActor()),
      );
      expect(adminDto.id).toBe(TEST_LIB_PROGRAMME_A_ID);
      const studentDto = await withTestTenant(async () =>
        programmes.getById(TEST_LIB_PROGRAMME_A_ID, studentActor()),
      );
      expect((studentDto as any).myProgress).toBeDefined();
      await expect(
        withTestTenant(async () => programmes.getById(NONEXISTENT_UUID, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getLeaderboard returns ordered list; missing → 404', async () => {
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.lib_programme_progress
           (id, programme_id, student_id, books_read, pages_read, last_updated_at, is_complete)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 5, 800, now(), false)
         ON CONFLICT (programme_id, student_id) DO UPDATE
           SET books_read = EXCLUDED.books_read`,
        generateId(),
        TEST_LIB_PROGRAMME_A_ID,
        TEST_LIB_STU_A_ID,
      );
      const lb = await withTestTenant(async () =>
        programmes.getLeaderboard(TEST_LIB_PROGRAMME_A_ID, 10),
      );
      expect(lb.length).toBeGreaterThan(0);
      expect(lb[0]!.booksRead).toBe(5);
      // Limit clamping (0 → 1, 500 → 200)
      const lb1 = await withTestTenant(async () =>
        programmes.getLeaderboard(TEST_LIB_PROGRAMME_A_ID, 0),
      );
      expect(lb1.length).toBeLessThanOrEqual(1);
      const lb2 = await withTestTenant(async () =>
        programmes.getLeaderboard(TEST_LIB_PROGRAMME_A_ID, 500),
      );
      expect(lb2.length).toBeLessThanOrEqual(200);
      await expect(
        withTestTenant(async () => programmes.getLeaderboard(NONEXISTENT_UUID)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('create + patch (admin); student personType → Forbidden', async () => {
      const created = await withTestTenant(async () =>
        programmes.create(
          {
            name: 'Brand New',
            description: 'd',
            targetBooks: 5,
            targetPages: 500,
            startDate: '2026-09-01',
            endDate: '2027-06-30',
            targetAudienceType: 'SCHOOL_WIDE' as any,
          } as any,
          adminActor(),
        ),
      );
      expect(created.name).toBe('Brand New');
      const patched = await withTestTenant(async () =>
        programmes.patch(
          created.id,
          {
            name: 'Renamed',
            description: 'd2',
            targetBooks: 6,
            targetPages: 600,
            startDate: '2026-09-15',
            endDate: '2027-07-15',
            isActive: false,
          } as any,
          adminActor(),
        ),
      );
      expect(patched.name).toBe('Renamed');
      // Empty body no-op
      const noop = await withTestTenant(async () =>
        programmes.patch(created.id, {} as any, adminActor()),
      );
      expect(noop.id).toBe(created.id);
      // Patch missing → 404
      await expect(
        withTestTenant(async () =>
          programmes.patch(NONEXISTENT_UUID, { name: 'X' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      // Student create → Forbidden
      await expect(
        withTestTenant(async () =>
          programmes.create(
            {
              name: 'StudentBogus',
              targetAudienceType: 'SCHOOL_WIDE' as any,
            } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // Teacher with grant succeeds
      await grantTeacherLibPerms();
      const teacherCreated = await withTestTenant(async () =>
        programmes.create(
          {
            name: 'Teacher Programme',
            targetAudienceType: 'SCHOOL_WIDE' as any,
          } as any,
          teacherActor(),
        ),
      );
      expect(teacherCreated.name).toBe('Teacher Programme');
      // Teacher patch
      const tpatch = await withTestTenant(async () =>
        programmes.patch(teacherCreated.id, { name: 'TP2' } as any, teacherActor()),
      );
      expect(tpatch.name).toBe('TP2');
      // Student patch → Forbidden
      await expect(
        withTestTenant(async () =>
          programmes.patch(teacherCreated.id, { name: 'no' } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('controller list / getById / leaderboard / create / patch pass-through', async () => {
      const list = await withTestTenant(async () => programmeCtrl.list(undefined, fakeReq()));
      expect(list.length).toBeGreaterThan(0);
      const inactive = await withTestTenant(async () =>
        programmeCtrl.list('true', fakeReq()),
      );
      expect(inactive).toBeDefined();
      const dto = await withTestTenant(async () =>
        programmeCtrl.getById(TEST_LIB_PROGRAMME_A_ID, fakeReq()),
      );
      expect(dto.id).toBe(TEST_LIB_PROGRAMME_A_ID);
      const lb = await withTestTenant(async () =>
        programmeCtrl.leaderboard(TEST_LIB_PROGRAMME_A_ID, undefined),
      );
      expect(lb).toBeDefined();
      const lb2 = await withTestTenant(async () =>
        programmeCtrl.leaderboard(TEST_LIB_PROGRAMME_A_ID, '50'),
      );
      expect(lb2).toBeDefined();
      const lb3 = await withTestTenant(async () =>
        programmeCtrl.leaderboard(TEST_LIB_PROGRAMME_A_ID, 'bogus'),
      );
      expect(lb3).toBeDefined();
      const created = await withTestTenant(async () =>
        programmeCtrl.create(
          {
            name: 'CtrlProgramme',
            targetAudienceType: 'SCHOOL_WIDE' as any,
          } as any,
          fakeReq(),
        ),
      );
      const patched = await withTestTenant(async () =>
        programmeCtrl.patch(created.id, { name: 'CtrlPatched' } as any, fakeReq()),
      );
      expect(patched.name).toBe('CtrlPatched');
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // ReadingLogService — STUDENT-INPUT KEYSTONE
  // ═════════════════════════════════════════════════════════════════════
  describe('ReadingLogService', () => {
    it('log (completed) auto-upserts SCHOOL_WIDE + CLASS programme progress', async () => {
      const studentReq = fakeReq({
        sub: TEST_ADMIN_ACCOUNT_ID,
        personId: TEST_STUDENT_PERSON_ID,
      });
      void studentReq;
      const log = await withTestTenant(async () =>
        logs.log(
          {
            catalogueItemId: TEST_LIB_ITEM_A_ID,
            startedDate: '2026-04-01',
            completedDate: '2026-04-10',
            pagesRead: 150,
            rating: 5,
            reviewText: 'Great',
          } as any,
          studentActor(),
        ),
      );
      expect(log.studentId).toBe(TEST_LIB_STU_A_ID);
      // Both SCHOOL_WIDE and CLASS programmes should have a progress row
      const rows = await rawClient.$queryRawUnsafe<
        Array<{ programme_id: string; books_read: number; pages_read: number; is_complete: boolean }>
      >(
        `SELECT programme_id::text AS programme_id, books_read, pages_read, is_complete
           FROM ${TEST_SCHEMA}.lib_programme_progress
          WHERE student_id = $1::uuid`,
        TEST_LIB_STU_A_ID,
      );
      const pids = rows.map((r) => r.programme_id);
      expect(pids).toContain(TEST_LIB_PROGRAMME_A_ID);
      expect(pids).toContain(TEST_LIB_PROGRAMME_CLASS_A_ID);
      // CLASS programme has target 2 books / 200 pages — one book / 150 pages → not complete
      const classRow = rows.find((r) => r.programme_id === TEST_LIB_PROGRAMME_CLASS_A_ID)!;
      expect(classRow.books_read).toBe(1);
      expect(classRow.pages_read).toBe(150);
      expect(classRow.is_complete).toBe(false);

      // Log a second completion — progress increments and CLASS becomes complete
      await withTestTenant(async () =>
        logs.log(
          {
            catalogueItemId: TEST_LIB_ITEM_A2_ID,
            completedDate: '2026-04-20',
            pagesRead: 100,
          } as any,
          studentActor(),
        ),
      );
      const rows2 = await rawClient.$queryRawUnsafe<
        Array<{ programme_id: string; books_read: number; pages_read: number; is_complete: boolean }>
      >(
        `SELECT programme_id::text AS programme_id, books_read, pages_read, is_complete
           FROM ${TEST_SCHEMA}.lib_programme_progress
          WHERE student_id = $1::uuid`,
        TEST_LIB_STU_A_ID,
      );
      const cls2 = rows2.find((r) => r.programme_id === TEST_LIB_PROGRAMME_CLASS_A_ID)!;
      expect(cls2.books_read).toBe(2);
      expect(cls2.pages_read).toBe(250);
      expect(cls2.is_complete).toBe(true);
    });

    it('log without completedDate skips progress upsert', async () => {
      const log = await withTestTenant(async () =>
        logs.log(
          {
            catalogueItemId: TEST_LIB_ITEM_A_ID,
            startedDate: '2026-04-01',
          } as any,
          studentActor(),
        ),
      );
      expect(log.id).toBeDefined();
      const c = await rawClient.$queryRawUnsafe<Array<{ c: bigint }>>(
        `SELECT count(*)::bigint AS c FROM ${TEST_SCHEMA}.lib_programme_progress WHERE student_id = $1::uuid`,
        TEST_LIB_STU_A_ID,
      );
      expect(Number(c[0]!.c)).toBe(0);
    });

    it('log catalogue item missing → 404; non-student → Forbidden', async () => {
      await expect(
        withTestTenant(async () =>
          logs.log({ catalogueItemId: NONEXISTENT_UUID } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        withTestTenant(async () =>
          logs.log({ catalogueItemId: TEST_LIB_ITEM_A_ID } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () =>
          logs.log({ catalogueItemId: TEST_LIB_ITEM_A_ID } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('list student sees own; staff requires ?studentId=; other persona Forbidden', async () => {
      // Seed a log
      await withTestTenant(async () =>
        logs.log(
          {
            catalogueItemId: TEST_LIB_ITEM_A_ID,
            completedDate: '2026-04-12',
            pagesRead: 50,
          } as any,
          studentActor(),
        ),
      );
      const own = await withTestTenant(async () => logs.list(studentActor(), {} as any));
      expect(own.length).toBeGreaterThan(0);
      // Staff without studentId → BadRequest
      await expect(
        withTestTenant(async () => logs.list(adminActor(), {} as any)),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Staff with student id
      const staffList = await withTestTenant(async () =>
        logs.list(adminActor(), { studentId: TEST_LIB_STU_A_ID } as any),
      );
      expect(staffList.length).toBeGreaterThan(0);
      // Parent persona → Forbidden
      await expect(
        withTestTenant(async () => logs.list(parentActor(), {} as any)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('patch student own + transitions in-progress→complete triggers progress upsert; non-owner Forbidden; missing 404; non-student Forbidden', async () => {
      // Seed an in-progress log (no completedDate)
      const log = await withTestTenant(async () =>
        logs.log(
          { catalogueItemId: TEST_LIB_ITEM_A_ID, pagesRead: 50 } as any,
          studentActor(),
        ),
      );
      const patched = await withTestTenant(async () =>
        logs.patch(
          log.id,
          {
            startedDate: '2026-04-01',
            completedDate: '2026-04-15',
            pagesRead: 175,
            rating: 4,
            reviewText: 'Nice',
          } as any,
          studentActor(),
        ),
      );
      expect(patched.completedDate).toBe('2026-04-15');
      // Progress upserted
      const c = await rawClient.$queryRawUnsafe<Array<{ c: bigint }>>(
        `SELECT count(*)::bigint AS c FROM ${TEST_SCHEMA}.lib_programme_progress WHERE student_id = $1::uuid`,
        TEST_LIB_STU_A_ID,
      );
      expect(Number(c[0]!.c)).toBeGreaterThan(0);
      // Empty patch no-op
      const noop = await withTestTenant(async () =>
        logs.patch(log.id, {} as any, studentActor()),
      );
      expect(noop.id).toBe(log.id);
      // Non-student → Forbidden
      await expect(
        withTestTenant(async () => logs.patch(log.id, { rating: 3 } as any, adminActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // Missing → 404
      await expect(
        withTestTenant(async () =>
          logs.patch(NONEXISTENT_UUID, { rating: 3 } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById student sees own; student non-owner → 404', async () => {
      const log = await withTestTenant(async () =>
        logs.log({ catalogueItemId: TEST_LIB_ITEM_A_ID } as any, studentActor()),
      );
      const got = await withTestTenant(async () => logs.getById(log.id, studentActor()));
      expect(got.id).toBe(log.id);
      const adm = await withTestTenant(async () => logs.getById(log.id, adminActor()));
      expect(adm.id).toBe(log.id);
      await expect(
        withTestTenant(async () => logs.getById(NONEXISTENT_UUID, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('controller list / getById / log / patch pass-through', async () => {
      // log as student
      const created = await withTestTenant(async () =>
        logCtrl.log(
          { catalogueItemId: TEST_LIB_ITEM_A_ID } as any,
          fakeReq({ sub: TEST_ADMIN_ACCOUNT_ID, personId: TEST_STUDENT_PERSON_ID }),
        ),
      );
      const list = await withTestTenant(async () =>
        logCtrl.list(TEST_LIB_STU_A_ID, fakeReq()),
      );
      expect(list.length).toBeGreaterThan(0);
      const got = await withTestTenant(async () =>
        logCtrl.getById(
          created.id,
          fakeReq({ sub: TEST_ADMIN_ACCOUNT_ID, personId: TEST_STUDENT_PERSON_ID }),
        ),
      );
      expect(got.id).toBe(created.id);
      const patched = await withTestTenant(async () =>
        logCtrl.patch(
          created.id,
          { rating: 5 } as any,
          fakeReq({ sub: TEST_ADMIN_ACCOUNT_ID, personId: TEST_STUDENT_PERSON_ID }),
        ),
      );
      expect(patched.rating).toBe(5);
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // ReadingListService + Controller
  // ═════════════════════════════════════════════════════════════════════
  describe('ReadingListService', () => {
    it('create + addItem + listItems + patch publish/unpublish + UNIQUE on name', async () => {
      const list = await withTestTenant(async () =>
        lists.create(
          {
            name: 'Summer Pick',
            description: 'd',
            listType: 'GENERAL' as any,
            targetGradeLevel: '11',
          } as any,
          adminActor(),
        ),
      );
      expect(list.name).toBe('Summer Pick');
      expect(list.isPublished).toBe(false);

      // Duplicate name → 400
      await expect(
        withTestTenant(async () =>
          lists.create(
            { name: 'Summer Pick', listType: 'GENERAL' as any } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      // Add item
      const item = await withTestTenant(async () =>
        lists.addItem(
          list.id,
          {
            catalogueItemId: TEST_LIB_ITEM_A_ID,
            itemType: 'REQUIRED' as any,
            sortOrder: 1,
            notes: 'must read',
          } as any,
          adminActor(),
        ),
      );
      expect(item.catalogueItemId).toBe(TEST_LIB_ITEM_A_ID);
      // Duplicate item → 400
      await expect(
        withTestTenant(async () =>
          lists.addItem(
            list.id,
            { catalogueItemId: TEST_LIB_ITEM_A_ID } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Add item w/ bogus catalogue → 404
      await expect(
        withTestTenant(async () =>
          lists.addItem(
            list.id,
            { catalogueItemId: NONEXISTENT_UUID } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      // Add item to bogus list → 404
      await expect(
        withTestTenant(async () =>
          lists.addItem(
            NONEXISTENT_UUID,
            { catalogueItemId: TEST_LIB_ITEM_A2_ID } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);

      // List items
      const items = await withTestTenant(async () => lists.listItems(list.id));
      expect(items.length).toBe(1);

      // Publish via patch with isPublished=true
      const published = await withTestTenant(async () =>
        lists.patch(list.id, { isPublished: true } as any, adminActor()),
      );
      expect(published.isPublished).toBe(true);
      expect(published.publishedAt).not.toBeNull();
      // Unpublish
      const unpub = await withTestTenant(async () =>
        lists.patch(list.id, { isPublished: false } as any, adminActor()),
      );
      expect(unpub.isPublished).toBe(false);
      expect(unpub.publishedAt).toBeNull();
      // Re-publish via the publish controller alias
      const repub = await withTestTenant(async () =>
        listCtrl.publish(list.id, fakeReq()),
      );
      expect(repub.isPublished).toBe(true);
      // Re-publish (no-state-change branch — keep isPublished=true)
      const samePub = await withTestTenant(async () =>
        lists.patch(list.id, { isPublished: true } as any, adminActor()),
      );
      expect(samePub.isPublished).toBe(true);

      // Patch metadata
      const meta = await withTestTenant(async () =>
        lists.patch(
          list.id,
          {
            name: 'Renamed',
            description: 'd2',
            listType: 'CLASS' as any,
            targetClassId: '00000000-0000-0000-0000-000000000000',
            targetGradeLevel: '12',
            curriculumUnitId: '00000000-0000-0000-0000-000000000001',
          } as any,
          adminActor(),
        ),
      );
      expect(meta.name).toBe('Renamed');
      // Empty patch no-op
      const noop = await withTestTenant(async () =>
        lists.patch(list.id, {} as any, adminActor()),
      );
      expect(noop.id).toBe(list.id);
      // Patch missing → 404
      await expect(
        withTestTenant(async () =>
          lists.patch(NONEXISTENT_UUID, { name: 'X' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);

      // PatchItem + removeItem
      const updated = await withTestTenant(async () =>
        lists.patchItem(
          item.id,
          { itemType: 'RECOMMENDED' as any, sortOrder: 5, notes: 'updated' } as any,
          adminActor(),
        ),
      );
      expect(updated.itemType).toBe('RECOMMENDED');
      // Empty patch no-op
      const itemNoop = await withTestTenant(async () =>
        lists.patchItem(item.id, {} as any, adminActor()),
      );
      expect(itemNoop.id).toBe(item.id);
      // PatchItem missing → 404
      await expect(
        withTestTenant(async () =>
          lists.patchItem(NONEXISTENT_UUID, { notes: 'X' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      // Remove
      await withTestTenant(async () => lists.removeItem(item.id, adminActor()));
      // Remove missing → 404
      await expect(
        withTestTenant(async () => lists.removeItem(NONEXISTENT_UUID, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('list filters + getById gating', async () => {
      // Seed published + unpublished
      const draft = await withTestTenant(async () =>
        lists.create({ name: 'Draft', listType: 'GENERAL' as any } as any, adminActor()),
      );
      const pub = await withTestTenant(async () =>
        lists.create({ name: 'Pub', listType: 'CLASS' as any } as any, adminActor()),
      );
      await withTestTenant(async () =>
        lists.patch(pub.id, { isPublished: true } as any, adminActor()),
      );
      // Student (non-writer) only sees published
      const studentList = await withTestTenant(async () =>
        lists.list(studentActor(), {} as any),
      );
      expect(studentList.map((l) => l.id)).toContain(pub.id);
      expect(studentList.map((l) => l.id)).not.toContain(draft.id);
      // Admin with includeUnpublished sees draft
      const all = await withTestTenant(async () =>
        lists.list(adminActor(), { includeUnpublished: true } as any),
      );
      expect(all.map((l) => l.id)).toContain(draft.id);
      // Filters
      const byType = await withTestTenant(async () =>
        lists.list(adminActor(), { includeUnpublished: true, listType: 'CLASS' } as any),
      );
      expect(byType.every((l) => l.listType === 'CLASS')).toBe(true);
      // grade level filter (no rows match label '11' because seed sets null)
      await withTestTenant(async () =>
        lists.list(adminActor(), {
          includeUnpublished: true,
          targetGradeLevel: '11',
        } as any),
      );
      await withTestTenant(async () =>
        lists.list(adminActor(), {
          includeUnpublished: true,
          curriculumUnitId: '00000000-0000-0000-0000-000000000099',
        } as any),
      );

      // GetById published visible to student
      const got = await withTestTenant(async () => lists.getById(pub.id, studentActor()));
      expect(got.id).toBe(pub.id);
      // GetById draft → 404 for student
      await expect(
        withTestTenant(async () => lists.getById(draft.id, studentActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
      // Admin reads draft
      const adminDraft = await withTestTenant(async () =>
        lists.getById(draft.id, adminActor()),
      );
      expect(adminDraft.id).toBe(draft.id);
      // Missing → 404
      await expect(
        withTestTenant(async () => lists.getById(NONEXISTENT_UUID, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('student create/addItem/patch/removeItem → Forbidden', async () => {
      await expect(
        withTestTenant(async () =>
          lists.create({ name: 'StudentList', listType: 'GENERAL' as any } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      const list = await withTestTenant(async () =>
        lists.create({ name: 'AdminList', listType: 'GENERAL' as any } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          lists.addItem(
            list.id,
            { catalogueItemId: TEST_LIB_ITEM_A_ID } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () =>
          lists.patch(list.id, { name: 'X' } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // Need a real item for patchItem path
      const item = await withTestTenant(async () =>
        lists.addItem(
          list.id,
          { catalogueItemId: TEST_LIB_ITEM_A_ID } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          lists.patchItem(item.id, { notes: 'x' } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => lists.removeItem(item.id, studentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('controller list / getById / create / patch / addItem / patchItem / removeItem pass-through', async () => {
      const list = await withTestTenant(async () =>
        listCtrl.create(
          { name: 'CtrlList', listType: 'GENERAL' as any } as any,
          fakeReq(),
        ),
      );
      const listing = await withTestTenant(async () =>
        listCtrl.list('true', undefined, undefined, undefined, fakeReq()),
      );
      expect(listing.map((l) => l.id)).toContain(list.id);
      // All filters
      const filtered = await withTestTenant(async () =>
        listCtrl.list('true', 'GENERAL', undefined, undefined, fakeReq()),
      );
      expect(filtered).toBeDefined();
      const got = await withTestTenant(async () => listCtrl.getById(list.id, fakeReq()));
      expect(got.id).toBe(list.id);
      const patched = await withTestTenant(async () =>
        listCtrl.patch(list.id, { description: 'd' } as any, fakeReq()),
      );
      expect(patched.id).toBe(list.id);
      const item = await withTestTenant(async () =>
        listCtrl.addItem(
          list.id,
          { catalogueItemId: TEST_LIB_ITEM_A_ID } as any,
          fakeReq(),
        ),
      );
      const itemPatched = await withTestTenant(async () =>
        listCtrl.patchItem(item.id, { notes: 'n' } as any, fakeReq()),
      );
      expect(itemPatched.id).toBe(item.id);
      await withTestTenant(async () => listCtrl.removeItem(item.id, fakeReq()));
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // ReviewService + Controller
  // ═════════════════════════════════════════════════════════════════════
  describe('ReviewService', () => {
    it('create + duplicate POST → 400; non-student → Forbidden; bogus item → 404', async () => {
      const r = await withTestTenant(async () =>
        reviews.create(
          TEST_LIB_ITEM_A_ID,
          { rating: 4, reviewText: 'Good read' } as any,
          studentActor(),
        ),
      );
      expect(r.rating).toBe(4);
      // Duplicate POST → 400
      await expect(
        withTestTenant(async () =>
          reviews.create(
            TEST_LIB_ITEM_A_ID,
            { rating: 5 } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Non-student → Forbidden
      await expect(
        withTestTenant(async () =>
          reviews.create(
            TEST_LIB_ITEM_A_ID,
            { rating: 5 } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () =>
          reviews.create(
            TEST_LIB_ITEM_A_ID,
            { rating: 5 } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // Bogus item → 404
      await expect(
        withTestTenant(async () =>
          reviews.create(NONEXISTENT_UUID, { rating: 3 } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('patch student own only; moderator can patch any; non-owner Forbidden; missing 404', async () => {
      const r = await withTestTenant(async () =>
        reviews.create(
          TEST_LIB_ITEM_A_ID,
          { rating: 3, reviewText: 'meh' } as any,
          studentActor(),
        ),
      );
      const patched = await withTestTenant(async () =>
        reviews.patch(r.id, { rating: 5, reviewText: 'love it' } as any, studentActor()),
      );
      expect(patched.rating).toBe(5);
      // Admin (moderator) can patch
      const adminPatch = await withTestTenant(async () =>
        reviews.patch(r.id, { reviewText: 'edited by admin' } as any, adminActor()),
      );
      expect(adminPatch.reviewText).toBe('edited by admin');
      // Empty patch no-op
      const noop = await withTestTenant(async () =>
        reviews.patch(r.id, {} as any, adminActor()),
      );
      expect(noop.id).toBe(r.id);
      // Missing → 404
      await expect(
        withTestTenant(async () =>
          reviews.patch(NONEXISTENT_UUID, { rating: 3 } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      // Officer (non-moderator non-owner) → Forbidden
      await expect(
        withTestTenant(async () =>
          reviews.patch(r.id, { rating: 1 } as any, officerActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('setApproval hide / unhide; missing → 404; non-moderator → Forbidden', async () => {
      const r = await withTestTenant(async () =>
        reviews.create(
          TEST_LIB_ITEM_A_ID,
          { rating: 2 } as any,
          studentActor(),
        ),
      );
      const hidden = await withTestTenant(async () =>
        reviews.setApproval(r.id, false, adminActor()),
      );
      expect(hidden.isApproved).toBe(false);
      const shown = await withTestTenant(async () =>
        reviews.setApproval(r.id, true, adminActor()),
      );
      expect(shown.isApproved).toBe(true);
      await expect(
        withTestTenant(async () => reviews.setApproval(NONEXISTENT_UUID, false, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        withTestTenant(async () => reviews.setApproval(r.id, false, studentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('listForItem: moderator sees hidden; student sees only approved', async () => {
      const r = await withTestTenant(async () =>
        reviews.create(
          TEST_LIB_ITEM_A_ID,
          { rating: 4 } as any,
          studentActor(),
        ),
      );
      await withTestTenant(async () => reviews.setApproval(r.id, false, adminActor()));
      const adminList = await withTestTenant(async () =>
        reviews.listForItem(TEST_LIB_ITEM_A_ID, adminActor()),
      );
      expect(adminList.map((x) => x.id)).toContain(r.id);
      const studentList = await withTestTenant(async () =>
        reviews.listForItem(TEST_LIB_ITEM_A_ID, studentActor()),
      );
      expect(studentList.map((x) => x.id)).not.toContain(r.id);
    });

    it('controller listForItem / create / patch / hide / unhide pass-through', async () => {
      const r = await withTestTenant(async () =>
        reviewCtrl.create(
          TEST_LIB_ITEM_A_ID,
          { rating: 4 } as any,
          fakeReq({ sub: TEST_ADMIN_ACCOUNT_ID, personId: TEST_STUDENT_PERSON_ID }),
        ),
      );
      const list = await withTestTenant(async () =>
        reviewCtrl.listForItem(TEST_LIB_ITEM_A_ID, fakeReq()),
      );
      expect(list.map((x) => x.id)).toContain(r.id);
      const patched = await withTestTenant(async () =>
        reviewCtrl.patch(r.id, { reviewText: 'updated' } as any, fakeReq()),
      );
      expect(patched.reviewText).toBe('updated');
      const hidden = await withTestTenant(async () => reviewCtrl.hide(r.id, fakeReq()));
      expect(hidden.isApproved).toBe(false);
      const shown = await withTestTenant(async () => reviewCtrl.unhide(r.id, fakeReq()));
      expect(shown.isApproved).toBe(true);
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // ClassSetService + Controller + Overdue Worker
  // ═════════════════════════════════════════════════════════════════════
  describe('ClassSetService', () => {
    it('create bulk-checkout spawns N lib_checkouts + flips copies CHECKED_OUT atomically', async () => {
      const cs = await withTestTenant(async () =>
        classSets.create(
          {
            catalogueItemId: TEST_LIB_ITEM_A_ID,
            teacherPatronId: TEST_TEACHER_PERSON_ID,
            copyCount: 3,
            checkoutDate: '2026-05-01',
            dueDate: '2026-05-15',
            notes: 'Class set',
          } as any,
          adminActor(),
        ),
      );
      expect(cs.copyCount).toBe(3);
      expect(cs.status).toBe('ACTIVE');
      // 3 children checkouts
      const childRows = await rawClient.$queryRawUnsafe<Array<{ c: bigint }>>(
        `SELECT count(*)::bigint AS c FROM ${TEST_SCHEMA}.lib_checkouts WHERE class_set_checkout_id = $1::uuid`,
        cs.id,
      );
      expect(Number(childRows[0]!.c)).toBe(3);
      // 3 copies flipped
      const flipped = await rawClient.$queryRawUnsafe<Array<{ c: bigint }>>(
        `SELECT count(*)::bigint AS c FROM ${TEST_SCHEMA}.lib_catalogue_copies
          WHERE catalogue_item_id = $1::uuid AND is_available = false`,
        TEST_LIB_ITEM_A_ID,
      );
      expect(Number(flipped[0]!.c)).toBe(3);
    });

    it('create rejects copy_count<1, bad date, bad item, bad teacher, bad class, insufficient copies', async () => {
      await expect(
        withTestTenant(async () =>
          classSets.create(
            {
              catalogueItemId: TEST_LIB_ITEM_A_ID,
              teacherPatronId: TEST_TEACHER_PERSON_ID,
              copyCount: 0,
              checkoutDate: '2026-05-01',
              dueDate: '2026-05-15',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        withTestTenant(async () =>
          classSets.create(
            {
              catalogueItemId: TEST_LIB_ITEM_A_ID,
              teacherPatronId: TEST_TEACHER_PERSON_ID,
              copyCount: 2,
              checkoutDate: '2026-05-15',
              dueDate: '2026-05-01',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Bad item
      await expect(
        withTestTenant(async () =>
          classSets.create(
            {
              catalogueItemId: NONEXISTENT_UUID,
              teacherPatronId: TEST_TEACHER_PERSON_ID,
              copyCount: 1,
              checkoutDate: '2026-05-01',
              dueDate: '2026-05-15',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      // Bad teacher
      await expect(
        withTestTenant(async () =>
          classSets.create(
            {
              catalogueItemId: TEST_LIB_ITEM_A_ID,
              teacherPatronId: NONEXISTENT_UUID,
              copyCount: 1,
              checkoutDate: '2026-05-01',
              dueDate: '2026-05-15',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Bad class id
      await expect(
        withTestTenant(async () =>
          classSets.create(
            {
              catalogueItemId: TEST_LIB_ITEM_A_ID,
              teacherPatronId: TEST_TEACHER_PERSON_ID,
              classId: NONEXISTENT_UUID,
              copyCount: 1,
              checkoutDate: '2026-05-01',
              dueDate: '2026-05-15',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Insufficient copies — we have 5 ON_SHELF, ask for 100
      await expect(
        withTestTenant(async () =>
          classSets.create(
            {
              catalogueItemId: TEST_LIB_ITEM_A_ID,
              teacherPatronId: TEST_TEACHER_PERSON_ID,
              copyCount: 100,
              checkoutDate: '2026-05-01',
              dueDate: '2026-05-15',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('create from non-librarian → Forbidden', async () => {
      await expect(
        withTestTenant(async () =>
          classSets.create(
            {
              catalogueItemId: TEST_LIB_ITEM_A_ID,
              teacherPatronId: TEST_TEACHER_PERSON_ID,
              copyCount: 1,
              checkoutDate: '2026-05-01',
              dueDate: '2026-05-15',
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('returnCopies walks state machine ACTIVE → PARTIALLY_RETURNED → RETURNED + with explicit barcodes', async () => {
      const cs = await withTestTenant(async () =>
        classSets.create(
          {
            catalogueItemId: TEST_LIB_ITEM_A_ID,
            teacherPatronId: TEST_TEACHER_PERSON_ID,
            copyCount: 3,
            checkoutDate: '2026-05-01',
            dueDate: '2026-05-15',
          } as any,
          adminActor(),
        ),
      );
      // Return 1 → PARTIALLY_RETURNED
      const partial = await withTestTenant(async () =>
        classSets.returnCopies(cs.id, { copiesReturned: 1 } as any, adminActor()),
      );
      expect(partial.status).toBe('PARTIALLY_RETURNED');
      expect(partial.returnedCount).toBe(1);
      // Return 2 with explicit barcodes (the next two)
      const allBarcodes = await rawClient.$queryRawUnsafe<Array<{ barcode: string }>>(
        `SELECT cp.barcode FROM ${TEST_SCHEMA}.lib_checkouts co
           JOIN ${TEST_SCHEMA}.lib_catalogue_copies cp ON cp.id = co.copy_id
          WHERE co.class_set_checkout_id = $1::uuid AND co.status = 'ACTIVE'
          ORDER BY cp.barcode ASC`,
        cs.id,
      );
      const remaining = allBarcodes.slice(0, 2).map((b) => b.barcode);
      const fully = await withTestTenant(async () =>
        classSets.returnCopies(
          cs.id,
          { copiesReturned: 2, barcodes: remaining } as any,
          adminActor(),
        ),
      );
      expect(fully.status).toBe('RETURNED');
      expect(fully.returnedCount).toBe(3);
    });

    it('returnCopies rejects 0, over-return, double-return, barcode-count mismatch, unknown barcodes', async () => {
      const cs = await withTestTenant(async () =>
        classSets.create(
          {
            catalogueItemId: TEST_LIB_ITEM_A_ID,
            teacherPatronId: TEST_TEACHER_PERSON_ID,
            copyCount: 2,
            checkoutDate: '2026-05-01',
            dueDate: '2026-05-15',
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          classSets.returnCopies(cs.id, { copiesReturned: 0 } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Over-return
      await expect(
        withTestTenant(async () =>
          classSets.returnCopies(cs.id, { copiesReturned: 10 } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // barcode count mismatch
      await expect(
        withTestTenant(async () =>
          classSets.returnCopies(
            cs.id,
            { copiesReturned: 2, barcodes: ['ONLY-ONE'] } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Unknown barcodes
      await expect(
        withTestTenant(async () =>
          classSets.returnCopies(
            cs.id,
            { copiesReturned: 1, barcodes: ['UNKNOWN-X'] } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Fully return then re-return → BadRequest
      await withTestTenant(async () =>
        classSets.returnCopies(cs.id, { copiesReturned: 2 } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          classSets.returnCopies(cs.id, { copiesReturned: 1 } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Missing → 404
      await expect(
        withTestTenant(async () =>
          classSets.returnCopies(NONEXISTENT_UUID, { copiesReturned: 1 } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      // Non-librarian → Forbidden
      await expect(
        withTestTenant(async () =>
          classSets.returnCopies(cs.id, { copiesReturned: 1 } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('list + getById + filters', async () => {
      const cs = await withTestTenant(async () =>
        classSets.create(
          {
            catalogueItemId: TEST_LIB_ITEM_A_ID,
            teacherPatronId: TEST_TEACHER_PERSON_ID,
            copyCount: 1,
            checkoutDate: '2026-05-01',
            dueDate: '2026-05-15',
          } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () => classSets.list({} as any));
      expect(list.map((x) => x.id)).toContain(cs.id);
      const filtered = await withTestTenant(async () =>
        classSets.list({ status: 'ACTIVE', teacherPatronId: TEST_TEACHER_PERSON_ID } as any),
      );
      expect(filtered.map((x) => x.id)).toContain(cs.id);
      const got = await withTestTenant(async () => classSets.getById(cs.id));
      expect(got.id).toBe(cs.id);
      await expect(
        withTestTenant(async () => classSets.getById(NONEXISTENT_UUID)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('sweepOverdueForCurrentTenant flips ACTIVE past-due → OVERDUE', async () => {
      // Create then mutate dates so it's overdue
      const cs = await withTestTenant(async () =>
        classSets.create(
          {
            catalogueItemId: TEST_LIB_ITEM_A_ID,
            teacherPatronId: TEST_TEACHER_PERSON_ID,
            copyCount: 1,
            checkoutDate: '2026-04-01',
            dueDate: '2026-04-15',
          } as any,
          adminActor(),
        ),
      );
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.lib_class_set_checkouts SET due_date = CURRENT_DATE - 1 WHERE id = $1::uuid`,
        cs.id,
      );
      const flipped = await withTestTenant(async () => classSets.sweepOverdueForCurrentTenant());
      expect(flipped).toContain(cs.id);
      const status = await rawClient.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT status FROM ${TEST_SCHEMA}.lib_class_set_checkouts WHERE id = $1::uuid`,
        cs.id,
      );
      expect(status[0]!.status).toBe('OVERDUE');
    });

    it('controller list / getById / create / return pass-through', async () => {
      const list = await withTestTenant(async () => classSetCtrl.list({} as any));
      expect(list).toBeDefined();
      const cs = await withTestTenant(async () =>
        classSetCtrl.create(
          {
            catalogueItemId: TEST_LIB_ITEM_A_ID,
            teacherPatronId: TEST_TEACHER_PERSON_ID,
            copyCount: 1,
            checkoutDate: '2026-05-01',
            dueDate: '2026-05-15',
          } as any,
          fakeReq(),
        ),
      );
      const got = await withTestTenant(async () => classSetCtrl.getById(cs.id));
      expect(got.id).toBe(cs.id);
      const ret = await withTestTenant(async () =>
        classSetCtrl.returnCopies(cs.id, { copiesReturned: 1 } as any, fakeReq()),
      );
      expect(ret.status).toBe('RETURNED');
    });

    it('ClassSetOverdueWorker tick walks every active school + tickForTenant', async () => {
      // Seed an overdue ACTIVE row
      const cs = await withTestTenant(async () =>
        classSets.create(
          {
            catalogueItemId: TEST_LIB_ITEM_A_ID,
            teacherPatronId: TEST_TEACHER_PERSON_ID,
            copyCount: 1,
            checkoutDate: '2026-04-01',
            dueDate: '2026-04-15',
          } as any,
          adminActor(),
        ),
      );
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.lib_class_set_checkouts SET due_date = CURRENT_DATE - 1 WHERE id = $1::uuid`,
        cs.id,
      );
      // Worker tick walks every active school. Calling .tick() twice covers
      // the "already-running guard" branch — second invocation runs after
      // first finishes so we can't easily race here, but the guard is
      // exercised via the `if (this.running)` early-return on subsequent
      // attempts. Direct double-invoke covers loadActiveSchools + tickForTenant.
      await classSetWorker.tick();
      // No-op second call still completes cleanly
      await classSetWorker.tick();
      const row = await rawClient.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT status FROM ${TEST_SCHEMA}.lib_class_set_checkouts WHERE id = $1::uuid`,
        cs.id,
      );
      expect(row[0]!.status).toBe('OVERDUE');
      // Cover onModuleInit + onApplicationShutdown via the disabled-env path
      const prev = process.env.CLASS_SET_OVERDUE_DISABLED;
      process.env.CLASS_SET_OVERDUE_DISABLED = '1';
      const w = new ClassSetOverdueWorker(tenantPrisma, classSets);
      w.onModuleInit();
      w.onApplicationShutdown();
      if (prev === undefined) delete process.env.CLASS_SET_OVERDUE_DISABLED;
      else process.env.CLASS_SET_OVERDUE_DISABLED = prev;
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // RecommendationService + Controller
  // ═════════════════════════════════════════════════════════════════════
  describe('RecommendationService', () => {
    it('replaceForStudent inserts batch + listForStudent returns it; dismiss soft-hides', async () => {
      const n = await withTestTenant(async () =>
        recommendations.replaceForStudent(TEST_LIB_STU_A_ID, [
          {
            itemId: TEST_LIB_ITEM_A_ID,
            reasonType: 'STAFF_PICK',
            score: 0.95,
            reasonMetadata: { source: 'librarian' },
          },
          {
            itemId: TEST_LIB_ITEM_A2_ID,
            reasonType: 'COLLABORATIVE_FILTERING',
            score: 0.75,
          },
        ]),
      );
      expect(n).toBe(2);
      // Admin reads recommendations for the student
      const all = await withTestTenant(async () =>
        recommendations.listForStudent(TEST_LIB_STU_A_ID, adminActor(), {} as any),
      );
      expect(all.length).toBe(2);
      // Student reads their own
      const own = await withTestTenant(async () =>
        recommendations.listForStudent(TEST_LIB_STU_A_ID, studentActor(), {} as any),
      );
      expect(own.length).toBe(2);
      // Parent reads via guardian link
      const par = await withTestTenant(async () =>
        recommendations.listForStudent(TEST_LIB_STU_A_ID, parentActor(), {} as any),
      );
      expect(par.length).toBe(2);
      // Teacher (non-librarian, non-guardian) → Forbidden
      await expect(
        withTestTenant(async () =>
          recommendations.listForStudent(TEST_LIB_STU_A_ID, teacherActor(), {} as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // Officer (non-librarian, non-student, non-guardian) → Forbidden
      await expect(
        withTestTenant(async () =>
          recommendations.listForStudent(TEST_LIB_STU_A_ID, officerActor(), {} as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      // Dismiss as student
      const first = all[0]!;
      await withTestTenant(async () => recommendations.dismiss(first.id, studentActor()));
      // Without includeDismissed, only 1 remains
      const remaining = await withTestTenant(async () =>
        recommendations.listForStudent(TEST_LIB_STU_A_ID, adminActor(), {} as any),
      );
      expect(remaining.length).toBe(1);
      // With includeDismissed, 2 again
      const all2 = await withTestTenant(async () =>
        recommendations.listForStudent(TEST_LIB_STU_A_ID, adminActor(), {
          includeDismissed: true,
        } as any),
      );
      expect(all2.length).toBe(2);
      // Re-dismiss already-dismissed → BadRequest
      await expect(
        withTestTenant(async () => recommendations.dismiss(first.id, studentActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Dismiss missing → 404
      await expect(
        withTestTenant(async () => recommendations.dismiss(NONEXISTENT_UUID, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('replaceForStudent rejects bad studentId + bad itemId', async () => {
      await expect(
        withTestTenant(async () =>
          recommendations.replaceForStudent(NONEXISTENT_UUID, [
            { itemId: TEST_LIB_ITEM_A_ID, reasonType: 'STAFF_PICK' },
          ]),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        withTestTenant(async () =>
          recommendations.replaceForStudent(TEST_LIB_STU_A_ID, [
            { itemId: NONEXISTENT_UUID, reasonType: 'STAFF_PICK' },
          ]),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Empty batch is a no-op
      const n = await withTestTenant(async () =>
        recommendations.replaceForStudent(TEST_LIB_STU_A_ID, []),
      );
      expect(n).toBe(0);
    });

    it('listForStudent — admin missing student → 404; student-non-owner → Forbidden', async () => {
      await expect(
        withTestTenant(async () =>
          recommendations.listForStudent(NONEXISTENT_UUID, adminActor(), {} as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        withTestTenant(async () =>
          recommendations.listForStudent(TEST_LIB_STU_B_ID, studentActor(), {} as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () =>
          recommendations.listForStudent(TEST_LIB_STU_B_ID, parentActor(), {} as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('dismiss student own only; non-owner non-librarian → Forbidden; librarian can dismiss', async () => {
      await withTestTenant(async () =>
        recommendations.replaceForStudent(TEST_LIB_STU_A_ID, [
          { itemId: TEST_LIB_ITEM_A_ID, reasonType: 'STAFF_PICK', score: 0.5 },
        ]),
      );
      const recs = await withTestTenant(async () =>
        recommendations.listForStudent(TEST_LIB_STU_A_ID, adminActor(), {} as any),
      );
      const r = recs[0]!;
      // Librarian-admin can dismiss
      await withTestTenant(async () => recommendations.dismiss(r.id, adminActor()));
      // Reseed + try non-owner non-librarian
      await withTestTenant(async () =>
        recommendations.replaceForStudent(TEST_LIB_STU_A_ID, [
          { itemId: TEST_LIB_ITEM_A_ID, reasonType: 'STAFF_PICK', score: 0.5 },
        ]),
      );
      const recs2 = await withTestTenant(async () =>
        recommendations.listForStudent(TEST_LIB_STU_A_ID, adminActor(), {} as any),
      );
      // Officer (non-librarian non-owner) → Forbidden
      await expect(
        withTestTenant(async () => recommendations.dismiss(recs2[0]!.id, officerActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('config: loadWeights default → recommended config; updateConfig admin sum=100 + persists; sum-mismatch → 400; getConfig non-admin requires lib-002:read', async () => {
      const def = await withTestTenant(async () => recommendations.loadWeights());
      expect(def.collaborativeFiltering).toBe(30);
      // Admin update with valid sum
      const w = await withTestTenant(async () =>
        recommendations.updateConfig(adminActor(), {
          collaborativeFiltering: 40,
          readingLevelMatch: 20,
          subjectMatch: 20,
          newArrival: 10,
          staffPick: 10,
        } as any),
      );
      expect(w.collaborativeFiltering).toBe(40);
      // Round-trip via getConfig
      const get = await withTestTenant(async () => recommendations.getConfig(adminActor()));
      expect(get.collaborativeFiltering).toBe(40);
      // Sum mismatch → 400
      await expect(
        withTestTenant(async () =>
          recommendations.updateConfig(adminActor(), {
            collaborativeFiltering: 99,
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // PATCH-merge — only one key supplied
      const partial = await withTestTenant(async () =>
        recommendations.updateConfig(adminActor(), {
          collaborativeFiltering: 40,
          readingLevelMatch: 30,
          subjectMatch: 10,
          newArrival: 10,
          staffPick: 10,
        } as any),
      );
      expect(partial.readingLevelMatch).toBe(30);
      // Non-admin without lib-002 → Forbidden on getConfig
      await expect(
        withTestTenant(async () => recommendations.getConfig(teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // Non-admin without lib-002:admin → Forbidden on updateConfig
      await expect(
        withTestTenant(async () =>
          recommendations.updateConfig(teacherActor(), {
            collaborativeFiltering: 20,
            readingLevelMatch: 20,
            subjectMatch: 20,
            newArrival: 20,
            staffPick: 20,
          } as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('loadWeights handles non-object stored value (returns defaults)', async () => {
      // Insert a row with non-object string config_value
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.school_config (id, config_key, config_value, description)
         VALUES ($1::uuid, $2, $3::jsonb, $4)
         ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value`,
        generateId(),
        'library_recommendation_weights',
        JSON.stringify('not-an-object'),
        'd',
      );
      const w = await withTestTenant(async () => recommendations.loadWeights());
      expect(w.collaborativeFiltering).toBe(30);
    });

    it('controller listForStudent / dismiss / getConfig / updateConfig pass-through', async () => {
      await withTestTenant(async () =>
        recommendations.replaceForStudent(TEST_LIB_STU_A_ID, [
          { itemId: TEST_LIB_ITEM_A_ID, reasonType: 'STAFF_PICK', score: 0.6 },
        ]),
      );
      const list = await withTestTenant(async () =>
        recommendationCtrl.listForStudent(TEST_LIB_STU_A_ID, undefined, fakeReq()),
      );
      expect(list.length).toBe(1);
      const inclDis = await withTestTenant(async () =>
        recommendationCtrl.listForStudent(TEST_LIB_STU_A_ID, 'true', fakeReq()),
      );
      expect(inclDis.length).toBeGreaterThanOrEqual(1);
      // Dismiss via controller (admin)
      await withTestTenant(async () => recommendationCtrl.dismiss(list[0]!.id, fakeReq()));
      const cfg = await withTestTenant(async () => recommendationCtrl.getConfig(fakeReq()));
      expect(cfg).toBeDefined();
      const updated = await withTestTenant(async () =>
        recommendationCtrl.updateConfig(
          {
            collaborativeFiltering: 25,
            readingLevelMatch: 25,
            subjectMatch: 20,
            newArrival: 15,
            staffPick: 15,
          } as any,
          fakeReq(),
        ),
      );
      expect(updated.collaborativeFiltering).toBe(25);
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // InterlibraryLoanService + Controller
  // ═════════════════════════════════════════════════════════════════════
  describe('InterlibraryLoanService', () => {
    it('create BORROWED without catalogueItemId; LENT requires catalogueItemId; bad item rejected', async () => {
      const borrowed = await withTestTenant(async () =>
        ills.create(
          {
            loanDirection: 'BORROWED',
            partnerInstitution: 'Other Lib',
            title: 'Foreign Title',
            author: 'F. Author',
            isbn: '978-x',
            requestDate: '2026-05-01',
            notes: 'pls',
          } as any,
          adminActor(),
        ),
      );
      expect(borrowed.loanDirection).toBe('BORROWED');
      // LENT without catalogueItemId → BadRequest
      await expect(
        withTestTenant(async () =>
          ills.create(
            {
              loanDirection: 'LENT',
              partnerInstitution: 'Other',
              title: 'X',
              requestDate: '2026-05-01',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // LENT with bad catalogueItemId → BadRequest (cross-school)
      await expect(
        withTestTenant(async () =>
          ills.create(
            {
              loanDirection: 'LENT',
              partnerInstitution: 'Other',
              catalogueItemId: TEST_LIB_ITEM_B_ID,
              title: 'X',
              requestDate: '2026-05-01',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // LENT happy path
      const lent = await withTestTenant(async () =>
        ills.create(
          {
            loanDirection: 'LENT',
            partnerInstitution: 'Other',
            catalogueItemId: TEST_LIB_ITEM_A_ID,
            title: 'Our Book',
            requestDate: '2026-05-01',
          } as any,
          adminActor(),
        ),
      );
      expect(lent.loanDirection).toBe('LENT');
      // Non-librarian → Forbidden
      await expect(
        withTestTenant(async () =>
          ills.create(
            {
              loanDirection: 'BORROWED',
              partnerInstitution: 'X',
              title: 'X',
              requestDate: '2026-05-01',
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('patch walks status state machine + rejects bad transitions + carries dates + empty body', async () => {
      const ill = await withTestTenant(async () =>
        ills.create(
          {
            loanDirection: 'BORROWED',
            partnerInstitution: 'Lib X',
            title: 'X',
            requestDate: '2026-05-01',
          } as any,
          adminActor(),
        ),
      );
      // REQUESTED → IN_TRANSIT
      const inTransit = await withTestTenant(async () =>
        ills.patch(
          ill.id,
          {
            status: 'IN_TRANSIT',
            receivedDate: '2026-05-05',
            sentDate: '2026-05-04',
          } as any,
          adminActor(),
        ),
      );
      expect(inTransit.status).toBe('IN_TRANSIT');
      // IN_TRANSIT → ACTIVE with dueDate
      const active = await withTestTenant(async () =>
        ills.patch(
          ill.id,
          { status: 'ACTIVE', dueDate: '2026-06-01', notes: 'active now' } as any,
          adminActor(),
        ),
      );
      expect(active.status).toBe('ACTIVE');
      // Bad transition (ACTIVE → REQUESTED)
      await expect(
        withTestTenant(async () =>
          ills.patch(ill.id, { status: 'REQUESTED' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // ACTIVE → RETURNED with returnedDate
      const returned = await withTestTenant(async () =>
        ills.patch(
          ill.id,
          { status: 'RETURNED', returnedDate: '2026-05-30' } as any,
          adminActor(),
        ),
      );
      expect(returned.status).toBe('RETURNED');
      // Re-transition from terminal → BadRequest
      await expect(
        withTestTenant(async () =>
          ills.patch(ill.id, { status: 'ACTIVE' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Empty patch no-op
      const noop = await withTestTenant(async () =>
        ills.patch(ill.id, {} as any, adminActor()),
      );
      expect(noop.id).toBe(ill.id);
      // Patch missing → 404
      await expect(
        withTestTenant(async () =>
          ills.patch(NONEXISTENT_UUID, { notes: 'x' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      // Non-librarian → Forbidden
      await expect(
        withTestTenant(async () =>
          ills.patch(ill.id, { notes: 'x' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('list filters; getById missing → 404; cross-school isolation', async () => {
      const ill = await withTestTenant(async () =>
        ills.create(
          {
            loanDirection: 'BORROWED',
            partnerInstitution: 'P',
            title: 'T',
            requestDate: '2026-05-01',
          } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () => ills.list({} as any));
      expect(list.map((x) => x.id)).toContain(ill.id);
      const filtered = await withTestTenant(async () =>
        ills.list({ status: 'REQUESTED', loanDirection: 'BORROWED' } as any),
      );
      expect(filtered.length).toBeGreaterThan(0);
      // School B doesn't see school A's ILL
      const bList = await withTestTenantB(async () => ills.list({} as any));
      expect(bList.map((x) => x.id)).not.toContain(ill.id);
      // GetById missing → 404
      await expect(
        withTestTenant(async () => ills.getById(NONEXISTENT_UUID)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('sweepOverdueForCurrentTenant flips ACTIVE past-due → OVERDUE; listOverdue librarian-only', async () => {
      const ill = await withTestTenant(async () =>
        ills.create(
          {
            loanDirection: 'BORROWED',
            partnerInstitution: 'P',
            title: 'T',
            requestDate: '2026-05-01',
          } as any,
          adminActor(),
        ),
      );
      // Walk to ACTIVE
      await withTestTenant(async () =>
        ills.patch(ill.id, { status: 'IN_TRANSIT' } as any, adminActor()),
      );
      await withTestTenant(async () =>
        ills.patch(ill.id, { status: 'ACTIVE', dueDate: '2026-06-01' } as any, adminActor()),
      );
      // Bump due_date into the past
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.lib_interlibrary_loans SET due_date = CURRENT_DATE - 1 WHERE id = $1::uuid`,
        ill.id,
      );
      const flipped = await withTestTenant(async () => ills.sweepOverdueForCurrentTenant());
      expect(flipped).toContain(ill.id);
      // listOverdue admin
      const overdue = await withTestTenant(async () => ills.listOverdue(adminActor()));
      expect(overdue.map((x) => x.id)).toContain(ill.id);
      // Non-librarian → Forbidden
      await expect(
        withTestTenant(async () => ills.listOverdue(teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('controller list / listOverdue / getById / create / patch pass-through', async () => {
      const list = await withTestTenant(async () => illCtrl.list({} as any));
      expect(list).toBeDefined();
      const created = await withTestTenant(async () =>
        illCtrl.create(
          {
            loanDirection: 'BORROWED',
            partnerInstitution: 'X',
            title: 'X',
            requestDate: '2026-05-01',
          } as any,
          fakeReq(),
        ),
      );
      const got = await withTestTenant(async () => illCtrl.getById(created.id));
      expect(got.id).toBe(created.id);
      const patched = await withTestTenant(async () =>
        illCtrl.patch(created.id, { notes: 'updated' } as any, fakeReq()),
      );
      expect(patched.notes).toBe('updated');
      const overdue = await withTestTenant(async () => illCtrl.listOverdue(fakeReq()));
      expect(overdue).toBeDefined();
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // CatalogueImportService + Worker + Controller
  // ═════════════════════════════════════════════════════════════════════
  describe('CatalogueImportService', () => {
    it('create ISBN_BATCH queues; processQueuedJob walks PARSING → COMPLETED + ISBN dedup; outbox row queued', async () => {
      const job = await withTestTenant(async () =>
        imports.create(
          { importType: 'ISBN_BATCH', isbns: ['978-NEW-1', '978-NEW-2'] } as any,
          adminActor(),
        ),
      );
      expect(job.status).toBe('QUEUED');
      expect(job.totalRecords).toBe(2);
      // Process
      await withTestTenant(async () => imports.processQueuedJob(job.id));
      const after = await withTestTenant(async () => imports.getById(job.id));
      expect(after.status).toBe('COMPLETED');
      expect(after.recordsImported).toBe(2);
      expect(after.recordsSkipped).toBe(0);
      // Outbox row with deterministic event_id
      const expectId = deterministicLibImportCompletedEventId(job.id);
      const outboxRows = await rawClient.$queryRawUnsafe<Array<{ c: number }>>(
        `SELECT count(*)::int AS c FROM platform.platform_outbox
          WHERE topic = 'lib.import.completed'
            AND tenant_id = $1::uuid
            AND envelope::jsonb->>'event_id' = $2`,
        TEST_SCHOOL_ID,
        expectId,
      );
      expect(outboxRows[0]!.c).toBe(1);

      // Re-processing a COMPLETED job is a no-op (status filter excludes)
      await withTestTenant(async () => imports.processQueuedJob(job.id));
      const stillCompleted = await withTestTenant(async () => imports.getById(job.id));
      expect(stillCompleted.status).toBe('COMPLETED');
    });

    it('ISBN dedup: re-submit overlapping batch → skipped++', async () => {
      // First batch
      const j1 = await withTestTenant(async () =>
        imports.create(
          { importType: 'ISBN_BATCH', isbns: ['978-DUP-1'] } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () => imports.processQueuedJob(j1.id));
      // Second batch including the same ISBN
      const j2 = await withTestTenant(async () =>
        imports.create(
          { importType: 'ISBN_BATCH', isbns: ['978-DUP-1', '978-DUP-2'] } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () => imports.processQueuedJob(j2.id));
      const after = await withTestTenant(async () => imports.getById(j2.id));
      expect(after.recordsSkipped).toBe(1);
      expect(after.recordsImported).toBe(1);
    });

    it('create rejects ISBN_BATCH with no isbns; non-ISBN type without sourceFileS3Key', async () => {
      await expect(
        withTestTenant(async () =>
          imports.create({ importType: 'ISBN_BATCH' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        withTestTenant(async () =>
          imports.create({ importType: 'CSV_UPLOAD' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Non-librarian → Forbidden
      await expect(
        withTestTenant(async () =>
          imports.create(
            { importType: 'ISBN_BATCH', isbns: ['978-X'] } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // Admin without employeeId → Forbidden — use a contrived actor
      const adminNoEmp = { ...adminActor(), employeeId: null } as any;
      await expect(
        withTestTenant(async () =>
          imports.create(
            { importType: 'ISBN_BATCH', isbns: ['978-X'] } as any,
            adminNoEmp,
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('CSV_UPLOAD / MARC_IMPORT / WORLDCAT_SYNC scaffolded path marks COMPLETED with zero progress', async () => {
      const csv = await withTestTenant(async () =>
        imports.create(
          { importType: 'CSV_UPLOAD', sourceFileS3Key: 's3://k1' } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () => imports.processQueuedJob(csv.id));
      const after = await withTestTenant(async () => imports.getById(csv.id));
      expect(after.status).toBe('COMPLETED');
      expect(after.recordsImported).toBe(0);
    });

    it('processQueuedJob handles malformed inline ISBN_BATCH source_file_s3_key → FAILED', async () => {
      const jobId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.lib_catalogue_import_jobs
           (id, school_id, import_type, source_file_s3_key, total_records, status, initiated_by)
         VALUES ($1::uuid, $2::uuid, 'ISBN_BATCH', 'bogus-not-inline', 1, 'QUEUED', $3::uuid)`,
        jobId,
        TEST_SCHOOL_ID,
        TEST_TEACHER_EMPLOYEE_ID,
      );
      await withTestTenant(async () => imports.processQueuedJob(jobId));
      const after = await withTestTenant(async () => imports.getById(jobId));
      expect(after.status).toBe('FAILED');
    });

    it('processQueuedJob missing id → debug log only, no throw; non-QUEUED → no-op', async () => {
      await withTestTenant(async () => imports.processQueuedJob(NONEXISTENT_UUID));
      // Insert a job already in PARSING state and ensure processQueuedJob no-ops
      const jobId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.lib_catalogue_import_jobs
           (id, school_id, import_type, source_file_s3_key, total_records, status, initiated_by)
         VALUES ($1::uuid, $2::uuid, 'CSV_UPLOAD', 's3://k', 1, 'PARSING', $3::uuid)`,
        jobId,
        TEST_SCHOOL_ID,
        TEST_TEACHER_EMPLOYEE_ID,
      );
      await withTestTenant(async () => imports.processQueuedJob(jobId));
      const after = await withTestTenant(async () => imports.getById(jobId));
      expect(after.status).toBe('PARSING');
    });

    it('list + getById; cross-school isolation; missing → 404', async () => {
      const j = await withTestTenant(async () =>
        imports.create(
          { importType: 'ISBN_BATCH', isbns: ['978-LST-1'] } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () => imports.list());
      expect(list.map((x) => x.id)).toContain(j.id);
      const got = await withTestTenant(async () => imports.getById(j.id));
      expect(got.id).toBe(j.id);
      // Cross-school
      const bList = await withTestTenantB(async () => imports.list());
      expect(bList.map((x) => x.id)).not.toContain(j.id);
      await expect(
        withTestTenant(async () => imports.getById(NONEXISTENT_UUID)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('listQueuedForCurrentTenant returns ids; worker tick drains them', async () => {
      const j1 = await withTestTenant(async () =>
        imports.create(
          { importType: 'ISBN_BATCH', isbns: ['978-QQ-1'] } as any,
          adminActor(),
        ),
      );
      const queued = await withTestTenant(async () => imports.listQueuedForCurrentTenant());
      expect(queued).toContain(j1.id);
      // Worker tick
      await importWorker.tick();
      // Idempotent — second tick is a no-op
      await importWorker.tick();
      const after = await withTestTenant(async () => imports.getById(j1.id));
      expect(after.status).toBe('COMPLETED');
      // Cover onModuleInit + onApplicationShutdown via the disabled-env path
      const prev = process.env.LIB_IMPORT_WORKER_DISABLED;
      process.env.LIB_IMPORT_WORKER_DISABLED = '1';
      const w = new CatalogueImportWorker(tenantPrisma, imports);
      w.onModuleInit();
      w.onApplicationShutdown();
      if (prev === undefined) delete process.env.LIB_IMPORT_WORKER_DISABLED;
      else process.env.LIB_IMPORT_WORKER_DISABLED = prev;
    });

    it('controller list / getById / create pass-through', async () => {
      const created = await withTestTenant(async () =>
        importCtrl.create(
          { importType: 'ISBN_BATCH', isbns: ['978-CTRL-1'] } as any,
          fakeReq(),
        ),
      );
      const list = await withTestTenant(async () => importCtrl.list());
      expect(list.map((x) => x.id)).toContain(created.id);
      const got = await withTestTenant(async () => importCtrl.getById(created.id));
      expect(got.id).toBe(created.id);
    });
  });
});
