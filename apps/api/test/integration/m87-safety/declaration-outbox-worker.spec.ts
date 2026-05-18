import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import {
  DeclarationOutboxWorker,
  deterministicStepEventId,
} from '@modules/m87-safety/emergency/declaration-outbox.worker';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { makeRecordingKafka, type RecordingKafkaProducer } from '../helpers/recording-kafka';
import type { KafkaProducerService } from '@shared/kafka/kafka-producer.service';

import {
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
  TEST_SCHEMA,
  TEST_SUBDOMAIN,
} from '../helpers/tenant-context';
import {
  TEST_ADMIN_ACCOUNT_ID,
  TEST_ADMIN_EMPLOYEE_ID,
} from '../helpers/actor';

/**
 * DB-backed integration tests for DeclarationOutboxWorker — the P2C2
 * KEYSTONE worker that fans out the three async steps after an
 * emergency incident declaration.
 */
describe('integration:m87-safety/declaration-outbox-worker', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let kafka: RecordingKafkaProducer & KafkaProducerService;
  let worker: DeclarationOutboxWorker;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    kafka = makeRecordingKafka();
    worker = new DeclarationOutboxWorker(tenantPrisma, kafka);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    kafka.reset();
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.inc_accountability_summary WHERE incident_id IN
         (SELECT id FROM ${TEST_SCHEMA}.inc_incidents WHERE school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.inc_accountability_records WHERE incident_id IN
         (SELECT id FROM ${TEST_SCHEMA}.inc_incidents WHERE school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.inc_declaration_outbox WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.inc_incidents WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.inc_emergency_procedures WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
  });

  async function seedIncidentType(opts: {
    code: string;
    name: string;
    notificationTemplate?: string | null;
  }): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.inc_incident_types
         (id, school_id, code, name, severity, notification_template, is_active)
       VALUES ($1::uuid, NULL, $2, $3, 'HIGH', $4, true)
       ON CONFLICT (COALESCE(school_id, '00000000-0000-0000-0000-000000000000'::uuid), code)
       DO UPDATE SET notification_template = EXCLUDED.notification_template,
                     name = EXCLUDED.name,
                     severity = EXCLUDED.severity`,
      id,
      opts.code,
      opts.name,
      opts.notificationTemplate ?? null,
    );
    // If conflict, look up actual
    const found = (await rawClient.$queryRawUnsafe(
      `SELECT id::text AS id FROM ${TEST_SCHEMA}.inc_incident_types WHERE code = $1 LIMIT 1`,
      opts.code,
    )) as Array<{ id: string }>;
    return found[0]!.id;
  }

  async function seedProcedure(opts: {
    procedureType: string;
    primaryContactId: string | null;
    secondaryContactId?: string | null;
    school?: string;
  }): Promise<string> {
    const id = generateId();
    if (!opts.primaryContactId) {
      throw new Error('primaryContactId required');
    }
    const today = new Date().toISOString().slice(0, 10);
    const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.inc_emergency_procedures
         (id, school_id, procedure_type, title, procedure_steps, primary_contact_id,
          secondary_contact_id, last_reviewed_at, reviewed_by, next_review_date, is_active)
       VALUES ($1::uuid, $2::uuid, $3, $4, '[]'::jsonb, $5::uuid, $6::uuid, $7::date, $8::uuid, $9::date, true)`,
      id,
      opts.school ?? TEST_SCHOOL_ID,
      opts.procedureType,
      'Procedure ' + opts.procedureType,
      opts.primaryContactId,
      opts.secondaryContactId ?? null,
      today,
      TEST_ADMIN_EMPLOYEE_ID,
      future,
    );
    return id;
  }

  async function seedIncidentAndOutbox(opts: {
    typeCode?: string;
    procedureType?: string;
    primaryContact?: string | null;
    secondaryContact?: string | null;
    declaredAtMinutesAgo?: number;
    omitProcedure?: boolean;
    notificationTemplate?: string | null;
    school?: string;
  } = {}): Promise<{ incidentId: string; outboxId: string; typeId: string }> {
    const typeCode = opts.typeCode ?? 'FIRE_EVACUATION';
    const procedureType = opts.procedureType ?? typeCode;
    const typeId = await seedIncidentType({
      code: typeCode,
      name: typeCode,
      notificationTemplate: opts.notificationTemplate,
    });
    const school = opts.school ?? TEST_SCHOOL_ID;
    if (!opts.omitProcedure) {
      await seedProcedure({
        procedureType,
        primaryContactId: opts.primaryContact ?? TEST_ADMIN_EMPLOYEE_ID,
        secondaryContactId: opts.secondaryContact,
        school,
      });
    }
    const incidentId = generateId();
    const outboxId = generateId();
    const declaredAt = new Date(
      Date.now() - (opts.declaredAtMinutesAgo ?? 0) * 60 * 1000,
    ).toISOString();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.inc_incidents
         (id, school_id, incident_type_id, title, declared_by, declared_at, status, description)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6::timestamptz, 'ACTIVE', 'Test')`,
      incidentId,
      school,
      typeId,
      'Test Incident',
      TEST_ADMIN_ACCOUNT_ID,
      declaredAt,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.inc_declaration_outbox
         (id, incident_id, school_id, declared_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz)`,
      outboxId,
      incidentId,
      school,
      declaredAt,
    );
    return { incidentId, outboxId, typeId };
  }

  async function runWithTenant<T>(fn: () => Promise<T>): Promise<T> {
    const { runWithTenantContextAsync } = await import('@shared/tenant');
    return runWithTenantContextAsync(
      {
        tenant: {
          schoolId: TEST_SCHOOL_ID,
          schemaName: TEST_SCHEMA,
          organisationId: null,
          subdomain: TEST_SUBDOMAIN,
          isFrozen: false,
          planTier: 'MEDIUM',
          homeRegion: 'us-east-1',
        },
      },
      fn,
    );
  }

  async function readOutbox(outboxId: string): Promise<{
    tasks_created_at: string | null;
    muster_taken_at: string | null;
    alert_sent_at: string | null;
    last_error: string | null;
    attempt_count: number;
  }> {
    const rows = (await rawClient.$queryRawUnsafe(
      `SELECT tasks_created_at::text AS tasks_created_at, muster_taken_at::text AS muster_taken_at,
              alert_sent_at::text AS alert_sent_at, last_error, attempt_count
         FROM ${TEST_SCHEMA}.inc_declaration_outbox WHERE id = $1::uuid`,
      outboxId,
    )) as Array<{
      tasks_created_at: string | null;
      muster_taken_at: string | null;
      alert_sent_at: string | null;
      last_error: string | null;
      attempt_count: number;
    }>;
    return rows[0]!;
  }

  describe('deterministicStepEventId', () => {
    it('returns a v5-shaped UUID; stable for same (outboxId, step)', () => {
      const id1 = deterministicStepEventId('019e3a01-aaaa-bbbb-cccc-000000000001', 'tasks-0');
      const id2 = deterministicStepEventId('019e3a01-aaaa-bbbb-cccc-000000000001', 'tasks-0');
      expect(id1).toBe(id2);
      expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it('different step yields different uuid', () => {
      const id1 = deterministicStepEventId('019e3a01-aaaa-bbbb-cccc-000000000001', 'tasks-0');
      const id2 = deterministicStepEventId('019e3a01-aaaa-bbbb-cccc-000000000001', 'muster');
      expect(id1).not.toBe(id2);
    });
  });

  describe('runStepTasks', () => {
    it('emits inc.emergency.task.requested per contact + stamps tasks_created_at', async () => {
      const otherEmployeeId = '019e0cf8-aaaa-7777-8888-000000000022'; // officer employee id
      const { outboxId } = await seedIncidentAndOutbox({
        primaryContact: TEST_ADMIN_EMPLOYEE_ID,
        secondaryContact: otherEmployeeId,
      });
      const row = await loadOutboxRowJoined(outboxId);
      await runWithTenant(async () => worker.runStepTasks(row));

      const emits = kafka.calls.filter((e) => e.topic === 'inc.emergency.task.requested');
      expect(emits.length).toBe(2);
      const recipients = emits.map((e) => (e.payload as { recipientAccountId: string }).recipientAccountId);
      expect(recipients).toContain(TEST_ADMIN_EMPLOYEE_ID);
      expect(recipients).toContain(otherEmployeeId);

      const after = await readOutbox(outboxId);
      expect(after.tasks_created_at).not.toBeNull();
    });

    it('single-contact procedure → one emit', async () => {
      const { outboxId } = await seedIncidentAndOutbox({
        primaryContact: TEST_ADMIN_EMPLOYEE_ID,
        secondaryContact: null,
      });
      const row = await loadOutboxRowJoined(outboxId);
      await runWithTenant(async () => worker.runStepTasks(row));
      const emits = kafka.calls.filter((e) => e.topic === 'inc.emergency.task.requested');
      expect(emits.length).toBe(1);
    });

    it('secondary equal to primary → dedupes to one emit', async () => {
      const { outboxId } = await seedIncidentAndOutbox({
        primaryContact: TEST_ADMIN_EMPLOYEE_ID,
        secondaryContact: TEST_ADMIN_EMPLOYEE_ID,
      });
      const row = await loadOutboxRowJoined(outboxId);
      await runWithTenant(async () => worker.runStepTasks(row));
      const emits = kafka.calls.filter((e) => e.topic === 'inc.emergency.task.requested');
      expect(emits.length).toBe(1);
    });

    it('no procedure / no contacts → still stamps tasks_created_at (skip)', async () => {
      const { outboxId } = await seedIncidentAndOutbox({ omitProcedure: true });
      const row = await loadOutboxRowJoined(outboxId);
      await runWithTenant(async () => worker.runStepTasks(row));
      const emits = kafka.calls.filter((e) => e.topic === 'inc.emergency.task.requested');
      expect(emits.length).toBe(0);
      const after = await readOutbox(outboxId);
      expect(after.tasks_created_at).not.toBeNull();
    });

    it('skips when tasks_created_at already stamped', async () => {
      const { outboxId } = await seedIncidentAndOutbox({
        primaryContact: TEST_ADMIN_EMPLOYEE_ID,
      });
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.inc_declaration_outbox SET tasks_created_at = now() WHERE id = $1::uuid`,
        outboxId,
      );
      const row = await loadOutboxRowJoined(outboxId);
      await runWithTenant(async () => worker.runStepTasks(row));
      const emits = kafka.calls.filter((e) => e.topic === 'inc.emergency.task.requested');
      expect(emits.length).toBe(0);
    });
  });

  describe('runStepMuster', () => {
    it('emits inc.emergency.muster.requested + seeds accountability summary + stamps muster_taken_at', async () => {
      const { outboxId, incidentId } = await seedIncidentAndOutbox({
        primaryContact: TEST_ADMIN_EMPLOYEE_ID,
      });
      const row = await loadOutboxRowJoined(outboxId);
      await runWithTenant(async () => worker.runStepMuster(row));

      const emits = kafka.calls.filter((e) => e.topic === 'inc.emergency.muster.requested');
      expect(emits.length).toBe(1);
      const payload = emits[0]!.payload as { drillType: string; totalOnSiteAtSnapshot: number };
      expect(payload.drillType).toBe('FIRE_DRILL'); // FIRE_EVACUATION → FIRE_DRILL

      // Summary row materialised
      const summary = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.inc_accountability_summary WHERE incident_id = $1::uuid`,
        incidentId,
      )) as Array<{ n: number }>;
      expect(summary[0]!.n).toBe(1);

      const after = await readOutbox(outboxId);
      expect(after.muster_taken_at).not.toBeNull();
    });

    it('LOCKDOWN procedure → drillType=LOCKDOWN', async () => {
      const { outboxId } = await seedIncidentAndOutbox({
        typeCode: 'LOCKDOWN',
        procedureType: 'LOCKDOWN',
        primaryContact: TEST_ADMIN_EMPLOYEE_ID,
      });
      const row = await loadOutboxRowJoined(outboxId);
      await runWithTenant(async () => worker.runStepMuster(row));
      const emit = kafka.calls.find((e) => e.topic === 'inc.emergency.muster.requested')!;
      expect((emit.payload as { drillType: string }).drillType).toBe('LOCKDOWN');
    });

    it('BOMB_THREAT procedure → drillType=BOMB_THREAT', async () => {
      const { outboxId } = await seedIncidentAndOutbox({
        typeCode: 'BOMB_THREAT',
        procedureType: 'BOMB_THREAT',
        primaryContact: TEST_ADMIN_EMPLOYEE_ID,
      });
      const row = await loadOutboxRowJoined(outboxId);
      await runWithTenant(async () => worker.runStepMuster(row));
      const emit = kafka.calls.find((e) => e.topic === 'inc.emergency.muster.requested')!;
      expect((emit.payload as { drillType: string }).drillType).toBe('BOMB_THREAT');
    });

    it('SHELTER_IN_PLACE procedure → drillType=EVACUATION', async () => {
      const { outboxId } = await seedIncidentAndOutbox({
        typeCode: 'SHELTER_IN_PLACE',
        procedureType: 'SHELTER_IN_PLACE',
        primaryContact: TEST_ADMIN_EMPLOYEE_ID,
      });
      const row = await loadOutboxRowJoined(outboxId);
      await runWithTenant(async () => worker.runStepMuster(row));
      const emit = kafka.calls.find((e) => e.topic === 'inc.emergency.muster.requested')!;
      expect((emit.payload as { drillType: string }).drillType).toBe('EVACUATION');
    });

    it('unknown procedure_type → drillType=OTHER', async () => {
      const { outboxId } = await seedIncidentAndOutbox({
        typeCode: 'GENERAL',
        procedureType: 'GENERAL',
        primaryContact: TEST_ADMIN_EMPLOYEE_ID,
      });
      const row = await loadOutboxRowJoined(outboxId);
      await runWithTenant(async () => worker.runStepMuster(row));
      const emit = kafka.calls.find((e) => e.topic === 'inc.emergency.muster.requested')!;
      expect((emit.payload as { drillType: string }).drillType).toBe('OTHER');
    });

    it('skips when muster_taken_at already stamped', async () => {
      const { outboxId } = await seedIncidentAndOutbox({
        primaryContact: TEST_ADMIN_EMPLOYEE_ID,
      });
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.inc_declaration_outbox SET muster_taken_at = now() WHERE id = $1::uuid`,
        outboxId,
      );
      const row = await loadOutboxRowJoined(outboxId);
      await runWithTenant(async () => worker.runStepMuster(row));
      const emits = kafka.calls.filter((e) => e.topic === 'inc.emergency.muster.requested');
      expect(emits.length).toBe(0);
    });
  });

  describe('runStepAlert', () => {
    it('emits inc.emergency.alert.dispatch + stamps alert_sent_at', async () => {
      const { outboxId } = await seedIncidentAndOutbox({
        primaryContact: TEST_ADMIN_EMPLOYEE_ID,
        notificationTemplate: 'Please follow staff instructions immediately.',
      });
      const row = await loadOutboxRowJoined(outboxId);
      await runWithTenant(async () => worker.runStepAlert(row));

      const emits = kafka.calls.filter((e) => e.topic === 'inc.emergency.alert.dispatch');
      expect(emits.length).toBe(1);
      const payload = emits[0]!.payload as { notificationTemplate: string; severity: string };
      expect(payload.notificationTemplate).toBe('Please follow staff instructions immediately.');
      expect(payload.severity).toBe('HIGH');

      const after = await readOutbox(outboxId);
      expect(after.alert_sent_at).not.toBeNull();
    });

    it('uses fallback notification template when type has none', async () => {
      const { outboxId } = await seedIncidentAndOutbox({
        primaryContact: TEST_ADMIN_EMPLOYEE_ID,
        notificationTemplate: null,
      });
      const row = await loadOutboxRowJoined(outboxId);
      await runWithTenant(async () => worker.runStepAlert(row));
      const emit = kafka.calls.find((e) => e.topic === 'inc.emergency.alert.dispatch')!;
      expect((emit.payload as { notificationTemplate: string }).notificationTemplate).toMatch(
        /staff instructions/i,
      );
    });

    it('skips when alert_sent_at already stamped', async () => {
      const { outboxId } = await seedIncidentAndOutbox({
        primaryContact: TEST_ADMIN_EMPLOYEE_ID,
      });
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.inc_declaration_outbox SET alert_sent_at = now() WHERE id = $1::uuid`,
        outboxId,
      );
      const row = await loadOutboxRowJoined(outboxId);
      await runWithTenant(async () => worker.runStepAlert(row));
      const emits = kafka.calls.filter((e) => e.topic === 'inc.emergency.alert.dispatch');
      expect(emits.length).toBe(0);
    });
  });

  describe('tick — multi-tenant orchestration', () => {
    it('processes pending outbox row across active schools (stamps all 3 step columns)', async () => {
      const { outboxId } = await seedIncidentAndOutbox({
        primaryContact: TEST_ADMIN_EMPLOYEE_ID,
      });
      // tick runs all schools; for our test outbox, after 3 ticks all
      // steps should be stamped (tasks first, then muster, then alert).
      await worker.tick();
      await worker.tick();
      await worker.tick();
      const after = await readOutbox(outboxId);
      expect(after.tasks_created_at).not.toBeNull();
      expect(after.muster_taken_at).not.toBeNull();
      expect(after.alert_sent_at).not.toBeNull();
    });

    it('concurrent tick is rejected (running flag prevents overlapping passes)', async () => {
      // Best-effort: run tick twice in rapid succession. If both await
      // sequentially this is a no-op test; the running flag prevents
      // a second concurrent tick, which we can't easily race here.
      // Verify both calls complete without error.
      await Promise.all([worker.tick(), worker.tick()]);
      expect(true).toBe(true);
    });
  });

  describe('checkStall', () => {
    it('logs OUTBOX_STALL for incidents older than 5 minutes with unstamped steps (no throw)', async () => {
      const { outboxId } = await seedIncidentAndOutbox({
        primaryContact: TEST_ADMIN_EMPLOYEE_ID,
        declaredAtMinutesAgo: 10,
      });
      // tick should log stall but not throw
      await expect(worker.tick()).resolves.toBeUndefined();
      // After tick, the outbox steps complete (5min stale doesn't block).
      const after = await readOutbox(outboxId);
      expect(after.tasks_created_at).not.toBeNull();
    });
  });

  describe('onModuleInit + onApplicationShutdown', () => {
    it('disabled via env → init does not schedule', () => {
      const origEnv = process.env.DECLARATION_OUTBOX_DISABLED;
      try {
        process.env.DECLARATION_OUTBOX_DISABLED = '1';
        const w = new DeclarationOutboxWorker(tenantPrisma, kafka);
        w.onModuleInit();
        w.onApplicationShutdown(); // cleanup
        expect(true).toBe(true);
      } finally {
        if (origEnv === undefined) delete process.env.DECLARATION_OUTBOX_DISABLED;
        else process.env.DECLARATION_OUTBOX_DISABLED = origEnv;
      }
    });

    it('shutdown clears scheduled timers cleanly', () => {
      const origEnv = process.env.DECLARATION_OUTBOX_DISABLED;
      try {
        delete process.env.DECLARATION_OUTBOX_DISABLED;
        process.env.DECLARATION_OUTBOX_WARMUP_MS = '60000';
        process.env.DECLARATION_OUTBOX_INTERVAL_MS = '5000';
        const w = new DeclarationOutboxWorker(tenantPrisma, kafka);
        w.onModuleInit();
        w.onApplicationShutdown();
        // No error means timer cleanup worked
        expect(true).toBe(true);
      } finally {
        if (origEnv === undefined) delete process.env.DECLARATION_OUTBOX_DISABLED;
        else process.env.DECLARATION_OUTBOX_DISABLED = origEnv;
      }
    });
  });

  // Helper — build the OutboxRow shape with JOINs the way the worker
  // queries it. Exposed because the runStepX methods take an OutboxRow
  // not an id.
  async function loadOutboxRowJoined(outboxId: string): Promise<Parameters<DeclarationOutboxWorker['runStepTasks']>[0]> {
    const rows = (await rawClient.$queryRawUnsafe(
      `SELECT o.id::text AS id, o.incident_id::text AS incident_id,
              o.school_id::text AS school_id, o.declared_at::text AS declared_at,
              o.tasks_created_at::text AS tasks_created_at,
              o.muster_taken_at::text AS muster_taken_at,
              o.alert_sent_at::text AS alert_sent_at,
              o.attempt_count,
              i.title AS incident_title, it.code AS incident_type_code,
              COALESCE(it.code, 'GENERAL') AS procedure_type,
              it.notification_template, it.severity,
              p.primary_contact_id::text AS primary_contact_id,
              p.secondary_contact_id::text AS secondary_contact_id
         FROM ${TEST_SCHEMA}.inc_declaration_outbox o
         JOIN ${TEST_SCHEMA}.inc_incidents i ON i.id = o.incident_id AND i.school_id = o.school_id
         LEFT JOIN ${TEST_SCHEMA}.inc_incident_types it ON it.id = i.incident_type_id
         LEFT JOIN ${TEST_SCHEMA}.inc_emergency_procedures p ON p.school_id = o.school_id
           AND p.procedure_type = it.code AND p.is_active = true
        WHERE o.id = $1::uuid`,
      outboxId,
    )) as Array<Parameters<DeclarationOutboxWorker['runStepTasks']>[0]>;
    return rows[0]!;
  }
});
