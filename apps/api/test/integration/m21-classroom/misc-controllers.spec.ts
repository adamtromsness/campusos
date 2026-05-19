import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { HallPassController } from '@modules/m21-classroom/hall-passes/hall-pass.controller';
import { HallPassService } from '@modules/m21-classroom/hall-passes/hall-pass.service';
import { LessonRecordingController } from '@modules/m21-classroom/lessons/lesson-recording.controller';
import { LessonRecordingService } from '@modules/m21-classroom/lessons/lesson-recording.service';
import { ClassMomentController } from '@modules/m21-classroom/classes/class-moment.controller';
import { ClassMomentService } from '@modules/m21-classroom/classes/class-moment.service';
import { PeerReviewController } from '@modules/m21-classroom/peer-review/peer-review.controller';
import { PeerReviewService } from '@modules/m21-classroom/peer-review/peer-review.service';
import { ProgressNoteController } from '@modules/m21-classroom/progress-notes/progress-note.controller';
import { ProgressNoteService } from '@modules/m21-classroom/progress-notes/progress-note.service';
import { ReportCardSubjectController } from '@modules/m21-classroom/report-cards/report-card-subject.controller';
import { ReportCardSubjectService } from '@modules/m21-classroom/report-cards/report-card-subject.service';
import { AITutoringController } from '@modules/m21-classroom/ai-tutoring/ai-tutoring.controller';
import { AITutoringService } from '@modules/m21-classroom/ai-tutoring/ai-tutoring.service';
import { AIOptOutController } from '@modules/m21-classroom/ai-tutoring/ai-opt-out.controller';
import { AIOptOutService } from '@modules/m21-classroom/ai-tutoring/ai-opt-out.service';
import { AIUsageController } from '@modules/m21-classroom/ai-tutoring/ai-usage.controller';
import { AIUsageService } from '@modules/m21-classroom/ai-tutoring/ai-usage.service';
import type { AIGatewayService } from '@modules/m21-classroom/ai-tutoring/ai-gateway.service';
import { AssignmentService } from '@modules/m21-classroom/assignments/assignment.service';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';
import { RedisService } from '@shared/cache';
import type { KafkaProducerService } from '@shared/kafka/kafka-producer.service';

