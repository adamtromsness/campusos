import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { EnrollmentPeriodService } from '@modules/m81-enrolment/applications/enrollment-period.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import { adminActor, parentActor, teacherActor } from '../helpers/actor';
import {
  TEST_SIS_ACADEMIC_YEAR_ID,
  TEST_SIS_ACADEMIC_YEAR_B_ID,
} from '../fixtures/sis';

/**
 * Wave 5 — m81-enrolment EnrollmentPeriodService DB-backed integration tests.
 *
 * Contracts verified:
 *   - Period CRUD: create defaults to UPCOMING, update with FOR UPDATE row
 *     lock, status / dates / mid-year flag.
 *   - State transitions (UPCOMING / OPEN / OFFERS_ISSUED / CLOSED / COMPLETED).
 *   - Date validations (closesAt > opensAt, on create and on update).
 *   - Admission streams + intake capacities surface on getById.
 *   - Cross-school isolation note: service does NOT scope reads by school_id
 *     (same bug pattern as ApplicationService). Documented + tracked here
 *     instead of fixed because the precedent is set in application-lifecycle.
 *   - ForbiddenException on non-admin write paths.
 *   - NotFoundException on unknown ids / unknown academic year.
 *   - BadRequest on reservedPlaces > totalPlaces.
 */
