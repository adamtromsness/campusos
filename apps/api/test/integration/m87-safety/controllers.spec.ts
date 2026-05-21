import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

// Controllers under test
import { IncidentsController } from '@modules/m87-safety/incidents/incidents.controller';

// Services
import { IncidentService } from '@modules/m87-safety/incidents/incident.service';
import { IncidentTypeService } from '@modules/m87-safety/incidents/incident-type.service';
import { TimelineService } from '@modules/m87-safety/incidents/timeline.service';
import { NonDisciplineIncidentService } from '@modules/m87-safety/incidents/non-discipline.service';
import { ProcedureService } from '@modules/m87-safety/emergency/procedure.service';
import { DrillService } from '@modules/m87-safety/drills/drill.service';
import { AccountabilityService } from '@modules/m87-safety/reunification/accountability.service';
import { ReunificationService } from '@modules/m87-safety/reunification/reunification.service';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import type { KafkaProducerService } from '@shared/kafka/kafka-producer.service';

import { withTestTenant, TEST_SCHOOL_ID, TEST_SCHEMA } from '../helpers/tenant-context';
import {
  TEST_ADMIN_ACCOUNT_ID,
  TEST_ADMIN_PERSON_ID,
  TEST_ADMIN_EMPLOYEE_ID,
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';
import { makeRecordingKafka } from '../helpers/recording-kafka';

/**
 * Controller-layer DB-backed coverage for m87-safety. m87 exposes a
 * single canonical controller — `IncidentsController` — which fans out
 * to 9 services (IncidentService, IncidentTypeService, ProcedureService,
 * TimelineService, AccountabilityService, ReunificationService,
 * DrillService, NonDisciplineIncidentService) via a real
 * ActorContextService. Every HTTP route handler is exercised at least
 * once with admin actor + synthetic AuthedRequest. Admin holds
 * sch-001:admin + all saf-* codes tagged `assignment_version_hash =
 * 'm87-ctrl-test'` for clean afterAll teardown.
 */
describe('integration:m87-safety/controllers', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let kafka: KafkaProducerService;
  let permCheck: PermissionCheckService;
  let actors: ActorContextService;
  let controller: IncidentsController;

  // Reusable visitor type for reunification flows
  const visitorTypeId = '019e3ad0-cccc-4444-9abc-def000000087';

  // Reusable platform-default incident type used by every declare/drill path
  const platformIncidentTypeId = '019e3ad0-cccc-4444-9abc-def000000088';

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    kafka = makeRecordingKafka();
    permCheck = new PermissionCheckService(rawClient);
    actors = new ActorContextService(rawClient, permCheck, tenantPrisma);

    const incidents = new IncidentService(tenantPrisma, permCheck, kafka);
    const types = new IncidentTypeService(tenantPrisma, permCheck);
    const procedures = new ProcedureService(tenantPrisma, permCheck);
    const timeline = new TimelineService(tenantPrisma, permCheck);
    const accountability = new AccountabilityService(tenantPrisma, permCheck);
    const reunification = new ReunificationService(tenantPrisma, permCheck, accountability);
    const drills = new DrillService(tenantPrisma, permCheck);
    const nonDiscipline = new NonDisciplineIncidentService(tenantPrisma, permCheck, kafka);

    controller = new IncidentsController(
      actors,
      incidents,
      types,
      procedures,
      timeline,
      accountability,
      reunification,
      drills,
      nonDiscipline,
    );

    // Grant admin every relevant safety permission so ActorContextService
    // .resolveActor returns an admin actor and the service-side gates pass.
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache
         (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], now(), 'm87-ctrl-test')
       ON CONFLICT (account_id, scope_id) DO UPDATE
         SET permission_codes = EXCLUDED.permission_codes, computed_at = now()`,
      generateId(),
      TEST_ADMIN_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
      [
        'sch-001:admin',
        'saf-001:read',
        'saf-001:write',
        'saf-001:admin',
        'saf-003:read',
        'saf-003:write',
        'saf-003:admin',
        'saf-004:read',
        'saf-004:write',
        'saf-004:admin',
      ],
    );

    // Visitor type for the reunification create path
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.vis_visitor_types
         (id, school_id, name, requires_safeguarding_check, badge_color, is_active)
       VALUES ($1::uuid, $2::uuid, 'CTRL-Parent', false, 'green', true)
       ON CONFLICT (id) DO NOTHING`,
      visitorTypeId,
      TEST_SCHOOL_ID,
    );

    // Platform-default incident type for declares + drills
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.inc_incident_types
         (id, school_id, code, name, severity, requires_lockdown, is_active)
       VALUES ($1::uuid, NULL, 'CTRL-WX', 'CTRL Weather', 'MEDIUM', false, true)
       ON CONFLICT (id) DO NOTHING`,
      platformIncidentTypeId,
    );
  });

  afterAll(async () => {
    // Per-test beforeEach already wipes incident-related rows. Final
    // teardown removes the fixture rows + the iam cache grant.
    // IMMUTABLE tables: inc_incident_timeline. TRUNCATE bypasses
    // the BEFORE-ROW prevent_mutation trigger.
    await rawClient.$executeRawUnsafe(`TRUNCATE ${TEST_SCHEMA}.inc_incident_timeline`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.inc_reunification_corrections WHERE reunification_record_id IN
         (SELECT id FROM ${TEST_SCHEMA}.inc_reunification_records)`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.inc_reunification_records WHERE incident_id IN
         (SELECT id FROM ${TEST_SCHEMA}.inc_incidents WHERE school_id = $1::uuid)`,
      TEST_SCHOOL_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.inc_accountability_summary WHERE incident_id IN
         (SELECT id FROM ${TEST_SCHEMA}.inc_incidents WHERE school_id = $1::uuid)`,
      TEST_SCHOOL_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.inc_accountability_records WHERE incident_id IN
         (SELECT id FROM ${TEST_SCHEMA}.inc_incidents WHERE school_id = $1::uuid)`,
      TEST_SCHOOL_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.inc_declaration_outbox WHERE school_id = $1::uuid`,
      TEST_SCHOOL_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.inc_incidents WHERE school_id = $1::uuid`,
      TEST_SCHOOL_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.inc_drills WHERE school_id = $1::uuid`,
      TEST_SCHOOL_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.inc_emergency_procedures WHERE school_id = $1::uuid`,
      TEST_SCHOOL_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.inc_non_discipline_incidents WHERE school_id = $1::uuid`,
      TEST_SCHOOL_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.vis_sign_ins WHERE school_id = $1::uuid`,
      TEST_SCHOOL_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.vis_visitors WHERE school_id = $1::uuid AND first_name LIKE 'CTRL-%'`,
      TEST_SCHOOL_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.inc_incident_types WHERE id = $1::uuid OR (school_id = $2::uuid AND code LIKE 'CTRL-%')`,
      platformIncidentTypeId,
      TEST_SCHOOL_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.vis_visitor_types WHERE id = $1::uuid`,
      visitorTypeId,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'CTRL-M87-%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_students WHERE first_name = 'CtrlM87'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_person WHERE first_name = 'CtrlM87'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE assignment_version_hash = 'm87-ctrl-test'`,
    );
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    // IMMUTABLE tables — TRUNCATE bypasses BEFORE-ROW prevent_mutation triggers
    await rawClient.$executeRawUnsafe(`TRUNCATE ${TEST_SCHEMA}.inc_incident_timeline`);

    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.inc_reunification_corrections WHERE reunification_record_id IN
         (SELECT id FROM ${TEST_SCHEMA}.inc_reunification_records)`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.inc_reunification_records WHERE incident_id IN
         (SELECT id FROM ${TEST_SCHEMA}.inc_incidents WHERE school_id = $1::uuid)`,
      TEST_SCHOOL_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.inc_accountability_summary WHERE incident_id IN
         (SELECT id FROM ${TEST_SCHEMA}.inc_incidents WHERE school_id = $1::uuid)`,
      TEST_SCHOOL_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.inc_accountability_records WHERE incident_id IN
         (SELECT id FROM ${TEST_SCHEMA}.inc_incidents WHERE school_id = $1::uuid)`,
      TEST_SCHOOL_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.inc_declaration_outbox WHERE school_id = $1::uuid`,
      TEST_SCHOOL_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.inc_incidents WHERE school_id = $1::uuid`,
      TEST_SCHOOL_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.inc_drills WHERE school_id = $1::uuid`,
      TEST_SCHOOL_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.inc_emergency_procedures WHERE school_id = $1::uuid`,
      TEST_SCHOOL_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.inc_non_discipline_incidents WHERE school_id = $1::uuid`,
      TEST_SCHOOL_ID,
    );
    // Clean per-test inc_incident_types (NOT the platform default fixture)
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.inc_incident_types WHERE school_id = $1::uuid AND code LIKE 'CTRL-%'`,
      TEST_SCHOOL_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.vis_sign_ins WHERE school_id = $1::uuid`,
      TEST_SCHOOL_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.vis_visitors WHERE school_id = $1::uuid AND first_name LIKE 'CTRL-%'`,
      TEST_SCHOOL_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'CTRL-M87-%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_students WHERE first_name = 'CtrlM87'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_person WHERE first_name = 'CtrlM87'`,
    );
  });

  // ─── Synthetic AuthedRequest ────────────────────────────────────────
  function req(): any {
    return {
      user: {
        sub: TEST_ADMIN_ACCOUNT_ID,
        accountId: TEST_ADMIN_ACCOUNT_ID,
        personId: TEST_ADMIN_PERSON_ID,
        email: 'admin@test',
        displayName: 'Admin',
        sessionId: 'sess',
      },
    };
  }

  // ─── Seeding helpers ────────────────────────────────────────────────
  async function seedStudent(label = 'Stu'): Promise<string> {
    const personId = generateId();
    const platformStudentId = generateId();
    const studentId = generateId();
    const suffix = generateId().slice(-12);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
       VALUES ($1::uuid, 'CtrlM87', $2, 'STUDENT', true)`,
      personId,
      label + '-' + suffix.slice(-4),
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
       VALUES ($1::uuid, $2::uuid, 'CtrlM87', $3, true)`,
      platformStudentId,
      personId,
      label + '-' + suffix.slice(-4),
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_students
         (id, school_id, platform_student_id, student_number, enrollment_status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'ENROLLED')`,
      studentId,
      TEST_SCHOOL_ID,
      platformStudentId,
      'CTRL-M87-' + suffix,
    );
    return studentId;
  }

  async function seedSignedInVisitor(): Promise<string> {
    const visitorId = generateId();
    const suffix = generateId().slice(-8);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.vis_visitors
         (id, school_id, visitor_type_id, first_name, last_name, email_hash)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'CTRL-Visitor', $4, $5)`,
      visitorId,
      TEST_SCHOOL_ID,
      visitorTypeId,
      'V-' + suffix,
      'hash-' + suffix,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.vis_sign_ins
         (id, school_id, visitor_id, signed_in_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, now())`,
      generateId(),
      TEST_SCHOOL_ID,
      visitorId,
    );
    return visitorId;
  }

  async function declareIncident(): Promise<string> {
    const dto = await withTestTenant(() =>
      controller.declare(req(), { incidentTypeId: platformIncidentTypeId, title: 'CTRL' } as any),
    );
    return dto.id;
  }

  // ════════════════════════════════════════════════════════════════════
  // IncidentsController — lifecycle routes
  // ════════════════════════════════════════════════════════════════════
  describe('IncidentsController — incident lifecycle', () => {
    it('POST /declare → returns dto with ACTIVE status + outbox row', async () => {
      const dto = await withTestTenant(() =>
        controller.declare(req(), {
          incidentTypeId: platformIncidentTypeId,
          title: 'Sirens',
          description: 'Tornado',
        } as any),
      );
      expect(dto.status).toBe('ACTIVE');
      expect(dto.schoolId).toBe(TEST_SCHOOL_ID);
      expect(dto.incidentTypeCode).toBe('CTRL-WX');

      // Outbox row landed
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS n FROM ${TEST_SCHEMA}.inc_declaration_outbox WHERE incident_id = $1::uuid`,
        dto.id,
      )) as Array<{ n: number }>;
      expect(rows[0]!.n).toBe(1);
    });

    it('GET / → list returns declared incidents', async () => {
      const id = await declareIncident();
      const list = await withTestTenant(() => controller.list({} as any));
      expect(list.find((r: any) => r.id === id)).toBeDefined();
    });

    it('GET / with status filter', async () => {
      const id = await declareIncident();
      const active = await withTestTenant(() => controller.list({ status: 'ACTIVE' } as any));
      expect(active.find((r: any) => r.id === id)).toBeDefined();
    });

    it('GET /:id → returns dto with inlined outboxStatus', async () => {
      const id = await declareIncident();
      const dto = await withTestTenant(() => controller.get(id));
      expect(dto.id).toBe(id);
      expect(dto.outboxStatus).not.toBeNull();
      expect(dto.outboxStatus!.incidentId).toBe(id);
      expect(dto.outboxStatus!.attemptCount).toBe(0);
    });

    it('PATCH /:id/resolve → status RESOLVED with stamped resolved_at', async () => {
      const id = await declareIncident();
      const dto = await withTestTenant(() =>
        controller.resolve(req(), id, { resolutionNotes: 'all clear at 3pm' } as any),
      );
      expect(dto.status).toBe('RESOLVED');
      expect(dto.resolvedAt).not.toBeNull();
      expect(dto.resolvedBy).toBe(TEST_ADMIN_ACCOUNT_ID);
      expect(dto.resolutionNotes).toBe('all clear at 3pm');
    });

    it('PATCH /:id/cancel → status CANCELLED', async () => {
      const id = await declareIncident();
      const dto = await withTestTenant(() => controller.cancel(req(), id));
      expect(dto.status).toBe('CANCELLED');
      expect(dto.resolvedAt).not.toBeNull();
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // IncidentsController — incident types catalogue routes
  // ════════════════════════════════════════════════════════════════════
  describe('IncidentsController — incident types', () => {
    it('GET /types/list (default) → active types only', async () => {
      const list = await withTestTenant(() => controller.listTypes());
      // Platform default fixture row must be present + active
      expect(list.find((t: any) => t.id === platformIncidentTypeId)).toBeDefined();
    });

    it('GET /types/list?includeInactive=true', async () => {
      const list = await withTestTenant(() => controller.listTypes('true'));
      expect(list.find((t: any) => t.id === platformIncidentTypeId)).toBeDefined();
    });

    it('POST /types → admin creates school-scoped type', async () => {
      const created = await withTestTenant(() =>
        controller.createType(req(), {
          code: 'CTRL-NEW-' + generateId().slice(-6),
          name: 'CTRL New Type',
          severity: 'HIGH',
          requiresLockdown: false,
        } as any),
      );
      expect(created.severity).toBe('HIGH');
      expect(created.schoolId).toBe(TEST_SCHOOL_ID);
    });

    it('GET /types/:id → returns the row', async () => {
      const created = await withTestTenant(() =>
        controller.createType(req(), {
          code: 'CTRL-GET-' + generateId().slice(-6),
          name: 'CTRL Get Type',
          severity: 'MEDIUM',
        } as any),
      );
      const got = await withTestTenant(() => controller.getType(created.id));
      expect(got.id).toBe(created.id);
    });

    it('PATCH /types/:id → admin can update', async () => {
      const created = await withTestTenant(() =>
        controller.createType(req(), {
          code: 'CTRL-PAT-' + generateId().slice(-6),
          name: 'CTRL Patch Type',
          severity: 'LOW',
        } as any),
      );
      const patched = await withTestTenant(() =>
        controller.patchType(req(), created.id, {
          name: 'Updated',
          severity: 'CRITICAL',
          requiresLockdown: true,
        } as any),
      );
      expect(patched.name).toBe('Updated');
      expect(patched.severity).toBe('CRITICAL');
      expect(patched.requiresLockdown).toBe(true);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // IncidentsController — procedures routes
  // ════════════════════════════════════════════════════════════════════
  describe('IncidentsController — procedures', () => {
    function baseProc(overrides: Record<string, unknown> = {}) {
      const today = new Date().toISOString().slice(0, 10);
      const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      return {
        procedureType: 'FIRE_EVACUATION' as const,
        title: 'CTRL Fire Procedure',
        procedureSteps: [
          { stepNumber: 1, action: 'Activate alarm' },
          { stepNumber: 2, action: 'Exit building' },
        ],
        primaryContactId: TEST_ADMIN_EMPLOYEE_ID,
        externalContacts: [{ agency: 'FIRE DEPT', phone: '911' }],
        assemblyPoints: [{ name: 'Front Lawn', priority: 1 }],
        lastReviewedAt: today,
        reviewedBy: TEST_ADMIN_EMPLOYEE_ID,
        nextReviewDate: future,
        ...overrides,
      };
    }

    it('POST /procedures + GET /procedures + GET /procedures/by-type + GET /procedures/:id + PATCH /procedures/:id', async () => {
      const created = await withTestTenant(() =>
        controller.createProcedure(req(), baseProc() as any),
      );
      expect(created.procedureType).toBe('FIRE_EVACUATION');
      expect(created.isActive).toBe(true);

      const list = await withTestTenant(() => controller.listProcedures());
      expect(list.find((p: any) => p.id === created.id)).toBeDefined();

      const includeInactive = await withTestTenant(() => controller.listProcedures('true'));
      expect(includeInactive.find((p: any) => p.id === created.id)).toBeDefined();

      const byType = await withTestTenant(() =>
        controller.getProcedureByType('FIRE_EVACUATION' as any),
      );
      expect(byType.id).toBe(created.id);

      const byId = await withTestTenant(() => controller.getProcedure(created.id));
      expect(byId.id).toBe(created.id);

      const patched = await withTestTenant(() =>
        controller.patchProcedure(req(), created.id, {
          title: 'CTRL Fire Procedure v2',
          isActive: false,
        } as any),
      );
      expect(patched.title).toBe('CTRL Fire Procedure v2');
      expect(patched.isActive).toBe(false);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // IncidentsController — timeline routes (append-only)
  // ════════════════════════════════════════════════════════════════════
  describe('IncidentsController — timeline', () => {
    it('POST /:id/timeline + GET /:id/timeline', async () => {
      const incidentId = await declareIncident();
      const entry = await withTestTenant(() =>
        controller.appendTimeline(req(), incidentId, {
          eventType: 'ALERT_SENT',
          description: 'Mass SMS dispatched',
          metadata: { channel: 'sms', count: 100 },
        } as any),
      );
      expect(entry.eventType).toBe('ALERT_SENT');
      expect(entry.incidentId).toBe(incidentId);

      const list = await withTestTenant(() => controller.getTimeline(incidentId));
      expect(list.find((e: any) => e.id === entry.id)).toBeDefined();
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // IncidentsController — accountability routes
  // ════════════════════════════════════════════════════════════════════
  describe('IncidentsController — accountability', () => {
    async function seedAccRow(
      incidentId: string,
      personType: 'STUDENT' | 'STAFF' | 'VISITOR' = 'STUDENT',
    ): Promise<string> {
      const id = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.inc_accountability_records
           (id, incident_id, person_id, person_type, status, last_updated_by, last_updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'UNKNOWN', $5::uuid, now())`,
        id,
        incidentId,
        generateId(),
        personType,
        TEST_ADMIN_ACCOUNT_ID,
      );
      return id;
    }

    it('GET /:id/accountability → returns list', async () => {
      const incidentId = await declareIncident();
      const recId = await seedAccRow(incidentId);
      const list = await withTestTenant(() => controller.listAccountability(incidentId));
      expect(list.find((r: any) => r.id === recId)).toBeDefined();
    });

    it('GET /:id/accountability/summary → returns null when no summary materialised', async () => {
      const incidentId = await declareIncident();
      const summary = await withTestTenant(() => controller.getAccountabilitySummary(incidentId));
      // No accountability records yet — summary row not materialised → null
      expect(summary).toBeNull();
    });

    it('PATCH /accountability/:recordId → updates status + materialises summary', async () => {
      const incidentId = await declareIncident();
      const recId = await seedAccRow(incidentId);
      const updated = await withTestTenant(() =>
        controller.patchAccountability(req(), recId, {
          status: 'ACCOUNTED_FOR',
          notes: 'Confirmed at assembly',
        } as any),
      );
      expect(updated.status).toBe('ACCOUNTED_FOR');
      expect(updated.lastUpdatedBy).toBe(TEST_ADMIN_ACCOUNT_ID);

      // Now summary is materialised
      const summary = await withTestTenant(() => controller.getAccountabilitySummary(incidentId));
      expect(summary).not.toBeNull();
      expect(summary!.accountedFor).toBe(1);
    });

    it('POST /:id/accountability/bulk → updates multiple records at once', async () => {
      const incidentId = await declareIncident();
      const r1 = await seedAccRow(incidentId);
      const r2 = await seedAccRow(incidentId);
      const r3 = await seedAccRow(incidentId);
      const result = await withTestTenant(() =>
        controller.bulkAccountability(req(), incidentId, {
          recordIds: [r1, r2, r3],
          status: 'EVACUATED',
          notes: 'Mass evacuation complete',
        } as any),
      );
      expect(result.updated).toBe(3);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // IncidentsController — reunification routes
  // ════════════════════════════════════════════════════════════════════
  describe('IncidentsController — reunification', () => {
    it('POST /:id/reunification → creates record + flips accountability + appends timeline', async () => {
      const incidentId = await declareIncident();
      const studentId = await seedStudent('Reun');
      const visitorId = await seedSignedInVisitor();

      const reun = await withTestTenant(() =>
        controller.createReunification(req(), incidentId, {
          studentId,
          releasedToId: visitorId,
          notes: 'Parent collected at 14:30',
        } as any),
      );
      expect(reun.studentId).toBe(studentId);
      expect(reun.releasedToId).toBe(visitorId);
      expect(reun.releasedBy).toBe(TEST_ADMIN_ACCOUNT_ID);
    });

    it('GET /:id/reunification → lists reunifications for an incident', async () => {
      const incidentId = await declareIncident();
      const studentId = await seedStudent('ReunList');
      const visitorId = await seedSignedInVisitor();
      const reun = await withTestTenant(() =>
        controller.createReunification(req(), incidentId, {
          studentId,
          releasedToId: visitorId,
        } as any),
      );

      const list = await withTestTenant(() => controller.listReunification(incidentId));
      expect(list.find((r: any) => r.id === reun.id)).toBeDefined();
    });

    it('POST /reunification/:reunificationId/correct → records correction', async () => {
      const incidentId = await declareIncident();
      const studentId = await seedStudent('ReunCorr');
      const visitorId = await seedSignedInVisitor();
      const reun = await withTestTenant(() =>
        controller.createReunification(req(), incidentId, {
          studentId,
          releasedToId: visitorId,
        } as any),
      );

      const correction = await withTestTenant(() =>
        controller.correctReunification(req(), reun.id, {
          correctionReason: 'Recorded wrong releasedToId — collecting adult was a different parent',
        } as any),
      );
      expect(correction.reunificationRecordId).toBe(reun.id);
      expect(correction.correctedBy).toBe(TEST_ADMIN_ACCOUNT_ID);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // IncidentsController — drills routes
  // ════════════════════════════════════════════════════════════════════
  describe('IncidentsController — drills', () => {
    function baseDrill(overrides: Record<string, unknown> = {}) {
      return {
        procedureType: 'FIRE_EVACUATION' as const,
        scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        notes: 'Quarterly fire drill',
        ...overrides,
      };
    }

    it('POST /drills + GET /drills/list + GET /drills/overdue + PATCH /drills/:id/complete', async () => {
      const created = await withTestTenant(() => controller.createDrill(req(), baseDrill() as any));
      expect(created.status).toBe('SCHEDULED');

      const list = await withTestTenant(() => controller.listDrills());
      expect(list.find((d: any) => d.id === created.id)).toBeDefined();

      const filtered = await withTestTenant(() => controller.listDrills('SCHEDULED' as any));
      expect(filtered.find((d: any) => d.id === created.id)).toBeDefined();

      const overdue = await withTestTenant(() => controller.overdueDrills());
      expect(Array.isArray(overdue)).toBe(true);

      const completed = await withTestTenant(() =>
        controller.completeDrill(req(), created.id, {
          completedAt: new Date().toISOString(),
          durationSeconds: 240,
          participationRate: 0.97,
          notes: 'All clear in 4 minutes',
        } as any),
      );
      expect(completed.status).toBe('COMPLETED');
      expect(completed.durationSeconds).toBe(240);
    });

    it('PATCH /drills/:id/cancel', async () => {
      const created = await withTestTenant(() =>
        controller.createDrill(req(), baseDrill({ procedureType: 'LOCKDOWN' }) as any),
      );
      const cancelled = await withTestTenant(() =>
        controller.cancelDrill(req(), created.id, { notes: 'Weather rescheduled' } as any),
      );
      expect(cancelled.status).toBe('CANCELLED');
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // IncidentsController — non-discipline reports routes
  // ════════════════════════════════════════════════════════════════════
  describe('IncidentsController — non-discipline reports', () => {
    it('POST /reports → admin creates incident report', async () => {
      const created = await withTestTenant(() =>
        controller.createReport(req(), {
          incidentType: 'STUDENT_INJURY',
          location: 'Gymnasium',
          incidentDate: new Date().toISOString(),
          description: 'Student tripped during basketball practice and grazed knee.',
          severity: 'LOW',
        } as any),
      );
      expect(created.status).toBe('OPEN');
      expect(created.severity).toBe('LOW');
      expect(created.reportedBy).toBe(TEST_ADMIN_ACCOUNT_ID);
    });

    it('GET /reports/list (default + filters)', async () => {
      const r = await withTestTenant(() =>
        controller.createReport(req(), {
          incidentType: 'PROPERTY_DAMAGE',
          location: 'Cafeteria',
          incidentDate: new Date().toISOString(),
          description: 'Window cracked due to thrown ball; awaiting facilities review.',
          severity: 'MEDIUM',
        } as any),
      );

      const list = await withTestTenant(() => controller.listReports(req(), {} as any));
      expect(list.find((x: any) => x.id === r.id)).toBeDefined();

      const filteredByStatus = await withTestTenant(() =>
        controller.listReports(req(), { status: 'OPEN' } as any),
      );
      expect(filteredByStatus.find((x: any) => x.id === r.id)).toBeDefined();

      const filteredByType = await withTestTenant(() =>
        controller.listReports(req(), { incidentType: 'PROPERTY_DAMAGE' } as any),
      );
      expect(filteredByType.find((x: any) => x.id === r.id)).toBeDefined();

      const mineOnly = await withTestTenant(() =>
        controller.listReports(req(), { mineOnly: true } as any),
      );
      expect(mineOnly.find((x: any) => x.id === r.id)).toBeDefined();
    });

    it('GET /reports/:id → returns dto', async () => {
      const r = await withTestTenant(() =>
        controller.createReport(req(), {
          incidentType: 'MEDICAL_EPISODE',
          incidentDate: new Date().toISOString(),
          description: 'Student fainted briefly during a fire drill; alert and fine now.',
          severity: 'HIGH',
        } as any),
      );
      const got = await withTestTenant(() => controller.getReport(req(), r.id));
      expect(got.id).toBe(r.id);
    });

    it('PATCH /reports/:id → admin reviewer transitions status', async () => {
      const r = await withTestTenant(() =>
        controller.createReport(req(), {
          incidentType: 'STAFF_INJURY',
          incidentDate: new Date().toISOString(),
          description: 'Teacher twisted ankle during evacuation drill; rest recommended.',
          severity: 'LOW',
        } as any),
      );
      const reviewed = await withTestTenant(() =>
        controller.patchReport(req(), r.id, { status: 'UNDER_REVIEW' } as any),
      );
      expect(reviewed.status).toBe('UNDER_REVIEW');
      expect(reviewed.reviewedBy).toBe(TEST_ADMIN_ACCOUNT_ID);

      const closed = await withTestTenant(() =>
        controller.patchReport(req(), r.id, {
          status: 'CLOSED',
          resolution: 'No further action required; incident closed.',
        } as any),
      );
      expect(closed.status).toBe('CLOSED');
      expect(closed.closedAt).not.toBeNull();
      expect(closed.resolution).toContain('No further action');
    });
  });
});
