import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { GuardianAuthorizationService } from '@modules/m00-platform/iam/guardian-authorization.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import { withTestTenant, TEST_SCHOOL_ID, TEST_SCHEMA } from '../helpers/tenant-context';

/**
 * Wave 2 — DB-backed integration tests for GuardianAuthorizationService.
 * Replaces apps/api/src/modules/m00-platform/iam/guardian-authorization.{service,custody}.spec.ts.
 *
 * Strategy doc Wave 2 headline contracts:
 *   - 6 capability methods (academic / health / payment / transport /
 *     communications / conference) each combine portal_access +
 *     portal_access_scope + has_custody + custody arrangement + court-
 *     order restrictions
 *   - SOLE_A denies guardian B for all 6 capabilities; SOLE_B denies
 *     guardian A; JOINT allows both
 *   - NULL custody arrangement → deny (fail closed per P2-H6 FIX 1)
 *   - Missing link → deny (not on the access list)
 *   - Missing family_id on link → deny (no household record)
 *   - Zero sis_family_relationships rows → deny (unknown custody)
 *   - court_order_restrictions JSONB with explicit `false` blocks the
 *     matching capability (other capabilities unaffected)
 *   - canAuthorizePayment validates familyAccountId binding (account
 *     holder + student linkage in the same school)
 *   - Every access decision writes a platform_audit_log row keyed on
 *     data_subject_id = studentId
 */
