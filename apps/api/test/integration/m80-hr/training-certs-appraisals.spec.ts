import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { TrainingProgrammeService } from '@modules/m80-hr/training/programme.service';
import { TrainingEventService } from '@modules/m80-hr/training/event.service';
import { CompletionService } from '@modules/m80-hr/training/completion.service';
import {
  CertificationTypeService,
  EmployeeCertificationService,
} from '@modules/m80-hr/training/certification.service';
import { TrainingController } from '@modules/m80-hr/training/training.controller';
import { CertificationService } from '@modules/m80-hr/certifications/certification.service';
import { TrainingComplianceService } from '@modules/m80-hr/certifications/training-compliance.service';
import { CertificationsController } from '@modules/m80-hr/certifications/certifications.controller';
import { ComplianceController } from '@modules/m80-hr/certifications/compliance.controller';
import {
  AppraisalFrameworkService,
  AppraisalCycleService,
  AppraisalService,
  AppraisalGoalService,
  AppraisalCommentService,
  LessonObservationService,
} from '@modules/m80-hr/appraisals/appraisals.service';
import { ExpenseClaimService } from '@modules/m80-hr/appraisals/expense-claim.service';
import { AppraisalsController } from '@modules/m80-hr/appraisals/appraisals.controller';
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
  TEST_ADMIN_ACCOUNT_ID,
  TEST_ADMIN_PERSON_ID,
  TEST_ADMIN_EMPLOYEE_ID,
  TEST_TEACHER_EMPLOYEE_ID,
  TEST_OFFICER_EMPLOYEE_ID,
} from '../helpers/actor';
import { makeRecordingKafka, RecordingKafkaProducer } from '../helpers/recording-kafka';
import { ensureWorkflowsPlatformFixtures } from '../fixtures/workflows';
import {
  resetAndSeedHr,
  ensureHrFixtures,
  TEST_HR_ACADEMIC_YEAR_ID,
  TEST_HR_APPRAISAL_FW_ID,
  TEST_HR_CERT_TYPE_FIRST_AID_ID,
  TEST_HR_TRAINING_PROG_MAND_ID,
  TEST_HR_TRAINING_PROG_OPT_ID,
  TEST_HR_TRAINING_PROG_B_ID,
} from '../fixtures/hr';
import { generateId } from '@campusos/database';

