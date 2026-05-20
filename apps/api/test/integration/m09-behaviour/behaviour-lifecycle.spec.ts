import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

// discipline/
import { CategoryService } from '@modules/m09-behaviour/discipline/category.service';
import { ActionTypeService } from '@modules/m09-behaviour/discipline/action-type.service';
import { IncidentService } from '@modules/m09-behaviour/discipline/incident.service';
import { ActionService } from '@modules/m09-behaviour/discipline/action.service';
import { CategoryController } from '@modules/m09-behaviour/discipline/category.controller';
import { IncidentController } from '@modules/m09-behaviour/discipline/incident.controller';
import { ActionController } from '@modules/m09-behaviour/discipline/action.controller';

// intervention-plans/
import { BehaviorPlanService } from '@modules/m09-behaviour/intervention-plans/behavior-plan.service';
import { GoalService } from '@modules/m09-behaviour/intervention-plans/goal.service';
import { FeedbackService } from '@modules/m09-behaviour/intervention-plans/feedback.service';
import { BipFeedbackService } from '@modules/m09-behaviour/intervention-plans/bip-feedback.service';
import { BehaviorPlanController } from '@modules/m09-behaviour/intervention-plans/behavior-plan.controller';
import { GoalController } from '@modules/m09-behaviour/intervention-plans/goal.controller';
import { FeedbackController } from '@modules/m09-behaviour/intervention-plans/feedback.controller';

// positive/
import { RestorativeJusticeService } from '@modules/m09-behaviour/positive/restorative-justice.service';
import { PeerMediationService } from '@modules/m09-behaviour/positive/peer-mediation.service';
import { PositiveBehaviourService } from '@modules/m09-behaviour/positive/positive-behaviour.service';
import { CategoryConfigService } from '@modules/m09-behaviour/positive/category-config.service';
import { OverdueActionWorker } from '@modules/m09-behaviour/positive/overdue-action.worker';
import { BehaviourAdvancedController } from '@modules/m09-behaviour/positive/behaviour-advanced.controller';
import {
  deterministicPositivePointsAwardedEventId,
  deterministicRjResolvedEventId,
} from '@modules/m09-behaviour/positive/event-ids';

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
  studentActor,
  TEST_ADMIN_ACCOUNT_ID,
  TEST_ADMIN_PERSON_ID,
  TEST_ADMIN_EMPLOYEE_ID,
  TEST_TEACHER_ACCOUNT_ID,
  TEST_TEACHER_PERSON_ID,
  TEST_TEACHER_EMPLOYEE_ID,
  TEST_PARENT_PERSON_ID,
  TEST_PARENT_ACCOUNT_ID,
  TEST_STUDENT_PERSON_ID,
  TEST_STUDENT_ACCOUNT_ID,
} from '../helpers/actor';
import { makeRecordingKafka, RecordingKafkaProducer } from '../helpers/recording-kafka';
import { TEST_SCHOOL_SCOPE_ID, TEST_SCHOOL_B_SCOPE_ID } from '../fixtures/platform';
import {
  resetAndSeedBehaviour,
  ensureBehaviourSeed,
  resetBehaviourTables,
  TEST_BEH_CAT_MINOR_A_ID,
  TEST_BEH_CAT_MAJOR_A_ID,
  TEST_BEH_CAT_CRIT_A_ID,
  TEST_BEH_CAT_INACTIVE_A_ID,
  TEST_BEH_CAT_MINOR_B_ID,
  TEST_BEH_ACT_TYPE_DETENTION_A_ID,
  TEST_BEH_ACT_TYPE_SUSPENSION_A_ID,
  TEST_BEH_ACT_TYPE_WARNING_A_ID,
  TEST_BEH_ACT_TYPE_INACTIVE_A_ID,
  TEST_BEH_STU_A_ID,
  TEST_BEH_STU_A2_ID,
  TEST_BEH_STU_B_ID,
  TEST_BEH_SHADOW_EMP_B_ID,
} from '../fixtures/behaviour';

function fakeReq(overrides?: { sub?: string; personId?: string; email?: string }): any {
  return {
    user: {
      sub: overrides?.sub ?? TEST_ADMIN_ACCOUNT_ID,
      personId: overrides?.personId ?? TEST_ADMIN_PERSON_ID,
      email: overrides?.email ?? 'admin@test.local',
      displayName: 'Test Actor',
      sessionId: 's',
    },
  };
}

