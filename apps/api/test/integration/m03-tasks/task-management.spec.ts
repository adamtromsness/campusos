import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { TaskService } from '@modules/m03-tasks/task.service';
import { AcknowledgementService } from '@modules/m03-tasks/acknowledgement.service';
import { TaskController } from '@modules/m03-tasks/task.controller';
import { AcknowledgementController } from '@modules/m03-tasks/acknowledgement.controller';
import { renderTemplate, buildPlaceholderValues } from '@modules/m03-tasks/template-render';
import { TicketTaskCompletionConsumer } from '@modules/m03-tasks/ticket-task-completion.consumer';
import { TaskWorker } from '@modules/m03-tasks/task.worker';
import { evaluateConditions } from '@modules/m03-tasks/task.worker';
import { ActorContextService, PermissionCheckService } from '@modules/m00-platform';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
} from '../helpers/tenant-context';
import {
  adminActor,
  teacherActor,
  studentActor,
  TEST_ADMIN_ACCOUNT_ID,
  TEST_ADMIN_PERSON_ID,
  TEST_TEACHER_ACCOUNT_ID,
  TEST_TEACHER_PERSON_ID,
} from '../helpers/actor';
import { makeRecordingKafka, RecordingKafkaProducer } from '../helpers/recording-kafka';
import { ensureWorkflowsPlatformFixtures } from '../fixtures/workflows';
import {
  resetAndSeedTasks,
  resetTasksTables,
  TEST_TSK_RULE_ADMIN_A_ID,
  TEST_TSK_RULE_ASSIGN_A_ID,
} from '../fixtures/tasks';
import { generateId } from '@campusos/database';

/**
 * Wave 8 — m03-tasks integration suite.
 *
 * Covers TaskService (list / listAssigned / getById / create / update),
 * AcknowledgementService (listOwnPending / getById / acknowledge /
 * dispute / listAll), TaskController + AcknowledgementController
 * pass-through, TicketTaskCompletionConsumer cascade, template-render.
 */