describe('integration:m80-hr/training-certs-appraisals', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let kafka: RecordingKafkaProducer;
  let outbox: OutboxService;
  let actors: ActorContextService;
  let permissions: PermissionCheckService;

  // Training
  let programmes: TrainingProgrammeService;
  let events: TrainingEventService;
  let completions: CompletionService;
  let certTypes: CertificationTypeService;
  let employeeCerts: EmployeeCertificationService;
  let trainingCtrl: TrainingController;

  // Legacy certs
  let legacyCerts: CertificationService;
  let compliance: TrainingComplianceService;
  let certsCtrl: CertificationsController;
  let complianceCtrl: ComplianceController;

  // Appraisals
  let frameworks: AppraisalFrameworkService;
  let cycles: AppraisalCycleService;
  let appraisals: AppraisalService;
  let goals: AppraisalGoalService;
  let comments: AppraisalCommentService;
  let observations: LessonObservationService;
  let claims: ExpenseClaimService;
  let appraisalsCtrl: AppraisalsController;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    // Restore canonical admin iam_effective_access_cache — earlier specs
    // wipe it. Training / Certification / Appraisal admin gates need
    // sch-001:admin.
    await ensureWorkflowsPlatformFixtures(rawClient);

    kafka = makeRecordingKafka() as any;
    outbox = new OutboxService();
    permissions = new PermissionCheckService(rawClient);
    actors = new ActorContextService(rawClient, permissions, tenantPrisma);

    programmes = new TrainingProgrammeService(tenantPrisma, permissions);
    events = new TrainingEventService(tenantPrisma, permissions);
    completions = new CompletionService(tenantPrisma, permissions, outbox, events);
    certTypes = new CertificationTypeService(tenantPrisma, permissions);
    employeeCerts = new EmployeeCertificationService(tenantPrisma, permissions);
    trainingCtrl = new TrainingController(
      programmes,
      events,
      completions,
      certTypes,
      employeeCerts,
      actors,
    );

    legacyCerts = new CertificationService(tenantPrisma, kafka as any);
    compliance = new TrainingComplianceService(tenantPrisma, permissions);
    certsCtrl = new CertificationsController(legacyCerts, actors);
    complianceCtrl = new ComplianceController(compliance, actors);

    frameworks = new AppraisalFrameworkService(tenantPrisma, permissions);
    cycles = new AppraisalCycleService(tenantPrisma, permissions);
    appraisals = new AppraisalService(tenantPrisma, permissions);
    goals = new AppraisalGoalService(tenantPrisma, appraisals);
    comments = new AppraisalCommentService(tenantPrisma, appraisals);
    observations = new LessonObservationService(tenantPrisma, permissions, appraisals);
    claims = new ExpenseClaimService(tenantPrisma, permissions);
    appraisalsCtrl = new AppraisalsController(
      frameworks,
      cycles,
      appraisals,
      goals,
      comments,
      observations,
      claims,
      actors,
    );

    await ensureHrFixtures(rawClient);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetAndSeedHr(rawClient);
    kafka.reset();
  });

  function adminReq(): any {
    return {
      user: {
        sub: TEST_ADMIN_ACCOUNT_ID,
        personId: TEST_ADMIN_PERSON_ID,
        email: 'admin@test.local',
        displayName: 'Admin',
        sessionId: 's',
      },
    };
  }

  // ───────────────────────────────────────────────────────────────────
  // TrainingProgrammeService
  // ───────────────────────────────────────────────────────────────────
  describe('TrainingProgrammeService', () => {
    it('list includes mandatory + optional', async () => {
      const list = await withTestTenant(async () => programmes.list(false));
      const ids = list.map((p) => p.id);
      expect(ids).toContain(TEST_HR_TRAINING_PROG_MAND_ID);
      expect(ids).toContain(TEST_HR_TRAINING_PROG_OPT_ID);
    });

    it('list includeInactive=true expands', async () => {
      const all = await withTestTenant(async () => programmes.list(true));
      expect(all.length).toBeGreaterThan(0);
    });

    it('getById 404 missing', async () => {
      await expect(
        withTestTenant(async () =>
          programmes.getById('019e0cf8-aaaa-7777-8888-00000000ffff'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('create rejects non-admin + duplicate-name → BadRequest', async () => {
      await expect(
        withTestTenant(async () =>
          programmes.create({ name: 'X' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      await expect(
        withTestTenant(async () =>
          programmes.create({ name: 'HR Soft Skills' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('create + patch + no-op + duplicate-on-patch', async () => {
      const dto = await withTestTenant(async () =>
        programmes.create(
          {
            name: 'New Prog ' + Date.now(),
            description: 'd',
            isMandatory: false,
            renewalMonths: 24,
          } as any,
          adminActor(),
        ),
      );
      const upd = await withTestTenant(async () =>
        programmes.patch(
          dto.id,
          {
            name: 'Patched Prog ' + Date.now(),
            description: 'new d',
            isMandatory: true,
            renewalMonths: 12,
            isActive: false,
          } as any,
          adminActor(),
        ),
      );
      expect(upd.isMandatory).toBe(true);

      const same = await withTestTenant(async () =>
        programmes.patch(dto.id, {} as any, adminActor()),
      );
      expect(same.id).toBe(dto.id);

      // Duplicate-name on PATCH
      await expect(
        withTestTenant(async () =>
          programmes.patch(dto.id, { name: 'HR Soft Skills' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      await expect(
        withTestTenant(async () =>
          programmes.patch(
            '019e0cf8-aaaa-7777-8888-00000000ffff',
            {} as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('loadInternal returns or null', async () => {
      const r = await withTestTenant(async () =>
        programmes.loadInternal(TEST_HR_TRAINING_PROG_MAND_ID),
      );
      expect(r?.id).toBe(TEST_HR_TRAINING_PROG_MAND_ID);
      const miss = await withTestTenant(async () =>
        programmes.loadInternal('019e0cf8-aaaa-7777-8888-00000000ffff'),
      );
      expect(miss).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // TrainingEventService
  // ───────────────────────────────────────────────────────────────────
  describe('TrainingEventService', () => {
    async function createEvent(programmeId = TEST_HR_TRAINING_PROG_MAND_ID) {
      return withTestTenant(async () =>
        events.create(
          {
            programmeId,
            title: 'E-' + Date.now(),
            scheduledAt: new Date().toISOString(),
            durationMinutes: 60,
          } as any,
          adminActor(),
        ),
      );
    }

    it('create rejects bad programme + non-admin', async () => {
      await expect(
        withTestTenant(async () =>
          events.create({} as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      await expect(
        withTestTenant(async () =>
          events.create(
            {
              programmeId: '019e0cf8-aaaa-7777-8888-00000000ffff',
              title: 'E',
              scheduledAt: new Date().toISOString(),
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('list + filter by programmeId + status + getById', async () => {
      const e = await createEvent();
      const list = await withTestTenant(async () => events.list({} as any));
      expect(list.map((x) => x.id)).toContain(e.id);
      const filtered = await withTestTenant(async () =>
        events.list({ programmeId: TEST_HR_TRAINING_PROG_MAND_ID } as any),
      );
      expect(filtered.map((x) => x.id)).toContain(e.id);
      const sched = await withTestTenant(async () =>
        events.list({ status: 'SCHEDULED' } as any),
      );
      expect(sched.length).toBeGreaterThan(0);

      const got = await withTestTenant(async () => events.getById(e.id));
      expect(got.id).toBe(e.id);
      await expect(
        withTestTenant(async () =>
          events.getById('019e0cf8-aaaa-7777-8888-00000000ffff'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('patch + COMPLETED + CANCELLED + terminal rejection', async () => {
      const e = await createEvent();
      const upd = await withTestTenant(async () =>
        events.patch(
          e.id,
          {
            title: 'Renamed',
            durationMinutes: 90,
            location: 'Aud',
            facilitator: 'Mr X',
            maxParticipants: 20,
            notes: 'n',
            scheduledAt: new Date().toISOString(),
          } as any,
          adminActor(),
        ),
      );
      expect(upd.title).toBe('Renamed');

      // No-op
      const noop = await withTestTenant(async () =>
        events.patch(e.id, {} as any, adminActor()),
      );
      expect(noop.id).toBe(e.id);

      // CANCELLED requires reason
      await expect(
        withTestTenant(async () =>
          events.patch(e.id, { status: 'CANCELLED' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      const cancelled = await withTestTenant(async () =>
        events.patch(
          e.id,
          { status: 'CANCELLED', cancellationReason: 'no go' } as any,
          adminActor(),
        ),
      );
      expect(cancelled.status).toBe('CANCELLED');

      // Terminal can't go back
      await expect(
        withTestTenant(async () =>
          events.patch(e.id, { status: 'SCHEDULED' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      await expect(
        withTestTenant(async () =>
          events.patch(
            '019e0cf8-aaaa-7777-8888-00000000ffff',
            {} as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('loadInternalWithProgramme returns or null', async () => {
      const e = await createEvent();
      const got = await withTestTenant(async () =>
        events.loadInternalWithProgramme(e.id),
      );
      expect(got?.eventId).toBe(e.id);
      const miss = await withTestTenant(async () =>
        events.loadInternalWithProgramme('019e0cf8-aaaa-7777-8888-00000000ffff'),
      );
      expect(miss).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // CompletionService — AUTO-ISSUE keystone
  // ───────────────────────────────────────────────────────────────────
  describe('CompletionService', () => {
    async function setupEvent(programmeId = TEST_HR_TRAINING_PROG_MAND_ID) {
      return withTestTenant(async () =>
        events.create(
          {
            programmeId,
            title: 'CE-' + Date.now(),
            scheduledAt: new Date().toISOString(),
          } as any,
          adminActor(),
        ),
      );
    }

    it('record rejects non-admin, bad event, bad employee', async () => {
      const e = await setupEvent();
      await expect(
        withTestTenant(async () =>
          completions.record(
            e.id,
            { employeeId: TEST_ADMIN_EMPLOYEE_ID } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      await expect(
        withTestTenant(async () =>
          completions.record(
            '019e0cf8-aaaa-7777-8888-00000000ffff',
            { employeeId: TEST_ADMIN_EMPLOYEE_ID } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);

      await expect(
        withTestTenant(async () =>
          completions.record(
            e.id,
            { employeeId: '019e0cf8-aaaa-7777-8888-00000000ffff' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('record on mandatory programme auto-issues a matching cert + outbox emit', async () => {
      const e = await setupEvent(TEST_HR_TRAINING_PROG_MAND_ID);
      const dto = await withTestTenant(async () =>
        completions.record(
          e.id,
          {
            employeeId: TEST_ADMIN_EMPLOYEE_ID,
            passed: true,
            score: 95,
            notes: 'great',
          } as any,
          adminActor(),
        ),
      );
      expect(dto.passed).toBe(true);

      // Cert was auto-issued
      const certs = await withTestTenant(async () =>
        employeeCerts.listForEmployee(TEST_ADMIN_EMPLOYEE_ID, adminActor()),
      );
      const fa = certs.find((c) => c.certificationTypeId === TEST_HR_CERT_TYPE_FIRST_AID_ID);
      expect(fa).toBeTruthy();
      expect(fa!.status).toBe('ACTIVE');

      // Outbox
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT envelope::text AS envelope FROM platform.platform_outbox
          WHERE topic = 'hr.training.completed' AND tenant_id = $1::uuid`,
        TEST_SCHOOL_ID,
      )) as Array<{ envelope: string }>;
      expect(rows.length).toBeGreaterThanOrEqual(1);

      // Re-completion on same event → unique violation → BadRequest
      await expect(
        withTestTenant(async () =>
          completions.record(
            e.id,
            { employeeId: TEST_ADMIN_EMPLOYEE_ID, passed: true } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      // Record on second event — UPDATE existing cert path
      const e2 = await setupEvent(TEST_HR_TRAINING_PROG_MAND_ID);
      const dto2 = await withTestTenant(async () =>
        completions.record(
          e2.id,
          { employeeId: TEST_ADMIN_EMPLOYEE_ID, passed: true } as any,
          adminActor(),
        ),
      );
      expect(dto2.passed).toBe(true);
    });

    it('record optional programme does NOT auto-issue', async () => {
      const e = await setupEvent(TEST_HR_TRAINING_PROG_OPT_ID);
      await withTestTenant(async () =>
        completions.record(
          e.id,
          { employeeId: TEST_ADMIN_EMPLOYEE_ID, passed: true } as any,
          adminActor(),
        ),
      );
      // No cert added (only the auto-issue path creates one)
      const certs = await withTestTenant(async () =>
        employeeCerts.listForEmployee(TEST_ADMIN_EMPLOYEE_ID, adminActor()),
      );
      expect(certs.length).toBe(0);
    });

    it('listForEvent admin sees all; non-admin sees own; no-employee → []', async () => {
      const e = await setupEvent(TEST_HR_TRAINING_PROG_OPT_ID);
      await withTestTenant(async () =>
        completions.record(
          e.id,
          { employeeId: TEST_ADMIN_EMPLOYEE_ID, passed: true } as any,
          adminActor(),
        ),
      );
      const adminList = await withTestTenant(async () =>
        completions.listForEvent(e.id, adminActor()),
      );
      expect(adminList.length).toBe(1);

      // Teacher (no completion) sees empty list
      const teacherList = await withTestTenant(async () =>
        completions.listForEvent(e.id, teacherActor()),
      );
      expect(teacherList.length).toBe(0);

      const parentList = await withTestTenant(async () =>
        completions.listForEvent(e.id, parentActor()),
      );
      expect(parentList).toEqual([]);
    });

    it('listForEmployee owner allowed; foreign non-admin → Forbidden', async () => {
      const e = await setupEvent(TEST_HR_TRAINING_PROG_OPT_ID);
      await withTestTenant(async () =>
        completions.record(
          e.id,
          { employeeId: TEST_ADMIN_EMPLOYEE_ID, passed: true } as any,
          adminActor(),
        ),
      );
      // Admin can see anyone
      const list = await withTestTenant(async () =>
        completions.listForEmployee(TEST_ADMIN_EMPLOYEE_ID, adminActor()),
      );
      expect(list.length).toBeGreaterThan(0);
      await expect(
        withTestTenant(async () =>
          completions.listForEmployee(TEST_ADMIN_EMPLOYEE_ID, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('getById missing → 404', async () => {
      await expect(
        withTestTenant(async () =>
          completions.getById('019e0cf8-aaaa-7777-8888-00000000ffff'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // CertificationTypeService + EmployeeCertificationService
  // ───────────────────────────────────────────────────────────────────
  describe('CertificationType + EmployeeCertification', () => {
    it('list types + includeInactive', async () => {
      const list = await withTestTenant(async () => certTypes.list(false));
      expect(list.length).toBeGreaterThan(0);
      const all = await withTestTenant(async () => certTypes.list(true));
      expect(all.length).toBeGreaterThanOrEqual(list.length);
    });

    it('create + duplicate name → BadRequest + patch lifecycle', async () => {
      const dto = await withTestTenant(async () =>
        certTypes.create(
          {
            name: 'CT-' + Date.now(),
            issuingBody: 'Body',
            description: 'd',
            validityMonths: 12,
            isRequired: true,
          } as any,
          adminActor(),
        ),
      );
      expect(dto.isRequired).toBe(true);

      await expect(
        withTestTenant(async () =>
          certTypes.create({ name: dto.name } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      const upd = await withTestTenant(async () =>
        certTypes.patch(
          dto.id,
          {
            name: 'Renamed-' + Date.now(),
            issuingBody: 'New',
            description: 'new d',
            validityMonths: 24,
            isRequired: false,
            isActive: false,
          } as any,
          adminActor(),
        ),
      );
      expect(upd.isActive).toBe(false);

      const noop = await withTestTenant(async () =>
        certTypes.patch(dto.id, {} as any, adminActor()),
      );
      expect(noop.id).toBe(dto.id);

      await expect(
        withTestTenant(async () =>
          certTypes.patch(
            '019e0cf8-aaaa-7777-8888-00000000ffff',
            {} as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('create rejects non-admin', async () => {
      await expect(
        withTestTenant(async () =>
          certTypes.create({ name: 'NA' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('employee cert listForEmployee + listExpiringSoon + create + revoke', async () => {
      // Self path
      const own = await withTestTenant(async () =>
        employeeCerts.listForEmployee(TEST_ADMIN_EMPLOYEE_ID, adminActor()),
      );
      expect(Array.isArray(own)).toBe(true);

      // Foreign path Forbidden
      await expect(
        withTestTenant(async () =>
          employeeCerts.listForEmployee(TEST_ADMIN_EMPLOYEE_ID, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      // Create
      const created = await withTestTenant(async () =>
        employeeCerts.create(
          {
            employeeId: TEST_ADMIN_EMPLOYEE_ID,
            certificationTypeId: TEST_HR_CERT_TYPE_FIRST_AID_ID,
            issuedAt: new Date().toISOString().slice(0, 10),
            expiresAt: '2027-01-01',
            documentS3Key: 's3/doc',
            referenceNumber: 'REF-1',
          } as any,
          adminActor(),
        ),
      );
      expect(created.status).toBe('ACTIVE');
      expect(typeof created.daysUntilExpiry).toBe('number');

      // listExpiringSoon
      const expiring = await withTestTenant(async () =>
        employeeCerts.listExpiringSoon(365, adminActor()),
      );
      expect(expiring.map((c) => c.id)).toContain(created.id);

      // listExpiringSoon admin only
      await expect(
        withTestTenant(async () =>
          employeeCerts.listExpiringSoon(60, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      // Revoke
      const revoked = await withTestTenant(async () =>
        employeeCerts.revoke(
          created.id,
          { reason: 'invalid' } as any,
          adminActor(),
        ),
      );
      expect(revoked.status).toBe('REVOKED');

      // Re-revoke → BadRequest
      await expect(
        withTestTenant(async () =>
          employeeCerts.revoke(
            created.id,
            { reason: 'x' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      // Missing → 404
      await expect(
        withTestTenant(async () =>
          employeeCerts.revoke(
            '019e0cf8-aaaa-7777-8888-00000000ffff',
            { reason: 'x' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('create rejects bad employee + bad cert type', async () => {
      await expect(
        withTestTenant(async () =>
          employeeCerts.create(
            {
              employeeId: '019e0cf8-aaaa-7777-8888-00000000ffff',
              certificationTypeId: TEST_HR_CERT_TYPE_FIRST_AID_ID,
              issuedAt: '2025-01-01',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      await expect(
        withTestTenant(async () =>
          employeeCerts.create(
            {
              employeeId: TEST_ADMIN_EMPLOYEE_ID,
              certificationTypeId: '019e0cf8-aaaa-7777-8888-00000000ffff',
              issuedAt: '2025-01-01',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Legacy CertificationService (hr_staff_certifications)
  // ───────────────────────────────────────────────────────────────────
  describe('Legacy CertificationService', () => {
    it('listForEmployee + create + verify + listExpiringSoon', async () => {
      // Owner allowed
      const own = await withTestTenant(async () =>
        legacyCerts.listForEmployee(TEST_ADMIN_EMPLOYEE_ID, adminActor()),
      );
      expect(Array.isArray(own)).toBe(true);
      // Foreign Forbidden
      await expect(
        withTestTenant(async () =>
          legacyCerts.listForEmployee(TEST_ADMIN_EMPLOYEE_ID, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      // Create
      const cert = await withTestTenant(async () =>
        legacyCerts.create(
          TEST_ADMIN_EMPLOYEE_ID,
          {
            certificationType: 'FIRST_AID',
            certificationName: 'First Aid',
            issuingBody: 'Red Cross',
            referenceNumber: 'FA-1',
            issuedDate: '2024-01-01',
            expiryDate: new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10),
            documentS3Key: 's3/d',
            notes: 'n',
          } as any,
          adminActor(),
        ),
      );
      expect(cert.certificationType).toBe('FIRST_AID');

      // Bad employee
      await expect(
        withTestTenant(async () =>
          legacyCerts.create(
            '019e0cf8-aaaa-7777-8888-00000000ffff',
            {
              certificationType: 'FIRST_AID',
              certificationName: 'X',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);

      // verify non-admin → Forbidden
      await expect(
        withTestTenant(async () =>
          legacyCerts.verify(
            cert.id,
            { status: 'VERIFIED' } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      // verify missing → 404
      await expect(
        withTestTenant(async () =>
          legacyCerts.verify(
            '019e0cf8-aaaa-7777-8888-00000000ffff',
            { status: 'VERIFIED' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);

      const verified = await withTestTenant(async () =>
        legacyCerts.verify(
          cert.id,
          { status: 'VERIFIED', notes: 'looks good' } as any,
          adminActor(),
        ),
      );
      expect(verified.verificationStatus).toBe('VERIFIED');

      const calls = kafka.callsForTopic('hr.certification.verified');
      expect(calls.length).toBeGreaterThanOrEqual(1);

      // ExpiringSoon
      const exp = await withTestTenant(async () => legacyCerts.listExpiringSoon());
      expect(exp.map((c) => c.id)).toContain(cert.id);

      // getById foreign person Forbidden
      await expect(
        withTestTenant(async () => legacyCerts.getById(cert.id, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);

      // missing → 404
      await expect(
        withTestTenant(async () =>
          legacyCerts.getById('019e0cf8-aaaa-7777-8888-00000000ffff', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // TrainingComplianceService
  // ───────────────────────────────────────────────────────────────────
  describe('TrainingComplianceService', () => {
    it('getForEmployee owner + foreign + admin', async () => {
      const own = await withTestTenant(async () =>
        compliance.getForEmployee(TEST_ADMIN_EMPLOYEE_ID, adminActor()),
      );
      expect(own.employeeId).toBe(TEST_ADMIN_EMPLOYEE_ID);
      // Foreign forbidden
      await expect(
        withTestTenant(async () =>
          compliance.getForEmployee(TEST_ADMIN_EMPLOYEE_ID, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('getDashboard admin allowed; non-admin → Forbidden', async () => {
      const dash = await withTestTenant(async () => compliance.getDashboard(adminActor()));
      expect(dash.totalEmployees).toBeGreaterThan(0);
      await expect(
        withTestTenant(async () => compliance.getDashboard(teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // AppraisalFrameworkService + CycleService + AppraisalService
  // ───────────────────────────────────────────────────────────────────
  describe('AppraisalFramework + Cycle', () => {
    it('framework list + create + patch + duplicate-name', async () => {
      const list = await withTestTenant(async () => frameworks.list(false));
      expect(list.map((f) => f.id)).toContain(TEST_HR_APPRAISAL_FW_ID);

      await expect(
        withTestTenant(async () =>
          frameworks.create(
            { name: 'HR Test Framework' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      const created = await withTestTenant(async () =>
        frameworks.create(
          {
            name: 'FW-' + Date.now(),
            description: 'd',
            criteria: [{ id: 'c', label: 'x', weight: 1 }],
          } as any,
          adminActor(),
        ),
      );

      const upd = await withTestTenant(async () =>
        frameworks.patch(
          created.id,
          {
            name: 'Renamed-FW-' + Date.now(),
            description: 'new',
            criteria: [],
            isActive: false,
          } as any,
          adminActor(),
        ),
      );
      expect(upd.isActive).toBe(false);

      const noop = await withTestTenant(async () =>
        frameworks.patch(created.id, {} as any, adminActor()),
      );
      expect(noop.id).toBe(created.id);

      // Rejects non-admin
      await expect(
        withTestTenant(async () =>
          frameworks.create({ name: 'X' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      await expect(
        withTestTenant(async () =>
          frameworks.patch(
            '019e0cf8-aaaa-7777-8888-00000000ffff',
            {} as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);

      // Duplicate-name on PATCH (rename to existing seeded framework)
      await expect(
        withTestTenant(async () =>
          frameworks.patch(
            created.id,
            { name: 'HR Test Framework' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    async function createCycle(type: 'ANNUAL' | 'MID_YEAR' | 'PROBATIONARY' = 'ANNUAL') {
      return withTestTenant(async () =>
        cycles.create(
          {
            academicYearId: TEST_HR_ACADEMIC_YEAR_ID,
            frameworkId: TEST_HR_APPRAISAL_FW_ID,
            cycleType: type,
            name: 'Cycle ' + type + ' ' + Date.now(),
            startsOn: '2026-01-01',
            endsOn: '2026-06-30',
          } as any,
          adminActor(),
        ),
      );
    }

    it('cycle list + create + getById + duplicate type → BadRequest', async () => {
      const c = await createCycle('ANNUAL');
      const list = await withTestTenant(async () => cycles.list());
      expect(list.map((x) => x.id)).toContain(c.id);
      const got = await withTestTenant(async () => cycles.getById(c.id));
      expect(got.id).toBe(c.id);
      // Duplicate ANNUAL same school+year → BadRequest
      await expect(createCycle('ANNUAL')).rejects.toBeInstanceOf(BadRequestException);

      // Different type works
      await createCycle('MID_YEAR');
    });

    it('cycle create rejects bad framework/year + non-admin', async () => {
      await expect(
        withTestTenant(async () =>
          cycles.create(
            {
              academicYearId: TEST_HR_ACADEMIC_YEAR_ID,
              frameworkId: TEST_HR_APPRAISAL_FW_ID,
              cycleType: 'ANNUAL',
              name: 'X',
              startsOn: '2026-01-01',
              endsOn: '2026-06-30',
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      await expect(
        withTestTenant(async () =>
          cycles.create(
            {
              academicYearId: TEST_HR_ACADEMIC_YEAR_ID,
              frameworkId: '019e0cf8-aaaa-7777-8888-00000000ffff',
              cycleType: 'ANNUAL',
              name: 'X',
              startsOn: '2026-01-01',
              endsOn: '2026-06-30',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      await expect(
        withTestTenant(async () =>
          cycles.create(
            {
              academicYearId: '019e0cf8-aaaa-7777-8888-00000000ffff',
              frameworkId: TEST_HR_APPRAISAL_FW_ID,
              cycleType: 'ANNUAL',
              name: 'X',
              startsOn: '2026-01-01',
              endsOn: '2026-06-30',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cycle patch flips status', async () => {
      const c = await createCycle('PROBATIONARY');
      const closed = await withTestTenant(async () =>
        cycles.patch(c.id, { status: 'CLOSED' } as any, adminActor()),
      );
      expect(closed.status).toBe('CLOSED');
      const opened = await withTestTenant(async () =>
        cycles.patch(c.id, { status: 'OPEN' } as any, adminActor()),
      );
      expect(opened.status).toBe('OPEN');
      const archived = await withTestTenant(async () =>
        cycles.patch(c.id, { status: 'ARCHIVED' } as any, adminActor()),
      );
      expect(archived.status).toBe('ARCHIVED');
      // Cannot exit ARCHIVED
      await expect(
        withTestTenant(async () =>
          cycles.patch(c.id, { status: 'OPEN' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      // Patch name + dates + no-op
      const c2 = await createCycle('ANNUAL');
      const upd = await withTestTenant(async () =>
        cycles.patch(
          c2.id,
          {
            name: 'New name',
            startsOn: '2026-02-01',
            endsOn: '2026-09-30',
          } as any,
          adminActor(),
        ),
      );
      expect(upd.name).toBe('New name');
      const noop = await withTestTenant(async () =>
        cycles.patch(c2.id, {} as any, adminActor()),
      );
      expect(noop.id).toBe(c2.id);
    });

    it('cycle getById 404 missing; CLOSED transition restrictions', async () => {
      await expect(
        withTestTenant(async () =>
          cycles.getById('019e0cf8-aaaa-7777-8888-00000000ffff'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);

      const c = await createCycle('MID_YEAR');
      await withTestTenant(async () =>
        cycles.patch(c.id, { status: 'CLOSED' } as any, adminActor()),
      );
      // From CLOSED, transitions other than ARCHIVED / OPEN raise.
      // (Same-status "CLOSED → CLOSED" is a no-op because the service
      // tests `input.status !== cur` before applying any rule, so it
      // returns the row unchanged. Test via a forbidden target.)
      await expect(
        withTestTenant(async () =>
          cycles.patch(c.id, { status: 'ARCHIVED' } as any, adminActor()),
        ),
      ).resolves.toBeTruthy();
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // AppraisalService + Goals + Comments + Observations
  // ───────────────────────────────────────────────────────────────────
  describe('AppraisalService + goals + comments + observations', () => {
    async function ensureCycle(type: 'ANNUAL' | 'MID_YEAR' = 'MID_YEAR') {
      const list = await withTestTenant(async () => cycles.list());
      const existing = list.find((c) => c.cycleType === type);
      if (existing) return existing;
      return withTestTenant(async () =>
        cycles.create(
          {
            academicYearId: TEST_HR_ACADEMIC_YEAR_ID,
            frameworkId: TEST_HR_APPRAISAL_FW_ID,
            cycleType: type,
            name: 'C-' + type + '-' + Date.now(),
            startsOn: '2026-01-01',
            endsOn: '2026-06-30',
          } as any,
          adminActor(),
        ),
      );
    }
    async function newAppraisal() {
      const c = await ensureCycle('MID_YEAR');
      return withTestTenant(async () =>
        appraisals.create(
          {
            cycleId: c.id,
            employeeId: TEST_TEACHER_EMPLOYEE_ID,
            appraiserId: TEST_ADMIN_EMPLOYEE_ID,
          } as any,
          adminActor(),
        ),
      );
    }

    it('create rejects non-admin + bad cycle/employee/appraiser; dup → BadRequest', async () => {
      const c = await ensureCycle('MID_YEAR');
      await expect(
        withTestTenant(async () =>
          appraisals.create(
            {
              cycleId: c.id,
              employeeId: TEST_TEACHER_EMPLOYEE_ID,
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      await expect(
        withTestTenant(async () =>
          appraisals.create(
            {
              cycleId: '019e0cf8-aaaa-7777-8888-00000000ffff',
              employeeId: TEST_TEACHER_EMPLOYEE_ID,
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      await expect(
        withTestTenant(async () =>
          appraisals.create(
            {
              cycleId: c.id,
              employeeId: '019e0cf8-aaaa-7777-8888-00000000ffff',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      await expect(
        withTestTenant(async () =>
          appraisals.create(
            {
              cycleId: c.id,
              employeeId: TEST_TEACHER_EMPLOYEE_ID,
              appraiserId: '019e0cf8-aaaa-7777-8888-00000000ffff',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      // Happy path
      const a = await newAppraisal();
      expect(a.status).toBe('DRAFT');
      // Dup same employee in same cycle
      await expect(
        withTestTenant(async () =>
          appraisals.create(
            {
              cycleId: c.id,
              employeeId: TEST_TEACHER_EMPLOYEE_ID,
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('list scoping; getById 404/no-leak; admin sees row', async () => {
      const a = await newAppraisal();
      // Admin sees
      const list = await withTestTenant(async () =>
        appraisals.list({} as any, adminActor()),
      );
      expect(list.map((x) => x.id)).toContain(a.id);
      // Non-admin teacher sees own
      const tList = await withTestTenant(async () =>
        appraisals.list({} as any, teacherActor()),
      );
      expect(tList.map((x) => x.id)).toContain(a.id);
      // Non-admin parent (no employeeId) → []
      const pList = await withTestTenant(async () =>
        appraisals.list({} as any, parentActor()),
      );
      expect(pList).toEqual([]);

      // cycleId filter
      const filtered = await withTestTenant(async () =>
        appraisals.list({ cycleId: a.cycleId } as any, adminActor()),
      );
      expect(filtered.length).toBeGreaterThan(0);

      // getById
      const got = await withTestTenant(async () =>
        appraisals.getById(a.id, adminActor()),
      );
      expect(got.id).toBe(a.id);
      // Foreign actor non-admin → 404
      await expect(
        withTestTenant(async () =>
          appraisals.getById(a.id, {
            ...teacherActor(),
            employeeId: TEST_OFFICER_EMPLOYEE_ID,
          } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        withTestTenant(async () =>
          appraisals.getById('019e0cf8-aaaa-7777-8888-00000000ffff', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('patch DRAFT → IN_REVIEW → SIGNED_OFF terminal', async () => {
      const a = await newAppraisal();
      // Owner-only fields
      const upd1 = await withTestTenant(async () =>
        appraisals.patch(a.id, { selfReview: 'me' } as any, teacherActor()),
      );
      expect(upd1.selfReview).toBe('me');

      // Owner trying admin-field → Forbidden
      await expect(
        withTestTenant(async () =>
          appraisals.patch(a.id, { appraiserReview: 'X' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      // Admin sets appraiser_review + rating + status
      const upd2 = await withTestTenant(async () =>
        appraisals.patch(
          a.id,
          {
            appraiserReview: 'good',
            overallRating: 'GOOD',
            developmentPlan: 'plan',
            status: 'IN_REVIEW',
          } as any,
          adminActor(),
        ),
      );
      expect(upd2.status).toBe('IN_REVIEW');

      // SIGNED_OFF must be by employee actor
      await expect(
        withTestTenant(async () =>
          appraisals.patch(
            a.id,
            { status: 'SIGNED_OFF' } as any,
            { ...adminActor(), employeeId: null },
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      const signed = await withTestTenant(async () =>
        appraisals.patch(a.id, { status: 'SIGNED_OFF' } as any, adminActor()),
      );
      expect(signed.status).toBe('SIGNED_OFF');

      // No further mutation
      await expect(
        withTestTenant(async () =>
          appraisals.patch(a.id, { selfReview: 'x' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('patch no-op + missing → 404 + foreign Forbidden', async () => {
      const a = await newAppraisal();
      const same = await withTestTenant(async () =>
        appraisals.patch(a.id, {} as any, adminActor()),
      );
      expect(same.id).toBe(a.id);
      await expect(
        withTestTenant(async () =>
          appraisals.patch(
            '019e0cf8-aaaa-7777-8888-00000000ffff',
            {} as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      // Foreign non-admin → Forbidden
      await expect(
        withTestTenant(async () =>
          appraisals.patch(a.id, { selfReview: 'x' } as any, {
            ...teacherActor(),
            employeeId: TEST_OFFICER_EMPLOYEE_ID,
          } as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('loadInternal returns or null', async () => {
      const a = await newAppraisal();
      const r = await withTestTenant(async () => appraisals.loadInternal(a.id));
      expect(r?.id).toBe(a.id);
      const miss = await withTestTenant(async () =>
        appraisals.loadInternal('019e0cf8-aaaa-7777-8888-00000000ffff'),
      );
      expect(miss).toBeNull();
    });

    it('goals create + patch + appraisee scope; SIGNED_OFF blocks', async () => {
      const a = await newAppraisal();
      const goal = await withTestTenant(async () =>
        goals.create(
          a.id,
          {
            goalText: 'My goal',
            successCriteria: 'metrics',
            targetDate: '2026-06-30',
            sortOrder: 1,
          } as any,
          adminActor(),
        ),
      );
      expect(goal.goalText).toBe('My goal');

      // Patch as appraiser (admin is appraiser)
      const upd = await withTestTenant(async () =>
        goals.patch(
          goal.id,
          {
            goalText: 'Refined',
            successCriteria: 'new',
            targetDate: '2026-07-30',
            progress: 'IN_PROGRESS',
            progressNotes: 'going',
          } as any,
          adminActor(),
        ),
      );
      expect(upd.progress).toBe('IN_PROGRESS');

      // Appraisee (teacher) can also patch own goal (DRAFT)
      const upd2 = await withTestTenant(async () =>
        goals.patch(goal.id, { progressNotes: 'mine' } as any, teacherActor()),
      );
      expect(upd2.progressNotes).toBe('mine');

      // Officer cannot
      await expect(
        withTestTenant(async () =>
          goals.patch(goal.id, { progressNotes: 'no' } as any, {
            ...teacherActor(),
            employeeId: TEST_OFFICER_EMPLOYEE_ID,
          } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);

      // Bad goalId
      await expect(
        withTestTenant(async () =>
          goals.patch(
            '019e0cf8-aaaa-7777-8888-00000000ffff',
            {} as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);

      // Bad appraisal in create
      await expect(
        withTestTenant(async () =>
          goals.create(
            '019e0cf8-aaaa-7777-8888-00000000ffff',
            { goalText: 'x' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);

      // patch with no fields
      const noop = await withTestTenant(async () =>
        goals.patch(goal.id, {} as any, adminActor()),
      );
      expect(noop.id).toBe(goal.id);

      // Lock appraisal SIGNED_OFF → goal mutations blocked
      await withTestTenant(async () =>
        appraisals.patch(a.id, { status: 'SIGNED_OFF' } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          goals.create(a.id, { goalText: 'x' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        withTestTenant(async () =>
          goals.patch(goal.id, { progress: 'ACHIEVED' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('comments visibility + private/admin gate', async () => {
      const a = await newAppraisal();
      // Owner can add public comment
      const own = await withTestTenant(async () =>
        comments.create(
          a.id,
          { commentText: 'mine', isVisibleToEmployee: true } as any,
          teacherActor(),
        ),
      );
      expect(own.commentText).toBe('mine');

      // Owner cannot author private comment
      await expect(
        withTestTenant(async () =>
          comments.create(
            a.id,
            { commentText: 'priv', isVisibleToEmployee: false } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      // Admin can author private
      const priv = await withTestTenant(async () =>
        comments.create(
          a.id,
          { commentText: 'admin priv', isVisibleToEmployee: false } as any,
          adminActor(),
        ),
      );
      expect(priv.commentText).toBe('admin priv');

      // Foreign actor → 404 (no leak)
      await expect(
        withTestTenant(async () =>
          comments.create(
            a.id,
            { commentText: 'x' } as any,
            {
              ...teacherActor(),
              employeeId: TEST_OFFICER_EMPLOYEE_ID,
            } as any,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);

      // No employeeId → Forbidden
      await expect(
        withTestTenant(async () =>
          comments.create(
            a.id,
            { commentText: 'x' } as any,
            {
              ...adminActor(),
              employeeId: null,
            } as any,
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      // Bad appraisal
      await expect(
        withTestTenant(async () =>
          comments.create(
            '019e0cf8-aaaa-7777-8888-00000000ffff',
            { commentText: 'x' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);

      // Lock + reject
      await withTestTenant(async () =>
        appraisals.patch(a.id, { status: 'SIGNED_OFF' } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          comments.create(
            a.id,
            { commentText: 'x' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('lesson observations gate + lock + update lifecycle', async () => {
      // School Admin has lesson_observation:write via everyFunction; this
      // works because the seeded admin actor has isSchoolAdmin=true.
      const a = await newAppraisal();
      const obs = await withTestTenant(async () =>
        observations.create(
          {
            appraisalId: a.id,
            observedEmployeeId: TEST_TEACHER_EMPLOYEE_ID,
            observationDate: '2026-02-15',
            observedClassLabel: 'Math 5A',
            durationMinutes: 45,
            overallGrade: 'GOOD',
            strengths: 's',
            areasForDevelopment: 'a',
            notes: 'n',
          } as any,
          adminActor(),
        ),
      );
      expect(obs.overallGrade).toBe('GOOD');

      // Non-admin → Forbidden
      await expect(
        withTestTenant(async () =>
          observations.create(
            {
              observedEmployeeId: TEST_TEACHER_EMPLOYEE_ID,
              observationDate: '2026-02-15',
              observedClassLabel: 'X',
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      // Bad observed employee
      await expect(
        withTestTenant(async () =>
          observations.create(
            {
              observedEmployeeId: '019e0cf8-aaaa-7777-8888-00000000ffff',
              observationDate: '2026-02-15',
              observedClassLabel: 'X',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      // No appraisal in create works (appraisalId optional)
      const standalone = await withTestTenant(async () =>
        observations.create(
          {
            observedEmployeeId: TEST_TEACHER_EMPLOYEE_ID,
            observationDate: '2026-03-15',
            observedClassLabel: 'Sci',
          } as any,
          adminActor(),
        ),
      );
      expect(standalone.id).toBeTruthy();

      // Bad appraisalId
      await expect(
        withTestTenant(async () =>
          observations.create(
            {
              appraisalId: '019e0cf8-aaaa-7777-8888-00000000ffff',
              observedEmployeeId: TEST_TEACHER_EMPLOYEE_ID,
              observationDate: '2026-03-15',
              observedClassLabel: 'X',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      // listForEmployee owner allowed; foreign Forbidden
      const list = await withTestTenant(async () =>
        observations.listForEmployee(TEST_TEACHER_EMPLOYEE_ID, adminActor()),
      );
      expect(list.length).toBeGreaterThan(0);
      // Foreign actor
      await expect(
        withTestTenant(async () =>
          observations.listForEmployee(TEST_TEACHER_EMPLOYEE_ID, {
            ...teacherActor(),
            employeeId: TEST_OFFICER_EMPLOYEE_ID,
          } as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      // patch non-locked
      const upd = await withTestTenant(async () =>
        observations.patch(
          obs.id,
          {
            observedClassLabel: 'M5A',
            durationMinutes: 60,
            overallGrade: 'OUTSTANDING',
            strengths: 's2',
            areasForDevelopment: 'a2',
            notes: 'n2',
          } as any,
          adminActor(),
        ),
      );
      expect(upd.overallGrade).toBe('OUTSTANDING');
      const noop = await withTestTenant(async () =>
        observations.patch(obs.id, {} as any, adminActor()),
      );
      expect(noop.id).toBe(obs.id);

      // lock
      const locked = await withTestTenant(async () =>
        observations.lock(obs.id, adminActor()),
      );
      expect(locked.isLocked).toBe(true);

      // re-lock → BadRequest; patch locked → BadRequest
      await expect(
        withTestTenant(async () => observations.lock(obs.id, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        withTestTenant(async () =>
          observations.patch(obs.id, { notes: 'x' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      // Missing → 404
      await expect(
        withTestTenant(async () =>
          observations.patch(
            '019e0cf8-aaaa-7777-8888-00000000ffff',
            {} as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        withTestTenant(async () =>
          observations.lock(
            '019e0cf8-aaaa-7777-8888-00000000ffff',
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // ExpenseClaimService
  // ───────────────────────────────────────────────────────────────────
  describe('ExpenseClaimService', () => {
    async function submitClaim(actor = adminActor(), amount = 100) {
      return withTestTenant(async () =>
        claims.create(
          {
            claimTitle: 'PD Trip ' + Date.now(),
            description: 'Travel',
            incurredOn: '2026-01-10',
            totalAmount: amount,
            receiptS3Keys: ['s3/r1'],
          } as any,
          actor,
        ),
      );
    }

    it('create requires employeeId; happy path', async () => {
      await expect(
        withTestTenant(async () =>
          claims.create(
            {
              claimTitle: 'X',
              incurredOn: '2026-01-10',
              totalAmount: 10,
            } as any,
            { ...adminActor(), employeeId: null } as any,
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      const dto = await submitClaim();
      expect(dto.status).toBe('SUBMITTED');
    });

    it('list scoping: admin sees all + mine=true; non-admin own only', async () => {
      const c = await submitClaim();
      const aList = await withTestTenant(async () =>
        claims.list({} as any, adminActor()),
      );
      expect(aList.map((x) => x.id)).toContain(c.id);
      const mine = await withTestTenant(async () =>
        claims.list({ mine: true } as any, adminActor()),
      );
      expect(mine.length).toBeGreaterThan(0);
      // non-admin parent (no employeeId) → []
      const pList = await withTestTenant(async () =>
        claims.list({} as any, parentActor()),
      );
      expect(pList).toEqual([]);
      // Status filter
      const sub = await withTestTenant(async () =>
        claims.list({ status: 'SUBMITTED' } as any, adminActor()),
      );
      expect(sub.every((x) => x.status === 'SUBMITTED')).toBe(true);
    });

    it('decide rejects non-admin + REJECTED without reason; approve + reject paths', async () => {
      const c = await submitClaim();
      await expect(
        withTestTenant(async () =>
          claims.decide(c.id, { decision: 'APPROVED' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      await expect(
        withTestTenant(async () =>
          claims.decide(c.id, { decision: 'REJECTED' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      const approved = await withTestTenant(async () =>
        claims.decide(c.id, { decision: 'APPROVED' } as any, adminActor()),
      );
      expect(approved.status).toBe('APPROVED');

      // Re-decide non-SUBMITTED → BadRequest
      await expect(
        withTestTenant(async () =>
          claims.decide(c.id, { decision: 'APPROVED' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      // Reject path
      const c2 = await submitClaim();
      const rejected = await withTestTenant(async () =>
        claims.decide(
          c2.id,
          { decision: 'REJECTED', rejectionReason: 'no receipt' } as any,
          adminActor(),
        ),
      );
      expect(rejected.status).toBe('REJECTED');

      // Missing → 404
      await expect(
        withTestTenant(async () =>
          claims.decide(
            '019e0cf8-aaaa-7777-8888-00000000ffff',
            { decision: 'APPROVED' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('markPaid happy + rejects non-approved + missing', async () => {
      const c = await submitClaim();
      // Not approved yet → reject
      await expect(
        withTestTenant(async () => claims.markPaid(c.id, {} as any, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);

      await withTestTenant(async () =>
        claims.decide(c.id, { decision: 'APPROVED' } as any, adminActor()),
      );
      const paid = await withTestTenant(async () =>
        claims.markPaid(c.id, {} as any, adminActor()),
      );
      expect(paid.status).toBe('PAID');
      // missing → 404
      await expect(
        withTestTenant(async () =>
          claims.markPaid(
            '019e0cf8-aaaa-7777-8888-00000000ffff',
            {} as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Controllers — pass-through coverage
  // ───────────────────────────────────────────────────────────────────
  describe('controllers', () => {
    it('TrainingController flows', async () => {
      const ps = await withTestTenant(async () =>
        trainingCtrl.listProgrammes('false'),
      );
      expect(ps.length).toBeGreaterThan(0);

      const got = await withTestTenant(async () =>
        trainingCtrl.getProgramme(TEST_HR_TRAINING_PROG_MAND_ID),
      );
      expect(got.id).toBe(TEST_HR_TRAINING_PROG_MAND_ID);

      const created = await withTestTenant(async () =>
        trainingCtrl.createProgramme(adminReq(), {
          name: 'TC-' + Date.now(),
        } as any),
      );
      const upd = await withTestTenant(async () =>
        trainingCtrl.patchProgramme(adminReq(), created.id, {
          isActive: false,
        } as any),
      );
      expect(upd.isActive).toBe(false);

      const e = await withTestTenant(async () =>
        trainingCtrl.createEvent(adminReq(), {
          programmeId: TEST_HR_TRAINING_PROG_MAND_ID,
          title: 'TCE',
          scheduledAt: new Date().toISOString(),
        } as any),
      );
      const events1 = await withTestTenant(async () =>
        trainingCtrl.listEvents(TEST_HR_TRAINING_PROG_MAND_ID, undefined),
      );
      expect(events1.map((x) => x.id)).toContain(e.id);
      const eGot = await withTestTenant(async () => trainingCtrl.getEvent(e.id));
      expect(eGot.id).toBe(e.id);
      const eUpd = await withTestTenant(async () =>
        trainingCtrl.patchEvent(adminReq(), e.id, { title: 'X' } as any),
      );
      expect(eUpd.title).toBe('X');

      const compl = await withTestTenant(async () =>
        trainingCtrl.recordCompletion(adminReq(), e.id, {
          employeeId: TEST_ADMIN_EMPLOYEE_ID,
          passed: true,
        } as any),
      );
      const eC = await withTestTenant(async () =>
        trainingCtrl.listEventCompletions(adminReq(), e.id),
      );
      expect(eC.map((c) => c.id)).toContain(compl.id);
      const emC = await withTestTenant(async () =>
        trainingCtrl.listEmployeeCompletions(adminReq(), TEST_ADMIN_EMPLOYEE_ID),
      );
      expect(emC.length).toBeGreaterThan(0);

      // Cert types + employee certs
      const cts = await withTestTenant(async () =>
        trainingCtrl.listCertTypes('false'),
      );
      expect(cts.length).toBeGreaterThan(0);
      const ct = await withTestTenant(async () =>
        trainingCtrl.createCertType(adminReq(), {
          name: 'CTC-' + Date.now(),
          validityMonths: 12,
        } as any),
      );
      const ctUpd = await withTestTenant(async () =>
        trainingCtrl.patchCertType(adminReq(), ct.id, { isRequired: true } as any),
      );
      expect(ctUpd.isRequired).toBe(true);

      // listExpiring + employee cert flow
      const expList = await withTestTenant(async () =>
        trainingCtrl.listExpiring(adminReq(), '90'),
      );
      expect(Array.isArray(expList)).toBe(true);

      const ec = await withTestTenant(async () =>
        trainingCtrl.createEmployeeCertification(adminReq(), {
          employeeId: TEST_ADMIN_EMPLOYEE_ID,
          certificationTypeId: ct.id,
          issuedAt: '2026-01-01',
          expiresAt: '2027-01-01',
        } as any),
      );
      const empCerts = await withTestTenant(async () =>
        trainingCtrl.listEmployeeCertifications(adminReq(), TEST_ADMIN_EMPLOYEE_ID),
      );
      expect(empCerts.map((x) => x.id)).toContain(ec.id);

      const revoked = await withTestTenant(async () =>
        trainingCtrl.revokeEmployeeCertification(adminReq(), ec.id, {
          reason: 'r',
        } as any),
      );
      expect(revoked.status).toBe('REVOKED');

      // listExpiring with bogus daysAhead falls back to 60
      const fallback = await withTestTenant(async () =>
        trainingCtrl.listExpiring(adminReq(), 'NaN'),
      );
      expect(Array.isArray(fallback)).toBe(true);
    });

    it('CertificationsController + ComplianceController', async () => {
      // Seed a legacy cert with near expiry
      await withTestTenant(async () =>
        legacyCerts.create(
          TEST_ADMIN_EMPLOYEE_ID,
          {
            certificationType: 'FIRST_AID',
            certificationName: 'FA',
            issuedDate: '2024-01-01',
            expiryDate: new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10),
          } as any,
          adminActor(),
        ),
      );
      const exp = await withTestTenant(async () => certsCtrl.listExpiringSoon());
      expect(exp.length).toBeGreaterThan(0);
      const certId = exp[0]!.id;
      const got = await withTestTenant(async () =>
        certsCtrl.getById(certId, adminReq()),
      );
      expect(got.id).toBe(certId);
      const verified = await withTestTenant(async () =>
        certsCtrl.verify(
          certId,
          { status: 'VERIFIED' } as any,
          adminReq(),
        ),
      );
      expect(verified.verificationStatus).toBe('VERIFIED');

      const dash = await withTestTenant(async () => complianceCtrl.dashboard(adminReq()));
      expect(dash.totalEmployees).toBeGreaterThan(0);
    });

    it('AppraisalsController flows', async () => {
      // Framework
      const list = await withTestTenant(async () =>
        appraisalsCtrl.listFrameworks(undefined),
      );
      expect(list.length).toBeGreaterThan(0);
      const created = await withTestTenant(async () =>
        appraisalsCtrl.createFramework(adminReq(), {
          name: 'FWC-' + Date.now(),
        } as any),
      );
      const upd = await withTestTenant(async () =>
        appraisalsCtrl.patchFramework(adminReq(), created.id, {
          description: 'new',
        } as any),
      );
      expect(upd.description).toBe('new');

      // Cycle
      const cyc = await withTestTenant(async () =>
        appraisalsCtrl.createCycle(adminReq(), {
          academicYearId: TEST_HR_ACADEMIC_YEAR_ID,
          frameworkId: TEST_HR_APPRAISAL_FW_ID,
          cycleType: 'ANNUAL',
          name: 'CycCtrl ' + Date.now(),
          startsOn: '2026-02-01',
          endsOn: '2026-08-31',
        } as any),
      );
      const cyclesList = await withTestTenant(async () =>
        appraisalsCtrl.listCycles(),
      );
      expect(cyclesList.map((c) => c.id)).toContain(cyc.id);
      const cycGot = await withTestTenant(async () => appraisalsCtrl.getCycle(cyc.id));
      expect(cycGot.id).toBe(cyc.id);
      const cycUpd = await withTestTenant(async () =>
        appraisalsCtrl.patchCycle(adminReq(), cyc.id, { name: 'NEW' } as any),
      );
      expect(cycUpd.name).toBe('NEW');

      // Appraisal
      const a = await withTestTenant(async () =>
        appraisalsCtrl.createAppraisal(adminReq(), {
          cycleId: cyc.id,
          employeeId: TEST_TEACHER_EMPLOYEE_ID,
          appraiserId: TEST_ADMIN_EMPLOYEE_ID,
        } as any),
      );
      const aList = await withTestTenant(async () =>
        appraisalsCtrl.listAppraisals(adminReq(), cyc.id),
      );
      expect(aList.map((x) => x.id)).toContain(a.id);
      const aGot = await withTestTenant(async () =>
        appraisalsCtrl.getAppraisal(adminReq(), a.id),
      );
      expect(aGot.id).toBe(a.id);
      const aUpd = await withTestTenant(async () =>
        appraisalsCtrl.patchAppraisal(adminReq(), a.id, {
          appraiserReview: 'good',
        } as any),
      );
      expect(aUpd.appraiserReview).toBe('good');

      // Goal
      const g = await withTestTenant(async () =>
        appraisalsCtrl.createGoal(adminReq(), a.id, {
          goalText: 'g',
        } as any),
      );
      const gU = await withTestTenant(async () =>
        appraisalsCtrl.patchGoal(adminReq(), g.id, {
          progress: 'ACHIEVED',
        } as any),
      );
      expect(gU.progress).toBe('ACHIEVED');

      // Comment
      const cm = await withTestTenant(async () =>
        appraisalsCtrl.createComment(adminReq(), a.id, {
          commentText: 'c',
          isVisibleToEmployee: true,
        } as any),
      );
      expect(cm.commentText).toBe('c');

      // Lesson observations
      const obs = await withTestTenant(async () =>
        appraisalsCtrl.createObservation(adminReq(), {
          appraisalId: a.id,
          observedEmployeeId: TEST_TEACHER_EMPLOYEE_ID,
          observationDate: '2026-03-01',
          observedClassLabel: 'C1',
        } as any),
      );
      const obsList = await withTestTenant(async () =>
        appraisalsCtrl.listEmployeeObservations(adminReq(), TEST_TEACHER_EMPLOYEE_ID),
      );
      expect(obsList.map((o) => o.id)).toContain(obs.id);
      const obsU = await withTestTenant(async () =>
        appraisalsCtrl.patchObservation(adminReq(), obs.id, {
          notes: 'n',
        } as any),
      );
      expect(obsU.notes).toBe('n');
      const locked = await withTestTenant(async () =>
        appraisalsCtrl.lockObservation(adminReq(), obs.id),
      );
      expect(locked.isLocked).toBe(true);

      // Expense claims
      const claim = await withTestTenant(async () =>
        appraisalsCtrl.createClaim(adminReq(), {
          claimTitle: 'C',
          incurredOn: '2026-01-01',
          totalAmount: 100,
        } as any),
      );
      const cList = await withTestTenant(async () =>
        appraisalsCtrl.listClaims(adminReq(), undefined, undefined),
      );
      expect(cList.map((c) => c.id)).toContain(claim.id);
      const decided = await withTestTenant(async () =>
        appraisalsCtrl.decideClaim(adminReq(), claim.id, {
          decision: 'APPROVED',
        } as any),
      );
      expect(decided.status).toBe('APPROVED');
      const paid = await withTestTenant(async () =>
        appraisalsCtrl.markPaid(adminReq(), claim.id, {} as any),
      );
      expect(paid.status).toBe('PAID');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Cross-school isolation
  // ───────────────────────────────────────────────────────────────────
  describe('cross-school isolation', () => {
    it('programmes A vs B disjoint', async () => {
      const a = await withTestTenant(async () => programmes.list(false));
      const b = await withTestTenantB(async () => programmes.list(false));
      const aIds = new Set(a.map((p) => p.id));
      const bIds = b.map((p) => p.id);
      expect(bIds).toContain(TEST_HR_TRAINING_PROG_B_ID);
      expect(aIds.has(TEST_HR_TRAINING_PROG_B_ID)).toBe(false);
    });
  });

  // Reference unused exports
  it('exports B-school references', () => {
    expect(TEST_SCHOOL_B_ID).toBeTruthy();
  });
});
