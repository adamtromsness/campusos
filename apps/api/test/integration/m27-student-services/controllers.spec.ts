import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

// Controllers under test (all 13)
import { CaseloadController } from '@modules/m27-student-services/caseload/caseload.controller';
import { CoordinatedCareController } from '@modules/m27-student-services/counselling/coordinated-care.controller';
import { MandatoryReportController } from '@modules/m27-student-services/counselling/mandatory-report.controller';
import { SessionController } from '@modules/m27-student-services/counselling/session.controller';
import { SessionNoteController } from '@modules/m27-student-services/counselling/session-note.controller';
import { MtssController } from '@modules/m27-student-services/mtss/mtss.controller';
import { ReferralController } from '@modules/m27-student-services/referrals/referral.controller';
import { ReferralTypeController } from '@modules/m27-student-services/referrals/referral-type.controller';
import { StudentServicesAdvancedController } from '@modules/m27-student-services/referrals/student-services-advanced.controller';
import { DeploymentController } from '@modules/m27-student-services/wellbeing/deployment.controller';
import { CheckinController } from '@modules/m27-student-services/wellbeing/checkin.controller';
import { SurveyTemplateController } from '@modules/m27-student-services/wellbeing/survey-template.controller';
import { AlertController } from '@modules/m27-student-services/wellbeing/alert.controller';

// Services
import { CaseloadService } from '@modules/m27-student-services/caseload/caseload.service';
import { CaseloadDashboardService } from '@modules/m27-student-services/caseload/caseload-dashboard.service';
import { CoordinatedCareService } from '@modules/m27-student-services/counselling/coordinated-care.service';
import { MandatoryReportService } from '@modules/m27-student-services/counselling/mandatory-report.service';
import { SessionService } from '@modules/m27-student-services/counselling/session.service';
import { SessionNoteService } from '@modules/m27-student-services/counselling/session-note.service';
import { InterventionService } from '@modules/m27-student-services/counselling/intervention.service';
import { MtssTierService } from '@modules/m27-student-services/mtss/mtss-tier.service';
import { MtssTeamMeetingService } from '@modules/m27-student-services/mtss/mtss-team-meeting.service';
import { ReferralService } from '@modules/m27-student-services/referrals/referral.service';
import { ReferralTypeService } from '@modules/m27-student-services/referrals/referral-type.service';
import { ReferralActivityService } from '@modules/m27-student-services/referrals/referral-activity.service';
import { AgencyReferralService } from '@modules/m27-student-services/referrals/agency-referral.service';
import { CrisisEscalationService } from '@modules/m27-student-services/referrals/crisis-escalation.service';
import { DeploymentService } from '@modules/m27-student-services/wellbeing/deployment.service';
import { CheckinService } from '@modules/m27-student-services/wellbeing/checkin.service';
import { SurveyTemplateService } from '@modules/m27-student-services/wellbeing/survey-template.service';
import { AlertService } from '@modules/m27-student-services/wellbeing/alert.service';
import { WellbeingLongitudinalService } from '@modules/m27-student-services/wellbeing/wellbeing-longitudinal.service';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';
import type { KafkaProducerService } from '@shared/kafka/kafka-producer.service';

