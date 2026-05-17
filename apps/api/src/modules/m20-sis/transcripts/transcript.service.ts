import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import { PermissionCheckService } from '@modules/m00-platform';
import { OutboxService } from '@shared/kafka';
import type { ResolvedActor } from '@modules/m00-platform';
import {
  TRANSCRIPT_REQUEST_STATUSES,
  TRANSCRIPT_STATUSES,
  TRANSCRIPT_TYPES,
  type GenerateTranscriptDto,
  type PatchTranscriptRequestStatusDto,
  type PatchTranscriptStatusDto,
  type SubmitTranscriptRequestDto,
  type TranscriptCourseDto,
  type TranscriptDto,
  type TranscriptRequestDto,
  type TranscriptRequestStatus,
  type TranscriptStatus,
  type TranscriptType,
} from './dto/sis-transcripts.dto';
import { deterministicTranscriptFeeRequestedEventId } from './event-ids';

interface TranscriptRow {
  id: string;
  student_id: string;
  student_first_name: string | null;
  student_last_name: string | null;
  transcript_type: string;
  generated_at: string;
  generated_by: string;
  generated_by_first_name: string | null;
  generated_by_last_name: string | null;
  gpa_config_id: string;
  cumulative_gpa_snapshot: string | null;
  total_credits: string | null;
  class_rank: number | null;
  class_size: number | null;
  pdf_s3_key: string | null;
  recipient_name: string | null;
  recipient_address: string | null;
  recipient_email: string | null;
  linked_request_id: string | null;
  status: string;
  sent_at: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
}

interface TranscriptCourseRow {
  id: string;
  academic_year: string;
  term: string;
  course_name: string;
  course_code: string | null;
  credits: string | null;
  grade: string;
  grade_points: string | null;
  is_honors: boolean;
  is_ap: boolean;
}

interface RequestRow {
  id: string;
  student_id: string;
  student_first_name: string | null;
  student_last_name: string | null;
  requested_by: string;
  requested_by_first_name: string | null;
  requested_by_last_name: string | null;
  recipient_name: string;
  recipient_address: string | null;
  recipient_email: string | null;
  transcript_type: string;
  copies: number;
  fee_amount: string | null;
  fee_paid: boolean;
  linked_invoice_id: string | null;
  status: string;
  notes: string | null;
  processed_at: string | null;
  sent_at: string | null;
  picked_up_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  created_at: string;
}

const TRANSCRIPT_TRANSITIONS: Record<TranscriptStatus, TranscriptStatus[]> = {
  GENERATED: ['SENT', 'REVOKED'],
  SENT: ['REVOKED'],
  REVOKED: [],
};

const REQUEST_TRANSITIONS: Record<TranscriptRequestStatus, TranscriptRequestStatus[]> = {
  SUBMITTED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['SENT', 'PICKED_UP', 'CANCELLED'],
  SENT: ['PICKED_UP'],
  PICKED_UP: [],
  CANCELLED: [],
};

/**
 * Transcript Service — THE FROZEN-SNAPSHOT KEYSTONE.
 *
 * `generate()` snapshots cls_grades joined to sis_classes plus sis_courses
 * into sis_transcript_courses at the moment of generation. The rows are
 * IMMUTABLE — a re-grade downstream creates a NEW transcript with fresh
 * rows. The existing rows are never live-joined to cls_grades.
 *
 * `submitRequest()` for a SUBMITTED request enqueues a durable
 * `sis.transcript_request.fee_requested` outbox event (per REVIEW-P2C13
 * BLOCKING 7 — SIS no longer writes pay_invoices / pay_invoice_line_items
 * directly across the module boundary) when fee_amount is set. The Payments
 * module's TranscriptFeeConsumer materialises the invoice + line items and
 * back-fills linked_invoice_id via its own emit. SIS validates the family
 * account exists in the current school before enqueuing.
 *
 * Row scope:
 *   - Admin / Staff with stu-005:write — read + write any transcript and request.
 *   - STUDENT — own only via platform_students.person_id chain.
 *   - GUARDIAN — linked children via sis_student_guardians.
 *   - Other / teacher — 403 at the gate or 404 row scope.
 */
