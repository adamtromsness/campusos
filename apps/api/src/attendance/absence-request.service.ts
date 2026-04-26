import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import {
  AbsenceRequestResponseDto,
  CreateAbsenceRequestDto,
  ListAbsenceRequestsQueryDto,
  ReviewAbsenceRequestDto,
} from './dto/absence-request.dto';

interface AbsenceRequestRow {
  id: string;
  school_id: string;
  student_id: string;
  student_first_name: string;
  student_last_name: string;
  submitted_by: string;
  submitter_email: string | null;
  absence_date_from: Date | string;
  absence_date_to: Date | string;
  request_type: string;
  reason_category: string;
  reason_text: string;
  supporting_document_s3_key: string | null;
  status: string;
  reviewed_by: string | null;
  reviewed_at: Date | string | null;
  reviewer_notes: string | null;
  created_at: Date | string;
}

function dateToString(d: Date | string): string {
  return typeof d === 'string' ? d : d.toISOString().slice(0, 10);
}

function tsToString(d: Date | string | null): string | null {
  if (!d) return null;
  return typeof d === 'string' ? d : d.toISOString();
}

function rowToDto(r: AbsenceRequestRow): AbsenceRequestResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    studentId: r.student_id,
    studentName: r.student_first_name + ' ' + r.student_last_name,
    submittedBy: r.submitted_by,
    submittedByEmail: r.submitter_email,
    absenceDateFrom: dateToString(r.absence_date_from),
    absenceDateTo: dateToString(r.absence_date_to),
    requestType: r.request_type,
    reasonCategory: r.reason_category,
    reasonText: r.reason_text,
    supportingDocumentS3Key: r.supporting_document_s3_key,
    status: r.status,
    reviewedBy: r.reviewed_by,
    reviewedAt: tsToString(r.reviewed_at),
    reviewerNotes: r.reviewer_notes,
    createdAt: tsToString(r.created_at) || new Date().toISOString(),
  };
}

var SELECT_BASE =
  'SELECT ar.id, ar.school_id, ar.student_id, ar.submitted_by, ar.absence_date_from::text, ' +
    'ar.absence_date_to::text, ar.request_type, ar.reason_category, ar.reason_text, ' +
    'ar.supporting_document_s3_key, ar.status, ar.reviewed_by, ar.reviewed_at, ' +
    'ar.reviewer_notes, ar.created_at, ' +
    'ip.first_name AS student_first_name, ip.last_name AS student_last_name, ' +
    'u.email AS submitter_email ' +
  'FROM sis_absence_requests ar ' +
  'JOIN sis_students s ON s.id = ar.student_id ' +
  'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
  'JOIN platform.iam_person ip ON ip.id = ps.person_id ' +
  'LEFT JOIN platform.platform_users u ON u.id = ar.submitted_by ';