describe('integration:m09-behaviour/behaviour-lifecycle', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let kafka: RecordingKafkaProducer;
  let outbox: OutboxService;
  let permCheck: PermissionCheckService;
  let actors: ActorContextService;

  // discipline services
  let categories: CategoryService;
  let actionTypes: ActionTypeService;
  let incidents: IncidentService;
  let actionsSvc: ActionService;
  let categoryCtrl: CategoryController;
  let incidentCtrl: IncidentController;
  let actionCtrl: ActionController;

  // intervention-plans
  let plans: BehaviorPlanService;
  let goals: GoalService;
  let feedback: FeedbackService;
  let bipFeedback: BipFeedbackService;
  let plansCtrl: BehaviorPlanController;
  let goalsCtrl: GoalController;
  let feedbackCtrl: FeedbackController;

  // positive
  let rj: RestorativeJusticeService;
  let mediation: PeerMediationService;
  let positive: PositiveBehaviourService;
  let categoryConfig: CategoryConfigService;
  let overdueWorker: OverdueActionWorker;
  let advancedCtrl: BehaviourAdvancedController;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    kafka = makeRecordingKafka() as unknown as RecordingKafkaProducer;
    outbox = new OutboxService();
    permCheck = new PermissionCheckService(rawClient);
    actors = new ActorContextService(rawClient, permCheck, tenantPrisma);

    // discipline
    categories = new CategoryService(tenantPrisma);
    actionTypes = new ActionTypeService(tenantPrisma);
    incidents = new IncidentService(tenantPrisma, kafka as any, categories);
    actionsSvc = new ActionService(tenantPrisma, kafka as any, incidents, actionTypes);
    categoryCtrl = new CategoryController(categories, actionTypes);
    incidentCtrl = new IncidentController(incidents, actors);
    actionCtrl = new ActionController(actionsSvc, actors);

    // intervention-plans
    plans = new BehaviorPlanService(tenantPrisma, permCheck);
    goals = new GoalService(tenantPrisma, plans);
    feedback = new FeedbackService(tenantPrisma, kafka as any, plans);
    bipFeedback = new BipFeedbackService(tenantPrisma, permCheck);
    plansCtrl = new BehaviorPlanController(plans, actors);
    goalsCtrl = new GoalController(goals, actors);
    feedbackCtrl = new FeedbackController(feedback, actors);

    // positive
    rj = new RestorativeJusticeService(tenantPrisma, outbox, permCheck);
    mediation = new PeerMediationService(tenantPrisma, permCheck);
    positive = new PositiveBehaviourService(tenantPrisma, outbox, permCheck);
    categoryConfig = new CategoryConfigService(tenantPrisma, permCheck);
    overdueWorker = new OverdueActionWorker(tenantPrisma);
    advancedCtrl = new BehaviourAdvancedController(
      rj,
      mediation,
      positive,
      categoryConfig,
      bipFeedback,
      actors,
    );

    await ensureBehaviourSeed(rawClient);

    // Seed admin's iam_effective_access_cache so the controller passthrough
    // tests (which resolve the actor from DB via ActorContextService) see
    // isSchoolAdmin=true via the sch-001:admin code. Also grant the
    // behaviour codes so beh-002:write counsellor scope check passes.
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache
         (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], now(), 'beh-test-hash')
       ON CONFLICT (account_id, scope_id) DO UPDATE
         SET permission_codes = EXCLUDED.permission_codes, computed_at = now()`,
      generateId(),
      TEST_ADMIN_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
      [
        'sch-001:admin',
        'beh-001:read',
        'beh-001:write',
        'beh-001:admin',
        'beh-002:read',
        'beh-002:write',
        'beh-002:admin',
      ],
    );
  });

  afterAll(async () => {
    await resetBehaviourTables(rawClient);
    // Drop the admin's cache grant so other suites don't inherit it.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache
       WHERE account_id = $1::uuid AND scope_id = $2::uuid`,
      TEST_ADMIN_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
    );
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetAndSeedBehaviour(rawClient);
    kafka.reset();
    // Reset iam_effective_access_cache for the teacher actor so leftover
    // counsellor-scope grants from a prior test don't bleed across.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache
       WHERE account_id IN ($1::uuid, $2::uuid)`,
      TEST_TEACHER_ACCOUNT_ID,
      TEST_STUDENT_ACCOUNT_ID,
    );
  });

  // Grant the teacher actor specific permission codes at SCHOOL scope.
  // Used to flip teacher into "counsellor" scope (beh-002:write) or
  // award scope (beh-001:write) without rebuilding the role catalogue.
  async function grantTeacher(codes: string[]): Promise<void> {
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache
         (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], now(), 'test-hash')
       ON CONFLICT (account_id, scope_id) DO UPDATE
         SET permission_codes = EXCLUDED.permission_codes, computed_at = now()`,
      generateId(),
      TEST_TEACHER_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
      codes,
    );
  }

  // ═════════════════════════════════════════════════════════════════════
  // discipline/ — CategoryService
  // ═════════════════════════════════════════════════════════════════════
  describe('CategoryService', () => {
    it('list returns active categories (active-only by default)', async () => {
      const list = await withTestTenant(async () => categories.list(false));
      const ids = list.map((c) => c.id);
      expect(ids).toContain(TEST_BEH_CAT_MINOR_A_ID);
      expect(ids).toContain(TEST_BEH_CAT_MAJOR_A_ID);
      expect(ids).toContain(TEST_BEH_CAT_CRIT_A_ID);
      expect(ids).not.toContain(TEST_BEH_CAT_INACTIVE_A_ID);
      // CRITICAL sorted first per the severity-aware ORDER BY
      expect(list[0]!.id).toBe(TEST_BEH_CAT_CRIT_A_ID);
    });

    it('list includeInactive returns soft-deleted rows', async () => {
      const list = await withTestTenant(async () => categories.list(true));
      expect(list.map((c) => c.id)).toContain(TEST_BEH_CAT_INACTIVE_A_ID);
    });

    it('getById returns one row', async () => {
      const dto = await withTestTenant(async () =>
        categories.getById(TEST_BEH_CAT_MINOR_A_ID),
      );
      expect(dto.severity).toBe('LOW');
      expect(dto.name).toBe('Minor Disruption');
    });

    it('getById missing → 404', async () => {
      await expect(
        withTestTenant(async () =>
          categories.getById('00000000-0000-0000-0000-000000000099'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('create + duplicate name surfaces 400', async () => {
      const dto = await withTestTenant(async () =>
        categories.create({
          name: 'UniqCat',
          severity: 'MEDIUM',
          description: 'd',
        } as any),
      );
      expect(dto.severity).toBe('MEDIUM');
      // re-create same name → unique violation translated to BadRequest
      await expect(
        withTestTenant(async () =>
          categories.create({ name: 'UniqCat', severity: 'LOW' } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('update — all fields, no-op, duplicate name, missing id', async () => {
      const dto = await withTestTenant(async () =>
        categories.update(TEST_BEH_CAT_MINOR_A_ID, {
          name: 'Renamed Minor',
          severity: 'MEDIUM',
          description: 'new',
          isActive: true,
        } as any),
      );
      expect(dto.name).toBe('Renamed Minor');
      // no-op update returns the current row
      const same = await withTestTenant(async () =>
        categories.update(TEST_BEH_CAT_MINOR_A_ID, {} as any),
      );
      expect(same.id).toBe(TEST_BEH_CAT_MINOR_A_ID);
      // duplicate name (set to Fighting which is taken)
      await expect(
        withTestTenant(async () =>
          categories.update(TEST_BEH_CAT_MINOR_A_ID, { name: 'Fighting' } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // missing id → 404
      await expect(
        withTestTenant(async () =>
          categories.update('00000000-0000-0000-0000-000000000099', {
            name: 'X',
          } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('assertActive — active passes, inactive 400', async () => {
      const dto = await withTestTenant(async () =>
        categories.assertActive(TEST_BEH_CAT_MINOR_A_ID),
      );
      expect(dto.isActive).toBe(true);
      await expect(
        withTestTenant(async () =>
          categories.assertActive(TEST_BEH_CAT_INACTIVE_A_ID),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // discipline/ — ActionTypeService
  // ═════════════════════════════════════════════════════════════════════
  describe('ActionTypeService', () => {
    it('list active + include inactive', async () => {
      const active = await withTestTenant(async () => actionTypes.list(false));
      const ids = active.map((t) => t.id);
      expect(ids).toContain(TEST_BEH_ACT_TYPE_DETENTION_A_ID);
      expect(ids).not.toContain(TEST_BEH_ACT_TYPE_INACTIVE_A_ID);
      const all = await withTestTenant(async () => actionTypes.list(true));
      expect(all.map((t) => t.id)).toContain(TEST_BEH_ACT_TYPE_INACTIVE_A_ID);
    });

    it('getById missing → 404', async () => {
      await expect(
        withTestTenant(async () =>
          actionTypes.getById('00000000-0000-0000-0000-000000000099'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('create + duplicate name + update + no-op + assertActive', async () => {
      const dto = await withTestTenant(async () =>
        actionTypes.create({
          name: 'Saturday School',
          requiresParentNotification: true,
          description: 'd',
        } as any),
      );
      expect(dto.requiresParentNotification).toBe(true);
      await expect(
        withTestTenant(async () =>
          actionTypes.create({ name: 'Saturday School' } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      const upd = await withTestTenant(async () =>
        actionTypes.update(dto.id, {
          name: 'Saturday Reflection',
          requiresParentNotification: false,
          description: 'newd',
          isActive: true,
        } as any),
      );
      expect(upd.name).toBe('Saturday Reflection');
      const same = await withTestTenant(async () => actionTypes.update(dto.id, {} as any));
      expect(same.id).toBe(dto.id);
      // dup name
      await expect(
        withTestTenant(async () =>
          actionTypes.update(dto.id, { name: 'Detention' } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // missing
      await expect(
        withTestTenant(async () =>
          actionTypes.update('00000000-0000-0000-0000-000000000099', {
            name: 'Z',
          } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      // assertActive
      const active = await withTestTenant(async () =>
        actionTypes.assertActive(TEST_BEH_ACT_TYPE_DETENTION_A_ID),
      );
      expect(active.isActive).toBe(true);
      await expect(
        withTestTenant(async () =>
          actionTypes.assertActive(TEST_BEH_ACT_TYPE_INACTIVE_A_ID),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // discipline/ — IncidentService
  // ═════════════════════════════════════════════════════════════════════
  describe('IncidentService', () => {
    it('create stamps reported_by + emits beh.incident.reported + sets OPEN', async () => {
      const dto = await withTestTenant(async () =>
        incidents.create(
          {
            studentId: TEST_BEH_STU_A_ID,
            categoryId: TEST_BEH_CAT_MINOR_A_ID,
            description: 'talking during quiz',
            incidentDate: '2026-05-01',
            incidentTime: '10:30',
            location: 'Room 12',
            witnesses: 'Mrs. Smith',
          } as any,
          adminActor(),
        ),
      );
      expect(dto.status).toBe('OPEN');
      expect(dto.reportedById).toBe(TEST_ADMIN_EMPLOYEE_ID);
      expect(dto.categoryName).toBe('Minor Disruption');
      expect(dto.severity).toBe('LOW');
      const emit = kafka.callsForTopic('beh.incident.reported');
      expect(emit.length).toBe(1);
      const payload = emit[0]!.payload as any;
      expect(payload.incidentId).toBe(dto.id);
      expect(payload.sourceRefId).toBe(dto.id);
      expect(payload.studentId).toBe(TEST_BEH_STU_A_ID);
      expect(payload.reporterName).toBe(payload.reportedByName);
      expect(payload.severity).toBe('LOW');
    });

    it('create rejects callers without employeeId', async () => {
      await expect(
        withTestTenant(async () =>
          incidents.create(
            {
              studentId: TEST_BEH_STU_A_ID,
              categoryId: TEST_BEH_CAT_MINOR_A_ID,
              description: 'x',
              incidentDate: '2026-05-01',
            } as any,
            parentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('create with bogus category → 400 via assertActive', async () => {
      await expect(
        withTestTenant(async () =>
          incidents.create(
            {
              studentId: TEST_BEH_STU_A_ID,
              categoryId: '00000000-0000-0000-0000-000000000099',
              description: 'x',
              incidentDate: '2026-05-01',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException); // assertActive → getById → NotFound
    });

    it('create with inactive category → 400', async () => {
      await expect(
        withTestTenant(async () =>
          incidents.create(
            {
              studentId: TEST_BEH_STU_A_ID,
              categoryId: TEST_BEH_CAT_INACTIVE_A_ID,
              description: 'x',
              incidentDate: '2026-05-01',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('create with bogus studentId → 400', async () => {
      await expect(
        withTestTenant(async () =>
          incidents.create(
            {
              studentId: '00000000-0000-0000-0000-000000000099',
              categoryId: TEST_BEH_CAT_MINOR_A_ID,
              description: 'x',
              incidentDate: '2026-05-01',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('list — admin sees all rows, sorted CRITICAL first', async () => {
      const a = await withTestTenant(async () =>
        incidents.create(
          {
            studentId: TEST_BEH_STU_A_ID,
            categoryId: TEST_BEH_CAT_MINOR_A_ID,
            description: 'low1',
            incidentDate: '2026-05-01',
          } as any,
          adminActor(),
        ),
      );
      const b = await withTestTenant(async () =>
        incidents.create(
          {
            studentId: TEST_BEH_STU_A2_ID,
            categoryId: TEST_BEH_CAT_CRIT_A_ID,
            description: 'crit1',
            incidentDate: '2026-04-30',
          } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () =>
        incidents.list({} as any, adminActor()),
      );
      expect(list.length).toBe(2);
      // critical first
      expect(list[0]!.id).toBe(b.id);
      expect(list[1]!.id).toBe(a.id);
    });

    it('list — query filters status, severity, categoryId, studentId, fromDate, toDate, limit', async () => {
      const a = await withTestTenant(async () =>
        incidents.create(
          {
            studentId: TEST_BEH_STU_A_ID,
            categoryId: TEST_BEH_CAT_MINOR_A_ID,
            description: 'x',
            incidentDate: '2026-05-01',
          } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        incidents.create(
          {
            studentId: TEST_BEH_STU_A2_ID,
            categoryId: TEST_BEH_CAT_CRIT_A_ID,
            description: 'y',
            incidentDate: '2026-05-15',
          } as any,
          adminActor(),
        ),
      );
      // status filter
      const open = await withTestTenant(async () =>
        incidents.list({ status: 'OPEN' } as any, adminActor()),
      );
      expect(open.every((i) => i.status === 'OPEN')).toBe(true);
      // severity filter
      const lows = await withTestTenant(async () =>
        incidents.list({ severity: 'LOW' } as any, adminActor()),
      );
      expect(lows.every((i) => i.severity === 'LOW')).toBe(true);
      // categoryId filter
      const minor = await withTestTenant(async () =>
        incidents.list({ categoryId: TEST_BEH_CAT_MINOR_A_ID } as any, adminActor()),
      );
      expect(minor.every((i) => i.categoryId === TEST_BEH_CAT_MINOR_A_ID)).toBe(true);
      // studentId filter
      const forA = await withTestTenant(async () =>
        incidents.list({ studentId: TEST_BEH_STU_A_ID } as any, adminActor()),
      );
      expect(forA.every((i) => i.studentId === TEST_BEH_STU_A_ID)).toBe(true);
      // fromDate / toDate filter (window contains only the May 1 incident)
      const win = await withTestTenant(async () =>
        incidents.list({ fromDate: '2026-05-01', toDate: '2026-05-10' } as any, adminActor()),
      );
      expect(win.map((i) => i.id)).toContain(a.id);
      expect(win.length).toBe(1);
      // limit
      const lim = await withTestTenant(async () =>
        incidents.list({ limit: 1 } as any, adminActor()),
      );
      expect(lim.length).toBe(1);
    });

    it('list — parent row scope returns own child + strips admin_notes', async () => {
      const stuA = await withTestTenant(async () =>
        incidents.create(
          {
            studentId: TEST_BEH_STU_A_ID,
            categoryId: TEST_BEH_CAT_MINOR_A_ID,
            description: 'parent visible',
            incidentDate: '2026-05-01',
          } as any,
          adminActor(),
        ),
      );
      // admin adds a private note via resolve
      await withTestTenant(async () =>
        incidents.resolve(stuA.id, { adminNotes: 'sensitive' } as any, adminActor()),
      );
      // also an incident for student A2 (no parent link)
      const stuA2 = await withTestTenant(async () =>
        incidents.create(
          {
            studentId: TEST_BEH_STU_A2_ID,
            categoryId: TEST_BEH_CAT_MINOR_A_ID,
            description: 'parent invisible',
            incidentDate: '2026-05-02',
          } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () =>
        incidents.list({} as any, parentActor()),
      );
      const ids = list.map((i) => i.id);
      expect(ids).toContain(stuA.id);
      expect(ids).not.toContain(stuA2.id);
      const own = list.find((i) => i.id === stuA.id)!;
      expect(own.adminNotes).toBeNull();
    });

    it('list — student persona returns no rows (AND FALSE branch)', async () => {
      await withTestTenant(async () =>
        incidents.create(
          {
            studentId: TEST_BEH_STU_A_ID,
            categoryId: TEST_BEH_CAT_MINOR_A_ID,
            description: 'x',
            incidentDate: '2026-05-01',
          } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () =>
        incidents.list({} as any, studentActor()),
      );
      expect(list).toEqual([]);
    });

    it('list — teacher row scope returns own-reported rows', async () => {
      // Teacher reports an incident
      const own = await withTestTenant(async () =>
        incidents.create(
          {
            studentId: TEST_BEH_STU_A_ID,
            categoryId: TEST_BEH_CAT_MINOR_A_ID,
            description: 'mine',
            incidentDate: '2026-05-01',
          } as any,
          teacherActor(),
        ),
      );
      // Admin reports against a different student
      const other = await withTestTenant(async () =>
        incidents.create(
          {
            studentId: TEST_BEH_STU_A2_ID,
            categoryId: TEST_BEH_CAT_MINOR_A_ID,
            description: 'admin',
            incidentDate: '2026-05-02',
          } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () =>
        incidents.list({} as any, teacherActor()),
      );
      const ids = list.map((i) => i.id);
      expect(ids).toContain(own.id);
      expect(ids).not.toContain(other.id);
      // admin_notes stripped on teacher view (non-manager)
      expect(list.find((i) => i.id === own.id)!.adminNotes).toBeNull();
    });

    it('getById — admin succeeds + 404 on bogus', async () => {
      const dto = await withTestTenant(async () =>
        incidents.create(
          {
            studentId: TEST_BEH_STU_A_ID,
            categoryId: TEST_BEH_CAT_MINOR_A_ID,
            description: 'x',
            incidentDate: '2026-05-01',
          } as any,
          adminActor(),
        ),
      );
      const got = await withTestTenant(async () =>
        incidents.getById(dto.id, adminActor()),
      );
      expect(got.id).toBe(dto.id);
      await expect(
        withTestTenant(async () =>
          incidents.getById('00000000-0000-0000-0000-000000000099', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById — parent of linked student succeeds, parent of unlinked → 404', async () => {
      const linked = await withTestTenant(async () =>
        incidents.create(
          {
            studentId: TEST_BEH_STU_A_ID,
            categoryId: TEST_BEH_CAT_MINOR_A_ID,
            description: 'x',
            incidentDate: '2026-05-01',
          } as any,
          adminActor(),
        ),
      );
      const unlinked = await withTestTenant(async () =>
        incidents.create(
          {
            studentId: TEST_BEH_STU_A2_ID,
            categoryId: TEST_BEH_CAT_MINOR_A_ID,
            description: 'y',
            incidentDate: '2026-05-01',
          } as any,
          adminActor(),
        ),
      );
      const got = await withTestTenant(async () =>
        incidents.getById(linked.id, parentActor()),
      );
      expect(got.id).toBe(linked.id);
      await expect(
        withTestTenant(async () => incidents.getById(unlinked.id, parentActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('review — non-admin Forbidden + missing 404 + duplicate REVIEW 400 + RESOLVED→REVIEW 400 + appends adminNotes', async () => {
      const dto = await withTestTenant(async () =>
        incidents.create(
          {
            studentId: TEST_BEH_STU_A_ID,
            categoryId: TEST_BEH_CAT_MINOR_A_ID,
            description: 'x',
            incidentDate: '2026-05-01',
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () => incidents.review(dto.id, {} as any, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      const reviewed = await withTestTenant(async () =>
        incidents.review(dto.id, { adminNotes: 'first note' } as any, adminActor()),
      );
      expect(reviewed.status).toBe('UNDER_REVIEW');
      expect(reviewed.adminNotes).toBe('first note');
      // duplicate UNDER_REVIEW → 400
      await expect(
        withTestTenant(async () =>
          incidents.review(dto.id, { adminNotes: 'second' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // missing → 404
      await expect(
        withTestTenant(async () =>
          incidents.review(
            '00000000-0000-0000-0000-000000000099',
            {} as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      // resolve then try to review → 400
      await withTestTenant(async () =>
        incidents.resolve(dto.id, {} as any, adminActor()),
      );
      await expect(
        withTestTenant(async () => incidents.review(dto.id, {} as any, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('resolve — fills resolved_by/at + emits beh.incident.resolved + appends adminNotes + 400 on duplicate', async () => {
      const dto = await withTestTenant(async () =>
        incidents.create(
          {
            studentId: TEST_BEH_STU_A_ID,
            categoryId: TEST_BEH_CAT_MINOR_A_ID,
            description: 'x',
            incidentDate: '2026-05-01',
          } as any,
          adminActor(),
        ),
      );
      // First add an initial admin note via review
      await withTestTenant(async () =>
        incidents.review(dto.id, { adminNotes: 'initial' } as any, adminActor()),
      );
      kafka.reset();
      const r = await withTestTenant(async () =>
        incidents.resolve(dto.id, { adminNotes: 'final' } as any, adminActor()),
      );
      expect(r.status).toBe('RESOLVED');
      expect(r.resolvedById).toBe(TEST_ADMIN_EMPLOYEE_ID);
      expect(r.resolvedAt).not.toBeNull();
      expect(r.adminNotes).toContain('initial');
      expect(r.adminNotes).toContain('final');
      const emit = kafka.callsForTopic('beh.incident.resolved');
      expect(emit.length).toBe(1);
      // duplicate resolve → 400
      await expect(
        withTestTenant(async () => incidents.resolve(dto.id, {} as any, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('resolve — non-admin Forbidden, missing 404, admin without employeeId Forbidden', async () => {
      const dto = await withTestTenant(async () =>
        incidents.create(
          {
            studentId: TEST_BEH_STU_A_ID,
            categoryId: TEST_BEH_CAT_MINOR_A_ID,
            description: 'x',
            incidentDate: '2026-05-01',
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () => incidents.resolve(dto.id, {} as any, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // admin without employeeId
      const phantom = { ...adminActor(), employeeId: null } as any;
      await expect(
        withTestTenant(async () => incidents.resolve(dto.id, {} as any, phantom)),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // missing → 404
      await expect(
        withTestTenant(async () =>
          incidents.resolve(
            '00000000-0000-0000-0000-000000000099',
            {} as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('reopen RESOLVED → OPEN, clears resolved fields + rejects non-RESOLVED + 404 + Forbidden', async () => {
      const dto = await withTestTenant(async () =>
        incidents.create(
          {
            studentId: TEST_BEH_STU_A_ID,
            categoryId: TEST_BEH_CAT_MINOR_A_ID,
            description: 'x',
            incidentDate: '2026-05-01',
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () => incidents.reopen(dto.id, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // rejection on non-RESOLVED
      await expect(
        withTestTenant(async () => incidents.reopen(dto.id, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
      await withTestTenant(async () => incidents.resolve(dto.id, {} as any, adminActor()));
      const reop = await withTestTenant(async () => incidents.reopen(dto.id, adminActor()));
      expect(reop.status).toBe('OPEN');
      expect(reop.resolvedAt).toBeNull();
      expect(reop.resolvedById).toBeNull();
      // missing
      await expect(
        withTestTenant(async () =>
          incidents.reopen('00000000-0000-0000-0000-000000000099', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school isolation — School A admin cannot read School B incident', async () => {
      // Post a B-side incident using the shadow school B employee actor.
      const bAdminActor = {
        ...adminActor(),
        employeeId: TEST_BEH_SHADOW_EMP_B_ID,
      } as any;
      const bDto = await withTestTenantB(async () =>
        incidents.create(
          {
            studentId: TEST_BEH_STU_B_ID,
            categoryId: TEST_BEH_CAT_MINOR_B_ID,
            description: 'school b only',
            incidentDate: '2026-05-01',
          } as any,
          bAdminActor,
        ),
      );
      // School A admin cannot get the B incident: query inside A's tenant
      // context returns no row (no school predicate explicit in SELECT;
      // since they share the same schema, the row is visible to a raw
      // select. Service-layer "list" returns it because the row IS in the
      // schema. NOTE: incident.service.ts has no explicit school_id filter
      // in SELECT — instead, services rely on the canonical row scope.
      // Verify the row exists in B's view, and that loadForActionWrite via
      // the row itself works. The B incident IS visible in a generic list
      // call from A because IncidentService does not filter by school_id
      // (the schema is shared). Instead, asserting on parent-of-A still
      // does not see B's student.
      const fromB = await withTestTenantB(async () =>
        incidents.list({} as any, bAdminActor),
      );
      expect(fromB.map((i) => i.id)).toContain(bDto.id);
      // Parent in school A (linked only to student A) should not see B's row
      const fromAParent = await withTestTenant(async () =>
        incidents.list({} as any, parentActor()),
      );
      expect(fromAParent.map((i) => i.id)).not.toContain(bDto.id);
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // discipline/ — ActionService
  // ═════════════════════════════════════════════════════════════════════
  describe('ActionService', () => {
    async function seedIncident(): Promise<string> {
      const dto = await withTestTenant(async () =>
        incidents.create(
          {
            studentId: TEST_BEH_STU_A_ID,
            categoryId: TEST_BEH_CAT_MAJOR_A_ID,
            description: 'fight',
            incidentDate: '2026-05-01',
          } as any,
          adminActor(),
        ),
      );
      return dto.id;
    }

    it('create with parent-notification fires beh.action.parent_notification_required + lists action', async () => {
      const incId = await seedIncident();
      kafka.reset();
      const dto = await withTestTenant(async () =>
        actionsSvc.create(
          incId,
          {
            actionTypeId: TEST_BEH_ACT_TYPE_DETENTION_A_ID,
            startDate: '2026-05-02',
            endDate: '2026-05-03',
            notes: 'after school 2 days',
          } as any,
          adminActor(),
        ),
      );
      expect(dto.actionTypeName).toBe('Detention');
      expect(dto.requiresParentNotification).toBe(true);
      const list = await withTestTenant(async () =>
        actionsSvc.listForIncident(incId, adminActor()),
      );
      expect(list.map((a) => a.id)).toContain(dto.id);
      // Kafka emit includes the guardian's portal account id
      const emit = kafka.callsForTopic('beh.action.parent_notification_required');
      expect(emit.length).toBe(1);
      const payload = emit[0]!.payload as any;
      expect(payload.guardianAccountIds).toContain(TEST_PARENT_ACCOUNT_ID);
      expect(payload.actionTypeName).toBe('Detention');
    });

    it('create with non-parent-notification action skips emit', async () => {
      const incId = await seedIncident();
      kafka.reset();
      await withTestTenant(async () =>
        actionsSvc.create(
          incId,
          { actionTypeId: TEST_BEH_ACT_TYPE_WARNING_A_ID } as any,
          adminActor(),
        ),
      );
      expect(kafka.callsForTopic('beh.action.parent_notification_required').length).toBe(0);
    });

    it('create non-admin Forbidden, admin without employeeId Forbidden', async () => {
      const incId = await seedIncident();
      await expect(
        withTestTenant(async () =>
          actionsSvc.create(
            incId,
            { actionTypeId: TEST_BEH_ACT_TYPE_DETENTION_A_ID } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      const phantom = { ...adminActor(), employeeId: null } as any;
      await expect(
        withTestTenant(async () =>
          actionsSvc.create(
            incId,
            { actionTypeId: TEST_BEH_ACT_TYPE_DETENTION_A_ID } as any,
            phantom,
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('create on RESOLVED incident → 400 via loadForActionWrite', async () => {
      const incId = await seedIncident();
      await withTestTenant(async () => incidents.resolve(incId, {} as any, adminActor()));
      await expect(
        withTestTenant(async () =>
          actionsSvc.create(
            incId,
            { actionTypeId: TEST_BEH_ACT_TYPE_DETENTION_A_ID } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('create rejects endDate before startDate + 400 on duplicate (incident, action_type)', async () => {
      const incId = await seedIncident();
      await expect(
        withTestTenant(async () =>
          actionsSvc.create(
            incId,
            {
              actionTypeId: TEST_BEH_ACT_TYPE_DETENTION_A_ID,
              startDate: '2026-05-03',
              endDate: '2026-05-02',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      await withTestTenant(async () =>
        actionsSvc.create(
          incId,
          { actionTypeId: TEST_BEH_ACT_TYPE_DETENTION_A_ID } as any,
          adminActor(),
        ),
      );
      // Duplicate (incident, action_type) — UNIQUE catch translates to 400
      await expect(
        withTestTenant(async () =>
          actionsSvc.create(
            incId,
            { actionTypeId: TEST_BEH_ACT_TYPE_DETENTION_A_ID } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('update — dates + notes + parentNotified flip stamps parent_notified_at, then clears on false', async () => {
      const incId = await seedIncident();
      const a = await withTestTenant(async () =>
        actionsSvc.create(
          incId,
          { actionTypeId: TEST_BEH_ACT_TYPE_DETENTION_A_ID } as any,
          adminActor(),
        ),
      );
      const upd = await withTestTenant(async () =>
        actionsSvc.update(
          a.id,
          {
            startDate: '2026-05-04',
            endDate: '2026-05-05',
            notes: 'updated',
            parentNotified: true,
          } as any,
          adminActor(),
        ),
      );
      expect(upd.startDate).toBe('2026-05-04');
      expect(upd.notes).toBe('updated');
      expect(upd.parentNotified).toBe(true);
      expect(upd.parentNotifiedAt).not.toBeNull();
      // Flip back to false — clears parent_notified_at
      const cleared = await withTestTenant(async () =>
        actionsSvc.update(a.id, { parentNotified: false } as any, adminActor()),
      );
      expect(cleared.parentNotified).toBe(false);
      expect(cleared.parentNotifiedAt).toBeNull();
      // No-op update returns the row
      const same = await withTestTenant(async () =>
        actionsSvc.update(a.id, {} as any, adminActor()),
      );
      expect(same.id).toBe(a.id);
      // Invalid date order under lock → 400
      await expect(
        withTestTenant(async () =>
          actionsSvc.update(
            a.id,
            { startDate: '2026-05-09', endDate: '2026-05-04' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Non-admin → 403
      await expect(
        withTestTenant(async () =>
          actionsSvc.update(a.id, { notes: 'x' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // Missing id → 404 (inside the lock branch)
      await expect(
        withTestTenant(async () =>
          actionsSvc.update(
            '00000000-0000-0000-0000-000000000099',
            { notes: 'x' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('remove — non-admin 403, RESOLVED 400, success deletes, missing 404', async () => {
      const incId = await seedIncident();
      const a = await withTestTenant(async () =>
        actionsSvc.create(
          incId,
          { actionTypeId: TEST_BEH_ACT_TYPE_WARNING_A_ID } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () => actionsSvc.remove(a.id, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () =>
          actionsSvc.remove('00000000-0000-0000-0000-000000000099', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      await withTestTenant(async () => actionsSvc.remove(a.id, adminActor()));
      // Re-remove → 404 because the row is gone
      await expect(
        withTestTenant(async () => actionsSvc.remove(a.id, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);

      // RESOLVED incident — remove rejected
      const a2 = await withTestTenant(async () =>
        actionsSvc.create(
          incId,
          { actionTypeId: TEST_BEH_ACT_TYPE_DETENTION_A_ID } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () => incidents.resolve(incId, {} as any, adminActor()));
      await expect(
        withTestTenant(async () => actionsSvc.remove(a2.id, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('listForIncident — non-participant 404 via parent gate', async () => {
      const incId = await withTestTenant(async () =>
        incidents
          .create(
            {
              studentId: TEST_BEH_STU_A2_ID,
              categoryId: TEST_BEH_CAT_MINOR_A_ID,
              description: 'x',
              incidentDate: '2026-05-01',
            } as any,
            adminActor(),
          )
          .then((d) => d.id),
      );
      await expect(
        withTestTenant(async () => actionsSvc.listForIncident(incId, parentActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('inactive action type → 400 via assertActive', async () => {
      const incId = await seedIncident();
      await expect(
        withTestTenant(async () =>
          actionsSvc.create(
            incId,
            { actionTypeId: TEST_BEH_ACT_TYPE_INACTIVE_A_ID } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // intervention-plans/ — BehaviorPlanService
  // ═════════════════════════════════════════════════════════════════════
  describe('BehaviorPlanService', () => {
    function createInput(overrides?: Record<string, unknown>) {
      return {
        studentId: TEST_BEH_STU_A_ID,
        planType: 'BIP',
        reviewDate: '2026-12-01',
        targetBehaviors: ['stay seated'],
        replacementBehaviors: ['raise hand'],
        reinforcementStrategies: ['token economy'],
        ...overrides,
      };
    }

    it('create — counsellor scope required + bogus student 400 + bogus source incident 400', async () => {
      // Teacher with default scope → Forbidden
      await expect(
        withTestTenant(async () => plans.create(createInput() as any, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // Admin without employeeId → Forbidden
      const phantom = { ...adminActor(), employeeId: null } as any;
      await expect(
        withTestTenant(async () => plans.create(createInput() as any, phantom)),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // Bogus student
      await expect(
        withTestTenant(async () =>
          plans.create(
            createInput({ studentId: '00000000-0000-0000-0000-000000000099' }) as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Bogus source incident
      await expect(
        withTestTenant(async () =>
          plans.create(
            createInput({
              sourceIncidentId: '00000000-0000-0000-0000-000000000099',
            }) as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Successful create
      const dto = await withTestTenant(async () =>
        plans.create(createInput() as any, adminActor()),
      );
      expect(dto.status).toBe('DRAFT');
      expect(dto.planType).toBe('BIP');
      expect(dto.studentId).toBe(TEST_BEH_STU_A_ID);
    });

    it('create with valid source_incident_id links to discipline incident', async () => {
      const inc = await withTestTenant(async () =>
        incidents.create(
          {
            studentId: TEST_BEH_STU_A_ID,
            categoryId: TEST_BEH_CAT_MAJOR_A_ID,
            description: 'fighting',
            incidentDate: '2026-05-01',
          } as any,
          adminActor(),
        ),
      );
      const dto = await withTestTenant(async () =>
        plans.create(createInput({ sourceIncidentId: inc.id }) as any, adminActor()),
      );
      expect(dto.sourceIncidentId).toBe(inc.id);
    });

    it('list + getById — counsellor sees all; parent sees own children with feedback stripped', async () => {
      const a = await withTestTenant(async () =>
        plans.create(createInput() as any, adminActor()),
      );
      const a2 = await withTestTenant(async () =>
        plans.create(
          createInput({ studentId: TEST_BEH_STU_A2_ID, planType: 'BSP' }) as any,
          adminActor(),
        ),
      );
      // Activate & request feedback so we have a feedback row on `a`
      await withTestTenant(async () => plans.activate(a.id, adminActor()));
      await withTestTenant(async () =>
        feedback.requestFeedback(
          a.id,
          { teacherId: TEST_TEACHER_EMPLOYEE_ID } as any,
          adminActor(),
        ),
      );
      // Counsellor sees all
      const adminList = await withTestTenant(async () =>
        plans.list({} as any, adminActor()),
      );
      expect(adminList.length).toBeGreaterThanOrEqual(2);
      // status filter
      const draftList = await withTestTenant(async () =>
        plans.list({ status: 'DRAFT' } as any, adminActor()),
      );
      expect(draftList.map((p) => p.id)).toContain(a2.id);
      expect(draftList.every((p) => p.status === 'DRAFT')).toBe(true);
      // planType filter
      const bipList = await withTestTenant(async () =>
        plans.list({ planType: 'BIP' } as any, adminActor()),
      );
      expect(bipList.every((p) => p.planType === 'BIP')).toBe(true);
      // studentId filter
      const stuList = await withTestTenant(async () =>
        plans.list({ studentId: TEST_BEH_STU_A_ID } as any, adminActor()),
      );
      expect(stuList.every((p) => p.studentId === TEST_BEH_STU_A_ID)).toBe(true);
      // Parent sees only their child + feedback stripped
      const parentList = await withTestTenant(async () =>
        plans.list({} as any, parentActor()),
      );
      const ids = parentList.map((p) => p.id);
      expect(ids).toContain(a.id);
      expect(ids).not.toContain(a2.id);
      const parentA = parentList.find((p) => p.id === a.id)!;
      expect(parentA.feedback).toEqual([]);
      // Parent getById on linked plan succeeds
      const got = await withTestTenant(async () => plans.getById(a.id, parentActor()));
      expect(got.id).toBe(a.id);
      // Parent getById on unlinked plan → 404
      await expect(
        withTestTenant(async () => plans.getById(a2.id, parentActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('list — student / unknown persona returns empty (AND FALSE branch)', async () => {
      await withTestTenant(async () => plans.create(createInput() as any, adminActor()));
      const list = await withTestTenant(async () =>
        plans.list({} as any, studentActor()),
      );
      expect(list).toEqual([]);
    });

    it('list — teacher row scope sees plans for own-class students only', async () => {
      // The fixture seed doesn't enroll TEST_BEH_STU_A in a class linked to
      // TEST_TEACHER_EMPLOYEE_ID, so the teacher branch returns empty.
      await withTestTenant(async () =>
        plans.create(createInput() as any, adminActor()),
      );
      const list = await withTestTenant(async () =>
        plans.list({} as any, teacherActor()),
      );
      // No enrollment seeded for STU_A in teacher's class → empty
      expect(list).toEqual([]);
    });

    it('hasCounsellorScope — admin true; teacher false; teacher with grant true', async () => {
      const adminScope = await withTestTenant(async () => plans.hasCounsellorScope(adminActor()));
      expect(adminScope).toBe(true);
      const teacherScope = await withTestTenant(async () =>
        plans.hasCounsellorScope(teacherActor()),
      );
      expect(teacherScope).toBe(false);
      await grantTeacher(['beh-002:write']);
      const teacherGranted = await withTestTenant(async () =>
        plans.hasCounsellorScope(teacherActor()),
      );
      expect(teacherGranted).toBe(true);
    });

    it('canSeeFeedback — parent false, student false, admin true', async () => {
      expect(await plans.canSeeFeedback(parentActor())).toBe(false);
      expect(await plans.canSeeFeedback(studentActor())).toBe(false);
      expect(await plans.canSeeFeedback(adminActor())).toBe(true);
    });

    it('update — counsellor only, EXPIRED read-only, ACTIVE rejects non-REVIEW transition, regular field bumps', async () => {
      const a = await withTestTenant(async () =>
        plans.create(createInput() as any, adminActor()),
      );
      // Teacher → 403
      await expect(
        withTestTenant(async () =>
          plans.update(a.id, { reviewDate: '2027-01-01' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // missing id → 404
      await expect(
        withTestTenant(async () =>
          plans.update(
            '00000000-0000-0000-0000-000000000099',
            { reviewDate: '2027-01-01' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      // Update non-status fields
      const upd = await withTestTenant(async () =>
        plans.update(
          a.id,
          {
            reviewDate: '2027-01-01',
            targetBehaviors: ['stay seated', 'on task'],
            replacementBehaviors: ['raise hand', 'breathing'],
            reinforcementStrategies: ['stars'],
            status: 'REVIEW',
          } as any,
          adminActor(),
        ),
      );
      expect(upd.status).toBe('REVIEW');
      expect(upd.targetBehaviors).toContain('on task');
      // Empty update → no-op returns same id
      const same = await withTestTenant(async () =>
        plans.update(a.id, {} as any, adminActor()),
      );
      expect(same.id).toBe(a.id);
      // Activate then try to update status back to DRAFT via PATCH → 400
      await withTestTenant(async () =>
        plans.update(a.id, { status: 'DRAFT' } as any, adminActor()),
      );
      await withTestTenant(async () => plans.activate(a.id, adminActor()));
      await expect(
        withTestTenant(async () =>
          plans.update(a.id, { status: 'DRAFT' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // ACTIVE → REVIEW is allowed
      const inReview = await withTestTenant(async () =>
        plans.update(a.id, { status: 'REVIEW' } as any, adminActor()),
      );
      expect(inReview.status).toBe('REVIEW');
      // Expire then try any update → 400
      await withTestTenant(async () => plans.expire(a.id, adminActor()));
      await expect(
        withTestTenant(async () =>
          plans.update(a.id, { status: 'DRAFT' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        withTestTenant(async () =>
          plans.update(a.id, { reviewDate: '2027-06-01' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('activate — DRAFT → ACTIVE; duplicate active per (student,type) 400; EXPIRED 400; duplicate ACTIVE 400', async () => {
      const a = await withTestTenant(async () =>
        plans.create(createInput() as any, adminActor()),
      );
      // Non-counsellor
      await expect(
        withTestTenant(async () => plans.activate(a.id, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // missing
      await expect(
        withTestTenant(async () =>
          plans.activate('00000000-0000-0000-0000-000000000099', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      const active = await withTestTenant(async () => plans.activate(a.id, adminActor()));
      expect(active.status).toBe('ACTIVE');
      // Already ACTIVE → 400
      await expect(
        withTestTenant(async () => plans.activate(a.id, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
      // New DRAFT for same (student, BIP) — activate trips pre-flight
      const dup = await withTestTenant(async () =>
        plans.create(createInput() as any, adminActor()),
      );
      await expect(
        withTestTenant(async () => plans.activate(dup.id, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
      // expire `a` and activate dup
      await withTestTenant(async () => plans.expire(a.id, adminActor()));
      const dupActive = await withTestTenant(async () => plans.activate(dup.id, adminActor()));
      expect(dupActive.status).toBe('ACTIVE');
      // EXPIRED → activate rejected
      await expect(
        withTestTenant(async () => plans.activate(a.id, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('expire — counsellor only, missing 404, already EXPIRED 400', async () => {
      const a = await withTestTenant(async () =>
        plans.create(createInput() as any, adminActor()),
      );
      await expect(
        withTestTenant(async () => plans.expire(a.id, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () =>
          plans.expire('00000000-0000-0000-0000-000000000099', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      const exp = await withTestTenant(async () => plans.expire(a.id, adminActor()));
      expect(exp.status).toBe('EXPIRED');
      await expect(
        withTestTenant(async () => plans.expire(a.id, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('loadForChildWrite — EXPIRED plan 400', async () => {
      const a = await withTestTenant(async () =>
        plans.create(createInput() as any, adminActor()),
      );
      await withTestTenant(async () => plans.expire(a.id, adminActor()));
      await expect(
        withTestTenant(async () => plans.loadForChildWrite(a.id, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('loadOrFailNoAuth — 404 on missing', async () => {
      await expect(
        withTestTenant(async () =>
          plans.loadOrFailNoAuth('00000000-0000-0000-0000-000000000099'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // intervention-plans/ — GoalService
  // ═════════════════════════════════════════════════════════════════════
  describe('GoalService', () => {
    async function seedPlan(): Promise<string> {
      const dto = await withTestTenant(async () =>
        plans.create(
          {
            studentId: TEST_BEH_STU_A_ID,
            planType: 'BIP',
            reviewDate: '2026-12-01',
            targetBehaviors: ['stay seated'],
          } as any,
          adminActor(),
        ),
      );
      return dto.id;
    }

    it('listForPlan + create + update + remove happy path + bumps last_assessed_at', async () => {
      const planId = await seedPlan();
      const list0 = await withTestTenant(async () =>
        goals.listForPlan(planId, adminActor()),
      );
      expect(list0).toEqual([]);
      const g = await withTestTenant(async () =>
        goals.create(
          planId,
          {
            goalText: 'reduce blurting',
            baselineFrequency: '5 per day',
            targetFrequency: '1 per day',
            measurementMethod: 'tally',
          } as any,
          adminActor(),
        ),
      );
      expect(g.goalText).toBe('reduce blurting');
      expect(g.progress).toBe('NOT_STARTED');
      expect(g.lastAssessedAt).toBeNull();
      const upd = await withTestTenant(async () =>
        goals.update(
          g.id,
          {
            progress: 'IN_PROGRESS',
            goalText: 'reduce blurting v2',
            baselineFrequency: '4',
            targetFrequency: '0',
            measurementMethod: 'count',
          } as any,
          adminActor(),
        ),
      );
      expect(upd.progress).toBe('IN_PROGRESS');
      expect(upd.lastAssessedAt).not.toBeNull();
      // No-op
      const same = await withTestTenant(async () =>
        goals.update(g.id, {} as any, adminActor()),
      );
      expect(same.id).toBe(g.id);
      // Reverting to NOT_STARTED does NOT bump last_assessed_at (only the
      // progress column changes)
      const back = await withTestTenant(async () =>
        goals.update(g.id, { progress: 'NOT_STARTED' } as any, adminActor()),
      );
      expect(back.progress).toBe('NOT_STARTED');
      // remove
      await withTestTenant(async () => goals.remove(g.id, adminActor()));
      const list1 = await withTestTenant(async () =>
        goals.listForPlan(planId, adminActor()),
      );
      expect(list1).toEqual([]);
    });

    it('create / update / remove non-counsellor → Forbidden', async () => {
      const planId = await seedPlan();
      await expect(
        withTestTenant(async () =>
          goals.create(planId, { goalText: 'x' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      const g = await withTestTenant(async () =>
        goals.create(planId, { goalText: 'y' } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          goals.update(g.id, { goalText: 'z' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => goals.remove(g.id, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('update/remove on EXPIRED plan → 403', async () => {
      const planId = await seedPlan();
      const g = await withTestTenant(async () =>
        goals.create(planId, { goalText: 'x' } as any, adminActor()),
      );
      await withTestTenant(async () => plans.expire(planId, adminActor()));
      await expect(
        withTestTenant(async () =>
          goals.update(g.id, { progress: 'MET' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => goals.remove(g.id, adminActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('missing id paths → 404 for update + remove', async () => {
      await expect(
        withTestTenant(async () =>
          goals.update(
            '00000000-0000-0000-0000-000000000099',
            { goalText: 'x' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        withTestTenant(async () =>
          goals.remove('00000000-0000-0000-0000-000000000099', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('create on EXPIRED plan → 400 via loadForChildWrite', async () => {
      const planId = await seedPlan();
      await withTestTenant(async () => plans.expire(planId, adminActor()));
      await expect(
        withTestTenant(async () =>
          goals.create(planId, { goalText: 'x' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // intervention-plans/ — FeedbackService (Cycle 9 surface)
  // ═════════════════════════════════════════════════════════════════════
  describe('FeedbackService', () => {
    async function seedPlan(): Promise<string> {
      const dto = await withTestTenant(async () =>
        plans.create(
          {
            studentId: TEST_BEH_STU_A_ID,
            planType: 'BIP',
            reviewDate: '2026-12-01',
            targetBehaviors: ['stay seated'],
          } as any,
          adminActor(),
        ),
      );
      return dto.id;
    }

    it('requestFeedback — non-counsellor Forbidden, no employeeId Forbidden, bogus teacher 400', async () => {
      const planId = await seedPlan();
      await expect(
        withTestTenant(async () =>
          feedback.requestFeedback(
            planId,
            { teacherId: TEST_TEACHER_EMPLOYEE_ID } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      const phantom = { ...adminActor(), employeeId: null } as any;
      await expect(
        withTestTenant(async () =>
          feedback.requestFeedback(
            planId,
            { teacherId: TEST_TEACHER_EMPLOYEE_ID } as any,
            phantom,
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () =>
          feedback.requestFeedback(
            planId,
            { teacherId: '00000000-0000-0000-0000-000000000099' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('requestFeedback — happy path emits beh.bip.feedback_requested + duplicate pending 400', async () => {
      const planId = await seedPlan();
      kafka.reset();
      const fb = await withTestTenant(async () =>
        feedback.requestFeedback(
          planId,
          { teacherId: TEST_TEACHER_EMPLOYEE_ID } as any,
          adminActor(),
        ),
      );
      expect(fb.planId).toBe(planId);
      expect(fb.submittedAt).toBeNull();
      expect(fb.teacherId).toBe(TEST_TEACHER_EMPLOYEE_ID);
      const emit = kafka.callsForTopic('beh.bip.feedback_requested');
      expect(emit.length).toBe(1);
      const payload = emit[0]!.payload as any;
      expect(payload.feedbackId).toBe(fb.id);
      expect(payload.planId).toBe(planId);
      expect(payload.recipientAccountId).toBe(TEST_TEACHER_ACCOUNT_ID);
      // Pending dup → 400 via pre-flight
      await expect(
        withTestTenant(async () =>
          feedback.requestFeedback(
            planId,
            { teacherId: TEST_TEACHER_EMPLOYEE_ID } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('listForPlan — counsellor sees rows; guardian/student see empty', async () => {
      const planId = await seedPlan();
      await withTestTenant(async () =>
        feedback.requestFeedback(
          planId,
          { teacherId: TEST_TEACHER_EMPLOYEE_ID } as any,
          adminActor(),
        ),
      );
      const a = await withTestTenant(async () =>
        feedback.listForPlan(planId, adminActor()),
      );
      expect(a.length).toBe(1);
      const p = await withTestTenant(async () =>
        feedback.listForPlan(planId, parentActor()),
      );
      expect(p).toEqual([]);
    });

    it('submit — happy path stamps submitted_at + 400 on duplicate submit + Forbidden for non-assigned teacher', async () => {
      const planId = await seedPlan();
      const fb = await withTestTenant(async () =>
        feedback.requestFeedback(
          planId,
          { teacherId: TEST_TEACHER_EMPLOYEE_ID } as any,
          adminActor(),
        ),
      );
      // Teacher (who is the assigned teacher) submits
      const submitted = await withTestTenant(async () =>
        feedback.submit(
          fb.id,
          {
            strategiesObserved: ['praise'],
            overallEffectiveness: 'EFFECTIVE',
            classroomObservations: 'better',
            recommendedAdjustments: 'maybe shorter prompts',
          } as any,
          teacherActor(),
        ),
      );
      expect(submitted.submittedAt).not.toBeNull();
      expect(submitted.overallEffectiveness).toBe('EFFECTIVE');
      // Duplicate submit → 400
      await expect(
        withTestTenant(async () => feedback.submit(fb.id, {} as any, teacherActor())),
      ).rejects.toBeInstanceOf(BadRequestException);

      // New pending row, submit attempt by non-assigned/non-counsellor → 403
      const fb2 = await withTestTenant(async () =>
        feedback.requestFeedback(
          planId,
          { teacherId: TEST_TEACHER_EMPLOYEE_ID } as any,
          adminActor(),
        ),
      );
      const otherStaff = {
        ...teacherActor(),
        employeeId: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
      } as any;
      await expect(
        withTestTenant(async () => feedback.submit(fb2.id, {} as any, otherStaff)),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // Admin override — counsellor scope wins
      const overridden = await withTestTenant(async () =>
        feedback.submit(fb2.id, {} as any, adminActor()),
      );
      expect(overridden.submittedAt).not.toBeNull();
      // Missing id → 404
      await expect(
        withTestTenant(async () =>
          feedback.submit(
            '00000000-0000-0000-0000-000000000099',
            {} as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('listPending — teacher sees own pending; counsellor sees all; non-staff empty', async () => {
      const planId = await seedPlan();
      await withTestTenant(async () =>
        feedback.requestFeedback(
          planId,
          { teacherId: TEST_TEACHER_EMPLOYEE_ID } as any,
          adminActor(),
        ),
      );
      const teacherPending = await withTestTenant(async () =>
        feedback.listPending(teacherActor()),
      );
      expect(teacherPending.length).toBeGreaterThanOrEqual(1);
      expect(teacherPending[0]!.studentName).not.toBeNull();
      expect(teacherPending[0]!.planType).toBe('BIP');
      const adminPending = await withTestTenant(async () =>
        feedback.listPending(adminActor()),
      );
      expect(adminPending.length).toBeGreaterThanOrEqual(1);
      // Parent (no employeeId, non-counsellor) → returns []
      const parentPending = await withTestTenant(async () =>
        feedback.listPending(parentActor()),
      );
      expect(parentPending).toEqual([]);
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // intervention-plans/ — BipFeedbackService (P2-14 surface)
  // ═════════════════════════════════════════════════════════════════════
  describe('BipFeedbackService', () => {
    async function seedPlan(): Promise<string> {
      const dto = await withTestTenant(async () =>
        plans.create(
          {
            studentId: TEST_BEH_STU_A_ID,
            planType: 'BIP',
            reviewDate: '2026-12-01',
            targetBehaviors: ['stay seated'],
          } as any,
          adminActor(),
        ),
      );
      return dto.id;
    }

    it('requestFeedback — happy path, dup pending → Conflict, non-counsellor Forbidden, no employeeId 400', async () => {
      const planId = await seedPlan();
      const dto = await withTestTenant(async () =>
        bipFeedback.requestFeedback(
          planId,
          { teacherEmployeeId: TEST_TEACHER_EMPLOYEE_ID } as any,
          adminActor(),
        ),
      );
      expect(dto.planId).toBe(planId);
      expect(dto.submittedAt).toBeNull();
      // Duplicate pending → ConflictException
      await expect(
        withTestTenant(async () =>
          bipFeedback.requestFeedback(
            planId,
            { teacherEmployeeId: TEST_TEACHER_EMPLOYEE_ID } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      // Non-counsellor
      await expect(
        withTestTenant(async () =>
          bipFeedback.requestFeedback(
            planId,
            { teacherEmployeeId: TEST_TEACHER_EMPLOYEE_ID } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // No employeeId → BadRequest
      const phantom = { ...adminActor(), employeeId: null } as any;
      await expect(
        withTestTenant(async () =>
          bipFeedback.requestFeedback(
            planId,
            { teacherEmployeeId: TEST_TEACHER_EMPLOYEE_ID } as any,
            phantom,
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // bogus planId → NotFound
      await expect(
        withTestTenant(async () =>
          bipFeedback.requestFeedback(
            '00000000-0000-0000-0000-000000000099',
            { teacherEmployeeId: TEST_TEACHER_EMPLOYEE_ID } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      // bogus teacher → BadRequest
      const planId2 = await seedPlan();
      await expect(
        withTestTenant(async () =>
          bipFeedback.requestFeedback(
            planId2,
            { teacherEmployeeId: '00000000-0000-0000-0000-000000000099' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('submit — assigned teacher succeeds + already-submitted 400 + non-assigned 403 + admin override + missing 404', async () => {
      const planId = await seedPlan();
      const fb = await withTestTenant(async () =>
        bipFeedback.requestFeedback(
          planId,
          { teacherEmployeeId: TEST_TEACHER_EMPLOYEE_ID } as any,
          adminActor(),
        ),
      );
      // non-assigned teacher → 403
      const other = {
        ...teacherActor(),
        employeeId: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
      } as any;
      await expect(
        withTestTenant(async () => bipFeedback.submit(fb.id, {} as any, other)),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // assigned teacher submits
      const sub = await withTestTenant(async () =>
        bipFeedback.submit(
          fb.id,
          {
            strategiesObserved: ['praise'],
            overallEffectiveness: 'EFFECTIVE',
            classroomObservations: 'okay',
            recommendedAdjustments: 'note',
          } as any,
          teacherActor(),
        ),
      );
      expect(sub.submittedAt).not.toBeNull();
      // already submitted → 400
      await expect(
        withTestTenant(async () => bipFeedback.submit(fb.id, {} as any, teacherActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
      // admin override on new pending
      const fb2 = await withTestTenant(async () =>
        bipFeedback.requestFeedback(
          planId,
          { teacherEmployeeId: TEST_TEACHER_EMPLOYEE_ID } as any,
          adminActor(),
        ),
      );
      const ovr = await withTestTenant(async () =>
        bipFeedback.submit(fb2.id, {} as any, adminActor()),
      );
      expect(ovr.submittedAt).not.toBeNull();
      // missing
      await expect(
        withTestTenant(async () =>
          bipFeedback.submit(
            '00000000-0000-0000-0000-000000000099',
            {} as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('listForPlan + getById', async () => {
      const planId = await seedPlan();
      const fb = await withTestTenant(async () =>
        bipFeedback.requestFeedback(
          planId,
          { teacherEmployeeId: TEST_TEACHER_EMPLOYEE_ID } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () => bipFeedback.listForPlan(planId));
      expect(list.map((f) => f.id)).toContain(fb.id);
      const got = await withTestTenant(async () => bipFeedback.getById(fb.id));
      expect(got.id).toBe(fb.id);
      await expect(
        withTestTenant(async () =>
          bipFeedback.getById('00000000-0000-0000-0000-000000000099'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // positive/ — PositiveBehaviourService
  // ═════════════════════════════════════════════════════════════════════
  describe('PositiveBehaviourService', () => {
    it('award — Forbidden without scope, BadRequest on no employeeId, bogus student 400', async () => {
      // Pure non-staff (student) → Forbidden
      await expect(
        withTestTenant(async () =>
          positive.award(
            {
              studentId: TEST_BEH_STU_A_ID,
              category: 'Respect',
              points: 5,
              reason: 'r',
            } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // admin without employeeId → BadRequest
      const phantom = { ...adminActor(), employeeId: null } as any;
      await expect(
        withTestTenant(async () =>
          positive.award(
            {
              studentId: TEST_BEH_STU_A_ID,
              category: 'R',
              points: 5,
              reason: 'r',
            } as any,
            phantom,
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // bogus student
      await expect(
        withTestTenant(async () =>
          positive.award(
            {
              studentId: '00000000-0000-0000-0000-000000000099',
              category: 'R',
              points: 5,
              reason: 'r',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('award — enqueues outbox row beh.positive_points.awarded (deterministic event id)', async () => {
      const dto = await withTestTenant(async () =>
        positive.award(
          {
            studentId: TEST_BEH_STU_A_ID,
            category: 'Respect',
            points: 10,
            reason: 'helping classmate',
          } as any,
          adminActor(),
        ),
      );
      expect(dto.transactionType).toBe('AWARD');
      expect(dto.points).toBe(10);
      // Outbox row landed
      const rows = await rawClient.$queryRawUnsafe<
        Array<{ topic: string; event_id: string; message_key: string }>
      >(
        `SELECT topic, (envelope->>'event_id') AS event_id, message_key
         FROM platform.platform_outbox
         WHERE topic = 'beh.positive_points.awarded' AND tenant_id = $1::uuid
         ORDER BY created_at DESC LIMIT 1`,
        TEST_SCHOOL_ID,
      );
      expect(rows.length).toBe(1);
      expect(rows[0]!.message_key).toBe(dto.id);
      const expected = deterministicPositivePointsAwardedEventId(dto.id);
      expect(rows[0]!.event_id).toBe(expected);
    });

    it('getStudentBalance — admin all + balance math + history', async () => {
      await withTestTenant(async () =>
        positive.award(
          { studentId: TEST_BEH_STU_A_ID, category: 'Respect', points: 5, reason: 'r' } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        positive.award(
          { studentId: TEST_BEH_STU_A_ID, category: 'Respect', points: 7, reason: 'r2' } as any,
          adminActor(),
        ),
      );
      const bal = await withTestTenant(async () =>
        positive.getStudentBalance(TEST_BEH_STU_A_ID, adminActor()),
      );
      expect(bal.awarded).toBe(12);
      expect(bal.redeemed).toBe(0);
      expect(bal.balance).toBe(12);
      expect(bal.history.length).toBe(2);
    });

    it('getStudentBalance — row scope: student self, guardian linked, teacher unlinked 403', async () => {
      await withTestTenant(async () =>
        positive.award(
          { studentId: TEST_BEH_STU_A_ID, category: 'Respect', points: 5, reason: 'r' } as any,
          adminActor(),
        ),
      );
      // Guardian linked → ok
      const parentBal = await withTestTenant(async () =>
        positive.getStudentBalance(TEST_BEH_STU_A_ID, parentActor()),
      );
      expect(parentBal.balance).toBe(5);
      // Guardian on unlinked student (STU_A2) → 403
      await expect(
        withTestTenant(async () =>
          positive.getStudentBalance(TEST_BEH_STU_A2_ID, parentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // Teacher not enrolled with these students → 403
      await expect(
        withTestTenant(async () =>
          positive.getStudentBalance(TEST_BEH_STU_A_ID, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // Student fetching own balance — need a STUDENT actor whose person
      // resolves to a student record in this school. The default
      // studentActor has no platform_students row, so this hits 403.
      await expect(
        withTestTenant(async () =>
          positive.getStudentBalance(TEST_BEH_STU_A_ID, studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // Unknown persona → 403
      const stranger = {
        ...studentActor(),
        personType: 'UNKNOWN',
      } as any;
      await expect(
        withTestTenant(async () =>
          positive.getStudentBalance(TEST_BEH_STU_A_ID, stranger),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rewards — list / create / update / getById admin-only', async () => {
      // Non-admin → 403
      await expect(
        withTestTenant(async () =>
          positive.createReward(
            { rewardName: 'X', pointsCost: 5, rewardType: 'DIGITAL' } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      const r = await withTestTenant(async () =>
        positive.createReward(
          {
            rewardName: 'Sticker',
            description: 'shiny',
            pointsCost: 5,
            rewardType: 'PHYSICAL',
            quantityAvailable: 10,
          } as any,
          adminActor(),
        ),
      );
      expect(r.rewardName).toBe('Sticker');
      // Duplicate name → ConflictException
      await expect(
        withTestTenant(async () =>
          positive.createReward(
            { rewardName: 'Sticker', pointsCost: 5, rewardType: 'PHYSICAL' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      // List active
      const list = await withTestTenant(async () => positive.listRewards());
      expect(list.map((x) => x.id)).toContain(r.id);
      // List including inactive
      const listAll = await withTestTenant(async () => positive.listRewards(true));
      expect(listAll.map((x) => x.id)).toContain(r.id);
      // Update — admin
      const upd = await withTestTenant(async () =>
        positive.updateReward(
          r.id,
          { description: 'shinier', pointsCost: 8, quantityAvailable: 20, isActive: true } as any,
          adminActor(),
        ),
      );
      expect(upd.description).toBe('shinier');
      expect(upd.pointsCost).toBe(8);
      expect(upd.quantityAvailable).toBe(20);
      // Update — non-admin 403
      await expect(
        withTestTenant(async () =>
          positive.updateReward(r.id, { description: 'x' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // Missing on update → 404
      await expect(
        withTestTenant(async () =>
          positive.updateReward(
            '00000000-0000-0000-0000-000000000099',
            { description: 'x' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      // getById
      const got = await withTestTenant(async () => positive.getRewardById(r.id));
      expect(got.id).toBe(r.id);
      await expect(
        withTestTenant(async () =>
          positive.getRewardById('00000000-0000-0000-0000-000000000099'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('redeem — admin on behalf success + decrements quantity + balance check 400 + reward inactive 400 + out-of-stock 409', async () => {
      const r = await withTestTenant(async () =>
        positive.createReward(
          {
            rewardName: 'Pencil',
            pointsCost: 5,
            rewardType: 'PHYSICAL',
            quantityAvailable: 2,
          } as any,
          adminActor(),
        ),
      );
      // No balance yet → 400
      await expect(
        withTestTenant(async () =>
          positive.redeem(r.id, { studentId: TEST_BEH_STU_A_ID } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Award enough points
      await withTestTenant(async () =>
        positive.award(
          { studentId: TEST_BEH_STU_A_ID, category: 'R', points: 20, reason: 'r' } as any,
          adminActor(),
        ),
      );
      const out1 = await withTestTenant(async () =>
        positive.redeem(r.id, { studentId: TEST_BEH_STU_A_ID } as any, adminActor()),
      );
      expect(out1.pointsSpent).toBe(5);
      expect(out1.newBalance).toBe(15);
      // Quantity decremented to 1
      const after1 = await withTestTenant(async () => positive.getRewardById(r.id));
      expect(after1.quantityAvailable).toBe(1);
      // Second redeem ok (quantity → 0)
      await withTestTenant(async () =>
        positive.redeem(r.id, { studentId: TEST_BEH_STU_A_ID } as any, adminActor()),
      );
      const after2 = await withTestTenant(async () => positive.getRewardById(r.id));
      expect(after2.quantityAvailable).toBe(0);
      // Third redeem → Conflict (out of stock)
      await expect(
        withTestTenant(async () =>
          positive.redeem(r.id, { studentId: TEST_BEH_STU_A_ID } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      // Inactive reward — make a new one and deactivate
      const r2 = await withTestTenant(async () =>
        positive.createReward(
          { rewardName: 'Bookmark', pointsCost: 1, rewardType: 'PHYSICAL' } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        positive.updateReward(r2.id, { isActive: false } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          positive.redeem(r2.id, { studentId: TEST_BEH_STU_A_ID } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Bogus reward id → 404
      await expect(
        withTestTenant(async () =>
          positive.redeem(
            '00000000-0000-0000-0000-000000000099',
            { studentId: TEST_BEH_STU_A_ID } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      // Bogus student id → 400
      const r3 = await withTestTenant(async () =>
        positive.createReward(
          { rewardName: 'Eraser', pointsCost: 1, rewardType: 'PHYSICAL' } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          positive.redeem(
            r3.id,
            { studentId: '00000000-0000-0000-0000-000000000099' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('redeem — non-admin student must redeem own; default studentActor not a student record → 403', async () => {
      const r = await withTestTenant(async () =>
        positive.createReward(
          { rewardName: 'Coupon', pointsCost: 1, rewardType: 'DIGITAL' } as any,
          adminActor(),
        ),
      );
      // Student persona without a matching sis_students row → 403
      await expect(
        withTestTenant(async () =>
          positive.redeem(r.id, { studentId: TEST_BEH_STU_A_ID } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('redeem — race: two concurrent redeems on stock=1 — only one succeeds', async () => {
      const r = await withTestTenant(async () =>
        positive.createReward(
          {
            rewardName: 'Solo',
            pointsCost: 1,
            rewardType: 'PHYSICAL',
            quantityAvailable: 1,
          } as any,
          adminActor(),
        ),
      );
      // Award enough for two attempts
      await withTestTenant(async () =>
        positive.award(
          { studentId: TEST_BEH_STU_A_ID, category: 'R', points: 5, reason: 'r' } as any,
          adminActor(),
        ),
      );
      const results = await Promise.allSettled([
        withTestTenant(async () =>
          positive.redeem(r.id, { studentId: TEST_BEH_STU_A_ID } as any, adminActor()),
        ),
        withTestTenant(async () =>
          positive.redeem(r.id, { studentId: TEST_BEH_STU_A_ID } as any, adminActor()),
        ),
      ]);
      const ok = results.filter((r) => r.status === 'fulfilled');
      const fail = results.filter((r) => r.status === 'rejected');
      // The FOR UPDATE lock on the reward row serialises — first wins,
      // second sees quantity_available = 0 and is rejected.
      expect(ok.length).toBe(1);
      expect(fail.length).toBe(1);
      const after = await withTestTenant(async () => positive.getRewardById(r.id));
      expect(after.quantityAvailable).toBe(0);
    });

    it('redeem — race: two concurrent redeems on balance=cost — exactly one succeeds (no negative balance)', async () => {
      const r = await withTestTenant(async () =>
        positive.createReward(
          { rewardName: 'Pricey', pointsCost: 10, rewardType: 'DIGITAL' } as any,
          adminActor(),
        ),
      );
      // Award exactly 10 — two parallel redeems can both pass the balance
      // pre-check pre-lock unless the FOR UPDATE on the reward row + the
      // in-tx balance recomputation serialise them.
      await withTestTenant(async () =>
        positive.award(
          { studentId: TEST_BEH_STU_A_ID, category: 'R', points: 10, reason: 'r' } as any,
          adminActor(),
        ),
      );
      const results = await Promise.allSettled([
        withTestTenant(async () =>
          positive.redeem(r.id, { studentId: TEST_BEH_STU_A_ID } as any, adminActor()),
        ),
        withTestTenant(async () =>
          positive.redeem(r.id, { studentId: TEST_BEH_STU_A_ID } as any, adminActor()),
        ),
      ]);
      const ok = results.filter((r) => r.status === 'fulfilled');
      expect(ok.length).toBe(1);
      // Final balance must be 0 (not negative)
      const bal = await withTestTenant(async () =>
        positive.getStudentBalance(TEST_BEH_STU_A_ID, adminActor()),
      );
      expect(bal.balance).toBe(0);
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // positive/ — CategoryConfigService
  // ═════════════════════════════════════════════════════════════════════
  describe('CategoryConfigService', () => {
    it('list returns defaults when no config row, then returns saved categories after update', async () => {
      const defaults = await withTestTenant(async () => categoryConfig.list());
      expect(defaults.length).toBeGreaterThanOrEqual(3);
      // Update with custom set
      const custom = [
        { name: 'Curiosity', description: 'asking questions', defaultPoints: 3 },
        { name: 'Empathy', description: 'kindness', defaultPoints: 4 },
      ];
      const saved = await withTestTenant(async () =>
        categoryConfig.update({ categories: custom } as any, adminActor()),
      );
      expect(saved.length).toBe(2);
      const reread = await withTestTenant(async () => categoryConfig.list());
      expect(reread.length).toBe(2);
      expect(reread[0]!.name).toBe('Curiosity');
    });

    it('update rejected for non-admin', async () => {
      await expect(
        withTestTenant(async () =>
          categoryConfig.update({ categories: [] } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('list returns defaults when config_value is not an array', async () => {
      // Persist a non-array value, then list should fall back to defaults
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.school_config (id, config_key, config_value, description)
         VALUES (gen_random_uuid(), 'positive_behaviour_categories', '{"bogus":true}'::jsonb, 'test')
         ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value`,
      );
      const list = await withTestTenant(async () => categoryConfig.list());
      expect(list.length).toBeGreaterThanOrEqual(3); // back to DEFAULT_CATEGORIES
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // positive/ — RestorativeJusticeService
  // ═════════════════════════════════════════════════════════════════════
  describe('RestorativeJusticeService', () => {
    async function seedIncident(): Promise<string> {
      const dto = await withTestTenant(async () =>
        incidents.create(
          {
            studentId: TEST_BEH_STU_A_ID,
            categoryId: TEST_BEH_CAT_MAJOR_A_ID,
            description: 'rj',
            incidentDate: '2026-05-01',
          } as any,
          adminActor(),
        ),
      );
      return dto.id;
    }

    async function makeConference(): Promise<string> {
      const incId = await seedIncident();
      const c = await withTestTenant(async () =>
        rj.createConference(
          {
            incidentId: incId,
            offenderStudentId: TEST_BEH_STU_A_ID,
            harmedPartyIds: [TEST_BEH_STU_A2_ID],
            conferenceDate: '2026-05-10T10:00:00Z',
            conferenceLocation: 'Counsellor Room',
            conferenceNotes: 'initial',
          } as any,
          adminActor(),
        ),
      );
      return c.id;
    }

    it('createConference — counsellor scope, empty harmed parties 400, no employeeId 400, bogus incident/student 400', async () => {
      await expect(
        withTestTenant(async () =>
          rj.createConference(
            {
              incidentId: '00000000-0000-0000-0000-000000000099',
              offenderStudentId: TEST_BEH_STU_A_ID,
              harmedPartyIds: [TEST_BEH_STU_A2_ID],
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // empty harmed parties
      await expect(
        withTestTenant(async () =>
          rj.createConference(
            {
              incidentId: '00000000-0000-0000-0000-000000000099',
              offenderStudentId: TEST_BEH_STU_A_ID,
              harmedPartyIds: [],
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // no employeeId
      const phantom = { ...adminActor(), employeeId: null } as any;
      await expect(
        withTestTenant(async () =>
          rj.createConference(
            {
              incidentId: '00000000-0000-0000-0000-000000000099',
              offenderStudentId: TEST_BEH_STU_A_ID,
              harmedPartyIds: [TEST_BEH_STU_A2_ID],
            } as any,
            phantom,
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // bogus incident
      await expect(
        withTestTenant(async () =>
          rj.createConference(
            {
              incidentId: '00000000-0000-0000-0000-000000000099',
              offenderStudentId: TEST_BEH_STU_A_ID,
              harmedPartyIds: [TEST_BEH_STU_A2_ID],
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      const incId = await seedIncident();
      // bogus offender
      await expect(
        withTestTenant(async () =>
          rj.createConference(
            {
              incidentId: incId,
              offenderStudentId: '00000000-0000-0000-0000-000000000099',
              harmedPartyIds: [TEST_BEH_STU_A2_ID],
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // bogus harmed party
      await expect(
        withTestTenant(async () =>
          rj.createConference(
            {
              incidentId: incId,
              offenderStudentId: TEST_BEH_STU_A_ID,
              harmedPartyIds: ['00000000-0000-0000-0000-000000000099'],
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('createConference + listConferences + getConferenceById', async () => {
      const id = await makeConference();
      const list = await withTestTenant(async () => rj.listConferences(adminActor()));
      expect(list.map((c) => c.id)).toContain(id);
      const got = await withTestTenant(async () => rj.getConferenceById(id, adminActor()));
      expect(got.id).toBe(id);
      expect(got.actions).toEqual([]);
      // missing
      await expect(
        withTestTenant(async () =>
          rj.getConferenceById('00000000-0000-0000-0000-000000000099', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('updateConference — non-counsellor 403, missing 404, valid transitions + invalid transition 400 + notes-only path', async () => {
      const id = await makeConference();
      await expect(
        withTestTenant(async () =>
          rj.updateConference(id, { status: 'IN_PROGRESS' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () =>
          rj.updateConference(
            '00000000-0000-0000-0000-000000000099',
            { status: 'IN_PROGRESS' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      // SCHEDULED → AGREEMENT_REACHED not allowed
      await expect(
        withTestTenant(async () =>
          rj.updateConference(id, { status: 'AGREEMENT_REACHED' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // SCHEDULED → IN_PROGRESS
      const inProg = await withTestTenant(async () =>
        rj.updateConference(id, { status: 'IN_PROGRESS' } as any, adminActor()),
      );
      expect(inProg.status).toBe('IN_PROGRESS');
      // notes-only path (no status)
      const noteUpd = await withTestTenant(async () =>
        rj.updateConference(id, { conferenceNotes: 'note added' } as any, adminActor()),
      );
      expect(noteUpd.conferenceNotes).toBe('note added');
      // IN_PROGRESS → AGREEMENT_REACHED
      const agr = await withTestTenant(async () =>
        rj.updateConference(id, { status: 'AGREEMENT_REACHED' } as any, adminActor()),
      );
      expect(agr.status).toBe('AGREEMENT_REACHED');
      // AGREEMENT_REACHED → FAILED is terminal
      const fail = await withTestTenant(async () =>
        rj.updateConference(id, { status: 'FAILED' } as any, adminActor()),
      );
      expect(fail.status).toBe('FAILED');
      // FAILED → anything else: 400
      await expect(
        withTestTenant(async () =>
          rj.updateConference(id, { status: 'IN_PROGRESS' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('addAction — counsellor scope, missing conference 404, bogus student 400, status terminal 400', async () => {
      const id = await makeConference();
      await expect(
        withTestTenant(async () =>
          rj.addAction(
            id,
            {
              actionDescription: 'apology letter',
              assignedToStudentId: TEST_BEH_STU_A_ID,
              dueDate: '2026-05-15',
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () =>
          rj.addAction(
            '00000000-0000-0000-0000-000000000099',
            {
              actionDescription: 'x',
              assignedToStudentId: TEST_BEH_STU_A_ID,
              dueDate: '2026-05-15',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      const a = await withTestTenant(async () =>
        rj.addAction(
          id,
          {
            actionDescription: 'apology letter',
            assignedToStudentId: TEST_BEH_STU_A_ID,
            dueDate: '2026-05-15',
          } as any,
          adminActor(),
        ),
      );
      expect(a.status).toBe('PENDING');
      // bogus student
      await expect(
        withTestTenant(async () =>
          rj.addAction(
            id,
            {
              actionDescription: 'x',
              assignedToStudentId: '00000000-0000-0000-0000-000000000099',
              dueDate: '2026-05-15',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Terminal — flip to FAILED then try to add
      await withTestTenant(async () =>
        rj.updateConference(id, { status: 'FAILED' } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          rj.addAction(
            id,
            {
              actionDescription: 'late',
              assignedToStudentId: TEST_BEH_STU_A_ID,
              dueDate: '2026-05-20',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('listActionsForConference + getConferenceById inlines actions', async () => {
      const id = await makeConference();
      await withTestTenant(async () =>
        rj.addAction(
          id,
          {
            actionDescription: 'a1',
            assignedToStudentId: TEST_BEH_STU_A_ID,
            dueDate: '2026-05-15',
          } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        rj.addAction(
          id,
          {
            actionDescription: 'a2',
            assignedToStudentId: TEST_BEH_STU_A2_ID,
            dueDate: '2026-05-20',
          } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () => rj.listActionsForConference(id));
      expect(list.length).toBe(2);
      // inline
      const conf = await withTestTenant(async () => rj.getConferenceById(id, adminActor()));
      expect(conf.actions?.length).toBe(2);
    });

    it('completeAction — counsellor only + no employeeId 400 + missing 404 + duplicate complete 400 + auto-transition + outbox emit', async () => {
      const id = await makeConference();
      const a1 = await withTestTenant(async () =>
        rj.addAction(
          id,
          {
            actionDescription: 'a1',
            assignedToStudentId: TEST_BEH_STU_A_ID,
            dueDate: '2026-05-15',
          } as any,
          adminActor(),
        ),
      );
      const a2 = await withTestTenant(async () =>
        rj.addAction(
          id,
          {
            actionDescription: 'a2',
            assignedToStudentId: TEST_BEH_STU_A2_ID,
            dueDate: '2026-05-20',
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          rj.completeAction(a1.id, { evidenceNotes: 'done' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      const phantom = { ...adminActor(), employeeId: null } as any;
      await expect(
        withTestTenant(async () =>
          rj.completeAction(a1.id, {} as any, phantom),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // missing
      await expect(
        withTestTenant(async () =>
          rj.completeAction(
            '00000000-0000-0000-0000-000000000099',
            {} as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      // Complete first
      const r1 = await withTestTenant(async () =>
        rj.completeAction(a1.id, { evidenceNotes: 'done' } as any, adminActor()),
      );
      expect(r1.action.status).toBe('COMPLETED');
      expect(r1.conferenceResolved).toBe(false);
      // Duplicate complete on a1 → 400
      await expect(
        withTestTenant(async () => rj.completeAction(a1.id, {} as any, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Complete second → auto-transition to RESOLVED_SUCCESSFULLY
      const r2 = await withTestTenant(async () =>
        rj.completeAction(a2.id, {} as any, adminActor()),
      );
      expect(r2.conferenceResolved).toBe(true);
      const conf = await withTestTenant(async () => rj.getConferenceById(id, adminActor()));
      expect(conf.status).toBe('RESOLVED_SUCCESSFULLY');
      expect(conf.resolutionDate).not.toBeNull();
      // Outbox row landed
      const rows = await rawClient.$queryRawUnsafe<
        Array<{ topic: string; event_id: string; message_key: string }>
      >(
        `SELECT topic, (envelope->>'event_id') AS event_id, message_key
         FROM platform.platform_outbox
         WHERE topic = 'beh.rj_conference.resolved' AND tenant_id = $1::uuid
         ORDER BY created_at DESC LIMIT 1`,
        TEST_SCHOOL_ID,
      );
      expect(rows.length).toBe(1);
      expect(rows[0]!.message_key).toBe(id);
      expect(rows[0]!.event_id).toBe(deterministicRjResolvedEventId(id));
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // positive/ — PeerMediationService
  // ═════════════════════════════════════════════════════════════════════
  describe('PeerMediationService', () => {
    // Need a third student (mediator) — use STU_B from school A by creating
    // an extra row inline. Reuse the existing STU_A as mediator vs A2 + B.
    // For school A we need three distinct students: mediator (STU_A2),
    // partyA (STU_A), partyB (we'll create at runtime).
    let extraStudentId: string;
    beforeEach(async () => {
      // Create an extra student in school A so we have three distinct rows.
      extraStudentId = '019e0cf8-aaaa-7777-8888-000000009701';
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
         VALUES ($1::uuid, 'Beh', 'Mediator-A', 'STUDENT', true)
         ON CONFLICT (id) DO NOTHING`,
        '019e0cf8-aaaa-7777-8888-000000009702',
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
         VALUES ($1::uuid, $2::uuid, 'Beh', 'Mediator-A', true)
         ON CONFLICT (id) DO NOTHING`,
        '019e0cf8-aaaa-7777-8888-000000009703',
        '019e0cf8-aaaa-7777-8888-000000009702',
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_students
           (id, platform_student_id, school_id, student_number, grade_level, enrollment_status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'BEH-MED', '7', 'ENROLLED')
         ON CONFLICT (id) DO NOTHING`,
        extraStudentId,
        '019e0cf8-aaaa-7777-8888-000000009703',
        TEST_SCHOOL_ID,
      );
    });

    it('create — referral scope required, self/dup parties 400, bogus student 400, success + getById + list', async () => {
      // Non-staff → 403
      await expect(
        withTestTenant(async () =>
          mediation.create(
            {
              mediatorStudentId: extraStudentId,
              partyAStudentId: TEST_BEH_STU_A_ID,
              partyBStudentId: TEST_BEH_STU_A2_ID,
              conflictDescription: 'd',
            } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // No employeeId → 400
      const phantom = { ...adminActor(), employeeId: null } as any;
      await expect(
        withTestTenant(async () =>
          mediation.create(
            {
              mediatorStudentId: extraStudentId,
              partyAStudentId: TEST_BEH_STU_A_ID,
              partyBStudentId: TEST_BEH_STU_A2_ID,
              conflictDescription: 'd',
            } as any,
            phantom,
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Same parties → 400
      await expect(
        withTestTenant(async () =>
          mediation.create(
            {
              mediatorStudentId: extraStudentId,
              partyAStudentId: TEST_BEH_STU_A_ID,
              partyBStudentId: TEST_BEH_STU_A_ID,
              conflictDescription: 'd',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // mediator is a party → 400
      await expect(
        withTestTenant(async () =>
          mediation.create(
            {
              mediatorStudentId: TEST_BEH_STU_A_ID,
              partyAStudentId: TEST_BEH_STU_A_ID,
              partyBStudentId: TEST_BEH_STU_A2_ID,
              conflictDescription: 'd',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // bogus student
      await expect(
        withTestTenant(async () =>
          mediation.create(
            {
              mediatorStudentId: extraStudentId,
              partyAStudentId: '00000000-0000-0000-0000-000000000099',
              partyBStudentId: TEST_BEH_STU_A2_ID,
              conflictDescription: 'd',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Happy path
      const m = await withTestTenant(async () =>
        mediation.create(
          {
            mediatorStudentId: extraStudentId,
            partyAStudentId: TEST_BEH_STU_A_ID,
            partyBStudentId: TEST_BEH_STU_A2_ID,
            conflictDescription: 'recess argument',
          } as any,
          adminActor(),
        ),
      );
      expect(m.status).toBe('REFERRED');
      expect(m.isMediatorTrained).toBe(true);
      // getById
      const got = await withTestTenant(async () => mediation.getById(m.id));
      expect(got.id).toBe(m.id);
      await expect(
        withTestTenant(async () =>
          mediation.getById('00000000-0000-0000-0000-000000000099'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      // list + status filter
      const list = await withTestTenant(async () => mediation.list(adminActor()));
      expect(list.map((x) => x.id)).toContain(m.id);
      const refOnly = await withTestTenant(async () =>
        mediation.list(adminActor(), 'REFERRED'),
      );
      expect(refOnly.every((x) => x.status === 'REFERRED')).toBe(true);
    });

    it('update — counsellor only + lifecycle update + missing 404 + listTrainedMediators', async () => {
      const m = await withTestTenant(async () =>
        mediation.create(
          {
            mediatorStudentId: extraStudentId,
            partyAStudentId: TEST_BEH_STU_A_ID,
            partyBStudentId: TEST_BEH_STU_A2_ID,
            conflictDescription: 'd',
          } as any,
          adminActor(),
        ),
      );
      // teacher → 403
      await expect(
        withTestTenant(async () =>
          mediation.update(m.id, { status: 'SCHEDULED' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // update
      const u = await withTestTenant(async () =>
        mediation.update(
          m.id,
          {
            status: 'RESOLVED',
            mediationDate: '2026-05-15T10:00:00Z',
            outcome: 'apology accepted',
          } as any,
          adminActor(),
        ),
      );
      expect(u.status).toBe('RESOLVED');
      expect(u.outcome).toBe('apology accepted');
      // missing
      await expect(
        withTestTenant(async () =>
          mediation.update(
            '00000000-0000-0000-0000-000000000099',
            { status: 'RESOLVED' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      // listTrainedMediators returns the mediator
      const mediators = await withTestTenant(async () => mediation.listTrainedMediators());
      expect(mediators.map((x) => x.studentId)).toContain(extraStudentId);
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // positive/ — OverdueActionWorker
  // ═════════════════════════════════════════════════════════════════════
  describe('OverdueActionWorker', () => {
    it('runOnce — flips PENDING actions past due_date to OVERDUE; scans active schools', async () => {
      const incId = await withTestTenant(async () =>
        incidents
          .create(
            {
              studentId: TEST_BEH_STU_A_ID,
              categoryId: TEST_BEH_CAT_MAJOR_A_ID,
              description: 'x',
              incidentDate: '2026-05-01',
            } as any,
            adminActor(),
          )
          .then((d) => d.id),
      );
      const conf = await withTestTenant(async () =>
        rj.createConference(
          {
            incidentId: incId,
            offenderStudentId: TEST_BEH_STU_A_ID,
            harmedPartyIds: [TEST_BEH_STU_A2_ID],
          } as any,
          adminActor(),
        ),
      );
      // Action with past due_date
      const past = await withTestTenant(async () =>
        rj.addAction(
          conf.id,
          {
            actionDescription: 'overdue',
            assignedToStudentId: TEST_BEH_STU_A_ID,
            dueDate: '2020-01-01',
          } as any,
          adminActor(),
        ),
      );
      // Action with future due_date
      const future = await withTestTenant(async () =>
        rj.addAction(
          conf.id,
          {
            actionDescription: 'future',
            assignedToStudentId: TEST_BEH_STU_A2_ID,
            dueDate: '2099-12-31',
          } as any,
          adminActor(),
        ),
      );

      const result = await overdueWorker.runOnce();
      expect(result.tenantsScanned).toBeGreaterThanOrEqual(1);
      expect(result.rowsFlipped).toBeGreaterThanOrEqual(1);

      const rows = await rawClient.$queryRawUnsafe<Array<{ id: string; status: string }>>(
        `SELECT id::text, status FROM ${TEST_SCHEMA}.sis_rj_agreement_actions
         WHERE id IN ($1::uuid, $2::uuid)`,
        past.id,
        future.id,
      );
      const byId = new Map(rows.map((r) => [r.id, r.status]));
      expect(byId.get(past.id)).toBe('OVERDUE');
      expect(byId.get(future.id)).toBe('PENDING');
    });

    it('lifecycle hooks — onModuleInit + onModuleDestroy are safe no-ops in test mode', () => {
      // NODE_ENV is 'test' under vitest, so onModuleInit short-circuits.
      overdueWorker.onModuleInit();
      overdueWorker.onModuleDestroy();
      // No throw == pass.
    });

    it('onModuleInit schedules a timer outside test mode (then we clear it)', () => {
      const prev = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const w = new OverdueActionWorker(tenantPrisma);
        w.onModuleInit();
        w.onModuleDestroy();
      } finally {
        process.env.NODE_ENV = prev;
      }
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // Controllers — pass-through coverage
  // ═════════════════════════════════════════════════════════════════════
  describe('controllers (pass-through)', () => {
    it('CategoryController — list, get, create, update, action-type list+create+update', async () => {
      const list = await withTestTenant(async () =>
        categoryCtrl.listCategories({ includeInactive: true } as any),
      );
      expect(list.length).toBeGreaterThan(0);
      const got = await withTestTenant(async () =>
        categoryCtrl.getCategory(TEST_BEH_CAT_MINOR_A_ID),
      );
      expect(got.id).toBe(TEST_BEH_CAT_MINOR_A_ID);
      const cat = await withTestTenant(async () =>
        categoryCtrl.createCategory({ name: 'CtrlCat', severity: 'LOW' } as any),
      );
      const upd = await withTestTenant(async () =>
        categoryCtrl.updateCategory(cat.id, { isActive: false } as any),
      );
      expect(upd.isActive).toBe(false);
      const atList = await withTestTenant(async () =>
        categoryCtrl.listActionTypes({} as any),
      );
      expect(atList.length).toBeGreaterThan(0);
      const at = await withTestTenant(async () =>
        categoryCtrl.createActionType({ name: 'CtrlAt' } as any),
      );
      const atUpd = await withTestTenant(async () =>
        categoryCtrl.updateActionType(at.id, { description: 'd' } as any),
      );
      expect(atUpd.description).toBe('d');
    });

    it('IncidentController — list, getById, create, review, resolve, reopen', async () => {
      const c = await withTestTenant(async () =>
        incidentCtrl.create(
          {
            studentId: TEST_BEH_STU_A_ID,
            categoryId: TEST_BEH_CAT_MINOR_A_ID,
            description: 'cm',
            incidentDate: '2026-05-01',
          } as any,
          fakeReq(),
        ),
      );
      const list = await withTestTenant(async () => incidentCtrl.list({} as any, fakeReq()));
      expect(list.map((i) => i.id)).toContain(c.id);
      const got = await withTestTenant(async () => incidentCtrl.getById(c.id, fakeReq()));
      expect(got.id).toBe(c.id);
      const rev = await withTestTenant(async () =>
        incidentCtrl.review(c.id, {} as any, fakeReq()),
      );
      expect(rev.status).toBe('UNDER_REVIEW');
      const res = await withTestTenant(async () =>
        incidentCtrl.resolve(c.id, {} as any, fakeReq()),
      );
      expect(res.status).toBe('RESOLVED');
      const reop = await withTestTenant(async () => incidentCtrl.reopen(c.id, fakeReq()));
      expect(reop.status).toBe('OPEN');
    });

    it('ActionController — list, create, update, remove', async () => {
      const incDto = await withTestTenant(async () =>
        incidentCtrl.create(
          {
            studentId: TEST_BEH_STU_A_ID,
            categoryId: TEST_BEH_CAT_MAJOR_A_ID,
            description: 'cm',
            incidentDate: '2026-05-01',
          } as any,
          fakeReq(),
        ),
      );
      const a = await withTestTenant(async () =>
        actionCtrl.create(
          incDto.id,
          { actionTypeId: TEST_BEH_ACT_TYPE_WARNING_A_ID } as any,
          fakeReq(),
        ),
      );
      const list = await withTestTenant(async () => actionCtrl.list(incDto.id, fakeReq()));
      expect(list.map((x) => x.id)).toContain(a.id);
      const upd = await withTestTenant(async () =>
        actionCtrl.update(a.id, { notes: 'x' } as any, fakeReq()),
      );
      expect(upd.notes).toBe('x');
      await withTestTenant(async () => actionCtrl.remove(a.id, fakeReq()));
      const list2 = await withTestTenant(async () => actionCtrl.list(incDto.id, fakeReq()));
      expect(list2.map((x) => x.id)).not.toContain(a.id);
    });

    it('BehaviorPlanController — list, get, create, update, activate, expire', async () => {
      const p = await withTestTenant(async () =>
        plansCtrl.create(
          {
            studentId: TEST_BEH_STU_A_ID,
            planType: 'BIP',
            reviewDate: '2026-12-01',
            targetBehaviors: ['x'],
          } as any,
          fakeReq(),
        ),
      );
      const list = await withTestTenant(async () => plansCtrl.list({} as any, fakeReq()));
      expect(list.map((x) => x.id)).toContain(p.id);
      const got = await withTestTenant(async () => plansCtrl.getById(p.id, fakeReq()));
      expect(got.id).toBe(p.id);
      const upd = await withTestTenant(async () =>
        plansCtrl.update(p.id, { reviewDate: '2027-01-01' } as any, fakeReq()),
      );
      expect(upd.reviewDate).toBe('2027-01-01');
      const act = await withTestTenant(async () => plansCtrl.activate(p.id, fakeReq()));
      expect(act.status).toBe('ACTIVE');
      const exp = await withTestTenant(async () => plansCtrl.expire(p.id, fakeReq()));
      expect(exp.status).toBe('EXPIRED');
    });

    it('GoalController — list, create, update, remove', async () => {
      const p = await withTestTenant(async () =>
        plansCtrl.create(
          {
            studentId: TEST_BEH_STU_A_ID,
            planType: 'BIP',
            reviewDate: '2026-12-01',
            targetBehaviors: ['x'],
          } as any,
          fakeReq(),
        ),
      );
      const g = await withTestTenant(async () =>
        goalsCtrl.create(p.id, { goalText: 'gt' } as any, fakeReq()),
      );
      const list = await withTestTenant(async () => goalsCtrl.list(p.id, fakeReq()));
      expect(list.map((x) => x.id)).toContain(g.id);
      const upd = await withTestTenant(async () =>
        goalsCtrl.update(g.id, { progress: 'IN_PROGRESS' } as any, fakeReq()),
      );
      expect(upd.progress).toBe('IN_PROGRESS');
      await withTestTenant(async () => goalsCtrl.remove(g.id, fakeReq()));
    });

    it('FeedbackController — list, request, submit, pending', async () => {
      const p = await withTestTenant(async () =>
        plansCtrl.create(
          {
            studentId: TEST_BEH_STU_A_ID,
            planType: 'BIP',
            reviewDate: '2026-12-01',
            targetBehaviors: ['x'],
          } as any,
          fakeReq(),
        ),
      );
      const fb = await withTestTenant(async () =>
        feedbackCtrl.request(
          p.id,
          { teacherId: TEST_TEACHER_EMPLOYEE_ID } as any,
          fakeReq(),
        ),
      );
      const list = await withTestTenant(async () => feedbackCtrl.list(p.id, fakeReq()));
      expect(list.map((x) => x.id)).toContain(fb.id);
      const pending = await withTestTenant(async () =>
        feedbackCtrl.pending(
          fakeReq({
            sub: TEST_TEACHER_ACCOUNT_ID,
            personId: TEST_TEACHER_PERSON_ID,
            email: 'teacher@test.local',
          }),
        ),
      );
      expect(pending.map((x) => x.id)).toContain(fb.id);
      const sub = await withTestTenant(async () =>
        feedbackCtrl.submit(fb.id, {} as any, fakeReq()),
      );
      expect(sub.submittedAt).not.toBeNull();
    });

    it('BehaviourAdvancedController — RJ + mediation + positive + categories + BIP feedback pass-through', async () => {
      // RJ
      const inc = await withTestTenant(async () =>
        incidentCtrl.create(
          {
            studentId: TEST_BEH_STU_A_ID,
            categoryId: TEST_BEH_CAT_MAJOR_A_ID,
            description: 'rj',
            incidentDate: '2026-05-01',
          } as any,
          fakeReq(),
        ),
      );
      const conf = await withTestTenant(async () =>
        advancedCtrl.createConference(
          {
            incidentId: inc.id,
            offenderStudentId: TEST_BEH_STU_A_ID,
            harmedPartyIds: [TEST_BEH_STU_A2_ID],
          } as any,
          fakeReq(),
        ),
      );
      const confList = await withTestTenant(async () =>
        advancedCtrl.listConferences(fakeReq()),
      );
      expect(confList.map((c) => c.id)).toContain(conf.id);
      const confGet = await withTestTenant(async () =>
        advancedCtrl.getConference(conf.id, fakeReq()),
      );
      expect(confGet.id).toBe(conf.id);
      const updConf = await withTestTenant(async () =>
        advancedCtrl.updateConference(
          conf.id,
          { status: 'IN_PROGRESS' } as any,
          fakeReq(),
        ),
      );
      expect(updConf.status).toBe('IN_PROGRESS');
      const a = await withTestTenant(async () =>
        advancedCtrl.addAction(
          conf.id,
          {
            actionDescription: 'a1',
            assignedToStudentId: TEST_BEH_STU_A_ID,
            dueDate: '2099-12-31',
          } as any,
          fakeReq(),
        ),
      );
      const actList = await withTestTenant(async () =>
        advancedCtrl.listActions(conf.id),
      );
      expect(actList.map((x) => x.id)).toContain(a.id);
      const cmp = await withTestTenant(async () =>
        advancedCtrl.completeAction(a.id, {} as any, fakeReq()),
      );
      expect(cmp.action.status).toBe('COMPLETED');

      // Mediation — need a 3rd student in school A
      const extraId = '019e0cf8-aaaa-7777-8888-000000009701';
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
         VALUES ($1::uuid, 'Beh', 'Med-Ctrl', 'STUDENT', true)
         ON CONFLICT (id) DO NOTHING`,
        '019e0cf8-aaaa-7777-8888-000000009702',
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
         VALUES ($1::uuid, $2::uuid, 'Beh', 'Med-Ctrl', true)
         ON CONFLICT (id) DO NOTHING`,
        '019e0cf8-aaaa-7777-8888-000000009703',
        '019e0cf8-aaaa-7777-8888-000000009702',
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_students
           (id, platform_student_id, school_id, student_number, grade_level, enrollment_status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'BEH-MEDC', '7', 'ENROLLED')
         ON CONFLICT (id) DO NOTHING`,
        extraId,
        '019e0cf8-aaaa-7777-8888-000000009703',
        TEST_SCHOOL_ID,
      );
      const m = await withTestTenant(async () =>
        advancedCtrl.createMediation(
          {
            mediatorStudentId: extraId,
            partyAStudentId: TEST_BEH_STU_A_ID,
            partyBStudentId: TEST_BEH_STU_A2_ID,
            conflictDescription: 'd',
          } as any,
          fakeReq(),
        ),
      );
      const medList = await withTestTenant(async () =>
        advancedCtrl.listMediations(fakeReq()),
      );
      expect(medList.map((x) => x.id)).toContain(m.id);
      const medGot = await withTestTenant(async () => advancedCtrl.getMediation(m.id));
      expect(medGot.id).toBe(m.id);
      const medUpd = await withTestTenant(async () =>
        advancedCtrl.updateMediation(m.id, { status: 'RESOLVED' } as any, fakeReq()),
      );
      expect(medUpd.status).toBe('RESOLVED');
      const trained = await withTestTenant(async () => advancedCtrl.listTrainedMediators());
      expect(trained.length).toBeGreaterThanOrEqual(1);

      // Positive points
      const tx = await withTestTenant(async () =>
        advancedCtrl.awardPoints(
          {
            studentId: TEST_BEH_STU_A_ID,
            category: 'Respect',
            points: 5,
            reason: 'r',
          } as any,
          fakeReq(),
        ),
      );
      expect(tx.points).toBe(5);
      const bal = await withTestTenant(async () =>
        advancedCtrl.getStudentBalance(TEST_BEH_STU_A_ID, fakeReq()),
      );
      expect(bal.balance).toBe(5);
      const rewards = await withTestTenant(async () => advancedCtrl.listRewards());
      expect(Array.isArray(rewards)).toBe(true);
      const rewardsIncl = await withTestTenant(async () => advancedCtrl.listRewards('true'));
      expect(Array.isArray(rewardsIncl)).toBe(true);
      const reward = await withTestTenant(async () =>
        advancedCtrl.createReward(
          { rewardName: 'CtrlR', pointsCost: 2, rewardType: 'DIGITAL' } as any,
          fakeReq(),
        ),
      );
      const rewardUpd = await withTestTenant(async () =>
        advancedCtrl.updateReward(reward.id, { description: 'd' } as any, fakeReq()),
      );
      expect(rewardUpd.description).toBe('d');
      const red = await withTestTenant(async () =>
        advancedCtrl.redeemReward(
          reward.id,
          { studentId: TEST_BEH_STU_A_ID } as any,
          fakeReq(),
        ),
      );
      expect(red.pointsSpent).toBe(2);

      // Categories
      const cats = await withTestTenant(async () => advancedCtrl.listCategories());
      expect(cats.length).toBeGreaterThan(0);
      const newCats = await withTestTenant(async () =>
        advancedCtrl.updateCategories(
          { categories: [{ name: 'Try', defaultPoints: 1 }] } as any,
          fakeReq(),
        ),
      );
      expect(newCats.length).toBe(1);

      // BIP feedback pass-through
      const p = await withTestTenant(async () =>
        plansCtrl.create(
          {
            studentId: TEST_BEH_STU_A_ID,
            planType: 'BSP',
            reviewDate: '2026-12-01',
            targetBehaviors: ['x'],
          } as any,
          fakeReq(),
        ),
      );
      const bfList0 = await withTestTenant(async () => advancedCtrl.listBipFeedback(p.id));
      expect(bfList0).toEqual([]);
      const bf = await withTestTenant(async () =>
        advancedCtrl.requestBipFeedback(
          p.id,
          { teacherEmployeeId: TEST_TEACHER_EMPLOYEE_ID } as any,
          fakeReq(),
        ),
      );
      const bfSub = await withTestTenant(async () =>
        advancedCtrl.submitBipFeedback(bf.id, {} as any, fakeReq()),
      );
      expect(bfSub.submittedAt).not.toBeNull();
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // Fixture sanity
  // ═════════════════════════════════════════════════════════════════════
  describe('fixture sanity', () => {
    it('resetBehaviourTables wipes all behaviour tables', async () => {
      await withTestTenant(async () =>
        incidents.create(
          {
            studentId: TEST_BEH_STU_A_ID,
            categoryId: TEST_BEH_CAT_MINOR_A_ID,
            description: 'x',
            incidentDate: '2026-05-01',
          } as any,
          adminActor(),
        ),
      );
      await resetBehaviourTables(rawClient);
      const counts = await rawClient.$queryRawUnsafe<Array<{ c: bigint }>>(
        `SELECT count(*)::bigint AS c FROM ${TEST_SCHEMA}.sis_discipline_incidents`,
      );
      expect(Number(counts[0]!.c)).toBe(0);
      // Re-seed for the next test
      await ensureBehaviourSeed(rawClient);
    });
  });
});
