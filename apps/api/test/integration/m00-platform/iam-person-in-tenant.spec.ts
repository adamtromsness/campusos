import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import {
  assertPersonInTenant,
  assertAccountInTenant,
} from '@modules/m00-platform/iam/person-in-tenant';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import type { RedisService } from '@shared/cache';

import { withTestTenant, TEST_SCHOOL_ID, TEST_SCHEMA } from '../helpers/tenant-context';
import { TEST_ADMIN_ACCOUNT_ID } from '../helpers/actor';

/**
 * Covers iam/person-in-tenant.ts (was 0%) and the Redis-cache branches
 * of PermissionCheckService that the bare permission-resolution spec
 * left uncovered (lines 50-65, 110).
 */
describe('integration:m00-platform/iam-person-in-tenant', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  const createdPersonIds: string[] = [];
  const createdPlatformStudentIds: string[] = [];
  const createdStudentIds: string[] = [];
  const createdGuardianIds: string[] = [];
  const createdEmployeeIds: string[] = [];

  beforeEach(async () => {
    if (createdStudentIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE id = ANY($1::uuid[])`,
        createdStudentIds.splice(0),
      );
    }
    if (createdGuardianIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sis_guardians WHERE id = ANY($1::uuid[])`,
        createdGuardianIds.splice(0),
      );
    }
    if (createdEmployeeIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.hr_employees WHERE id = ANY($1::uuid[])`,
        createdEmployeeIds.splice(0),
      );
    }
    if (createdPlatformStudentIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.platform_students WHERE id = ANY($1::uuid[])`,
        createdPlatformStudentIds.splice(0),
      );
    }
    if (createdPersonIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.iam_person WHERE id = ANY($1::uuid[])`,
        createdPersonIds.splice(0),
      );
    }
  });

  async function seedPerson(): Promise<string> {
    const personId = generateId();
    createdPersonIds.push(personId);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
       VALUES ($1::uuid, 'PIT-Person', $2, 'STAFF', true)`,
      personId,
      'T-' + personId.slice(-6),
    );
    return personId;
  }

  // ─── assertPersonInTenant ──────────────────────────────────

  describe('assertPersonInTenant', () => {
    it('resolves via sis_students projection', async () => {
      const personId = await seedPerson();
      const psId = generateId();
      const studentId = generateId();
      createdPlatformStudentIds.push(psId);
      createdStudentIds.push(studentId);
      const suffix = generateId().slice(-8);
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
         VALUES ($1::uuid, $2::uuid, 'PIT', 'Stu', true)`,
        psId,
        personId,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_students
           (id, school_id, platform_student_id, student_number, grade_level)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '5')`,
        studentId,
        TEST_SCHOOL_ID,
        psId,
        'PIT-' + suffix,
      );
      await expect(
        withTestTenant(async () => assertPersonInTenant(tenantPrisma, personId, 'testField')),
      ).resolves.toBeUndefined();
    });

    it('resolves via sis_guardians projection', async () => {
      const personId = await seedPerson();
      const guardianId = generateId();
      createdGuardianIds.push(guardianId);
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_guardians (id, person_id, school_id, relationship)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'PARENT')`,
        guardianId,
        personId,
        TEST_SCHOOL_ID,
      );
      await expect(
        withTestTenant(async () => assertPersonInTenant(tenantPrisma, personId, 'testField')),
      ).resolves.toBeUndefined();
    });

    it('resolves via hr_employees projection', async () => {
      const personId = await seedPerson();
      const employeeId = generateId();
      const accountId = generateId();
      createdEmployeeIds.push(employeeId);
      const suffix = generateId().slice(-8);
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.hr_employees
           (id, school_id, person_id, account_id, employee_number, hire_date,
            employment_type, employment_status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, now()::date,
                 'FULL_TIME', 'ACTIVE')`,
        employeeId,
        TEST_SCHOOL_ID,
        personId,
        accountId,
        'PIT-EMP-' + suffix,
      );
      await expect(
        withTestTenant(async () => assertPersonInTenant(tenantPrisma, personId, 'testField')),
      ).resolves.toBeUndefined();
    });

    it('no projection in this tenant → BadRequestException with field name', async () => {
      const personId = await seedPerson();
      await expect(
        withTestTenant(async () =>
          assertPersonInTenant(tenantPrisma, personId, 'assignedToPersonId'),
        ),
      ).rejects.toThrow(/assignedToPersonId/);
      await expect(
        withTestTenant(async () => assertPersonInTenant(tenantPrisma, personId, 'x')),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─── assertAccountInTenant ─────────────────────────────────

  describe('assertAccountInTenant', () => {
    it('unknown accountId → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          assertAccountInTenant(tenantPrisma, generateId(), 'targetAccountId'),
        ),
      ).rejects.toThrow(/targetAccountId/);
    });

    it('valid account whose person projects in tenant → resolves silently', async () => {
      // Use the seeded admin account — its person_id is also a known
      // platform fixture; the admin person has an hr_employees row in
      // tenant_test under the same school via the employee fixture seed.
      await expect(
        withTestTenant(async () => assertAccountInTenant(tenantPrisma, TEST_ADMIN_ACCOUNT_ID, 'x')),
      ).resolves.toBeUndefined();
    });

    it('valid account whose person has no tenant projection → BadRequestException', async () => {
      // Seed a fresh platform_user backed by a person with no
      // student/guardian/employee row.
      const personId = await seedPerson();
      const accountId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.platform_users
           (id, person_id, email, display_name, account_status, account_type, mfa_enabled)
         VALUES ($1::uuid, $2::uuid, $3, 'No Projection', 'ACTIVE', 'HUMAN', false)`,
        accountId,
        personId,
        'noproj-' + accountId.slice(-6) + '@test',
      );
      try {
        await expect(
          withTestTenant(async () => assertAccountInTenant(tenantPrisma, accountId, 'fieldX')),
        ).rejects.toThrow(/fieldX/);
      } finally {
        await rawClient.$executeRawUnsafe(
          `DELETE FROM platform.platform_users WHERE id = $1::uuid`,
          accountId,
        );
      }
    });
  });

  // ─── PermissionCheckService Redis branches ────────────────

  describe('PermissionCheckService redis cache hit + invalidate', () => {
    let cached: string[] | null = null;
    let setCalls: Array<{ key: string; codes: string[] }> = [];
    const stubRedis: RedisService = {
      cacheGet: async <T>() => cached as T | null,
      cacheSet: async (key: string, codes: unknown) => {
        setCalls.push({ key, codes: codes as string[] });
      },
      cacheInvalidate: async () => {
        cached = null;
      },
    } as unknown as RedisService;

    it('cache HIT short-circuits the DB read', async () => {
      cached = ['cached:read'];
      setCalls = [];
      const svc = new PermissionCheckService(rawClient, stubRedis);
      const codes = await svc.getPermissions(generateId(), generateId());
      expect(codes).toEqual(['cached:read']);
      // No setCalls when cache hit
      expect(setCalls.length).toBe(0);
    });

    it('cache MISS reads DB + writes cache', async () => {
      cached = null;
      setCalls = [];
      const svc = new PermissionCheckService(rawClient, stubRedis);
      await svc.getPermissions(generateId(), generateId());
      // No DB row → empty array cached
      expect(setCalls.length).toBe(1);
      expect(setCalls[0]!.codes).toEqual([]);
    });

    it('invalidate calls redis.cacheInvalidate', async () => {
      cached = ['stale:read'];
      const svc = new PermissionCheckService(rawClient, stubRedis);
      await svc.invalidate(generateId(), generateId());
      expect(cached).toBeNull();
    });

    it('invalidate is a no-op when redis is undefined', async () => {
      const svc = new PermissionCheckService(rawClient);
      // Just verify the early-return branch doesn't throw.
      await expect(svc.invalidate(generateId(), generateId())).resolves.toBeUndefined();
    });
  });
});
