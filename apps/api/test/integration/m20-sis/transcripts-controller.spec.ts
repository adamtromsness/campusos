import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { SisTranscriptsController } from '@modules/m20-sis/transcripts/sis-transcripts.controller';
import { TranscriptService } from '@modules/m20-sis/transcripts/transcript.service';
import { ReportingPeriodService } from '@modules/m20-sis/transcripts/reporting-period.service';
import { TransferService } from '@modules/m20-sis/transfers/transfer.service';
import { LockerService } from '@modules/m20-sis/lockers/locker.service';
import { StudentAwardService } from '@modules/m20-sis/students/student-award.service';
import { MedicalExemptionService } from '@modules/m20-sis/students/medical-exemption.service';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import { withTestTenant, TEST_SCHEMA, TEST_SCHOOL_ID } from '../helpers/tenant-context';
import {
  TEST_ADMIN_PERSON_ID,
  TEST_ADMIN_ACCOUNT_ID,
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';
import { TEST_SIS_ACADEMIC_YEAR_ID } from '../fixtures/sis';
import { seedStudent, cleanupSeededIds } from './sis-helpers';

/**
 * Wave 4 — m20-sis SisTranscriptsController.
 *
 * Drives every controller endpoint at least once: transcripts (read +
 * generate + status), transcript requests (submit + list + get + status),
 * transfers, lockers, reporting periods, awards, medical exemptions.
 * Service-level contracts remain covered by transcripts.spec /
 * lockers-transfers.spec / student-profile.spec.
 */
describe('integration:m20-sis/transcripts-controller', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let actorContext: ActorContextService;
  let outbox: OutboxService;
  let transcriptService: TranscriptService;
  let transferService: TransferService;
  let lockerService: LockerService;
  let reportingService: ReportingPeriodService;
  let awardService: StudentAwardService;
  let exemptionService: MedicalExemptionService;
  let controller: SisTranscriptsController;

  const personIds: string[] = [];
  const platformStudentIds: string[] = [];
  const studentIds: string[] = [];

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
    outbox = new OutboxService();

    transcriptService = new TranscriptService(tenantPrisma, permCheck, outbox);
    transferService = new TransferService(tenantPrisma, permCheck);
    lockerService = new LockerService(tenantPrisma, permCheck);
    reportingService = new ReportingPeriodService(tenantPrisma, permCheck);
    awardService = new StudentAwardService(tenantPrisma, permCheck);
    exemptionService = new MedicalExemptionService(tenantPrisma, permCheck);

    controller = new SisTranscriptsController(
      transcriptService,
      transferService,
      lockerService,
      reportingService,
      awardService,
      exemptionService,
      actorContext,
    );

    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid,
               ARRAY['sch-001:admin','stu-001:read','stu-001:write','stu-004:read','stu-004:write','stu-005:read','stu-005:write','stu-005:admin','stu-007:read','stu-007:write','stu-007:admin']::text[],
               now(), 'test')
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
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_transcript_courses`,
    );
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.sis_transcripts`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_transcript_requests`,
    );
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.sis_transfer_records`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.sis_lockers`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.sis_reporting_periods`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_student_awards`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_medical_exemption_records`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_student_gpa_snapshots`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_gpa_configurations`,
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

  // ─── Transcripts ────────────────────────────────────────────────────

  describe('transcripts', () => {
    it('listTranscripts (empty), generateTranscript, getTranscript, patchStatus', async () => {
      const student = await trackedStudent({ gradeLevel: '11' });

      await seedDefaultGpaConfig();
      const empty = await withTestTenant(async () =>
        controller.listTranscripts(student.studentId, fakeAdminReq()),
      );
      expect(empty).toHaveLength(0);

      const generated = await withTestTenant(async () =>
        controller.generateTranscript(
          student.studentId,
          { transcriptType: 'OFFICIAL' } as any,
          fakeAdminReq(),
        ),
      );
      expect(generated.studentId).toBe(student.studentId);

      const single = await withTestTenant(async () =>
        controller.getTranscript(generated.id, fakeAdminReq()),
      );
      expect(single.id).toBe(generated.id);

      const patched = await withTestTenant(async () =>
        controller.patchTranscriptStatus(
          generated.id,
          { status: 'SENT' } as any,
          fakeAdminReq(),
        ),
      );
      expect(patched.status).toBe('SENT');
    });
  });

  // ─── Transcript requests ────────────────────────────────────────────

  describe('transcript requests', () => {
    it('submit + list + filtered list + get + patch status (no fee)', async () => {
      const student = await trackedStudent({ gradeLevel: '12' });

      const submitted = await withTestTenant(async () =>
        controller.submitTranscriptRequest(
          {
            studentId: student.studentId,
            recipientName: 'College Acme',
            transcriptType: 'OFFICIAL',
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(submitted.studentId).toBe(student.studentId);
      expect(submitted.status).toBe('SUBMITTED');

      const list = await withTestTenant(async () =>
        controller.listTranscriptRequests(fakeAdminReq(), undefined, undefined),
      );
      expect(list.map((r) => r.id)).toContain(submitted.id);

      const filtered = await withTestTenant(async () =>
        controller.listTranscriptRequests(
          fakeAdminReq(),
          student.studentId,
          'SUBMITTED',
        ),
      );
      expect(filtered.map((r) => r.id)).toContain(submitted.id);

      const single = await withTestTenant(async () =>
        controller.getTranscriptRequest(submitted.id, fakeAdminReq()),
      );
      expect(single.id).toBe(submitted.id);

      const patched = await withTestTenant(async () =>
        controller.patchTranscriptRequestStatus(
          submitted.id,
          { status: 'PROCESSING' } as any,
          fakeAdminReq(),
        ),
      );
      expect(patched.status).toBe('PROCESSING');
    });
  });

  // ─── Transfers ──────────────────────────────────────────────────────

  describe('transfers', () => {
    it('create + list + listStudentTransfers + get + patch', async () => {
      const student = await trackedStudent();

      const created = await withTestTenant(async () =>
        controller.createTransfer(
          {
            studentId: student.studentId,
            transferDirection: 'INCOMING',
            otherSchoolName: 'Other Acme',
            transferDate: '2026-08-15',
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(created.studentId).toBe(student.studentId);

      const list = await withTestTenant(async () =>
        controller.listTransfers(fakeAdminReq(), undefined, undefined, undefined),
      );
      expect(list.map((r) => r.id)).toContain(created.id);

      const listFiltered = await withTestTenant(async () =>
        controller.listTransfers(fakeAdminReq(), 'INCOMING', '2026-01-01', '2027-01-01'),
      );
      expect(listFiltered.map((r) => r.id)).toContain(created.id);

      const perStudent = await withTestTenant(async () =>
        controller.listStudentTransfers(student.studentId, fakeAdminReq()),
      );
      expect(perStudent.map((r) => r.id)).toContain(created.id);

      const single = await withTestTenant(async () =>
        controller.getTransfer(created.id, fakeAdminReq()),
      );
      expect(single.id).toBe(created.id);

      const patched = await withTestTenant(async () =>
        controller.patchTransfer(
          created.id,
          { recordsReceived: true, notes: 'Records received' } as any,
          fakeAdminReq(),
        ),
      );
      expect(patched.recordsReceived).toBe(true);
    });
  });

  // ─── Lockers ────────────────────────────────────────────────────────

  describe('lockers', () => {
    it('create + list + assign + release + getStudentLocker + state-machine + bulkClear', async () => {
      const created = await withTestTenant(async () =>
        controller.createLocker(
          { lockerNumber: 'LOC-' + Date.now(), locationDescription: 'Hall A' } as any,
          fakeAdminReq(),
        ),
      );
      expect(created.status).toBe('AVAILABLE');

      const list = await withTestTenant(async () =>
        controller.listLockers(fakeAdminReq(), undefined),
      );
      expect(list.map((l) => l.id)).toContain(created.id);

      const filtered = await withTestTenant(async () =>
        controller.listLockers(fakeAdminReq(), 'AVAILABLE'),
      );
      expect(filtered.map((l) => l.id)).toContain(created.id);

      const student = await trackedStudent();
      const assigned = await withTestTenant(async () =>
        controller.assignLocker(
          {
            lockerId: created.id,
            studentId: student.studentId,
            academicYear: '2026-2027',
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(assigned.locker.status).toBe('ASSIGNED');
      expect(typeof assigned.combination).toBe('string');

      // Own-locker view returns the decrypted combination.
      const studentLocker = await withTestTenant(async () =>
        controller.getStudentLocker(student.studentId, fakeAdminReq()),
      );
      expect(studentLocker.id).toBe(created.id);

      const released = await withTestTenant(async () =>
        controller.releaseLocker(created.id, fakeAdminReq()),
      );
      expect(released.status).toBe('AVAILABLE');

      const oos = await withTestTenant(async () =>
        controller.outOfService(created.id, fakeAdminReq()),
      );
      expect(oos.status).toBe('OUT_OF_SERVICE');

      const back = await withTestTenant(async () =>
        controller.backInService(created.id, fakeAdminReq()),
      );
      expect(back.status).toBe('AVAILABLE');

      // bulkClear — nothing assigned right now; should return 0
      const bulk = await withTestTenant(async () =>
        controller.bulkClearLockers({} as any, fakeAdminReq()),
      );
      expect(bulk.cleared).toBe(0);
    });
  });

  // ─── Reporting periods ──────────────────────────────────────────────

  describe('reporting periods', () => {
    it('create + list + get + current + patch status', async () => {
      const created = await withTestTenant(async () =>
        controller.createReportingPeriod(
          {
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            name: 'Q1',
            periodType: 'PROGRESS_REPORT',
            startDate: '2026-08-15',
            endDate: '2026-10-25',
            gradesDueDate: '2026-11-01',
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(created.status).toBe('UPCOMING');

      const list = await withTestTenant(async () => controller.listReportingPeriods());
      expect(list.map((p) => p.id)).toContain(created.id);

      const single = await withTestTenant(async () =>
        controller.getReportingPeriod(created.id),
      );
      expect(single.id).toBe(created.id);

      const patched = await withTestTenant(async () =>
        controller.patchReportingPeriodStatus(
          created.id,
          { status: 'OPEN' } as any,
          fakeAdminReq(),
        ),
      );
      expect(patched.status).toBe('OPEN');

      const current = await withTestTenant(async () => controller.currentReportingPeriod());
      // current is the OPEN period for the current academic year — may or
      // may not be the row we created (the fixture year is not is_current).
      void current;
    });
  });

  // ─── Awards ─────────────────────────────────────────────────────────

  describe('awards', () => {
    it('create + listStudentAwards + delete (and bulkHonorRoll no-op)', async () => {
      const student = await trackedStudent({ gradeLevel: '12' });

      const created = await withTestTenant(async () =>
        controller.createAward(
          {
            studentId: student.studentId,
            awardType: 'SUBJECT_AWARD',
            awardName: 'Best in Maths',
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(created.studentId).toBe(student.studentId);

      const list = await withTestTenant(async () =>
        controller.listStudentAwards(student.studentId, fakeAdminReq()),
      );
      expect(list.map((a) => a.id)).toContain(created.id);

      // bulkHonorRoll with no GPA snapshots → 0 awarded
      const bulk = await withTestTenant(async () =>
        controller.bulkHonorRoll(
          {
            academicYear: '2026-2027',
            term: 'Fall 2026',
            gpaThreshold: 3.5,
            awardName: 'Honor Roll',
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(bulk.awarded).toBe(0);

      const deleted = await withTestTenant(async () =>
        controller.deleteAward(created.id, fakeAdminReq()),
      );
      expect(deleted.deleted).toBe(true);
    });
  });

  // ─── Medical exemptions ─────────────────────────────────────────────

  describe('medical exemptions', () => {
    it('create + list + patch + delete', async () => {
      const student = await trackedStudent();

      const created = await withTestTenant(async () =>
        controller.createExemption(
          {
            studentId: student.studentId,
            exemptionType: 'PE',
            reason: 'Knee injury',
            effectiveFrom: '2026-08-01',
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(created.studentId).toBe(student.studentId);

      const list = await withTestTenant(async () =>
        controller.listStudentExemptions(student.studentId, fakeAdminReq()),
      );
      expect(list.map((e) => e.id)).toContain(created.id);

      const patched = await withTestTenant(async () =>
        controller.patchExemption(
          created.id,
          { reason: 'Updated reason' } as any,
          fakeAdminReq(),
        ),
      );
      expect(patched.reason).toBe('Updated reason');

      const deleted = await withTestTenant(async () =>
        controller.deleteExemption(created.id, fakeAdminReq()),
      );
      expect(deleted.deleted).toBe(true);
    });
  });
});