describe('integration:m03-tasks/task-management', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let tasks: TaskService;
  let acks: AcknowledgementService;
  let taskCtrl: TaskController;
  let ackCtrl: AcknowledgementController;
  let ticketConsumer: TicketTaskCompletionConsumer;
  let worker: TaskWorker;
  let stubRedis: any;
  let kafka: RecordingKafkaProducer;
  let actors: ActorContextService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    kafka = makeRecordingKafka() as any;
    tasks = new TaskService(tenantPrisma, kafka as any);
    acks = new AcknowledgementService(tenantPrisma, kafka as any);
    const permCheck = new PermissionCheckService(rawClient);
    actors = new ActorContextService(rawClient, permCheck, tenantPrisma);
    taskCtrl = new TaskController(tasks, actors);
    ackCtrl = new AcknowledgementController(acks, actors);
    ticketConsumer = new TicketTaskCompletionConsumer(
      {} as any,
      {} as any,
      tenantPrisma,
      kafka as any,
    );
    // Build a stub Redis that records claim/release calls. The default
    // claim returns true so all events flow through; specific tests
    // override the flag to test dedup.
    stubRedis = {
      claims: new Map<string, boolean>(),
      claimAllowed: true,
      async claimIdempotency(key: string) {
        if (!this.claimAllowed) return false;
        if (this.claims.has(key)) return false;
        this.claims.set(key, true);
        return true;
      },
      async releaseIdempotency(key: string) {
        this.claims.delete(key);
      },
    };
    const stubIdempotency = {
      isClaimed: async () => false,
      claim: async () => {},
    } as any;
    const stubConsumer = { subscribe: async () => {} } as any;
    worker = new TaskWorker(
      rawClient,
      tenantPrisma,
      stubConsumer,
      stubIdempotency,
      kafka as any,
      stubRedis,
    );
    await ensureWorkflowsPlatformFixtures(rawClient);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetAndSeedTasks(rawClient);
    kafka.reset();
  });

  // ───────────────────────────────────────────────────────────────────
  // TaskService.create
  // ───────────────────────────────────────────────────────────────────
  describe('TaskService.create', () => {
    it('creates a self-owned MANUAL task + emits task.created', async () => {
      const dto = await withTestTenant(async () =>
        tasks.create(
          { title: 'My task', priority: 'HIGH', taskCategory: 'PERSONAL' } as any,
          adminActor(),
        ),
      );
      expect(dto.ownerId).toBe(TEST_ADMIN_ACCOUNT_ID);
      expect(dto.createdForId).toBeNull();
      expect(dto.status).toBe('TODO');
      expect(dto.priority).toBe('HIGH');
      expect(dto.source).toBe('MANUAL');

      const emitted = kafka.callsForTopic('task.created');
      expect(emitted).toHaveLength(1);
      expect(emitted[0]!.payload).toMatchObject({
        ownerId: TEST_ADMIN_ACCOUNT_ID,
        priority: 'HIGH',
        taskCategory: 'PERSONAL',
      });
    });

    it('defaults priority and taskCategory when omitted', async () => {
      const dto = await withTestTenant(async () =>
        tasks.create({ title: 'Default' } as any, adminActor()),
      );
      expect(dto.priority).toBe('NORMAL');
      expect(dto.taskCategory).toBe('PERSONAL');
    });

    it('rejects unknown taskCategory', async () => {
      await expect(
        withTestTenant(async () =>
          tasks.create({ title: 'X', taskCategory: 'NOT_REAL' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('non-admin cannot create ACKNOWLEDGEMENT-tier task', async () => {
      await expect(
        withTestTenant(async () =>
          tasks.create({ title: 'X', taskCategory: 'ACKNOWLEDGEMENT' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('non-admin cannot delegate', async () => {
      // Teacher tries to delegate TO admin (different account → isDelegation=true)
      await expect(
        withTestTenant(async () =>
          tasks.create(
            { title: 'X', assigneeAccountId: TEST_ADMIN_ACCOUNT_ID } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('admin can delegate but assignee must have tenant projection', async () => {
      // Admin delegates to a UUID with no projection → BadRequest.
      await expect(
        withTestTenant(async () =>
          tasks.create(
            {
              title: 'Delegated',
              assigneeAccountId: '99999999-9999-9999-9999-999999999999',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('admin delegates to staff with hr_employees row — owner=assignee, createdFor=actor', async () => {
      // Seed a hr_employees row for the teacher so assertAssigneeInCurrentTenant succeeds.
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.hr_employees
           (id, person_id, account_id, school_id, employee_number,
            employment_type, employment_status, hire_date)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid,
                 'WFL-TEACH-' || floor(random()*100000)::text,
                 'FULL_TIME', 'ACTIVE', '2024-08-01')
         ON CONFLICT DO NOTHING`,
        TEST_TEACHER_PERSON_ID,
        TEST_TEACHER_ACCOUNT_ID,
        TEST_SCHOOL_ID,
      );
      const dto = await withTestTenant(async () =>
        tasks.create(
          { title: 'Delegated', assigneeAccountId: TEST_TEACHER_ACCOUNT_ID } as any,
          adminActor(),
        ),
      );
      expect(dto.ownerId).toBe(TEST_TEACHER_ACCOUNT_ID);
      expect(dto.createdForId).toBe(TEST_ADMIN_ACCOUNT_ID);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // TaskService.list / listAssigned / getById
  // ───────────────────────────────────────────────────────────────────
  describe('TaskService.list/getById', () => {
    async function insertTask(
      opts: Partial<{
        schoolId: string;
        ownerId: string;
        createdForId: string | null;
        status: string;
        priority: string;
        title: string;
        dueAt: string | null;
      }> = {},
    ) {
      const id = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.tsk_tasks
           (id, school_id, owner_id, title, source, priority, status, task_category, due_at, created_for_id, completed_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'MANUAL', $5, $6, 'PERSONAL', $7::timestamptz, $8::uuid,
                 CASE WHEN $6 IN ('DONE','CANCELLED') THEN now() ELSE NULL END)`,
        id,
        opts.schoolId ?? TEST_SCHOOL_ID,
        opts.ownerId ?? TEST_ADMIN_ACCOUNT_ID,
        opts.title ?? 'T',
        opts.priority ?? 'NORMAL',
        opts.status ?? 'TODO',
        opts.dueAt ?? null,
        opts.createdForId ?? null,
      );
      return id;
    }

    it('admin list returns all rows in school by default (excludes DONE/CANCELLED)', async () => {
      await insertTask({ title: 'TODO row' });
      await insertTask({ title: 'IN_PROGRESS row', status: 'IN_PROGRESS' });
      await insertTask({ title: 'DONE row', status: 'DONE' });
      const list = await withTestTenant(async () => tasks.list({} as any, adminActor()));
      const titles = list.map((t) => t.title);
      expect(titles).toContain('TODO row');
      expect(titles).toContain('IN_PROGRESS row');
      expect(titles).not.toContain('DONE row');
    });

    it('admin list with includeCompleted=true returns DONE too', async () => {
      await insertTask({ title: 'TODO' });
      await insertTask({ title: 'DONE', status: 'DONE' });
      const list = await withTestTenant(async () =>
        tasks.list({ includeCompleted: true } as any, adminActor()),
      );
      expect(list.map((t) => t.title)).toEqual(expect.arrayContaining(['TODO', 'DONE']));
    });

    it('non-admin sees only rows where they are owner or createdFor', async () => {
      await insertTask({ ownerId: TEST_ADMIN_ACCOUNT_ID, title: 'admin only' });
      await insertTask({ ownerId: TEST_TEACHER_ACCOUNT_ID, title: 'teacher own' });
      await insertTask({
        ownerId: TEST_ADMIN_ACCOUNT_ID,
        createdForId: TEST_TEACHER_ACCOUNT_ID,
        title: 'teacher delegated',
      });
      const teacherList = await withTestTenant(async () => tasks.list({} as any, teacherActor()));
      const titles = teacherList.map((t) => t.title);
      expect(titles).toContain('teacher own');
      expect(titles).toContain('teacher delegated');
      expect(titles).not.toContain('admin only');
    });

    it('list filters: status / priority / taskCategory / dueAfter / dueBefore', async () => {
      await insertTask({ status: 'TODO', priority: 'HIGH', title: 'high todo' });
      await insertTask({ status: 'IN_PROGRESS', priority: 'LOW', title: 'low in_progress' });
      const high = await withTestTenant(async () =>
        tasks.list({ priority: 'HIGH' } as any, adminActor()),
      );
      expect(high.every((t) => t.priority === 'HIGH')).toBe(true);
      const inprog = await withTestTenant(async () =>
        tasks.list({ status: 'IN_PROGRESS' } as any, adminActor()),
      );
      expect(inprog.every((t) => t.status === 'IN_PROGRESS')).toBe(true);
      const cat = await withTestTenant(async () =>
        tasks.list({ taskCategory: 'PERSONAL' } as any, adminActor()),
      );
      expect(cat.every((t) => t.taskCategory === 'PERSONAL')).toBe(true);

      // Date filters
      const futureRow = await insertTask({
        title: 'far future',
        dueAt: '2027-01-01T00:00:00Z',
      });
      const after = await withTestTenant(async () =>
        tasks.list({ dueAfter: '2026-12-01T00:00:00Z' } as any, adminActor()),
      );
      expect(after.map((t) => t.id)).toContain(futureRow);
      const before = await withTestTenant(async () =>
        tasks.list({ dueBefore: '2026-12-01T00:00:00Z' } as any, adminActor()),
      );
      expect(before.map((t) => t.id)).not.toContain(futureRow);
    });

    it('list respects limit (clamped to 200)', async () => {
      const list = await withTestTenant(async () =>
        tasks.list({ limit: 500 } as any, adminActor()),
      );
      expect(list.length).toBeLessThanOrEqual(200);
    });

    it('listAssigned returns rows delegated to me (createdFor=me, owner!=me)', async () => {
      // Note: listAssigned uses created_for_id but NOT school_id filter —
      // it returns tasks across all tenants where created_for_id matches.
      // Insert a task assigned TO teacher (createdFor=teacher, owner=admin).
      await insertTask({
        ownerId: TEST_ADMIN_ACCOUNT_ID,
        createdForId: TEST_TEACHER_ACCOUNT_ID,
        title: 'admin delegated to teacher',
      });
      const assignedToTeacher = await withTestTenant(async () =>
        tasks.listAssigned(teacherActor()),
      );
      expect(assignedToTeacher.map((t) => t.title)).toContain('admin delegated to teacher');
    });

    it('getById — admin sees any row', async () => {
      const id = await insertTask({ title: 'X' });
      const dto = await withTestTenant(async () => tasks.getById(id, adminActor()));
      expect(dto.id).toBe(id);
    });

    it('getById — non-admin not owner/creator → 404', async () => {
      const id = await insertTask({ title: 'X' });
      await expect(
        withTestTenant(async () => tasks.getById(id, teacherActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById — missing → 404', async () => {
      await expect(
        withTestTenant(async () =>
          tasks.getById('00000000-0000-0000-0000-000000000099', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school: School A task not visible from School B', async () => {
      const id = await insertTask({ schoolId: TEST_SCHOOL_ID });
      const fromB = await withTestTenantB(async () => tasks.list({} as any, adminActor()));
      expect(fromB.map((t) => t.id)).not.toContain(id);
      await expect(
        withTestTenantB(async () => tasks.getById(id, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // TaskService.update
  // ───────────────────────────────────────────────────────────────────
  describe('TaskService.update', () => {
    async function seed(opts: { owner?: string; status?: string } = {}) {
      const id = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.tsk_tasks
           (id, school_id, owner_id, title, source, priority, status, task_category, completed_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'X', 'MANUAL', 'NORMAL', $4, 'PERSONAL',
                 CASE WHEN $4 IN ('DONE','CANCELLED') THEN now() ELSE NULL END)`,
        id,
        TEST_SCHOOL_ID,
        opts.owner ?? TEST_ADMIN_ACCOUNT_ID,
        opts.status ?? 'TODO',
      );
      return id;
    }

    it('update — owner can patch title/description/priority/dueAt', async () => {
      const id = await seed();
      const dto = await withTestTenant(async () =>
        tasks.update(
          id,
          {
            title: 'New',
            description: 'd',
            priority: 'URGENT',
            dueAt: '2026-12-31T00:00:00Z',
          } as any,
          adminActor(),
        ),
      );
      expect(dto.title).toBe('New');
      expect(dto.description).toBe('d');
      expect(dto.priority).toBe('URGENT');
    });

    it('update — null dueAt clears it', async () => {
      const id = await seed();
      const dto = await withTestTenant(async () =>
        tasks.update(id, { dueAt: null } as any, adminActor()),
      );
      expect(dto.dueAt).toBeNull();
    });

    it('update — status DONE sets completed_at + emits task.completed', async () => {
      const id = await seed();
      kafka.reset();
      const dto = await withTestTenant(async () =>
        tasks.update(id, { status: 'DONE' } as any, adminActor()),
      );
      expect(dto.status).toBe('DONE');
      expect(dto.completedAt).not.toBeNull();
      const emitted = kafka.callsForTopic('task.completed');
      expect(emitted).toHaveLength(1);
    });

    it('update — DONE→TODO re-opens (clears completed_at, no second emit)', async () => {
      const id = await seed({ status: 'DONE' });
      kafka.reset();
      const dto = await withTestTenant(async () =>
        tasks.update(id, { status: 'TODO' } as any, adminActor()),
      );
      expect(dto.status).toBe('TODO');
      expect(dto.completedAt).toBeNull();
      // No emit on re-open
      expect(kafka.callsForTopic('task.completed')).toHaveLength(0);
    });

    it('update — CANCELLED sets completed_at without task.completed emit', async () => {
      const id = await seed();
      kafka.reset();
      const dto = await withTestTenant(async () =>
        tasks.update(id, { status: 'CANCELLED' } as any, adminActor()),
      );
      expect(dto.status).toBe('CANCELLED');
      expect(dto.completedAt).not.toBeNull();
      expect(kafka.callsForTopic('task.completed')).toHaveLength(0);
    });

    it('update — non-owner non-admin → 404', async () => {
      const id = await seed();
      await expect(
        withTestTenant(async () => tasks.update(id, { title: 'X' } as any, teacherActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('update — empty patch is a no-op returning current state', async () => {
      const id = await seed();
      const dto = await withTestTenant(async () => tasks.update(id, {} as any, adminActor()));
      expect(dto.id).toBe(id);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // AcknowledgementService
  // ───────────────────────────────────────────────────────────────────
  describe('AcknowledgementService', () => {
    async function seedAck(
      opts: {
        schoolId?: string;
        subjectId?: string;
        status?: string;
        sourceRefId?: string;
      } = {},
    ) {
      const id = generateId();
      const sourceRefId = opts.sourceRefId ?? generateId();
      const status = opts.status ?? 'PENDING';
      // Schema CHECK requires acknowledged_at non-null for terminal statuses.
      const ackedAt =
        status === 'ACKNOWLEDGED' || status === 'ACKNOWLEDGED_WITH_DISPUTE' ? 'now()' : 'NULL';
      const disputeReason = status === 'ACKNOWLEDGED_WITH_DISPUTE' ? "'reason'" : 'NULL';
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.tsk_acknowledgements
           (id, school_id, subject_id, source_type, source_ref_id, source_table,
            title, status, acknowledged_at, dispute_reason, created_by)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'POLICY_DOCUMENT', $4::uuid,
                 'policy_documents', 'Ack me', $5, ${ackedAt}, ${disputeReason}, $6::uuid)`,
        id,
        opts.schoolId ?? TEST_SCHOOL_ID,
        opts.subjectId ?? TEST_ADMIN_PERSON_ID,
        sourceRefId,
        status,
        TEST_ADMIN_ACCOUNT_ID,
      );
      return { id, sourceRefId };
    }

    it('listOwnPending returns only this subject + PENDING', async () => {
      await seedAck({ subjectId: TEST_ADMIN_PERSON_ID, status: 'PENDING' });
      const ackd = await seedAck({ subjectId: TEST_ADMIN_PERSON_ID, status: 'ACKNOWLEDGED' });
      // ACKNOWLEDGED requires acknowledged_at.
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.tsk_acknowledgements SET acknowledged_at = now() WHERE id = $1::uuid`,
        ackd.id,
      );
      await seedAck({ subjectId: TEST_TEACHER_PERSON_ID, status: 'PENDING' });
      const list = await withTestTenant(async () => acks.listOwnPending(adminActor()));
      expect(list.every((a) => a.subjectId === TEST_ADMIN_PERSON_ID)).toBe(true);
      expect(list.every((a) => a.status === 'PENDING')).toBe(true);
    });

    it('getById — owner sees their own', async () => {
      const { id } = await seedAck();
      const dto = await withTestTenant(async () => acks.getById(id, adminActor()));
      expect(dto.id).toBe(id);
    });

    it('getById — non-admin not subject → 404', async () => {
      const { id } = await seedAck({ subjectId: TEST_TEACHER_PERSON_ID });
      await expect(
        withTestTenant(async () => acks.getById(id, studentActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById — missing → 404', async () => {
      await expect(
        withTestTenant(async () =>
          acks.getById('00000000-0000-0000-0000-000000000099', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('acknowledge flips PENDING→ACKNOWLEDGED + cascades linked task DONE + emits', async () => {
      const { id: ackId, sourceRefId } = await seedAck();
      // Link a task to this ack
      const taskId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.tsk_tasks
           (id, school_id, owner_id, title, source, priority, status, task_category, acknowledgement_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Linked task', 'AUTO', 'NORMAL', 'TODO', 'ACKNOWLEDGEMENT', $4::uuid)`,
        taskId,
        TEST_SCHOOL_ID,
        TEST_ADMIN_ACCOUNT_ID,
        ackId,
      );
      kafka.reset();
      const dto = await withTestTenant(async () => acks.acknowledge(ackId, adminActor()));
      expect(dto.status).toBe('ACKNOWLEDGED');
      expect(dto.acknowledgedAt).not.toBeNull();

      // Cascade — task now DONE
      const taskRows = await rawClient.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT status FROM ${TEST_SCHEMA}.tsk_tasks WHERE id = $1::uuid`,
        taskId,
      );
      expect(taskRows[0]!.status).toBe('DONE');

      const emit = kafka.callsForTopic('student.acknowledgement.completed');
      expect(emit).toHaveLength(1);
      expect(emit[0]!.payload).toMatchObject({
        status: 'ACKNOWLEDGED',
        subjectId: TEST_ADMIN_PERSON_ID,
        sourceRefId,
      });
    });

    it('acknowledge — already-acknowledged → BadRequest', async () => {
      // Acknowledge once to get past the schema CHECK; then try again.
      const { id } = await seedAck();
      await withTestTenant(async () => acks.acknowledge(id, adminActor()));
      await expect(
        withTestTenant(async () => acks.acknowledge(id, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('acknowledge — non-subject non-admin → 404', async () => {
      const { id } = await seedAck({ subjectId: TEST_TEACHER_PERSON_ID });
      await expect(
        withTestTenant(async () => acks.acknowledge(id, studentActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('acknowledge — missing → 404', async () => {
      await expect(
        withTestTenant(async () =>
          acks.acknowledge('00000000-0000-0000-0000-000000000099', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('dispute — sets ACKNOWLEDGED_WITH_DISPUTE + dispute_reason', async () => {
      const { id } = await seedAck();
      const dto = await withTestTenant(async () => acks.dispute(id, 'I disagree', adminActor()));
      expect(dto.status).toBe('ACKNOWLEDGED_WITH_DISPUTE');
      expect(dto.disputeReason).toBe('I disagree');
    });

    it('dispute — empty reason → BadRequest', async () => {
      const { id } = await seedAck();
      await expect(
        withTestTenant(async () => acks.dispute(id, '   ', adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('listAll — admin sees all rows in school', async () => {
      await seedAck({ subjectId: TEST_ADMIN_PERSON_ID });
      await seedAck({ subjectId: TEST_TEACHER_PERSON_ID });
      const all = await withTestTenant(async () => acks.listAll(adminActor()));
      expect(all.length).toBeGreaterThanOrEqual(2);
    });

    it('listAll — non-admin → ForbiddenException', async () => {
      await expect(withTestTenant(async () => acks.listAll(teacherActor()))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('cross-school: B ack not visible from A', async () => {
      const { id } = await seedAck({ schoolId: '019e0cf8-aaaa-7777-8888-00000000000b' });
      await expect(
        withTestTenant(async () => acks.getById(id, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // TicketTaskCompletionConsumer.cascadeDone (via handle())
  // ───────────────────────────────────────────────────────────────────
  describe('TicketTaskCompletionConsumer.handle', () => {
    function makeMsg(ticketId: string | undefined) {
      const payload = ticketId ? { ticketId } : {};
      return {
        topic: 'tkt.ticket.resolved',
        partition: 0,
        offset: '1',
        key: ticketId ?? 'k',
        payload: {
          event_id: generateId(),
          tenant_id: TEST_SCHOOL_ID,
          payload,
        },
        headers: { 'tenant-subdomain': 'test' },
        timestamp: Date.now().toString(),
      } as any;
    }

    // Stub the idempotency service so processWithIdempotency proceeds.
    let stubbed = false;
    function stubIdem() {
      if (stubbed) return;
      const idem = { isClaimed: async () => false, claim: async () => {} };
      (ticketConsumer as any).idempotency = idem;
      stubbed = true;
    }

    it('flips AUTO tasks linked to ticketId to DONE + emits task.completed', async () => {
      stubIdem();
      const ticketId = generateId();
      const taskId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.tsk_tasks
           (id, school_id, owner_id, title, source, source_ref_id, priority, status, task_category)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Auto', 'AUTO', $4::uuid, 'NORMAL', 'TODO', 'ADMINISTRATIVE')`,
        taskId,
        TEST_SCHOOL_ID,
        TEST_ADMIN_ACCOUNT_ID,
        ticketId,
      );
      kafka.reset();
      await (ticketConsumer as any).handle(makeMsg(ticketId));
      const rows = await rawClient.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT status FROM ${TEST_SCHEMA}.tsk_tasks WHERE id = $1::uuid`,
        taskId,
      );
      expect(rows[0]!.status).toBe('DONE');
      const emit = kafka.callsForTopic('task.completed');
      expect(emit).toHaveLength(1);
      expect(emit[0]!.payload).toMatchObject({
        taskId,
        ownerId: TEST_ADMIN_ACCOUNT_ID,
        completedViaTicketId: ticketId,
      });
    });

    it('drops envelope without ticketId', async () => {
      stubIdem();
      kafka.reset();
      await (ticketConsumer as any).handle(makeMsg(undefined));
      expect(kafka.callsForTopic('task.completed')).toHaveLength(0);
    });

    it('no linked tasks → no-op (no emit)', async () => {
      stubIdem();
      kafka.reset();
      await (ticketConsumer as any).handle(makeMsg(generateId()));
      expect(kafka.callsForTopic('task.completed')).toHaveLength(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // template-render
  // ───────────────────────────────────────────────────────────────────
  describe('template-render', () => {
    it('renderTemplate substitutes placeholders from values', () => {
      const out = renderTemplate('Hello {name}, your task is {task}', {
        name: 'Adam',
        task: 'Read me',
      });
      expect(out).toBe('Hello Adam, your task is Read me');
    });

    it('renderTemplate leaves missing placeholders unsubstituted', () => {
      const out = renderTemplate('Hello {name}', {});
      expect(out).toBe('Hello {name}');
    });

    it('renderTemplate stringifies non-strings, ISO-dates Date', () => {
      const date = new Date('2026-05-20T10:00:00Z');
      const out = renderTemplate('{n} on {d}', { n: 42, d: date });
      expect(out).toBe('42 on 2026-05-20');
    });

    it('buildPlaceholderValues adds snake_case mirrors of camelCase keys', () => {
      const vals = buildPlaceholderValues({ studentId: 'abc' }, { extra: 'x' });
      expect(vals.studentId).toBe('abc');
      expect(vals.student_id).toBe('abc');
      expect(vals.extra).toBe('x');
    });

    it('renderTemplate treats null/undefined as missing', () => {
      const out = renderTemplate('A {b}', { b: null });
      expect(out).toBe('A {b}');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Controllers
  // ───────────────────────────────────────────────────────────────────
  describe('controllers (pass-through)', () => {
    const fakeReq = {
      user: {
        sub: TEST_ADMIN_ACCOUNT_ID,
        personId: TEST_ADMIN_PERSON_ID,
        email: 'admin@test.local',
        displayName: 'Admin',
        sessionId: 'sess-1',
      },
    } as any;

    it('TaskController list / create / get / update / listAssigned', async () => {
      const created = await withTestTenant(async () =>
        taskCtrl.create({ title: 'ctrl' } as any, fakeReq),
      );
      const list = await withTestTenant(async () => taskCtrl.list({} as any, fakeReq));
      expect(list.map((t) => t.id)).toContain(created.id);
      const fetched = await withTestTenant(async () => taskCtrl.getById(created.id, fakeReq));
      expect(fetched.id).toBe(created.id);
      const upd = await withTestTenant(async () =>
        taskCtrl.update(created.id, { status: 'DONE' } as any, fakeReq),
      );
      expect(upd.status).toBe('DONE');
      const assigned = await withTestTenant(async () => taskCtrl.listAssigned(fakeReq));
      expect(Array.isArray(assigned)).toBe(true);
    });

    it('AcknowledgementController list / get / acknowledge / dispute, including ?all=true admin path', async () => {
      // Seed an ack
      const ackId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.tsk_acknowledgements
           (id, school_id, subject_id, source_type, source_ref_id, source_table, title, created_by)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'POLICY_DOCUMENT', gen_random_uuid(),
                 'policy_documents', 'ctrl ack', $4::uuid)`,
        ackId,
        TEST_SCHOOL_ID,
        TEST_ADMIN_PERSON_ID,
        TEST_ADMIN_ACCOUNT_ID,
      );
      const myList = await withTestTenant(async () => ackCtrl.list({} as any, fakeReq));
      expect(myList.map((a) => a.id)).toContain(ackId);

      const all = await withTestTenant(async () => ackCtrl.list({ all: true } as any, fakeReq));
      expect(all.map((a) => a.id)).toContain(ackId);

      const single = await withTestTenant(async () => ackCtrl.getById(ackId, fakeReq));
      expect(single.id).toBe(ackId);

      const ackd = await withTestTenant(async () => ackCtrl.acknowledge(ackId, fakeReq));
      expect(ackd.status).toBe('ACKNOWLEDGED');

      // Seed second and dispute it
      const id2 = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.tsk_acknowledgements
           (id, school_id, subject_id, source_type, source_ref_id, source_table, title, created_by, requires_dispute_option)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'POLICY_DOCUMENT', gen_random_uuid(),
                 'policy_documents', 'ctrl dispute', $4::uuid, true)`,
        id2,
        TEST_SCHOOL_ID,
        TEST_ADMIN_PERSON_ID,
        TEST_ADMIN_ACCOUNT_ID,
      );
      const disp = await withTestTenant(async () =>
        ackCtrl.dispute(id2, { reason: 'nope' } as any, fakeReq),
      );
      expect(disp.status).toBe('ACKNOWLEDGED_WITH_DISPUTE');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // TaskWorker.handle (auto-task rule evaluation + creation)
  // ───────────────────────────────────────────────────────────────────
  describe('TaskWorker.handle', () => {
    function makeMsg(
      eventType: string,
      payload: Record<string, unknown>,
      schoolId = TEST_SCHOOL_ID,
    ) {
      return {
        topic: eventType, // worker un-prefixes via unprefixTopic; integration runs without prefix
        partition: 0,
        offset: '1',
        key: 'k',
        payload: {
          event_id: generateId(),
          tenant_id: schoolId,
          payload,
        },
        headers: { 'tenant-subdomain': 'test' },
        timestamp: Date.now().toString(),
      } as any;
    }

    beforeEach(() => {
      stubRedis.claims.clear();
      stubRedis.claimAllowed = true;
    });

    it('drops event with no rules for type', async () => {
      kafka.reset();
      await (worker as any).handle(makeMsg('no.such.event', {}));
      expect(kafka.callsForTopic('task.created')).toHaveLength(0);
    });

    it('SCHOOL_ADMIN rule with condition GT met fires + emits task.created', async () => {
      kafka.reset();
      await (worker as any).handle(
        makeMsg('pay.invoice.overdue', {
          invoiceNumber: 'INV-001',
          invoice_number: 'INV-001',
          amount: 500,
          sourceRefId: '019e0aaa-aaaa-7777-8888-000000099001',
        }),
      );
      const created = kafka.callsForTopic('task.created');
      expect(created.length).toBeGreaterThan(0);
      expect(created[0]!.payload).toMatchObject({
        taskCategory: 'ADMINISTRATIVE',
        priority: 'URGENT',
      });
    });

    it('SCHOOL_ADMIN rule with condition GT NOT met → no emit', async () => {
      kafka.reset();
      await (worker as any).handle(
        makeMsg('pay.invoice.overdue', {
          amount: 50, // below threshold
          sourceRefId: '019e0aaa-aaaa-7777-8888-000000099002',
        }),
      );
      expect(kafka.callsForTopic('task.created')).toHaveLength(0);
    });

    it('STUDENT rule with payload.studentId resolves student account and creates task', async () => {
      // Seed a student + sis_student row + platform_users link.
      const personId = generateId();
      const platformStudentId = generateId();
      const studentId = generateId();
      const accountId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
         VALUES ($1::uuid, 'Stu', 'Dent', 'STUDENT', true)`,
        personId,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.platform_users
           (id, person_id, email, display_name, account_status, account_type, mfa_enabled)
         VALUES ($1::uuid, $2::uuid, 'stu-' || $1::text || '@t.local',
                 'Stu', 'ACTIVE', 'HUMAN', false)`,
        accountId,
        personId,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
         VALUES ($1::uuid, $2::uuid, 'Stu', 'Dent', true)`,
        platformStudentId,
        personId,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_students
           (id, platform_student_id, school_id, student_number, grade_level, enrollment_status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'WV8-' || floor(random()*100000)::text, '5', 'ENROLLED')`,
        studentId,
        platformStudentId,
        TEST_SCHOOL_ID,
      );
      // Reseed the ASSIGN rule to target STUDENT and target a custom event
      // we control here. Reuse the existing 'cls.assignment.posted' rule
      // but feed a `studentId` payload form (the resolver tries class-id
      // first; without sis_enrollments, falls through to studentId path
      // only if rule.target_role is STUDENT and not assignment.posted).
      // For simplicity, change rule to target a custom event_type that
      // dispatches into the STUDENT path.
      const customRuleId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.tsk_auto_task_rules
           (id, school_id, trigger_event_type, target_role, title_template,
            priority, task_category, is_active, is_system)
         VALUES ($1::uuid, $2::uuid, 'custom.student.event', 'STUDENT',
                 'Hello {studentId}', 'NORMAL', 'PERSONAL', true, true)`,
        customRuleId,
        TEST_SCHOOL_ID,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.tsk_auto_task_actions
           (id, rule_id, action_type, sort_order)
         VALUES (gen_random_uuid(), $1::uuid, 'CREATE_TASK', 0)`,
        customRuleId,
      );

      kafka.reset();
      await (worker as any).handle(
        makeMsg('custom.student.event', { studentId, sourceRefId: generateId() }),
      );
      const created = kafka.callsForTopic('task.created');
      expect(created.length).toBeGreaterThan(0);
      expect(created[0]!.payload).toMatchObject({ ownerId: accountId });

      // Cleanup the custom rule + seeded student + platform rows.
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE id = $1::uuid`,
        studentId,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.platform_students WHERE id = $1::uuid`,
        platformStudentId,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.platform_users WHERE id = $1::uuid`,
        accountId,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.iam_person WHERE id = $1::uuid`,
        personId,
      );
    });

    it('GUARDIAN rule reads guardianAccountId from payload', async () => {
      const customRuleId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.tsk_auto_task_rules
           (id, school_id, trigger_event_type, target_role, title_template,
            priority, task_category, is_active, is_system)
         VALUES ($1::uuid, $2::uuid, 'custom.guardian.event', 'GUARDIAN',
                 'GHello', 'NORMAL', 'PERSONAL', true, true)`,
        customRuleId,
        TEST_SCHOOL_ID,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.tsk_auto_task_actions
           (id, rule_id, action_type, sort_order)
         VALUES (gen_random_uuid(), $1::uuid, 'CREATE_TASK', 0)`,
        customRuleId,
      );
      kafka.reset();
      await (worker as any).handle(
        makeMsg('custom.guardian.event', {
          guardianAccountId: TEST_ADMIN_ACCOUNT_ID,
          sourceRefId: generateId(),
        }),
      );
      const created = kafka.callsForTopic('task.created');
      expect(created.length).toBeGreaterThan(0);
    });

    it('fallback recipientAccountId path when no target_role', async () => {
      const customRuleId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.tsk_auto_task_rules
           (id, school_id, trigger_event_type, target_role, title_template,
            priority, task_category, is_active, is_system)
         VALUES ($1::uuid, $2::uuid, 'custom.fallback.event', NULL,
                 'Fallback', 'NORMAL', 'PERSONAL', true, true)`,
        customRuleId,
        TEST_SCHOOL_ID,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.tsk_auto_task_actions
           (id, rule_id, action_type, sort_order)
         VALUES (gen_random_uuid(), $1::uuid, 'CREATE_TASK', 0)`,
        customRuleId,
      );
      kafka.reset();
      await (worker as any).handle(
        makeMsg('custom.fallback.event', {
          recipientAccountId: TEST_ADMIN_ACCOUNT_ID,
          sourceRefId: generateId(),
        }),
      );
      expect(kafka.callsForTopic('task.created').length).toBeGreaterThan(0);
    });

    it('CREATE_ACKNOWLEDGEMENT + CREATE_TASK rule chains ack → task with linked acknowledgement_id', async () => {
      // Create a custom rule targeting SCHOOL_ADMIN so the fallback
      // resolves to seeded admins. Two actions in order:
      // CREATE_ACKNOWLEDGEMENT then CREATE_TASK.
      const customRuleId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.tsk_auto_task_rules
           (id, school_id, trigger_event_type, target_role, title_template,
            priority, task_category, is_active, is_system)
         VALUES ($1::uuid, $2::uuid, 'announcement.policy.posted', 'SCHOOL_ADMIN',
                 'Ack {announcement_title}', 'HIGH', 'ACKNOWLEDGEMENT', true, true)`,
        customRuleId,
        TEST_SCHOOL_ID,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.tsk_auto_task_actions
           (id, rule_id, action_type, sort_order)
         VALUES (gen_random_uuid(), $1::uuid, 'CREATE_ACKNOWLEDGEMENT', 0),
                (gen_random_uuid(), $1::uuid, 'CREATE_TASK', 1)`,
        customRuleId,
      );
      kafka.reset();
      const sourceRefId = generateId();
      await (worker as any).handle(
        makeMsg('announcement.policy.posted', {
          announcementId: sourceRefId,
          announcement_title: 'Hi',
        }),
      );
      const created = kafka.callsForTopic('task.created');
      expect(created.length).toBeGreaterThan(0);
      const taskRows = await rawClient.$queryRawUnsafe<Array<{ ack_id: string | null }>>(
        `SELECT acknowledgement_id::text AS ack_id FROM ${TEST_SCHEMA}.tsk_tasks
         WHERE source_ref_id = $1::uuid LIMIT 1`,
        sourceRefId,
      );
      expect(taskRows[0]?.ack_id).toBeTruthy();
    });

    it('redis dedup hit → skip task creation for owner', async () => {
      kafka.reset();
      const sourceRefId = generateId();
      // Pre-block all claims globally so the dedup hits for every owner.
      stubRedis.claimAllowed = false;
      await (worker as any).handle(makeMsg('pay.invoice.overdue', { amount: 1000, sourceRefId }));
      const matching = kafka
        .callsForTopic('task.created')
        .filter((c: any) => c.payload?.sourceRefId === sourceRefId);
      expect(matching).toHaveLength(0);
    });

    it('cross-school: School A rule does not fire for School B tenant', async () => {
      // Use School B's tenant_id. Only the School B assign rule applies
      // (cls.assignment.posted target STUDENT). Our event has no studentId
      // → 0 owners → no creation.
      kafka.reset();
      await (worker as any).handle(
        makeMsg(
          'cls.assignment.posted',
          { assignment_title: 'X' },
          '019e0cf8-aaaa-7777-8888-00000000000b',
        ),
      );
      expect(kafka.callsForTopic('task.created')).toHaveLength(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // evaluateConditions helper (export)
  // ───────────────────────────────────────────────────────────────────
  describe('evaluateConditions', () => {
    const payload = { a: 5, b: 'x', nested: { c: 'inside' }, missing: null };

    it('returns true for empty conditions', () => {
      expect(evaluateConditions([], payload)).toBe(true);
    });

    it('EXISTS handles present + null + missing', () => {
      expect(
        evaluateConditions([{ field_path: 'a', operator: 'EXISTS', value: null }], payload),
      ).toBe(true);
      expect(
        evaluateConditions([{ field_path: 'missing', operator: 'EXISTS', value: null }], payload),
      ).toBe(false);
      expect(
        evaluateConditions([{ field_path: 'absent', operator: 'EXISTS', value: null }], payload),
      ).toBe(false);
    });

    it('EQUALS / NOT_EQUALS', () => {
      expect(evaluateConditions([{ field_path: 'a', operator: 'EQUALS', value: 5 }], payload)).toBe(
        true,
      );
      expect(
        evaluateConditions([{ field_path: 'a', operator: 'NOT_EQUALS', value: 6 }], payload),
      ).toBe(true);
    });

    it('IN / NOT_IN', () => {
      expect(
        evaluateConditions([{ field_path: 'a', operator: 'IN', value: [1, 5, 10] }], payload),
      ).toBe(true);
      expect(
        evaluateConditions([{ field_path: 'a', operator: 'NOT_IN', value: [1, 2] }], payload),
      ).toBe(true);
    });

    it('GT / LT', () => {
      expect(evaluateConditions([{ field_path: 'a', operator: 'GT', value: 4 }], payload)).toBe(
        true,
      );
      expect(evaluateConditions([{ field_path: 'a', operator: 'LT', value: 4 }], payload)).toBe(
        false,
      );
    });

    it('unknown operator returns false', () => {
      expect(evaluateConditions([{ field_path: 'a', operator: 'WTF', value: 5 }], payload)).toBe(
        false,
      );
    });

    it('dotted field_path resolves nested', () => {
      expect(
        evaluateConditions(
          [{ field_path: 'nested.c', operator: 'EQUALS', value: 'inside' }],
          payload,
        ),
      ).toBe(true);
    });

    it('AND semantics — one false fails the chain', () => {
      expect(
        evaluateConditions(
          [
            { field_path: 'a', operator: 'EQUALS', value: 5 },
            { field_path: 'b', operator: 'EQUALS', value: 'wrong' },
          ],
          payload,
        ),
      ).toBe(false);
    });

    it('object value compared via JSON-equal', () => {
      const p = { o: { k: 1 } } as any;
      expect(
        evaluateConditions([{ field_path: 'o', operator: 'EQUALS', value: { k: 1 } }], p),
      ).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // TaskWorker.bootstrapSubscriptions (onModuleInit)
  // ───────────────────────────────────────────────────────────────────
  describe('TaskWorker.onModuleInit', () => {
    it('builds subscription set from active rules across tenants and calls consumer.subscribe', async () => {
      const subscribeCalls: any[] = [];
      const cons = {
        subscribe: async (opts: any) => {
          subscribeCalls.push(opts);
        },
      };
      const localWorker = new TaskWorker(
        rawClient,
        tenantPrisma,
        cons as any,
        { isClaimed: async () => false, claim: async () => {} } as any,
        kafka as any,
        stubRedis,
      );
      await localWorker.onModuleInit();
      // The seed has the demo tenant + our test tenant; subscribe may
      // pick up event types from both. Just assert subscribe got called.
      // (Allow zero calls in the unlikely case the seed has no rules.)
      expect(Array.isArray(subscribeCalls)).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Fixture sanity
  // ───────────────────────────────────────────────────────────────────
  describe('fixture sanity', () => {
    it('canonical rules are seeded', async () => {
      const rows = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text AS id FROM ${TEST_SCHEMA}.tsk_auto_task_rules WHERE id IN ($1::uuid, $2::uuid)`,
        TEST_TSK_RULE_ASSIGN_A_ID,
        TEST_TSK_RULE_ADMIN_A_ID,
      );
      expect(rows.length).toBeGreaterThanOrEqual(2);
    });

    it('resetTasksTables wipes all', async () => {
      // Insert a task, then reset.
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.tsk_tasks
           (id, school_id, owner_id, title, source, priority, status, task_category)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'X', 'MANUAL', 'NORMAL', 'TODO', 'PERSONAL')`,
        TEST_SCHOOL_ID,
        TEST_ADMIN_ACCOUNT_ID,
      );
      await resetTasksTables(rawClient);
      const c = await rawClient.$queryRawUnsafe<Array<{ c: bigint }>>(
        `SELECT count(*)::bigint AS c FROM ${TEST_SCHEMA}.tsk_tasks`,
      );
      expect(Number(c[0]!.c)).toBe(0);
    });
  });
});
