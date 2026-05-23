import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { PersonaResolutionService } from '@modules/m00-platform/iam/persona-resolution.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import { TEST_SCHOOL_ID, TEST_SCHEMA } from '../helpers/tenant-context';

/**
 * DB-backed integration tests for PersonaResolutionService.
 *
 * The service derives personas from projection tables across every
 * tenant schema, then caches them in platform_personas. The fixtures
 * here seed the canonical inputs (iam_person, platform_families,
 * platform_family_members, platform_family_children, hr_employees,
 * etc.) inside the integration tenant (tenant_test, TEST_SCHOOL_ID)
 * and assert the resolver's output.
 */
describe('integration:m00-platform/persona-resolution', () => {
  let prisma: PrismaClient;
  let tenantPrisma: TenantPrismaService;
  let service: PersonaResolutionService;

  // Stable per-suite IDs. Generated once so cleanup can find them.
  const personId = generateId();
  const accountId = generateId();
  const familyId = generateId();
  const familyMemberId = generateId();
  // Child #1 — LINKED to a real iam_person.
  const childPersonId = generateId();
  const familyChildId = generateId();
  // Child #2 — PLACEHOLDER, no canonical account yet.
  const placeholderChildId = generateId();

  // Auxiliary employee row.
  const employeeId = generateId();

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    tenantPrisma = new TenantPrismaService();
    service = new PersonaResolutionService(prisma, tenantPrisma);

    // The parent person.
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
       VALUES ($1::uuid, 'Persona', 'Resolver', 'GUARDIAN', true)
       ON CONFLICT (id) DO NOTHING`,
      personId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.platform_users (id, person_id, email, display_name, account_status, account_type, mfa_enabled)
       VALUES ($1::uuid, $2::uuid, $3, 'Persona Resolver', 'ACTIVE', 'HUMAN', false)
       ON CONFLICT (id) DO NOTHING`,
      accountId,
      personId,
      'persona-' + personId.slice(-6) + '@test.integration',
    );

    // The linked child person (no platform_users row needed for the
    // PARENT → child relationship, the iam_person is the canonical
    // identity).
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
       VALUES ($1::uuid, 'Linked', 'Child', 'STUDENT', true)
       ON CONFLICT (id) DO NOTHING`,
      childPersonId,
    );

    // Family.
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.platform_families (id, name)
       VALUES ($1::uuid, 'Resolver Family')
       ON CONFLICT (id) DO NOTHING`,
      familyId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.platform_family_members (id, family_id, person_id, member_role)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'PARENT')
       ON CONFLICT (family_id, person_id) DO NOTHING`,
      familyMemberId,
      familyId,
      personId,
    );
  });

  afterAll(async () => {
    // Cleanup is best-effort; integration suite shares the DB and we
    // confine writes to per-suite UUIDs.
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.platform_personas WHERE person_id IN ($1::uuid, $2::uuid)`,
      personId,
      childPersonId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.platform_family_children WHERE family_id = $1::uuid`,
      familyId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.platform_family_members WHERE family_id = $1::uuid`,
      familyId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.platform_families WHERE id = $1::uuid`,
      familyId,
    );
    // tenant cleanup
    await prisma.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.hr_employees WHERE person_id = $1::uuid`,
      personId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.platform_users WHERE id = $1::uuid`,
      accountId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.iam_person WHERE id IN ($1::uuid, $2::uuid)`,
      personId,
      childPersonId,
    );
    await tenantPrisma.onModuleDestroy();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Reset personas + projection rows per test for deterministic state.
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.platform_personas WHERE person_id = $1::uuid`,
      personId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.platform_family_children WHERE family_id = $1::uuid`,
      familyId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.hr_employees WHERE person_id = $1::uuid`,
      personId,
    );
  });

  // ─── resolveForPerson ───────────────────────────────────────

  describe('resolveForPerson', () => {
    it('person with no projections → empty personas', async () => {
      const personas = await service.resolveForPerson(personId);
      expect(personas).toEqual([]);
    });

    it('LINKED child but no school enrolment → PARENT with null schoolId', async () => {
      await prisma.$executeRawUnsafe(
        `INSERT INTO platform.platform_family_children
           (id, family_id, person_id, first_name, last_name, status, linked_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Linked', 'Child', 'LINKED', now())`,
        familyChildId,
        familyId,
        childPersonId,
      );

      const personas = await service.resolveForPerson(personId);
      const parent = personas.find((p) => p.type === 'PARENT');
      expect(parent).toBeTruthy();
      expect(parent!.schoolId).toBeNull();
      expect(parent!.label).toBe('Parent');
    });

    it('PLACEHOLDER child does NOT activate PARENT persona', async () => {
      await prisma.$executeRawUnsafe(
        `INSERT INTO platform.platform_family_children
           (id, family_id, person_id, first_name, last_name, status)
         VALUES ($1::uuid, $2::uuid, NULL, 'Placeholder', 'Child', 'PLACEHOLDER')`,
        placeholderChildId,
        familyId,
      );

      const personas = await service.resolveForPerson(personId);
      expect(personas.find((p) => p.type === 'PARENT')).toBeUndefined();
    });

    it('hr_employees row (ACTIVE) → STAFF persona at that school', async () => {
      await prisma.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.hr_employees
           (id, person_id, account_id, school_id, employment_type, employment_status, hire_date)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'FULL_TIME', 'ACTIVE', '2024-01-01')`,
        employeeId,
        personId,
        accountId,
        TEST_SCHOOL_ID,
      );

      const personas = await service.resolveForPerson(personId);
      const staff = personas.find((p) => p.type === 'STAFF');
      expect(staff).toBeTruthy();
      expect(staff!.schoolId).toBe(TEST_SCHOOL_ID);
    });

    it('TERMINATED hr_employees row → no STAFF persona', async () => {
      await prisma.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.hr_employees
           (id, person_id, account_id, school_id, employment_type, employment_status, hire_date, termination_date)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'FULL_TIME', 'TERMINATED', '2020-01-01', '2024-12-31')`,
        employeeId,
        personId,
        accountId,
        TEST_SCHOOL_ID,
      );

      const personas = await service.resolveForPerson(personId);
      expect(personas.find((p) => p.type === 'STAFF')).toBeUndefined();
    });

    it('returns BOTH STAFF and PARENT when person has both projections', async () => {
      await prisma.$executeRawUnsafe(
        `INSERT INTO platform.platform_family_children
           (id, family_id, person_id, first_name, last_name, status, linked_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Linked', 'Child', 'LINKED', now())`,
        familyChildId,
        familyId,
        childPersonId,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.hr_employees
           (id, person_id, account_id, school_id, employment_type, employment_status, hire_date)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'FULL_TIME', 'ACTIVE', '2024-01-01')`,
        employeeId,
        personId,
        accountId,
        TEST_SCHOOL_ID,
      );

      const personas = await service.resolveForPerson(personId);
      const types = personas.map((p) => p.type).sort();
      expect(types).toContain('STAFF');
      expect(types).toContain('PARENT');
    });
  });

  // ─── refreshPersonaCache ────────────────────────────────────

  describe('refreshPersonaCache', () => {
    it('UPSERTs personas into platform_personas', async () => {
      await prisma.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.hr_employees
           (id, person_id, account_id, school_id, employment_type, employment_status, hire_date)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'FULL_TIME', 'ACTIVE', '2024-01-01')`,
        employeeId,
        personId,
        accountId,
        TEST_SCHOOL_ID,
      );

      await service.refreshPersonaCache(personId);
      const cached = await prisma.platformPersona.findMany({
        where: { personId },
      });
      expect(cached.length).toBe(1);
      expect(cached[0]!.type).toBe('STAFF');
    });

    it('deletes stale personas when a projection disappears', async () => {
      // Seed an hr_employees row, refresh → STAFF persona cached.
      await prisma.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.hr_employees
           (id, person_id, account_id, school_id, employment_type, employment_status, hire_date)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'FULL_TIME', 'ACTIVE', '2024-01-01')`,
        employeeId,
        personId,
        accountId,
        TEST_SCHOOL_ID,
      );
      await service.refreshPersonaCache(personId);
      let cached = await prisma.platformPersona.findMany({ where: { personId } });
      expect(cached.length).toBe(1);

      // Remove the projection, refresh → STAFF persona dropped.
      await prisma.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.hr_employees WHERE id = $1::uuid`,
        employeeId,
      );
      await service.refreshPersonaCache(personId);
      cached = await prisma.platformPersona.findMany({ where: { personId } });
      expect(cached.length).toBe(0);
    });

    it('idempotent — calling twice does not produce duplicates', async () => {
      await prisma.$executeRawUnsafe(
        `INSERT INTO platform.platform_family_children
           (id, family_id, person_id, first_name, last_name, status, linked_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Linked', 'Child', 'LINKED', now())`,
        familyChildId,
        familyId,
        childPersonId,
      );

      await service.refreshPersonaCache(personId);
      await service.refreshPersonaCache(personId);
      const cached = await prisma.platformPersona.findMany({ where: { personId } });
      const parentRows = cached.filter((c) => c.type === 'PARENT');
      expect(parentRows.length).toBe(1);
    });

    it('adding hr_employees row + refresh → STAFF persona appears in cache', async () => {
      // Start with no projections.
      await service.refreshPersonaCache(personId);
      let cached = await prisma.platformPersona.findMany({ where: { personId } });
      expect(cached.length).toBe(0);

      // Add an hr_employees row, refresh → STAFF appears.
      await prisma.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.hr_employees
           (id, person_id, account_id, school_id, employment_type, employment_status, hire_date)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'FULL_TIME', 'ACTIVE', '2024-01-01')`,
        employeeId,
        personId,
        accountId,
        TEST_SCHOOL_ID,
      );
      await service.refreshPersonaCache(personId);
      cached = await prisma.platformPersona.findMany({ where: { personId } });
      expect(cached.find((c) => c.type === 'STAFF')).toBeTruthy();
    });
  });

  // ─── getActivePersonas ──────────────────────────────────────

  describe('getActivePersonas', () => {
    it('returns cached personas verbatim', async () => {
      await prisma.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.hr_employees
           (id, person_id, account_id, school_id, employment_type, employment_status, hire_date)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'FULL_TIME', 'ACTIVE', '2024-01-01')`,
        employeeId,
        personId,
        accountId,
        TEST_SCHOOL_ID,
      );
      await service.refreshPersonaCache(personId);
      const active = await service.getActivePersonas(personId);
      expect(active.length).toBe(1);
      expect(active[0]!.type).toBe('STAFF');
      expect(active[0]!.schoolId).toBe(TEST_SCHOOL_ID);
    });

    it('returns empty array for a person with no cached personas', async () => {
      const active = await service.getActivePersonas(personId);
      expect(active).toEqual([]);
    });
  });
});
