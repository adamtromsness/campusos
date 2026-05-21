import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { IncidentService } from '@modules/m87-safety/incidents/incident.service';
import { TimelineService } from '@modules/m87-safety/incidents/timeline.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import type { KafkaProducerService } from '@shared/kafka/kafka-producer.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
  TEST_SCHEMA,
} from '../helpers/tenant-context';
import {
  adminActor,
  officerActor,
  teacherActor,
  studentActor,
  parentActor,
  TEST_OFFICER_ACCOUNT_ID,
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';
import { RecordingKafkaProducer, makeRecordingKafka } from '../helpers/recording-kafka';

/**
 * Wave 3 — DB-backed integration tests for IncidentService + TimelineService.
 *
 * Strategy doc Wave 3 KEYSTONE contracts:
 *   - declare(): inc_incidents + inc_declaration_outbox MUST land in
 *     the same tenant tx (P2C2 atomic orchestration keystone). The
 *     `inc.emergency.declared` Kafka emit happens AFTER commit so a
 *     slow/failing broker cannot race the DB write (REVIEW-P2C2 ROUND 1
 *     MAJOR 2 fix). DeclarationOutboxWorker owns the operational
 *     fan-out.
 *   - resolve()/cancel(): state-machine transitions use SELECT FOR
 *     UPDATE inside the tenant tx so two concurrent requests cannot
 *     both pass the ACTIVE gate.
 *   - TimelineService: append-only legal record, no PATCH/DELETE
 *     surface. IMMUTABLE-trigger contract is verified in
 *     wave3-immutable-contracts.spec.ts; here we cover the service-
 *     side validation and tenant scoping.
 *
 * Tests use a RecordingKafkaProducer to capture emit() calls without
 * needing a live broker (per the DATABASE-BACKED rule from
 * docs/procurement-integration-test-harness.md D4).
 */
describe('integration:m87-safety/incident-lifecycle', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let recordingKafka: RecordingKafkaProducer;
  let kafka: RecordingKafkaProducer & KafkaProducerService;
  let service: IncidentService;
  let timeline: TimelineService;

  // Reusable incident type ids (platform default + per-school override)
  const platformTypeId = generateId();
  const platformLockdownTypeId = generateId();
  const schoolATypeId = generateId();
  const schoolBTypeId = generateId();
  const inactiveTypeId = generateId();

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    kafka = makeRecordingKafka();
    recordingKafka = kafka as unknown as RecordingKafkaProducer;
    service = new IncidentService(tenantPrisma, permCheck, kafka);
    timeline = new TimelineService(tenantPrisma, permCheck);

    // Seed reusable incident types in both schools' shared tenant_test
    // schema. Per the schema, school_id IS NULL is a platform default.
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.inc_incident_types (id, school_id, code, name, severity, requires_lockdown, is_active)
       VALUES
         ($1::uuid, NULL,             'WX-PLATFORM',  'Weather (platform)',  'MEDIUM', false, true),
         ($2::uuid, NULL,             'LD-PLATFORM',  'Lockdown (platform)', 'CRITICAL', true, true),
         ($3::uuid, $4::uuid,         'WX-SCHOOL-A',  'Weather (school A)',  'MEDIUM', false, true),
         ($5::uuid, $6::uuid,         'WX-SCHOOL-B',  'Weather (school B)',  'MEDIUM', false, true),
         ($7::uuid, NULL,             'INACTIVE-TYPE','Retired type',        'LOW',  false, false)
       ON CONFLICT (id) DO NOTHING`,
      platformTypeId,
      platformLockdownTypeId,
      schoolATypeId,
      TEST_SCHOOL_ID,
      schoolBTypeId,
      TEST_SCHOOL_B_ID,
      inactiveTypeId,
    );
  });

  afterAll(async () => {
    // Wipe incidents + outbox + timeline + types we created
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.inc_declaration_outbox WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(`TRUNCATE ${TEST_SCHEMA}.inc_incident_timeline`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.inc_incidents WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.inc_incident_types WHERE id = ANY($1::uuid[])`,
      [platformTypeId, platformLockdownTypeId, schoolATypeId, schoolBTypeId, inactiveTypeId],
    );
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    recordingKafka.reset();
    // Outbox FK cascades when we delete incidents
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.inc_declaration_outbox WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(`TRUNCATE ${TEST_SCHEMA}.inc_incident_timeline`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.inc_incidents WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    // Reset officer perm cache so :write tests are deterministic
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE account_id = $1::uuid`,
      TEST_OFFICER_ACCOUNT_ID,
    );
  });

  async function grantOfficerSafetyWrite(): Promise<void> {
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache
         (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], now(), 'test-hash')
       ON CONFLICT (account_id, scope_id) DO UPDATE
         SET permission_codes = EXCLUDED.permission_codes, computed_at = now()`,
      generateId(),
      TEST_OFFICER_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
      ['saf-001:write'],
    );
  }

  async function countIncidents(schoolId: string): Promise<number> {
    const rows = (await rawClient.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM ${TEST_SCHEMA}.inc_incidents WHERE school_id = $1::uuid`,
      schoolId,
    )) as Array<{ n: number }>;
    return rows[0]!.n;
  }

  async function readOutboxFor(incidentId: string) {
    return rawClient.$queryRawUnsafe<
      Array<{ incident_id: string; school_id: string; declared_at: string }>
    >(
      `SELECT incident_id::text AS incident_id, school_id::text AS school_id, declared_at::text AS declared_at
         FROM ${TEST_SCHEMA}.inc_declaration_outbox WHERE incident_id = $1::uuid`,
      incidentId,
    );
  }

  // ────────────────────────────────────────────────────────────────────
  // declare — KEYSTONE: incident + outbox atomic; emit AFTER commit
  // ────────────────────────────────────────────────────────────────────
  describe('declare (KEYSTONE: incident + outbox in same tx)', () => {
    it('admin declares with platform-default incident type → inc_incidents + inc_declaration_outbox both land', async () => {
      const dto = await withTestTenant(async () =>
        service.declare(
          {
            incidentTypeId: platformTypeId,
            title: 'Tornado warning',
            description: 'Sirens at 2pm',
          },
          adminActor(),
        ),
      );
      expect(dto.id).toBeTruthy();
      expect(dto.status).toBe('ACTIVE');
      expect(dto.schoolId).toBe(TEST_SCHOOL_ID);

      // Both rows present
      expect(await countIncidents(TEST_SCHOOL_ID)).toBe(1);
      const outbox = await readOutboxFor(dto.id);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]!.school_id).toBe(TEST_SCHOOL_ID);

      // Kafka emit happened AFTER commit (not buffered, immediately recorded)
      const emits = recordingKafka.callsForTopic('inc.emergency.declared');
      expect(emits).toHaveLength(1);
      expect(emits[0]!.key).toBe(dto.id);
      expect((emits[0]!.payload as any).incidentId).toBe(dto.id);
      expect((emits[0]!.payload as any).incidentTypeCode).toBe('WX-PLATFORM');
      expect((emits[0]!.payload as any).requiresLockdown).toBe(false);
    });

    it('admin declares a CRITICAL lockdown type → requiresLockdown=true on the dto AND in the emit', async () => {
      const dto = await withTestTenant(async () =>
        service.declare({ incidentTypeId: platformLockdownTypeId }, adminActor()),
      );
      expect(dto.severity).toBe('CRITICAL');
      expect(dto.requiresLockdown).toBe(true);
      const emit = recordingKafka.callsForTopic('inc.emergency.declared')[0]!;
      expect((emit.payload as any).requiresLockdown).toBe(true);
      expect((emit.payload as any).severity).toBe('CRITICAL');
    });

    it('admin declares with a school-A-specific incident type → ok', async () => {
      const dto = await withTestTenant(async () =>
        service.declare({ incidentTypeId: schoolATypeId }, adminActor()),
      );
      expect(dto.incidentTypeId).toBe(schoolATypeId);
    });

    it('STAFF with saf-001:write at SCHOOL scope can declare', async () => {
      await grantOfficerSafetyWrite();
      const dto = await withTestTenant(async () =>
        service.declare({ incidentTypeId: platformTypeId }, officerActor()),
      );
      expect(dto.status).toBe('ACTIVE');
      expect(await countIncidents(TEST_SCHOOL_ID)).toBe(1);
    });

    it.each([
      ['officer (no saf-001:write)', officerActor],
      ['teacher', teacherActor],
      ['student', studentActor],
      ['parent', parentActor],
    ])('declare as %s → ForbiddenException; no rows written', async (_label, actor) => {
      await expect(
        withTestTenant(async () => service.declare({ incidentTypeId: platformTypeId }, actor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(await countIncidents(TEST_SCHOOL_ID)).toBe(0);
      expect(recordingKafka.calls).toHaveLength(0);
    });

    it('inactive incident type → BadRequest; no incident row, no outbox row, no emit', async () => {
      await expect(
        withTestTenant(async () =>
          service.declare({ incidentTypeId: inactiveTypeId }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(await countIncidents(TEST_SCHOOL_ID)).toBe(0);
      expect(recordingKafka.calls).toHaveLength(0);
    });

    it('unknown incident type → BadRequest; no rows written', async () => {
      await expect(
        withTestTenant(async () =>
          service.declare({ incidentTypeId: '00000000-0000-0000-0000-000000000000' }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(await countIncidents(TEST_SCHOOL_ID)).toBe(0);
    });

    it('cross-school: School A tenant cannot declare using School B-owned incident type', async () => {
      await expect(
        withTestTenant(async () =>
          service.declare({ incidentTypeId: schoolBTypeId }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(await countIncidents(TEST_SCHOOL_ID)).toBe(0);
    });

    it('cross-school isolation: a declare in School A does not surface in School B counts', async () => {
      await withTestTenant(async () =>
        service.declare({ incidentTypeId: platformTypeId }, adminActor()),
      );
      expect(await countIncidents(TEST_SCHOOL_ID)).toBe(1);
      expect(await countIncidents(TEST_SCHOOL_B_ID)).toBe(0);
    });

    it('Kafka emit failure is swallowed (logged) — declare succeeds and rows are committed', async () => {
      // Swap kafka.emit with a throwing impl for this test
      const original = kafka.emit.bind(kafka);
      kafka.emit = (async () => {
        throw new Error('broker unavailable');
      }) as any;
      try {
        const dto = await withTestTenant(async () =>
          service.declare({ incidentTypeId: platformTypeId }, adminActor()),
        );
        // Committed despite broker failure
        expect(await countIncidents(TEST_SCHOOL_ID)).toBe(1);
        expect(await readOutboxFor(dto.id)).toHaveLength(1);
      } finally {
        kafka.emit = original;
      }
    });

    it('UNIQUE(incident_id) on inc_declaration_outbox: cannot have two outbox rows for one incident', async () => {
      const dto = await withTestTenant(async () =>
        service.declare({ incidentTypeId: platformTypeId }, adminActor()),
      );
      await expect(
        rawClient.$executeRawUnsafe(
          `INSERT INTO ${TEST_SCHEMA}.inc_declaration_outbox (id, incident_id, school_id, declared_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, now())`,
          generateId(),
          dto.id,
          TEST_SCHOOL_ID,
        ),
      ).rejects.toThrow();
    });

    it('resolved_chk: a freshly declared incident has resolved_at=NULL and resolved_by=NULL', async () => {
      const dto = await withTestTenant(async () =>
        service.declare({ incidentTypeId: platformTypeId }, adminActor()),
      );
      expect(dto.resolvedAt).toBeNull();
      expect(dto.resolvedBy).toBeNull();
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // resolve — ACTIVE → RESOLVED with SELECT FOR UPDATE
  // ────────────────────────────────────────────────────────────────────
  describe('resolve (state machine)', () => {
    async function declareActive(): Promise<string> {
      const dto = await withTestTenant(async () =>
        service.declare({ incidentTypeId: platformTypeId }, adminActor()),
      );
      return dto.id;
    }

    it('admin resolves ACTIVE → RESOLVED with notes; resolved_at + resolved_by stamped together', async () => {
      const incidentId = await declareActive();
      const dto = await withTestTenant(async () =>
        service.resolve(incidentId, { resolutionNotes: 'all clear at 3pm' }, adminActor()),
      );
      expect(dto.status).toBe('RESOLVED');
      expect(dto.resolvedAt).not.toBeNull();
      expect(dto.resolvedBy).not.toBeNull();
      expect(dto.resolutionNotes).toBe('all clear at 3pm');
    });

    it('STAFF with saf-001:write can resolve', async () => {
      const incidentId = await declareActive();
      await grantOfficerSafetyWrite();
      const dto = await withTestTenant(async () => service.resolve(incidentId, {}, officerActor()));
      expect(dto.status).toBe('RESOLVED');
    });

    it('cannot resolve a RESOLVED incident → BadRequest', async () => {
      const incidentId = await declareActive();
      await withTestTenant(async () => service.resolve(incidentId, {}, adminActor()));
      await expect(
        withTestTenant(async () => service.resolve(incidentId, {}, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cannot resolve a CANCELLED incident → BadRequest', async () => {
      const incidentId = await declareActive();
      await withTestTenant(async () => service.cancel(incidentId, adminActor()));
      await expect(
        withTestTenant(async () => service.resolve(incidentId, {}, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('resolve missing incident → NotFound', async () => {
      await expect(
        withTestTenant(async () =>
          service.resolve('00000000-0000-0000-0000-000000000000', {}, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school: cannot resolve an incident owned by another school → NotFound', async () => {
      const incidentId = await declareActive();
      await expect(
        withTestTenantB(async () => service.resolve(incidentId, {}, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
      // Original still ACTIVE in School A
      const dto = await withTestTenant(async () => service.getById(incidentId));
      expect(dto.status).toBe('ACTIVE');
    });

    it.each([
      ['officer (no saf-001:write)', officerActor],
      ['teacher', teacherActor],
      ['student', studentActor],
      ['parent', parentActor],
    ])('resolve as %s → ForbiddenException', async (_label, actor) => {
      const incidentId = await declareActive();
      await expect(
        withTestTenant(async () => service.resolve(incidentId, {}, actor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // cancel — ACTIVE → CANCELLED
  // ────────────────────────────────────────────────────────────────────
  describe('cancel', () => {
    async function declareActive(): Promise<string> {
      const dto = await withTestTenant(async () =>
        service.declare({ incidentTypeId: platformTypeId }, adminActor()),
      );
      return dto.id;
    }

    it('admin cancels ACTIVE → CANCELLED with default notes', async () => {
      const incidentId = await declareActive();
      const dto = await withTestTenant(async () => service.cancel(incidentId, adminActor()));
      expect(dto.status).toBe('CANCELLED');
      expect(dto.resolvedAt).not.toBeNull();
      expect(dto.resolutionNotes).toMatch(/cancelled/i);
    });

    it('cannot cancel a RESOLVED incident → BadRequest', async () => {
      const incidentId = await declareActive();
      await withTestTenant(async () => service.resolve(incidentId, {}, adminActor()));
      await expect(
        withTestTenant(async () => service.cancel(incidentId, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cancel missing incident → NotFound', async () => {
      await expect(
        withTestTenant(async () =>
          service.cancel('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("cross-school: cannot cancel another school's incident → NotFound", async () => {
      const incidentId = await declareActive();
      await expect(
        withTestTenantB(async () => service.cancel(incidentId, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it.each([
      ['officer (no saf-001:write)', officerActor],
      ['teacher', teacherActor],
      ['parent', parentActor],
    ])('cancel as %s → ForbiddenException', async (_label, actor) => {
      const incidentId = await declareActive();
      await expect(
        withTestTenant(async () => service.cancel(incidentId, actor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // list + getById — read paths with tenant scoping
  // ────────────────────────────────────────────────────────────────────
  describe('list + getById', () => {
    it('list returns incidents ordered by declared_at DESC', async () => {
      const first = await withTestTenant(async () =>
        service.declare({ incidentTypeId: platformTypeId, title: 'first' }, adminActor()),
      );
      // Small spacing so declared_at differs
      await new Promise((r) => setTimeout(r, 10));
      const second = await withTestTenant(async () =>
        service.declare({ incidentTypeId: platformTypeId, title: 'second' }, adminActor()),
      );
      const rows = await withTestTenant(async () => service.list({}));
      expect(rows).toHaveLength(2);
      expect(rows[0]!.id).toBe(second.id);
      expect(rows[1]!.id).toBe(first.id);
    });

    it('list filters by status', async () => {
      const a = await withTestTenant(async () =>
        service.declare({ incidentTypeId: platformTypeId }, adminActor()),
      );
      await withTestTenant(async () => service.resolve(a.id, {}, adminActor()));
      await withTestTenant(async () =>
        service.declare({ incidentTypeId: platformTypeId }, adminActor()),
      );
      const active = await withTestTenant(async () => service.list({ status: 'ACTIVE' as any }));
      const resolved = await withTestTenant(async () =>
        service.list({ status: 'RESOLVED' as any }),
      );
      expect(active).toHaveLength(1);
      expect(resolved).toHaveLength(1);
    });

    it('list is tenant-scoped: School A declares → School B sees 0', async () => {
      await withTestTenant(async () =>
        service.declare({ incidentTypeId: platformTypeId }, adminActor()),
      );
      const rowsB = await withTestTenantB(async () => service.list({}));
      expect(rowsB).toHaveLength(0);
    });

    it('getById inlines outbox status when present', async () => {
      const decl = await withTestTenant(async () =>
        service.declare({ incidentTypeId: platformTypeId }, adminActor()),
      );
      const dto = await withTestTenant(async () => service.getById(decl.id));
      expect(dto.outboxStatus).not.toBeNull();
      expect(dto.outboxStatus!.incidentId).toBe(decl.id);
      expect(dto.outboxStatus!.attemptCount).toBe(0);
      expect(dto.outboxStatus!.tasksCreatedAt).toBeNull();
      expect(dto.outboxStatus!.musterTakenAt).toBeNull();
      expect(dto.outboxStatus!.alertSentAt).toBeNull();
    });

    it('getById missing → NotFound', async () => {
      await expect(
        withTestTenant(async () => service.getById('00000000-0000-0000-0000-000000000000')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school: getById on School A incident from School B → NotFound', async () => {
      const decl = await withTestTenant(async () =>
        service.declare({ incidentTypeId: platformTypeId }, adminActor()),
      );
      await expect(withTestTenantB(async () => service.getById(decl.id))).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // TimelineService — append-only contract + tenant scoping
  // ────────────────────────────────────────────────────────────────────
  describe('TimelineService (append-only)', () => {
    async function declareActive(): Promise<string> {
      const dto = await withTestTenant(async () =>
        service.declare({ incidentTypeId: platformTypeId }, adminActor()),
      );
      return dto.id;
    }

    it('admin appends a timeline entry with metadata; row visible to listForIncident', async () => {
      const incidentId = await declareActive();
      const entry = await withTestTenant(async () =>
        timeline.append(
          incidentId,
          {
            eventType: 'ALERT_SENT',
            description: 'Mass SMS dispatched',
            metadata: { channel: 'sms', count: 850 },
          },
          adminActor(),
        ),
      );
      expect(entry.eventType).toBe('ALERT_SENT');
      expect(entry.metadata).toMatchObject({ channel: 'sms', count: 850 });
      const entries = await withTestTenant(async () => timeline.listForIncident(incidentId));
      expect(entries).toHaveLength(1);
      expect(entries[0]!.id).toBe(entry.id);
    });

    it('STAFF with saf-001:write can append', async () => {
      await grantOfficerSafetyWrite();
      const incidentId = await declareActive();
      const entry = await withTestTenant(async () =>
        timeline.append(
          incidentId,
          { eventType: 'MUSTER_STARTED', description: 'Begin headcount' },
          officerActor(),
        ),
      );
      expect(entry.recordedBy).toBe(TEST_OFFICER_ACCOUNT_ID);
    });

    it.each([
      ['officer (no saf-001:write)', officerActor],
      ['teacher', teacherActor],
      ['student', studentActor],
      ['parent', parentActor],
    ])('append as %s → ForbiddenException', async (_label, actor) => {
      const incidentId = await declareActive();
      await expect(
        withTestTenant(async () =>
          timeline.append(incidentId, { eventType: 'X', description: 'y' }, actor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('append against non-existent incident → NotFound', async () => {
      await expect(
        withTestTenant(async () =>
          timeline.append(
            '00000000-0000-0000-0000-000000000000',
            { eventType: 'X', description: 'y' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school: cannot append to a foreign-tenant incident → NotFound', async () => {
      const incidentId = await declareActive();
      await expect(
        withTestTenantB(async () =>
          timeline.append(incidentId, { eventType: 'X', description: 'y' }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('listForIncident returns entries ordered by recorded_at ASC', async () => {
      const incidentId = await declareActive();
      await withTestTenant(async () =>
        timeline.append(
          incidentId,
          { eventType: 'ALERT_SENT', description: 'first' },
          adminActor(),
        ),
      );
      await new Promise((r) => setTimeout(r, 10));
      await withTestTenant(async () =>
        timeline.append(
          incidentId,
          { eventType: 'MUSTER_STARTED', description: 'second' },
          adminActor(),
        ),
      );
      const entries = await withTestTenant(async () => timeline.listForIncident(incidentId));
      expect(entries.map((e) => e.description)).toEqual(['first', 'second']);
    });

    it('listForIncident is tenant-scoped via JOIN: probing School A incident from School B → []', async () => {
      const incidentId = await declareActive();
      await withTestTenant(async () =>
        timeline.append(
          incidentId,
          { eventType: 'ALERT_SENT', description: 'A only' },
          adminActor(),
        ),
      );
      const fromB = await withTestTenantB(async () => timeline.listForIncident(incidentId));
      expect(fromB).toHaveLength(0);
    });

    it('append-only contract: no UPDATE method exists on the service surface', () => {
      // Service exposes exactly two methods. The IMMUTABLE-trigger
      // contract (UPDATE/DELETE → SQLSTATE 23001) is verified in
      // wave3-immutable-contracts.spec.ts. Here we lock the surface.
      const allowedMethods = ['append', 'listForIncident'].sort();
      const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(timeline))
        .filter((n) => n !== 'constructor')
        .filter((n) => typeof (timeline as any)[n] === 'function')
        .filter((n) => !n.startsWith('_'))
        // Private methods (assertResponder, rowToDto) are not part of public surface
        .filter((n) => !['assertResponder', 'rowToDto'].includes(n))
        .sort();
      expect(methods).toEqual(allowedMethods);
    });
  });
});