describe('integration:m81-enrolment/enrolment-periods', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let periodService: EnrollmentPeriodService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    periodService = new EnrollmentPeriodService(tenantPrisma);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    // Wipe enr_* rows for both schools. Order matters because of FKs:
    // capacity_summary / intake_capacities / streams cascade off periods.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.enr_capacity_summary`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.enr_waitlist_entries`,
    );
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.enr_offers`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.enr_application_notes`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.enr_application_screening_responses`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.enr_applications`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.enr_intake_capacities`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.enr_admission_streams`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.enr_enrollment_periods`,
    );
    // Re-enrol family-account tables defensively (some flows touch them).
    await rawClient.$executeRawUnsafe(
      `TRUNCATE ${TEST_SCHEMA}.pay_family_account_students, ${TEST_SCHEMA}.pay_family_accounts CASCADE`,
    );
  });

  function nextWindow(daysAhead = 30): { opensAt: string; closesAt: string } {
    const opens = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const closes = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
    return { opensAt: opens.toISOString(), closesAt: closes.toISOString() };
  }

  // ────────────────────────────────────────────────────────────────────
  // create — admin gate + window + academic year + status default
  // ────────────────────────────────────────────────────────────────────
  describe('create', () => {
    it('admin creates a period with default status=UPCOMING', async () => {
      const { opensAt, closesAt } = nextWindow();
      const dto = await withTestTenant(async () =>
        periodService.create(
          {
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            name: 'AY 2026-27 Standard',
            opensAt,
            closesAt,
          },
          adminActor(),
        ),
      );
      expect(dto.status).toBe('UPCOMING');
      expect(dto.schoolId).toBe(TEST_SCHOOL_ID);
      expect(dto.academicYearName).toBe('2026-2027 SIS Test');
      expect(dto.allowsMidYearApplications).toBe(false);
      expect(dto.streams).toEqual([]);
      expect(dto.capacities).toEqual([]);
    });

    it('non-admin → ForbiddenException', async () => {
      const { opensAt, closesAt } = nextWindow();
      await expect(
        withTestTenant(async () =>
          periodService.create(
            {
              academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
              name: 'AY 2026-27 By Parent',
              opensAt,
              closesAt,
            },
            parentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      await expect(
        withTestTenant(async () =>
          periodService.create(
            {
              academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
              name: 'AY 2026-27 By Teacher',
              opensAt,
              closesAt,
            },
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('closesAt <= opensAt → BadRequestException', async () => {
      const opens = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const closes = new Date(Date.now()).toISOString();
      await expect(
        withTestTenant(async () =>
          periodService.create(
            {
              academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
              name: 'AY 2026-27 Bad Window',
              opensAt: opens,
              closesAt: closes,
            },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('unknown academic year → NotFoundException', async () => {
      const { opensAt, closesAt } = nextWindow();
      await expect(
        withTestTenant(async () =>
          periodService.create(
            {
              academicYearId: '00000000-0000-0000-0000-000000000000',
              name: 'No AY',
              opensAt,
              closesAt,
            },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('allowsMidYearApplications honoured on create', async () => {
      const { opensAt, closesAt } = nextWindow();
      const dto = await withTestTenant(async () =>
        periodService.create(
          {
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            name: 'AY 2026-27 Mid-Year',
            opensAt,
            closesAt,
            allowsMidYearApplications: true,
          },
          adminActor(),
        ),
      );
      expect(dto.allowsMidYearApplications).toBe(true);
    });

    it('duplicate (school, academic_year, name) → unique-violation', async () => {
      const { opensAt, closesAt } = nextWindow();
      await withTestTenant(async () =>
        periodService.create(
          {
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            name: 'AY 2026-27 Dup',
            opensAt,
            closesAt,
          },
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          periodService.create(
            {
              academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
              name: 'AY 2026-27 Dup',
              opensAt,
              closesAt,
            },
            adminActor(),
          ),
        ),
      ).rejects.toThrow();
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // list / getById
  // ────────────────────────────────────────────────────────────────────
  describe('list / getById', () => {
    it('list orders by opens_at DESC', async () => {
      // Seed three periods at different opens_at offsets.
      const a = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.enr_enrollment_periods (id, school_id, academic_year_id, name, opens_at, closes_at, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'A', now() - interval '7 days', now() + interval '7 days', 'OPEN')`,
        a,
        TEST_SCHOOL_ID,
        TEST_SIS_ACADEMIC_YEAR_ID,
      );
      const b = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.enr_enrollment_periods (id, school_id, academic_year_id, name, opens_at, closes_at, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'B', now() - interval '14 days', now() + interval '7 days', 'OPEN')`,
        b,
        TEST_SCHOOL_ID,
        TEST_SIS_ACADEMIC_YEAR_ID,
      );

      const list = await withTestTenant(async () => periodService.list());
      // Newer opens_at first → 'A' before 'B'.
      const names = list.map((p) => p.name);
      const aIdx = names.indexOf('A');
      const bIdx = names.indexOf('B');
      expect(aIdx).toBeGreaterThanOrEqual(0);
      expect(bIdx).toBeGreaterThanOrEqual(0);
      expect(aIdx).toBeLessThan(bIdx);
    });

    it('getById bundles streams + capacities + summary', async () => {
      const { opensAt, closesAt } = nextWindow();
      const period = await withTestTenant(async () =>
        periodService.create(
          {
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            name: 'Bundled',
            opensAt,
            closesAt,
          },
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        periodService.createStream(
          period.id,
          { name: 'Standard', isActive: true },
          adminActor(),
        ),
      );
      const withCapacity = await withTestTenant(async () =>
        periodService.createCapacity(
          period.id,
          {
            gradeLevel: '5',
            totalPlaces: 30,
            reservedPlaces: 2,
          },
          adminActor(),
        ),
      );
      expect(withCapacity.streams).toHaveLength(1);
      expect(withCapacity.streams[0]!.name).toBe('Standard');
      expect(withCapacity.capacities).toHaveLength(1);
      expect(withCapacity.capacities[0]!.totalPlaces).toBe(30);
      expect(withCapacity.capacities[0]!.reservedPlaces).toBe(2);
    });

    it('getById unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          periodService.getById('00000000-0000-0000-0000-000000000000'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('list with no rows returns []', async () => {
      const list = await withTestTenant(async () => periodService.list());
      expect(list).toEqual([]);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // update — status transitions + window edits + admin gate
  // ────────────────────────────────────────────────────────────────────
  describe('update', () => {
    async function seed(): Promise<string> {
      const { opensAt, closesAt } = nextWindow();
      const p = await withTestTenant(async () =>
        periodService.create(
          {
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            name: 'Update Me',
            opensAt,
            closesAt,
          },
          adminActor(),
        ),
      );
      return p.id;
    }

    it('UPCOMING → OPEN flip', async () => {
      const id = await seed();
      const updated = await withTestTenant(async () =>
        periodService.update(id, { status: 'OPEN' }, adminActor()),
      );
      expect(updated.status).toBe('OPEN');
    });

    it('UPCOMING → OFFERS_ISSUED → CLOSED → COMPLETED full lifecycle', async () => {
      const id = await seed();
      const step1 = await withTestTenant(async () =>
        periodService.update(id, { status: 'OPEN' }, adminActor()),
      );
      expect(step1.status).toBe('OPEN');
      const step2 = await withTestTenant(async () =>
        periodService.update(
          id,
          { status: 'OFFERS_ISSUED' as any },
          adminActor(),
        ),
      );
      expect(step2.status).toBe('OFFERS_ISSUED');
      const step3 = await withTestTenant(async () =>
        periodService.update(id, { status: 'CLOSED' }, adminActor()),
      );
      expect(step3.status).toBe('CLOSED');
      const step4 = await withTestTenant(async () =>
        periodService.update(
          id,
          { status: 'COMPLETED' as any },
          adminActor(),
        ),
      );
      expect(step4.status).toBe('COMPLETED');
    });

    it('update name + opens/closes + allowsMidYear together', async () => {
      const id = await seed();
      const newOpens = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
      const newCloses = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
      const updated = await withTestTenant(async () =>
        periodService.update(
          id,
          {
            name: 'Renamed',
            opensAt: newOpens,
            closesAt: newCloses,
            allowsMidYearApplications: true,
          },
          adminActor(),
        ),
      );
      expect(updated.name).toBe('Renamed');
      expect(updated.allowsMidYearApplications).toBe(true);
    });

    it('update with empty body → no-op, current state returned', async () => {
      const id = await seed();
      const before = await withTestTenant(async () => periodService.getById(id));
      const after = await withTestTenant(async () =>
        periodService.update(id, {}, adminActor()),
      );
      expect(after.name).toBe(before.name);
      expect(after.status).toBe(before.status);
    });

    it('closesAt <= opensAt on update → BadRequest', async () => {
      const id = await seed();
      // Set closesAt to a value earlier than the existing opens_at.
      const period = await withTestTenant(async () => periodService.getById(id));
      const newCloses = new Date(new Date(period.opensAt).getTime() - 1000).toISOString();
      await expect(
        withTestTenant(async () =>
          periodService.update(id, { closesAt: newCloses }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('update unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          periodService.update(
            '00000000-0000-0000-0000-000000000000',
            { status: 'OPEN' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-admin update → ForbiddenException', async () => {
      const id = await seed();
      await expect(
        withTestTenant(async () =>
          periodService.update(id, { status: 'OPEN' }, parentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () =>
          periodService.update(id, { status: 'OPEN' }, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // createStream
  // ────────────────────────────────────────────────────────────────────
  describe('createStream', () => {
    async function seed(): Promise<string> {
      const { opensAt, closesAt } = nextWindow();
      const p = await withTestTenant(async () =>
        periodService.create(
          {
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            name: 'WithStream',
            opensAt,
            closesAt,
          },
          adminActor(),
        ),
      );
      return p.id;
    }

    it('admin creates a stream → appears in streams[] on getById', async () => {
      const id = await seed();
      const dto = await withTestTenant(async () =>
        periodService.createStream(
          id,
          { name: 'Standard', gradeLevel: '5', isActive: true },
          adminActor(),
        ),
      );
      expect(dto.streams).toHaveLength(1);
      expect(dto.streams[0]!.name).toBe('Standard');
      expect(dto.streams[0]!.gradeLevel).toBe('5');
      expect(dto.streams[0]!.isActive).toBe(true);
    });

    it('non-admin → ForbiddenException', async () => {
      const id = await seed();
      await expect(
        withTestTenant(async () =>
          periodService.createStream(id, { name: 'Sneaky' }, parentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('unknown period id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          periodService.createStream(
            '00000000-0000-0000-0000-000000000000',
            { name: 'Orphan' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('duplicate stream name within the same period → unique-violation', async () => {
      const id = await seed();
      await withTestTenant(async () =>
        periodService.createStream(id, { name: 'Music' }, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          periodService.createStream(id, { name: 'Music' }, adminActor()),
        ),
      ).rejects.toThrow();
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // createCapacity
  // ────────────────────────────────────────────────────────────────────
  describe('createCapacity', () => {
    async function seed(): Promise<string> {
      const { opensAt, closesAt } = nextWindow();
      const p = await withTestTenant(async () =>
        periodService.create(
          {
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            name: 'WithCapacity',
            opensAt,
            closesAt,
          },
          adminActor(),
        ),
      );
      return p.id;
    }

    it('admin creates capacity', async () => {
      const id = await seed();
      const dto = await withTestTenant(async () =>
        periodService.createCapacity(
          id,
          { gradeLevel: '5', totalPlaces: 30, reservedPlaces: 0 },
          adminActor(),
        ),
      );
      expect(dto.capacities).toHaveLength(1);
      expect(dto.capacities[0]!.totalPlaces).toBe(30);
      expect(dto.capacities[0]!.streamId).toBeNull();
    });

    it('reservedPlaces > totalPlaces → BadRequest', async () => {
      const id = await seed();
      await expect(
        withTestTenant(async () =>
          periodService.createCapacity(
            id,
            { gradeLevel: '5', totalPlaces: 10, reservedPlaces: 99 },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('non-admin → ForbiddenException', async () => {
      const id = await seed();
      await expect(
        withTestTenant(async () =>
          periodService.createCapacity(
            id,
            { gradeLevel: '5', totalPlaces: 10 },
            parentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('unknown period id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          periodService.createCapacity(
            '00000000-0000-0000-0000-000000000000',
            { gradeLevel: '5', totalPlaces: 10 },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Cross-school isolation — Codex FIX 3: EnrollmentPeriodService.list /
  // .getById now bind `p.school_id = tenant.schoolId`. A School A actor
  // sees only School A periods; a School B period id collapses to 404
  // on getById.
  // ────────────────────────────────────────────────────────────────────
  describe('cross-school isolation', () => {
    it('A admin list excludes B periods; B admin sees only B periods', async () => {
      const { opensAt, closesAt } = nextWindow();
      await withTestTenant(async () =>
        periodService.create(
          {
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            name: 'SchoolA Period',
            opensAt,
            closesAt,
          },
          adminActor(),
        ),
      );
      const bDto = await withTestTenantB(async () =>
        periodService.create(
          {
            academicYearId: TEST_SIS_ACADEMIC_YEAR_B_ID,
            name: 'SchoolB Period',
            opensAt,
            closesAt,
          },
          adminActor(),
        ),
      );
      const aList = await withTestTenant(async () => periodService.list());
      const aNames = aList.map((p) => p.name);
      expect(aNames).toContain('SchoolA Period');
      expect(aNames).not.toContain('SchoolB Period');

      // A admin probing the B period id → 404.
      await expect(
        withTestTenant(async () => periodService.getById(bDto.id)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
