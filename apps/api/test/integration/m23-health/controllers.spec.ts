import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

// Controllers under test
import { HealthRecordController } from '@modules/m23-health/records/health-record.controller';
import { HealthController } from '@modules/m23-health/records/health.controller';
import { ConditionController } from '@modules/m23-health/records/condition.controller';
import { MedicationController } from '@modules/m23-health/records/medication.controller';
import { MedicationScheduleController } from '@modules/m23-health/records/medication-schedule.controller';
import { AdministrationController } from '@modules/m23-health/records/administration.controller';
import { NurseVisitController } from '@modules/m23-health/records/nurse-visit.controller';
import { HealthAccessLogController } from '@modules/m23-health/records/health-access-log.controller';
import { HealthAdvancedController } from '@modules/m23-health/records/health-advanced.controller';
import { DietaryProfileController } from '@modules/m23-health/dietary/dietary-profile.controller';
import { ImmunisationController } from '@modules/m23-health/immunisation/immunisation.controller';
import { IepPlanController } from '@modules/m23-health/iep/iep-plan.controller';
import { ScreeningController } from '@modules/m23-health/screenings/screening.controller';
import { ImmunisationComplianceWorker } from '@modules/m23-health/immunisation/immunisation-compliance.worker';
import { IepAccommodationConsumer } from '@modules/m23-health/iep/iep-accommodation.consumer';
import { IdempotencyService } from '@shared/kafka/idempotency.service';
import type {
  ConsumedMessage,
  KafkaConsumerService,
  MessageHandler,
} from '@shared/kafka/kafka-consumer.service';

// Services
import { HealthRecordService } from '@modules/m23-health/records/health-record.service';
import { HealthAccessLogService } from '@modules/m23-health/records/health-access-log.service';
import { ConditionService } from '@modules/m23-health/records/condition.service';
import { MedicationService } from '@modules/m23-health/records/medication.service';
import { MedicationScheduleService } from '@modules/m23-health/records/medication-schedule.service';
import { AdministrationService } from '@modules/m23-health/records/administration.service';
import { NurseVisitService } from '@modules/m23-health/records/nurse-visit.service';
import { TelehealthProviderService } from '@modules/m23-health/records/telehealth-provider.service';
import { TelehealthSessionService } from '@modules/m23-health/records/telehealth-session.service';
import { DietaryProfileService } from '@modules/m23-health/dietary/dietary-profile.service';
import { ImmunisationService } from '@modules/m23-health/immunisation/immunisation.service';
import { ImmunisationRequirementService } from '@modules/m23-health/immunisation/immunisation-requirement.service';
import { ImmunisationComplianceService } from '@modules/m23-health/immunisation/immunisation-compliance.service';
import { IepPlanService } from '@modules/m23-health/iep/iep-plan.service';
import { ScreeningService } from '@modules/m23-health/screenings/screening.service';
import { ScreeningReferralService } from '@modules/m23-health/screenings/screening-referral.service';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { GuardianAuthorizationService } from '@modules/m00-platform/iam/guardian-authorization.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';
import type { KafkaProducerService } from '@shared/kafka/kafka-producer.service';

import { withTestTenant, TEST_SCHOOL_ID, TEST_SCHEMA } from '../helpers/tenant-context';
import { TEST_ADMIN_ACCOUNT_ID, TEST_ADMIN_PERSON_ID } from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';
import { makeRecordingKafka } from '../helpers/recording-kafka';

/**
 * Controller-layer coverage for m23-health. Each controller is instantiated
 * with real services + a real DB. Tests exercise list/get/create endpoints
 * with synthetic AuthedRequest, plus the ImmunisationComplianceWorker.tick.
 */
