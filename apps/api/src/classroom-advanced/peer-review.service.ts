import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  AssignPeerReviewsDto,
  CreatePeerReviewAssignmentDto,
  type PeerOverallRating,
  PeerReviewAssignmentResponseDto,
  PeerReviewResponseDto,
  type PeerReviewStatus,
  type PeerReviewType,
  SubmitPeerReviewDto,
} from './dto/peer-review.dto';

interface PeerAssignmentRow {
  id: string;
  assignment_id: string;
  assignment_title: string | null;
  review_type: PeerReviewType;
  reviews_per_student: number;
  is_anonymous: boolean;
  rubric_id: string | null;
  rubric_title: string | null;
  due_date: Date | string | null;
  instructions: string | null;
  created_by: string;
  created_by_name: string | null;
  total_reviews: number;
  submitted_reviews: number;
  created_at: Date | string;
  updated_at: Date | string;
}

interface PeerReviewRow {
  id: string;
  peer_assignment_id: string;
  reviewer_student_id: string;
  reviewer_student_name: string | null;
  reviewee_submission_id: string;
  reviewee_student_id: string | null;
  reviewee_student_name: string | null;
  feedback: string | null;
  overall_rating: PeerOverallRating | null;
  status: PeerReviewStatus;
  submitted_at: Date | string | null;
  teacher_reviewed_by: string | null;
  teacher_reviewed_at: Date | string | null;
  is_anonymous: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

function toIso(v: Date | string | null): string | null {
  if (v === null) return null;
  return typeof v === 'string' ? v : v.toISOString();
}

function assignmentRowToDto(row: PeerAssignmentRow): PeerReviewAssignmentResponseDto {
  return {
    id: row.id,
    assignmentId: row.assignment_id,
    assignmentTitle: row.assignment_title,
    reviewType: row.review_type,
    reviewsPerStudent: row.reviews_per_student,
    isAnonymous: row.is_anonymous,
    rubricId: row.rubric_id,
    rubricTitle: row.rubric_title,
    dueDate: toIso(row.due_date),
    instructions: row.instructions,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    totalReviews: Number(row.total_reviews),
    submittedReviews: Number(row.submitted_reviews),
    createdAt: toIso(row.created_at) ?? '',
    updatedAt: toIso(row.updated_at) ?? '',
  };
}

const SELECT_ASSIGNMENT_BASE =
  'SELECT pa.id, pa.assignment_id, a.title AS assignment_title, ' +
  'pa.review_type, pa.reviews_per_student, pa.is_anonymous, pa.rubric_id, ' +
  'r.title AS rubric_title, ' +
  'pa.due_date, pa.instructions, pa.created_by, ' +
  "(ip.first_name || ' ' || ip.last_name) AS created_by_name, " +
  '(SELECT count(*)::int FROM cls_peer_reviews pr WHERE pr.peer_assignment_id = pa.id) AS total_reviews, ' +
  "(SELECT count(*)::int FROM cls_peer_reviews pr WHERE pr.peer_assignment_id = pa.id AND pr.status IN ('SUBMITTED','REVIEWED_BY_TEACHER')) AS submitted_reviews, " +
  'pa.created_at, pa.updated_at ' +
  'FROM cls_peer_review_assignments pa ' +
  'LEFT JOIN cls_assignments a ON a.id = pa.assignment_id ' +
  'LEFT JOIN cls_rubrics r ON r.id = pa.rubric_id ' +
  'LEFT JOIN hr_employees he ON he.id = pa.created_by ' +
  'LEFT JOIN platform.iam_person ip ON ip.id = he.person_id ';

const SELECT_REVIEW_BASE =
  'SELECT pr.id, pr.peer_assignment_id, pr.reviewer_student_id, ' +
  "(ip_rev.first_name || ' ' || ip_rev.last_name) AS reviewer_student_name, " +
  'pr.reviewee_submission_id, ' +
  's_sub.student_id AS reviewee_student_id, ' +
  "(ip_ree.first_name || ' ' || ip_ree.last_name) AS reviewee_student_name, " +
  'pr.feedback, pr.overall_rating, pr.status, pr.submitted_at, ' +
  'pr.teacher_reviewed_by, pr.teacher_reviewed_at, ' +
  'pa.is_anonymous, ' +
  'pr.created_at, pr.updated_at ' +
  'FROM cls_peer_reviews pr ' +
  'JOIN cls_peer_review_assignments pa ON pa.id = pr.peer_assignment_id ' +
  'LEFT JOIN sis_students s_rev ON s_rev.id = pr.reviewer_student_id ' +
  'LEFT JOIN platform.platform_students ps_rev ON ps_rev.id = s_rev.platform_student_id ' +
  'LEFT JOIN platform.iam_person ip_rev ON ip_rev.id = ps_rev.person_id ' +
  'LEFT JOIN cls_submissions s_sub ON s_sub.id = pr.reviewee_submission_id ' +
  'LEFT JOIN sis_students s_ree ON s_ree.id = s_sub.student_id ' +
  'LEFT JOIN platform.platform_students ps_ree ON ps_ree.id = s_ree.platform_student_id ' +
  'LEFT JOIN platform.iam_person ip_ree ON ip_ree.id = ps_ree.person_id ';

@Injectable()
export class PeerReviewService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private requireEmployee(actor: ResolvedActor): string {
    if (!actor.employeeId) {
      throw new ForbiddenException(
        'Only teachers can manage peer review assignments. The calling user has no hr_employees record.',
      );
    }
    return actor.employeeId;
  }

