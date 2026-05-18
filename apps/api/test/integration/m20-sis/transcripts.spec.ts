import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { TranscriptService } from '@modules/m20-sis/transcripts/transcript.service';
import { ReportingPeriodService } from '@modules/m20-sis/transcripts/reporting-period.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import {
  withTestTenant,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
} from '../helpers/tenant-context';
import { adminActor, teacherActor } from '../helpers/actor';
import { TEST_SIS_ACADEMIC_YEAR_ID, TEST_SIS_CLASS_ID } from '../fixtures/sis';
import { seedStudent, cleanupSeededIds } from './sis-helpers';

describe('integration:m20-sis/transcripts', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let outbox: OutboxService;
  let transcriptService: TranscriptService;
  let reportingService: ReportingPeriodService;

  const personIds: string[] = [];
  const platformStudentIds: string[] = [];
  const studentIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    outbox = new OutboxService();
    transcriptService = new TranscriptService(tenantPrisma, permCheck, outbox);
    reportingService = new ReportingPeriodService(tenantPrisma, permCheck);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.sis_transcript_courses`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.sis_transcripts`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.sis_transcript_requests`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.sis_reporting_periods`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.sis_student_gpa_snapshots`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.sis_gpa_configurations`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_outbox WHERE topic = 'sis.transcript_request.fee_requested' AND tenant_id = $1::uuid`,
      TEST_SCHOOL_ID,
    );
    await cleanupSeededIds(rawClient, {
      studentIds: studentIds.splice(0),
      platformStudentIds: platformStudentIds.splice(0),
      personIds: personIds.splice(0),
    });
  });

  async function trackedStudent(opts: Parameters<typeof seedStudent>[1] = {}) {
    const s = await seedStudent(rawClient, opts);
    studentIds.push(s.studentId);
    platformStudentIds.push(s.platformStudentId);
    personIds.push(s.personId);
    return s;
  }

  async function seedDefaultGpaConfig(): Promise<string> {
    const cfgId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_gpa_configurations
         (id, school_id, config_name, calculation_method, scale_type, grade_point_mapping, is_default)
       VALUES ($1::uuid, $2::uuid, 'Default 4.0', 'WEIGHTED', 'FOUR_POINT',
               '{"A": 4, "B": 3, "C": 2, "D": 1, "F": 0}'::jsonb, true)`,
      cfgId,
      TEST_SCHOOL_ID,
    );
    return cfgId;
  }

  describe('ReportingPeriodService', () => {
    it('admin creates a reporting period (status UPCOMING)', async () => {
      const period = await withTestTenant(async () =>
        reportingService.create(
          {
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            name: 'Q1',
            periodType: 'PROGRESS_REPORT',
            startDate: '2026-08-15',
            endDate: '2026-10-25',
            gradesDueDate: '2026-11-01',
          } as any,
          adminActor(),
        ),
      );
      expect(period.status).toBe('UPCOMING');
      expect(period.name).toBe('Q1');
    });

    it('non-admin create → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          reportingService.create(
            {
              academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
              name: 'Q1',
              periodType: 'PROGRESS_REPORT',
              startDate: '2026-08-15',
              endDate: '2026-10-25',
              gradesDueDate: '2026-11-01',
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('endDate < startDate → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          reportingService.create(
            {
              academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
              name: 'BadDates',
              periodType: 'PROGRESS_REPORT',
              startDate: '2026-10-25',
              endDate: '2026-08-15',
              gradesDueDate: '2026-11-01',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('invalid periodType → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          reportingService.create(
            {
              academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
              name: 'X',
              periodType: 'NOPE',
              startDate: '2026-08-15',
              endDate: '2026-10-25',
              gradesDueDate: '2026-11-01',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('foreign-school academic_year → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          reportingService.create(
            {
              academicYearId: '00000000-0000-0000-0000-000000000000',
              name: 'X',
              periodType: 'PROGRESS_REPORT',
              startDate: '2026-08-15',
              endDate: '2026-10-25',
              gradesDueDate: '2026-11-01',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('patchStatus: UPCOMING → OPEN → GRADING_CLOSED → PUBLISHED happy path', async () => {
      const p = await withTestTenant(async () =>
        reportingService.create(
          {
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            name: 'Q2',
            periodType: 'PROGRESS_REPORT',
            startDate: '2026-10-26',
            endDate: '2026-12-15',
            gradesDueDate: '2026-12-22',
          } as any,
          adminActor(),
        ),
      );
      let next = await withTestTenant(async () =>
        reportingService.patchStatus(p.id, { status: 'OPEN' } as any, adminActor()),
      );
      expect(next.status).toBe('OPEN');
      next = await withTestTenant(async () =>
        reportingService.patchStatus(p.id, { status: 'GRADING_CLOSED' } as any, adminActor()),
      );
      expect(next.status).toBe('GRADING_CLOSED');
      next = await withTestTenant(async () =>
        reportingService.patchStatus(p.id, { status: 'PUBLISHED' } as any, adminActor()),
      );
      expect(next.status).toBe('PUBLISHED');
      expect(next.publishedAt).not.toBeNull();
    });

    it('patchStatus: skipping UPCOMING → PUBLISHED → BadRequestException', async () => {
      const p = await withTestTenant(async () =>
        reportingService.create(
          {
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            name: 'Q3',
            periodType: 'PROGRESS_REPORT',
            startDate: '2026-12-16',
            endDate: '2027-02-15',
            gradesDueDate: '2027-02-22',
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          reportingService.patchStatus(p.id, { status: 'PUBLISHED' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('patchStatus on unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          reportingService.patchStatus(
            '00000000-0000-0000-0000-000000000000',
            { status: 'OPEN' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('list returns rows; getById and current return active', async () => {
      const p = await withTestTenant(async () =>
        reportingService.create(
          {
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            name: 'Q4',
            periodType: 'PROGRESS_REPORT',
            startDate: '2027-02-16',
            endDate: '2027-04-15',
            gradesDueDate: '2027-04-22',
          } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        reportingService.patchStatus(p.id, { status: 'OPEN' } as any, adminActor()),
      );
      const all = await withTestTenant(async () => reportingService.list());
      expect(all.map((r) => r.id)).toContain(p.id);

      const lookup = await withTestTenant(async () => reportingService.getById(p.id));
      expect(lookup.id).toBe(p.id);

      const current = await withTestTenant(async () => reportingService.current());
      expect(current?.id).toBe(p.id);
    });

    it('getById on unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          reportingService.getById('00000000-0000-0000-0000-000000000000'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('TranscriptService.generate', () => {
    it('admin generates OFFICIAL transcript → header + default config + empty courses', async () => {
      const cfgId = await seedDefaultGpaConfig();
      const s = await trackedStudent({ firstName: 'Cert', lastName: 'Stu', gradeLevel: '12' });

      const t = await withTestTenant(async () =>
        transcriptService.generate(
          s.studentId,
          {
            transcriptType: 'OFFICIAL',
            recipientName: 'Office of Admissions',
          } as any,
          adminActor(),
        ),
      );
      expect(t.transcriptType).toBe('OFFICIAL');
      expect(t.status).toBe('GENERATED');
      expect(t.gpaConfigId).toBe(cfgId);
      // No cls_grades seeded — empty courses
      expect(t.courses).toHaveLength(0);
    });

    it('admin generates with explicit gpaConfigId', async () => {
      const cfgId = await seedDefaultGpaConfig();
      const s = await trackedStudent();
      const t = await withTestTenant(async () =>
        transcriptService.generate(
          s.studentId,
          { transcriptType: 'UNOFFICIAL', gpaConfigId: cfgId } as any,
          adminActor(),
        ),
      );
      expect(t.gpaConfigId).toBe(cfgId);
    });

    it('foreign-school gpaConfigId → BadRequestException', async () => {
      await seedDefaultGpaConfig();
      const s = await trackedStudent();
      await expect(
        withTestTenant(async () =>
          transcriptService.generate(
            s.studentId,
            {
              transcriptType: 'OFFICIAL',
              gpaConfigId: '00000000-0000-0000-0000-000000000000',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('generate with no GPA config + no supplied id → BadRequestException', async () => {
      const s = await trackedStudent();
      await expect(
        withTestTenant(async () =>
          transcriptService.generate(
            s.studentId,
            { transcriptType: 'OFFICIAL' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('generate by non-registrar → ForbiddenException', async () => {
      const s = await trackedStudent();
      await expect(
        withTestTenant(async () =>
          transcriptService.generate(
            s.studentId,
            { transcriptType: 'OFFICIAL' } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('invalid transcriptType → BadRequestException', async () => {
      const s = await trackedStudent();
      await expect(
        withTestTenant(async () =>
          transcriptService.generate(
            s.studentId,
            { transcriptType: 'BOGUS' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('generate with foreign-school student → BadRequestException', async () => {
      const bStudent = await trackedStudent({ schoolId: '019e0cf8-aaaa-7777-8888-00000000000b' });
      await seedDefaultGpaConfig();
      await expect(
        withTestTenant(async () =>
          transcriptService.generate(
            bStudent.studentId,
            { transcriptType: 'OFFICIAL' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('TranscriptService.patchStatus', () => {
    async function generate(): Promise<{ studentId: string; transcriptId: string }> {
      await seedDefaultGpaConfig();
      const s = await trackedStudent();
      const t = await withTestTenant(async () =>
        transcriptService.generate(
          s.studentId,
          { transcriptType: 'OFFICIAL' } as any,
          adminActor(),
        ),
      );
      return { studentId: s.studentId, transcriptId: t.id };
    }

    it('GENERATED → SENT', async () => {
      const { transcriptId } = await generate();
      const sent = await withTestTenant(async () =>
        transcriptService.patchStatus(transcriptId, { status: 'SENT' } as any, adminActor()),
      );
      expect(sent.status).toBe('SENT');
      expect(sent.sentAt).not.toBeNull();
    });

    it('SENT → REVOKED requires revokeReason', async () => {
      const { transcriptId } = await generate();
      await withTestTenant(async () =>
        transcriptService.patchStatus(transcriptId, { status: 'SENT' } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          transcriptService.patchStatus(transcriptId, { status: 'REVOKED' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      const revoked = await withTestTenant(async () =>
        transcriptService.patchStatus(
          transcriptId,
          { status: 'REVOKED', revokeReason: 'data error' } as any,
          adminActor(),
        ),
      );
      expect(revoked.status).toBe('REVOKED');
    });

    it('non-registrar patchStatus → ForbiddenException', async () => {
      const { transcriptId } = await generate();
      await expect(
        withTestTenant(async () =>
          transcriptService.patchStatus(transcriptId, { status: 'SENT' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('invalid status → BadRequestException', async () => {
      const { transcriptId } = await generate();
      await expect(
        withTestTenant(async () =>
          transcriptService.patchStatus(transcriptId, { status: 'NOPE' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('TranscriptService.submitRequest + listRequests', () => {
    it('admin submits free request → SUBMITTED, no outbox emit', async () => {
      const s = await trackedStudent();
      const req = await withTestTenant(async () =>
        transcriptService.submitRequest(
          {
            studentId: s.studentId,
            recipientName: 'College',
            transcriptType: 'OFFICIAL',
            copies: 2,
          } as any,
          adminActor(),
        ),
      );
      expect(req.status).toBe('SUBMITTED');
      expect(req.copies).toBe(2);

      const emits = await rawClient.$queryRawUnsafe<Array<{ topic: string }>>(
        `SELECT topic FROM platform.platform_outbox WHERE topic = 'sis.transcript_request.fee_requested' AND tenant_id = $1::uuid`,
        TEST_SCHOOL_ID,
      );
      expect(emits).toHaveLength(0);
    });

    it('admin submits paid request → outbox emit lands', async () => {
      const s = await trackedStudent();
      // Seed family account
      const famAccId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.pay_family_accounts (id, school_id, account_holder_id, account_number, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'TR-FAM', 'ACTIVE')`,
        famAccId,
        TEST_SCHOOL_ID,
        '019e0cf8-aaaa-7777-8888-000000000010',
      );
      try {
        const req = await withTestTenant(async () =>
          transcriptService.submitRequest(
            {
              studentId: s.studentId,
              recipientName: 'University',
              transcriptType: 'OFFICIAL',
              copies: 1,
              feeAmount: 10,
              familyAccountId: famAccId,
            } as any,
            adminActor(),
          ),
        );
        expect(req.status).toBe('SUBMITTED');

        const emits = await rawClient.$queryRawUnsafe<Array<{ topic: string }>>(
          `SELECT topic FROM platform.platform_outbox WHERE topic = 'sis.transcript_request.fee_requested' AND tenant_id = $1::uuid`,
          TEST_SCHOOL_ID,
        );
        expect(emits).toHaveLength(1);
      } finally {
        await rawClient.$executeRawUnsafe(
          `DELETE FROM ${TEST_SCHEMA}.pay_family_accounts WHERE id = $1::uuid`,
          famAccId,
        );
      }
    });

    it('paid request with no familyAccountId → BadRequestException', async () => {
      const s = await trackedStudent();
      await expect(
        withTestTenant(async () =>
          transcriptService.submitRequest(
            {
              studentId: s.studentId,
              recipientName: 'X',
              transcriptType: 'OFFICIAL',
              feeAmount: 5,
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('paid request with foreign-school familyAccountId → BadRequestException', async () => {
      const s = await trackedStudent();
      await expect(
        withTestTenant(async () =>
          transcriptService.submitRequest(
            {
              studentId: s.studentId,
              recipientName: 'X',
              transcriptType: 'OFFICIAL',
              feeAmount: 5,
              familyAccountId: '00000000-0000-0000-0000-000000000000',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('copies out of range → BadRequestException', async () => {
      const s = await trackedStudent();
      await expect(
        withTestTenant(async () =>
          transcriptService.submitRequest(
            {
              studentId: s.studentId,
              recipientName: 'X',
              transcriptType: 'OFFICIAL',
              copies: 0,
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('listRequests filters by status', async () => {
      const s = await trackedStudent();
      await withTestTenant(async () =>
        transcriptService.submitRequest(
          {
            studentId: s.studentId,
            recipientName: 'X',
            transcriptType: 'OFFICIAL',
          } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () =>
        transcriptService.listRequests({ status: 'SUBMITTED' }, adminActor()),
      );
      expect(list).toHaveLength(1);
    });

    it('patchRequestStatus: SUBMITTED → PROCESSING → SENT → PICKED_UP', async () => {
      const s = await trackedStudent();
      const req = await withTestTenant(async () =>
        transcriptService.submitRequest(
          {
            studentId: s.studentId,
            recipientName: 'X',
            transcriptType: 'OFFICIAL',
          } as any,
          adminActor(),
        ),
      );
      let next = await withTestTenant(async () =>
        transcriptService.patchRequestStatus(req.id, { status: 'PROCESSING' } as any, adminActor()),
      );
      expect(next.status).toBe('PROCESSING');
      next = await withTestTenant(async () =>
        transcriptService.patchRequestStatus(req.id, { status: 'SENT' } as any, adminActor()),
      );
      expect(next.status).toBe('SENT');
      next = await withTestTenant(async () =>
        transcriptService.patchRequestStatus(req.id, { status: 'PICKED_UP' } as any, adminActor()),
      );
      expect(next.status).toBe('PICKED_UP');
    });

    it('patchRequestStatus illegal transition (SUBMITTED → SENT) → BadRequestException', async () => {
      const s = await trackedStudent();
      const req = await withTestTenant(async () =>
        transcriptService.submitRequest(
          {
            studentId: s.studentId,
            recipientName: 'X',
            transcriptType: 'OFFICIAL',
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          transcriptService.patchRequestStatus(req.id, { status: 'SENT' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('patchRequestStatus CANCELLED requires cancelReason', async () => {
      const s = await trackedStudent();
      const req = await withTestTenant(async () =>
        transcriptService.submitRequest(
          {
            studentId: s.studentId,
            recipientName: 'X',
            transcriptType: 'OFFICIAL',
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          transcriptService.patchRequestStatus(
            req.id,
            { status: 'CANCELLED' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      const cancelled = await withTestTenant(async () =>
        transcriptService.patchRequestStatus(
          req.id,
          { status: 'CANCELLED', cancelReason: 'duplicate' } as any,
          adminActor(),
        ),
      );
      expect(cancelled.status).toBe('CANCELLED');
    });

    it('getRequestById unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          transcriptService.getRequestById(
            '00000000-0000-0000-0000-000000000000',
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('listForStudent + getById return rows generated above', async () => {
      await seedDefaultGpaConfig();
      const s = await trackedStudent();
      const t = await withTestTenant(async () =>
        transcriptService.generate(
          s.studentId,
          { transcriptType: 'OFFICIAL' } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () =>
        transcriptService.listForStudent(s.studentId, adminActor()),
      );
      expect(list.map((r) => r.id)).toContain(t.id);

      const dto = await withTestTenant(async () => transcriptService.getById(t.id, adminActor()));
      expect(dto.id).toBe(t.id);
    });

    it('getById unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          transcriptService.getById('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
