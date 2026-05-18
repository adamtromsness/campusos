import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { MandatoryReportService } from '@modules/m27-student-services/counselling/mandatory-report.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import {
  withTestTenant,
  TEST_SCHOOL_ID,
  TEST_SCHEMA,
} from '../helpers/tenant-context';
import { adminActor, TEST_ADMIN_PERSON_ID } from '../helpers/actor';

/**
 * Wave 3 follow-up — Codex review FIX 3. Mandatory report FILED
 * immutability contract per the M27 ERD: once a report is created
 * (which starts at status='FILED' by service default), the core
 * fields — description, report_type, reported_to_authority,
 * report_date, supporting_docs_s3_keys, student_id, reporter_person_id
 * — are IMMUTABLE. Only status and cps_response may be patched.
 *
 * The service enforces this with a defence-in-depth whitelist guard
 * in MandatoryReportService.patch (file:
 * `apps/api/src/modules/m27-student-services/counselling/mandatory-report.service.ts:229`).
 * The DTO additionally constrains the surface to the two mutable
 * fields, so an attacker would need to forge a custom payload to
 * even reach the service guard.
 *
 * Each rejection is paired with a raw SQL re-read that proves the DB
 * row is byte-identical to its pre-patch state.
 */
describe('integration:m27-student-services/mandatory-reports', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let service: MandatoryReportService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    service = new MandatoryReportService(tenantPrisma, permCheck);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  const createdPersonIds: string[] = [];
  const createdPlatformStudentIds: string[] = [];
  const createdStudentIds: string[] = [];

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.svc_mandatory_reports WHERE student_id IN (SELECT id FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'MR-TEST-%')`,
    );
    if (createdStudentIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE id = ANY($1::uuid[])`,
        createdStudentIds.splice(0),
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

  async function seedStudent(label: string): Promise<string> {
    const personId = generateId();
    const platformStudentId = generateId();
    const studentId = generateId();
    createdPersonIds.push(personId);
    createdPlatformStudentIds.push(platformStudentId);
    createdStudentIds.push(studentId);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
       VALUES ($1::uuid, 'MR', $2, 'STUDENT', true)`,
      personId,
      label,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
       VALUES ($1::uuid, $2::uuid, 'MR', $3, true)`,
      platformStudentId,
      personId,
      label,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_students (id, platform_student_id, school_id, student_number, grade_level)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '5')`,
      studentId,
      platformStudentId,
      TEST_SCHOOL_ID,
      'MR-TEST-' + studentId.slice(-12),
    );
    return studentId;
  }

  async function seedReport(): Promise<{ id: string; studentId: string }> {
    const studentId = await seedStudent('Report');
    const dto = await withTestTenant(async () =>
      service.create(
        {
          studentId,
          reportType: 'SUSPECTED_ABUSE',
          reportedToAuthority: 'CPS-County-1',
          reportDate: new Date().toISOString(),
          description: 'initial mandatory-report narrative',
          supportingDocsS3Keys: ['s3://docs/initial-1', 's3://docs/initial-2'],
        } as any,
        adminActor(),
      ),
    );
    return { id: dto.id, studentId };
  }

  async function readRow(id: string) {
    const rows = (await rawClient.$queryRawUnsafe(
      `SELECT id::text AS id, student_id::text AS student_id,
              reporter_person_id::text AS reporter_person_id,
              report_type, reported_to_authority, report_date::text AS report_date,
              description, supporting_docs_s3_keys, cps_response, status,
              created_at::text AS created_at, updated_at::text AS updated_at
         FROM ${TEST_SCHEMA}.svc_mandatory_reports WHERE id = $1::uuid`,
      id,
    )) as Array<Record<string, any>>;
    return rows[0]!;
  }

  // ────────────────────────────────────────────────────────────────────
  // Default status on create is FILED
  // ────────────────────────────────────────────────────────────────────
  it('create() lands the row at status=FILED with reporter_person_id stamped from actor.personId', async () => {
    const { id } = await seedReport();
    const row = await readRow(id);
    expect(row.status).toBe('FILED');
    expect(row.reporter_person_id).toBe(TEST_ADMIN_PERSON_ID);
    expect(row.description).toBe('initial mandatory-report narrative');
  });

  // ────────────────────────────────────────────────────────────────────
  // Service-side guard rejects every immutable field
  // ────────────────────────────────────────────────────────────────────
  it.each([
    ['description', { description: 'tampered narrative' }],
    ['reportType', { reportType: 'SUSPECTED_NEGLECT' }],
    ['reportedToAuthority', { reportedToAuthority: 'CPS-DIFFERENT-AUTHORITY' }],
    ['reportDate', { reportDate: '2025-01-01T00:00:00Z' }],
    ['supportingDocsS3Keys', { supportingDocsS3Keys: ['s3://malicious/insert'] }],
    ['studentId', { studentId: '00000000-0000-0000-0000-000000000000' }],
    ['reporterPersonId', { reporterPersonId: '00000000-0000-0000-0000-000000000000' }],
  ])(
    'patch() on FILED report with immutable field %s → BadRequest, DB row unchanged',
    async (_label, badInput) => {
      const { id } = await seedReport();
      const before = await readRow(id);
      await expect(
        withTestTenant(async () => service.patch(id, badInput as any, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
      const after = await readRow(id);
      // Every column matches its pre-patch state. updated_at may or
      // may not move depending on whether the guard fired before the
      // UPDATE — assert the columns that the service might have
      // tampered with explicitly.
      expect(after.description).toBe(before.description);
      expect(after.report_type).toBe(before.report_type);
      expect(after.reported_to_authority).toBe(before.reported_to_authority);
      expect(after.report_date).toBe(before.report_date);
      expect(after.supporting_docs_s3_keys).toEqual(before.supporting_docs_s3_keys);
      expect(after.student_id).toBe(before.student_id);
      expect(after.reporter_person_id).toBe(before.reporter_person_id);
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // Permitted patches still work
  // ────────────────────────────────────────────────────────────────────
  it('patch() with status=CPS_CONTACTED → row updated to CPS_CONTACTED', async () => {
    const { id } = await seedReport();
    await withTestTenant(async () =>
      service.patch(id, { status: 'CPS_CONTACTED' } as any, adminActor()),
    );
    const after = await readRow(id);
    expect(after.status).toBe('CPS_CONTACTED');
  });

  it('patch() with cpsResponse → field updated, immutable core fields preserved', async () => {
    const { id } = await seedReport();
    const before = await readRow(id);
    await withTestTenant(async () =>
      service.patch(
        id,
        { cpsResponse: 'CPS opened case file 2026-05-18' } as any,
        adminActor(),
      ),
    );
    const after = await readRow(id);
    expect(after.cps_response).toBe('CPS opened case file 2026-05-18');
    expect(after.description).toBe(before.description);
    expect(after.report_type).toBe(before.report_type);
  });

  it('patch() on FILED report transitioning through CPS_CONTACTED → INVESTIGATION_ACTIVE → CLOSED keeps immutable core fields throughout', async () => {
    const { id } = await seedReport();
    const before = await readRow(id);
    for (const status of ['CPS_CONTACTED', 'INVESTIGATION_ACTIVE', 'CLOSED']) {
      await withTestTenant(async () =>
        service.patch(id, { status } as any, adminActor()),
      );
      const r = await readRow(id);
      expect(r.status).toBe(status);
      // Core fields are byte-identical at every transition.
      expect(r.description).toBe(before.description);
      expect(r.report_type).toBe(before.report_type);
      expect(r.reported_to_authority).toBe(before.reported_to_authority);
      expect(r.report_date).toBe(before.report_date);
      expect(r.supporting_docs_s3_keys).toEqual(before.supporting_docs_s3_keys);
      expect(r.student_id).toBe(before.student_id);
      expect(r.reporter_person_id).toBe(before.reporter_person_id);
    }
  });

  it('patch() on missing report → NotFound', async () => {
    await expect(
      withTestTenant(async () =>
        service.patch(
          '00000000-0000-0000-0000-000000000000',
          { status: 'CLOSED' } as any,
          adminActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