describe('integration:m00-platform/guardian-authorization', () => {
  let rawClient: PrismaClient;
  let tenantPrisma: TenantPrismaService;
  let service: GuardianAuthorizationService;

  beforeAll(async () => {
    rawClient = new PrismaClient();
    await rawClient.$connect();
    tenantPrisma = new TenantPrismaService();
    service = new GuardianAuthorizationService(tenantPrisma);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  const createdPersonIds: string[] = [];
  const createdPlatformStudentIds: string[] = [];

  beforeEach(async () => {
    // Wipe test-created seed rows from prior runs. Order matters: links →
    // relationships → student_guardians → students/guardians/families.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_family_relationships WHERE family_id IN (SELECT id FROM ${TEST_SCHEMA}.sis_families WHERE family_name LIKE 'GA-TEST-%')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_student_guardians WHERE student_id IN (SELECT id FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'GA-TEST-%')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.pay_family_account_students WHERE student_id IN (SELECT id FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'GA-TEST-%')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.pay_family_accounts WHERE account_number LIKE 'GA-TEST-%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'GA-TEST-%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_guardians WHERE id IN (SELECT id FROM ${TEST_SCHEMA}.sis_guardians WHERE family_id IN (SELECT id FROM ${TEST_SCHEMA}.sis_families WHERE family_name LIKE 'GA-TEST-%'))`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_families WHERE family_name LIKE 'GA-TEST-%'`,
    );
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
    // Wipe audit-log rows from prior tests so per-test assertions are deterministic
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_audit_log WHERE action = 'guardian_access_decision' AND tenant_id = $1::uuid`,
      TEST_SCHOOL_ID,
    );
  });

  /**
   * Seed a complete custody scenario:
   *   - family with N guardians (each iam_person + sis_guardians)
   *   - student (iam_person + platform_students + sis_students)
   *   - sis_student_guardians link per guardian with configured flags
   *   - sis_family_relationships row(s) configuring custody_arrangement
   *     + court_order_restrictions between guardian A and B
   */
  async function seedScenario(opts: {
    guardians: Array<{
      portalAccess?: boolean;
      portalAccessScope?: 'FULL' | 'ACADEMIC_ONLY' | 'COMMUNICATIONS_ONLY' | null;
      hasCustody?: boolean;
      receivesReports?: boolean;
      isEmergencyContact?: boolean;
    }>;
    /** Custody between the first two guardians. NULL means "no relationship row". */
    custodyArrangement?: 'JOINT' | 'SOLE_A' | 'SOLE_B' | 'OTHER' | null;
    courtOrderRestrictions?: Record<string, boolean>;
    /** Omit family_id on the link to test the "no household" path */
    omitFamilyId?: boolean;
    /** When provided, no family relationship row is created at all */
    omitRelationship?: boolean;
  }): Promise<{ studentId: string; guardianPersonIds: string[]; familyId: string }> {
    const familyId = generateId();
    const studentPersonId = generateId();
    const platformStudentId = generateId();
    const studentId = generateId();
    createdPersonIds.push(studentPersonId);
    createdPlatformStudentIds.push(platformStudentId);

    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_families (id, family_name, created_by)
       VALUES ($1::uuid, $2, $3::uuid)`,
      familyId,
      'GA-TEST-' + familyId,
      studentPersonId, // any uuid — created_by is not FK'd
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
       VALUES ($1::uuid, 'GA', 'Student', 'STUDENT', true)
       ON CONFLICT (id) DO NOTHING`,
      studentPersonId,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
       VALUES ($1::uuid, $2::uuid, 'GA', 'Student', true)
       ON CONFLICT (id) DO NOTHING`,
      platformStudentId,
      studentPersonId,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_students (id, platform_student_id, school_id, student_number, grade_level)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '5')`,
      studentId,
      platformStudentId,
      TEST_SCHOOL_ID,
      'GA-TEST-' + studentId,
    );

    const guardianIds: string[] = [];
    const guardianPersonIds: string[] = [];
    for (const g of opts.guardians) {
      const personId = generateId();
      const guardianId = generateId();
      guardianIds.push(guardianId);
      guardianPersonIds.push(personId);
      createdPersonIds.push(personId);
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
         VALUES ($1::uuid, 'GA', 'Guardian', 'GUARDIAN', true)
         ON CONFLICT (id) DO NOTHING`,
        personId,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_guardians (id, person_id, school_id, family_id, relationship)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'PARENT')`,
        guardianId,
        personId,
        TEST_SCHOOL_ID,
        opts.omitFamilyId ? null : familyId,
      );
      const scope = g.portalAccessScope === undefined ? 'FULL' : g.portalAccessScope;
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_student_guardians
           (id, student_id, guardian_id, has_custody, is_emergency_contact, receives_reports, portal_access, portal_access_scope)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, COALESCE($8, 'FULL'))`,
        generateId(),
        studentId,
        guardianId,
        g.hasCustody ?? true,
        g.isEmergencyContact ?? false,
        g.receivesReports ?? true,
        g.portalAccess ?? true,
        scope,
      );
    }

    if (!opts.omitRelationship && guardianIds.length >= 2) {
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_family_relationships
           (id, family_id, guardian_a_id, guardian_b_id, relationship_type, custody_arrangement, court_order_restrictions)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'MARRIED', $5, $6::jsonb)`,
        generateId(),
        familyId,
        guardianIds[0],
        guardianIds[1],
        opts.custodyArrangement ?? null,
        JSON.stringify(opts.courtOrderRestrictions ?? {}),
      );
    }

    return { studentId, guardianPersonIds, familyId };
  }

  async function readAuditLog(studentId: string) {
    return rawClient.$queryRawUnsafe<
      Array<{
        actor_id: string;
        action: string;
        entity_id: string;
        data_subject_id: string;
        metadata: unknown;
      }>
    >(
      `SELECT actor_id::text AS actor_id, action, entity_id::text AS entity_id,
              data_subject_id::text AS data_subject_id, metadata
         FROM platform.platform_audit_log
        WHERE action = 'guardian_access_decision' AND entity_id = $1::uuid AND tenant_id = $2::uuid
        ORDER BY created_at`,
      studentId,
      TEST_SCHOOL_ID,
    );
  }

  // ────────────────────────────────────────────────────────────────────
  // Custody invariants — apply to ALL 6 capabilities
  // ────────────────────────────────────────────────────────────────────
  describe('custody invariants (applied across all capabilities)', () => {
    it('JOINT: both guardians can access (academic)', async () => {
      const { studentId, guardianPersonIds } = await seedScenario({
        guardians: [{}, {}],
        custodyArrangement: 'JOINT',
      });
      await withTestTenant(async () => {
        expect(await service.canViewAcademicRecord(guardianPersonIds[0]!, studentId)).toBe(true);
        expect(await service.canViewAcademicRecord(guardianPersonIds[1]!, studentId)).toBe(true);
      });
    });

    it('SOLE_A: guardian A allowed, guardian B denied (for academic_record)', async () => {
      const { studentId, guardianPersonIds } = await seedScenario({
        guardians: [{}, {}],
        custodyArrangement: 'SOLE_A',
      });
      await withTestTenant(async () => {
        expect(await service.canViewAcademicRecord(guardianPersonIds[0]!, studentId)).toBe(true);
        expect(await service.canViewAcademicRecord(guardianPersonIds[1]!, studentId)).toBe(false);
      });
    });

    it('SOLE_B: guardian A denied, guardian B allowed', async () => {
      const { studentId, guardianPersonIds } = await seedScenario({
        guardians: [{}, {}],
        custodyArrangement: 'SOLE_B',
      });
      await withTestTenant(async () => {
        expect(await service.canViewAcademicRecord(guardianPersonIds[0]!, studentId)).toBe(false);
        expect(await service.canViewAcademicRecord(guardianPersonIds[1]!, studentId)).toBe(true);
      });
    });

    it('NULL custody → BOTH denied (fail-closed per P2-H6 FIX 1)', async () => {
      const { studentId, guardianPersonIds } = await seedScenario({
        guardians: [{}, {}],
        custodyArrangement: null,
      });
      await withTestTenant(async () => {
        expect(await service.canViewAcademicRecord(guardianPersonIds[0]!, studentId)).toBe(false);
        expect(await service.canViewAcademicRecord(guardianPersonIds[1]!, studentId)).toBe(false);
      });
    });

    it('zero relationship rows → deny (unknown custody)', async () => {
      const { studentId, guardianPersonIds } = await seedScenario({
        guardians: [{}, {}],
        omitRelationship: true,
      });
      await withTestTenant(async () => {
        expect(await service.canViewAcademicRecord(guardianPersonIds[0]!, studentId)).toBe(false);
      });
    });

    it('guardian without family_id on the link → deny (no household record)', async () => {
      const { studentId, guardianPersonIds } = await seedScenario({
        guardians: [{}],
        omitFamilyId: true,
      });
      await withTestTenant(async () => {
        expect(await service.canViewAcademicRecord(guardianPersonIds[0]!, studentId)).toBe(false);
      });
    });

    it('no link (random uuid) → deny', async () => {
      const { studentId } = await seedScenario({
        guardians: [{}, {}],
        custodyArrangement: 'JOINT',
      });
      const randomGuardianPersonId = generateId();
      await withTestTenant(async () => {
        expect(await service.canViewAcademicRecord(randomGuardianPersonId, studentId)).toBe(false);
      });
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // canViewAcademicRecord
  // ────────────────────────────────────────────────────────────────────
  describe('canViewAcademicRecord', () => {
    it('FULL scope + JOINT custody → granted', async () => {
      const { studentId, guardianPersonIds } = await seedScenario({
        guardians: [{ portalAccessScope: 'FULL' }, {}],
        custodyArrangement: 'JOINT',
      });
      await withTestTenant(async () =>
        expect(await service.canViewAcademicRecord(guardianPersonIds[0]!, studentId)).toBe(true),
      );
    });

    it('ACADEMIC_ONLY scope → granted', async () => {
      const { studentId, guardianPersonIds } = await seedScenario({
        guardians: [{ portalAccessScope: 'ACADEMIC_ONLY' }, {}],
        custodyArrangement: 'JOINT',
      });
      await withTestTenant(async () =>
        expect(await service.canViewAcademicRecord(guardianPersonIds[0]!, studentId)).toBe(true),
      );
    });

    it('COMMUNICATIONS_ONLY scope → denied', async () => {
      const { studentId, guardianPersonIds } = await seedScenario({
        guardians: [{ portalAccessScope: 'COMMUNICATIONS_ONLY' }, {}],
        custodyArrangement: 'JOINT',
      });
      await withTestTenant(async () =>
        expect(await service.canViewAcademicRecord(guardianPersonIds[0]!, studentId)).toBe(false),
      );
    });

    it('portal_access=false → denied (regardless of scope)', async () => {
      const { studentId, guardianPersonIds } = await seedScenario({
        guardians: [{ portalAccess: false, portalAccessScope: 'FULL' }, {}],
        custodyArrangement: 'JOINT',
      });
      await withTestTenant(async () =>
        expect(await service.canViewAcademicRecord(guardianPersonIds[0]!, studentId)).toBe(false),
      );
    });

    it('court_order_restrictions academic_records=false → denied', async () => {
      const { studentId, guardianPersonIds } = await seedScenario({
        guardians: [{}, {}],
        custodyArrangement: 'JOINT',
        courtOrderRestrictions: { academic_records: false },
      });
      await withTestTenant(async () =>
        expect(await service.canViewAcademicRecord(guardianPersonIds[0]!, studentId)).toBe(false),
      );
    });

    it('court_order_restrictions OTHER capability false → unaffected (academic still granted)', async () => {
      const { studentId, guardianPersonIds } = await seedScenario({
        guardians: [{}, {}],
        custodyArrangement: 'JOINT',
        courtOrderRestrictions: { health_records: false }, // not academic_records
      });
      await withTestTenant(async () =>
        expect(await service.canViewAcademicRecord(guardianPersonIds[0]!, studentId)).toBe(true),
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // canViewHealthRecord
  // ────────────────────────────────────────────────────────────────────
  describe('canViewHealthRecord', () => {
    it('FULL scope + receives_reports + JOINT → granted', async () => {
      const { studentId, guardianPersonIds } = await seedScenario({
        guardians: [{ portalAccessScope: 'FULL', receivesReports: true }, {}],
        custodyArrangement: 'JOINT',
      });
      await withTestTenant(async () =>
        expect(await service.canViewHealthRecord(guardianPersonIds[0]!, studentId)).toBe(true),
      );
    });

    it('ACADEMIC_ONLY scope → denied (health needs FULL)', async () => {
      const { studentId, guardianPersonIds } = await seedScenario({
        guardians: [{ portalAccessScope: 'ACADEMIC_ONLY', receivesReports: true }, {}],
        custodyArrangement: 'JOINT',
      });
      await withTestTenant(async () =>
        expect(await service.canViewHealthRecord(guardianPersonIds[0]!, studentId)).toBe(false),
      );
    });

    it('FULL but no receives_reports / emergency / custody → denied', async () => {
      const { studentId, guardianPersonIds } = await seedScenario({
        guardians: [
          {
            portalAccessScope: 'FULL',
            receivesReports: false,
            isEmergencyContact: false,
            hasCustody: false,
          },
          {},
        ],
        custodyArrangement: 'JOINT',
      });
      await withTestTenant(async () =>
        expect(await service.canViewHealthRecord(guardianPersonIds[0]!, studentId)).toBe(false),
      );
    });

    it('court_order_restrictions health_records=false → denied', async () => {
      const { studentId, guardianPersonIds } = await seedScenario({
        guardians: [{}, {}],
        custodyArrangement: 'JOINT',
        courtOrderRestrictions: { health_records: false },
      });
      await withTestTenant(async () =>
        expect(await service.canViewHealthRecord(guardianPersonIds[0]!, studentId)).toBe(false),
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // canAuthorizePayment — including familyAccountId binding
  // ────────────────────────────────────────────────────────────────────
  describe('canAuthorizePayment', () => {
    it('has_custody + JOINT (no familyAccountId) → granted', async () => {
      const { studentId, guardianPersonIds } = await seedScenario({
        guardians: [{ hasCustody: true }, {}],
        custodyArrangement: 'JOINT',
      });
      await withTestTenant(async () =>
        expect(await service.canAuthorizePayment(guardianPersonIds[0]!, studentId)).toBe(true),
      );
    });

    it('has_custody=false → denied', async () => {
      const { studentId, guardianPersonIds } = await seedScenario({
        guardians: [{ hasCustody: false }, {}],
        custodyArrangement: 'JOINT',
      });
      await withTestTenant(async () =>
        expect(await service.canAuthorizePayment(guardianPersonIds[0]!, studentId)).toBe(false),
      );
    });

    it('court_order_restrictions financial_authority=false → denied', async () => {
      const { studentId, guardianPersonIds } = await seedScenario({
        guardians: [{ hasCustody: true }, {}],
        custodyArrangement: 'JOINT',
        courtOrderRestrictions: { financial_authority: false },
      });
      await withTestTenant(async () =>
        expect(await service.canAuthorizePayment(guardianPersonIds[0]!, studentId)).toBe(false),
      );
    });

    it('familyAccountId binding: account holder + student linkage → granted', async () => {
      const { studentId, guardianPersonIds } = await seedScenario({
        guardians: [{ hasCustody: true }, {}],
        custodyArrangement: 'JOINT',
      });
      const guardianPersonId = guardianPersonIds[0]!;
      const accountId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.pay_family_accounts (id, school_id, account_holder_id, account_number, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'ACTIVE')`,
        accountId,
        TEST_SCHOOL_ID,
        guardianPersonId,
        'GA-TEST-FA-' + accountId,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.pay_family_account_students (id, family_account_id, student_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid)`,
        generateId(),
        accountId,
        studentId,
      );
      await withTestTenant(async () =>
        expect(
          await service.canAuthorizePayment(guardianPersonId, studentId, accountId),
        ).toBe(true),
      );
    });

    it('familyAccountId binding: account holder is different person → denied', async () => {
      const { studentId, guardianPersonIds } = await seedScenario({
        guardians: [{ hasCustody: true }, {}],
        custodyArrangement: 'JOINT',
      });
      const guardianPersonId = guardianPersonIds[0]!;
      const otherHolderId = generateId();
      createdPersonIds.push(otherHolderId);
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
         VALUES ($1::uuid, 'X', 'Y', 'GUARDIAN', true) ON CONFLICT (id) DO NOTHING`,
        otherHolderId,
      );
      const accountId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.pay_family_accounts (id, school_id, account_holder_id, account_number, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'ACTIVE')`,
        accountId,
        TEST_SCHOOL_ID,
        otherHolderId, // different holder
        'GA-TEST-FA-' + accountId,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.pay_family_account_students (id, family_account_id, student_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid)`,
        generateId(),
        accountId,
        studentId,
      );
      await withTestTenant(async () =>
        expect(
          await service.canAuthorizePayment(guardianPersonId, studentId, accountId),
        ).toBe(false),
      );
    });

    it('familyAccountId binding: account does not list this student → denied', async () => {
      const { studentId, guardianPersonIds } = await seedScenario({
        guardians: [{ hasCustody: true }, {}],
        custodyArrangement: 'JOINT',
      });
      const guardianPersonId = guardianPersonIds[0]!;
      const accountId = generateId();
      // Account exists with correct holder, but NO pay_family_account_students row
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.pay_family_accounts (id, school_id, account_holder_id, account_number, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'ACTIVE')`,
        accountId,
        TEST_SCHOOL_ID,
        guardianPersonId,
        'GA-TEST-FA-' + accountId,
      );
      await withTestTenant(async () =>
        expect(
          await service.canAuthorizePayment(guardianPersonId, studentId, accountId),
        ).toBe(false),
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // canReceiveTransportInfo
  // ────────────────────────────────────────────────────────────────────
  describe('canReceiveTransportInfo', () => {
    it('non-custodial parent on receives_reports gets alerts (safety)', async () => {
      const { studentId, guardianPersonIds } = await seedScenario({
        guardians: [{ hasCustody: false, receivesReports: true }, {}],
        custodyArrangement: 'JOINT',
      });
      await withTestTenant(async () =>
        expect(await service.canReceiveTransportInfo(guardianPersonIds[0]!, studentId)).toBe(true),
      );
    });

    it('court_order_restrictions transport_contact=false → denied', async () => {
      const { studentId, guardianPersonIds } = await seedScenario({
        guardians: [{ hasCustody: true }, {}],
        custodyArrangement: 'JOINT',
        courtOrderRestrictions: { transport_contact: false },
      });
      await withTestTenant(async () =>
        expect(await service.canReceiveTransportInfo(guardianPersonIds[0]!, studentId)).toBe(false),
      );
    });

    it('not on receives_reports / custody / emergency-contact → denied', async () => {
      const { studentId, guardianPersonIds } = await seedScenario({
        guardians: [
          {
            hasCustody: false,
            receivesReports: false,
            isEmergencyContact: false,
            portalAccess: true,
          },
          {},
        ],
        custodyArrangement: 'JOINT',
      });
      await withTestTenant(async () =>
        expect(await service.canReceiveTransportInfo(guardianPersonIds[0]!, studentId)).toBe(false),
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // canViewCommunications
  // ────────────────────────────────────────────────────────────────────
  describe('canViewCommunications', () => {
    it.each([
      ['FULL', true],
      ['COMMUNICATIONS_ONLY', true],
      ['ACADEMIC_ONLY', false],
    ] as const)('scope=%s → %s', async (scope, expected) => {
      const { studentId, guardianPersonIds } = await seedScenario({
        guardians: [{ portalAccessScope: scope }, {}],
        custodyArrangement: 'JOINT',
      });
      await withTestTenant(async () =>
        expect(await service.canViewCommunications(guardianPersonIds[0]!, studentId)).toBe(expected),
      );
    });

    it('court_order_restrictions communications=false → denied', async () => {
      const { studentId, guardianPersonIds } = await seedScenario({
        guardians: [{}, {}],
        custodyArrangement: 'JOINT',
        courtOrderRestrictions: { communications: false },
      });
      await withTestTenant(async () =>
        expect(await service.canViewCommunications(guardianPersonIds[0]!, studentId)).toBe(false),
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // canAttendConference
  // ────────────────────────────────────────────────────────────────────
  describe('canAttendConference', () => {
    it.each([
      ['FULL', true],
      ['COMMUNICATIONS_ONLY', true],
      ['ACADEMIC_ONLY', false],
    ] as const)('scope=%s → %s', async (scope, expected) => {
      const { studentId, guardianPersonIds } = await seedScenario({
        guardians: [{ portalAccessScope: scope }, {}],
        custodyArrangement: 'JOINT',
      });
      await withTestTenant(async () =>
        expect(await service.canAttendConference(guardianPersonIds[0]!, studentId)).toBe(expected),
      );
    });

    it('court_order_restrictions conference_attendance=false → denied', async () => {
      const { studentId, guardianPersonIds } = await seedScenario({
        guardians: [{}, {}],
        custodyArrangement: 'JOINT',
        courtOrderRestrictions: { conference_attendance: false },
      });
      await withTestTenant(async () =>
        expect(await service.canAttendConference(guardianPersonIds[0]!, studentId)).toBe(false),
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Audit log: every decision recorded in platform_audit_log
  // ────────────────────────────────────────────────────────────────────
  describe('platform_audit_log persistence', () => {
    it('each capability call writes one guardian_access_decision row', async () => {
      const { studentId, guardianPersonIds } = await seedScenario({
        guardians: [{}, {}],
        custodyArrangement: 'JOINT',
      });
      const guardianPersonId = guardianPersonIds[0]!;
      await withTestTenant(async () => {
        await service.canViewAcademicRecord(guardianPersonId, studentId);
        await service.canViewHealthRecord(guardianPersonId, studentId);
        await service.canAuthorizePayment(guardianPersonId, studentId);
        await service.canReceiveTransportInfo(guardianPersonId, studentId);
        await service.canViewCommunications(guardianPersonId, studentId);
        await service.canAttendConference(guardianPersonId, studentId);
      });

      const rows = await readAuditLog(studentId);
      expect(rows).toHaveLength(6);
      const capabilities = rows
        .map((r) => (r.metadata as { capability: string }).capability)
        .sort();
      expect(capabilities).toEqual([
        'academic_record',
        'communications',
        'conference',
        'health_record',
        'payment_authorise',
        'transport_info',
      ]);

      for (const row of rows) {
        expect(row.actor_id).toBe(guardianPersonId);
        expect(row.entity_id).toBe(studentId);
        expect(row.data_subject_id).toBe(studentId);
      }
    });

    it('metadata.granted reflects the actual decision (deny case)', async () => {
      const { studentId, guardianPersonIds } = await seedScenario({
        guardians: [{}, {}],
        custodyArrangement: 'SOLE_A',
      });
      const grantedActorId = guardianPersonIds[0]!;
      const deniedActorId = guardianPersonIds[1]!;
      await withTestTenant(async () => {
        await service.canViewAcademicRecord(grantedActorId, studentId);
        await service.canViewAcademicRecord(deniedActorId, studentId);
      });
      const rows = await readAuditLog(studentId);
      const granted = rows.find((r) => r.actor_id === grantedActorId)!;
      const denied = rows.find((r) => r.actor_id === deniedActorId)!;
      expect((granted.metadata as { granted: boolean }).granted).toBe(true);
      expect((denied.metadata as { granted: boolean }).granted).toBe(false);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // resolveLink — raw link snapshot for callers that need flags directly
  // ────────────────────────────────────────────────────────────────────
  describe('resolveLink', () => {
    it('returns the link snapshot for a valid (guardian, student) pair', async () => {
      const { studentId, guardianPersonIds } = await seedScenario({
        guardians: [
          {
            hasCustody: true,
            isEmergencyContact: true,
            receivesReports: false,
            portalAccess: true,
            portalAccessScope: 'ACADEMIC_ONLY',
          },
          {},
        ],
        custodyArrangement: 'JOINT',
      });
      const link = await withTestTenant(async () =>
        service.resolveLink(guardianPersonIds[0]!, studentId),
      );
      expect(link).toEqual({
        hasCustody: true,
        isEmergencyContact: true,
        receivesReports: false,
        portalAccess: true,
        portalAccessScope: 'ACADEMIC_ONLY',
      });
    });

    it('returns null when no link exists', async () => {
      const { studentId } = await seedScenario({
        guardians: [{}],
        custodyArrangement: null,
        omitRelationship: true,
      });
      const link = await withTestTenant(async () =>
        service.resolveLink(generateId(), studentId),
      );
      expect(link).toBeNull();
    });
  });
});