@Injectable()
export class TranscriptService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
    private readonly outbox: OutboxService,
  ) {}

  // ─── Mapping helpers ───

  private rowToDto(r: TranscriptRow, courses: TranscriptCourseRow[]): TranscriptDto {
    return {
      id: r.id,
      studentId: r.student_id,
      studentName:
        r.student_first_name && r.student_last_name
          ? `${r.student_first_name} ${r.student_last_name}`
          : null,
      transcriptType: r.transcript_type as TranscriptType,
      generatedAt: r.generated_at,
      generatedBy: r.generated_by,
      generatedByName:
        r.generated_by_first_name && r.generated_by_last_name
          ? `${r.generated_by_first_name} ${r.generated_by_last_name}`
          : null,
      gpaConfigId: r.gpa_config_id,
      cumulativeGpaSnapshot:
        r.cumulative_gpa_snapshot === null ? null : Number(r.cumulative_gpa_snapshot),
      totalCredits: r.total_credits === null ? null : Number(r.total_credits),
      classRank: r.class_rank,
      classSize: r.class_size,
      pdfS3Key: r.pdf_s3_key,
      recipientName: r.recipient_name,
      recipientAddress: r.recipient_address,
      recipientEmail: r.recipient_email,
      linkedRequestId: r.linked_request_id,
      status: r.status as TranscriptStatus,
      sentAt: r.sent_at,
      revokedAt: r.revoked_at,
      revokeReason: r.revoke_reason,
      courses: courses.map((c) => this.courseRowToDto(c)),
    };
  }

  private courseRowToDto(c: TranscriptCourseRow): TranscriptCourseDto {
    return {
      id: c.id,
      academicYear: c.academic_year,
      term: c.term,
      courseName: c.course_name,
      courseCode: c.course_code,
      credits: c.credits === null ? null : Number(c.credits),
      grade: c.grade,
      gradePoints: c.grade_points === null ? null : Number(c.grade_points),
      isHonors: c.is_honors,
      isAp: c.is_ap,
    };
  }

  private requestRowToDto(r: RequestRow): TranscriptRequestDto {
    return {
      id: r.id,
      studentId: r.student_id,
      studentName:
        r.student_first_name && r.student_last_name
          ? `${r.student_first_name} ${r.student_last_name}`
          : null,
      requestedBy: r.requested_by,
      requestedByName:
        r.requested_by_first_name && r.requested_by_last_name
          ? `${r.requested_by_first_name} ${r.requested_by_last_name}`
          : null,
      recipientName: r.recipient_name,
      recipientAddress: r.recipient_address,
      recipientEmail: r.recipient_email,
      transcriptType: r.transcript_type as TranscriptType,
      copies: r.copies,
      feeAmount: r.fee_amount === null ? null : Number(r.fee_amount),
      feePaid: r.fee_paid,
      linkedInvoiceId: r.linked_invoice_id,
      status: r.status as TranscriptRequestStatus,
      notes: r.notes,
      processedAt: r.processed_at,
      sentAt: r.sent_at,
      pickedUpAt: r.picked_up_at,
      cancelledAt: r.cancelled_at,
      cancelReason: r.cancel_reason,
      createdAt: r.created_at,
    };
  }

  // ─── Scope ───

  private async hasRegistrarScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'stu-005:write',
      'stu-005:admin',
    ]);
  }

  private async resolveOwnStudentId(actor: ResolvedActor): Promise<string | null> {
    if (actor.personType !== 'STUDENT') return null;
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = await client.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT s.id::text AS id FROM sis_students s ' +
          'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          'WHERE s.school_id = $1::uuid AND ps.person_id = $2::uuid LIMIT 1',
        tenant.schoolId,
        actor.personId,
      );
      return rows[0]?.id ?? null;
    });
  }

  /**
   * REVIEW-P2C13 BLOCKING 6 — every read scope check now requires
   * sis_students.school_id = tenant.schoolId. Even the registrar
   * bypass is preceded by a student-exists-in-this-school check via
   * assertStudentInTenant in the request-path callers + the JOIN
   * predicate inside the buildTranscriptSelectBase SELECT.
   */
  private async assertCanReadStudent(studentId: string, actor: ResolvedActor): Promise<void> {
    if (await this.hasRegistrarScope(actor)) {
      // Registrar / staff still requires the student to belong to the
      // current school. Cross-school transcript reads by UUID are
      // refused at the JOIN predicate inside every SELECT — the
      // explicit check here gives a friendlier collapsed 404.
      await this.assertStudentInTenantSoft(studentId);
      return;
    }
    if (actor.personType === 'STUDENT') {
      const ownId = await this.resolveOwnStudentId(actor);
      if (ownId === studentId) return;
      throw new NotFoundException('Student not found');
    }
    if (actor.personType === 'GUARDIAN') {
      const tenant = getCurrentTenant();
      const linked = await this.tenantPrisma.executeInTenantContext(async (client) =>
        client.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM sis_student_guardians sg ' +
            'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
            'JOIN sis_students s ON s.id = sg.student_id ' +
            'WHERE sg.student_id = $1::uuid AND g.person_id = $2::uuid ' +
            'AND s.school_id = $3::uuid LIMIT 1',
          studentId,
          actor.personId,
          tenant.schoolId,
        ),
      );
      if (linked.length > 0) return;
      throw new NotFoundException('Student not found');
    }
    throw new NotFoundException('Student not found');
  }

  private async assertStudentInTenantSoft(studentId: string): Promise<void> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM sis_students WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        studentId,
        tenant.schoolId,
      ),
    );
    if (rows.length === 0) {
      throw new NotFoundException('Student not found');
    }
  }

  private async assertStudentInTenant(studentId: string): Promise<void> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM sis_students WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        studentId,
        tenant.schoolId,
      ),
    );
    if (rows.length === 0) {
      throw new BadRequestException('studentId does not match a student in this school');
    }
  }

  // ─── Transcript reads ───

  /**
   * REVIEW-P2C13 BLOCKING 6 — select base now JOINs sis_students with
   * the school predicate. Every read goes through this base so a
   * registrar / parent / student cannot resolve a foreign-school
   * transcript by guessing the transcript UUID — the JOIN collapses
   * the result to 0 rows.
   */
  private buildTranscriptSelectBase(): string {
    return (
      'SELECT t.id::text, t.student_id::text, ' +
      'sip.first_name AS student_first_name, sip.last_name AS student_last_name, ' +
      't.transcript_type, t.generated_at::text, t.generated_by::text, ' +
      'gp.first_name AS generated_by_first_name, gp.last_name AS generated_by_last_name, ' +
      't.gpa_config_id::text, t.cumulative_gpa_snapshot::text, t.total_credits::text, ' +
      't.class_rank, t.class_size, t.pdf_s3_key, ' +
      't.recipient_name, t.recipient_address, t.recipient_email, ' +
      't.linked_request_id::text, t.status, ' +
      't.sent_at::text, t.revoked_at::text, t.revoke_reason ' +
      'FROM sis_transcripts t ' +
      'JOIN sis_students s ON s.id = t.student_id ' +
      'LEFT JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
      'LEFT JOIN platform.iam_person sip ON sip.id = ps.person_id ' +
      'LEFT JOIN platform.iam_person gp ON gp.id = t.generated_by '
    );
  }

  private async loadCoursesForTranscript(
    transcriptId: string,
    schoolId: string,
  ): Promise<TranscriptCourseRow[]> {
    return this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<TranscriptCourseRow[]>(
        'SELECT tc.id::text, tc.academic_year, tc.term, tc.course_name, tc.course_code, ' +
          'tc.credits::text, tc.grade, tc.grade_points::text, tc.is_honors, tc.is_ap ' +
          'FROM sis_transcript_courses tc ' +
          'JOIN sis_transcripts t ON t.id = tc.transcript_id ' +
          'JOIN sis_students s ON s.id = t.student_id ' +
          'WHERE tc.transcript_id = $1::uuid AND s.school_id = $2::uuid ' +
          'ORDER BY tc.sort_order, tc.academic_year, tc.term',
        transcriptId,
        schoolId,
      ),
    );
  }

  async listForStudent(studentId: string, actor: ResolvedActor): Promise<TranscriptDto[]> {
    await this.assertCanReadStudent(studentId, actor);
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<TranscriptRow[]>(
        this.buildTranscriptSelectBase() +
          'WHERE t.student_id = $1::uuid AND s.school_id = $2::uuid ' +
          'ORDER BY t.generated_at DESC',
        studentId,
        tenant.schoolId,
      ),
    );
    const out: TranscriptDto[] = [];
    for (const r of rows) {
      const courses = await this.loadCoursesForTranscript(r.id, tenant.schoolId);
      out.push(this.rowToDto(r, courses));
    }
    return out;
  }

  async getById(id: string, actor: ResolvedActor): Promise<TranscriptDto> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<TranscriptRow[]>(
        this.buildTranscriptSelectBase() +
          'WHERE t.id = $1::uuid AND s.school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      ),
    );
    if (rows.length === 0) throw new NotFoundException('Transcript not found');
    const row = rows[0]!;
    await this.assertCanReadStudent(row.student_id, actor);
    const courses = await this.loadCoursesForTranscript(row.id, tenant.schoolId);
    return this.rowToDto(row, courses);
  }

  // ─── Generate ───

  async generate(
    studentId: string,
    dto: GenerateTranscriptDto,
    actor: ResolvedActor,
  ): Promise<TranscriptDto> {
    if (!(await this.hasRegistrarScope(actor))) {
      throw new ForbiddenException('Only staff or admins can generate transcripts.');
    }
    if (!TRANSCRIPT_TYPES.includes(dto.transcriptType)) {
      throw new BadRequestException(`transcriptType must be one of ${TRANSCRIPT_TYPES.join(', ')}`);
    }
    await this.assertStudentInTenant(studentId);

    const tenant = getCurrentTenant();
    const transcriptId = generateId();

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Resolve the GPA config — use the supplied id when set, otherwise the
      // school's default GPA config.
      let gpaConfigId = dto.gpaConfigId ?? null;
      if (gpaConfigId === null) {
        const defaults = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          'SELECT id::text AS id FROM sis_gpa_configurations ' +
            'WHERE school_id = $1::uuid AND is_default = true AND is_active = true LIMIT 1',
          tenant.schoolId,
        );
        if (defaults.length === 0) {
          throw new BadRequestException(
            'No default GPA configuration set for this school. Supply gpaConfigId or run sis_gpa_configurations seed.',
          );
        }
        gpaConfigId = defaults[0]!.id;
      } else {
        const lookup = await tx.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM sis_gpa_configurations WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
          gpaConfigId,
          tenant.schoolId,
        );
        if (lookup.length === 0) {
          throw new BadRequestException(
            'gpaConfigId does not match a configuration in this school',
          );
        }
      }

      // Read the most recent cumulative GPA snapshot for the student under
      // the chosen config (NULL year + NULL term cumulative row preferred).
      const snapshots = await tx.$queryRawUnsafe<
        Array<{
          cumulative_gpa: string | null;
          total_credits_earned: string | null;
          class_rank: number | null;
          class_size: number | null;
        }>
      >(
        'SELECT cumulative_gpa::text, total_credits_earned::text, class_rank, class_size ' +
          'FROM sis_student_gpa_snapshots ' +
          'WHERE student_id = $1::uuid AND gpa_config_id = $2::uuid ' +
          'ORDER BY (academic_year_id IS NULL) DESC, calculated_at DESC LIMIT 1',
        studentId,
        gpaConfigId,
      );
      const snapshot = snapshots[0] ?? null;

      // Snapshot cls_grades joined to sis_classes + sis_courses + sis_terms +
      // sis_academic_years into sis_transcript_courses. ADR-010 — once written
      // these rows are NOT updated by future grade changes. The transcript
      // header captures GPA + credits at the same instant.
      const courseRows = await tx.$queryRawUnsafe<
        Array<{
          class_id: string;
          academic_year: string;
          term: string;
          course_name: string;
          course_code: string | null;
          credits: string | null;
          grade: string;
          grade_points: string | null;
          is_honors: boolean;
          is_ap: boolean;
        }>
      >(
        'SELECT c.id::text AS class_id, ' +
          "COALESCE(ay.name, '') AS academic_year, " +
          "COALESCE(tm.name, '') AS term, " +
          'co.name AS course_name, ' +
          'co.code AS course_code, ' +
          'co.credit_hours::text AS credits, ' +
          'g.letter_grade AS grade, ' +
          '(SELECT gse.grade_points::text FROM sis_grade_scale_entries gse ' +
          '  WHERE gse.school_id = $2::uuid AND gse.letter_grade = g.letter_grade ' +
          '  ORDER BY gse.sort_order LIMIT 1) AS grade_points, ' +
          'COALESCE(co.is_honors, false) AS is_honors, ' +
          'COALESCE(co.is_ap, false) AS is_ap ' +
          'FROM cls_grades g ' +
          'JOIN sis_classes c ON c.id = g.class_id ' +
          'JOIN sis_courses co ON co.id = c.course_id ' +
          'LEFT JOIN sis_terms tm ON tm.id = c.term_id ' +
          'LEFT JOIN sis_academic_years ay ON ay.id = c.academic_year_id ' +
          'WHERE g.student_id = $1::uuid AND g.is_published = true ' +
          'ORDER BY ay.start_date NULLS LAST, tm.start_date NULLS LAST, co.name',
        studentId,
        tenant.schoolId,
      );

      let totalCredits = 0;
      for (const c of courseRows) {
        if (c.credits) totalCredits += Number(c.credits);
      }

      await tx.$executeRawUnsafe(
        'INSERT INTO sis_transcripts (id, student_id, transcript_type, generated_at, generated_by, ' +
          'gpa_config_id, cumulative_gpa_snapshot, total_credits, class_rank, class_size, ' +
          'recipient_name, recipient_address, recipient_email, linked_request_id, status) ' +
          'VALUES ($1::uuid, $2::uuid, $3, now(), $4::uuid, $5::uuid, $6::numeric, $7::numeric, ' +
          "$8, $9, $10, $11, $12, $13::uuid, 'GENERATED')",
        transcriptId,
        studentId,
        dto.transcriptType,
        actor.personId,
        gpaConfigId,
        snapshot?.cumulative_gpa ?? null,
        totalCredits > 0
          ? totalCredits
          : snapshot?.total_credits_earned
            ? Number(snapshot.total_credits_earned)
            : null,
        snapshot?.class_rank ?? null,
        snapshot?.class_size ?? null,
        dto.recipientName ?? null,
        dto.recipientAddress ?? null,
        dto.recipientEmail ?? null,
        dto.linkedRequestId ?? null,
      );

      let sortOrder = 0;
      for (const c of courseRows) {
        await tx.$executeRawUnsafe(
          'INSERT INTO sis_transcript_courses (id, transcript_id, academic_year, term, course_name, ' +
            'course_code, credits, grade, grade_points, is_honors, is_ap, source_class_id, sort_order) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::numeric, $8, $9::numeric, $10, $11, $12::uuid, $13)',
          generateId(),
          transcriptId,
          c.academic_year,
          c.term,
          c.course_name,
          c.course_code,
          c.credits,
          c.grade,
          c.grade_points,
          c.is_honors,
          c.is_ap,
          c.class_id,
          sortOrder,
        );
        sortOrder += 10;
      }

      // If linkedRequestId is set, flip the request to PROCESSING and
      // stamp processed_at. REVIEW-P2C13 BLOCKING 6 — UPDATE is scoped
      // by sis_students.school_id through a subselect so a foreign-
      // school request UUID cannot be advanced from this generate.
      if (dto.linkedRequestId) {
        await tx.$executeRawUnsafe(
          'UPDATE sis_transcript_requests r SET status = ' +
            "CASE WHEN r.status = 'SUBMITTED' THEN 'PROCESSING' ELSE r.status END, " +
            'processed_at = COALESCE(r.processed_at, now()), updated_at = now() ' +
            'FROM sis_students s ' +
            'WHERE r.id = $1::uuid AND s.id = r.student_id AND s.school_id = $2::uuid',
          dto.linkedRequestId,
          tenant.schoolId,
        );
      }
    });

    return this.getById(transcriptId, actor);
  }

  // ─── Transcript status transitions ───

  async patchStatus(
    id: string,
    dto: PatchTranscriptStatusDto,
    actor: ResolvedActor,
  ): Promise<TranscriptDto> {
    if (!(await this.hasRegistrarScope(actor))) {
      throw new ForbiddenException('Only staff or admins can update transcript status.');
    }
    if (!TRANSCRIPT_STATUSES.includes(dto.status)) {
      throw new BadRequestException(`status must be one of ${TRANSCRIPT_STATUSES.join(', ')}`);
    }
    if (dto.status === 'REVOKED' && (!dto.revokeReason || dto.revokeReason.trim() === '')) {
      throw new BadRequestException('revokeReason is required when status=REVOKED.');
    }

    const tenant = getCurrentTenant();
    // REVIEW-P2C13 BLOCKING 6 — lock + UPDATE both join through
    // sis_students with the school predicate so a registrar in school
    // A cannot patch a transcript belonging to school B by guessing
    // the UUID.
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<{ status: string }>>(
        'SELECT t.status FROM sis_transcripts t ' +
          'JOIN sis_students s ON s.id = t.student_id ' +
          'WHERE t.id = $1::uuid AND s.school_id = $2::uuid FOR UPDATE OF t',
        id,
        tenant.schoolId,
      );
      if (rows.length === 0) throw new NotFoundException('Transcript not found');
      const current = rows[0]!.status as TranscriptStatus;
      const allowed = TRANSCRIPT_TRANSITIONS[current] ?? [];
      if (!allowed.includes(dto.status)) {
        throw new BadRequestException(
          `Cannot transition transcript from ${current} to ${dto.status}.`,
        );
      }
      await tx.$executeRawUnsafe(
        'UPDATE sis_transcripts SET status = $1, ' +
          "sent_at = CASE WHEN $1 = 'SENT' THEN COALESCE(sent_at, now()) ELSE sent_at END, " +
          "revoked_at = CASE WHEN $1 = 'REVOKED' THEN now() ELSE revoked_at END, " +
          "revoke_reason = CASE WHEN $1 = 'REVOKED' THEN $2 ELSE revoke_reason END, " +
          'updated_at = now() WHERE id = $3::uuid',
        dto.status,
        dto.revokeReason ?? null,
        id,
      );
    });
    return this.getById(id, actor);
  }

  // ─── Requests ───

  /**
   * REVIEW-P2C13 BLOCKING 6 / 7 — request select base JOINs sis_students
   * so a foreign-school request UUID never resolves into the caller's
   * tenant view.
   */
  private buildRequestSelectBase(): string {
    return (
      'SELECT r.id::text, r.student_id::text, ' +
      'sip.first_name AS student_first_name, sip.last_name AS student_last_name, ' +
      'r.requested_by::text, ' +
      'rp.first_name AS requested_by_first_name, rp.last_name AS requested_by_last_name, ' +
      'r.recipient_name, r.recipient_address, r.recipient_email, ' +
      'r.transcript_type, r.copies, r.fee_amount::text, r.fee_paid, r.linked_invoice_id::text, ' +
      'r.status, r.notes, ' +
      'r.processed_at::text, r.sent_at::text, r.picked_up_at::text, ' +
      'r.cancelled_at::text, r.cancel_reason, r.created_at::text ' +
      'FROM sis_transcript_requests r ' +
      'JOIN sis_students s ON s.id = r.student_id ' +
      'LEFT JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
      'LEFT JOIN platform.iam_person sip ON sip.id = ps.person_id ' +
      'LEFT JOIN platform.iam_person rp ON rp.id = r.requested_by '
    );
  }

  async submitRequest(
    dto: SubmitTranscriptRequestDto,
    actor: ResolvedActor,
  ): Promise<TranscriptRequestDto> {
    if (!TRANSCRIPT_TYPES.includes(dto.transcriptType)) {
      throw new BadRequestException(`transcriptType must be one of ${TRANSCRIPT_TYPES.join(', ')}`);
    }
    if (dto.copies !== undefined && (dto.copies <= 0 || dto.copies > 50)) {
      throw new BadRequestException('copies must be between 1 and 50');
    }
    if (dto.feeAmount !== undefined && dto.feeAmount > 0 && !dto.familyAccountId) {
      throw new BadRequestException('familyAccountId is required when feeAmount > 0');
    }
    await this.assertStudentInTenant(dto.studentId);
    // Parent / student row scope.
    if (!(await this.hasRegistrarScope(actor))) {
      await this.assertCanReadStudent(dto.studentId, actor);
    }

    const tenant = getCurrentTenant();
    const requestId = generateId();
    const copies = dto.copies ?? 1;
    const feeAmount = dto.feeAmount ?? null;

    // REVIEW-P2C13 BLOCKING 7 — SIS no longer writes pay_invoices /
    // pay_invoice_line_items directly. Instead the request lands in
    // sis_transcript_requests and a durable outbox event
    // sis.transcript_request.fee_requested fires when feeAmount > 0.
    // The Payments module owns pay_* tables and the Phase 2 follow-up
    // TranscriptFeeConsumer materialises the invoice + line items and
    // back-fills linked_invoice_id via an event of its own.
    //
    // The family-account validation moves to a soft pre-flight: SIS
    // still confirms the account exists in this tenant + is ACTIVE so
    // an invalid request fails fast at submission, but the actual
    // pay_* row creation is deferred to the Payments consumer.
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      if (feeAmount !== null && feeAmount > 0) {
        const accountRows = await tx.$queryRawUnsafe<Array<{ status: string }>>(
          'SELECT status FROM pay_family_accounts WHERE id = $1::uuid AND school_id = $2::uuid',
          dto.familyAccountId,
          tenant.schoolId,
        );
        if (accountRows.length === 0) {
          throw new BadRequestException(
            'familyAccountId does not match a family account in this school',
          );
        }
        if (accountRows[0]!.status !== 'ACTIVE') {
          throw new BadRequestException(
            `Family account is in status ${accountRows[0]!.status}; cannot bill the transcript fee`,
          );
        }
      }

      await tx.$executeRawUnsafe(
        'INSERT INTO sis_transcript_requests (id, student_id, requested_by, recipient_name, ' +
          'recipient_address, recipient_email, transcript_type, copies, fee_amount, fee_paid, ' +
          'linked_invoice_id, status, notes) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9::numeric, $10, NULL, ' +
          "'SUBMITTED', $11)",
        requestId,
        dto.studentId,
        actor.personId,
        dto.recipientName,
        dto.recipientAddress ?? null,
        dto.recipientEmail ?? null,
        dto.transcriptType,
        copies,
        feeAmount,
        false,
        dto.notes ?? null,
      );

      // Durable cross-module event. Payments consumer materialises the
      // pay_invoice and updates linked_invoice_id back via its own emit.
      if (feeAmount !== null && feeAmount > 0) {
        const lineTotal = Number((feeAmount * copies).toFixed(2));
        await this.outbox.enqueueInTx(tx, {
          topic: 'sis.transcript_request.fee_requested',
          key: requestId,
          sourceModule: 'sis-transcripts',
          eventId: deterministicTranscriptFeeRequestedEventId(requestId),
          payload: {
            requestId,
            schoolId: tenant.schoolId,
            studentId: dto.studentId,
            familyAccountId: dto.familyAccountId,
            transcriptType: dto.transcriptType,
            copies,
            feeAmount,
            lineTotal,
            recipientName: dto.recipientName,
            requestedBy: actor.personId,
            sourceRefId: requestId,
          },
        });
      }
    });

    return this.getRequestById(requestId, actor);
  }

  async listRequests(
    args: { studentId?: string; status?: string },
    actor: ResolvedActor,
  ): Promise<TranscriptRequestDto[]> {
    const tenant = getCurrentTenant();
    const conditions: string[] = ['s.school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    let nextParam = 2;

    if (args.studentId) {
      conditions.push(`r.student_id = $${nextParam}::uuid`);
      params.push(args.studentId);
      nextParam += 1;
      // Row scope on supplied studentId.
      if (!(await this.hasRegistrarScope(actor))) {
        await this.assertCanReadStudent(args.studentId, actor);
      }
    } else if (!(await this.hasRegistrarScope(actor))) {
      // Non-staff readers default to own scope.
      if (actor.personType === 'STUDENT') {
        const own = await this.resolveOwnStudentId(actor);
        if (own === null) return [];
        conditions.push(`r.student_id = $${nextParam}::uuid`);
        params.push(own);
        nextParam += 1;
      } else if (actor.personType === 'GUARDIAN') {
        // REVIEW-P2C13 BLOCKING 6 — guardian-children subquery joins
        // through sis_students to bind the result to the calling
        // school. A guardian linked across schools sees only their
        // child(ren) in this school.
        conditions.push(
          `r.student_id IN (SELECT sg.student_id FROM sis_student_guardians sg ` +
            `JOIN sis_guardians g ON g.id = sg.guardian_id ` +
            `JOIN sis_students gs ON gs.id = sg.student_id ` +
            `WHERE g.person_id = $${nextParam}::uuid AND gs.school_id = $1::uuid)`,
        );
        params.push(actor.personId);
        nextParam += 1;
      } else {
        return [];
      }
    }
    if (args.status) {
      if (!TRANSCRIPT_REQUEST_STATUSES.includes(args.status as TranscriptRequestStatus)) {
        throw new BadRequestException(
          `status must be one of ${TRANSCRIPT_REQUEST_STATUSES.join(', ')}`,
        );
      }
      conditions.push(`r.status = $${nextParam}`);
      params.push(args.status);
      nextParam += 1;
    }
    const sql =
      this.buildRequestSelectBase() +
      'WHERE ' +
      conditions.join(' AND ') +
      ' ORDER BY r.created_at DESC LIMIT 200';
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<RequestRow[]>(sql, ...params),
    );
    return rows.map((r) => this.requestRowToDto(r));
  }

  async getRequestById(id: string, actor: ResolvedActor): Promise<TranscriptRequestDto> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<RequestRow[]>(
        this.buildRequestSelectBase() + 'WHERE r.id = $1::uuid AND s.school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      ),
    );
    if (rows.length === 0) throw new NotFoundException('Transcript request not found');
    const row = rows[0]!;
    if (!(await this.hasRegistrarScope(actor))) {
      await this.assertCanReadStudent(row.student_id, actor);
    }
    return this.requestRowToDto(row);
  }

  async patchRequestStatus(
    id: string,
    dto: PatchTranscriptRequestStatusDto,
    actor: ResolvedActor,
  ): Promise<TranscriptRequestDto> {
    if (!(await this.hasRegistrarScope(actor))) {
      throw new ForbiddenException('Only staff or admins can advance a transcript request.');
    }
    if (!TRANSCRIPT_REQUEST_STATUSES.includes(dto.status)) {
      throw new BadRequestException(
        `status must be one of ${TRANSCRIPT_REQUEST_STATUSES.join(', ')}`,
      );
    }
    if (dto.status === 'CANCELLED' && (!dto.cancelReason || dto.cancelReason.trim() === '')) {
      throw new BadRequestException('cancelReason is required when status=CANCELLED.');
    }

    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // REVIEW-P2C13 BLOCKING 6 — lock joins through sis_students so
      // a registrar cannot transition a request that belongs to a
      // different school by guessing the UUID.
      const rows = await tx.$queryRawUnsafe<Array<{ status: string }>>(
        'SELECT r.status FROM sis_transcript_requests r ' +
          'JOIN sis_students s ON s.id = r.student_id ' +
          'WHERE r.id = $1::uuid AND s.school_id = $2::uuid FOR UPDATE OF r',
        id,
        tenant.schoolId,
      );
      if (rows.length === 0) throw new NotFoundException('Transcript request not found');
      const current = rows[0]!.status as TranscriptRequestStatus;
      const allowed = REQUEST_TRANSITIONS[current] ?? [];
      if (!allowed.includes(dto.status)) {
        throw new BadRequestException(
          `Cannot transition transcript request from ${current} to ${dto.status}.`,
        );
      }
      await tx.$executeRawUnsafe(
        'UPDATE sis_transcript_requests SET status = $1, ' +
          "processed_at = CASE WHEN $1 = 'PROCESSING' THEN COALESCE(processed_at, now()) ELSE processed_at END, " +
          "sent_at = CASE WHEN $1 = 'SENT' THEN COALESCE(sent_at, now()) ELSE sent_at END, " +
          "picked_up_at = CASE WHEN $1 = 'PICKED_UP' THEN COALESCE(picked_up_at, now()) ELSE picked_up_at END, " +
          "cancelled_at = CASE WHEN $1 = 'CANCELLED' THEN now() ELSE cancelled_at END, " +
          "cancel_reason = CASE WHEN $1 = 'CANCELLED' THEN $2 ELSE cancel_reason END, " +
          'updated_at = now() WHERE id = $3::uuid',
        dto.status,
        dto.cancelReason ?? null,
        id,
      );
    });
    return this.getRequestById(id, actor);
  }
}