@Injectable()
export class AbsenceRequestService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
  ) {}

  /**
   * Submit a new absence request. SAME_DAY_REPORT requests are
   * AUTO_APPROVED on submission; ADVANCE_REQUEST requests start PENDING
   * and need admin review.
   *
   * Caller must be a guardian of the student (authorisation enforced by
   * the controller via stu-001:read + family-link check) or a school admin.
   */
  async create(
    submitterAccountId: string,
    submitterPersonId: string,
    dto: CreateAbsenceRequestDto,
    isAdmin: boolean,
  ): Promise<AbsenceRequestResponseDto> {
    if (new Date(dto.absenceDateTo) < new Date(dto.absenceDateFrom)) {
      throw new BadRequestException('absenceDateTo must be on or after absenceDateFrom');
    }

    var tenant = getCurrentTenant();
    var schoolId = tenant.schoolId;

    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Authorisation: non-admins must be a guardian of the student.
      if (!isAdmin) {
        var link = await tx.$queryRawUnsafe<Array<{ count: number }>>(
          'SELECT count(*)::int AS count ' +
          'FROM sis_student_guardians sg ' +
          'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
          'WHERE sg.student_id = $1::uuid AND g.person_id = $2::uuid',
          dto.studentId,
          submitterPersonId,
        );
        if (!link[0] || link[0].count === 0) {
          throw new ForbiddenException('Caller is not a guardian of student ' + dto.studentId);
        }
      }

      var initialStatus = dto.requestType === 'SAME_DAY_REPORT' ? 'AUTO_APPROVED' : 'PENDING';
      var newId = generateId();

      await tx.$executeRawUnsafe(
        'INSERT INTO sis_absence_requests ' +
          '(id, school_id, student_id, submitted_by, absence_date_from, absence_date_to, ' +
          ' request_type, reason_category, reason_text, supporting_document_s3_key, status) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::date, $7, $8, $9, $10, $11)',
        newId, schoolId, dto.studentId, submitterAccountId,
        dto.absenceDateFrom, dto.absenceDateTo,
        dto.requestType, dto.reasonCategory, dto.reasonText,
        dto.supportingDocumentS3Key ?? null, initialStatus,
      );

      var rows = await tx.$queryRawUnsafe<AbsenceRequestRow[]>(
        SELECT_BASE + 'WHERE ar.id = $1::uuid',
        newId,
      );
      return rows[0]!;
    }).then((row) => {
      void this.kafka.emit('att.absence.requested', row.id, {
        requestId: row.id,
        studentId: row.student_id,
        submittedBy: row.submitted_by,
        requestType: row.request_type,
        absenceDateFrom: dateToString(row.absence_date_from),
        absenceDateTo: dateToString(row.absence_date_to),
        status: row.status,
      });
      return rowToDto(row);
    });
  }

  async list(
    callerAccountId: string,
    query: ListAbsenceRequestsQueryDto,
    isAdmin: boolean,
  ): Promise<AbsenceRequestResponseDto[]> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      var sql = SELECT_BASE + 'WHERE 1=1 ';
      var params: any[] = [];
      var idx = 1;

      if (query.studentId) {
        sql += 'AND ar.student_id = $' + idx + '::uuid ';
        params.push(query.studentId); idx++;
      }
      if (query.status) {
        sql += 'AND ar.status = $' + idx + ' ';
        params.push(query.status); idx++;
      }
      if (query.mySubmissions || !isAdmin) {
        // Non-admins always see only their own submissions, regardless of mySubmissions flag.
        sql += 'AND ar.submitted_by = $' + idx + '::uuid ';
        params.push(callerAccountId); idx++;
      }
      sql += 'ORDER BY ar.created_at DESC';

      return client.$queryRawUnsafe<AbsenceRequestRow[]>(sql, ...params);
    });
    return rows.map(rowToDto);
  }

  async getById(id: string, callerAccountId: string, isAdmin: boolean): Promise<AbsenceRequestResponseDto> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<AbsenceRequestRow[]>(
        SELECT_BASE + 'WHERE ar.id = $1::uuid',
        id,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Absence request ' + id + ' not found');
    var row = rows[0]!;
    if (!isAdmin && row.submitted_by !== callerAccountId) {
      throw new ForbiddenException('Cannot view absence requests submitted by other users');
    }
    return rowToDto(row);
  }

  /**
   * Admin reviews a pending absence request. Decision is APPROVED or REJECTED.
   */
  async review(
    id: string,
    reviewerAccountId: string,
    dto: ReviewAbsenceRequestDto,
  ): Promise<AbsenceRequestResponseDto> {
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      var existing = await tx.$queryRawUnsafe<Array<{ status: string }>>(
        'SELECT status FROM sis_absence_requests WHERE id = $1::uuid',
        id,
      );
      if (existing.length === 0) throw new NotFoundException('Absence request ' + id + ' not found');
      if (existing[0]!.status !== 'PENDING') {
        throw new BadRequestException('Request is already ' + existing[0]!.status + ' and cannot be re-reviewed');
      }

      await tx.$executeRawUnsafe(
        'UPDATE sis_absence_requests SET ' +
          'status = $1, reviewed_by = $2::uuid, reviewed_at = now(), ' +
          'reviewer_notes = $3, updated_at = now() ' +
        'WHERE id = $4::uuid',
        dto.decision,
        reviewerAccountId,
        dto.reviewerNotes ?? null,
        id,
      );

      var rows = await tx.$queryRawUnsafe<AbsenceRequestRow[]>(
        SELECT_BASE + 'WHERE ar.id = $1::uuid',
        id,
      );
      return rows[0]!;
    }).then((row) => {
      void this.kafka.emit('att.absence.reviewed', row.id, {
        requestId: row.id,
        studentId: row.student_id,
        decision: row.status,
        reviewedBy: row.reviewed_by,
        reviewedAt: tsToString(row.reviewed_at),
      });
      return rowToDto(row);
    });
  }
}
