import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { PeerReviewService } from '@modules/m21-classroom/peer-review/peer-review.service';
import { AssignmentService } from '@modules/m21-classroom/assignments/assignment.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import type { KafkaProducerService } from '@shared/kafka/kafka-producer.service';

import { makeRecordingKafka } from '../helpers/recording-kafka';
import { withTestTenant, TEST_SCHEMA, TEST_SCHOOL_ID } from '../helpers/tenant-context';
import {
  adminActor,
  teacherActor,
  studentActor,
  TEST_STUDENT_PERSON_ID,
  TEST_TEACHER_EMPLOYEE_ID,
} from '../helpers/actor';
import { TEST_SIS_CLASS_ID } from '../fixtures/sis';
import {
  seedStudent,
  enrollStudent,
  assignTeacherToClass,
  cleanupSeededIds,
} from '../m20-sis/sis-helpers';

/**
 * Wave 4 — m21-classroom PeerReviewService DB-backed integration tests.
 *
 * Contracts:
 *   - getForAssignment + enableForAssignment + assignReviews + listMy +
 *     listForAssignment + listForSubmission + submit + markTeacherReviewed +
 *     getReviewById
 *   - Anonymisation: when is_anonymous=true the reviewer identity is stripped
 *     from the DTO for non-staff readers (other students), but teachers +
 *     admins always see full identity for audit.
 *   - Random distribution never pairs a student with their own submission and
 *     respects reviewsPerStudent.
 *   - TEACHER_ASSIGNED mode honours input.manualAssignments and rejects
 *     self-review.
 *   - UNIQUE(assignment_id) at the schema layer is surfaced as BadRequest.
 *   - State transitions are row-locked: ASSIGNED → SUBMITTED →
 *     REVIEWED_BY_TEACHER. Non-reviewer cannot submit, non-employee cannot
 *     mark-reviewed, terminal states reject re-marking.
 */