import { makeRecordingKafka } from '../helpers/recording-kafka';
import { withTestTenant, TEST_SCHEMA, TEST_SCHOOL_ID } from '../helpers/tenant-context';
import {
  TEST_ADMIN_ACCOUNT_ID,
  TEST_ADMIN_PERSON_ID,
  TEST_ADMIN_EMPLOYEE_ID,
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';
import { TEST_SIS_CLASS_ID, TEST_SIS_COURSE_ID, TEST_SIS_TERM_ID } from '../fixtures/sis';
import {
  seedStudent,
  enrollStudent,
  assignTeacherToClass,
  cleanupSeededIds,
} from '../m20-sis/sis-helpers';

/**
 * Wave 4 — m21-classroom miscellaneous controllers DB-backed integration.
 *
 * Covers hall-pass, lesson-recording, class-moment, peer-review, progress-note,
 * report-card-subject, ai-tutoring, ai-opt-out, ai-usage controllers.
 *
 * Each controller is constructed with real services and called directly with
 * synthetic AuthedRequest objects. The underlying service contracts are already
 * exercised by the existing m21-classroom specs — this lifts the controllers
 * from 0 % to ≥80 % so the m21-classroom module hits Wave 4 coverage.
 */
describe('integration:m21-classroom/misc-controllers', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let actorContext: ActorContextService;
  let kafka: ReturnType<typeof makeRecordingKafka>;
  let outbox: OutboxService;
  let redis: RedisService;

  let hallPassService: HallPassService;
  let lessonRecordingService: LessonRecordingService;
  let classMomentService: ClassMomentService;
  let peerReviewService: PeerReviewService;
  let progressNoteService: ProgressNoteService;
  let reportCardSubjectService: ReportCardSubjectService;
  let assignmentService: AssignmentService;
  let aiOptOutService: AIOptOutService;
  let aiUsageService: AIUsageService;
  let aiTutoringService: AITutoringService;
  let gatewayStub: AIGatewayService;

  let hallPassController: HallPassController;
  let lessonRecordingController: LessonRecordingController;
  let classMomentController: ClassMomentController;
  let peerReviewController: PeerReviewController;
  let progressNoteController: ProgressNoteController;
  let reportCardSubjectController: ReportCardSubjectController;
  let aiTutoringController: AITutoringController;
  let aiOptOutController: AIOptOutController;
  let aiUsageController: AIUsageController;

  const personIds: string[] = [];
  const platformStudentIds: string[] = [];
  const studentIds: string[] = [];
  const guardianIds: string[] = [];
  const accountIds: string[] = [];
  const lessonIds: string[] = [];
  const recordingIds: string[] = [];
  const reportCardIds: string[] = [];

  let assignmentTypeId: string;

  function fakeAdminReq(): any {
    return {
      user: {
        sub: TEST_ADMIN_ACCOUNT_ID,
        personId: TEST_ADMIN_PERSON_ID,
        email: 'admin@test.integration.local',
        displayName: 'Integration Admin',
        sessionId: 'test-session',
      },
    };
  }

  async function ensureAssignmentType(): Promise<string> {
    const existing = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id::text AS id FROM ${TEST_SCHEMA}.cls_assignment_types WHERE school_id = $1::uuid LIMIT 1`,
      TEST_SCHOOL_ID,
    );
    if (existing.length > 0) return existing[0]!.id;
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.cls_assignment_types (id, school_id, name, weight_in_category, category)
       VALUES ($1::uuid, $2::uuid, 'Homework', 100.00, 'HOMEWORK')`,
      id,
      TEST_SCHOOL_ID,
    );
    return id;
  }

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    actorContext = new ActorContextService(rawClient, permCheck, tenantPrisma);
    kafka = makeRecordingKafka();
    outbox = new OutboxService();
    redis = new RedisService();
    await redis.onModuleInit();

    hallPassService = new HallPassService(
      tenantPrisma,
      kafka as unknown as KafkaProducerService,
    );
    lessonRecordingService = new LessonRecordingService(tenantPrisma, outbox);
    classMomentService = new ClassMomentService(tenantPrisma);
    peerReviewService = new PeerReviewService(tenantPrisma);
    assignmentService = new AssignmentService(
      tenantPrisma,
      kafka as unknown as KafkaProducerService,
    );
    progressNoteService = new ProgressNoteService(
      tenantPrisma,
      assignmentService,
      kafka as unknown as KafkaProducerService,
    );
    reportCardSubjectService = new ReportCardSubjectService(tenantPrisma);

    gatewayStub = {
      tutoringReply: async (input: { newMessage: string; subject: string }) => ({
        content: 'stub reply for ' + input.subject + ' / ' + input.newMessage.slice(0, 20),
        tokensUsed: 50,
        costUsd: 0,
      }),
      extractLearningSignals: async () => ({
        signals: [
          { signalType: 'INTEREST' as const, description: 'stub interest', confidence: 0.5 },
        ],
        tokensUsed: 100,
        costUsd: 0,
      }),
      summariseLesson: async () => ({
        summaryText: 'stub summary',
        keyTopics: ['stub'],
        actionItems: [],
        modelVersion: 'stub-v1',
        tokensUsed: 0,
        costUsd: 0,
      }),
    } as unknown as AIGatewayService;

    aiUsageService = new AIUsageService(tenantPrisma, redis);
    aiOptOutService = new AIOptOutService(tenantPrisma);
    aiTutoringService = new AITutoringService(
      tenantPrisma,
      aiUsageService,
      aiOptOutService,
      gatewayStub,
    );

    hallPassController = new HallPassController(hallPassService, actorContext);
    lessonRecordingController = new LessonRecordingController(lessonRecordingService, actorContext);
    classMomentController = new ClassMomentController(classMomentService, actorContext);
    peerReviewController = new PeerReviewController(peerReviewService, actorContext);
    progressNoteController = new ProgressNoteController(progressNoteService, actorContext);
    reportCardSubjectController = new ReportCardSubjectController(
      reportCardSubjectService,
      actorContext,
    );
    aiTutoringController = new AITutoringController(aiTutoringService, actorContext);
    aiOptOutController = new AIOptOutController(aiOptOutService, actorContext);
    aiUsageController = new AIUsageController(aiUsageService, actorContext);

    // Seed admin permission cache so isSchoolAdmin resolves true.
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, ARRAY['sch-001:admin','tch-001:read','tch-001:write','tch-002:read','tch-002:write','tch-003:read','tch-003:write','tch-007:read','tch-007:write','tch-007:admin','tch-008:write','tch-009:read','tch-009:write','tch-010:write','tch-013:write','att-005:read','att-005:write','att-005:admin']::text[], now(), 'test')
       ON CONFLICT (account_id, scope_id) DO UPDATE SET permission_codes = EXCLUDED.permission_codes`,
      TEST_ADMIN_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
    );

    // Seed hr_employees row for the admin actor — several controllers
    // (PeerReview, ReportCardSubject, ProgressNote) require employeeId
    // even for admin callers. ProgressNote test then assigns this teacher
    // to the test class.
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.hr_employees (id, school_id, person_id, account_id, employee_number, employment_status, employment_type, hire_date)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'CTRL-ADMIN', 'ACTIVE', 'FULL_TIME', '2025-01-01')
       ON CONFLICT (id) DO NOTHING`,
      TEST_ADMIN_EMPLOYEE_ID,
      TEST_SCHOOL_ID,
      TEST_ADMIN_PERSON_ID,
      TEST_ADMIN_ACCOUNT_ID,
    );

    assignmentTypeId = await ensureAssignmentType();
  });

  afterAll(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.hr_employees WHERE id = $1::uuid`,
      TEST_ADMIN_EMPLOYEE_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE account_id = $1::uuid`,
      TEST_ADMIN_ACCOUNT_ID,
    );
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
    await redis.onModuleDestroy();
  });

  beforeEach(async () => {
    // Wipe per-test classroom state — children before parents (FK order matters).
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_hall_passes`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_hall_pass_settings`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_lesson_summaries`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_lesson_transcripts`);
    if (recordingIds.length) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.cls_lesson_recordings WHERE id = ANY($1::uuid[])`,
        recordingIds.splice(0),
      );
    }
    if (lessonIds.length) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.cls_lessons WHERE id = ANY($1::uuid[])`,
        lessonIds.splice(0),
      );
    }
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_class_moment_reactions`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_class_moment_photos`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_class_moments`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_peer_reviews`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_peer_review_assignments`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_student_progress_notes`);
    if (reportCardIds.length) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.cls_report_card_subjects WHERE report_card_id = ANY($1::uuid[])`,
        reportCardIds,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.cls_report_cards WHERE id = ANY($1::uuid[])`,
        reportCardIds.splice(0),
      );
    }
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_ai_tutoring_opt_outs`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.cls_ai_tutoring_learning_signals`,
    );
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_ai_tutoring_messages`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_ai_tutoring_sessions`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_ai_usage_log`);
    // FK-aware order: rubric_scores → standard_grades → observations → grades → submissions → assignments
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_rubric_scores`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_standard_grade_evidence`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_standard_grades`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_student_observations`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_grades`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_submissions`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_assignments`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.sis_class_teachers`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.sis_enrollments`);
    await cleanupSeededIds(rawClient, {
      studentIds: studentIds.splice(0),
      platformStudentIds: platformStudentIds.splice(0),
      guardianIds: guardianIds.splice(0),
      personIds: personIds.splice(0),
      accountIds: accountIds.splice(0),
    });
  });

  async function trackedStudent() {
    const s = await seedStudent(rawClient);
    studentIds.push(s.studentId);
    platformStudentIds.push(s.platformStudentId);
    personIds.push(s.personId);
    return s;
  }

  async function seedLesson(): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.cls_lessons (id, school_id, class_id, title, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'Lesson', 'PUBLISHED')`,
      id,
      TEST_SCHOOL_ID,
      TEST_SIS_CLASS_ID,
    );
    lessonIds.push(id);
    return id;
  }

  async function seedReportCard(studentId: string): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.cls_report_cards (id, student_id, class_id, term_id, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'DRAFT')`,
      id,
      studentId,
      TEST_SIS_CLASS_ID,
      TEST_SIS_TERM_ID,
    );
    reportCardIds.push(id);
    return id;
  }

  // ────────────────────────────────────────────────────────────────────
  // HallPassController
  // ────────────────────────────────────────────────────────────────────
  describe('HallPassController', () => {
    it('getSettings + updateSettings + issue + list + listActive + getById + returnPass', async () => {
      const settings = await withTestTenant(async () => hallPassController.getSettings());
      expect(settings.schoolId).toBe(TEST_SCHOOL_ID);

      const updated = await withTestTenant(async () =>
        hallPassController.updateSettings(
          { destinations: ['Bathroom', 'Office', 'Library'] } as any,
          fakeAdminReq(),
        ),
      );
      expect(updated.destinations).toEqual(['Bathroom', 'Office', 'Library']);

      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);

      const pass = await withTestTenant(async () =>
        hallPassController.issue(
          {
            studentId: student.studentId,
            classId: TEST_SIS_CLASS_ID,
            destination: 'Bathroom',
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(pass.status).toBe('ACTIVE');

      const fetched = await withTestTenant(async () => hallPassController.getById(pass.id));
      expect(fetched.id).toBe(pass.id);

      const list = await withTestTenant(async () =>
        hallPassController.list(undefined, fakeAdminReq()),
      );
      expect(list.map((p) => p.id)).toContain(pass.id);

      const active = await withTestTenant(async () =>
        hallPassController.listActive(fakeAdminReq()),
      );
      expect(active.map((p) => p.id)).toContain(pass.id);

      const returned = await withTestTenant(async () =>
        hallPassController.returnPass(pass.id, {} as any, fakeAdminReq()),
      );
      expect(returned.status).toBe('RETURNED');
    });

    it('recall', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      await withTestTenant(async () =>
        hallPassController.updateSettings(
          { destinations: ['Bathroom'] } as any,
          fakeAdminReq(),
        ),
      );
      const pass = await withTestTenant(async () =>
        hallPassController.issue(
          {
            studentId: student.studentId,
            classId: TEST_SIS_CLASS_ID,
            destination: 'Bathroom',
          } as any,
          fakeAdminReq(),
        ),
      );

      const recalled = await withTestTenant(async () =>
        hallPassController.recall(pass.id, { reason: 'Test recall' } as any, fakeAdminReq()),
      );
      expect(recalled.status).toBe('RECALLED');
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // LessonRecordingController
  // ────────────────────────────────────────────────────────────────────
  describe('LessonRecordingController', () => {
    it('create + getOne + listForLesson', async () => {
      const lessonId = await seedLesson();
      const created = await withTestTenant(async () =>
        lessonRecordingController.create(
          lessonId,
          { lessonId, s3Key: 's3://lesson1' } as any,
          fakeAdminReq(),
        ),
      );
      recordingIds.push(created.id);
      expect(created.lessonId).toBe(lessonId);
      expect(created.s3Key).toBe('s3://lesson1');

      const fetched = await withTestTenant(async () =>
        lessonRecordingController.getOne(created.id, fakeAdminReq()),
      );
      expect(fetched.id).toBe(created.id);

      const list = await withTestTenant(async () =>
        lessonRecordingController.listForLesson(lessonId, fakeAdminReq()),
      );
      expect(list.map((r) => r.id)).toContain(created.id);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // ClassMomentController
  // ────────────────────────────────────────────────────────────────────
  describe('ClassMomentController', () => {
    it('create + listForClass + getById + react + unreact + delete', async () => {
      const moment = await withTestTenant(async () =>
        classMomentController.create(
          TEST_SIS_CLASS_ID,
          {
            caption: 'Field trip!',
            photos: [{ s3Key: 's3://moment1', sortOrder: 0 }],
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(moment.caption).toBe('Field trip!');
      expect(moment.classId).toBe(TEST_SIS_CLASS_ID);

      const list = await withTestTenant(async () =>
        classMomentController.listForClass(TEST_SIS_CLASS_ID, fakeAdminReq()),
      );
      expect(list.map((m) => m.id)).toContain(moment.id);

      const fetched = await withTestTenant(async () =>
        classMomentController.getById(moment.id, fakeAdminReq()),
      );
      expect(fetched.id).toBe(moment.id);

      const reacted = await withTestTenant(async () =>
        classMomentController.react(
          moment.id,
          { reactionType: 'LIKE' } as any,
          fakeAdminReq(),
        ),
      );
      expect(reacted.reactionCount).toBe(1);

      const unreacted = await withTestTenant(async () =>
        classMomentController.unreact(moment.id, fakeAdminReq()),
      );
      expect(unreacted.reactionCount).toBe(0);

      await withTestTenant(async () => classMomentController.delete(moment.id, fakeAdminReq()));
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // PeerReviewController
  // ────────────────────────────────────────────────────────────────────
  describe('PeerReviewController', () => {
    it('enable + getForAssignment + listForAssignment + listMy', async () => {
      // Need an assignment + 2 students with submissions for assignReviews
      const assignment = await withTestTenant(async () =>
        assignmentService.create(
          TEST_SIS_CLASS_ID,
          { title: 'Peer Reviewable', assignmentTypeId, isPublished: true } as any,
          {
            accountId: TEST_ADMIN_ACCOUNT_ID,
            personId: TEST_ADMIN_PERSON_ID,
            employeeId: null,
            personType: 'STAFF',
            isSchoolAdmin: true,
          } as any,
        ),
      );

      const enabled = await withTestTenant(async () =>
        peerReviewController.enable(
          assignment.id,
          { reviewType: 'RANDOM', reviewsPerStudent: 1, isAnonymous: true } as any,
          fakeAdminReq(),
        ),
      );
      expect(enabled.assignmentId).toBe(assignment.id);

      const fetched = await withTestTenant(async () =>
        peerReviewController.getForAssignment(assignment.id),
      );
      expect(fetched?.id).toBe(enabled.id);

      const list = await withTestTenant(async () =>
        peerReviewController.listForAssignment(enabled.id, fakeAdminReq()),
      );
      expect(Array.isArray(list)).toBe(true);

      const mine = await withTestTenant(async () =>
        peerReviewController.listMy(fakeAdminReq()),
      );
      expect(Array.isArray(mine)).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // ProgressNoteController
  // ────────────────────────────────────────────────────────────────────
  describe('ProgressNoteController', () => {
    it('upsert + listForStudent', async () => {
      // ProgressNoteService requires employeeId on the actor. The admin
      // hr_employees row is seeded in beforeAll; resolveActor will pick it
      // up via the person_id join.
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      await assignTeacherToClass(rawClient, TEST_SIS_CLASS_ID, TEST_ADMIN_EMPLOYEE_ID);
      const note = await withTestTenant(async () =>
        progressNoteController.upsert(
          TEST_SIS_CLASS_ID,
          {
            studentId: student.studentId,
            termId: TEST_SIS_TERM_ID,
            noteText: 'Excellent term',
            isParentVisible: true,
            isStudentVisible: true,
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(note.studentId).toBe(student.studentId);
      expect(note.noteText).toBe('Excellent term');

      const list = await withTestTenant(async () =>
        progressNoteController.listForStudent(student.studentId, fakeAdminReq()),
      );
      expect(list.map((n) => n.id)).toContain(note.id);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // ReportCardSubjectController
  // ────────────────────────────────────────────────────────────────────
  describe('ReportCardSubjectController', () => {
    it('create + listForReportCard + getById + update + delete', async () => {
      const student = await trackedStudent();
      const rcId = await seedReportCard(student.studentId);

      const created = await withTestTenant(async () =>
        reportCardSubjectController.create(
          rcId,
          {
            subjectLabel: 'Math',
            courseId: TEST_SIS_COURSE_ID,
            finalGrade: 'A',
            gradeValue: 95,
            teacherComments: 'Great',
            effortGrade: 'High',
            sortOrder: 1,
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(created.subjectLabel).toBe('Math');

      const list = await withTestTenant(async () =>
        reportCardSubjectController.listForReportCard(rcId),
      );
      expect(list.map((s) => s.id)).toContain(created.id);

      const fetched = await withTestTenant(async () =>
        reportCardSubjectController.getById(created.id),
      );
      expect(fetched.id).toBe(created.id);

      const updated = await withTestTenant(async () =>
        reportCardSubjectController.update(
          created.id,
          { subjectLabel: 'Mathematics', gradeValue: 98 } as any,
          fakeAdminReq(),
        ),
      );
      expect(updated.subjectLabel).toBe('Mathematics');
      expect(updated.gradeValue).toBe(98);

      await withTestTenant(async () =>
        reportCardSubjectController.delete(created.id, fakeAdminReq()),
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // AITutoringController + AIOptOutController + AIUsageController
  // ────────────────────────────────────────────────────────────────────
  describe('AI controllers', () => {
    it('AIUsageController.getSummary + listUsage + getQuota', async () => {
      const summary = await withTestTenant(async () =>
        aiUsageController.getSummary(undefined, fakeAdminReq()),
      );
      expect(typeof summary.totalTokens).toBe('number');

      const summaryWithDays = await withTestTenant(async () =>
        aiUsageController.getSummary('7', fakeAdminReq()),
      );
      expect(typeof summaryWithDays.totalTokens).toBe('number');

      const log = await withTestTenant(async () =>
        aiUsageController.listUsage(undefined, fakeAdminReq()),
      );
      expect(Array.isArray(log)).toBe(true);

      const logLimited = await withTestTenant(async () =>
        aiUsageController.listUsage('10', fakeAdminReq()),
      );
      expect(Array.isArray(logLimited)).toBe(true);

      const quota = await withTestTenant(async () => aiUsageController.getQuota(fakeAdminReq()));
      expect(quota.schoolId).toBe(TEST_SCHOOL_ID);
      expect(typeof quota.dailyLimitTokens).toBe('number');
    });

    it('AIOptOutController.create + getOne + delete', async () => {
      const student = await trackedStudent();

      const optOut = await withTestTenant(async () =>
        aiOptOutController.create(
          { studentId: student.studentId, reason: 'parent request' } as any,
          fakeAdminReq(),
        ),
      );
      expect(optOut.studentId).toBe(student.studentId);

      const fetched = await withTestTenant(async () =>
        aiOptOutController.getOne(student.studentId, fakeAdminReq()),
      );
      expect(fetched.studentId).toBe(student.studentId);

      await withTestTenant(async () =>
        aiOptOutController.delete(student.studentId, fakeAdminReq()),
      );
    });

    it('AITutoringController.start + list + getOne + postMessage + complete + extractSignals + listSessionSignals + listStudentSignals', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);

      const session = await withTestTenant(async () =>
        aiTutoringController.start(
          { studentId: student.studentId, classId: TEST_SIS_CLASS_ID, subject: 'Algebra' } as any,
          fakeAdminReq(),
        ),
      );
      expect(session.subject).toBe('Algebra');
      expect(session.status).toBe('ACTIVE');

      const list = await withTestTenant(async () => aiTutoringController.list(fakeAdminReq()));
      expect(list.map((s) => s.id)).toContain(session.id);

      const fetched = await withTestTenant(async () =>
        aiTutoringController.getOne(session.id, fakeAdminReq()),
      );
      expect(fetched.id).toBe(session.id);

      const reply = await withTestTenant(async () =>
        aiTutoringController.postMessage(
          session.id,
          { content: 'Help me with quadratic equations' } as any,
          fakeAdminReq(),
        ),
      );
      expect(reply.student.content).toContain('quadratic');
      expect(reply.assistant.role).toBe('ASSISTANT');

      const completed = await withTestTenant(async () =>
        aiTutoringController.complete(session.id, { notes: 'good session' } as any, fakeAdminReq()),
      );
      expect(completed.status).toBe('COMPLETED');

      const signals = await withTestTenant(async () =>
        aiTutoringController.extractSignals(session.id, fakeAdminReq()),
      );
      expect(Array.isArray(signals)).toBe(true);

      const sessionSignals = await withTestTenant(async () =>
        aiTutoringController.listSessionSignals(session.id, fakeAdminReq()),
      );
      expect(Array.isArray(sessionSignals)).toBe(true);

      const studentSignals = await withTestTenant(async () =>
        aiTutoringController.listStudentSignals(student.studentId, fakeAdminReq()),
      );
      expect(Array.isArray(studentSignals)).toBe(true);
    });
  });
});
