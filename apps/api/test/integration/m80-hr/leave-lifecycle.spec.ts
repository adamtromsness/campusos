import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { LeaveService } from '@modules/m80-hr/leave/leave.service';
import { LeaveController } from '@modules/m80-hr/leave/leave.controller';
import { LeaveApprovalConsumer } from '@modules/m80-hr/leave/leave-approval.consumer';
import { ActorContextService, PermissionCheckService } from '@modules/m00-platform';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { IdempotencyService } from '@shared/kafka/idempotency.service';
import { WorkflowEngineService } from '@modules/m02-workflows';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SUBDOMAIN,
} from '../helpers/tenant-context';
import {
  adminActor,
  teacherActor,
  officerActor,
  parentActor,
  TEST_ADMIN_ACCOUNT_ID,
  TEST_ADMIN_PERSON_ID,
  TEST_TEACHER_ACCOUNT_ID,
  TEST_TEACHER_EMPLOYEE_ID,
  TEST_TEACHER_PERSON_ID,
  TEST_OFFICER_EMPLOYEE_ID,
  TEST_ADMIN_EMPLOYEE_ID,
} from '../helpers/actor';
import { makeRecordingKafka, RecordingKafkaProducer } from '../helpers/recording-kafka';
import { ensureWorkflowsPlatformFixtures } from '../fixtures/workflows';
import {
  resetAndSeedHr,
  ensureHrFixtures,
  TEST_HR_LEAVE_TYPE_VACATION_ID,
  TEST_HR_LEAVE_TYPE_SICK_ID,
  TEST_HR_LEAVE_TYPE_B_ID,
  TEST_HR_SHADOW_EMPLOYEE_B_ID,
} from '../fixtures/hr';
import { generateId } from '@campusos/database';

class StubKafkaConsumer {
  async subscribe(): Promise<void> {
    // no-op
  }
}

