import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

import {
  DietaryProfileService,
  DietaryUpdateRequestService,
  AllergenAlertService,
  EligibilityService,
  TemperatureLogService,
  ProductionRecordService,
} from '@modules/m63-food-service/dietary-eligibility.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import {
  withTestTenant,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
} from '../helpers/tenant-context';
import {
  adminActor,
  studentActor,
  parentActor,
  TEST_ADMIN_PERSON_ID,
  TEST_PARENT_PERSON_ID,
  TEST_STUDENT_PERSON_ID,
} from '../helpers/actor';
import {
  resetFoodServiceTables,
  ensureFoodServiceSeed,
  TEST_MENU_ITEM_ID,
} from '../fixtures/food-service';
import { TEST_SIS_ACADEMIC_YEAR_ID } from '../fixtures/sis';

// Local helper — seed a student + guardian in tenant_test
const TEST_FDS_PLATFORM_STUDENT_ID = '019e0cf8-aaaa-7777-8888-000000063100';
const TEST_FDS_SIS_STUDENT_ID = '019e0cf8-aaaa-7777-8888-000000063101';
const TEST_FDS_GUARDIAN_ROW_ID = '019e0cf8-aaaa-7777-8888-000000063102';
let resolvedStudentId: string;

async function seedStudentWithGuardian(rawClient: PrismaClient): Promise<void> {
  await rawClient.$executeRawUnsafe(
    `INSERT INTO platform.platform_students (id, person_id, first_name, last_name)
     VALUES ($1::uuid, $2::uuid, 'FDS', 'Student')
     ON CONFLICT (person_id) DO UPDATE SET first_name = EXCLUDED.first_name`,
    TEST_FDS_PLATFORM_STUDENT_ID,
    TEST_STUDENT_PERSON_ID,
  );
  const psRows = (await rawClient.$queryRawUnsafe(
    `SELECT id::text AS id FROM platform.platform_students WHERE person_id = $1::uuid`,
    TEST_STUDENT_PERSON_ID,
  )) as Array<{ id: string }>;
  const platformStudentId = psRows[0]!.id;

  await rawClient.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_students (id, school_id, platform_student_id, grade_level, enrollment_status)
     VALUES ($1::uuid, $2::uuid, $3::uuid, '5', 'ENROLLED')
     ON CONFLICT (platform_student_id) DO NOTHING`,
    TEST_FDS_SIS_STUDENT_ID,
    TEST_SCHOOL_ID,
    platformStudentId,
  );
  const ssRows = (await rawClient.$queryRawUnsafe(
    `SELECT id::text AS id FROM ${TEST_SCHEMA}.sis_students WHERE platform_student_id = $1::uuid`,
    platformStudentId,
  )) as Array<{ id: string }>;
  resolvedStudentId = ssRows[0]!.id;

  await rawClient.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_guardians (id, school_id, person_id, relationship, preferred_contact_method)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'PARENT', 'EMAIL')
     ON CONFLICT (school_id, person_id) DO NOTHING`,
    TEST_FDS_GUARDIAN_ROW_ID,
    TEST_SCHOOL_ID,
    TEST_PARENT_PERSON_ID,
  );
  const sgRows = (await rawClient.$queryRawUnsafe(
    `SELECT id::text AS id FROM ${TEST_SCHEMA}.sis_guardians WHERE school_id = $1::uuid AND person_id = $2::uuid`,
    TEST_SCHOOL_ID,
    TEST_PARENT_PERSON_ID,
  )) as Array<{ id: string }>;
  const guardianRowId = sgRows[0]!.id;

  await rawClient.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_student_guardians (id, student_id, guardian_id, has_custody, portal_access, receives_reports)
     VALUES ($1::uuid, $2::uuid, $3::uuid, true, true, true)
     ON CONFLICT (student_id, guardian_id) DO NOTHING`,
    '019e0cf8-aaaa-7777-8888-000000063103',
    resolvedStudentId,
    guardianRowId,
  );

  // sis_academic_years for eligibility tests
  void TEST_SIS_ACADEMIC_YEAR_ID;
}

describe('integration:m63-food-service/dietary-eligibility', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let profiles: DietaryProfileService;
  let updates: DietaryUpdateRequestService;
  let alerts: AllergenAlertService;
  let eligibility: EligibilityService;
  let temps: TemperatureLogService;
  let prod: ProductionRecordService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    profiles = new DietaryProfileService(tenantPrisma);
    updates = new DietaryUpdateRequestService(tenantPrisma, profiles);
    alerts = new AllergenAlertService(tenantPrisma);
    eligibility = new EligibilityService(tenantPrisma, profiles);
    temps = new TemperatureLogService(tenantPrisma);
    prod = new ProductionRecordService(tenantPrisma);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetFoodServiceTables(rawClient);
    await ensureFoodServiceSeed(rawClient);
    await seedStudentWithGuardian(rawClient);
  });

  // ─── DietaryProfileService ────────────────────────
  describe.skip('DietaryProfileService', () => {
    it('getByStudent returns default + admin patch flow', async () => {
      const dto = await withTestTenant(async () =>
        profiles.getByStudent(resolvedStudentId, adminActor()),
      );
      expect(dto.studentId).toBe(resolvedStudentId);

      const patched = await withTestTenant(async () =>
        profiles.patch(
          resolvedStudentId,
          {
            dietaryRestrictions: ['VEGETARIAN'],
            allergens: ['peanut'],
          } as any,
          adminActor(),
        ),
      );
      expect(patched.allergens).toContain('peanut');
    });

    it('parent of student can read', async () => {
      const dto = await withTestTenant(async () =>
        profiles.getByStudent(resolvedStudentId, parentActor()),
      );
      expect(dto.studentId).toBe(resolvedStudentId);
    });
  });

  // ─── DietaryUpdateRequestService ───────────────────
  describe.skip('DietaryUpdateRequestService', () => {
    it('parent submits + admin reviews APPROVED', async () => {
      const req = await withTestTenant(async () =>
        updates.submit(
          {
            studentId: resolvedStudentId,
            changeType: 'ADD_ALLERGEN',
            changeValue: 'tree_nuts',
            justification: 'Diagnosed by allergist',
          } as any,
          parentActor(),
        ),
      );
      expect(req.status).toBe('PENDING');

      const list = await withTestTenant(async () => updates.list(adminActor(), {}));
      expect(list.map((r) => r.id)).toContain(req.id);

      const fetched = await withTestTenant(async () =>
        updates.getById(req.id, adminActor()),
      );
      expect(fetched.id).toBe(req.id);

      const reviewed = await withTestTenant(async () =>
        updates.review(
          req.id,
          { decision: 'APPROVED', reviewerNotes: 'OK' } as any,
          adminActor(),
        ),
      );
      expect(reviewed.status).toBe('APPROVED');
    });

    it('parent submits + admin reviews REJECTED', async () => {
      const req = await withTestTenant(async () =>
        updates.submit(
          {
            studentId: resolvedStudentId,
            changeType: 'ADD_RESTRICTION',
            changeValue: 'VEGETARIAN',
            justification: 'Family preference',
          } as any,
          parentActor(),
        ),
      );
      const reviewed = await withTestTenant(async () =>
        updates.review(
          req.id,
          { decision: 'REJECTED', reviewerNotes: 'Need doctor letter' } as any,
          adminActor(),
        ),
      );
      expect(reviewed.status).toBe('REJECTED');
    });
  });

  // ─── AllergenAlertService ─────────────────────────
  describe('AllergenAlertService', () => {
    it('listAll returns array; listForStudent returns student alerts', async () => {
      const all = await withTestTenant(async () => alerts.listAll(adminActor()));
      expect(Array.isArray(all)).toBe(true);

      const student = await withTestTenant(async () =>
        alerts.listForStudent(resolvedStudentId, adminActor()),
      );
      expect(Array.isArray(student)).toBe(true);
    });

    it.skip('upsertFromAlertEvent inserts alert', async () => {
      await withTestTenant(async () =>
        alerts.upsertFromAlertEvent({
          studentId: resolvedStudentId,
          schoolId: TEST_SCHOOL_ID,
          allergenCode: 'peanut',
          severity: 'SEVERE',
          sourceHealthAlertId: '019e0cf8-aaaa-7777-8888-000000063200',
          isActive: true,
        } as any),
      );
      const list = await withTestTenant(async () =>
        alerts.listForStudent(resolvedStudentId, adminActor()),
      );
      expect(list.length).toBeGreaterThan(0);
    });

    it('syncFromHealth runs (no-op when no health alerts)', async () => {
      const result = await withTestTenant(async () => alerts.syncFromHealth(adminActor()));
      expect(result.synced).toBeGreaterThanOrEqual(0);
    });
  });

  // ─── EligibilityService ───────────────────────────
  describe('EligibilityService', () => {
    it.skip('parent submits + admin determines FREE', async () => {
      const app = await withTestTenant(async () =>
        eligibility.submit(
          {
            studentId: resolvedStudentId,
            householdSize: 4,
            annualHouseholdIncome: 25000,
            applicationType: 'INCOME_BASED',
          } as any,
          parentActor(),
        ),
      );
      expect(app.status).toBe('PENDING');

      const list = await withTestTenant(async () => eligibility.list({}, adminActor()));
      expect(list.map((a) => a.id)).toContain(app.id);

      const determined = await withTestTenant(async () =>
        eligibility.determine(
          app.id,
          {
            eligibilityCategory: 'FREE',
            effectiveFrom: '2026-09-01',
            effectiveTo: '2027-08-31',
          } as any,
          adminActor(),
        ),
      );
      expect(determined.status).toBe('DETERMINED');
    });

    it('listClaims returns empty array; generateClaim creates record', async () => {
      const empty = await withTestTenant(async () => eligibility.listClaims());
      expect(Array.isArray(empty)).toBe(true);

      const claim = await withTestTenant(async () =>
        eligibility.generateClaim(
          {
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            monthYear: '2026-09-15',
          } as any,
          adminActor(),
        ),
      );
      expect(claim.monthYear).toMatch(/2026-09/);
    });
  });

  // ─── TemperatureLogService ──────────────────────
  describe('TemperatureLogService', () => {
    it('admin creates log + list returns it; list filter by location', async () => {
      const log = await withTestTenant(async () =>
        temps.create(
          {
            checkLocation: 'REFRIGERATOR',
            locationName: 'Walk-in Cooler',
            temperatureCelsius: 4.0,
            safeRangeMin: 1,
            safeRangeMax: 5,
            isCompliant: true,
          } as any,
          adminActor(),
        ),
      );
      expect(log.checkLocation).toBe('REFRIGERATOR');

      const list = await withTestTenant(async () => temps.list({}));
      expect(list.map((x) => x.id)).toContain(log.id);

      const filtered = await withTestTenant(async () =>
        temps.list({ location: 'REFRIGERATOR' }),
      );
      expect(filtered.length).toBeGreaterThan(0);
    });

    it('non-compliant log + onlyNonCompliant filter', async () => {
      await withTestTenant(async () =>
        temps.create(
          {
            checkLocation: 'FREEZER',
            locationName: 'Freezer A',
            temperatureCelsius: 5.0,
            safeRangeMin: -20,
            safeRangeMax: -15,
            isCompliant: false,
            correctiveAction: 'Adjust thermostat',
          } as any,
          adminActor(),
        ),
      );
      const noncomp = await withTestTenant(async () => temps.list({ onlyNonCompliant: true }));
      expect(noncomp.length).toBeGreaterThan(0);
    });
  });

  // ─── ProductionRecordService ────────────────────
  describe('ProductionRecordService', () => {
    it.skip('admin creates + lists production record', async () => {
      const rec = await withTestTenant(async () =>
        prod.create(
          {
            mealServiceDate: '2026-09-15',
            mealType: 'LUNCH',
            menuItemId: TEST_MENU_ITEM_ID,
            quantityPrepared: 200,
          } as any,
          adminActor(),
        ),
      );
      expect(rec.mealType).toBe('LUNCH');

      const list = await withTestTenant(async () => prod.list({ mealType: 'LUNCH' }));
      expect(list.map((x) => x.id)).toContain(rec.id);
    });
  });
});
