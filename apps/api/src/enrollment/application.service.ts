import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { CapacitySummaryService } from './capacity-summary.service';
import {
  ApplicationDocumentDto,
  ApplicationNoteDto,
  ApplicationResponseDto,
  CreateApplicationDto,
  CreateApplicationNoteDto,
  ListApplicationsQueryDto,
  ScreeningResponseDto,
  UpdateApplicationStatusDto,
} from './dto/application.dto';

interface ApplicationRow {
  id: string;
  school_id: string;
  enrollment_period_id: string;
  enrollment_period_name: string;
  stream_id: string | null;
  stream_name: string | null;
  student_first_name: string;
  student_last_name: string;
  student_date_of_birth: string;
  applying_for_grade: string;
  guardian_person_id: string | null;
  guardian_email: string;
  guardian_phone: string | null;
  admission_type: string;
  status: string;
  submitted_at: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  created_at: string;
  updated_at: string;
}

interface ScreeningRow {
  id: string;
  application_id: string;
  question_key: string;
  response_value: any;
}

interface DocumentRow {
  id: string;
  application_id: string;
  document_type: string;
  s3_key: string;
  file_name: string | null;
  content_type: string | null;
  file_size_bytes: string | null;
  uploaded_at: string;
}

interface NoteRow {
  id: string;
  application_id: string;
  note_type: string;
  note_text: string;
  is_confidential: boolean;
  created_by: string | null;
  created_at: string;
}

function applicationRowToDto(
  r: ApplicationRow,
  screening: ScreeningRow[],
  documents: DocumentRow[],
  notes: NoteRow[],
): ApplicationResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    enrollmentPeriodId: r.enrollment_period_id,
    enrollmentPeriodName: r.enrollment_period_name,
    streamId: r.stream_id,
    streamName: r.stream_name,
    studentFirstName: r.student_first_name,
    studentLastName: r.student_last_name,
    studentDateOfBirth: r.student_date_of_birth,
    applyingForGrade: r.applying_for_grade,
    guardianPersonId: r.guardian_person_id,
    guardianEmail: r.guardian_email,
    guardianPhone: r.guardian_phone,
    admissionType: r.admission_type as ApplicationResponseDto['admissionType'],
    status: r.status as ApplicationResponseDto['status'],
    submittedAt: r.submitted_at,
    reviewedAt: r.reviewed_at,
    reviewedBy: r.reviewed_by,
    screening: screening
      .filter((s) => s.application_id === r.id)
      .map<ScreeningResponseDto>((s) => ({
        questionKey: s.question_key,
        responseValue: s.response_value,
      })),
    documents: documents
      .filter((d) => d.application_id === r.id)
      .map<ApplicationDocumentDto>((d) => ({
        id: d.id,
        documentType: d.document_type,
        s3Key: d.s3_key,
        fileName: d.file_name,
        contentType: d.content_type,
        fileSizeBytes: d.file_size_bytes === null ? null : Number(d.file_size_bytes),
        uploadedAt: d.uploaded_at,
      })),
    notes: notes
      .filter((n) => n.application_id === r.id)
      .map<ApplicationNoteDto>((n) => ({
        id: n.id,
        noteType: n.note_type as ApplicationNoteDto['noteType'],
        noteText: n.note_text,
        isConfidential: n.is_confidential,
        createdBy: n.created_by,
        createdAt: n.created_at,
      })),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

var SELECT_APPLICATION_BASE =
  'SELECT a.id, a.school_id, a.enrollment_period_id, ep.name AS enrollment_period_name, ' +
  'a.stream_id, s.name AS stream_name, ' +
  'a.student_first_name, a.student_last_name, ' +
  "TO_CHAR(a.student_date_of_birth, 'YYYY-MM-DD') AS student_date_of_birth, " +
  'a.applying_for_grade, a.guardian_person_id, a.guardian_email, a.guardian_phone, ' +
  'a.admission_type, a.status, a.submitted_at, a.reviewed_at, a.reviewed_by, ' +
  'a.created_at, a.updated_at ' +
  'FROM enr_applications a ' +
  'JOIN enr_enrollment_periods ep ON ep.id = a.enrollment_period_id ' +
  'LEFT JOIN enr_admission_streams s ON s.id = a.stream_id ';

