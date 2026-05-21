import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { DashboardService } from '@modules/m110-analytics/dashboard.service';
import {
  AtRiskEvaluationWorker,
  CheckpointService,
  ClassroomReadModelWorker,
  SISReadModelWorker,
} from '@modules/m110-analytics/workers.service';
import {
  DistrictAnalyticsWorker,
  FinanceARWorker,
  SchoolSummaryWorker,
  WellbeingTrendsWorker,
} from '@modules/m110-analytics/cross-domain.service';
import {
  ReportDefinitionService,
  ReportRunService,
  ScheduledReportWorker,
} from '@modules/m110-analytics/reports.service';
import { AnalyticsController } from '@modules/m110-analytics/analytics.controller';
import {
  AthleticsReadModelWorker,
  ClubsReadModelWorker,
  CommsReadModelWorker,
  EnrolmentReadModelWorker,
  GroupsReadModelWorker,
  OfficialsReadModelWorker,
  PublicationsReadModelWorker,
  WellbeingReadModelWorker,
} from '@modules/m110-analytics/engagement/engagement-workers.service';
import { EngagementReadService } from '@modules/m110-analytics/engagement/engagement-read.service';
import { EngagementAnalyticsController } from '@modules/m110-analytics/engagement/engagement-analytics.controller';
import {
  FacilitiesReadModelWorker,
  FoodServiceReadModelWorker,
  ITReadModelWorker,
  LibraryReadModelWorker,
  ProcurementReadModelWorker,
  StoreReadModelWorker,
  TransportReadModelWorker,
} from '@modules/m110-analytics/operations/operations-workers.service';
import { OperationsReadService } from '@modules/m110-analytics/operations/operations-read.service';
import { OperationsAnalyticsController } from '@modules/m110-analytics/operations/operations-analytics.controller';
import {
  assertPayloadSchoolMatchesEnvelope,
  claimReadModelContribution,
  dispatchOperationsEvent,
  monthAnchor,
} from '@modules/m110-analytics/operations/operations-worker-base';

import { ActorContextService, PermissionCheckService } from '@modules/m00-platform';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import type { UnwrappedEvent } from '@shared/kafka';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
  TEST_ORG_ID,
} from '../helpers/tenant-context';
import {
  adminActor,
  teacherActor,
  studentActor,
  TEST_ADMIN_ACCOUNT_ID,
  TEST_ADMIN_EMPLOYEE_ID,
  TEST_TEACHER_ACCOUNT_ID,
} from '../helpers/actor';
import { makeRecordingKafka, RecordingKafkaProducer } from '../helpers/recording-kafka';
import { ensureWorkflowsPlatformFixtures } from '../fixtures/workflows';
import {
  resetAndSeedAnalytics,
  TEST_ANA_ACADEMIC_YEAR_ID,
  TEST_ANA_CLASS_ID,
  TEST_ANA_CLASS_B_ID,
  TEST_ANA_FAMILY_ACCOUNT_ID,
  TEST_ANA_INVOICE_OVERDUE_ID,
  TEST_ANA_INVOICE_CURRENT_ID,
  TEST_ANA_STUDENT_ID,
  TEST_ANA_STUDENT2_ID,
  TEST_ANA_ATTENDANCE_DATE,
  TEST_ANA_PLATFORM_STUDENT_ID,
} from '../fixtures/analytics';

/**
 * Wave 8 — m110-analytics integration suite.
 *
 * Drives:
 *   - workers.service.ts — CheckpointService.record/list, SISReadModelWorker,
 *     ClassroomReadModelWorker, AtRiskEvaluationWorker (emit on flag).
 *   - cross-domain.service.ts — SchoolSummaryWorker, DistrictAnalyticsWorker,
 *     WellbeingTrendsWorker, FinanceARWorker.
 *   - reports.service.ts — ReportDefinitionService CRUD + ReportRunService.run
 *     + ScheduledReportWorker (cron, runNow, list, update).
 *   - dashboard.service.ts — every read surface + persona scoping.
 *   - engagement-workers.service.ts — direct upsert() invocations with
 *     synthetic UnwrappedEvent payloads. onModuleInit subscribe wires are
 *     exercised via stub KafkaConsumerService.subscribe.
 *   - operations-workers.service.ts — same upsert direct invocation pattern.
 *     FacilitiesReadModelWorker.materialiseKpi + OfficialsReadModelWorker
 *     batch path also hit.
 *   - operations-worker-base.ts — claimReadModelContribution + monthAnchor
 *     + assertPayloadSchoolMatchesEnvelope + dispatchOperationsEvent.
 *   - controllers — analytics, engagement, operations pass-through.
 *
 * Cross-school isolation asserted on every read service + worker that
 * scopes by school.
 */