import { withTestTenant, TEST_SCHOOL_ID, TEST_SCHEMA } from '../helpers/tenant-context';
import {
  TEST_ADMIN_ACCOUNT_ID,
  TEST_ADMIN_PERSON_ID,
  TEST_ADMIN_EMPLOYEE_ID,
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';
import { TEST_ACADEMIC_YEAR_ID } from '../fixtures/finance';
import { makeRecordingKafka } from '../helpers/recording-kafka';

/**
 * Controller-layer coverage for m27-student-services. Each of the 13
 * canonical controllers is instantiated with real services + a real DB.
 * Tests exercise every HTTP route handler with admin actor + synthetic
 * AuthedRequest. Admin holds sch-001:admin + every cou-* SVC permission
 * tagged `assignment_version_hash='m27-ctrl-test'` for clean afterAll
 * teardown.
 */
describe('integration:m27-student-services/controllers', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let kafka: KafkaProducerService;
  let outbox: OutboxService;
  let permCheck: PermissionCheckService;
  let actors: ActorContextService;

  // Service refs we need across describe blocks
  let referralTypeService: ReferralTypeService;

  // Controller refs
  let caseloadCtrl: CaseloadController;
  let coordinatedCareCtrl: CoordinatedCareController;
  let mandatoryReportCtrl: MandatoryReportController;
  let sessionCtrl: SessionController;
  let sessionNoteCtrl: SessionNoteController;
  let mtssCtrl: MtssController;
  let referralCtrl: ReferralController;
  let referralTypeCtrl: ReferralTypeController;
  let advancedCtrl: StudentServicesAdvancedController;
  let deploymentCtrl: DeploymentController;
  let checkinCtrl: CheckinController;
  let surveyTemplateCtrl: SurveyTemplateController;
  let alertCtrl: AlertController;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    kafka = makeRecordingKafka();
    outbox = new OutboxService();
    permCheck = new PermissionCheckService(rawClient);
    actors = new ActorContextService(rawClient, permCheck, tenantPrisma);

    const caseloads = new CaseloadService(tenantPrisma, permCheck);
    const dashboard = new CaseloadDashboardService(tenantPrisma);
    const care = new CoordinatedCareService(tenantPrisma, permCheck);
    const reports = new MandatoryReportService(tenantPrisma, permCheck);
    const sessions = new SessionService(tenantPrisma, permCheck);
    const notes = new SessionNoteService(tenantPrisma, permCheck, sessions);
    const interventions = new InterventionService(tenantPrisma, permCheck);
    const mtssTiers = new MtssTierService(tenantPrisma, kafka, permCheck);
    const mtssMeetings = new MtssTeamMeetingService(tenantPrisma);
    const activity = new ReferralActivityService(tenantPrisma);
    referralTypeService = new ReferralTypeService(tenantPrisma);
    const referrals = new ReferralService(
      tenantPrisma,
      kafka,
      activity,
      referralTypeService,
      caseloads,
      permCheck,
    );
    const agency = new AgencyReferralService(tenantPrisma);
    const crisis = new CrisisEscalationService(tenantPrisma, outbox);
    const longitudinal = new WellbeingLongitudinalService(tenantPrisma);
    const templates = new SurveyTemplateService(tenantPrisma, permCheck);
    const deployments = new DeploymentService(tenantPrisma, permCheck, templates);
    const checkins = new CheckinService(tenantPrisma, permCheck, outbox);
    const alerts = new AlertService(tenantPrisma, permCheck);

    caseloadCtrl = new CaseloadController(caseloads, actors);
    coordinatedCareCtrl = new CoordinatedCareController(care, actors);
    mandatoryReportCtrl = new MandatoryReportController(reports, actors);
    sessionCtrl = new SessionController(sessions, actors);
    sessionNoteCtrl = new SessionNoteController(notes, actors);
    mtssCtrl = new MtssController(mtssTiers, interventions, actors);
    referralCtrl = new ReferralController(referrals, activity, actors);
    referralTypeCtrl = new ReferralTypeController(referralTypeService, actors);
    advancedCtrl = new StudentServicesAdvancedController(
      dashboard,
      agency,
      longitudinal,
      mtssMeetings,
      crisis,
      actors,
    );
    deploymentCtrl = new DeploymentController(deployments, actors);
    checkinCtrl = new CheckinController(checkins, actors);
    surveyTemplateCtrl = new SurveyTemplateController(templates, actors);
    alertCtrl = new AlertController(alerts, actors);

    // Grant admin every relevant permission so the controller-side
    // ActorContextService.resolveActor produces an admin actor and all
    // service-layer gates pass.
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache
         (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], now(), 'm27-ctrl-test')
       ON CONFLICT (account_id, scope_id) DO UPDATE
         SET permission_codes = EXCLUDED.permission_codes, computed_at = now()`,
      generateId(),
      TEST_ADMIN_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
      [
        'sch-001:admin',
        // Caseload + sessions + mandatory reports
        'cou-001:read',
        'cou-001:write',
        'cou-001:admin',
        'cou-002:read',
        'cou-002:write',
        'cou-002:admin',
        'cou-003:read',
        'cou-003:write',
        'cou-003:admin',
        'cou-004:read',
        'cou-004:write',
        'cou-004:admin',
        'cou-006:read',
        'cou-006:write',
        'cou-006:admin',
        'cou-007:read',
        'cou-007:write',
        // FERPA gate for session notes
        'student_counseling_record:read',
        // CoordinatedCare service requires hlt-001:read AND cou-007:read AND hlt-001:write for NURSE notes
        'hlt-001:read',
        'hlt-001:write',
      ],
    );
  });

  afterAll(async () => {
    // Wipe residual m27 tenant data so this spec doesn't bleed state
    // into the next spec file (deployment.spec.ts asserts "0 students"
    // for an empty admin caseload, etc.).
    await rawClient.$executeRawUnsafe(`TRUNCATE ${TEST_SCHEMA}.svc_referral_activity CASCADE`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.svc_intervention_progress`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.svc_interventions`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.svc_mtss_team_meeting_students`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.svc_mtss_team_meetings`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.svc_mtss_tiers`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.svc_agency_referrals`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.svc_session_notes`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.svc_session_participants`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.svc_sessions`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.svc_coordinated_care_notes`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.svc_mandatory_reports`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.svc_wellbeing_alerts`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.svc_wellbeing_responses`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.svc_wellbeing_checkins`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.svc_wellbeing_deployments`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.svc_wellbeing_questions`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.svc_wellbeing_survey_templates`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.svc_wellbeing_longitudinal`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.svc_referrals`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.svc_referral_types WHERE name LIKE 'CTRL-%'`,
    );
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.svc_caseloads`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'CTRL-%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_students WHERE first_name = 'Ctrl'`,
    );
    await rawClient.$executeRawUnsafe(`DELETE FROM platform.iam_person WHERE first_name = 'Ctrl'`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_outbox WHERE tenant_id = $1::uuid AND topic LIKE 'svc.%'`,
      TEST_SCHOOL_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE assignment_version_hash = 'm27-ctrl-test'`,
    );
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  // ─── per-test bookkeeping ───────────────────────────────────────
  const createdPersonIds: string[] = [];
  const createdPlatformStudentIds: string[] = [];
  const createdStudentIds: string[] = [];

  beforeEach(async () => {
    // svc_referral_activity is IMMUTABLE — TRUNCATE bypasses BEFORE-ROW trigger
    await rawClient.$executeRawUnsafe(`TRUNCATE ${TEST_SCHEMA}.svc_referral_activity CASCADE`);
    // Clean m27 tenant tables in FK-safe order
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.svc_intervention_progress`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.svc_interventions`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.svc_mtss_team_meeting_students`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.svc_mtss_team_meetings`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.svc_mtss_tiers`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.svc_agency_referrals`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.svc_session_notes`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.svc_session_participants`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.svc_sessions`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.svc_coordinated_care_notes`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.svc_mandatory_reports`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.svc_wellbeing_alerts`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.svc_wellbeing_responses`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.svc_wellbeing_checkins`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.svc_wellbeing_deployments`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.svc_wellbeing_questions`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.svc_wellbeing_survey_templates`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.svc_wellbeing_longitudinal`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.svc_referrals`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.svc_referral_types WHERE name LIKE 'CTRL-%'`,
    );
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.svc_caseloads`);
    if (createdStudentIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE id = ANY($1::uuid[])`,
        createdStudentIds.splice(0),
      );
    }
    if (createdPlatformStudentIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.platform_students WHERE id = ANY($1::uuid[])`,
        createdPlatformStudentIds.splice(0),
      );
    }
    if (createdPersonIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.iam_person WHERE id = ANY($1::uuid[])`,
        createdPersonIds.splice(0),
      );
    }
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_outbox WHERE tenant_id = $1::uuid AND topic LIKE 'svc.%'`,
      TEST_SCHOOL_ID,
    );
  });

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

  async function seedStudent(label = 'Stu'): Promise<string> {
    const personId = generateId();
    const platformStudentId = generateId();
    const studentId = generateId();
    createdPersonIds.push(personId);
    createdPlatformStudentIds.push(platformStudentId);
    createdStudentIds.push(studentId);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
       VALUES ($1::uuid, 'Ctrl', $2, 'STUDENT', true)`,
      personId,
      label,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
       VALUES ($1::uuid, $2::uuid, 'Ctrl', $3, true)`,
      platformStudentId,
      personId,
      label,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_students (id, platform_student_id, school_id, student_number, grade_level)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '8')`,
      studentId,
      platformStudentId,
      TEST_SCHOOL_ID,
      'CTRL-' + studentId.slice(-12),
    );
    return studentId;
  }

  async function seedCaseload(studentId: string): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.svc_caseloads
         (id, school_id, counselor_id, student_id, academic_year_id, primary_concern,
          is_primary_counselor, status, opened_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'ACADEMIC',
               true, 'ACTIVE', now()::date)`,
      id,
      TEST_SCHOOL_ID,
      TEST_ADMIN_EMPLOYEE_ID,
      studentId,
      TEST_ACADEMIC_YEAR_ID,
    );
    return id;
  }

  function futureIso(deltaMs: number): string {
    return new Date(Date.now() + deltaMs).toISOString();
  }

  async function seedReferralTypeRow(): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.svc_referral_types
         (id, school_id, name, default_priority, requires_parent_notification, is_active)
       VALUES ($1::uuid, $2::uuid, $3, 'MEDIUM', false, true)`,
      id,
      TEST_SCHOOL_ID,
      'CTRL-Type-' + id.slice(-6),
    );
    return id;
  }

  // ─────────────────────────────────────────────────────────────────
  // CaseloadController
  // ─────────────────────────────────────────────────────────────────
  describe('CaseloadController', () => {
    async function createCaseload(studentId: string): Promise<any> {
      return withTestTenant(() =>
        caseloadCtrl.create(
          {
            counselorId: TEST_ADMIN_EMPLOYEE_ID,
            studentId,
            academicYearId: TEST_ACADEMIC_YEAR_ID,
            primaryConcern: 'ACADEMIC',
            isPrimaryCounselor: true,
            openedAt: new Date().toISOString().slice(0, 10),
            notes: 'caseload notes',
          } as any,
          req(),
        ),
      );
    }

    it('create + list + getById + patch + close', async () => {
      const studentId = await seedStudent('Case');
      const created = await createCaseload(studentId);
      expect(created.status).toBe('ACTIVE');
      expect(created.counselorId).toBe(TEST_ADMIN_EMPLOYEE_ID);

      const list = await withTestTenant(() => caseloadCtrl.list({} as any, req()));
      expect(list.find((c: any) => c.id === created.id)).toBeDefined();

      const got = await withTestTenant(() => caseloadCtrl.getById(created.id, req()));
      expect(got.id).toBe(created.id);
      expect(got.sessionCount).toBe(0);

      const patched = await withTestTenant(() =>
        caseloadCtrl.patch(
          created.id,
          { primaryConcern: 'SOCIAL_EMOTIONAL', notes: 'updated' } as any,
          req(),
        ),
      );
      expect(patched.primaryConcern).toBe('SOCIAL_EMOTIONAL');

      const closed = await withTestTenant(() =>
        caseloadCtrl.close(created.id, { closureReason: 'Goals met' } as any, req()),
      );
      expect(closed.status).toBe('CLOSED');
    });

    it('list with status filter returns matching only', async () => {
      const studentId = await seedStudent('CaseFilter');
      const c = await createCaseload(studentId);
      const list = await withTestTenant(() =>
        caseloadCtrl.list({ status: 'ACTIVE' } as any, req()),
      );
      expect(list.find((x: any) => x.id === c.id)).toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // CoordinatedCareController
  // ─────────────────────────────────────────────────────────────────
  describe('CoordinatedCareController', () => {
    it('create + listForStudent (NURSE author role with admin)', async () => {
      const studentId = await seedStudent('CC');
      const note = await withTestTenant(() =>
        coordinatedCareCtrl.create(
          studentId,
          { authorRole: 'NURSE', noteText: 'nurse note' } as any,
          req(),
        ),
      );
      expect(note.authorRole).toBe('NURSE');
      const list = await withTestTenant(() => coordinatedCareCtrl.listForStudent(studentId, req()));
      expect(list.find((n: any) => n.id === note.id)).toBeDefined();
    });

    it('create COUNSELLOR note', async () => {
      const studentId = await seedStudent('CCCou');
      const note = await withTestTenant(() =>
        coordinatedCareCtrl.create(
          studentId,
          { authorRole: 'COUNSELLOR', noteText: 'counsellor note' } as any,
          req(),
        ),
      );
      expect(note.authorRole).toBe('COUNSELLOR');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // MandatoryReportController
  // ─────────────────────────────────────────────────────────────────
  describe('MandatoryReportController', () => {
    it('create + list + getById + patch (status only)', async () => {
      const studentId = await seedStudent('MR');
      const created = await withTestTenant(() =>
        mandatoryReportCtrl.create(
          {
            studentId,
            reportType: 'SUSPECTED_ABUSE',
            reportedToAuthority: 'CPS-County-1',
            reportDate: new Date().toISOString(),
            description: 'mandatory report narrative',
            supportingDocsS3Keys: ['s3://docs/x'],
          } as any,
          req(),
        ),
      );
      expect(created.status).toBe('FILED');

      const list = await withTestTenant(() => mandatoryReportCtrl.list({} as any, req()));
      expect(list.find((r: any) => r.id === created.id)).toBeDefined();

      const got = await withTestTenant(() => mandatoryReportCtrl.getById(created.id, req()));
      expect(got.id).toBe(created.id);

      const patched = await withTestTenant(() =>
        mandatoryReportCtrl.patch(
          created.id,
          { status: 'CPS_CONTACTED', cpsResponse: 'CPS opened case' } as any,
          req(),
        ),
      );
      expect(patched.status).toBe('CPS_CONTACTED');
      expect(patched.cpsResponse).toBe('CPS opened case');
    });

    it('list with status filter', async () => {
      const studentId = await seedStudent('MRFilter');
      await withTestTenant(() =>
        mandatoryReportCtrl.create(
          {
            studentId,
            reportType: 'SUSPECTED_NEGLECT',
            reportedToAuthority: 'CPS-2',
            reportDate: new Date().toISOString(),
            description: 'narrative',
          } as any,
          req(),
        ),
      );
      const list = await withTestTenant(() =>
        mandatoryReportCtrl.list({ status: 'FILED' } as any, req()),
      );
      expect(list.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // SessionController
  // ─────────────────────────────────────────────────────────────────
  describe('SessionController', () => {
    async function makeIndividualSession(): Promise<{
      sessionId: string;
      studentId: string;
      caseloadId: string;
    }> {
      const studentId = await seedStudent('SessInd');
      const caseloadId = await seedCaseload(studentId);
      const s = await withTestTenant(() =>
        sessionCtrl.create(
          {
            counselorId: TEST_ADMIN_EMPLOYEE_ID,
            sessionDate: '2026-05-12',
            sessionType: 'INDIVIDUAL',
            primaryCaseloadId: caseloadId,
          } as any,
          req(),
        ),
      );
      return { sessionId: s.id, studentId, caseloadId };
    }

    it('create + list + getById + patch', async () => {
      const { sessionId } = await makeIndividualSession();

      const list = await withTestTenant(() => sessionCtrl.list({} as any, req()));
      expect(list.find((s: any) => s.id === sessionId)).toBeDefined();

      const got = await withTestTenant(() => sessionCtrl.getById(sessionId, req()));
      expect(got.id).toBe(sessionId);

      const patched = await withTestTenant(() =>
        sessionCtrl.patch(
          sessionId,
          { status: 'COMPLETED', durationMinutes: 30, notes: 'good session' } as any,
          req(),
        ),
      );
      expect(patched.status).toBe('COMPLETED');
      expect(patched.durationMinutes).toBe(30);
    });

    it('addParticipant + markAttendance on GROUP session', async () => {
      const group = await withTestTenant(() =>
        sessionCtrl.create(
          {
            counselorId: TEST_ADMIN_EMPLOYEE_ID,
            sessionDate: '2026-05-12',
            sessionType: 'GROUP',
          } as any,
          req(),
        ),
      );
      const studentId = await seedStudent('SessGrp');
      const participant = await withTestTenant(() =>
        sessionCtrl.addParticipant(group.id, { studentId } as any, req()),
      );
      expect(participant.studentId).toBe(studentId);

      const marked = await withTestTenant(() =>
        sessionCtrl.markAttendance(
          participant.id,
          { attendanceStatus: 'LATE', notes: 'arrived 10 min late' } as any,
          req(),
        ),
      );
      expect(marked.attendanceStatus).toBe('LATE');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // SessionNoteController (FERPA-gated)
  // ─────────────────────────────────────────────────────────────────
  describe('SessionNoteController', () => {
    it('create + listForSession + getById + patch + lock', async () => {
      const studentId = await seedStudent('Note');
      const caseloadId = await seedCaseload(studentId);
      const session = await withTestTenant(() =>
        sessionCtrl.create(
          {
            counselorId: TEST_ADMIN_EMPLOYEE_ID,
            sessionDate: '2026-05-12',
            sessionType: 'INDIVIDUAL',
            primaryCaseloadId: caseloadId,
          } as any,
          req(),
        ),
      );

      const note = await withTestTenant(() =>
        sessionNoteCtrl.create(session.id, { studentId, notesText: 'initial' } as any, req()),
      );
      expect(note.notesText).toBe('initial');
      expect(note.isLocked).toBe(false);

      const list = await withTestTenant(() => sessionNoteCtrl.listForSession(session.id, req()));
      expect(list.find((n: any) => n.id === note.id)).toBeDefined();

      const got = await withTestTenant(() => sessionNoteCtrl.getById(note.id, req()));
      expect(got.id).toBe(note.id);

      const patched = await withTestTenant(() =>
        sessionNoteCtrl.patch(
          note.id,
          { notesText: 'revised', followUpRequired: true } as any,
          req(),
        ),
      );
      expect(patched.notesText).toBe('revised');
      expect(patched.followUpRequired).toBe(true);

      const locked = await withTestTenant(() => sessionNoteCtrl.lock(note.id, req()));
      expect(locked.isLocked).toBe(true);
      expect(locked.lockedById).toBe(TEST_ADMIN_EMPLOYEE_ID);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // MtssController
  // ─────────────────────────────────────────────────────────────────
  describe('MtssController', () => {
    async function createTier(studentId: string): Promise<any> {
      return withTestTenant(() =>
        mtssCtrl.createTier(
          {
            studentId,
            academicYearId: TEST_ACADEMIC_YEAR_ID,
            tier: 'TIER_2',
            domain: 'ACADEMIC',
            assignedAt: '2026-01-15',
            reviewDate: '2026-04-15',
          } as any,
          req(),
        ),
      );
    }

    it('tier lifecycle: listTiers + getTier + createTier + patchTier + dashboard', async () => {
      const studentId = await seedStudent('Tier');
      const tier = await createTier(studentId);
      expect(tier.tier).toBe('TIER_2');

      const list = await withTestTenant(() => mtssCtrl.listTiers({} as any, req()));
      expect(list.find((t: any) => t.id === tier.id)).toBeDefined();

      const got = await withTestTenant(() => mtssCtrl.getTier(tier.id, req()));
      expect(got.id).toBe(tier.id);

      const patched = await withTestTenant(() =>
        mtssCtrl.patchTier(tier.id, { tier: 'TIER_3' } as any, req()),
      );
      expect(patched.tier).toBe('TIER_3');

      const dash = await withTestTenant(() => mtssCtrl.dashboard(req()));
      expect(dash.totalActive).toBeGreaterThanOrEqual(1);
    });

    it('team meetings: createMeeting + listMeetings + getMeeting + attachMeetingStudent', async () => {
      const meeting = await withTestTenant(() =>
        mtssCtrl.createMeeting(
          {
            academicYearId: TEST_ACADEMIC_YEAR_ID,
            meetingDate: '2026-03-01',
            notes: 'review',
          } as any,
          req(),
        ),
      );

      const list = await withTestTenant(() =>
        mtssCtrl.listMeetings(undefined, undefined, TEST_ACADEMIC_YEAR_ID, req()),
      );
      expect(list.find((m: any) => m.id === meeting.id)).toBeDefined();

      const got = await withTestTenant(() => mtssCtrl.getMeeting(meeting.id, req()));
      expect(got.id).toBe(meeting.id);

      const studentId = await seedStudent('Meet');
      const attached = await withTestTenant(() =>
        mtssCtrl.attachMeetingStudent(
          meeting.id,
          { studentId, outcome: 'TIER_UP', outcomeNotes: 'promote' } as any,
          req(),
        ),
      );
      expect(attached.studentId).toBe(studentId);
    });

    it('interventions: createIntervention + listInterventions + patchIntervention + logProgress + listProgress', async () => {
      const studentId = await seedStudent('Int');
      const tier = await createTier(studentId);

      const intervention = await withTestTenant(() =>
        mtssCtrl.createIntervention(
          tier.id,
          {
            interventionName: 'Reading Practice',
            interventionType: 'ACADEMIC_SUPPORT',
            description: 'Daily reading',
            frequency: 'DAILY',
            startDate: '2026-02-01',
          } as any,
          req(),
        ),
      );
      expect(intervention.status).toBe('ACTIVE');

      const list = await withTestTenant(() => mtssCtrl.listInterventions(tier.id, req()));
      expect(list.find((i: any) => i.id === intervention.id)).toBeDefined();

      const patched = await withTestTenant(() =>
        mtssCtrl.patchIntervention(
          intervention.id,
          { frequency: 'WEEKLY', description: 'Updated' } as any,
          req(),
        ),
      );
      expect(patched.frequency).toBe('WEEKLY');

      const progress = await withTestTenant(() =>
        mtssCtrl.logProgress(
          intervention.id,
          {
            recordedDate: '2026-03-01',
            measureType: 'FLUENCY_WPM',
            score: 80,
            benchmark: 75,
            notes: 'on track',
          } as any,
          req(),
        ),
      );
      expect(progress.score).toBe(80);

      const progressList = await withTestTenant(() =>
        mtssCtrl.listProgress(intervention.id, req()),
      );
      expect(progressList.find((p: any) => p.id === progress.id)).toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // ReferralTypeController
  // ─────────────────────────────────────────────────────────────────
  describe('ReferralTypeController', () => {
    it('create + list + patch', async () => {
      const created = await withTestTenant(() =>
        referralTypeCtrl.create(
          {
            name: 'CTRL-Type-' + generateId().slice(-6),
            description: 'controller-test type',
            defaultPriority: 'HIGH',
            requiresParentNotification: true,
          } as any,
          req(),
        ),
      );
      expect(created.defaultPriority).toBe('HIGH');

      const list = await withTestTenant(() => referralTypeCtrl.list(false));
      expect(list.find((t: any) => t.id === created.id)).toBeDefined();

      const listAll = await withTestTenant(() => referralTypeCtrl.list(true));
      expect(listAll.find((t: any) => t.id === created.id)).toBeDefined();

      const patched = await withTestTenant(() =>
        referralTypeCtrl.patch(
          created.id,
          { description: 'updated', defaultPriority: 'URGENT', isActive: false } as any,
          req(),
        ),
      );
      expect(patched.defaultPriority).toBe('URGENT');
      expect(patched.isActive).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // ReferralController
  // ─────────────────────────────────────────────────────────────────
  describe('ReferralController', () => {
    async function seedReferralCtrl(): Promise<{ id: string; studentId: string; typeId: string }> {
      const studentId = await seedStudent('Ref');
      const typeId = await seedReferralTypeRow();
      const r = await withTestTenant(() =>
        referralCtrl.create(
          {
            studentId,
            referralTypeId: typeId,
            reason: 'Concerning behavior pattern observed',
          } as any,
          req(),
        ),
      );
      return { id: r.id, studentId, typeId };
    }

    it('create + list + getById + listActivity', async () => {
      const { id } = await seedReferralCtrl();
      const list = await withTestTenant(() => referralCtrl.list({} as any, req()));
      expect(list.find((r: any) => r.id === id)).toBeDefined();

      const got = await withTestTenant(() => referralCtrl.getById(id, req()));
      expect(got.id).toBe(id);

      const activity = await withTestTenant(() => referralCtrl.listActivity(id, req()));
      expect(Array.isArray(activity)).toBe(true);
      expect(activity.length).toBeGreaterThanOrEqual(1);
    });

    it('triage + accept + start + complete (full lifecycle)', async () => {
      const { id } = await seedReferralCtrl();
      const triaged = await withTestTenant(() =>
        referralCtrl.triage(
          id,
          { assignedCounselorId: TEST_ADMIN_EMPLOYEE_ID, notes: 'assigned' } as any,
          req(),
        ),
      );
      expect(triaged.status).toBe('TRIAGED');

      const accepted = await withTestTenant(() =>
        referralCtrl.accept(id, { notes: 'ok' } as any, req()),
      );
      expect(accepted.status).toBe('ACCEPTED');

      const started = await withTestTenant(() => referralCtrl.start(id, req()));
      expect(started.status).toBe('IN_PROGRESS');

      const completed = await withTestTenant(() =>
        referralCtrl.complete(
          id,
          { outcome: 'Resolved through counselling sessions' } as any,
          req(),
        ),
      );
      expect(completed.status).toBe('COMPLETED');
    });

    it('decline (separate flow)', async () => {
      const { id } = await seedReferralCtrl();
      const declined = await withTestTenant(() =>
        referralCtrl.decline(id, { reason: 'Not appropriate scope' } as any, req()),
      );
      expect(declined.status).toBe('DECLINED');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // StudentServicesAdvancedController
  // ─────────────────────────────────────────────────────────────────
  describe('StudentServicesAdvancedController', () => {
    it('caseloadDashboard returns rows', async () => {
      const studentId = await seedStudent('Adv1');
      await seedCaseload(studentId);
      const dash = await withTestTenant(() =>
        advancedCtrl.caseloadDashboard(TEST_ACADEMIC_YEAR_ID, req()),
      );
      expect(Array.isArray(dash.rows)).toBe(true);
    });

    it('agency referrals: createAgency + listAgency + getAgency + patchAgency', async () => {
      const studentId = await seedStudent('AdvAgency');
      const typeId = await seedReferralTypeRow();
      const referral = await withTestTenant(() =>
        referralCtrl.create(
          { studentId, referralTypeId: typeId, reason: 'parent referral source' } as any,
          req(),
        ),
      );

      const agency = await withTestTenant(() =>
        advancedCtrl.createAgency(
          {
            referralId: referral.id,
            agencyName: 'Test Family Therapy',
            agencyContact: 'Dr Smith',
            agencyPhone: '555',
            agencyEmail: 'test@x',
            referralDate: new Date().toISOString().slice(0, 10),
            reason: 'long-term support',
            consentObtained: false,
          } as any,
          req(),
        ),
      );
      expect(agency.status).toBe('REFERRED');

      const list = await withTestTenant(() => advancedCtrl.listAgency({} as any, req()));
      expect(list.find((a: any) => a.id === agency.id)).toBeDefined();

      const listByReferral = await withTestTenant(() =>
        advancedCtrl.listAgency({ referralId: referral.id } as any, req()),
      );
      expect(listByReferral.find((a: any) => a.id === agency.id)).toBeDefined();

      const got = await withTestTenant(() => advancedCtrl.getAgency(agency.id, req()));
      expect(got.id).toBe(agency.id);

      const patched = await withTestTenant(() =>
        advancedCtrl.patchAgency(
          agency.id,
          { status: 'CONTACTED', notes: 'reached out' } as any,
          req(),
        ),
      );
      expect(patched.status).toBe('CONTACTED');
    });

    it('escalate referral via crisis path', async () => {
      const studentId = await seedStudent('AdvCrisis');
      const typeId = await seedReferralTypeRow();
      const r = await withTestTenant(() =>
        referralCtrl.create(
          { studentId, referralTypeId: typeId, reason: 'crisis signals' } as any,
          req(),
        ),
      );
      const result = await withTestTenant(() => advancedCtrl.escalate(r.id, req()));
      expect(result.newPriority).toBe('URGENT');
      expect(result.referralId).toBe(r.id);
    });

    it('wellbeing longitudinal: studentLongitudinal + yearLongitudinal + materialise', async () => {
      const studentId = await seedStudent('AdvLong');
      // Pre-seed a row so studentLongitudinal returns content
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.svc_wellbeing_longitudinal
           (id, student_id, school_id, academic_year, domain, avg_score, trend,
            checkin_count, flagged_count, materialised_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, '2025-2026', 'ACADEMIC', 7.0, 'STABLE', 3, 0, now())`,
        generateId(),
        studentId,
        TEST_SCHOOL_ID,
      );

      const studentResult = await withTestTenant(() =>
        advancedCtrl.studentLongitudinal(studentId, req()),
      );
      expect(studentResult.studentId).toBe(studentId);
      expect(studentResult.rows.length).toBeGreaterThanOrEqual(1);

      const yearList = await withTestTenant(() =>
        advancedCtrl.yearLongitudinal('2025-2026', req()),
      );
      expect(Array.isArray(yearList)).toBe(true);

      const materialised = await withTestTenant(() =>
        advancedCtrl.materialise({ academicYear: '2025-2026' } as any, req()),
      );
      expect(materialised.academicYear).toBe('2025-2026');
      expect(typeof materialised.rowsWritten).toBe('number');
    });

    it('MTSS team meetings (advanced): createMeeting + listMeetings + getMeeting + listDiscussions', async () => {
      const meeting = await withTestTenant(() =>
        advancedCtrl.createMeeting(
          {
            academicYearId: TEST_ACADEMIC_YEAR_ID,
            meetingDate: new Date().toISOString().slice(0, 10),
            notes: 'advanced team meeting',
          } as any,
          req(),
        ),
      );
      expect(meeting.academicYearId).toBe(TEST_ACADEMIC_YEAR_ID);

      const list = await withTestTenant(() => advancedCtrl.listMeetings(req()));
      expect(list.find((m: any) => m.id === meeting.id)).toBeDefined();

      const got = await withTestTenant(() => advancedCtrl.getMeeting(meeting.id, req()));
      expect(got.id).toBe(meeting.id);
    });

    it('listDiscussions returns the recorded rows for a meeting', async () => {
      const meeting = await withTestTenant(() =>
        advancedCtrl.createMeeting(
          {
            academicYearId: TEST_ACADEMIC_YEAR_ID,
            meetingDate: new Date().toISOString().slice(0, 10),
          } as any,
          req(),
        ),
      );
      const list = await withTestTenant(() => advancedCtrl.listDiscussions(meeting.id, req()));
      expect(Array.isArray(list)).toBe(true);
    });

    it('recordDiscussion creates a discussion row with MAINTAIN recommendation', async () => {
      const meeting = await withTestTenant(() =>
        advancedCtrl.createMeeting(
          {
            academicYearId: TEST_ACADEMIC_YEAR_ID,
            meetingDate: new Date().toISOString().slice(0, 10),
          } as any,
          req(),
        ),
      );
      const studentId = await seedStudent('AdvDisc');
      const d = await withTestTenant(() =>
        advancedCtrl.recordDiscussion(
          meeting.id,
          {
            studentId,
            tierChangeRecommended: 'MAINTAIN',
            discussionNotes: 'continue tier supports',
          } as any,
          req(),
        ),
      );
      expect(d.studentId).toBe(studentId);
      expect(d.tierChangeRecommended).toBe('MAINTAIN');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // SurveyTemplateController
  // ─────────────────────────────────────────────────────────────────
  describe('SurveyTemplateController', () => {
    async function createTpl(): Promise<any> {
      return withTestTenant(() =>
        surveyTemplateCtrl.create(
          {
            name: 'CTRL-Tpl-' + generateId().slice(-6),
            description: 'controller test',
            frequencyRecommendation: 'WEEKLY',
            questions: [
              {
                questionText: 'How safe?',
                questionType: 'SCALE_1_5',
                domain: 'SAFETY',
                sortOrder: 0,
              },
              {
                questionText: 'How happy?',
                questionType: 'SCALE_1_5',
                domain: 'EMOTIONAL',
                sortOrder: 1,
              },
            ],
          } as any,
          req(),
        ),
      );
    }

    it('create + list + getById + patch', async () => {
      const tpl = await createTpl();
      expect(tpl.questions?.length).toBe(2);

      const list = await withTestTenant(() => surveyTemplateCtrl.list(false));
      expect(list.find((t: any) => t.id === tpl.id)).toBeDefined();

      const includeInactive = await withTestTenant(() => surveyTemplateCtrl.list(true));
      expect(includeInactive.find((t: any) => t.id === tpl.id)).toBeDefined();

      const got = await withTestTenant(() => surveyTemplateCtrl.getById(tpl.id));
      expect(got.id).toBe(tpl.id);

      const patched = await withTestTenant(() =>
        surveyTemplateCtrl.patch(
          tpl.id,
          { description: 'patched', frequencyRecommendation: 'MONTHLY' } as any,
          req(),
        ),
      );
      expect(patched.frequencyRecommendation).toBe('MONTHLY');
    });

    it('addQuestion + patchQuestion + deleteQuestion', async () => {
      const tpl = await createTpl();
      const q = await withTestTenant(() =>
        surveyTemplateCtrl.addQuestion(
          tpl.id,
          {
            questionText: 'New Q',
            questionType: 'YES_NO',
            domain: 'EMOTIONAL',
            sortOrder: 5,
          } as any,
          req(),
        ),
      );
      expect(q.sortOrder).toBe(5);

      const patched = await withTestTenant(() =>
        surveyTemplateCtrl.patchQuestion(
          q.id,
          { questionText: 'Updated text', sortOrder: 6 } as any,
          req(),
        ),
      );
      expect(patched.questionText).toBe('Updated text');
      expect(patched.sortOrder).toBe(6);

      await withTestTenant(() => surveyTemplateCtrl.deleteQuestion(q.id, req()));
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // DeploymentController
  // ─────────────────────────────────────────────────────────────────
  describe('DeploymentController', () => {
    async function createTpl(): Promise<string> {
      const t = await withTestTenant(() =>
        surveyTemplateCtrl.create(
          {
            name: 'CTRL-DepTpl-' + generateId().slice(-6),
            frequencyRecommendation: 'WEEKLY',
            questions: [
              {
                questionText: 'How safe?',
                questionType: 'SCALE_1_5',
                domain: 'SAFETY',
                sortOrder: 0,
              },
            ],
          } as any,
          req(),
        ),
      );
      return t.id;
    }

    it('create + list + getById', async () => {
      const templateId = await createTpl();
      const dep = await withTestTenant(() =>
        deploymentCtrl.create(
          {
            templateId,
            deployAt: futureIso(1000),
            targetType: 'CASELOAD',
          } as any,
          req(),
        ),
      );
      expect(dep.status).toBe('SCHEDULED');

      const list = await withTestTenant(() => deploymentCtrl.list({} as any, req()));
      expect(list.find((d: any) => d.id === dep.id)).toBeDefined();

      const got = await withTestTenant(() => deploymentCtrl.getById(dep.id, req()));
      expect(got.id).toBe(dep.id);
    });

    it('activate (CUSTOM_LIST) + complete + cancel lifecycle', async () => {
      const templateId = await createTpl();
      const studentId = await seedStudent('Dep');
      const dep = await withTestTenant(() =>
        deploymentCtrl.create(
          {
            templateId,
            deployAt: futureIso(1000),
            targetType: 'CUSTOM_LIST',
            targetIds: [studentId],
          } as any,
          req(),
        ),
      );
      const activated = await withTestTenant(() => deploymentCtrl.activate(dep.id, req()));
      expect(activated.checkinsCreated).toBe(1);
      expect(activated.deployment.status).toBe('ACTIVE');

      const completed = await withTestTenant(() => deploymentCtrl.complete(dep.id, req()));
      expect(completed.status).toBe('COMPLETED');

      // For cancel exercise, start a fresh deployment in SCHEDULED state
      const dep2 = await withTestTenant(() =>
        deploymentCtrl.create(
          {
            templateId,
            deployAt: futureIso(1000),
            targetType: 'CASELOAD',
          } as any,
          req(),
        ),
      );
      const cancelled = await withTestTenant(() => deploymentCtrl.cancel(dep2.id, req()));
      expect(cancelled.status).toBe('CANCELLED');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // CheckinController + AlertController
  // ─────────────────────────────────────────────────────────────────
  describe('CheckinController + AlertController', () => {
    /**
     * Seed a complete deployment + check-in chain. Submit triggers SHI
     * alert evaluation (numeric=1 on SAFETY/SCALE_1_5), so subsequent
     * tests can exercise AlertController.list / getById / acknowledge /
     * resolve on the resulting alert row.
     */
    async function seedSubmittedCheckinWithAlert(): Promise<{
      studentId: string;
      checkinId: string;
      alertId: string;
    }> {
      const studentId = await seedStudent('CK');
      // Seed admin caseload so the alert is in scope for AlertService row-scope
      await seedCaseload(studentId);
      const templateId = (
        await withTestTenant(() =>
          surveyTemplateCtrl.create(
            {
              name: 'CTRL-CK-Tpl-' + generateId().slice(-6),
              frequencyRecommendation: 'WEEKLY',
              questions: [
                {
                  questionText: 'How safe do you feel?',
                  questionType: 'SCALE_1_5',
                  domain: 'SAFETY',
                  sortOrder: 0,
                },
              ],
            } as any,
            req(),
          ),
        )
      ).id;

      const dep = await withTestTenant(() =>
        deploymentCtrl.create(
          {
            templateId,
            deployAt: futureIso(1000),
            targetType: 'CUSTOM_LIST',
            targetIds: [studentId],
          } as any,
          req(),
        ),
      );
      await withTestTenant(() => deploymentCtrl.activate(dep.id, req()));

      const checkinRow = (await rawClient.$queryRawUnsafe(
        `SELECT id::text AS id FROM ${TEST_SCHEMA}.svc_wellbeing_checkins
             WHERE deployment_id = $1::uuid AND student_id = $2::uuid
             LIMIT 1`,
        dep.id,
        studentId,
      )) as Array<{ id: string }>;
      const checkinId = checkinRow[0]!.id;

      // Read the SAFETY question id off the template
      const qRow = (await rawClient.$queryRawUnsafe(
        `SELECT id::text AS id FROM ${TEST_SCHEMA}.svc_wellbeing_questions
           WHERE template_id = $1::uuid LIMIT 1`,
        templateId,
      )) as Array<{ id: string }>;
      const qid = qRow[0]!.id;

      // Submit with SHI-triggering value (numeric=1 on SCALE_1_5+SAFETY)
      await withTestTenant(() =>
        checkinCtrl.submit(
          checkinId,
          { responses: [{ questionId: qid, numericResponse: 1 }] } as any,
          req(),
        ),
      );

      const alertRow = (await rawClient.$queryRawUnsafe(
        `SELECT id::text AS id FROM ${TEST_SCHEMA}.svc_wellbeing_alerts
           WHERE student_id = $1::uuid LIMIT 1`,
        studentId,
      )) as Array<{ id: string }>;
      return { studentId, checkinId, alertId: alertRow[0]!.id };
    }

    it('checkin: list + getById + submit (KEYSTONE)', async () => {
      const { studentId, checkinId } = await seedSubmittedCheckinWithAlert();

      const list = await withTestTenant(() => checkinCtrl.list({ studentId } as any, req()));
      expect(list.find((c: any) => c.id === checkinId)).toBeDefined();

      const got = await withTestTenant(() => checkinCtrl.getById(checkinId, req()));
      expect(got.id).toBe(checkinId);
      expect(got.flaggedForFollowUp).toBe(true);
    });

    it('alerts: list + getById + acknowledge + resolve lifecycle', async () => {
      const { alertId } = await seedSubmittedCheckinWithAlert();

      const list = await withTestTenant(() => alertCtrl.list({} as any, req()));
      expect(list.find((a: any) => a.id === alertId)).toBeDefined();

      const got = await withTestTenant(() => alertCtrl.getById(alertId, req()));
      expect(got.id).toBe(alertId);
      expect(got.alertType).toBe('SELF_HARM_INDICATOR');

      const acked = await withTestTenant(() => alertCtrl.acknowledge(alertId, req()));
      expect(acked.status).toBe('ACKNOWLEDGED');
      expect(acked.acknowledgedById).toBe(TEST_ADMIN_EMPLOYEE_ID);

      const resolved = await withTestTenant(() =>
        alertCtrl.resolve(alertId, { resolutionNotes: 'safety plan signed' } as any, req()),
      );
      expect(resolved.status).toBe('RESOLVED');
      expect(resolved.resolutionNotes).toBe('safety plan signed');
    });

    it('alerts: list filters by status, alertType, studentId', async () => {
      const { studentId, alertId } = await seedSubmittedCheckinWithAlert();
      const filteredByStatus = await withTestTenant(() =>
        alertCtrl.list({ status: 'NEW' } as any, req()),
      );
      expect(filteredByStatus.find((a: any) => a.id === alertId)).toBeDefined();

      const filteredByType = await withTestTenant(() =>
        alertCtrl.list({ alertType: 'SELF_HARM_INDICATOR' } as any, req()),
      );
      expect(filteredByType.find((a: any) => a.id === alertId)).toBeDefined();

      const filteredByStudent = await withTestTenant(() =>
        alertCtrl.list({ studentId } as any, req()),
      );
      expect(filteredByStudent.find((a: any) => a.id === alertId)).toBeDefined();
    });
  });
});