  /** Verify the actor teaches the parent class of the assignment. Admins bypass. */
  private async assertCanManageAssignment(
    assignmentId: string,
    actor: ResolvedActor,
  ): Promise<{ classId: string }> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ class_id: string }>>(
        'SELECT class_id::text AS class_id FROM cls_assignments WHERE id = $1::uuid',
        assignmentId,
      );
    });
    if (rows.length === 0) {
      throw new NotFoundException('Assignment ' + assignmentId + ' not found');
    }
    const classId = rows[0]!.class_id;
    if (actor.isSchoolAdmin) return { classId };
    if (!actor.employeeId) {
      throw new ForbiddenException(
        'Only teachers can manage peer reviews. The calling user has no hr_employees record.',
      );
    }
    const teaches = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM sis_class_teachers WHERE class_id = $1::uuid AND teacher_employee_id = $2::uuid',
        classId,
        actor.employeeId,
      );
    });
    if (teaches.length === 0) {
      throw new ForbiddenException('You are not assigned to the class for this assignment.');
    }
    return { classId };
  }

  /** Resolve the calling student's sis_students.id from actor.personId. */
  private async resolveStudentSelfId(actor: ResolvedActor): Promise<string | null> {
    if (actor.personType !== 'STUDENT') return null;
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT s.id::text AS id FROM sis_students s ' +
          'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          'WHERE ps.person_id = $1::uuid',
        actor.personId,
      );
    });
    return rows[0]?.id ?? null;
  }

  /**
   * Strip reviewer identity from a peer review row when the parent
   * assignment is is_anonymous=true AND the reading actor is the
   * reviewee (or any student other than the reviewer themself).
   * Teachers + admins always see the full identity for audit.
   */
  private projectReviewToDto(
    row: PeerReviewRow,
    callerStudentId: string | null,
    isStaffOrAdmin: boolean,
  ): PeerReviewResponseDto {
    const isReviewerSelf = callerStudentId !== null && row.reviewer_student_id === callerStudentId;
    const stripIdentity = row.is_anonymous && !isStaffOrAdmin && !isReviewerSelf;
    return {
      id: row.id,
      peerAssignmentId: row.peer_assignment_id,
      reviewerStudentId: stripIdentity ? null : row.reviewer_student_id,
      reviewerStudentName: stripIdentity ? null : row.reviewer_student_name,
      revieweeSubmissionId: row.reviewee_submission_id,
      revieweeStudentId: row.reviewee_student_id,
      revieweeStudentName: row.reviewee_student_name,
      feedback: row.feedback,
      overallRating: row.overall_rating,
      status: row.status,
      submittedAt: toIso(row.submitted_at),
      teacherReviewedBy: row.teacher_reviewed_by,
      teacherReviewedAt: toIso(row.teacher_reviewed_at),
      isAnonymousView: stripIdentity,
      createdAt: toIso(row.created_at) ?? '',
      updatedAt: toIso(row.updated_at) ?? '',
    };
  }

  /** GET /classroom/assignments/:id/peer-review */
  async getForAssignment(assignmentId: string): Promise<PeerReviewAssignmentResponseDto | null> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<PeerAssignmentRow[]>(
        SELECT_ASSIGNMENT_BASE + ' WHERE pa.assignment_id = $1::uuid',
        assignmentId,
      );
    });
    return rows.length > 0 ? assignmentRowToDto(rows[0]!) : null;
  }

  /**
   * POST /classroom/assignments/:id/peer-review — teacher enables peer
   * review with config. UNIQUE(assignment_id) at the schema layer
   * means re-enabling returns 400 with a friendly hint.
   */
  async enableForAssignment(
    assignmentId: string,
    input: CreatePeerReviewAssignmentDto,
    actor: ResolvedActor,
  ): Promise<PeerReviewAssignmentResponseDto> {
    const employeeId = this.requireEmployee(actor);
    await this.assertCanManageAssignment(assignmentId, actor);

    // Validate optional rubric exists
    if (input.rubricId) {
      const exists = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM cls_rubrics WHERE id = $1::uuid',
          input.rubricId,
        );
      });
      if (exists.length === 0) {
        throw new BadRequestException('rubricId does not match a row in cls_rubrics.');
      }
    }

    const newId = generateId();
    try {
      await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'INSERT INTO cls_peer_review_assignments ' +
            '(id, assignment_id, review_type, reviews_per_student, is_anonymous, rubric_id, ' +
            'due_date, instructions, created_by) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4::int, $5, $6, $7::timestamptz, $8, $9::uuid)',
          newId,
          assignmentId,
          input.reviewType ?? 'RANDOM',
          input.reviewsPerStudent ?? 2,
          input.isAnonymous ?? true,
          input.rubricId ?? null,
          input.dueDate ?? null,
          input.instructions ?? null,
          employeeId,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException(
          'Peer review is already enabled for assignment ' +
            assignmentId +
            '. Patch the existing config instead of re-enabling.',
        );
      }
      throw err;
    }
    const created = await this.getForAssignment(assignmentId);
    if (!created) throw new NotFoundException('Peer review assignment not found after create');
    return created;
  }

  /**
   * POST /classroom/peer-reviews/assign — distribute submissions for review.
   * RANDOM mode walks the SUBMITTED + GRADED submissions for the parent
   * assignment and pairs each student to reviews_per_student peers' work.
   * TEACHER_ASSIGNED mode reads input.manualAssignments.
   */
  async assignReviews(
    peerAssignmentId: string,
    input: AssignPeerReviewsDto,
    actor: ResolvedActor,
  ): Promise<PeerReviewResponseDto[]> {
    this.requireEmployee(actor);

    const config = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<
        Array<{
          assignment_id: string;
          review_type: PeerReviewType;
          reviews_per_student: number;
        }>
      >(
        'SELECT assignment_id::text AS assignment_id, review_type, reviews_per_student ' +
          'FROM cls_peer_review_assignments WHERE id = $1::uuid',
        peerAssignmentId,
      );
    });
    if (config.length === 0) {
      throw new NotFoundException('Peer review assignment ' + peerAssignmentId + ' not found');
    }
    const cfg = config[0]!;
    await this.assertCanManageAssignment(cfg.assignment_id, actor);

    // Load eligible submissions (must be SUBMITTED at minimum)
    const submissions = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ id: string; student_id: string }>>(
        'SELECT id::text AS id, student_id::text AS student_id ' +
          'FROM cls_submissions WHERE assignment_id = $1::uuid ' +
          "AND status IN ('SUBMITTED','GRADED','RETURNED')",
        cfg.assignment_id,
      );
    });
    if (submissions.length < 2) {
      throw new BadRequestException(
        'Need at least 2 submissions to distribute peer reviews. Currently ' +
          submissions.length +
          ' eligible.',
      );
    }

    const pairings: Array<{ reviewerStudentId: string; revieweeSubmissionId: string }> = [];

    if (cfg.review_type === 'TEACHER_ASSIGNED') {
      if (!input.manualAssignments) {
        throw new BadRequestException(
          'manualAssignments map is required when review_type=TEACHER_ASSIGNED.',
        );
      }
      const submissionIds = new Set(submissions.map((s) => s.id));
      for (const [reviewerStudentId, submissionList] of Object.entries(input.manualAssignments)) {
        for (const submissionId of submissionList) {
          if (!submissionIds.has(submissionId)) {
            throw new BadRequestException(
              'Submission ' + submissionId + ' is not eligible for review on this assignment.',
            );
          }
          // Self-review prevention: skip pairings where reviewer == author
          const sub = submissions.find((s) => s.id === submissionId);
          if (sub && sub.student_id === reviewerStudentId) {
            throw new BadRequestException(
              'Cannot assign student ' +
                reviewerStudentId +
                ' to review their own submission ' +
                submissionId +
                '.',
            );
          }
          pairings.push({ reviewerStudentId, revieweeSubmissionId: submissionId });
        }
      }
    } else {
      // RANDOM: each student reviews reviews_per_student peers.
      // Deterministic shuffle: rotate by k=1..N for each student so no
      // student reviews their own submission and the load distributes
      // across the cohort.
      const studentIds = submissions.map((s) => s.student_id);
      const submissionsByStudent = new Map(submissions.map((s) => [s.student_id, s.id]));

      for (let i = 0; i < studentIds.length; i++) {
        const reviewerStudentId = studentIds[i]!;
        const targets = new Set<string>();
        for (let k = 1; targets.size < cfg.reviews_per_student && k < studentIds.length; k++) {
          const targetIdx = (i + k) % studentIds.length;
          const targetStudentId = studentIds[targetIdx]!;
          const submissionId = submissionsByStudent.get(targetStudentId);
          if (submissionId) {
            targets.add(submissionId);
          }
        }
        for (const submissionId of targets) {
          pairings.push({ reviewerStudentId, revieweeSubmissionId: submissionId });
        }
      }
    }

    if (pairings.length === 0) {
      throw new BadRequestException('No peer review pairings produced.');
    }

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      for (const p of pairings) {
        await tx.$executeRawUnsafe(
          'INSERT INTO cls_peer_reviews ' +
            '(id, peer_assignment_id, reviewer_student_id, reviewee_submission_id, status) ' +
            "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ASSIGNED') " +
            'ON CONFLICT (peer_assignment_id, reviewer_student_id, reviewee_submission_id) DO NOTHING',
          generateId(),
          peerAssignmentId,
          p.reviewerStudentId,
          p.revieweeSubmissionId,
        );
      }
    });

    return this.listForAssignment(peerAssignmentId, actor);
  }

  /** GET /classroom/peer-reviews/my — student: reviews I need to do. */
  async listMy(actor: ResolvedActor): Promise<PeerReviewResponseDto[]> {
    if (actor.personType !== 'STUDENT') {
      return [];
    }
    const studentId = await this.resolveStudentSelfId(actor);
    if (!studentId) return [];

    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<PeerReviewRow[]>(
        SELECT_REVIEW_BASE + ' WHERE pr.reviewer_student_id = $1::uuid ORDER BY pr.created_at DESC',
        studentId,
      );
    });
    // Reviewer themself sees own reviewer identity regardless of anonymity flag
    return rows.map((r) => this.projectReviewToDto(r, studentId, false));
  }

  /** GET /classroom/peer-review-assignments/:id/reviews — teacher: all reviews under assignment. */
  async listForAssignment(
    peerAssignmentId: string,
    actor: ResolvedActor,
  ): Promise<PeerReviewResponseDto[]> {
    // Verify caller can read the assignment
    const cfg = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ assignment_id: string }>>(
        'SELECT assignment_id::text AS assignment_id FROM cls_peer_review_assignments WHERE id = $1::uuid',
        peerAssignmentId,
      );
    });
    if (cfg.length === 0) {
      throw new NotFoundException('Peer review assignment ' + peerAssignmentId + ' not found');
    }
    await this.assertCanManageAssignment(cfg[0]!.assignment_id, actor);

    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<PeerReviewRow[]>(
        SELECT_REVIEW_BASE + ' WHERE pr.peer_assignment_id = $1::uuid ORDER BY pr.created_at DESC',
        peerAssignmentId,
      );
    });
    // Teachers + admins always see full reviewer identity for audit.
    return rows.map((r) => this.projectReviewToDto(r, null, true));
  }

  /** GET /classroom/submissions/:id/peer-reviews — reviewee sees received reviews (anonymised). */
  async listForSubmission(
    submissionId: string,
    actor: ResolvedActor,
  ): Promise<PeerReviewResponseDto[]> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<PeerReviewRow[]>(
        SELECT_REVIEW_BASE +
          " WHERE pr.reviewee_submission_id = $1::uuid AND pr.status IN ('SUBMITTED','REVIEWED_BY_TEACHER') " +
          'ORDER BY pr.submitted_at DESC',
        submissionId,
      );
    });
    if (actor.isSchoolAdmin || actor.personType === 'STAFF') {
      return rows.map((r) => this.projectReviewToDto(r, null, true));
    }
    const studentId = await this.resolveStudentSelfId(actor);
    return rows.map((r) => this.projectReviewToDto(r, studentId, false));
  }

  /** PATCH /classroom/peer-reviews/:id — student submits feedback. */
  async submit(
    id: string,
    input: SubmitPeerReviewDto,
    actor: ResolvedActor,
  ): Promise<PeerReviewResponseDto> {
    const studentId = await this.resolveStudentSelfId(actor);
    if (!studentId && !actor.isSchoolAdmin) {
      throw new ForbiddenException(
        'Only the assigned reviewer or an admin can submit a peer review.',
      );
    }

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<
        Array<{ status: PeerReviewStatus; reviewer_student_id: string }>
      >(
        'SELECT status, reviewer_student_id::text AS reviewer_student_id ' +
          'FROM cls_peer_reviews WHERE id = $1::uuid FOR UPDATE',
        id,
      );
      if (rows.length === 0) throw new NotFoundException('Peer review ' + id + ' not found');
      const row = rows[0]!;
      if (!actor.isSchoolAdmin && (studentId === null || row.reviewer_student_id !== studentId)) {
        throw new ForbiddenException(
          'Only the assigned reviewer or an admin can submit this peer review.',
        );
      }
      if (row.status !== 'ASSIGNED' && row.status !== 'SUBMITTED') {
        throw new BadRequestException(
          'Peer review is in status ' + row.status + ' and cannot be re-submitted.',
        );
      }
      await tx.$executeRawUnsafe(
        'UPDATE cls_peer_reviews SET feedback = COALESCE($2, feedback), ' +
          "overall_rating = COALESCE($3, overall_rating), status = 'SUBMITTED', " +
          'submitted_at = COALESCE(submitted_at, now()), updated_at = now() ' +
          'WHERE id = $1::uuid',
        id,
        input.feedback ?? null,
        input.overallRating ?? null,
      );
    });
    return this.getReviewById(id, actor);
  }

  /** PATCH /classroom/peer-reviews/:id/teacher-review — teacher marks reviewed. */
  async markTeacherReviewed(id: string, actor: ResolvedActor): Promise<PeerReviewResponseDto> {
    const employeeId = this.requireEmployee(actor);
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<
        Array<{ status: PeerReviewStatus; peer_assignment_id: string }>
      >(
        'SELECT status, peer_assignment_id::text AS peer_assignment_id ' +
          'FROM cls_peer_reviews WHERE id = $1::uuid FOR UPDATE',
        id,
      );
      if (rows.length === 0) throw new NotFoundException('Peer review ' + id + ' not found');
      if (rows[0]!.status !== 'SUBMITTED') {
        throw new BadRequestException(
          'Only SUBMITTED reviews can be marked teacher-reviewed (current: ' +
            rows[0]!.status +
            ').',
        );
      }
      await tx.$executeRawUnsafe(
        "UPDATE cls_peer_reviews SET status = 'REVIEWED_BY_TEACHER', " +
          'teacher_reviewed_by = $2::uuid, teacher_reviewed_at = now(), updated_at = now() ' +
          'WHERE id = $1::uuid',
        id,
        employeeId,
      );
    });
    return this.getReviewById(id, actor);
  }

  async getReviewById(id: string, actor: ResolvedActor): Promise<PeerReviewResponseDto> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<PeerReviewRow[]>(
        SELECT_REVIEW_BASE + ' WHERE pr.id = $1::uuid',
        id,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Peer review ' + id + ' not found');
    if (actor.isSchoolAdmin || actor.personType === 'STAFF') {
      return this.projectReviewToDto(rows[0]!, null, true);
    }
    const studentId = await this.resolveStudentSelfId(actor);
    return this.projectReviewToDto(rows[0]!, studentId, false);
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as Record<string, unknown>;
  if (e.code === 'P2010' || e.code === '23505') return true;
  const meta = e.meta as Record<string, unknown> | undefined;
  if (meta && (meta.code === '23505' || meta.code === 'P2010')) return true;
  if (typeof e.message === 'string' && e.message.includes('23505')) return true;
  return false;
}