describe('integration:m23-health/controllers', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let kafka: KafkaProducerService;
  let outbox: OutboxService;
  let permCheck: PermissionCheckService;
  let actors: ActorContextService;
  let healthRecordCtrl: HealthRecordController;
  let healthCtrl: HealthController;
  let conditionCtrl: ConditionController;
  let medicationCtrl: MedicationController;
  let medScheduleCtrl: MedicationScheduleController;
  let administrationCtrl: AdministrationController;
  let nurseVisitCtrl: NurseVisitController;
  let accessLogCtrl: HealthAccessLogController;
  let healthAdvCtrl: HealthAdvancedController;
  let dietaryCtrl: DietaryProfileController;
  let immunisationCtrl: ImmunisationController;
  let iepCtrl: IepPlanController;
  let screeningCtrl: ScreeningController;
  let worker: ImmunisationComplianceWorker;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    kafka = makeRecordingKafka();
    outbox = new OutboxService();
    permCheck = new PermissionCheckService(rawClient);
    const guardianAuthz = new GuardianAuthorizationService(tenantPrisma);
    actors = new ActorContextService(rawClient, permCheck, tenantPrisma);

    const accessLog = new HealthAccessLogService(tenantPrisma);
    const records = new HealthRecordService(
      tenantPrisma,
      accessLog,
      permCheck,
      guardianAuthz,
      outbox,
    );
    const conditions = new ConditionService(tenantPrisma, accessLog, records);
    const medications = new MedicationService(tenantPrisma, accessLog, records);
    const schedules = new MedicationScheduleService(tenantPrisma, records, medications);
    const administrations = new AdministrationService(
      tenantPrisma,
      accessLog,
      records,
      medications,
      kafka,
    );
    const visits = new NurseVisitService(tenantPrisma, accessLog, records, kafka);
    const providers = new TelehealthProviderService(tenantPrisma, permCheck);
    const sessions = new TelehealthSessionService(tenantPrisma, permCheck, providers, accessLog);
    const dietary = new DietaryProfileService(tenantPrisma, accessLog, records);
    const immunisations = new ImmunisationService(tenantPrisma, accessLog, records);
    const requirements = new ImmunisationRequirementService(tenantPrisma, permCheck);
    const compliance = new ImmunisationComplianceService(
      tenantPrisma,
      permCheck,
      requirements,
      kafka,
    );
    const iepPlans = new IepPlanService(tenantPrisma, accessLog, records, outbox);
    const screenings = new ScreeningService(tenantPrisma, accessLog, records);
    const referrals = new ScreeningReferralService(tenantPrisma, permCheck);

    healthRecordCtrl = new HealthRecordController(records, actors);
    healthCtrl = new HealthController();
    conditionCtrl = new ConditionController(conditions, actors);
    medicationCtrl = new MedicationController(medications, actors);
    medScheduleCtrl = new MedicationScheduleController(schedules, actors);
    administrationCtrl = new AdministrationController(administrations, actors);
    nurseVisitCtrl = new NurseVisitController(visits, actors);
    accessLogCtrl = new HealthAccessLogController(accessLog, actors);
    healthAdvCtrl = new HealthAdvancedController(
      actors,
      providers,
      sessions,
      requirements,
      compliance,
      referrals,
    );
    dietaryCtrl = new DietaryProfileController(dietary, actors);
    immunisationCtrl = new ImmunisationController(immunisations, actors);
    iepCtrl = new IepPlanController(iepPlans, actors);
    screeningCtrl = new ScreeningController(screenings, actors);
    worker = new ImmunisationComplianceWorker(tenantPrisma, compliance);

    // Grant admin sch-001:admin + every health permission.
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache
         (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], now(), 'm23-ctrl-test')
       ON CONFLICT (account_id, scope_id) DO UPDATE
         SET permission_codes = EXCLUDED.permission_codes, computed_at = now()`,
      generateId(),
      TEST_ADMIN_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
      [
        'sch-001:admin',
        'hlt-001:read',
        'hlt-001:write',
        'hlt-001:admin',
        'hlt-002:read',
        'hlt-002:write',
        'hlt-002:admin',
        'hlt-003:read',
        'hlt-003:write',
        'hlt-004:read',
        'hlt-004:write',
        'hlt-005:read',
        'hlt-005:write',
        'hlt-006:read',
        'hlt-006:write',
        'hlt-007:read',
        'hlt-007:admin',
      ],
    );
  });

  afterAll(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE assignment_version_hash = 'm23-ctrl-test'`,
    );
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  let createdPersonIds: string[] = [];
  let createdPlatformStudentIds: string[] = [];
  let createdStudentIds: string[] = [];

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(`TRUNCATE ${TEST_SCHEMA}.hlth_health_access_log`);
    await rawClient.$executeRawUnsafe(
      `TRUNCATE ${TEST_SCHEMA}.hlth_nurse_visits, ${TEST_SCHEMA}.hlth_medication_administrations, ${TEST_SCHEMA}.hlth_medication_schedule, ${TEST_SCHEMA}.hlth_medications, ${TEST_SCHEMA}.hlth_medical_conditions, ${TEST_SCHEMA}.hlth_immunisations, ${TEST_SCHEMA}.hlth_screenings, ${TEST_SCHEMA}.hlth_dietary_profiles CASCADE`,
    );
    if (createdStudentIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.hlth_student_health_records WHERE student_id = ANY($1::uuid[])`,
        createdStudentIds,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE id = ANY($1::uuid[])`,
        createdStudentIds,
      );
      createdStudentIds = [];
    }
    if (createdPlatformStudentIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.platform_students WHERE id = ANY($1::uuid[])`,
        createdPlatformStudentIds,
      );
      createdPlatformStudentIds = [];
    }
    if (createdPersonIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.iam_person WHERE id = ANY($1::uuid[])`,
        createdPersonIds,
      );
      createdPersonIds = [];
    }
  });

  function req(): any {
    return {
      user: {
        sub: TEST_ADMIN_ACCOUNT_ID,
        personId: TEST_ADMIN_PERSON_ID,
        email: 'admin@test',
        displayName: 'Admin',
        sessionId: 'sess',
      },
    };
  }

  async function seedStudent(): Promise<string> {
    const personId = generateId();
    const platformStudentId = generateId();
    const studentId = generateId();
    createdPersonIds.push(personId);
    createdPlatformStudentIds.push(platformStudentId);
    createdStudentIds.push(studentId);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
       VALUES ($1::uuid, 'CT', 'Stu', 'STUDENT', true)`,
      personId,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
       VALUES ($1::uuid, $2::uuid, 'CT', 'Stu', true)`,
      platformStudentId,
      personId,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_students (id, platform_student_id, school_id, student_number, grade_level)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '5')`,
      studentId,
      platformStudentId,
      TEST_SCHOOL_ID,
      'CTRL-' + studentId.slice(-6),
    );
    return studentId;
  }

  // ─── HealthController (probe) ───────────────────────────────
  describe('HealthController', () => {
    it('getHealth returns probe shape', () => {
      const out = healthCtrl.getHealth();
      expect(out.status).toBe('healthy');
    });
  });

  // ─── HealthRecordController ──────────────────────────────────
  describe('HealthRecordController', () => {
    it('create + getRecord + update + compliance', async () => {
      const studentId = await seedStudent();
      const created = await withTestTenant(() =>
        healthRecordCtrl.create(studentId, { bloodType: 'O+' } as any, req()),
      );
      expect(created.studentId).toBe(studentId);

      const got = await withTestTenant(() => healthRecordCtrl.getRecord(studentId, req()));
      expect(got.studentId).toBe(studentId);

      const updated = await withTestTenant(() =>
        healthRecordCtrl.update(studentId, { bloodType: 'A+' } as any, req()),
      );
      expect(updated.bloodType).toBe('A+');

      const compliance = await withTestTenant(() => healthRecordCtrl.compliance(req()));
      expect(Array.isArray(compliance)).toBe(true);
    });
  });

  // ─── ConditionController ─────────────────────────────────────
  describe('ConditionController', () => {
    it('list smoke + create on a student record', async () => {
      const studentId = await seedStudent();
      await withTestTenant(() => healthRecordCtrl.create(studentId, {} as any, req()));

      const created = await withTestTenant(() =>
        conditionCtrl.create(
          studentId,
          { conditionName: 'asthma', diagnosisDate: '2024-01-01', severity: 'MODERATE' } as any,
          req(),
        ),
      );
      const list = await withTestTenant(() => conditionCtrl.list(studentId, req()));
      expect(list.find((c: any) => c.id === created.id)).toBeDefined();

      const updated = await withTestTenant(() =>
        conditionCtrl.update(created.id, { managementPlan: 'controlled' } as any, req()),
      );
      expect(updated.managementPlan).toBe('controlled');
    });
  });

  // ─── MedicationController + MedicationScheduleController + AdministrationController ─
  describe('Medication + Schedule + Administration', () => {
    it('medication CRUD + schedule + administration flow', async () => {
      const studentId = await seedStudent();
      await withTestTenant(() => healthRecordCtrl.create(studentId, {} as any, req()));

      const med = await withTestTenant(() =>
        medicationCtrl.create(
          studentId,
          {
            medicationName: 'Albuterol',
            dosage: '90mcg',
            route: 'INHALER',
          } as any,
          req(),
        ),
      );

      const list = await withTestTenant(() => medicationCtrl.list(studentId, req()));
      expect(list.find((m: any) => m.id === med.id)).toBeDefined();

      const sched = await withTestTenant(() =>
        medScheduleCtrl.create(med.id, { scheduledTime: '08:00', dayOfWeek: 1 } as any, req()),
      );

      const schedList = await withTestTenant(() => medScheduleCtrl.list(med.id, req()));
      expect(schedList.find((s: any) => s.id === sched.id)).toBeDefined();

      const admin = await withTestTenant(() =>
        administrationCtrl.administer(med.id, { doseGiven: '90mcg' } as any, req()),
      );

      const adminList = await withTestTenant(() => administrationCtrl.list(med.id, req()));
      expect(adminList.find((a: any) => a.id === admin.id)).toBeDefined();

      const dashboard = await withTestTenant(() => administrationCtrl.dashboard(req()));
      expect(Array.isArray(dashboard)).toBe(true);
    });
  });

  // ─── NurseVisitController ────────────────────────────────────
  describe('NurseVisitController', () => {
    it('create + list + listForStudent + roster', async () => {
      const studentId = await seedStudent();
      await withTestTenant(() => healthRecordCtrl.create(studentId, {} as any, req()));
      const visit = await withTestTenant(() =>
        nurseVisitCtrl.create({ visitedPersonId: studentId, reason: 'headache' } as any, req()),
      );
      const list = await withTestTenant(() => nurseVisitCtrl.list({} as any, req()));
      expect(list.find((v: any) => v.id === visit.id)).toBeDefined();

      const forStudent = await withTestTenant(() =>
        nurseVisitCtrl.listForStudent(studentId, req()),
      );
      expect(forStudent.find((v: any) => v.id === visit.id)).toBeDefined();

      const roster = await withTestTenant(() => nurseVisitCtrl.roster(req()));
      expect(Array.isArray(roster)).toBe(true);
    });
  });

  // ─── HealthAccessLogController ───────────────────────────────
  describe('HealthAccessLogController', () => {
    it('list smoke', async () => {
      const list = await withTestTenant(() => accessLogCtrl.list({} as any, req()));
      expect(Array.isArray(list)).toBe(true);
    });
  });

  // ─── DietaryProfileController ────────────────────────────────
  describe('DietaryProfileController', () => {
    it('create + get + update', async () => {
      const studentId = await seedStudent();
      await withTestTenant(() => healthRecordCtrl.create(studentId, {} as any, req()));
      const created = await withTestTenant(() =>
        dietaryCtrl.create(
          studentId,
          { dietaryPattern: 'VEGETARIAN', allergies: [] } as any,
          req(),
        ),
      );
      const got = await withTestTenant(() => dietaryCtrl.get(studentId, req()));
      expect(got?.id).toBe(created.id);

      const updated = await withTestTenant(() =>
        dietaryCtrl.update(created.id, { specialMealInstructions: 'no nuts' } as any, req()),
      );
      expect(updated.id).toBe(created.id);

      const alerts = await withTestTenant(() => dietaryCtrl.allergenAlerts(req()));
      expect(Array.isArray(alerts)).toBe(true);
    });
  });

  // ─── ImmunisationController ──────────────────────────────────
  describe('ImmunisationController', () => {
    it('create + list', async () => {
      const studentId = await seedStudent();
      await withTestTenant(() => healthRecordCtrl.create(studentId, {} as any, req()));
      const imm = await withTestTenant(() =>
        immunisationCtrl.create(
          studentId,
          {
            vaccineName: 'MMR',
            administeredDate: '2026-01-01',
            status: 'CURRENT',
          } as any,
          req(),
        ),
      );
      const list = await withTestTenant(() => immunisationCtrl.list(studentId, req()));
      expect(list.find((i: any) => i.id === imm.id)).toBeDefined();
    });
  });

  // ─── IepPlanController ───────────────────────────────────────
  describe('IepPlanController', () => {
    it('create + getByStudent + list smoke', async () => {
      const studentId = await seedStudent();
      const plan = await withTestTenant(() =>
        iepCtrl.create(
          studentId,
          {
            planType: 'IEP',
            startDate: '2026-01-01',
            endDate: '2026-12-31',
          } as any,
          req(),
        ),
      );
      const got = await withTestTenant(() => iepCtrl.get(studentId, req()));
      expect(got?.id).toBe(plan.id);

      const updated = await withTestTenant(() =>
        iepCtrl.update(plan.id, { status: 'ACTIVE' } as any, req()),
      );
      expect(updated.status).toBe('ACTIVE');
    });
  });

  // ─── ScreeningController ─────────────────────────────────────
  describe('ScreeningController', () => {
    it('create + list', async () => {
      const studentId = await seedStudent();
      await withTestTenant(() => healthRecordCtrl.create(studentId, {} as any, req()));
      const s = await withTestTenant(() =>
        screeningCtrl.create(
          {
            studentId,
            screeningType: 'VISION',
            screeningDate: '2026-01-01',
            result: 'PASS',
          } as any,
          req(),
        ),
      );
      const list = await withTestTenant(() => screeningCtrl.list({} as any, req()));
      expect(list.find((x: any) => x.id === s.id)).toBeDefined();
    });
  });

  // ─── HealthAdvancedController (telehealth + compliance + referrals) ────
  describe('HealthAdvancedController', () => {
    it('telehealth providers + sessions smoke', async () => {
      const provider = await withTestTenant(() =>
        healthAdvCtrl.createProvider(req(), {
          providerName: 'CTRL Provider',
          providerType: 'PEDIATRICIAN',
          contactEmail: 'p@x',
        } as any),
      );
      const providers = await withTestTenant(() => healthAdvCtrl.listProviders('true'));
      expect(providers.find((p: any) => p.id === provider.id)).toBeDefined();

      const got = await withTestTenant(() => healthAdvCtrl.getProvider(provider.id));
      expect(got.id).toBe(provider.id);

      const patched = await withTestTenant(() =>
        healthAdvCtrl.patchProvider(req(), provider.id, { contactEmail: 'p2@x' } as any),
      );
      expect(patched.contactEmail).toBe('p2@x');

      const sessions = await withTestTenant(() => healthAdvCtrl.listSessions(req(), {} as any));
      expect(Array.isArray(sessions)).toBe(true);
    });

    it('immunisation requirements + compliance + run smoke', async () => {
      const reqList = await withTestTenant(() => healthAdvCtrl.listRequirements());
      expect(Array.isArray(reqList)).toBe(true);

      const created = await withTestTenant(() =>
        healthAdvCtrl.createRequirement(req(), {
          stateCode: 'CT',
          vaccineName: 'VARI-' + generateId().slice(-6),
          requiredByGrade: '5',
          requiredDoses: 1,
        } as any),
      );
      const got = await withTestTenant(() =>
        healthAdvCtrl.patchRequirement(req(), created.id, { requiredDoses: 2 } as any),
      );
      expect(got.requiredDoses).toBe(2);

      const compList = await withTestTenant(() => healthAdvCtrl.listCompliance({} as any));
      expect(Array.isArray(compList)).toBe(true);

      const dashboard = await withTestTenant(() => healthAdvCtrl.complianceDashboard());
      expect(dashboard).toBeDefined();

      // CSV report — pipe to a fake Express response that captures send()
      const captured: { csv?: string; headers: Record<string, string> } = { headers: {} };
      const fakeRes: any = {
        setHeader: (k: string, v: string) => {
          captured.headers[k] = v;
        },
        send: (body: string) => {
          captured.csv = body;
        },
      };
      await withTestTenant(() => healthAdvCtrl.complianceReport(fakeRes));
      expect(typeof captured.csv).toBe('string');
      expect(captured.headers['Content-Disposition']).toContain('immunisation-compliance');

      const ran = await withTestTenant(() => healthAdvCtrl.runCompliance(req(), {} as any));
      expect(typeof ran.computed).toBe('number');
    });

    it('screening referrals list + overdue smoke', async () => {
      const list = await withTestTenant(() => healthAdvCtrl.listReferrals({} as any));
      expect(Array.isArray(list)).toBe(true);
      const overdue = await withTestTenant(() => healthAdvCtrl.overdueReferrals());
      expect(Array.isArray(overdue)).toBe(true);
    });
  });

  // ─── ImmunisationComplianceWorker ───────────────────────────
  describe('ImmunisationComplianceWorker', () => {
    it('tick walks active schools and computes compliance', async () => {
      // tick() uses tenantPrisma.getPlatformClient() which calls
      // PrismaClient directly. Since this method may not exist in test
      // builds, we wrap in try/catch on the test side — the worker
      // itself has a try/catch around the entire loadActiveSchools.
      await worker.tick();
      // Second invocation exercises the "running guard" branch
      const promise = worker.tick();
      await worker.tick(); // most likely returns immediately due to running flag
      await promise;
    });
  });

  // ─── IepAccommodationConsumer ───────────────────────────────
  describe('IepAccommodationConsumer', () => {
    it('reconcile upserts accommodations from snapshot, then drops removed ones', async () => {
      const studentId = await seedStudent();
      const idempotency = new IdempotencyService(rawClient);
      let captured: MessageHandler | null = null;
      const mockConsumer: KafkaConsumerService = {
        subscribe: async (opts: any) => {
          captured = opts.handler;
        },
      } as any;
      const consumer = new IepAccommodationConsumer(mockConsumer, idempotency, tenantPrisma);
      await consumer.onModuleInit();
      if (!captured) throw new Error('handler not captured');
      const handler = captured as unknown as MessageHandler;

      // Wipe consumer idempotency rows so the test event_id is fresh.
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.platform_event_consumer_idempotency WHERE consumer_group = 'iep-accommodation-consumer'`,
      );

      const acc1Id = generateId();
      const acc2Id = generateId();
      const eventId1 = generateId();
      const msg1: ConsumedMessage = {
        topic: 'dev.iep.accommodation.updated',
        partition: 0,
        offset: '0',
        key: null,
        headers: { 'tenant-subdomain': 'test' },
        payload: {
          event_id: eventId1,
          event_type: 'iep.accommodation.updated',
          event_version: 1,
          occurred_at: new Date().toISOString(),
          published_at: new Date().toISOString(),
          tenant_id: TEST_SCHOOL_ID,
          source_module: 'iep-test',
          payload: {
            planId: generateId(),
            schoolId: TEST_SCHOOL_ID,
            studentId,
            planType: 'IEP',
            planStatus: 'ACTIVE',
            accommodations: [
              {
                sourceIepAccommodationId: acc1Id,
                accommodationType: 'EXTRA_TIME',
                description: 'Extra time on tests',
                appliesTo: 'ALL_ASSESSMENTS',
              },
              {
                sourceIepAccommodationId: acc2Id,
                accommodationType: 'PREFERENTIAL_SEATING',
                appliesTo: 'ALL_ASSIGNMENTS',
              },
            ],
          },
        },
        timestamp: new Date().toISOString(),
      };
      await handler(msg1);

      const rows = await rawClient.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT COUNT(*)::int AS n FROM ${TEST_SCHEMA}.sis_student_active_accommodations
           WHERE student_id = $1::uuid AND source_iep_accommodation_id IS NOT NULL`,
        studentId,
      );
      expect(rows[0]!.n).toBe(2);

      // Second event with only one accommodation → the other is deleted.
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.platform_event_consumer_idempotency WHERE consumer_group = 'iep-accommodation-consumer'`,
      );
      const msg2: ConsumedMessage = {
        ...msg1,
        payload: {
          ...(msg1.payload as any),
          event_id: generateId(),
          payload: {
            ...(msg1.payload as any).payload,
            accommodations: [
              {
                sourceIepAccommodationId: acc1Id,
                accommodationType: 'EXTRA_TIME_v2',
                appliesTo: 'ALL_ASSESSMENTS',
              },
            ],
          },
        },
      };
      await handler(msg2);

      const rows2 = await rawClient.$queryRawUnsafe<Array<{ n: number; t: string }>>(
        `SELECT COUNT(*)::int AS n, MIN(accommodation_type) AS t
           FROM ${TEST_SCHEMA}.sis_student_active_accommodations
           WHERE student_id = $1::uuid AND source_iep_accommodation_id IS NOT NULL`,
        studentId,
      );
      expect(rows2[0]!.n).toBe(1);
      expect(rows2[0]!.t).toBe('EXTRA_TIME_v2');

      // Empty array → drops everything.
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.platform_event_consumer_idempotency WHERE consumer_group = 'iep-accommodation-consumer'`,
      );
      const msg3: ConsumedMessage = {
        ...msg1,
        payload: {
          ...(msg1.payload as any),
          event_id: generateId(),
          payload: {
            ...(msg1.payload as any).payload,
            planStatus: 'EXPIRED',
            accommodations: [],
          },
        },
      };
      await handler(msg3);

      const rows3 = await rawClient.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT COUNT(*)::int AS n FROM ${TEST_SCHEMA}.sis_student_active_accommodations
           WHERE student_id = $1::uuid AND source_iep_accommodation_id IS NOT NULL`,
        studentId,
      );
      expect(rows3[0]!.n).toBe(0);

      // Missing routing ids → drops via warn (no throw)
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.platform_event_consumer_idempotency WHERE consumer_group = 'iep-accommodation-consumer'`,
      );
      const badMsg: ConsumedMessage = {
        ...msg1,
        payload: {
          ...(msg1.payload as any),
          event_id: generateId(),
          payload: { accommodations: [] },
        },
      };
      await handler(badMsg);
    });
  });
});