@Injectable()
export class ApplicationService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
    private readonly capacity: CapacitySummaryService,
  ) {}

  /**
   * List applications. Parents see only their own applications (matched
   * on guardian_person_id). Admins see all and can filter by period /
   * status / grade. Students and teachers without admin status see
   * nothing — they can't read applications.
   */
  async list(
    query: ListApplicationsQueryDto,
    actor: ResolvedActor,
  ): Promise<ApplicationResponseDto[]> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      var sql = SELECT_APPLICATION_BASE + 'WHERE 1=1 ';
      var params: any[] = [];
      var idx = 1;
      if (!actor.isSchoolAdmin) {
        // Non-admins: parent persona sees own applications only; everyone
        // else gets nothing.
        if (actor.personType !== 'GUARDIAN') return [] as ApplicationRow[];
        sql += 'AND a.guardian_person_id = $' + idx + '::uuid ';
        params.push(actor.personId);
        idx++;
      }
      if (query.enrollmentPeriodId) {
        sql += 'AND a.enrollment_period_id = $' + idx + '::uuid ';
        params.push(query.enrollmentPeriodId);
        idx++;
      }
      if (query.status) {
        sql += 'AND a.status = $' + idx + ' ';
        params.push(query.status);
        idx++;
      }
      if (query.applyingForGrade) {
        sql += 'AND a.applying_for_grade = $' + idx + ' ';
        params.push(query.applyingForGrade);
        idx++;
      }
      sql += 'ORDER BY a.submitted_at DESC NULLS LAST, a.created_at DESC';
      return client.$queryRawUnsafe<ApplicationRow[]>(sql, ...params);
    });
    if (rows.length === 0) return [];
    var ids = rows.map((r) => r.id);
    var data = await this.tenantPrisma.executeInTenantContext(async (client) => {
      var screening = await this.loadScreeningFor(client, ids);
      var documents = await this.loadDocumentsFor(client, ids);
      var notes = await this.loadNotesFor(client, ids, actor.isSchoolAdmin);
      return { screening, documents, notes };
    });
    return rows.map((r) => applicationRowToDto(r, data.screening, data.documents, data.notes));
  }

  async getById(id: string, actor: ResolvedActor): Promise<ApplicationResponseDto> {
    var data = await this.tenantPrisma.executeInTenantContext(async (client) => {
      var rows = await client.$queryRawUnsafe<ApplicationRow[]>(
        SELECT_APPLICATION_BASE + 'WHERE a.id = $1::uuid',
        id,
      );
      if (rows.length === 0) return null;
      var screening = await this.loadScreeningFor(client, [id]);
      var documents = await this.loadDocumentsFor(client, [id]);
      var notes = await this.loadNotesFor(client, [id], actor.isSchoolAdmin);
      return { row: rows[0]!, screening, documents, notes };
    });
    if (!data) throw new NotFoundException('Application ' + id + ' not found');
    var row = data.row;
    if (!actor.isSchoolAdmin) {
      if (actor.personType !== 'GUARDIAN' || row.guardian_person_id !== actor.personId) {
        throw new NotFoundException('Application ' + id + ' not found');
      }
    }
    return applicationRowToDto(row, data.screening, data.documents, data.notes);
  }

  /**
   * Submit a new application. Parent action — the guardian_person_id is
   * stamped from the actor.personId, and the enrollment period must be
   * OPEN (or allow mid-year applications). admin submissions are also
   * allowed for back-office data entry; admins are not row-scoped.
   * Emits enr.application.submitted on success.
   */
  async create(body: CreateApplicationDto, actor: ResolvedActor): Promise<ApplicationResponseDto> {
    if (!actor.isSchoolAdmin && actor.personType !== 'GUARDIAN') {
      throw new ForbiddenException('Only guardians or admins can submit applications');
    }
    var schoolId = getCurrentTenant().schoolId;
    var applicationId = generateId();
    var now = new Date();
    var dob = new Date(body.studentDateOfBirth);
    if (Number.isNaN(dob.getTime())) {
      throw new BadRequestException('studentDateOfBirth must be a valid date');
    }
    var admissionType = body.admissionType ?? 'NEW_STUDENT';

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      var periodRows = (await tx.$queryRawUnsafe(
        'SELECT id, status, allows_mid_year_applications FROM enr_enrollment_periods WHERE id = $1::uuid',
        body.enrollmentPeriodId,
      )) as Array<{ id: string; status: string; allows_mid_year_applications: boolean }>;
      if (periodRows.length === 0) {
        throw new NotFoundException('Enrollment period ' + body.enrollmentPeriodId + ' not found');
      }
      var period = periodRows[0]!;
      var midYear = admissionType === 'MID_YEAR_ADMISSION';
      if (period.status !== 'OPEN' && !(midYear && period.allows_mid_year_applications)) {
        throw new BadRequestException(
          'Enrollment period is in status ' + period.status + ' and does not accept applications',
        );
      }
      if (body.streamId) {
        var streamRows = (await tx.$queryRawUnsafe(
          'SELECT id FROM enr_admission_streams WHERE id = $1::uuid AND enrollment_period_id = $2::uuid AND is_active = true',
          body.streamId,
          body.enrollmentPeriodId,
        )) as Array<{ id: string }>;
        if (streamRows.length === 0) {
          throw new BadRequestException(
            'Stream ' + body.streamId + ' is not active in this period',
          );
        }
      }

      var guardianPersonId = actor.personType === 'GUARDIAN' ? actor.personId : null;
      await tx.$executeRawUnsafe(
        'INSERT INTO enr_applications (id, school_id, enrollment_period_id, stream_id, student_first_name, student_last_name, student_date_of_birth, applying_for_grade, guardian_person_id, guardian_email, guardian_phone, admission_type, status, submitted_at) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::date, $8, $9::uuid, $10, $11, $12, 'SUBMITTED', $13::timestamptz)",
        applicationId,
        schoolId,
        body.enrollmentPeriodId,
        body.streamId ?? null,
        body.studentFirstName,
        body.studentLastName,
        body.studentDateOfBirth,
        body.applyingForGrade,
        guardianPersonId,
        body.guardianEmail,
        body.guardianPhone ?? null,
        admissionType,
        now.toISOString(),
      );

      if (body.screening && body.screening.length > 0) {
        for (var i = 0; i < body.screening.length; i++) {
          var sr = body.screening[i]!;
          await tx.$executeRawUnsafe(
            'INSERT INTO enr_application_screening_responses (id, application_id, question_key, response_value) ' +
              'VALUES ($1::uuid, $2::uuid, $3, $4::jsonb)',
            generateId(),
            applicationId,
            sr.questionKey,
            JSON.stringify(sr.responseValue),
          );
        }
      }

      await this.capacity.recompute(tx, body.enrollmentPeriodId, body.applyingForGrade);
    });

    var dto = await this.getById(applicationId, actor);
    void this.kafka.emit({
      topic: 'enr.application.submitted',
      key: applicationId,
      sourceModule: 'enrollment',
      payload: {
        applicationId: applicationId,
        schoolId: schoolId,
        enrollmentPeriodId: body.enrollmentPeriodId,
        applyingForGrade: body.applyingForGrade,
        admissionType: admissionType,
        guardianPersonId: dto.guardianPersonId,
        guardianEmail: dto.guardianEmail,
        studentFirstName: dto.studentFirstName,
        studentLastName: dto.studentLastName,
        submittedAt: dto.submittedAt,
      },
    });
    return dto;
  }

  /**
   * Admin status transition. Locks the row with FOR UPDATE inside the
   * tx (Cycle 5 review carry-over: state-machine transitions must lock
   * the row). Allowed transitions are admin-initiated only — the parent
   * never patches status directly. Going to ENROLLED is the OfferService's
   * job (on offer accept), so we explicitly reject it here.
   *
   * Emits enr.application.status_changed.
   */
  async updateStatus(
    id: string,
    body: UpdateApplicationStatusDto,
    actor: ResolvedActor,
  ): Promise<ApplicationResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can change application status');
    }
    var locked = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      var rows = (await tx.$queryRawUnsafe(
        'SELECT id, enrollment_period_id, applying_for_grade, status, submitted_at FROM enr_applications WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{
        id: string;
        enrollment_period_id: string;
        applying_for_grade: string;
        status: string;
        submitted_at: string | null;
      }>;
      if (rows.length === 0) {
        throw new NotFoundException('Application ' + id + ' not found');
      }
      var current = rows[0]!;
      assertTransitionAllowed(current.status, body.status);

      // submitted_at is NOT NULL for any non-DRAFT state under the
      // multi-column submitted_chk. We are only ever transitioning out of
      // SUBMITTED / UNDER_REVIEW / WAITLISTED here, all of which already
      // have submitted_at set, so the CHECK never fires.
      await tx.$executeRawUnsafe(
        'UPDATE enr_applications SET status = $1, reviewed_at = now(), reviewed_by = $2::uuid, updated_at = now() WHERE id = $3::uuid',
        body.status,
        actor.accountId,
        id,
      );

      if (body.reviewNote) {
        await tx.$executeRawUnsafe(
          'INSERT INTO enr_application_notes (id, application_id, note_type, note_text, is_confidential, created_by) ' +
            "VALUES ($1::uuid, $2::uuid, 'GENERAL', $3, false, $4::uuid)",
          generateId(),
          id,
          body.reviewNote,
          actor.accountId,
        );
      }

      await this.capacity.recompute(tx, current.enrollment_period_id, current.applying_for_grade);
      return current;
    });

    var dto = await this.getById(id, actor);
    void this.kafka.emit({
      topic: 'enr.application.status_changed',
      key: id,
      sourceModule: 'enrollment',
      payload: {
        applicationId: id,
        previousStatus: locked.status,
        newStatus: body.status,
        reviewedBy: actor.accountId,
        reviewedAt: dto.reviewedAt,
      },
    });
    return dto;
  }

  async addNote(
    applicationId: string,
    body: CreateApplicationNoteDto,
    actor: ResolvedActor,
  ): Promise<ApplicationNoteDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can add application notes');
    }
    var noteId = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      var rows = (await tx.$queryRawUnsafe(
        'SELECT id FROM enr_applications WHERE id = $1::uuid',
        applicationId,
      )) as Array<{ id: string }>;
      if (rows.length === 0) {
        throw new NotFoundException('Application ' + applicationId + ' not found');
      }
      await tx.$executeRawUnsafe(
        'INSERT INTO enr_application_notes (id, application_id, note_type, note_text, is_confidential, created_by) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid)',
        noteId,
        applicationId,
        body.noteType ?? 'GENERAL',
        body.noteText,
        body.isConfidential ?? false,
        actor.accountId,
      );
    });
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<NoteRow[]>(
        'SELECT id, application_id, note_type, note_text, is_confidential, created_by, created_at ' +
          'FROM enr_application_notes WHERE id = $1::uuid',
        noteId,
      );
    });
    var n = rows[0]!;
    return {
      id: n.id,
      noteType: n.note_type as ApplicationNoteDto['noteType'],
      noteText: n.note_text,
      isConfidential: n.is_confidential,
      createdBy: n.created_by,
      createdAt: n.created_at,
    };
  }

  private async loadScreeningFor(client: any, ids: string[]): Promise<ScreeningRow[]> {
    if (ids.length === 0) return [];
    var placeholders = ids.map((_: string, i: number) => '$' + (i + 1) + '::uuid').join(',');
    return client.$queryRawUnsafe(
      'SELECT id, application_id, question_key, response_value ' +
        'FROM enr_application_screening_responses WHERE application_id IN (' +
        placeholders +
        ') ORDER BY question_key',
      ...ids,
    );
  }

  private async loadDocumentsFor(client: any, ids: string[]): Promise<DocumentRow[]> {
    if (ids.length === 0) return [];
    var placeholders = ids.map((_: string, i: number) => '$' + (i + 1) + '::uuid').join(',');
    return client.$queryRawUnsafe(
      'SELECT id, application_id, document_type, s3_key, file_name, content_type, file_size_bytes::text AS file_size_bytes, uploaded_at ' +
        'FROM enr_application_documents WHERE application_id IN (' +
        placeholders +
        ') ORDER BY uploaded_at DESC',
      ...ids,
    );
  }

  private async loadNotesFor(
    client: any,
    ids: string[],
    includeConfidential: boolean,
  ): Promise<NoteRow[]> {
    if (ids.length === 0) return [];
    var placeholders = ids.map((_: string, i: number) => '$' + (i + 1) + '::uuid').join(',');
    var confidentialClause = includeConfidential ? '' : 'AND is_confidential = false ';
    return client.$queryRawUnsafe(
      'SELECT id, application_id, note_type, note_text, is_confidential, created_by, created_at ' +
        'FROM enr_application_notes WHERE application_id IN (' +
        placeholders +
        ') ' +
        confidentialClause +
        'ORDER BY created_at DESC',
      ...ids,
    );
  }
}

/**
 * Allowed admin transitions. Aligned with the 8-status enum on
 * enr_applications. ENROLLED is reserved for the OfferService accept
 * path. DRAFT and SUBMITTED can never be set by an admin patch.
 */
function assertTransitionAllowed(current: string, target: string): void {
  var valid: Record<string, string[]> = {
    SUBMITTED: ['UNDER_REVIEW', 'ACCEPTED', 'REJECTED', 'WAITLISTED', 'WITHDRAWN'],
    UNDER_REVIEW: ['ACCEPTED', 'REJECTED', 'WAITLISTED', 'WITHDRAWN'],
    WAITLISTED: ['ACCEPTED', 'REJECTED', 'WITHDRAWN'],
    ACCEPTED: ['WITHDRAWN'],
  };
  var allowed = valid[current];
  if (!allowed || allowed.indexOf(target) === -1) {
    throw new BadRequestException(
      'Cannot transition application from ' + current + ' to ' + target,
    );
  }
}