describe('integration:m21-classroom/peer-review', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let assignmentService: AssignmentService;
  let service: PeerReviewService;

  const personIds: string[] = [];
  const platformStudentIds: string[] = [];
  const studentIds: string[] = [];
  const guardianIds: string[] = [];
  const accountIds: string[] = [];

  let assignmentTypeId: string;

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

  /**
   * Strip stray rows tied to the static STUDENT actor person id that may
   * have leaked from a prior spec file. Idempotent — safe to call from
   * both beforeAll and beforeEach.
   */
  async function pruneStudentActorLeak(): Promise<void> {
    // Children of sis_students by person_id chain.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.cls_peer_reviews
       WHERE reviewer_student_id IN (
         SELECT s.id FROM ${TEST_SCHEMA}.sis_students s
         JOIN platform.platform_students ps ON ps.id = s.platform_student_id
         WHERE ps.person_id = $1::uuid)`,
      TEST_STUDENT_PERSON_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.cls_grades
       WHERE student_id IN (
         SELECT s.id FROM ${TEST_SCHEMA}.sis_students s
         JOIN platform.platform_students ps ON ps.id = s.platform_student_id
         WHERE ps.person_id = $1::uuid)`,
      TEST_STUDENT_PERSON_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.cls_submissions
       WHERE student_id IN (
         SELECT s.id FROM ${TEST_SCHEMA}.sis_students s
         JOIN platform.platform_students ps ON ps.id = s.platform_student_id
         WHERE ps.person_id = $1::uuid)`,
      TEST_STUDENT_PERSON_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_enrollments
       WHERE student_id IN (
         SELECT s.id FROM ${TEST_SCHEMA}.sis_students s
         JOIN platform.platform_students ps ON ps.id = s.platform_student_id
         WHERE ps.person_id = $1::uuid)`,
      TEST_STUDENT_PERSON_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_students
       WHERE platform_student_id IN (
         SELECT id FROM platform.platform_students WHERE person_id = $1::uuid)`,
      TEST_STUDENT_PERSON_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_students WHERE person_id = $1::uuid`,
      TEST_STUDENT_PERSON_ID,
    );
  }

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const kafka = makeRecordingKafka();
    assignmentService = new AssignmentService(
      tenantPrisma,
      kafka as unknown as KafkaProducerService,
    );
    service = new PeerReviewService(tenantPrisma);
    assignmentTypeId = await ensureAssignmentType();
    // Final-line-of-defence: even if a previous spec leaked a STUDENT
    // actor row, prune it before any test in this spec runs.
    await pruneStudentActorLeak();
  });

  afterAll(async () => {
    // Final cleanup so the next spec doesn't trip on platform_students.
    await pruneStudentActorLeak();
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    // Wipe per-test state. Order matters — children before parents.
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_peer_reviews`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_peer_review_assignments`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_rubric_scores`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_grades`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_submissions`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_assignments`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_rubric_criteria`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_rubrics`);
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

  async function trackedStudent(opts: Parameters<typeof seedStudent>[1] = {}) {
    const s = await seedStudent(rawClient, opts);
    studentIds.push(s.studentId);
    platformStudentIds.push(s.platformStudentId);
    personIds.push(s.personId);
    return s;
  }

  /**
   * Seed a sis_students row linked to the STUDENT actor persona so the
   * service can resolve callerStudentId via actor.personId. Returns the
   * sis_students.id. Idempotent on platform_students(person_id) — if a
   * row already exists for the actor (leaked from a prior spec), reuse
   * it instead of inserting a fresh row that would trip UNIQUE.
   */
  async function ensureStudentActorSisRow(): Promise<string> {
    await pruneStudentActorLeak();
    const psId = generateId();
    const sid = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
         VALUES ($1::uuid, $2::uuid, 'Self', 'Reviewer', true)`,
      psId,
      TEST_STUDENT_PERSON_ID,
    );
    platformStudentIds.push(psId);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_students
         (id, platform_student_id, school_id, student_number, grade_level, enrollment_status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '5', 'ENROLLED')`,
      sid,
      psId,
      TEST_SCHOOL_ID,
      'PR-SELF-' + Math.random().toString(36).slice(2, 8),
    );
    studentIds.push(sid);
    return sid;
  }

  async function makePublishedAssignment(title = 'Peer Essay'): Promise<string> {
    const a = await withTestTenant(async () =>
      assignmentService.create(
        TEST_SIS_CLASS_ID,
        { title, assignmentTypeId, isPublished: true, maxPoints: 100 } as any,
        adminActor(),
      ),
    );
    return a.id;
  }

  async function makeSubmission(assignmentId: string, studentSisId: string): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.cls_submissions
         (id, assignment_id, student_id, status, submission_text, attachments, submitted_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'SUBMITTED', 'work', '[]'::jsonb, now())`,
      id,
      assignmentId,
      studentSisId,
    );
    return id;
  }

  // ────────────────────────────────────────────────────────────────────
  // enableForAssignment + getForAssignment
  // ────────────────────────────────────────────────────────────────────
  describe('enableForAssignment / getForAssignment', () => {
    it('admin enables peer review for assignment → row inserted + getForAssignment returns DTO', async () => {
      const aid = await makePublishedAssignment();
      const enabled = await withTestTenant(async () =>
        service.enableForAssignment(
          aid,
          { reviewType: 'RANDOM', reviewsPerStudent: 2, isAnonymous: true } as any,
          adminActor(),
        ),
      );
      expect(enabled.assignmentId).toBe(aid);
      expect(enabled.reviewType).toBe('RANDOM');
      expect(enabled.reviewsPerStudent).toBe(2);
      expect(enabled.isAnonymous).toBe(true);

      const fetched = await withTestTenant(async () => service.getForAssignment(aid));
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(enabled.id);
    });

    it('teacher of the class enables peer review → succeeds, created_by = employee', async () => {
      await assignTeacherToClass(rawClient, TEST_SIS_CLASS_ID, TEST_TEACHER_EMPLOYEE_ID);
      const aid = await makePublishedAssignment();
      const enabled = await withTestTenant(async () =>
        service.enableForAssignment(aid, {} as any, teacherActor()),
      );
      expect(enabled.createdBy).toBe(TEST_TEACHER_EMPLOYEE_ID);
    });

    it('teacher NOT assigned to the class → ForbiddenException', async () => {
      const aid = await makePublishedAssignment();
      await expect(
        withTestTenant(async () => service.enableForAssignment(aid, {} as any, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('non-employee actor (student) → ForbiddenException', async () => {
      const aid = await makePublishedAssignment();
      await expect(
        withTestTenant(async () => service.enableForAssignment(aid, {} as any, studentActor()), {
          personId: TEST_STUDENT_PERSON_ID,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('phantom assignment id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.enableForAssignment(
            '00000000-0000-0000-0000-000000000000',
            {} as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('re-enable on the same assignment → BadRequestException (UNIQUE keystone)', async () => {
      const aid = await makePublishedAssignment();
      await withTestTenant(async () => service.enableForAssignment(aid, {} as any, adminActor()));
      await expect(
        withTestTenant(async () => service.enableForAssignment(aid, {} as any, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rubricId that does not exist → BadRequestException', async () => {
      const aid = await makePublishedAssignment();
      await expect(
        withTestTenant(async () =>
          service.enableForAssignment(
            aid,
            { rubricId: '00000000-0000-0000-0000-000000000000' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('getForAssignment with no config → returns null', async () => {
      const aid = await makePublishedAssignment();
      const fetched = await withTestTenant(async () => service.getForAssignment(aid));
      expect(fetched).toBeNull();
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // assignReviews
  // ────────────────────────────────────────────────────────────────────
  describe('assignReviews', () => {
    it('RANDOM mode pairs each student to reviews_per_student peers, never to own submission', async () => {
      const aid = await makePublishedAssignment();
      const enabled = await withTestTenant(async () =>
        service.enableForAssignment(
          aid,
          { reviewType: 'RANDOM', reviewsPerStudent: 2, isAnonymous: true } as any,
          adminActor(),
        ),
      );
      const s1 = await trackedStudent({ firstName: 'A', lastName: '1' });
      const s2 = await trackedStudent({ firstName: 'B', lastName: '2' });
      const s3 = await trackedStudent({ firstName: 'C', lastName: '3' });
      const submissions = [
        [s1.studentId, await makeSubmission(aid, s1.studentId)] as const,
        [s2.studentId, await makeSubmission(aid, s2.studentId)] as const,
        [s3.studentId, await makeSubmission(aid, s3.studentId)] as const,
      ];
      const out = await withTestTenant(async () =>
        service.assignReviews(enabled.id, {} as any, adminActor()),
      );
      expect(out).toHaveLength(3 * 2); // 3 students × 2 peers each
      // Self-review check: pull cls_submissions + cls_peer_reviews and assert
      // no row has reviewer_student_id matching the submission owner.
      for (const row of out) {
        const reviewer = row.reviewerStudentId;
        const subOwner = submissions.find(([, subId]) => subId === row.revieweeSubmissionId)?.[0];
        expect(reviewer).not.toBe(subOwner);
      }
    });

    it('RANDOM mode rejects when fewer than 2 eligible submissions', async () => {
      const aid = await makePublishedAssignment();
      const enabled = await withTestTenant(async () =>
        service.enableForAssignment(aid, { reviewType: 'RANDOM' } as any, adminActor()),
      );
      const s1 = await trackedStudent();
      await makeSubmission(aid, s1.studentId);
      await expect(
        withTestTenant(async () => service.assignReviews(enabled.id, {} as any, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('TEACHER_ASSIGNED mode without manualAssignments → BadRequest', async () => {
      const aid = await makePublishedAssignment();
      const enabled = await withTestTenant(async () =>
        service.enableForAssignment(aid, { reviewType: 'TEACHER_ASSIGNED' } as any, adminActor()),
      );
      const s1 = await trackedStudent({ firstName: 'X', lastName: '1' });
      const s2 = await trackedStudent({ firstName: 'Y', lastName: '2' });
      await makeSubmission(aid, s1.studentId);
      await makeSubmission(aid, s2.studentId);
      await expect(
        withTestTenant(async () => service.assignReviews(enabled.id, {} as any, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('TEACHER_ASSIGNED mode with manual map → only those pairings created', async () => {
      const aid = await makePublishedAssignment();
      const enabled = await withTestTenant(async () =>
        service.enableForAssignment(
          aid,
          { reviewType: 'TEACHER_ASSIGNED', reviewsPerStudent: 1 } as any,
          adminActor(),
        ),
      );
      const s1 = await trackedStudent({ firstName: 'P', lastName: '1' });
      const s2 = await trackedStudent({ firstName: 'Q', lastName: '2' });
      const sub1 = await makeSubmission(aid, s1.studentId);
      const sub2 = await makeSubmission(aid, s2.studentId);
      const out = await withTestTenant(async () =>
        service.assignReviews(
          enabled.id,
          {
            manualAssignments: {
              [s1.studentId]: [sub2],
              [s2.studentId]: [sub1],
            },
          } as any,
          adminActor(),
        ),
      );
      expect(out).toHaveLength(2);
      const pairs = out.map((r) => ({
        reviewer: r.reviewerStudentId,
        sub: r.revieweeSubmissionId,
      }));
      // RANDOM unused — make sure NO reviewer was paired with their own submission
      for (const p of pairs) {
        // Re-derive sub owner
        if (p.sub === sub1) expect(p.reviewer).not.toBe(s1.studentId);
        if (p.sub === sub2) expect(p.reviewer).not.toBe(s2.studentId);
      }
    });

    it('TEACHER_ASSIGNED mode self-review pairing → BadRequest', async () => {
      const aid = await makePublishedAssignment();
      const enabled = await withTestTenant(async () =>
        service.enableForAssignment(
          aid,
          { reviewType: 'TEACHER_ASSIGNED', reviewsPerStudent: 1 } as any,
          adminActor(),
        ),
      );
      const s1 = await trackedStudent({ firstName: 'P', lastName: '1' });
      const s2 = await trackedStudent({ firstName: 'Q', lastName: '2' });
      const sub1 = await makeSubmission(aid, s1.studentId);
      await makeSubmission(aid, s2.studentId);
      await expect(
        withTestTenant(async () =>
          service.assignReviews(
            enabled.id,
            { manualAssignments: { [s1.studentId]: [sub1] } } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('TEACHER_ASSIGNED references a submission not on this assignment → BadRequest', async () => {
      const aid = await makePublishedAssignment();
      const enabled = await withTestTenant(async () =>
        service.enableForAssignment(aid, { reviewType: 'TEACHER_ASSIGNED' } as any, adminActor()),
      );
      const s1 = await trackedStudent({ firstName: 'P', lastName: '1' });
      const s2 = await trackedStudent({ firstName: 'Q', lastName: '2' });
      await makeSubmission(aid, s1.studentId);
      await makeSubmission(aid, s2.studentId);
      await expect(
        withTestTenant(async () =>
          service.assignReviews(
            enabled.id,
            {
              manualAssignments: { [s1.studentId]: ['00000000-0000-0000-0000-000000000000'] },
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('non-employee caller → ForbiddenException', async () => {
      await expect(
        withTestTenant(
          async () =>
            service.assignReviews(
              '00000000-0000-0000-0000-000000000000',
              {} as any,
              studentActor(),
            ),
          { personId: TEST_STUDENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('phantom peer-assignment id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.assignReviews('00000000-0000-0000-0000-000000000000', {} as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // listForAssignment / listMy / listForSubmission — anonymisation gating
  // ────────────────────────────────────────────────────────────────────
  describe('listing + anonymisation', () => {
    /**
     * Seed two students with submissions and a SUBMITTED peer-review pair
     * where s1 reviews s2's submission. Returns the relevant ids and the
     * peer review row id.
     */
    async function seedSubmittedPair(opts: { anonymous: boolean }) {
      const aid = await makePublishedAssignment();
      const enabled = await withTestTenant(async () =>
        service.enableForAssignment(
          aid,
          {
            reviewType: 'TEACHER_ASSIGNED',
            reviewsPerStudent: 1,
            isAnonymous: opts.anonymous,
          } as any,
          adminActor(),
        ),
      );
      const reviewerSid = await ensureStudentActorSisRow();
      const peer = await trackedStudent({ firstName: 'Peer', lastName: 'X' });
      const reviewerSub = await makeSubmission(aid, reviewerSid);
      const peerSub = await makeSubmission(aid, peer.studentId);
      await withTestTenant(async () =>
        service.assignReviews(
          enabled.id,
          {
            manualAssignments: {
              [reviewerSid]: [peerSub],
              [peer.studentId]: [reviewerSub],
            },
          } as any,
          adminActor(),
        ),
      );
      // Pick the reviewer→peer pairing.
      const rows = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text AS id FROM ${TEST_SCHEMA}.cls_peer_reviews
         WHERE peer_assignment_id = $1::uuid AND reviewer_student_id = $2::uuid`,
        enabled.id,
        reviewerSid,
      );
      const reviewId = rows[0]!.id;
      // Reviewer (the student actor) submits feedback
      await withTestTenant(
        async () =>
          service.submit(
            reviewId,
            { feedback: 'good job', overallRating: 'GOOD' } as any,
            studentActor(),
          ),
        { personId: TEST_STUDENT_PERSON_ID },
      );
      return {
        peerAssignmentId: enabled.id,
        reviewId,
        reviewerSid,
        peerSid: peer.studentId,
        peerSubmissionId: peerSub,
        reviewerSubmissionId: reviewerSub,
      };
    }

    it('admin sees full reviewer identity even on anonymous reviews', async () => {
      const ctx = await seedSubmittedPair({ anonymous: true });
      const list = await withTestTenant(async () =>
        service.listForAssignment(ctx.peerAssignmentId, adminActor()),
      );
      const row = list.find((r) => r.id === ctx.reviewId)!;
      expect(row.reviewerStudentId).toBe(ctx.reviewerSid);
      expect(row.isAnonymousView).toBe(false);
    });

    it('reviewee (other student) viewing an anonymous review → reviewer identity stripped', async () => {
      const ctx = await seedSubmittedPair({ anonymous: true });
      // Switch the student actor's persona to the peer (reviewee).
      // We re-seed the peer to be the student actor.
      // For this test we simply directly load the list as the original
      // student actor for the peer's submission — but the student
      // actor IS the reviewer, so listForSubmission of the peer's
      // submission shows the reviewer as themself (not stripped).
      // To test anonymity from the reviewee's perspective we need to
      // call listForSubmission scoped to the REVIEWER's own submission
      // (which is owned by them) with their own actor — but that won't
      // see the review because the reviewer→peer pair targets the
      // PEER's submission. So we test the reverse pair:
      // peer→reviewer, which means the student actor IS the reviewee.
      // Force this via the second pairing seeded by seedSubmittedPair.
      // The peer→reviewer pair is in ASSIGNED state, so submit it as
      // admin on behalf of the peer student — but submit() requires
      // matching reviewer studentId. Instead, manually update.
      const peerToReviewerRow = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text AS id FROM ${TEST_SCHEMA}.cls_peer_reviews
         WHERE peer_assignment_id = $1::uuid AND reviewer_student_id = $2::uuid`,
        ctx.peerAssignmentId,
        ctx.peerSid,
      );
      const peerReviewId = peerToReviewerRow[0]!.id;
      // Submit on behalf of the peer student via admin role (service allows admin)
      await withTestTenant(async () =>
        service.submit(peerReviewId, { feedback: 'thanks!' } as any, adminActor()),
      );

      // Now the student-actor calls listForSubmission for THEIR OWN
      // submission and should see the peer's review with identity
      // stripped (anonymous + non-staff reader + not the reviewer themself).
      const list = await withTestTenant(
        async () => service.listForSubmission(ctx.reviewerSubmissionId, studentActor()),
        { personId: TEST_STUDENT_PERSON_ID },
      );
      const got = list.find((r) => r.id === peerReviewId);
      expect(got).toBeDefined();
      expect(got!.reviewerStudentId).toBeNull();
      expect(got!.reviewerStudentName).toBeNull();
      expect(got!.isAnonymousView).toBe(true);
    });

    it('non-anonymous review: reviewer identity is preserved for everyone', async () => {
      const ctx = await seedSubmittedPair({ anonymous: false });
      // Submit the peer-side review as admin so listForSubmission picks it up
      const peerToReviewerRow = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text AS id FROM ${TEST_SCHEMA}.cls_peer_reviews
         WHERE peer_assignment_id = $1::uuid AND reviewer_student_id = $2::uuid`,
        ctx.peerAssignmentId,
        ctx.peerSid,
      );
      const peerReviewId = peerToReviewerRow[0]!.id;
      await withTestTenant(async () =>
        service.submit(peerReviewId, { feedback: 'visible' } as any, adminActor()),
      );

      const list = await withTestTenant(
        async () => service.listForSubmission(ctx.reviewerSubmissionId, studentActor()),
        { personId: TEST_STUDENT_PERSON_ID },
      );
      const got = list.find((r) => r.id === peerReviewId)!;
      expect(got.reviewerStudentId).toBe(ctx.peerSid);
      expect(got.isAnonymousView).toBe(false);
    });

    it('reviewer themself ALWAYS sees their own identity even on anonymous reviews', async () => {
      const ctx = await seedSubmittedPair({ anonymous: true });
      // listMy from the reviewer (student actor) — they should see
      // their own reviewer_student_id.
      const list = await withTestTenant(async () => service.listMy(studentActor()), {
        personId: TEST_STUDENT_PERSON_ID,
      });
      const own = list.find((r) => r.id === ctx.reviewId)!;
      expect(own.reviewerStudentId).toBe(ctx.reviewerSid);
    });

    it('listMy for non-STUDENT actor → empty list', async () => {
      const list = await withTestTenant(async () => service.listMy(adminActor()));
      expect(list).toEqual([]);
    });

    it('listForAssignment with phantom id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.listForAssignment('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('listForSubmission only returns SUBMITTED + REVIEWED_BY_TEACHER reviews (ASSIGNED hidden)', async () => {
      const aid = await makePublishedAssignment();
      const enabled = await withTestTenant(async () =>
        service.enableForAssignment(
          aid,
          { reviewType: 'TEACHER_ASSIGNED', reviewsPerStudent: 1 } as any,
          adminActor(),
        ),
      );
      const reviewerSid = await ensureStudentActorSisRow();
      const peer = await trackedStudent();
      const peerSub = await makeSubmission(aid, peer.studentId);
      const reviewerSub = await makeSubmission(aid, reviewerSid);
      await withTestTenant(async () =>
        service.assignReviews(
          enabled.id,
          {
            manualAssignments: {
              [reviewerSid]: [peerSub],
              [peer.studentId]: [reviewerSub],
            },
          } as any,
          adminActor(),
        ),
      );
      // Both still ASSIGNED.
      const list = await withTestTenant(async () =>
        service.listForSubmission(peerSub, adminActor()),
      );
      expect(list).toEqual([]);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // submit
  // ────────────────────────────────────────────────────────────────────
  describe('submit', () => {
    async function seedAssigned(): Promise<{ reviewId: string; reviewerSid: string }> {
      const aid = await makePublishedAssignment();
      const enabled = await withTestTenant(async () =>
        service.enableForAssignment(
          aid,
          { reviewType: 'TEACHER_ASSIGNED', reviewsPerStudent: 1 } as any,
          adminActor(),
        ),
      );
      const reviewerSid = await ensureStudentActorSisRow();
      const peer = await trackedStudent();
      const peerSub = await makeSubmission(aid, peer.studentId);
      await makeSubmission(aid, reviewerSid);
      await withTestTenant(async () =>
        service.assignReviews(
          enabled.id,
          { manualAssignments: { [reviewerSid]: [peerSub] } } as any,
          adminActor(),
        ),
      );
      const rows = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text AS id FROM ${TEST_SCHEMA}.cls_peer_reviews
         WHERE peer_assignment_id = $1::uuid AND reviewer_student_id = $2::uuid`,
        enabled.id,
        reviewerSid,
      );
      return { reviewId: rows[0]!.id, reviewerSid };
    }

    it('reviewer submits feedback → status flips to SUBMITTED, submitted_at set', async () => {
      const { reviewId } = await seedAssigned();
      const out = await withTestTenant(
        async () =>
          service.submit(
            reviewId,
            { feedback: 'great work', overallRating: 'EXCELLENT' } as any,
            studentActor(),
          ),
        { personId: TEST_STUDENT_PERSON_ID },
      );
      expect(out.status).toBe('SUBMITTED');
      expect(out.feedback).toBe('great work');
      expect(out.overallRating).toBe('EXCELLENT');
      expect(out.submittedAt).not.toBeNull();
    });

    it('admin submits on behalf of the reviewer → succeeds', async () => {
      const { reviewId } = await seedAssigned();
      const out = await withTestTenant(async () =>
        service.submit(reviewId, { feedback: 'admin override' } as any, adminActor()),
      );
      expect(out.status).toBe('SUBMITTED');
    });

    it("a different student trying to submit someone else's review → ForbiddenException", async () => {
      const { reviewId } = await seedAssigned();
      // Re-seed the student actor to a NEW student (not the reviewer)
      // by creating a fresh sis_students row keyed off the original
      // persona. The reviewer's row was already created — so attempt
      // submit as the same actor but force a non-matching personType
      // via parentActor (no studentId resolve) which should hit
      // ForbiddenException because parentActor.personType = GUARDIAN.
      const { parentActor: parentActorFn, TEST_PARENT_PERSON_ID } =
        await import('../helpers/actor');
      await expect(
        withTestTenant(
          async () => service.submit(reviewId, { feedback: 'nope' } as any, parentActorFn()),
          { personId: TEST_PARENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('re-submit overwrites in place (still SUBMITTED)', async () => {
      const { reviewId } = await seedAssigned();
      const first = await withTestTenant(
        async () =>
          service.submit(
            reviewId,
            { feedback: 'v1', overallRating: 'GOOD' } as any,
            studentActor(),
          ),
        { personId: TEST_STUDENT_PERSON_ID },
      );
      const second = await withTestTenant(
        async () =>
          service.submit(
            reviewId,
            { feedback: 'v2', overallRating: 'EXCELLENT' } as any,
            studentActor(),
          ),
        { personId: TEST_STUDENT_PERSON_ID },
      );
      expect(second.id).toBe(first.id);
      expect(second.feedback).toBe('v2');
      expect(second.overallRating).toBe('EXCELLENT');
    });

    it('after teacher review, re-submit → BadRequestException (terminal state)', async () => {
      const { reviewId } = await seedAssigned();
      await withTestTenant(
        async () => service.submit(reviewId, { feedback: 'v1' } as any, studentActor()),
        { personId: TEST_STUDENT_PERSON_ID },
      );
      await withTestTenant(async () => service.markTeacherReviewed(reviewId, adminActor()));
      await expect(
        withTestTenant(
          async () => service.submit(reviewId, { feedback: 'v2' } as any, studentActor()),
          { personId: TEST_STUDENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('unknown review id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.submit(
            '00000000-0000-0000-0000-000000000000',
            { feedback: 'x' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // markTeacherReviewed
  // ────────────────────────────────────────────────────────────────────
  describe('markTeacherReviewed', () => {
    async function seedSubmitted(): Promise<string> {
      const aid = await makePublishedAssignment();
      const enabled = await withTestTenant(async () =>
        service.enableForAssignment(aid, { reviewType: 'TEACHER_ASSIGNED' } as any, adminActor()),
      );
      const reviewerSid = await ensureStudentActorSisRow();
      const peer = await trackedStudent();
      const peerSub = await makeSubmission(aid, peer.studentId);
      await makeSubmission(aid, reviewerSid);
      await withTestTenant(async () =>
        service.assignReviews(
          enabled.id,
          { manualAssignments: { [reviewerSid]: [peerSub] } } as any,
          adminActor(),
        ),
      );
      const rows = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text AS id FROM ${TEST_SCHEMA}.cls_peer_reviews
         WHERE peer_assignment_id = $1::uuid AND reviewer_student_id = $2::uuid`,
        enabled.id,
        reviewerSid,
      );
      const id = rows[0]!.id;
      await withTestTenant(
        async () => service.submit(id, { feedback: 'ok' } as any, studentActor()),
        { personId: TEST_STUDENT_PERSON_ID },
      );
      return id;
    }

    it('admin marks review as teacher-reviewed → status flips, teacher_reviewed_by set', async () => {
      const id = await seedSubmitted();
      const out = await withTestTenant(async () => service.markTeacherReviewed(id, adminActor()));
      expect(out.status).toBe('REVIEWED_BY_TEACHER');
      expect(out.teacherReviewedAt).not.toBeNull();
    });

    it('non-employee actor (student) → ForbiddenException', async () => {
      const id = await seedSubmitted();
      await expect(
        withTestTenant(async () => service.markTeacherReviewed(id, studentActor()), {
          personId: TEST_STUDENT_PERSON_ID,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('ASSIGNED status cannot be teacher-reviewed yet → BadRequestException', async () => {
      const aid = await makePublishedAssignment();
      const enabled = await withTestTenant(async () =>
        service.enableForAssignment(aid, { reviewType: 'TEACHER_ASSIGNED' } as any, adminActor()),
      );
      const reviewerSid = await ensureStudentActorSisRow();
      const peer = await trackedStudent();
      const peerSub = await makeSubmission(aid, peer.studentId);
      await makeSubmission(aid, reviewerSid);
      await withTestTenant(async () =>
        service.assignReviews(
          enabled.id,
          { manualAssignments: { [reviewerSid]: [peerSub] } } as any,
          adminActor(),
        ),
      );
      const rows = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text AS id FROM ${TEST_SCHEMA}.cls_peer_reviews
         WHERE peer_assignment_id = $1::uuid AND reviewer_student_id = $2::uuid`,
        enabled.id,
        reviewerSid,
      );
      await expect(
        withTestTenant(async () => service.markTeacherReviewed(rows[0]!.id, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('already teacher-reviewed → BadRequestException', async () => {
      const id = await seedSubmitted();
      await withTestTenant(async () => service.markTeacherReviewed(id, adminActor()));
      await expect(
        withTestTenant(async () => service.markTeacherReviewed(id, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.markTeacherReviewed('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // getReviewById
  // ────────────────────────────────────────────────────────────────────
  describe('getReviewById', () => {
    it('admin fetches by id', async () => {
      const aid = await makePublishedAssignment();
      const enabled = await withTestTenant(async () =>
        service.enableForAssignment(aid, { reviewType: 'TEACHER_ASSIGNED' } as any, adminActor()),
      );
      const reviewerSid = await ensureStudentActorSisRow();
      const peer = await trackedStudent();
      const peerSub = await makeSubmission(aid, peer.studentId);
      await makeSubmission(aid, reviewerSid);
      await withTestTenant(async () =>
        service.assignReviews(
          enabled.id,
          { manualAssignments: { [reviewerSid]: [peerSub] } } as any,
          adminActor(),
        ),
      );
      const rows = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text AS id FROM ${TEST_SCHEMA}.cls_peer_reviews
         WHERE peer_assignment_id = $1::uuid`,
        enabled.id,
      );
      const id = rows[0]!.id;
      const got = await withTestTenant(async () => service.getReviewById(id, adminActor()));
      expect(got.id).toBe(id);
      expect(got.status).toBe('ASSIGNED');
    });

    it('unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.getReviewById('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