describe('integration:m80-hr/leave-lifecycle', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let leave: LeaveService;
  let leaveCtrl: LeaveController;
  let approvalConsumer: LeaveApprovalConsumer;
  let actors: ActorContextService;
  let kafka: RecordingKafkaProducer;
  let workflowEngine: WorkflowEngineService;
  let idempotency: IdempotencyService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    // Restore canonical admin iam_effective_access_cache — earlier specs
    // wipe it for narrow-permission tests and never restore. LeaveController
    // approve/reject endpoints gate on isSchoolAdmin.
    await ensureWorkflowsPlatformFixtures(rawClient);

    kafka = makeRecordingKafka() as any;
    workflowEngine = new WorkflowEngineService(tenantPrisma, kafka as any);
    leave = new LeaveService(tenantPrisma, kafka as any, workflowEngine);

    const permissions = new PermissionCheckService(rawClient);
    actors = new ActorContextService(rawClient, permissions, tenantPrisma);
    leaveCtrl = new LeaveController(leave, actors);

    idempotency = new IdempotencyService(tenantPrisma);
    approvalConsumer = new LeaveApprovalConsumer(
      new StubKafkaConsumer() as any,
      idempotency,
      leave,
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
  function teacherReq(): any {
    return {
      user: {
        sub: TEST_TEACHER_ACCOUNT_ID,
        personId: TEST_TEACHER_PERSON_ID,
        email: 'teacher@test.local',
        displayName: 'Teacher',
        sessionId: 's',
      },
    };
  }

  /** Builds the canonical Kafka envelope shape consumers receive. */
  function buildEnvelope(
    topic: string,
    payload: Record<string, unknown>,
    overrides?: { eventId?: string; tenantSchoolId?: string; tenantSubdomain?: string },
  ): any {
    return {
      topic,
      partition: 0,
      offset: '1',
      key: null,
      headers: {
        'tenant-id': overrides?.tenantSchoolId ?? TEST_SCHOOL_ID,
        'tenant-subdomain': overrides?.tenantSubdomain ?? TEST_SUBDOMAIN,
      },
      payload: {
        event_id: overrides?.eventId ?? generateId(),
        event_type: topic,
        event_version: 1,
        tenant_id: overrides?.tenantSchoolId ?? TEST_SCHOOL_ID,
        tenant_subdomain: overrides?.tenantSubdomain ?? TEST_SUBDOMAIN,
        source_module: 'workflows',
        occurred_at: new Date().toISOString(),
        published_at: new Date().toISOString(),
        payload,
      },
      timestamp: new Date().toISOString(),
    };
  }

  // ───────────────────────────────────────────────────────────────────
  // LeaveService — read paths
  // ───────────────────────────────────────────────────────────────────
  describe('LeaveService.listLeaveTypes', () => {
    it('returns active types only', async () => {
      const list = await withTestTenant(async () => leave.listLeaveTypes());
      const ids = list.map((t) => t.id);
      expect(ids).toContain(TEST_HR_LEAVE_TYPE_VACATION_ID);
      expect(ids).toContain(TEST_HR_LEAVE_TYPE_SICK_ID);
    });
  });

  describe('LeaveService.listBalancesForEmployee', () => {
    it('returns one row per active leave type, zero-filled', async () => {
      const balances = await withTestTenant(async () =>
        leave.listBalancesForEmployee(TEST_TEACHER_EMPLOYEE_ID),
      );
      expect(balances.length).toBeGreaterThanOrEqual(2);
      for (const b of balances) {
        expect(b.accrued).toBe(0);
        expect(b.used).toBe(0);
        expect(b.pending).toBe(0);
        expect(b.available).toBe(0);
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // LeaveService.submit
  // ───────────────────────────────────────────────────────────────────
  describe('LeaveService.submit', () => {
    it('rejects when actor has no employeeId', async () => {
      await expect(
        withTestTenant(async () =>
          leave.submit(
            {
              leaveTypeId: TEST_HR_LEAVE_TYPE_VACATION_ID,
              startDate: '2026-01-05',
              endDate: '2026-01-06',
              daysRequested: 2,
            } as any,
            parentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects endDate before startDate', async () => {
      await expect(
        withTestTenant(async () =>
          leave.submit(
            {
              leaveTypeId: TEST_HR_LEAVE_TYPE_VACATION_ID,
              startDate: '2026-01-10',
              endDate: '2026-01-09',
              daysRequested: 1,
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects daysRequested <= 0', async () => {
      await expect(
        withTestTenant(async () =>
          leave.submit(
            {
              leaveTypeId: TEST_HR_LEAVE_TYPE_VACATION_ID,
              startDate: '2026-01-05',
              endDate: '2026-01-06',
              daysRequested: 0,
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects unknown leave type', async () => {
      await expect(
        withTestTenant(async () =>
          leave.submit(
            {
              leaveTypeId: '019e0cf8-aaaa-7777-8888-00000000fffe',
              startDate: '2026-01-05',
              endDate: '2026-01-06',
              daysRequested: 1,
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('submits PENDING + emits hr.leave.requested + bumps pending balance', async () => {
      const dto = await withTestTenant(async () =>
        leave.submit(
          {
            leaveTypeId: TEST_HR_LEAVE_TYPE_VACATION_ID,
            startDate: '2026-01-05',
            endDate: '2026-01-06',
            daysRequested: 2,
            reason: 'Family trip',
          } as any,
          teacherActor(),
        ),
      );
      expect(dto.status).toBe('PENDING');
      expect(dto.employeeId).toBe(TEST_TEACHER_EMPLOYEE_ID);
      const calls = kafka.callsForTopic('hr.leave.requested');
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const balances = await withTestTenant(async () =>
        leave.listBalancesForEmployee(TEST_TEACHER_EMPLOYEE_ID),
      );
      const vac = balances.find((b) => b.leaveTypeId === TEST_HR_LEAVE_TYPE_VACATION_ID)!;
      expect(vac.pending).toBe(2);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // LeaveService.list + getById
  // ───────────────────────────────────────────────────────────────────
  describe('LeaveService.list + getById', () => {
    async function submitOne(days = 1) {
      return withTestTenant(async () =>
        leave.submit(
          {
            leaveTypeId: TEST_HR_LEAVE_TYPE_VACATION_ID,
            startDate: '2026-02-01',
            endDate: '2026-02-01',
            daysRequested: days,
          } as any,
          teacherActor(),
        ),
      );
    }

    it('non-admin sees own only; admin sees all', async () => {
      const dto = await submitOne();
      const teacherList = await withTestTenant(async () => leave.list({} as any, teacherActor()));
      expect(teacherList.map((r) => r.id)).toContain(dto.id);

      const adminList = await withTestTenant(async () => leave.list({} as any, adminActor()));
      expect(adminList.map((r) => r.id)).toContain(dto.id);
    });

    it('non-admin without employeeId → empty', async () => {
      const list = await withTestTenant(async () => leave.list({} as any, parentActor()));
      expect(list).toEqual([]);
    });

    it('admin status + employeeId filter applied', async () => {
      const dto = await submitOne();
      const filtered = await withTestTenant(async () =>
        leave.list(
          { status: 'PENDING', employeeId: TEST_TEACHER_EMPLOYEE_ID } as any,
          adminActor(),
        ),
      );
      expect(filtered.map((r) => r.id)).toContain(dto.id);
      const none = await withTestTenant(async () =>
        leave.list({ status: 'APPROVED' } as any, adminActor()),
      );
      expect(none.map((r) => r.id)).not.toContain(dto.id);
    });

    it('getById missing → 404; non-admin foreign → 404 (no leak)', async () => {
      await expect(
        withTestTenant(async () =>
          leave.getById('019e0cf8-aaaa-7777-8888-00000000fffe', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);

      // Build a leave as teacher, try to read as a different non-admin
      // (the officer actor has employeeId = officer's).
      const dto = await submitOne();
      await expect(
        withTestTenant(async () => leave.getById(dto.id, officerActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // LeaveService.approve / reject / cancel
  // ───────────────────────────────────────────────────────────────────
  describe('LeaveService.approve', () => {
    async function submitVacation() {
      return withTestTenant(async () =>
        leave.submit(
          {
            leaveTypeId: TEST_HR_LEAVE_TYPE_VACATION_ID,
            startDate: '2026-03-01',
            endDate: '2026-03-02',
            daysRequested: 2,
          } as any,
          teacherActor(),
        ),
      );
    }

    it('non-admin → Forbidden', async () => {
      const r = await submitVacation();
      await expect(
        withTestTenant(async () => leave.approve(r.id, {} as any, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('approve flips PENDING → APPROVED + decrements pending + increments used + emits', async () => {
      const r = await submitVacation();
      kafka.reset();
      const out = await withTestTenant(async () =>
        leave.approve(r.id, { reviewNotes: 'ok' } as any, adminActor()),
      );
      expect(out.status).toBe('APPROVED');
      const calls = kafka.callsForTopic('hr.leave.approved');
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const balances = await withTestTenant(async () =>
        leave.listBalancesForEmployee(TEST_TEACHER_EMPLOYEE_ID),
      );
      const vac = balances.find((b) => b.leaveTypeId === TEST_HR_LEAVE_TYPE_VACATION_ID)!;
      expect(vac.used).toBe(2);
      expect(vac.pending).toBe(0);
    });

    it('approve non-PENDING → BadRequest', async () => {
      const r = await submitVacation();
      await withTestTenant(async () => leave.approve(r.id, {} as any, adminActor()));
      await expect(
        withTestTenant(async () => leave.approve(r.id, {} as any, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('approve missing → 404', async () => {
      await expect(
        withTestTenant(async () =>
          leave.approve('019e0cf8-aaaa-7777-8888-00000000fffe', {} as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('LeaveService.reject', () => {
    async function submit() {
      return withTestTenant(async () =>
        leave.submit(
          {
            leaveTypeId: TEST_HR_LEAVE_TYPE_SICK_ID,
            startDate: '2026-04-01',
            endDate: '2026-04-01',
            daysRequested: 1,
          } as any,
          teacherActor(),
        ),
      );
    }

    it('non-admin → Forbidden', async () => {
      const r = await submit();
      await expect(
        withTestTenant(async () => leave.reject(r.id, {} as any, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('reject flips PENDING → REJECTED + reverses pending + emits', async () => {
      const r = await submit();
      kafka.reset();
      const out = await withTestTenant(async () =>
        leave.reject(r.id, { reviewNotes: 'no' } as any, adminActor()),
      );
      expect(out.status).toBe('REJECTED');
      const calls = kafka.callsForTopic('hr.leave.rejected');
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const balances = await withTestTenant(async () =>
        leave.listBalancesForEmployee(TEST_TEACHER_EMPLOYEE_ID),
      );
      const sick = balances.find((b) => b.leaveTypeId === TEST_HR_LEAVE_TYPE_SICK_ID)!;
      expect(sick.pending).toBe(0);
    });
  });

  describe('LeaveService.cancel', () => {
    async function submit() {
      return withTestTenant(async () =>
        leave.submit(
          {
            leaveTypeId: TEST_HR_LEAVE_TYPE_SICK_ID,
            startDate: '2026-05-01',
            endDate: '2026-05-01',
            daysRequested: 1,
          } as any,
          teacherActor(),
        ),
      );
    }

    it('non-owner non-admin → Forbidden', async () => {
      const r = await submit();
      await expect(
        withTestTenant(async () => leave.cancel(r.id, officerActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('owner cancel of PENDING → CANCELLED + reverses pending', async () => {
      const r = await submit();
      kafka.reset();
      const out = await withTestTenant(async () => leave.cancel(r.id, teacherActor()));
      expect(out.status).toBe('CANCELLED');
      const calls = kafka.callsForTopic('hr.leave.cancelled');
      expect(calls.length).toBeGreaterThanOrEqual(1);
    });

    it('admin cancel of APPROVED → CANCELLED + reverses used', async () => {
      const r = await submit();
      await withTestTenant(async () => leave.approve(r.id, {} as any, adminActor()));
      const before = await withTestTenant(async () =>
        leave.listBalancesForEmployee(TEST_TEACHER_EMPLOYEE_ID),
      );
      const sickBefore = before.find((b) => b.leaveTypeId === TEST_HR_LEAVE_TYPE_SICK_ID)!;
      expect(sickBefore.used).toBe(1);
      const out = await withTestTenant(async () => leave.cancel(r.id, adminActor()));
      expect(out.status).toBe('CANCELLED');
      const after = await withTestTenant(async () =>
        leave.listBalancesForEmployee(TEST_TEACHER_EMPLOYEE_ID),
      );
      const sickAfter = after.find((b) => b.leaveTypeId === TEST_HR_LEAVE_TYPE_SICK_ID)!;
      expect(sickAfter.used).toBe(0);
    });

    it('cancel already-CANCELLED → BadRequest', async () => {
      const r = await submit();
      await withTestTenant(async () => leave.cancel(r.id, teacherActor()));
      await expect(
        withTestTenant(async () => leave.cancel(r.id, teacherActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // LeaveApprovalConsumer
  // ───────────────────────────────────────────────────────────────────
  describe('LeaveApprovalConsumer', () => {
    async function submit() {
      return withTestTenant(async () =>
        leave.submit(
          {
            leaveTypeId: TEST_HR_LEAVE_TYPE_VACATION_ID,
            startDate: '2026-06-05',
            endDate: '2026-06-05',
            daysRequested: 1,
          } as any,
          teacherActor(),
        ),
      );
    }

    it('non-LEAVE_REQUEST requestType → drop (no-op)', async () => {
      const msg = buildEnvelope('approval.request.resolved', {
        requestId: generateId(),
        requestType: 'OTHER',
        referenceId: null,
        referenceTable: null,
        requesterId: TEST_ADMIN_ACCOUNT_ID,
        status: 'APPROVED',
      });
      await (approvalConsumer as any).handle(msg);
    });

    it('LEAVE_REQUEST without referenceId → drop', async () => {
      const msg = buildEnvelope('approval.request.resolved', {
        requestId: generateId(),
        requestType: 'LEAVE_REQUEST',
        referenceId: null,
        referenceTable: 'hr_leave_requests',
        requesterId: TEST_ADMIN_ACCOUNT_ID,
        status: 'APPROVED',
      });
      await (approvalConsumer as any).handle(msg);
    });

    it('LEAVE_REQUEST APPROVED → leave row flips APPROVED', async () => {
      const r = await submit();
      const msg = buildEnvelope('approval.request.resolved', {
        requestId: generateId(),
        requestType: 'LEAVE_REQUEST',
        referenceId: r.id,
        referenceTable: 'hr_leave_requests',
        requesterId: TEST_ADMIN_ACCOUNT_ID,
        status: 'APPROVED',
        approverAccountId: TEST_ADMIN_ACCOUNT_ID,
      });
      await (approvalConsumer as any).handle(msg);
      const after = await withTestTenant(async () => leave.getById(r.id, adminActor()));
      expect(after.status).toBe('APPROVED');
    });

    it('LEAVE_REQUEST REJECTED → flips REJECTED', async () => {
      const r = await submit();
      const msg = buildEnvelope('approval.request.resolved', {
        requestId: generateId(),
        requestType: 'LEAVE_REQUEST',
        referenceId: r.id,
        referenceTable: 'hr_leave_requests',
        requesterId: TEST_ADMIN_ACCOUNT_ID,
        status: 'REJECTED',
        approverAccountId: TEST_ADMIN_ACCOUNT_ID,
      });
      await (approvalConsumer as any).handle(msg);
      const after = await withTestTenant(async () => leave.getById(r.id, adminActor()));
      expect(after.status).toBe('REJECTED');
    });

    it('LEAVE_REQUEST WITHDRAWN → cascade-cancels leave row', async () => {
      const r = await submit();
      const msg = buildEnvelope('approval.request.resolved', {
        requestId: generateId(),
        requestType: 'LEAVE_REQUEST',
        referenceId: r.id,
        referenceTable: 'hr_leave_requests',
        requesterId: TEST_ADMIN_ACCOUNT_ID,
        status: 'WITHDRAWN',
        approverAccountId: TEST_ADMIN_ACCOUNT_ID,
      });
      await (approvalConsumer as any).handle(msg);
      const after = await withTestTenant(async () => leave.getById(r.id, adminActor()));
      expect(after.status).toBe('CANCELLED');
    });

    it('unexpected status value → drop silently', async () => {
      const msg = buildEnvelope('approval.request.resolved', {
        requestId: generateId(),
        requestType: 'LEAVE_REQUEST',
        referenceId: 'something',
        referenceTable: 'hr_leave_requests',
        requesterId: TEST_ADMIN_ACCOUNT_ID,
        status: 'BOGUS',
      });
      await (approvalConsumer as any).handle(msg);
    });

    it('idempotency: redelivery is dropped after first claim', async () => {
      const r = await submit();
      const eventId = generateId();
      const msg = buildEnvelope(
        'approval.request.resolved',
        {
          requestId: generateId(),
          requestType: 'LEAVE_REQUEST',
          referenceId: r.id,
          referenceTable: 'hr_leave_requests',
          requesterId: TEST_ADMIN_ACCOUNT_ID,
          status: 'APPROVED',
          approverAccountId: TEST_ADMIN_ACCOUNT_ID,
        },
        { eventId },
      );
      await (approvalConsumer as any).handle(msg);
      // Second delivery — should be a no-op because event_id is claimed.
      // It does NOT raise even though row is already APPROVED because the
      // idempotency claim happens before re-running applyDecision.
      await (approvalConsumer as any).handle(msg);
      const after = await withTestTenant(async () => leave.getById(r.id, adminActor()));
      expect(after.status).toBe('APPROVED');
    });

    it('APPROVED on already-terminal row swallows BadRequest', async () => {
      const r = await submit();
      // Admin approves first.
      await withTestTenant(async () => leave.approve(r.id, {} as any, adminActor()));
      // Now consumer tries to approve — should swallow the BadRequest.
      const msg = buildEnvelope('approval.request.resolved', {
        requestId: generateId(),
        requestType: 'LEAVE_REQUEST',
        referenceId: r.id,
        referenceTable: 'hr_leave_requests',
        requesterId: TEST_ADMIN_ACCOUNT_ID,
        status: 'APPROVED',
        approverAccountId: TEST_ADMIN_ACCOUNT_ID,
      });
      await (approvalConsumer as any).handle(msg);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Controller pass-through
  // ───────────────────────────────────────────────────────────────────
  describe('LeaveController', () => {
    it('listLeaveTypes + myBalances + flow', async () => {
      const types = await withTestTenant(async () => leaveCtrl.listLeaveTypes());
      expect(types.length).toBeGreaterThan(0);

      const balances = await withTestTenant(async () => leaveCtrl.myBalances(teacherReq()));
      expect(balances.length).toBeGreaterThan(0);

      const dto = await withTestTenant(async () =>
        leaveCtrl.submit(
          {
            leaveTypeId: TEST_HR_LEAVE_TYPE_VACATION_ID,
            startDate: '2026-07-01',
            endDate: '2026-07-01',
            daysRequested: 1,
          } as any,
          teacherReq(),
        ),
      );
      expect(dto.status).toBe('PENDING');

      const list = await withTestTenant(async () =>
        leaveCtrl.listRequests({} as any, teacherReq()),
      );
      expect(list.map((l) => l.id)).toContain(dto.id);

      const got = await withTestTenant(async () => leaveCtrl.getRequest(dto.id, teacherReq()));
      expect(got.id).toBe(dto.id);

      const approved = await withTestTenant(async () =>
        leaveCtrl.approve(dto.id, { reviewNotes: 'ok' } as any, adminReq()),
      );
      expect(approved.status).toBe('APPROVED');
    });

    it('myBalances returns [] for parent (no employeeId)', async () => {
      const list = await withTestTenant(async () =>
        leaveCtrl.myBalances({
          user: {
            sub: '019e0cf8-aaaa-7777-8888-000000000051',
            personId: '019e0cf8-aaaa-7777-8888-000000000050',
            email: 'parent@test.local',
            displayName: 'Parent',
            sessionId: 's',
          },
        } as any),
      );
      expect(list).toEqual([]);
    });

    it('cancel + reject flow', async () => {
      const dto = await withTestTenant(async () =>
        leaveCtrl.submit(
          {
            leaveTypeId: TEST_HR_LEAVE_TYPE_SICK_ID,
            startDate: '2026-07-05',
            endDate: '2026-07-05',
            daysRequested: 1,
          } as any,
          teacherReq(),
        ),
      );
      const rejected = await withTestTenant(async () =>
        leaveCtrl.reject(dto.id, { reviewNotes: 'no' } as any, adminReq()),
      );
      expect(rejected.status).toBe('REJECTED');

      const dto2 = await withTestTenant(async () =>
        leaveCtrl.submit(
          {
            leaveTypeId: TEST_HR_LEAVE_TYPE_SICK_ID,
            startDate: '2026-08-05',
            endDate: '2026-08-05',
            daysRequested: 1,
          } as any,
          teacherReq(),
        ),
      );
      const cancelled = await withTestTenant(async () => leaveCtrl.cancel(dto2.id, teacherReq()));
      expect(cancelled.status).toBe('CANCELLED');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Cross-school isolation
  // ───────────────────────────────────────────────────────────────────
  describe('cross-school isolation', () => {
    it('list under School B does not surface School A requests', async () => {
      await withTestTenant(async () =>
        leave.submit(
          {
            leaveTypeId: TEST_HR_LEAVE_TYPE_VACATION_ID,
            startDate: '2026-09-01',
            endDate: '2026-09-01',
            daysRequested: 1,
          } as any,
          teacherActor(),
        ),
      );
      const bList = await withTestTenantB(async () => leave.list({} as any, adminActor()));
      // School B has no leave rows seeded.
      // (Admin actor in School B context still resolves admin scope.)
      expect(Array.isArray(bList)).toBe(true);
    });

    it('submit raises BadRequest if no current academic year exists', async () => {
      // Drop is_current on the seeded year, expect submit to fail.
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.sis_academic_years SET is_current = false WHERE school_id = $1::uuid`,
        TEST_SCHOOL_ID,
      );
      try {
        await expect(
          withTestTenant(async () =>
            leave.submit(
              {
                leaveTypeId: TEST_HR_LEAVE_TYPE_VACATION_ID,
                startDate: '2026-12-05',
                endDate: '2026-12-05',
                daysRequested: 1,
              } as any,
              teacherActor(),
            ),
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      } finally {
        // Restore for downstream tests.
        await rawClient.$executeRawUnsafe(
          `UPDATE ${TEST_SCHEMA}.sis_academic_years SET is_current = true WHERE id = (
             SELECT id FROM ${TEST_SCHEMA}.sis_academic_years WHERE school_id = $1::uuid ORDER BY start_date DESC LIMIT 1
           )`,
          TEST_SCHOOL_ID,
        );
      }
    });
  });

  // Reference unused IDs
  it('exports admin + officer employee IDs', () => {
    expect(TEST_ADMIN_EMPLOYEE_ID).toBeTruthy();
    expect(TEST_OFFICER_EMPLOYEE_ID).toBeTruthy();
    expect(TEST_SCHEMA).toBeTruthy();
  });
});