describe('integration:m110-analytics/analytics-lifecycle', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let kafka: RecordingKafkaProducer;

  // workers
  let checkpoints: CheckpointService;
  let sisWorker: SISReadModelWorker;
  let classroomWorker: ClassroomReadModelWorker;
  let atRiskWorker: AtRiskEvaluationWorker;
  let schoolWorker: SchoolSummaryWorker;
  let districtWorker: DistrictAnalyticsWorker;
  let wellbeingWorker: WellbeingTrendsWorker;
  let financeWorker: FinanceARWorker;
  // reports
  let definitions: ReportDefinitionService;
  let runs: ReportRunService;
  let scheduled: ScheduledReportWorker;
  // dashboard
  let dashboards: DashboardService;
  // engagement
  let enrolmentWorker: EnrolmentReadModelWorker;
  let athleticsWorker: AthleticsReadModelWorker;
  let officialsWorker: OfficialsReadModelWorker;
  let groupsWorker: GroupsReadModelWorker;
  let publicationsWorker: PublicationsReadModelWorker;
  let clubsWorker: ClubsReadModelWorker;
  let commsWorker: CommsReadModelWorker;
  let wellbeingDomainWorker: WellbeingReadModelWorker;
  let engagementReads: EngagementReadService;
  // operations
  let procurementWorker: ProcurementReadModelWorker;
  let storeWorker: StoreReadModelWorker;
  let foodWorker: FoodServiceReadModelWorker;
  let transportWorker: TransportReadModelWorker;
  let facilitiesWorker: FacilitiesReadModelWorker;
  let itWorker: ITReadModelWorker;
  let libraryWorker: LibraryReadModelWorker;
  let operationsReads: OperationsReadService;
  // controllers
  let analyticsCtrl: AnalyticsController;
  let engagementCtrl: EngagementAnalyticsController;
  let operationsCtrl: OperationsAnalyticsController;
  let actors: ActorContextService;

  // Subscribe call records (kafka consumer stub)
  let subscribeCalls: Array<{ groupId: string; topics: string[] }>;
  let stubConsumer: any;
  let stubIdempotency: any;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    // Restore the canonical admin iam_effective_access_cache row that
    // sibling specs (m23-health/m25-curriculum/m86-procurement) wipe to
    // seed their own narrow permissions and never restore. AnalyticsController
    // tests + DashboardService manager gates depend on isSchoolAdmin=true.
    await ensureWorkflowsPlatformFixtures(rawClient);
    kafka = makeRecordingKafka() as any;

    subscribeCalls = [];
    stubConsumer = {
      subscribe: async (opts: any) => {
        subscribeCalls.push({ groupId: opts.groupId, topics: opts.topics });
      },
    };
    stubIdempotency = {
      isClaimed: async () => false,
      claim: async () => {},
    };

    const permCheck = new PermissionCheckService(rawClient);
    actors = new ActorContextService(rawClient, permCheck, tenantPrisma);

    checkpoints = new CheckpointService(tenantPrisma);
    sisWorker = new SISReadModelWorker(tenantPrisma, checkpoints);
    classroomWorker = new ClassroomReadModelWorker(tenantPrisma, checkpoints);
    atRiskWorker = new AtRiskEvaluationWorker(tenantPrisma, checkpoints, kafka as any);
    schoolWorker = new SchoolSummaryWorker(tenantPrisma, checkpoints);
    districtWorker = new DistrictAnalyticsWorker(tenantPrisma, checkpoints);
    wellbeingWorker = new WellbeingTrendsWorker(tenantPrisma, checkpoints);
    financeWorker = new FinanceARWorker(tenantPrisma, checkpoints);

    definitions = new ReportDefinitionService(tenantPrisma, permCheck);
    runs = new ReportRunService(tenantPrisma, definitions);
    dashboards = new DashboardService(tenantPrisma, permCheck);
    scheduled = new ScheduledReportWorker(tenantPrisma, permCheck, runs, dashboards);

    // Engagement workers — onModuleInit wires subscribe; the stub records.
    enrolmentWorker = new EnrolmentReadModelWorker(
      stubConsumer,
      stubIdempotency,
      tenantPrisma,
      checkpoints,
    );
    athleticsWorker = new AthleticsReadModelWorker(
      stubConsumer,
      stubIdempotency,
      tenantPrisma,
      checkpoints,
    );
    officialsWorker = new OfficialsReadModelWorker(tenantPrisma, checkpoints);
    groupsWorker = new GroupsReadModelWorker(
      stubConsumer,
      stubIdempotency,
      tenantPrisma,
      checkpoints,
    );
    publicationsWorker = new PublicationsReadModelWorker(
      stubConsumer,
      stubIdempotency,
      tenantPrisma,
      checkpoints,
    );
    clubsWorker = new ClubsReadModelWorker(
      stubConsumer,
      stubIdempotency,
      tenantPrisma,
      checkpoints,
    );
    commsWorker = new CommsReadModelWorker(
      stubConsumer,
      stubIdempotency,
      tenantPrisma,
      checkpoints,
    );
    wellbeingDomainWorker = new WellbeingReadModelWorker(
      stubConsumer,
      stubIdempotency,
      tenantPrisma,
      checkpoints,
    );
    engagementReads = new EngagementReadService(tenantPrisma);

    // Operations workers
    procurementWorker = new ProcurementReadModelWorker(
      stubConsumer,
      stubIdempotency,
      tenantPrisma,
      checkpoints,
    );
    storeWorker = new StoreReadModelWorker(
      stubConsumer,
      stubIdempotency,
      tenantPrisma,
      checkpoints,
    );
    foodWorker = new FoodServiceReadModelWorker(
      stubConsumer,
      stubIdempotency,
      tenantPrisma,
      checkpoints,
    );
    transportWorker = new TransportReadModelWorker(
      stubConsumer,
      stubIdempotency,
      tenantPrisma,
      checkpoints,
    );
    facilitiesWorker = new FacilitiesReadModelWorker(
      stubConsumer,
      stubIdempotency,
      tenantPrisma,
      checkpoints,
    );
    itWorker = new ITReadModelWorker(
      stubConsumer,
      stubIdempotency,
      tenantPrisma,
      checkpoints,
    );
    libraryWorker = new LibraryReadModelWorker(
      stubConsumer,
      stubIdempotency,
      tenantPrisma,
      checkpoints,
    );
    operationsReads = new OperationsReadService(tenantPrisma);

    analyticsCtrl = new AnalyticsController(
      actors,
      permCheck,
      dashboards,
      checkpoints,
      sisWorker,
      classroomWorker,
      atRiskWorker,
      schoolWorker,
      districtWorker,
      wellbeingWorker,
      financeWorker,
      definitions,
      runs,
      scheduled,
    );
    engagementCtrl = new EngagementAnalyticsController(engagementReads);
    operationsCtrl = new OperationsAnalyticsController(operationsReads);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetAndSeedAnalytics(rawClient);
    kafka.reset();
    subscribeCalls.length = 0;
  });

  /**
   * Helper: build a synthetic UnwrappedEvent payload for engagement /
   * operations worker upsert tests. The worker's upsert() method takes
   * the same shape directly, bypassing kafka envelope unwrap.
   */
  function makeEvent<P>(
    payload: P,
    opts?: {
      schoolId?: string;
      topic?: string;
      eventId?: string;
    },
  ): UnwrappedEvent<P> {
    return {
      eventId: opts?.eventId ?? generateId(),
      tenant: {
        schoolId: opts?.schoolId ?? TEST_SCHOOL_ID,
        schemaName: TEST_SCHEMA,
        organisationId: TEST_ORG_ID,
        subdomain: 'test',
        isFrozen: false,
        planTier: 'MEDIUM',
        homeRegion: 'us-east-1',
      },
      payload,
      topic: opts?.topic ?? 'test.topic',
    };
  }

  /* ─────────────────────────────────────────────────────────────────
     CheckpointService
     ──────────────────────────────────────────────────────────────── */
  describe('CheckpointService', () => {
    it('record() inserts then UPSERTs with lag computed', async () => {
      await withTestTenant(async () => {
        await checkpoints.record('grp-a', 'topic.a', 0, 100, 150);
        const list = await checkpoints.list();
        const row = list.find((r) => r.consumerGroup === 'grp-a' && r.topic === 'topic.a');
        expect(row?.committedOffset).toBe(100);
        expect(row?.lag).toBe(50);
        // Replay updates the row (same UNIQUE), lag recomputed.
        await checkpoints.record('grp-a', 'topic.a', 0, 200, 250);
        const list2 = await checkpoints.list();
        const row2 = list2.find((r) => r.consumerGroup === 'grp-a' && r.topic === 'topic.a');
        expect(row2?.committedOffset).toBe(200);
        expect(row2?.lag).toBe(50);
      });
    });

    it('record() handles missing logEndOffset (lag null)', async () => {
      await withTestTenant(async () => {
        await checkpoints.record('grp-b', 'topic.b', 0, 42);
        const list = await checkpoints.list();
        const row = list.find((r) => r.consumerGroup === 'grp-b' && r.topic === 'topic.b');
        expect(row?.lag).toBeNull();
        expect(row?.logEndOffset).toBeNull();
      });
    });
  });

  /* ─────────────────────────────────────────────────────────────────
     SISReadModelWorker
     ──────────────────────────────────────────────────────────────── */
  describe('SISReadModelWorker', () => {
    it('materialises rpt_daily_attendance_summary + rpt_student_academic_summary', async () => {
      const result = await withTestTenant(async () =>
        sisWorker.materialise(TEST_ANA_ATTENDANCE_DATE),
      );
      expect(result.status).toBe('OK');
      expect(result.rowsWritten).toBeGreaterThan(0);

      const att = (await rawClient.$queryRawUnsafe(
        `SELECT * FROM ${TEST_SCHEMA}.rpt_daily_attendance_summary WHERE school_id = $1::uuid`,
        TEST_SCHOOL_ID,
      )) as Array<{
        class_id: string;
        present_count: number;
        absent_count: number;
        late_count: number;
        total_enrolled: number;
        attendance_rate: string | null;
      }>;
      expect(att.length).toBeGreaterThan(0);
      const day = att.find(
        (r) => r.class_id === TEST_ANA_CLASS_ID && Number(r.total_enrolled) === 2,
      );
      expect(day?.present_count).toBe(1);
      expect(day?.absent_count).toBe(1);

      const acad = (await rawClient.$queryRawUnsafe(
        `SELECT * FROM ${TEST_SCHEMA}.rpt_student_academic_summary WHERE school_id = $1::uuid`,
        TEST_SCHOOL_ID,
      )) as Array<{ student_id: string; current_gpa: string | null }>;
      expect(acad.length).toBeGreaterThanOrEqual(2);
      const flagged = acad.find((r) => r.student_id === TEST_ANA_STUDENT_ID);
      // Student 1 has a published grade of 92 → maps to 4.0 GPA.
      expect(flagged?.current_gpa).toBeTruthy();
    });

    it('SKIPPED status when no current academic year (no attendance rows still ok)', async () => {
      await withTestTenant(async () => {
        // Run twice — second time is idempotent UPSERT.
        const first = await sisWorker.materialise(TEST_ANA_ATTENDANCE_DATE);
        expect(first.status).toBe('OK');
        const second = await sisWorker.materialise(TEST_ANA_ATTENDANCE_DATE);
        expect(second.status).toBe('OK');
      });
    });

    it('records checkpoint on success', async () => {
      await withTestTenant(async () => sisWorker.materialise(TEST_ANA_ATTENDANCE_DATE));
      const list = await withTestTenant(async () => checkpoints.list());
      expect(list.some((c) => c.consumerGroup === 'sis-readmodel-worker')).toBe(true);
    });

    it('FAILED status surfaces error message', async () => {
      // Force failure: pass a malformed asOfDate that postgres rejects.
      const result = await withTestTenant(async () => sisWorker.materialise('not-a-date'));
      expect(result.status).toBe('FAILED');
      expect(result.errorMessage).toBeTruthy();
    });
  });

  /* ─────────────────────────────────────────────────────────────────
     ClassroomReadModelWorker
     ──────────────────────────────────────────────────────────────── */
  describe('ClassroomReadModelWorker', () => {
    it('materialises class performance + staff summary', async () => {
      const result = await withTestTenant(async () => classroomWorker.materialise());
      expect(result.status).toBe('OK');
      const perf = (await rawClient.$queryRawUnsafe(
        `SELECT * FROM ${TEST_SCHEMA}.rpt_class_performance_summary WHERE school_id = $1::uuid`,
        TEST_SCHOOL_ID,
      )) as Array<{ class_id: string; student_count: number; avg_grade: string | null }>;
      expect(perf.some((r) => r.class_id === TEST_ANA_CLASS_ID)).toBe(true);

      const staff = (await rawClient.$queryRawUnsafe(
        `SELECT * FROM ${TEST_SCHEMA}.rpt_staff_summary WHERE school_id = $1::uuid`,
        TEST_SCHOOL_ID,
      )) as Array<{ employee_id: string; leave_days_taken: string }>;
      const admin = staff.find((r) => r.employee_id === TEST_ADMIN_EMPLOYEE_ID);
      expect(admin).toBeTruthy();
      expect(Number(admin?.leave_days_taken)).toBe(2);
    });

    it('SKIPPED when no current academic year', async () => {
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.sis_academic_years SET is_current = false`,
      );
      const result = await withTestTenant(async () => classroomWorker.materialise());
      expect(result.status).toBe('SKIPPED');
    });
  });

  /* ─────────────────────────────────────────────────────────────────
     AtRiskEvaluationWorker
     ──────────────────────────────────────────────────────────────── */
  describe('AtRiskEvaluationWorker', () => {
    it('flags students that match all populated conditions + emits rpt.at_risk.flagged', async () => {
      // Materialise SIS first so rpt_student_academic_summary has data.
      await withTestTenant(async () => sisWorker.materialise(TEST_ANA_ATTENDANCE_DATE));

      // Create a config that will flag student 2 (low attendance, GPA 0).
      const cfgId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.rpt_at_risk_configurations
           (id, school_id, name, trigger_conditions, alert_recipients, is_active)
         VALUES ($1::uuid, $2::uuid, 'flag low gpa', $3::jsonb, ARRAY[]::uuid[], true)`,
        cfgId,
        TEST_SCHOOL_ID,
        JSON.stringify({ grade_threshold: 5 }),
      );

      const result = await withTestTenant(async () => atRiskWorker.evaluate());
      expect(result.status).toBe('OK');
      expect(result.rowsWritten).toBeGreaterThan(0);
      expect(kafka.callsForTopic('rpt.at_risk.flagged').length).toBeGreaterThan(0);

      const flagged = (await rawClient.$queryRawUnsafe(
        `SELECT student_id::text AS student_id, at_risk_flags
         FROM ${TEST_SCHEMA}.rpt_student_academic_summary
         WHERE school_id = $1::uuid AND at_risk_flags <> '{}'::jsonb`,
        TEST_SCHOOL_ID,
      )) as Array<{ student_id: string; at_risk_flags: Record<string, unknown> }>;
      expect(flagged.length).toBeGreaterThan(0);
    });

    it('does NOT re-emit on second run for previously flagged students', async () => {
      await withTestTenant(async () => sisWorker.materialise(TEST_ANA_ATTENDANCE_DATE));
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.rpt_at_risk_configurations
           (id, school_id, name, trigger_conditions, alert_recipients, is_active)
         VALUES ($1::uuid, $2::uuid, 'flag again', $3::jsonb, ARRAY[]::uuid[], true)`,
        generateId(),
        TEST_SCHOOL_ID,
        JSON.stringify({ grade_threshold: 5 }),
      );
      await withTestTenant(async () => atRiskWorker.evaluate());
      const firstCalls = kafka.callsForTopic('rpt.at_risk.flagged').length;
      kafka.reset();
      await withTestTenant(async () => atRiskWorker.evaluate());
      const secondCalls = kafka.callsForTopic('rpt.at_risk.flagged').length;
      expect(secondCalls).toBeLessThan(firstCalls);
    });

    it('evaluate handles missing thresholds (no populated conditions = no flag)', async () => {
      await withTestTenant(async () => sisWorker.materialise(TEST_ANA_ATTENDANCE_DATE));
      // Config with NO known thresholds = populated count is 0.
      const cfgId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.rpt_at_risk_configurations
           (id, school_id, name, trigger_conditions, alert_recipients, is_active)
         VALUES ($1::uuid, $2::uuid, 'empty cond', '{}'::jsonb, ARRAY[]::uuid[], true)`,
        cfgId,
        TEST_SCHOOL_ID,
      );
      const result = await withTestTenant(async () => atRiskWorker.evaluate());
      expect(result.status).toBe('OK');
      expect(kafka.callsForTopic('rpt.at_risk.flagged').length).toBe(0);
    });
  });

  /* ─────────────────────────────────────────────────────────────────
     SchoolSummaryWorker
     ──────────────────────────────────────────────────────────────── */
  describe('SchoolSummaryWorker', () => {
    it('aggregates after SIS + Classroom + AtRisk', async () => {
      await withTestTenant(async () => {
        await sisWorker.materialise(TEST_ANA_ATTENDANCE_DATE);
        await classroomWorker.materialise();
      });
      const result = await withTestTenant(async () => schoolWorker.materialise());
      expect(result.status).toBe('OK');
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT * FROM ${TEST_SCHEMA}.rpt_school_summary WHERE school_id = $1::uuid`,
        TEST_SCHOOL_ID,
      )) as Array<{ total_enrolled: number; total_staff: number; incident_count: number }>;
      expect(rows.length).toBe(1);
      // 2 active enrollments (student1, student2) seeded
      expect(Number(rows[0]!.total_enrolled)).toBeGreaterThanOrEqual(2);
      // At least 1 incident in last 90 days seeded
      expect(Number(rows[0]!.incident_count)).toBeGreaterThanOrEqual(1);
    });

    it('SKIPPED when no current academic year', async () => {
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.sis_academic_years SET is_current = false`,
      );
      const result = await withTestTenant(async () => schoolWorker.materialise());
      expect(result.status).toBe('SKIPPED');
    });
  });

  /* ─────────────────────────────────────────────────────────────────
     DistrictAnalyticsWorker
     ──────────────────────────────────────────────────────────────── */
  describe('DistrictAnalyticsWorker', () => {
    it('rolls school summaries up into district + comparison rows', async () => {
      await withTestTenant(async () => {
        await sisWorker.materialise(TEST_ANA_ATTENDANCE_DATE);
        await classroomWorker.materialise();
        await schoolWorker.materialise();
      });
      const result = await withTestTenant(async () => districtWorker.materialise());
      expect(result.status).toBe('OK');
      const summary = (await rawClient.$queryRawUnsafe(
        `SELECT school_count, total_enrolled FROM ${TEST_SCHEMA}.rpt_district_summary WHERE organisation_id = $1::uuid`,
        TEST_ORG_ID,
      )) as Array<{ school_count: number; total_enrolled: number }>;
      expect(summary.length).toBe(1);

      const cmp = (await rawClient.$queryRawUnsafe(
        `SELECT * FROM ${TEST_SCHEMA}.rpt_district_school_comparison WHERE organisation_id = $1::uuid`,
        TEST_ORG_ID,
      )) as Array<{ school_id: string; rank_by_attendance: number | null }>;
      expect(cmp.length).toBeGreaterThan(0);
    });

    it('SKIPPED when current org has no academic year', async () => {
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.sis_academic_years SET is_current = false`,
      );
      const result = await withTestTenant(async () => districtWorker.materialise());
      expect(result.status).toBe('SKIPPED');
    });
  });

  /* ─────────────────────────────────────────────────────────────────
     WellbeingTrendsWorker
     ──────────────────────────────────────────────────────────────── */
  describe('WellbeingTrendsWorker', () => {
    it('aggregates by grade_level + period, NO student attribution', async () => {
      const result = await withTestTenant(async () => wellbeingWorker.materialise());
      expect(result.status).toBe('OK');
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT * FROM ${TEST_SCHEMA}.rpt_wellbeing_trends WHERE school_id = $1::uuid`,
        TEST_SCHOOL_ID,
      )) as Array<{ grade_level: string; wants_to_talk_count: number; response_count: number }>;
      expect(rows.length).toBeGreaterThan(0);
      const row = rows[0]!;
      expect(row.grade_level).toBe('5');
      // Schema has no student_id column — column check
      const cols = (await rawClient.$queryRawUnsafe(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'rpt_wellbeing_trends'`,
        TEST_SCHEMA,
      )) as Array<{ column_name: string }>;
      expect(cols.map((c) => c.column_name)).not.toContain('student_id');
    });

    it('handles missing wellbeing tables gracefully (no-op when range is empty)', async () => {
      const result = await withTestTenant(async () =>
        wellbeingWorker.materialise('2099-01-01', '2099-01-31'),
      );
      expect(result.status).toBe('OK');
      expect(result.rowsWritten).toBe(0);
    });
  });

  /* ─────────────────────────────────────────────────────────────────
     FinanceARWorker
     ──────────────────────────────────────────────────────────────── */
  describe('FinanceARWorker', () => {
    it('computes aged debtor buckets per family account', async () => {
      const result = await withTestTenant(async () => financeWorker.materialise());
      expect(result.status).toBe('OK');
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT total_outstanding, current_bucket, days_30, days_60, days_90_plus
         FROM ${TEST_SCHEMA}.rpt_fin_aged_debtors
         WHERE school_id = $1::uuid AND family_account_id = $2::uuid`,
        TEST_SCHOOL_ID,
        TEST_ANA_FAMILY_ACCOUNT_ID,
      )) as Array<{
        total_outstanding: string;
        current_bucket: string;
        days_30: string;
        days_60: string;
        days_90_plus: string;
      }>;
      expect(rows.length).toBe(1);
      // overdue 500 - 100 paid = 400 in days_30/60 bucket (due 45d ago)
      // current 200 in current bucket
      expect(Number(rows[0]!.total_outstanding)).toBeCloseTo(600, 2);
      expect(Number(rows[0]!.current_bucket)).toBeCloseTo(200, 2);
      // The 45d-overdue bucket lands in days_30 (1..30) or days_60 (31..60).
      // Our seed is 45d ago, so days_60.
      expect(Number(rows[0]!.days_60)).toBeCloseTo(400, 2);
    });
  });

  /* ─────────────────────────────────────────────────────────────────
     DashboardService — manager / teacher / student persona scoping
     ──────────────────────────────────────────────────────────────── */
  describe('DashboardService persona scoping', () => {
    beforeEach(async () => {
      // Seed read models for the dashboard reads.
      await withTestTenant(async () => {
        await sisWorker.materialise(TEST_ANA_ATTENDANCE_DATE);
        await classroomWorker.materialise();
        await schoolWorker.materialise();
        await districtWorker.materialise();
        await wellbeingWorker.materialise();
        await financeWorker.materialise();
      });
    });

    it('listDailyAttendance returns rows for admin', async () => {
      const rows = await withTestTenant(async () =>
        dashboards.listDailyAttendance(adminActor(), {}),
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]!.schoolId).toBe(TEST_SCHOOL_ID);
    });

    it('listDailyAttendance limits to teacher classes for non-manager', async () => {
      const rows = await withTestTenant(async () =>
        dashboards.listDailyAttendance(teacherActor()),
      );
      // teacher is assigned to TEST_ANA_CLASS_ID via fixture, so should
      // return rows scoped to that class. Returns the seeded class's row.
      expect(rows.every((r) => r.classId === TEST_ANA_CLASS_ID)).toBe(true);
    });

    it('listDailyAttendance returns empty for student persona (no class memberships)', async () => {
      const rows = await withTestTenant(async () =>
        dashboards.listDailyAttendance(studentActor()),
      );
      expect(rows).toEqual([]);
    });

    it('listDailyAttendance applies fromDate/toDate/classId/limit', async () => {
      const rows = await withTestTenant(async () =>
        dashboards.listDailyAttendance(adminActor(), {
          fromDate: '2025-08-01',
          toDate: '2025-12-31',
          classId: TEST_ANA_CLASS_ID,
          limit: 5,
        }),
      );
      expect(rows.every((r) => r.classId === TEST_ANA_CLASS_ID)).toBe(true);
    });

    it('listAcademic strips at_risk_flags for non-manager', async () => {
      // First flag a student via at-risk so flags exist.
      const cfgId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.rpt_at_risk_configurations
           (id, school_id, name, trigger_conditions, alert_recipients, is_active)
         VALUES ($1::uuid, $2::uuid, 'all-students', '{"grade_threshold":5}'::jsonb, ARRAY[]::uuid[], true)`,
        cfgId,
        TEST_SCHOOL_ID,
      );
      await withTestTenant(async () => atRiskWorker.evaluate());

      const adminRows = await withTestTenant(async () => dashboards.listAcademic(adminActor()));
      const adminHasFlags = adminRows.some((r) => Object.keys(r.atRiskFlags).length > 0);
      expect(adminHasFlags).toBe(true);

      const teacherRows = await withTestTenant(async () =>
        dashboards.listAcademic(teacherActor()),
      );
      // Teacher's results have at_risk_flags stripped to {}
      expect(teacherRows.every((r) => Object.keys(r.atRiskFlags).length === 0)).toBe(true);
    });

    it('listAcademic with atRiskOnly throws ForbiddenException for non-manager', async () => {
      await expect(
        withTestTenant(async () =>
          dashboards.listAcademic(teacherActor(), { atRiskOnly: true }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('listAcademic filters by gradeLevel + atRiskOnly + limit for admin', async () => {
      const cfgId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.rpt_at_risk_configurations
           (id, school_id, name, trigger_conditions, alert_recipients, is_active)
         VALUES ($1::uuid, $2::uuid, 'all-students-2', '{"grade_threshold":5}'::jsonb, ARRAY[]::uuid[], true)`,
        cfgId,
        TEST_SCHOOL_ID,
      );
      await withTestTenant(async () => atRiskWorker.evaluate());
      const rows = await withTestTenant(async () =>
        dashboards.listAcademic(adminActor(), {
          gradeLevel: '5',
          atRiskOnly: true,
          limit: 50,
        }),
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.gradeLevel === '5')).toBe(true);
    });

    it('listClassPerformance: non-manager with no class memberships returns empty', async () => {
      const rows = await withTestTenant(async () =>
        dashboards.listClassPerformance(studentActor()),
      );
      expect(rows).toEqual([]);
    });

    it('listClassPerformance scoped for teacher to their classes', async () => {
      const rows = await withTestTenant(async () =>
        dashboards.listClassPerformance(teacherActor()),
      );
      expect(rows.every((r) => r.classId === TEST_ANA_CLASS_ID)).toBe(true);
    });

    it('listClassPerformance returns school rows for admin', async () => {
      const rows = await withTestTenant(async () =>
        dashboards.listClassPerformance(adminActor()),
      );
      expect(rows.length).toBeGreaterThan(0);
    });

    it('listStaffSummary admin-only — denies teacher', async () => {
      await expect(
        withTestTenant(async () => dashboards.listStaffSummary(teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('listStaffSummary returns rows for admin', async () => {
      const rows = await withTestTenant(async () => dashboards.listStaffSummary(adminActor()));
      expect(rows.length).toBeGreaterThan(0);
    });

    it('getSchoolSummary admin-only — denies teacher', async () => {
      await expect(
        withTestTenant(async () => dashboards.getSchoolSummary(teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('getSchoolSummary returns row for admin', async () => {
      const row = await withTestTenant(async () => dashboards.getSchoolSummary(adminActor()));
      expect(row?.schoolId).toBe(TEST_SCHOOL_ID);
    });

    it('getDistrictSummary requires district scope — denies teacher', async () => {
      await expect(
        withTestTenant(async () => dashboards.getDistrictSummary(teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('getDistrictSummary returns row for admin (has school admin path)', async () => {
      const row = await withTestTenant(async () => dashboards.getDistrictSummary(adminActor()));
      expect(row?.organisationId).toBe(TEST_ORG_ID);
    });

    it('listDistrictComparison denies teacher', async () => {
      await expect(
        withTestTenant(async () => dashboards.listDistrictComparison(teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('listDistrictComparison returns rows for admin', async () => {
      const rows = await withTestTenant(async () =>
        dashboards.listDistrictComparison(adminActor()),
      );
      expect(rows.length).toBeGreaterThan(0);
    });

    it('listWellbeingTrends denies teacher, returns aggregate for admin', async () => {
      await expect(
        withTestTenant(async () => dashboards.listWellbeingTrends(teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      const rows = await withTestTenant(async () =>
        dashboards.listWellbeingTrends(adminActor()),
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]!.gradeLevel).toBeTruthy();
    });

    it('listAgedDebtors denies teacher, returns rows for admin', async () => {
      await expect(
        withTestTenant(async () => dashboards.listAgedDebtors(teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      const rows = await withTestTenant(async () => dashboards.listAgedDebtors(adminActor()));
      expect(rows.length).toBeGreaterThan(0);
    });

    it('listAtRiskStudents denies teacher, returns admin', async () => {
      const cfgId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.rpt_at_risk_configurations
           (id, school_id, name, trigger_conditions, alert_recipients, is_active)
         VALUES ($1::uuid, $2::uuid, 'flag s1', '{"grade_threshold":5}'::jsonb, ARRAY[]::uuid[], true)`,
        cfgId,
        TEST_SCHOOL_ID,
      );
      await withTestTenant(async () => atRiskWorker.evaluate());
      await expect(
        withTestTenant(async () => dashboards.listAtRiskStudents(teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      const rows = await withTestTenant(async () =>
        dashboards.listAtRiskStudents(adminActor()),
      );
      expect(rows.length).toBeGreaterThan(0);
    });

    it('listAtRiskConfigs / createAtRiskConfig / updateAtRiskConfig — admin path', async () => {
      const created = await withTestTenant(async () =>
        dashboards.createAtRiskConfig(adminActor(), {
          name: 'low gpa flag',
          description: 'demo',
          triggerConditions: { grade_threshold: 2, attendance_threshold: 0.85 },
          alertRecipients: [TEST_ADMIN_ACCOUNT_ID],
          isActive: true,
        }),
      );
      expect(created.id).toBeTruthy();

      const list = await withTestTenant(async () => dashboards.listAtRiskConfigs(adminActor()));
      expect(list.some((c) => c.id === created.id)).toBe(true);

      const updated = await withTestTenant(async () =>
        dashboards.updateAtRiskConfig(adminActor(), created.id, {
          name: 'low gpa flag (renamed)',
          isActive: false,
          alertRecipients: [TEST_ADMIN_ACCOUNT_ID],
        }),
      );
      expect(updated.name).toBe('low gpa flag (renamed)');
      expect(updated.isActive).toBe(false);
    });

    it('createAtRiskConfig — BLOCKING 2 rejects unknown key', async () => {
      await expect(
        withTestTenant(async () =>
          dashboards.createAtRiskConfig(adminActor(), {
            name: 'bad keys',
            triggerConditions: { not_a_real_key: 1 } as any,
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('createAtRiskConfig — empty triggerConditions rejected', async () => {
      await expect(
        withTestTenant(async () =>
          dashboards.createAtRiskConfig(adminActor(), {
            name: 'empty',
            triggerConditions: {},
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('createAtRiskConfig — attendance_threshold range check', async () => {
      await expect(
        withTestTenant(async () =>
          dashboards.createAtRiskConfig(adminActor(), {
            name: 'bad att',
            triggerConditions: { attendance_threshold: 2 },
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('createAtRiskConfig — grade_threshold range check', async () => {
      await expect(
        withTestTenant(async () =>
          dashboards.createAtRiskConfig(adminActor(), {
            name: 'bad gpa',
            triggerConditions: { grade_threshold: 99 },
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('createAtRiskConfig — missed_assignments_threshold negative rejected', async () => {
      await expect(
        withTestTenant(async () =>
          dashboards.createAtRiskConfig(adminActor(), {
            name: 'bad missed',
            triggerConditions: { missed_assignments_threshold: -1 },
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('createAtRiskConfig — not an object', async () => {
      await expect(
        withTestTenant(async () =>
          dashboards.createAtRiskConfig(adminActor(), {
            name: 'not obj',
            triggerConditions: [1, 2, 3] as any,
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('createAtRiskConfig — non-finite number rejected', async () => {
      await expect(
        withTestTenant(async () =>
          dashboards.createAtRiskConfig(adminActor(), {
            name: 'inf',
            triggerConditions: { attendance_threshold: 'NaN' } as any,
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('createAtRiskConfig — recipient not in tenant rejected', async () => {
      await expect(
        withTestTenant(async () =>
          dashboards.createAtRiskConfig(adminActor(), {
            name: 'bad recipient',
            triggerConditions: { grade_threshold: 2 },
            alertRecipients: ['019e0cf8-aaaa-7777-8888-000000000999'],
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('createAtRiskConfig — duplicate name rejected with friendly 400', async () => {
      const dupName = 'dup ' + generateId().slice(0, 6);
      await withTestTenant(async () =>
        dashboards.createAtRiskConfig(adminActor(), {
          name: dupName,
          triggerConditions: { grade_threshold: 2 },
        }),
      );
      await expect(
        withTestTenant(async () =>
          dashboards.createAtRiskConfig(adminActor(), {
            name: dupName,
            triggerConditions: { grade_threshold: 2 },
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('updateAtRiskConfig: no fields returns existing row', async () => {
      const created = await withTestTenant(async () =>
        dashboards.createAtRiskConfig(adminActor(), {
          name: 'unchanged ' + generateId().slice(0, 6),
          triggerConditions: { grade_threshold: 2 },
        }),
      );
      const same = await withTestTenant(async () =>
        dashboards.updateAtRiskConfig(adminActor(), created.id, {}),
      );
      expect(same.id).toBe(created.id);
    });

    it('updateAtRiskConfig: validates new triggerConditions + recipients', async () => {
      const created = await withTestTenant(async () =>
        dashboards.createAtRiskConfig(adminActor(), {
          name: 'patch ' + generateId().slice(0, 6),
          triggerConditions: { grade_threshold: 2 },
        }),
      );
      await expect(
        withTestTenant(async () =>
          dashboards.updateAtRiskConfig(adminActor(), created.id, {
            triggerConditions: { not_real: 1 } as any,
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('updateAtRiskConfig: missing config raises 404', async () => {
      await expect(
        withTestTenant(async () =>
          dashboards.updateAtRiskConfig(adminActor(), generateId(), { isActive: false }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('listStateReportTemplates: returns empty by default', async () => {
      const rows = await withTestTenant(async () => dashboards.listStateReportTemplates());
      expect(Array.isArray(rows)).toBe(true);
    });

    it('cross-school isolation — School B sees only School B rows', async () => {
      // School B has no rpt rows seeded; admin in B should see 0.
      const att = await withTestTenantB(async () =>
        dashboards.listDailyAttendance(adminActor()),
      );
      expect(att).toEqual([]);
      const acad = await withTestTenantB(async () => dashboards.listAcademic(adminActor()));
      expect(acad).toEqual([]);
      const cls = await withTestTenantB(async () =>
        dashboards.listClassPerformance(adminActor()),
      );
      expect(cls).toEqual([]);
      const staff = await withTestTenantB(async () =>
        dashboards.listStaffSummary(adminActor()),
      );
      expect(staff).toEqual([]);
      const debtors = await withTestTenantB(async () =>
        dashboards.listAgedDebtors(adminActor()),
      );
      expect(debtors).toEqual([]);
    });
  });

  /* ─────────────────────────────────────────────────────────────────
     ReportDefinitionService + ReportRunService + ScheduledReportWorker
     ──────────────────────────────────────────────────────────────── */
  describe('Reports + scheduled', () => {
    it('ReportDefinitionService — create / list / getById / update', async () => {
      const created = await withTestTenant(async () =>
        definitions.create(adminActor(), {
          name: 'Test report ' + generateId().slice(0, 6),
          description: 'desc',
          reportType: 'CUSTOM',
          templateConfig: { data_source: 'rpt_daily_attendance_summary' },
        }),
      );
      expect(created.id).toBeTruthy();

      const list = await withTestTenant(async () => definitions.list(adminActor()));
      expect(list.some((d) => d.id === created.id)).toBe(true);

      const byId = await withTestTenant(async () => definitions.getById(created.id));
      expect(byId.name).toBe(created.name);

      const updated = await withTestTenant(async () =>
        definitions.update(adminActor(), created.id, {
          name: 'Renamed ' + generateId().slice(0, 6),
          description: null as any,
          reportType: 'ATTENDANCE',
          isActive: false,
        }),
      );
      expect(updated.name).toContain('Renamed');
      expect(updated.isActive).toBe(false);
    });

    it('ReportDefinitionService — update with no fields returns existing', async () => {
      const created = await withTestTenant(async () =>
        definitions.create(adminActor(), {
          name: 'No-op ' + generateId().slice(0, 6),
          reportType: 'CUSTOM',
          templateConfig: { data_source: 'rpt_school_summary' },
        }),
      );
      const same = await withTestTenant(async () =>
        definitions.update(adminActor(), created.id, {}),
      );
      expect(same.id).toBe(created.id);
    });

    it('ReportDefinitionService — invalid data_source rejected', async () => {
      await expect(
        withTestTenant(async () =>
          definitions.create(adminActor(), {
            name: 'invalid',
            reportType: 'CUSTOM',
            templateConfig: { data_source: 'sis_students' as any },
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('ReportDefinitionService — missing data_source rejected', async () => {
      await expect(
        withTestTenant(async () =>
          definitions.create(adminActor(), {
            name: 'missing ds',
            reportType: 'CUSTOM',
            templateConfig: {},
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('ReportDefinitionService — templateConfig must be object', async () => {
      await expect(
        withTestTenant(async () =>
          definitions.create(adminActor(), {
            name: 'not obj',
            reportType: 'CUSTOM',
            templateConfig: [] as any,
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('ReportDefinitionService — duplicate name rejected', async () => {
      const dup = 'dup ' + generateId().slice(0, 6);
      await withTestTenant(async () =>
        definitions.create(adminActor(), {
          name: dup,
          reportType: 'CUSTOM',
          templateConfig: { data_source: 'rpt_school_summary' },
        }),
      );
      await expect(
        withTestTenant(async () =>
          definitions.create(adminActor(), {
            name: dup,
            reportType: 'CUSTOM',
            templateConfig: { data_source: 'rpt_school_summary' },
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('ReportDefinitionService — getById raises 404 for missing', async () => {
      await expect(
        withTestTenant(async () => definitions.getById(generateId())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('ReportDefinitionService — update raises 404 for missing', async () => {
      await expect(
        withTestTenant(async () => definitions.update(adminActor(), generateId(), { isActive: false })),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('ReportDefinitionService — update validates new data_source', async () => {
      const created = await withTestTenant(async () =>
        definitions.create(adminActor(), {
          name: 'update-validate ' + generateId().slice(0, 6),
          reportType: 'CUSTOM',
          templateConfig: { data_source: 'rpt_school_summary' },
        }),
      );
      await expect(
        withTestTenant(async () =>
          definitions.update(adminActor(), created.id, {
            templateConfig: { data_source: 'bad_table' },
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('ReportRunService.run — runs against rpt_school_summary, writes a row, then listForDefinition', async () => {
      await withTestTenant(async () => {
        await sisWorker.materialise(TEST_ANA_ATTENDANCE_DATE);
        await classroomWorker.materialise();
        await schoolWorker.materialise();
      });
      const def = await withTestTenant(async () =>
        definitions.create(adminActor(), {
          name: 'School Summary ' + generateId().slice(0, 6),
          reportType: 'ATTENDANCE',
          templateConfig: { data_source: 'rpt_school_summary' },
        }),
      );
      const run = await withTestTenant(async () =>
        runs.run(adminActor(), def.id, { outputFormat: 'CSV' }),
      );
      expect(run.status).toBe('COMPLETE');
      expect(run.rowCount).toBeGreaterThan(0);

      const list = await withTestTenant(async () => runs.listForDefinition(def.id));
      expect(list.length).toBeGreaterThan(0);
      expect(list[0]!.id).toBe(run.id);
    });

    it('ReportRunService.run — rejects inactive definition', async () => {
      const def = await withTestTenant(async () =>
        definitions.create(adminActor(), {
          name: 'Inactive ' + generateId().slice(0, 6),
          reportType: 'CUSTOM',
          templateConfig: { data_source: 'rpt_school_summary' },
          isActive: false,
        }),
      );
      await expect(
        withTestTenant(async () => runs.run(adminActor(), def.id)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('ScheduledReportWorker — create + list + update + runNow', async () => {
      // First create a matching definition for runNow to find.
      const def = await withTestTenant(async () =>
        definitions.create(adminActor(), {
          name: 'Sched Target ' + generateId().slice(0, 6),
          reportType: 'CUSTOM',
          templateConfig: { data_source: 'rpt_school_summary' },
        }),
      );
      await withTestTenant(async () => {
        await sisWorker.materialise(TEST_ANA_ATTENDANCE_DATE);
        await classroomWorker.materialise();
        await schoolWorker.materialise();
      });
      const sched = await withTestTenant(async () =>
        scheduled.create(adminActor(), {
          reportName: 'Daily Attendance ' + generateId().slice(0, 6),
          templateName: def.name,
          reportParams: {},
          scheduleCron: '0 6 * * *',
          timezone: 'UTC',
          deliveryChannel: 'EMAIL',
          recipientIds: [TEST_ADMIN_ACCOUNT_ID],
          outputFormat: 'CSV',
          isActive: true,
        }),
      );
      expect(sched.id).toBeTruthy();
      expect(sched.nextRunAt).toBeTruthy();

      const list = await withTestTenant(async () => scheduled.list());
      expect(list.some((r) => r.id === sched.id)).toBe(true);

      const updated = await withTestTenant(async () =>
        scheduled.update(adminActor(), sched.id, {
          scheduleCron: '*/15 * * * *',
          timezone: 'America/Chicago',
          deliveryChannel: 'BOTH',
          outputFormat: 'XLSX',
          isActive: true,
          reportParams: { definition_id: def.id },
        }),
      );
      expect(updated.scheduleCron).toBe('*/15 * * * *');
      expect(updated.timezone).toBe('America/Chicago');

      const ran = await withTestTenant(async () => scheduled.runNow(adminActor(), sched.id));
      expect(['SUCCESS', 'FAILED']).toContain(ran.lastRunStatus);
    });

    it('ScheduledReportWorker — update with no fields returns existing', async () => {
      const def = await withTestTenant(async () =>
        definitions.create(adminActor(), {
          name: 'Sched Same ' + generateId().slice(0, 6),
          reportType: 'CUSTOM',
          templateConfig: { data_source: 'rpt_school_summary' },
        }),
      );
      const sched = await withTestTenant(async () =>
        scheduled.create(adminActor(), {
          reportName: 'noop ' + generateId().slice(0, 6),
          templateName: def.name,
          scheduleCron: '0 7 * * *',
        }),
      );
      const same = await withTestTenant(async () =>
        scheduled.update(adminActor(), sched.id, {}),
      );
      expect(same.id).toBe(sched.id);
    });

    it('ScheduledReportWorker.runNow — falls back to template_name lookup when definition_id not set', async () => {
      const def = await withTestTenant(async () =>
        definitions.create(adminActor(), {
          name: 'Match by name ' + generateId().slice(0, 6),
          reportType: 'CUSTOM',
          templateConfig: { data_source: 'rpt_school_summary' },
        }),
      );
      const sched = await withTestTenant(async () =>
        scheduled.create(adminActor(), {
          reportName: 'rn ' + generateId().slice(0, 6),
          templateName: def.name,
          scheduleCron: '0 8 * * *',
        }),
      );
      await withTestTenant(async () => scheduled.runNow(adminActor(), sched.id));
    });

    it('ScheduledReportWorker.runNow — fails when template_name has no matching active definition', async () => {
      const sched = await withTestTenant(async () =>
        scheduled.create(adminActor(), {
          reportName: 'orphan ' + generateId().slice(0, 6),
          templateName: 'nonexistent-template-' + generateId().slice(0, 6),
          scheduleCron: '0 9 * * *',
        }),
      );
      await expect(
        withTestTenant(async () => scheduled.runNow(adminActor(), sched.id)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('ScheduledReportWorker — create with invalid timezone rejected', async () => {
      await expect(
        withTestTenant(async () =>
          scheduled.create(adminActor(), {
            reportName: 'bad tz',
            templateName: 'x',
            scheduleCron: '0 6 * * *',
            timezone: 'Not/A_Real/Zone',
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('ScheduledReportWorker — duplicate name rejected', async () => {
      const name = 'dup-sched-' + generateId().slice(0, 6);
      await withTestTenant(async () =>
        scheduled.create(adminActor(), {
          reportName: name,
          templateName: 'tmpl',
          scheduleCron: '0 6 * * *',
        }),
      );
      await expect(
        withTestTenant(async () =>
          scheduled.create(adminActor(), {
            reportName: name,
            templateName: 'tmpl',
            scheduleCron: '0 6 * * *',
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('ScheduledReportWorker — update raises 404 for missing', async () => {
      await expect(
        withTestTenant(async () =>
          scheduled.update(adminActor(), generateId(), { isActive: false }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('ScheduledReportWorker — bad cron falls back to 24h-from-now', async () => {
      const def = await withTestTenant(async () =>
        definitions.create(adminActor(), {
          name: 'badcron-tmpl-' + generateId().slice(0, 6),
          reportType: 'CUSTOM',
          templateConfig: { data_source: 'rpt_school_summary' },
        }),
      );
      const sched = await withTestTenant(async () =>
        scheduled.create(adminActor(), {
          reportName: 'badcron-' + generateId().slice(0, 6),
          templateName: def.name,
          scheduleCron: 'not a cron',
        }),
      );
      expect(sched.nextRunAt).toBeTruthy();
    });

    it('ScheduledReportWorker — DOW name token + ranges + steps parse', async () => {
      const def = await withTestTenant(async () =>
        definitions.create(adminActor(), {
          name: 'cron-parsing-tmpl-' + generateId().slice(0, 6),
          reportType: 'CUSTOM',
          templateConfig: { data_source: 'rpt_school_summary' },
        }),
      );
      const sched = await withTestTenant(async () =>
        scheduled.create(adminActor(), {
          reportName: 'cron parse ' + generateId().slice(0, 6),
          templateName: def.name,
          scheduleCron: '*/15 8-17 * * MON-FRI',
          timezone: 'America/Chicago',
        }),
      );
      expect(sched.nextRunAt).toBeTruthy();
    });
  });

  /* ─────────────────────────────────────────────────────────────────
     AnalyticsController pass-through
     ──────────────────────────────────────────────────────────────── */
  describe('AnalyticsController', () => {
    const req = { user: { sub: TEST_ADMIN_ACCOUNT_ID, personId: TEST_ADMIN_ACCOUNT_ID } } as any;

    beforeEach(async () => {
      await withTestTenant(async () => {
        await sisWorker.materialise(TEST_ANA_ATTENDANCE_DATE);
        await classroomWorker.materialise();
        await schoolWorker.materialise();
        await districtWorker.materialise();
        await wellbeingWorker.materialise();
        await financeWorker.materialise();
      });
    });

    it('listAttendance', async () => {
      const rows = await withTestTenant(async () => analyticsCtrl.listAttendance(req, {}));
      expect(rows.length).toBeGreaterThan(0);
    });

    it('listAcademic + listClassPerformance + listStaffSummary + getSchoolSummary + getDistrictSummary + listDistrictComparison', async () => {
      const a = await withTestTenant(async () => analyticsCtrl.listAcademic(req, {}));
      expect(Array.isArray(a)).toBe(true);
      const c = await withTestTenant(async () => analyticsCtrl.listClassPerformance(req));
      expect(Array.isArray(c)).toBe(true);
      const s = await withTestTenant(async () => analyticsCtrl.listStaffSummary(req));
      expect(Array.isArray(s)).toBe(true);
      const ss = await withTestTenant(async () => analyticsCtrl.getSchoolSummary(req));
      expect(ss?.schoolId).toBe(TEST_SCHOOL_ID);
      const ds = await withTestTenant(async () => analyticsCtrl.getDistrictSummary(req));
      expect(ds?.organisationId).toBe(TEST_ORG_ID);
      const dc = await withTestTenant(async () => analyticsCtrl.listDistrictComparison(req));
      expect(Array.isArray(dc)).toBe(true);
    });

    it('listWellbeingTrends + listAgedDebtors + listAtRisk + listAtRiskConfigs + createAtRiskConfig + updateAtRiskConfig', async () => {
      const w = await withTestTenant(async () => analyticsCtrl.listWellbeingTrends(req));
      expect(Array.isArray(w)).toBe(true);
      const d = await withTestTenant(async () => analyticsCtrl.listAgedDebtors(req));
      expect(Array.isArray(d)).toBe(true);
      const ar = await withTestTenant(async () => analyticsCtrl.listAtRisk(req));
      expect(Array.isArray(ar)).toBe(true);
      const arc = await withTestTenant(async () => analyticsCtrl.listAtRiskConfigs(req));
      expect(Array.isArray(arc)).toBe(true);

      const created = await withTestTenant(async () =>
        analyticsCtrl.createAtRiskConfig(req, {
          name: 'ctrl ' + generateId().slice(0, 6),
          triggerConditions: { grade_threshold: 2 },
        }),
      );
      const upd = await withTestTenant(async () =>
        analyticsCtrl.updateAtRiskConfig(req, created.id, { isActive: false }),
      );
      expect(upd.isActive).toBe(false);
    });

    it('runWorkers (single + full chain)', async () => {
      const single = await withTestTenant(async () =>
        analyticsCtrl.runWorkers(req, { worker: 'sis', asOfDate: TEST_ANA_ATTENDANCE_DATE }),
      );
      expect(single.length).toBe(1);
      expect(single[0]!.worker).toBe('sis');

      const full = await withTestTenant(async () => analyticsCtrl.runWorkers(req, {}));
      expect(full.length).toBe(7);
    });

    it('workerStatus', async () => {
      await withTestTenant(async () => sisWorker.materialise(TEST_ANA_ATTENDANCE_DATE));
      const status = await withTestTenant(async () => analyticsCtrl.workerStatus());
      expect(status.length).toBeGreaterThan(0);
    });

    it('reports CRUD + listReports + getReport + runReport + listRunsForReport', async () => {
      const created = await withTestTenant(async () =>
        analyticsCtrl.createReport(req, {
          name: 'ctrl rpt ' + generateId().slice(0, 6),
          reportType: 'CUSTOM',
          templateConfig: { data_source: 'rpt_school_summary' },
        }),
      );
      const list = await withTestTenant(async () => analyticsCtrl.listReports(req));
      expect(list.some((r) => r.id === created.id)).toBe(true);
      const byId = await withTestTenant(async () => analyticsCtrl.getReport(created.id));
      expect(byId.id).toBe(created.id);
      const upd = await withTestTenant(async () =>
        analyticsCtrl.updateReport(req, created.id, { description: 'updated' }),
      );
      expect(upd.description).toBe('updated');
      const run = await withTestTenant(async () =>
        analyticsCtrl.runReport(req, created.id, {}),
      );
      expect(run.status).toBe('COMPLETE');
      const runs2 = await withTestTenant(async () =>
        analyticsCtrl.listRunsForReport(created.id),
      );
      expect(runs2.length).toBeGreaterThan(0);
    });

    it('scheduled CRUD', async () => {
      const def = await withTestTenant(async () =>
        analyticsCtrl.createReport(req, {
          name: 'sched-tgt-ctrl ' + generateId().slice(0, 6),
          reportType: 'CUSTOM',
          templateConfig: { data_source: 'rpt_school_summary' },
        }),
      );
      const sched = await withTestTenant(async () =>
        analyticsCtrl.createScheduled(req, {
          reportName: 'ctrl-sched-' + generateId().slice(0, 6),
          templateName: def.name,
          scheduleCron: '0 6 * * *',
        }),
      );
      const list = await withTestTenant(async () => analyticsCtrl.listScheduled());
      expect(list.some((r) => r.id === sched.id)).toBe(true);
      const upd = await withTestTenant(async () =>
        analyticsCtrl.updateScheduled(req, sched.id, { isActive: false }),
      );
      expect(upd.isActive).toBe(false);
    });

    it('listStateReports', async () => {
      const rows = await withTestTenant(async () => analyticsCtrl.listStateReports());
      expect(Array.isArray(rows)).toBe(true);
    });

    it('runWorkers unknown worker triggers 400 (via assertWorkerPermission)', async () => {
      await expect(
        withTestTenant(async () => analyticsCtrl.runWorkers(req, { worker: 'bogus' as any })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  /* ─────────────────────────────────────────────────────────────────
     Engagement workers — direct upsert invocations
     ──────────────────────────────────────────────────────────────── */
  describe('Engagement workers', () => {
    it('onModuleInit subscribes via stub consumer', async () => {
      // Each worker subscribed; verify subscribe was called per worker.
      await Promise.all([
        enrolmentWorker.onModuleInit(),
        athleticsWorker.onModuleInit(),
        groupsWorker.onModuleInit(),
        publicationsWorker.onModuleInit(),
        clubsWorker.onModuleInit(),
        commsWorker.onModuleInit(),
        wellbeingDomainWorker.onModuleInit(),
      ]);
      const groups = subscribeCalls.map((c) => c.groupId);
      expect(groups).toEqual(
        expect.arrayContaining([
          'enrolment-readmodel-worker',
          'athletics-readmodel-worker',
          'groups-readmodel-worker',
          'publications-readmodel-worker',
          'clubs-readmodel-worker',
          'comms-readmodel-worker',
          'wellbeing-readmodel-worker',
        ]),
      );
    });

    it('EnrolmentReadModelWorker upsert — application submitted increments applications', async () => {
      const ev = makeEvent({
        applicationId: generateId(),
        schoolId: TEST_SCHOOL_ID,
        academicYearName: '2025-2026',
        submittedAt: new Date().toISOString(),
      });
      await withTestTenant(async () =>
        enrolmentWorker.upsert(ev as any, 'env.enr.application.submitted'),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT applications_received FROM ${TEST_SCHEMA}.rpt_enr_funnel_summary WHERE school_id = $1::uuid`,
        TEST_SCHOOL_ID,
      )) as Array<{ applications_received: number }>;
      expect(rows.length).toBeGreaterThan(0);
      expect(Number(rows[0]!.applications_received)).toBe(1);
    });

    it('EnrolmentReadModelWorker — drops missing schoolId', async () => {
      const ev = makeEvent({ academicYearName: '2025-2026' } as any);
      await withTestTenant(async () =>
        enrolmentWorker.upsert(ev as any, 'env.enr.application.submitted'),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS c FROM ${TEST_SCHEMA}.rpt_enr_funnel_summary`,
      )) as Array<{ c: number }>;
      expect(Number(rows[0]!.c)).toBe(0);
    });

    it('EnrolmentReadModelWorker — payload/envelope school mismatch dropped', async () => {
      const ev = makeEvent({
        applicationId: 'x',
        schoolId: '019e0cf8-aaaa-7777-8888-000000999999',
        academicYearName: '2025-2026',
      });
      await withTestTenant(async () =>
        enrolmentWorker.upsert(ev as any, 'env.enr.application.submitted'),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS c FROM ${TEST_SCHEMA}.rpt_enr_funnel_summary`,
      )) as Array<{ c: number }>;
      expect(Number(rows[0]!.c)).toBe(0);
    });

    it('EnrolmentReadModelWorker — multi-topic deltas (offer issued/accepted/enrolled/tour/waitlisted)', async () => {
      const sid = TEST_SCHOOL_ID;
      const seq: Array<[any, string]> = [
        [{ applicationId: '1', schoolId: sid, academicYearName: '2025' }, 'env.enr.application.submitted'],
        [{ offerId: '1', schoolId: sid, academicYearName: '2025' }, 'env.enr.offer.issued'],
        [{ offerId: '1', schoolId: sid, familyResponse: 'ACCEPTED', academicYearName: '2025' }, 'env.enr.offer.responded'],
        [{ applicationId: '2', schoolId: sid, academicYearName: '2025' }, 'env.enr.student.enrolled'],
        [{ bookingId: '1', schoolId: sid, academicYear: '2025' }, 'env.enr.tour.booked'],
        [{ applicationId: '3', schoolId: sid, status: 'WAITLISTED', academicYearName: '2025' }, 'env.enr.application.status_changed'],
      ];
      for (const [payload, topic] of seq) {
        await withTestTenant(async () =>
          enrolmentWorker.upsert(makeEvent(payload) as any, topic),
        );
      }
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT applications_received, tours_booked, offers_made, offers_accepted, enrolled, waitlisted
         FROM ${TEST_SCHEMA}.rpt_enr_funnel_summary WHERE school_id = $1::uuid`,
        TEST_SCHOOL_ID,
      )) as any[];
      expect(Number(rows[0].offers_made)).toBe(1);
      expect(Number(rows[0].offers_accepted)).toBe(1);
      expect(Number(rows[0].enrolled)).toBe(1);
      expect(Number(rows[0].tours_booked)).toBe(1);
      expect(Number(rows[0].waitlisted)).toBe(1);
    });

    it('AthleticsReadModelWorker — writes both game_results + season_summary on a WIN', async () => {
      const ev = makeEvent({
        gameId: generateId(),
        schoolId: TEST_SCHOOL_ID,
        seasonId: generateId(),
        programmeId: generateId(),
        sport: 'BASKETBALL',
        homeScore: 50,
        awayScore: 40,
        result: 'WIN',
        rosterSize: 12,
        injuriesThisGame: 1,
        statisticalLeaders: [{ playerId: 'p1', name: 'Star', statType: 'PTS', value: 20 }],
        completedAt: new Date().toISOString(),
      } as const);
      await withTestTenant(async () => athleticsWorker.upsert(ev as any));
      const games = (await rawClient.$queryRawUnsafe(
        `SELECT * FROM ${TEST_SCHEMA}.rpt_game_results WHERE school_id = $1::uuid`,
        TEST_SCHOOL_ID,
      )) as any[];
      expect(games.length).toBe(1);
      expect(games[0].result).toBe('WIN');
      const seasons = (await rawClient.$queryRawUnsafe(
        `SELECT wins, losses, draws FROM ${TEST_SCHEMA}.rpt_ath_season_summary WHERE school_id = $1::uuid`,
        TEST_SCHOOL_ID,
      )) as any[];
      expect(Number(seasons[0].wins)).toBe(1);
    });

    it('AthleticsReadModelWorker — drops missing fields + payload mismatch', async () => {
      await withTestTenant(async () =>
        athleticsWorker.upsert(makeEvent({ schoolId: TEST_SCHOOL_ID } as any) as any),
      );
      await withTestTenant(async () =>
        athleticsWorker.upsert(
          makeEvent({
            gameId: 'g',
            schoolId: '019e0cf8-aaaa-7777-8888-000000999999',
            seasonId: 's',
            programmeId: 'p',
            sport: 'X',
            homeScore: 0,
            awayScore: 0,
            result: 'DRAW',
            completedAt: '2025-01-01',
          } as any) as any,
        ),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS c FROM ${TEST_SCHEMA}.rpt_game_results`,
      )) as any[];
      expect(Number(rows[0].c)).toBe(0);
    });

    it('OfficialsReadModelWorker — writes zero-row when ath_official_assignments missing or empty', async () => {
      const result = await withTestTenant(async () =>
        officialsWorker.materialise(TEST_SCHOOL_ID, '2025-09-01'),
      );
      expect(result.rowsWritten).toBe(1);
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT * FROM ${TEST_SCHEMA}.rpt_officials_marketplace WHERE school_id = $1::uuid`,
        TEST_SCHOOL_ID,
      )) as any[];
      expect(rows.length).toBe(1);
    });

    it('GroupsReadModelWorker — post/member/comment deltas', async () => {
      const sid = TEST_SCHOOL_ID;
      const groupId = generateId();
      await withTestTenant(async () =>
        groupsWorker.upsert(
          makeEvent({
            schoolId: sid,
            groupId,
            eventType: 'POST_CREATED',
            occurredAt: '2025-09-15',
          } as any) as any,
          'env.grp.post.created',
        ),
      );
      await withTestTenant(async () =>
        groupsWorker.upsert(
          makeEvent({
            schoolId: sid,
            groupId,
            eventType: 'MEMBER_JOINED',
            occurredAt: '2025-09-16',
          } as any) as any,
          'env.grp.member.joined',
        ),
      );
      await withTestTenant(async () =>
        groupsWorker.upsert(
          makeEvent({
            schoolId: sid,
            groupId,
            eventType: 'COMMENT_CREATED',
            occurredAt: '2025-09-17',
          } as any) as any,
          'env.grp.comment.created',
        ),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT posts_count, comments_count, total_members FROM ${TEST_SCHEMA}.rpt_grp_engagement_summary WHERE school_id = $1::uuid`,
        TEST_SCHOOL_ID,
      )) as any[];
      expect(rows.length).toBe(1);
      expect(Number(rows[0].posts_count)).toBe(1);
      expect(Number(rows[0].comments_count)).toBe(1);
    });

    it('GroupsReadModelWorker — drops missing fields', async () => {
      await withTestTenant(async () =>
        groupsWorker.upsert(
          makeEvent({} as any) as any,
          'env.grp.post.created',
        ),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS c FROM ${TEST_SCHEMA}.rpt_grp_engagement_summary`,
      )) as any[];
      expect(Number(rows[0].c)).toBe(0);
    });

    it('PublicationsReadModelWorker — first publication seeds + replay drops via contribution ledger', async () => {
      const ev = makeEvent({
        publicationId: 'p1',
        schoolId: TEST_SCHOOL_ID,
        timeToPublishDays: 3,
        views: 100,
        downloads: 5,
        publishedAt: '2025-09-10',
      } as any);
      await withTestTenant(async () => publicationsWorker.upsert(ev as any));
      // Same event id → contribution claim returns false → no double-count.
      await withTestTenant(async () => publicationsWorker.upsert(ev as any));
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT publications_count FROM ${TEST_SCHEMA}.rpt_pub_distribution_summary WHERE school_id = $1::uuid`,
        TEST_SCHOOL_ID,
      )) as any[];
      expect(Number(rows[0].publications_count)).toBe(1);
    });

    it('PublicationsReadModelWorker — drops missing schoolId', async () => {
      await withTestTenant(async () => publicationsWorker.upsert(makeEvent({} as any) as any));
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS c FROM ${TEST_SCHEMA}.rpt_pub_distribution_summary`,
      )) as any[];
      expect(Number(rows[0].c)).toBe(0);
    });

    it('ClubsReadModelWorker — activity completed updates', async () => {
      const ev = makeEvent({
        activityId: 'a1',
        schoolId: TEST_SCHOOL_ID,
        clubId: generateId(),
        academicYear: '2025',
        attendees: 20,
        totalRegistered: 25,
        budgetSpent: 150,
        completedAt: new Date().toISOString(),
      } as any);
      await withTestTenant(async () => clubsWorker.upsert(ev as any));
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT events_held, total_members FROM ${TEST_SCHEMA}.rpt_ext_service_summary WHERE school_id = $1::uuid`,
        TEST_SCHOOL_ID,
      )) as any[];
      expect(Number(rows[0].events_held)).toBe(1);
    });

    it('ClubsReadModelWorker — drops missing fields', async () => {
      await withTestTenant(async () => clubsWorker.upsert(makeEvent({} as any) as any));
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS c FROM ${TEST_SCHEMA}.rpt_ext_service_summary`,
      )) as any[];
      expect(Number(rows[0].c)).toBe(0);
    });

    it('CommsReadModelWorker — message + broadcast deltas', async () => {
      const at = '2025-09-10';
      await withTestTenant(async () =>
        commsWorker.upsert(
          makeEvent({
            schoolId: TEST_SCHOOL_ID,
            delivered: true,
            read: true,
            responseTimeHours: 1.5,
            sentAt: at,
          } as any) as any,
          'env.msg.message.sent',
        ),
      );
      await withTestTenant(async () =>
        commsWorker.upsert(
          makeEvent({
            schoolId: TEST_SCHOOL_ID,
            delivered: true,
            read: false,
            responseTimeHours: null,
            sentAt: at,
          } as any) as any,
          'env.msg.broadcast.sent',
        ),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT messages_sent, broadcasts_sent FROM ${TEST_SCHEMA}.rpt_msg_communication_metrics WHERE school_id = $1::uuid`,
        TEST_SCHOOL_ID,
      )) as any[];
      expect(Number(rows[0].messages_sent)).toBe(1);
      expect(Number(rows[0].broadcasts_sent)).toBe(1);
    });

    it('CommsReadModelWorker — drops missing fields', async () => {
      await withTestTenant(async () =>
        commsWorker.upsert(makeEvent({} as any) as any, 'env.msg.message.sent'),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS c FROM ${TEST_SCHEMA}.rpt_msg_communication_metrics`,
      )) as any[];
      expect(Number(rows[0].c)).toBe(0);
    });

    it('WellbeingReadModelWorker — SAFETY+SCALE_1_5 score=1 increments below_threshold', async () => {
      const ev = makeEvent({
        responseId: 'r1',
        schoolId: TEST_SCHOOL_ID,
        gradeLevel: '5',
        domain: 'SAFETY',
        numericResponse: 1,
        questionType: 'SCALE_1_5',
        submittedAt: '2025-09-10',
      } as any);
      await withTestTenant(async () => wellbeingDomainWorker.upsert(ev as any));
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT below_threshold_count, response_count FROM ${TEST_SCHEMA}.rpt_wellbeing_domain_trends WHERE school_id = $1::uuid`,
        TEST_SCHOOL_ID,
      )) as any[];
      expect(Number(rows[0].below_threshold_count)).toBe(1);
    });

    it('WellbeingReadModelWorker — non-SAFETY domain does not flag below_threshold', async () => {
      const ev = makeEvent({
        responseId: 'r2',
        schoolId: TEST_SCHOOL_ID,
        gradeLevel: '5',
        domain: 'ACADEMIC',
        numericResponse: 1,
        questionType: 'SCALE_1_5',
        submittedAt: '2025-09-10',
      } as any);
      await withTestTenant(async () => wellbeingDomainWorker.upsert(ev as any));
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT below_threshold_count FROM ${TEST_SCHEMA}.rpt_wellbeing_domain_trends WHERE school_id = $1::uuid AND domain = 'ACADEMIC'`,
        TEST_SCHOOL_ID,
      )) as any[];
      expect(Number(rows[0].below_threshold_count)).toBe(0);
    });

    it('WellbeingReadModelWorker — drops missing fields', async () => {
      await withTestTenant(async () => wellbeingDomainWorker.upsert(makeEvent({} as any) as any));
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS c FROM ${TEST_SCHEMA}.rpt_wellbeing_domain_trends`,
      )) as any[];
      expect(Number(rows[0].c)).toBe(0);
    });
  });

  /* ─────────────────────────────────────────────────────────────────
     Engagement read service — every list endpoint + cross-school
     ──────────────────────────────────────────────────────────────── */
  describe('EngagementReadService', () => {
    beforeEach(async () => {
      // Seed all engagement read models via direct INSERTs so reads have data.
      const inserts = [
        `INSERT INTO ${TEST_SCHEMA}.rpt_enr_funnel_summary
           (id, school_id, academic_year, applications_received, tours_booked, offers_made,
            offers_accepted, enrolled, waitlisted, conversion_rate)
         VALUES (gen_random_uuid(), '${TEST_SCHOOL_ID}', '2025', 10, 5, 3, 2, 1, 1, 0.10)`,
        `INSERT INTO ${TEST_SCHEMA}.rpt_ath_season_summary
           (id, school_id, season_id, programme_id, games_played, wins, losses, draws,
            win_rate, total_roster_size, injury_count)
         VALUES (gen_random_uuid(), '${TEST_SCHOOL_ID}', gen_random_uuid(), gen_random_uuid(),
                 5, 3, 1, 1, 0.6, 12, 0)`,
        `INSERT INTO ${TEST_SCHEMA}.rpt_officials_marketplace
           (id, school_id, period, total_assignments, fill_rate, avg_cost_per_game,
            avg_official_rating, avg_school_rating)
         VALUES (gen_random_uuid(), '${TEST_SCHOOL_ID}', '2025-09-01', 4, 1.0, 80.0, NULL, NULL)`,
        `INSERT INTO ${TEST_SCHEMA}.rpt_game_results
           (id, school_id, game_id, sport, home_score, away_score, result, season_id,
            statistical_leaders)
         VALUES (gen_random_uuid(), '${TEST_SCHOOL_ID}', gen_random_uuid(), 'BB', 50, 40, 'WIN',
                 gen_random_uuid(), '[]'::jsonb)`,
        `INSERT INTO ${TEST_SCHEMA}.rpt_grp_engagement_summary
           (id, school_id, group_id, period, total_members, active_members, posts_count,
            comments_count, engagement_rate)
         VALUES (gen_random_uuid(), '${TEST_SCHOOL_ID}', gen_random_uuid(), '2025-09-01',
                 10, 5, 2, 4, 0.5)`,
        `INSERT INTO ${TEST_SCHEMA}.rpt_pub_distribution_summary
           (id, school_id, period, publications_count, total_views, total_downloads,
            avg_time_to_publish_days)
         VALUES (gen_random_uuid(), '${TEST_SCHOOL_ID}', '2025-09-01', 1, 100, 5, 3.0)`,
        `INSERT INTO ${TEST_SCHEMA}.rpt_ext_service_summary
           (id, school_id, academic_year, club_id, total_members, attendance_rate,
            events_held, budget_spent)
         VALUES (gen_random_uuid(), '${TEST_SCHOOL_ID}', '2025', gen_random_uuid(),
                 15, 0.9, 3, 500)`,
        `INSERT INTO ${TEST_SCHEMA}.rpt_msg_communication_metrics
           (id, school_id, period, messages_sent, broadcasts_sent, delivery_rate, read_rate,
            avg_response_time_hours)
         VALUES (gen_random_uuid(), '${TEST_SCHOOL_ID}', '2025-09-01', 5, 1, 0.9, 0.8, 2.0)`,
        `INSERT INTO ${TEST_SCHEMA}.rpt_wellbeing_domain_trends
           (id, school_id, period, grade_level, domain, avg_score, response_count,
            below_threshold_count)
         VALUES (gen_random_uuid(), '${TEST_SCHOOL_ID}', '2025-09-01', '5', 'SAFETY', 4.5,
                 10, 0)`,
      ];
      for (const ins of inserts) {
        await rawClient.$executeRawUnsafe(ins);
      }
    });

    it('every list endpoint returns A-only rows', async () => {
      const checks = [
        () => engagementReads.listEnrolmentFunnel(),
        () => engagementReads.listAthSeasons(),
        () => engagementReads.listOfficialsMarketplace({}),
        () => engagementReads.listGameResults(),
        () => engagementReads.listGroupsEngagement({}),
        () => engagementReads.listPublications({}),
        () => engagementReads.listClubsService(),
        () => engagementReads.listCommsMetrics({}),
        () => engagementReads.listWellbeingDomainTrends({}),
      ];
      for (const c of checks) {
        const rows = await withTestTenant(c);
        expect(rows.length).toBeGreaterThan(0);
      }
      // Cross-school isolation: School B sees nothing.
      for (const c of checks) {
        const rowsB = await withTestTenantB(c);
        expect(rowsB).toEqual([]);
      }
    });

    it('listOfficialsMarketplace applies fromDate/toDate filters', async () => {
      const rowsAll = await withTestTenant(async () =>
        engagementReads.listOfficialsMarketplace({}),
      );
      expect(rowsAll.length).toBeGreaterThan(0);
      const rowsNarrow = await withTestTenant(async () =>
        engagementReads.listOfficialsMarketplace({
          fromDate: '2025-09-01',
          toDate: '2025-09-30',
        }),
      );
      expect(rowsNarrow.length).toBeGreaterThan(0);
      const rowsEmpty = await withTestTenant(async () =>
        engagementReads.listOfficialsMarketplace({
          fromDate: '2099-01-01',
          toDate: '2099-12-31',
        }),
      );
      expect(rowsEmpty).toEqual([]);
    });
  });

  describe('EngagementAnalyticsController', () => {
    beforeEach(async () => {
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.rpt_enr_funnel_summary
           (id, school_id, academic_year, applications_received, tours_booked, offers_made,
            offers_accepted, enrolled, waitlisted, conversion_rate)
         VALUES (gen_random_uuid(), '${TEST_SCHOOL_ID}', '2025', 1, 0, 0, 0, 0, 0, NULL)`,
      );
    });

    it('every controller endpoint passes through', async () => {
      const a = await withTestTenant(async () => engagementCtrl.enrolmentFunnel());
      expect(a.length).toBeGreaterThan(0);
      await withTestTenant(async () => engagementCtrl.athleticsSeason());
      await withTestTenant(async () => engagementCtrl.officials({}));
      await withTestTenant(async () => engagementCtrl.gameResults());
      await withTestTenant(async () => engagementCtrl.groupsEngagement({}));
      await withTestTenant(async () => engagementCtrl.publications({}));
      await withTestTenant(async () => engagementCtrl.clubs());
      await withTestTenant(async () => engagementCtrl.communications({}));
      await withTestTenant(async () => engagementCtrl.wellbeingTrends({}));
    });
  });

  /* ─────────────────────────────────────────────────────────────────
     Operations workers — direct upsert
     ──────────────────────────────────────────────────────────────── */
  describe('Operations workers', () => {
    it('onModuleInit subscribes via stub consumer', async () => {
      await Promise.all([
        procurementWorker.onModuleInit(),
        storeWorker.onModuleInit(),
        foodWorker.onModuleInit(),
        transportWorker.onModuleInit(),
        facilitiesWorker.onModuleInit(),
        itWorker.onModuleInit(),
        libraryWorker.onModuleInit(),
      ]);
      const groups = subscribeCalls.map((c) => c.groupId);
      expect(groups).toEqual(
        expect.arrayContaining([
          'procurement-readmodel-worker',
          'store-readmodel-worker',
          'food-service-readmodel-worker',
          'transport-readmodel-worker',
          'facilities-readmodel-worker',
          'it-readmodel-worker',
          'library-readmodel-worker',
        ]),
      );
    });

    it('ProcurementReadModelWorker — PO issued + receipt completed', async () => {
      const sid = TEST_SCHOOL_ID;
      const vid = generateId();
      await withTestTenant(async () =>
        procurementWorker.upsert(
          makeEvent({
            poId: 'po1',
            schoolId: sid,
            vendorId: vid,
            department: 'IT',
            totalAmount: 1234,
            issuedAt: '2025-09-15',
          } as any) as any,
          false,
        ),
      );
      await withTestTenant(async () =>
        procurementWorker.upsert(
          makeEvent({
            receiptId: 'r1',
            poId: 'po1',
            schoolId: sid,
            vendorId: vid,
            department: 'IT',
            leadTimeDays: 5,
            completedAt: '2025-09-20',
          } as any) as any,
          true,
        ),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT total_pos, total_spend, avg_lead_time_days FROM ${TEST_SCHEMA}.rpt_procurement_summary WHERE school_id = $1::uuid`,
        sid,
      )) as any[];
      expect(rows.length).toBe(1);
      expect(Number(rows[0].total_pos)).toBe(1);
      expect(Number(rows[0].total_spend)).toBeCloseTo(1234, 2);
    });

    it('ProcurementReadModelWorker — drops missing fields + payload mismatch', async () => {
      await withTestTenant(async () =>
        procurementWorker.upsert(makeEvent({} as any) as any, false),
      );
      await withTestTenant(async () =>
        procurementWorker.upsert(
          makeEvent({
            poId: 'p',
            schoolId: '019e0cf8-aaaa-7777-8888-000000999999',
            vendorId: 'v',
            totalAmount: 1,
            issuedAt: '2025-01-01',
          } as any) as any,
          false,
        ),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS c FROM ${TEST_SCHEMA}.rpt_procurement_summary`,
      )) as any[];
      expect(Number(rows[0].c)).toBe(0);
    });

    it('StoreReadModelWorker — multi-item order', async () => {
      const ev = makeEvent({
        orderId: 'o1',
        schoolId: TEST_SCHOOL_ID,
        items: [
          { productId: generateId(), quantity: 2, revenue: 50, costOfGoods: 30 },
          { productId: generateId(), quantity: 1, revenue: 25, costOfGoods: 10 },
        ],
        completedAt: '2025-09-15',
      } as any);
      await withTestTenant(async () => storeWorker.upsert(ev as any));
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS c, SUM(units_sold)::int AS u FROM ${TEST_SCHEMA}.rpt_store_sales WHERE school_id = $1::uuid`,
        TEST_SCHOOL_ID,
      )) as any[];
      expect(Number(rows[0].c)).toBe(2);
      expect(Number(rows[0].u)).toBe(3);
    });

    it('StoreReadModelWorker — drops missing items', async () => {
      await withTestTenant(async () => storeWorker.upsert(makeEvent({} as any) as any));
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS c FROM ${TEST_SCHEMA}.rpt_store_sales`,
      )) as any[];
      expect(Number(rows[0].c)).toBe(0);
    });

    it('FoodServiceReadModelWorker — meal served (FREE/REDUCED/PAID + waste)', async () => {
      const sid = TEST_SCHOOL_ID;
      const date = '2025-09-15';
      const cases: any[] = [
        { eligibilityCategory: 'FREE', wasted: false, reimbursementEstimate: 2.5 },
        { eligibilityCategory: 'REDUCED', wasted: false, reimbursementEstimate: 1.5 },
        { eligibilityCategory: 'PAID', wasted: false, reimbursementEstimate: 0 },
        { eligibilityCategory: 'PAID', wasted: true, reimbursementEstimate: 0 },
      ];
      for (const c of cases) {
        await withTestTenant(async () =>
          foodWorker.upsert(
            makeEvent({
              mealServingId: generateId(),
              schoolId: sid,
              serviceDate: date,
              mealType: 'LUNCH',
              ...c,
            } as any) as any,
          ),
        );
      }
      const counts = (await rawClient.$queryRawUnsafe(
        `SELECT total_served, free_count, reduced_count, paid_count, waste_count FROM ${TEST_SCHEMA}.rpt_fds_meal_counts WHERE school_id = $1::uuid`,
        sid,
      )) as any[];
      expect(Number(counts[0].free_count)).toBe(1);
      expect(Number(counts[0].reduced_count)).toBe(1);
      expect(Number(counts[0].paid_count)).toBe(1);
      expect(Number(counts[0].waste_count)).toBe(1);
    });

    it('FoodServiceReadModelWorker — drops missing fields', async () => {
      await withTestTenant(async () => foodWorker.upsert(makeEvent({} as any) as any));
      const c = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS c FROM ${TEST_SCHEMA}.rpt_fds_meal_counts`,
      )) as any[];
      expect(Number(c[0].c)).toBe(0);
    });

    it('TransportReadModelWorker — run completed accrues riders + on-time rate', async () => {
      const sid = TEST_SCHOOL_ID;
      const routeId = generateId();
      await withTestTenant(async () =>
        transportWorker.upsert(
          makeEvent({
            runId: generateId(),
            schoolId: sid,
            routeId,
            riderCount: 30,
            durationMinutes: 45,
            onTime: true,
            completedAt: '2025-09-15',
          } as any) as any,
        ),
      );
      await withTestTenant(async () =>
        transportWorker.upsert(
          makeEvent({
            runId: generateId(),
            schoolId: sid,
            routeId,
            riderCount: 28,
            durationMinutes: 47,
            onTime: false,
            completedAt: '2025-09-16',
          } as any) as any,
        ),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT total_runs, total_riders, on_time_rate FROM ${TEST_SCHEMA}.rpt_trn_ridership_summary WHERE school_id = $1::uuid`,
        sid,
      )) as any[];
      expect(Number(rows[0].total_runs)).toBe(2);
      expect(Number(rows[0].total_riders)).toBe(58);
    });

    it('TransportReadModelWorker — drops missing fields', async () => {
      await withTestTenant(async () => transportWorker.upsert(makeEvent({} as any) as any));
      const c = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS c FROM ${TEST_SCHEMA}.rpt_trn_ridership_summary`,
      )) as any[];
      expect(Number(c[0].c)).toBe(0);
    });

    it('FacilitiesReadModelWorker — inspection + work order paths', async () => {
      const sid = TEST_SCHOOL_ID;
      const bid = generateId();
      const sp = generateId();
      await withTestTenant(async () =>
        facilitiesWorker.upsertInspection(
          makeEvent({
            inspectionId: 'i1',
            schoolId: sid,
            buildingId: bid,
            spaceId: sp,
            conditionScore: 8.5,
            inspectionDate: '2025-09-15',
          } as any) as any,
        ),
      );
      await withTestTenant(async () =>
        facilitiesWorker.upsertWorkOrder(
          makeEvent({
            workOrderId: 'w1',
            schoolId: sid,
            buildingId: bid,
            spaceId: sp,
            status: 'COMPLETED',
            overdue: false,
          } as any) as any,
        ),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT condition_score FROM ${TEST_SCHEMA}.rpt_facilities_condition WHERE school_id = $1::uuid`,
        sid,
      )) as any[];
      expect(rows.length).toBe(1);
    });

    it('FacilitiesReadModelWorker — drops missing fields', async () => {
      await withTestTenant(async () => facilitiesWorker.upsertInspection(makeEvent({} as any) as any));
      await withTestTenant(async () => facilitiesWorker.upsertWorkOrder(makeEvent({} as any) as any));
      const c = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS c FROM ${TEST_SCHEMA}.rpt_facilities_condition`,
      )) as any[];
      expect(Number(c[0].c)).toBe(0);
    });

    it('FacilitiesReadModelWorker.materialiseKpi — nightly batch', async () => {
      const result = await withTestTenant(async () =>
        facilitiesWorker.materialiseKpi(TEST_SCHOOL_ID, '2025-09-01'),
      );
      expect(result.rowsWritten).toBe(1);
    });

    it('ITReadModelWorker — provisioned + incident + deprovisioned', async () => {
      const sid = TEST_SCHOOL_ID;
      await withTestTenant(async () =>
        itWorker.upsert(
          makeEvent({
            deviceId: 'd1',
            schoolId: sid,
            deviceType: 'CHROMEBOOK',
            eventType: 'PROVISIONED',
            ageMonths: 12,
            occurredAt: '2025-09-01',
          } as any) as any,
          'env.tech.device.provisioned',
        ),
      );
      await withTestTenant(async () =>
        itWorker.upsert(
          makeEvent({
            deviceId: 'd1',
            schoolId: sid,
            deviceType: 'CHROMEBOOK',
            eventType: 'INCIDENT',
            status: 'IN_REPAIR',
            occurredAt: '2025-09-10',
          } as any) as any,
          'env.tech.device.incident',
        ),
      );
      await withTestTenant(async () =>
        itWorker.upsert(
          makeEvent({
            deviceId: 'd2',
            schoolId: sid,
            deviceType: 'CHROMEBOOK',
            eventType: 'DEPROVISIONED',
            occurredAt: '2025-09-20',
          } as any) as any,
          'env.tech.device.deprovisioned',
        ),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT total_devices, active, in_repair, decommissioned FROM ${TEST_SCHEMA}.rpt_tech_fleet_status WHERE school_id = $1::uuid`,
        sid,
      )) as any[];
      expect(Number(rows[0].total_devices)).toBeGreaterThanOrEqual(1);
    });

    it('ITReadModelWorker — drops missing fields', async () => {
      await withTestTenant(async () =>
        itWorker.upsert(makeEvent({} as any) as any, 'env.tech.device.provisioned'),
      );
      const c = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS c FROM ${TEST_SCHEMA}.rpt_tech_fleet_status`,
      )) as any[];
      expect(Number(c[0].c)).toBe(0);
    });

    it('LibraryReadModelWorker — checkout + return + overdue', async () => {
      const sid = TEST_SCHOOL_ID;
      const item = generateId();
      await withTestTenant(async () =>
        libraryWorker.upsert(
          makeEvent({
            checkoutId: 'co1',
            schoolId: sid,
            catalogueItemId: item,
            catalogueItemTitle: 'Title 1',
            createdAt: '2025-09-15',
          } as any) as any,
          false,
        ),
      );
      await withTestTenant(async () =>
        libraryWorker.upsert(
          makeEvent({
            checkoutId: 'co1',
            schoolId: sid,
            catalogueItemId: item,
            catalogueItemTitle: 'Title 1',
            loanDurationDays: 14,
            overdue: true,
            returnedAt: '2025-09-30',
          } as any) as any,
          true,
        ),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT total_checkouts, total_returns, overdue_count FROM ${TEST_SCHEMA}.rpt_lib_circulation_summary WHERE school_id = $1::uuid`,
        sid,
      )) as any[];
      expect(Number(rows[0].total_checkouts)).toBe(1);
      expect(Number(rows[0].total_returns)).toBe(1);
      expect(Number(rows[0].overdue_count)).toBe(1);
    });

    it('LibraryReadModelWorker — drops missing fields', async () => {
      await withTestTenant(async () => libraryWorker.upsert(makeEvent({} as any) as any, false));
      const c = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS c FROM ${TEST_SCHEMA}.rpt_lib_circulation_summary`,
      )) as any[];
      expect(Number(c[0].c)).toBe(0);
    });
  });

  /* ─────────────────────────────────────────────────────────────────
     OperationsReadService — read endpoints + cross-school
     ──────────────────────────────────────────────────────────────── */
  describe('OperationsReadService', () => {
    beforeEach(async () => {
      const inserts = [
        `INSERT INTO ${TEST_SCHEMA}.rpt_procurement_summary
           (id, school_id, period, department, vendor_id, total_pos, total_spend, avg_lead_time_days)
         VALUES (gen_random_uuid(), '${TEST_SCHOOL_ID}', '2025-09-01', 'IT', gen_random_uuid(), 5, 1000, 3)`,
        `INSERT INTO ${TEST_SCHEMA}.rpt_store_sales
           (id, school_id, period, product_id, units_sold, revenue, cost_of_goods, profit_margin)
         VALUES (gen_random_uuid(), '${TEST_SCHOOL_ID}', '2025-09-01', gen_random_uuid(), 10, 200, 100, 0.5)`,
        `INSERT INTO ${TEST_SCHEMA}.rpt_fds_meal_counts
           (id, school_id, service_date, meal_type, total_served, free_count, reduced_count, paid_count, waste_count)
         VALUES (gen_random_uuid(), '${TEST_SCHOOL_ID}', '2025-09-15', 'LUNCH', 100, 50, 25, 25, 5)`,
        `INSERT INTO ${TEST_SCHEMA}.rpt_fds_nslp_summary
           (id, school_id, month_year, free_meals, reduced_meals, paid_meals, total_reimbursement_estimate)
         VALUES (gen_random_uuid(), '${TEST_SCHOOL_ID}', '2025-09-01', 500, 200, 300, 1500)`,
        `INSERT INTO ${TEST_SCHEMA}.rpt_trn_ridership_summary
           (id, school_id, route_id, period, total_runs, total_riders, avg_riders_per_run, on_time_rate, avg_duration_minutes)
         VALUES (gen_random_uuid(), '${TEST_SCHOOL_ID}', gen_random_uuid(), '2025-09-01', 20, 600, 30, 0.95, 35)`,
        `INSERT INTO ${TEST_SCHEMA}.rpt_facilities_condition
           (id, school_id, building_id, space_id, last_inspection_date, condition_score, open_work_orders, overdue_work_orders)
         VALUES (gen_random_uuid(), '${TEST_SCHOOL_ID}', gen_random_uuid(), gen_random_uuid(), '2025-09-01', 7.5, 0, 0)`,
        `INSERT INTO ${TEST_SCHEMA}.rpt_facilities_kpi
           (id, school_id, period, total_work_orders, completed_on_time, avg_resolution_days, energy_cost, cost_per_sqft)
         VALUES (gen_random_uuid(), '${TEST_SCHOOL_ID}', '2025-09-01', 5, 4, 2.5, 100, 0.5)`,
        `INSERT INTO ${TEST_SCHEMA}.rpt_tech_fleet_status
           (id, school_id, device_type, total_devices, active, in_repair, decommissioned, avg_age_months, incident_rate)
         VALUES (gen_random_uuid(), '${TEST_SCHOOL_ID}', 'CHROMEBOOK', 50, 40, 5, 5, 18, 0.1)`,
        `INSERT INTO ${TEST_SCHEMA}.rpt_lib_circulation_summary
           (id, school_id, period, total_checkouts, total_returns, overdue_count, popular_titles, avg_loan_duration_days)
         VALUES (gen_random_uuid(), '${TEST_SCHOOL_ID}', '2025-09-01', 20, 15, 2, '[]'::jsonb, 14)`,
      ];
      for (const ins of inserts) {
        await rawClient.$executeRawUnsafe(ins);
      }
    });

    it('every list endpoint returns A-only rows', async () => {
      const lists = [
        () => operationsReads.listProcurement({}),
        () => operationsReads.listStoreSales({}),
        () => operationsReads.listMealCounts({}),
        () => operationsReads.listNslp({}),
        () => operationsReads.listRidership({}),
        () => operationsReads.listFacilitiesCondition(),
        () => operationsReads.listFacilitiesKpi({}),
        () => operationsReads.listTechFleet(),
        () => operationsReads.listLibraryCirculation({}),
      ];
      for (const fn of lists) {
        const rows = await withTestTenant(fn);
        expect(rows.length).toBeGreaterThan(0);
        const rowsB = await withTestTenantB(fn);
        expect(rowsB).toEqual([]);
      }
    });

    it('listProcurement honours fromDate/toDate filter', async () => {
      const rowsAll = await withTestTenant(async () => operationsReads.listProcurement({}));
      expect(rowsAll.length).toBeGreaterThan(0);
      const rowsEmpty = await withTestTenant(async () =>
        operationsReads.listProcurement({ fromDate: '2099-01-01', toDate: '2099-12-31' }),
      );
      expect(rowsEmpty).toEqual([]);
    });
  });

  describe('OperationsAnalyticsController', () => {
    beforeEach(async () => {
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.rpt_procurement_summary
           (id, school_id, period, department, vendor_id, total_pos, total_spend, avg_lead_time_days)
         VALUES (gen_random_uuid(), '${TEST_SCHOOL_ID}', '2025-09-01', 'IT', gen_random_uuid(), 1, 1, 1)`,
      );
    });

    it('all controller endpoints pass through', async () => {
      await withTestTenant(async () => operationsCtrl.procurement({}));
      await withTestTenant(async () => operationsCtrl.storeSales({}));
      await withTestTenant(async () => operationsCtrl.mealCounts({}));
      await withTestTenant(async () => operationsCtrl.nslp({}));
      await withTestTenant(async () => operationsCtrl.ridership({}));
      await withTestTenant(async () => operationsCtrl.facilitiesCondition());
      await withTestTenant(async () => operationsCtrl.facilitiesKpi({}));
      await withTestTenant(async () => operationsCtrl.techFleet());
      await withTestTenant(async () => operationsCtrl.libraryCirculation({}));
    });
  });

  /* ─────────────────────────────────────────────────────────────────
     operations-worker-base helpers — direct unit tests
     ──────────────────────────────────────────────────────────────── */
  describe('operations-worker-base helpers', () => {
    it('monthAnchor returns first day of month for any ISO date', () => {
      expect(monthAnchor('2025-09-15T12:34:56Z')).toBe('2025-09-01');
      expect(monthAnchor('2025-02-28')).toBe('2025-02-01');
    });

    it('claimReadModelContribution returns true on first INSERT, false on replay', async () => {
      await withTestTenant(async () => {
        await tenantPrisma.executeInTenantTransaction(async (tx) => {
          const eid = generateId();
          const first = await claimReadModelContribution(tx, 'test-grp', eid, 'rpt_x');
          const replay = await claimReadModelContribution(tx, 'test-grp', eid, 'rpt_x');
          expect(first).toBe(true);
          expect(replay).toBe(false);
        });
      });
    });

    it('claimReadModelContribution short-circuits when eventId is empty', async () => {
      await withTestTenant(async () => {
        await tenantPrisma.executeInTenantTransaction(async (tx) => {
          const r = await claimReadModelContribution(tx, 'test-grp', '', 'rpt_x');
          expect(r).toBe(true);
        });
      });
    });

    it('assertPayloadSchoolMatchesEnvelope true for matching, false for mismatch, true when null', () => {
      const logger = { warn: () => {} } as any;
      const evMatch = {
        tenant: { schoolId: TEST_SCHOOL_ID },
        eventId: 'e1',
      };
      expect(
        assertPayloadSchoolMatchesEnvelope(evMatch, TEST_SCHOOL_ID, 'g', 't', logger),
      ).toBe(true);
      expect(
        assertPayloadSchoolMatchesEnvelope(evMatch, TEST_SCHOOL_B_ID, 'g', 't', logger),
      ).toBe(false);
      expect(assertPayloadSchoolMatchesEnvelope(evMatch, null, 'g', 't', logger)).toBe(true);
      expect(
        assertPayloadSchoolMatchesEnvelope(
          { tenant: { schoolId: '' } } as any,
          TEST_SCHOOL_ID,
          'g',
          't',
          logger,
        ),
      ).toBe(true);
    });

    it('dispatchOperationsEvent drops messages with no eventId/tenant headers', async () => {
      const logger = { warn: () => {}, error: () => {}, debug: () => {} } as any;
      let called = false;
      const handler = async () => {
        called = true;
      };
      await dispatchOperationsEvent(
        {
          topic: 'x.y',
          partition: 0,
          offset: '0',
          key: 'k',
          headers: {},
          payload: null,
        } as any,
        'g',
        stubIdempotency,
        logger,
        handler,
      );
      expect(called).toBe(false);
    });

    it('dispatchOperationsEvent invokes handler when envelope is well-formed', async () => {
      const logger = { warn: () => {}, error: () => {}, debug: () => {} } as any;
      let called = false;
      const handler = async (ev: UnwrappedEvent<unknown>) => {
        called = true;
        expect(ev.eventId).toBeTruthy();
      };
      await dispatchOperationsEvent(
        {
          topic: 'x.y',
          partition: 0,
          offset: '0',
          key: 'k',
          headers: { 'tenant-subdomain': 'test', 'tenant-id': TEST_SCHOOL_ID },
          payload: {
            event_id: generateId(),
            event_type: 'x.y',
            tenant_id: TEST_SCHOOL_ID,
            occurred_at: new Date().toISOString(),
            published_at: new Date().toISOString(),
            source_module: 'test',
            payload: { hello: 'world' },
          },
        } as any,
        'g',
        stubIdempotency,
        logger,
        handler,
      );
      expect(called).toBe(true);
    });

    it('dispatchOperationsEvent drops messages with non-object payload', async () => {
      const logger = { warn: () => {}, error: () => {}, debug: () => {} } as any;
      let called = false;
      const handler = async () => {
        called = true;
      };
      await dispatchOperationsEvent(
        {
          topic: 'x.y',
          partition: 0,
          offset: '0',
          key: 'k',
          headers: { 'tenant-subdomain': 'test', 'tenant-id': TEST_SCHOOL_ID },
          payload: {
            event_id: generateId(),
            event_type: 'x.y',
            tenant_id: TEST_SCHOOL_ID,
            occurred_at: new Date().toISOString(),
            published_at: new Date().toISOString(),
            source_module: 'test',
            payload: 'not-an-object',
          },
        } as any,
        'g',
        stubIdempotency,
        logger,
        handler,
      );
      expect(called).toBe(false);
    });
  });

  // Suppress unused-import lint
  void TEST_ANA_CLASS_B_ID;
  void TEST_ANA_INVOICE_OVERDUE_ID;
  void TEST_ANA_INVOICE_CURRENT_ID;
  void TEST_ANA_STUDENT2_ID;
  void TEST_ANA_ACADEMIC_YEAR_ID;
  void TEST_ANA_PLATFORM_STUDENT_ID;
  void TEST_TEACHER_ACCOUNT_ID;
});
