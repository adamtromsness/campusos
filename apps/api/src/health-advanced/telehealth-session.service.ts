import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import { HealthAccessLogService } from '../health/health-access-log.service';
import { TelehealthProviderService } from './telehealth-provider.service';
import {
  CreateTelehealthSessionDto,
  ListTelehealthSessionsQueryDto,
  TELEHEALTH_SESSION_STATUSES,
  TelehealthDocumentDto,
  TelehealthDocumentType,
  TelehealthSessionDto,
  TelehealthSessionStatus,
  UpdateTelehealthSessionDto,
  UploadTelehealthDocumentDto,
} from './dto/health-advanced.dto';

interface SessionRow {
  id: string;
  school_id: string;
  student_id: string;
  student_first: string | null;
  student_last: string | null;
  provider_id: string;
  provider_name: string | null;
  provider_speciality: string | null;
  scheduled_at: string;
  duration_minutes: number | null;
  status: string;
  meeting_url: string | null;
  session_notes_s3_key: string | null;
  consent_signature_id: string | null;
  consent_received_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface DocumentRow {
  id: string;
  session_id: string;
  document_type: string;
  s3_key: string;
  file_size_bytes: number | null;
  signature_request_id: string | null;
  uploaded_by: string;
  uploaded_by_first: string | null;
  uploaded_by_last: string | null;
  uploaded_at: string;
}

const SELECT_SESSION_BASE =
  'SELECT s.id::text AS id, s.school_id::text AS school_id, ' +
  '       s.student_id::text AS student_id, ' +
  '       sip.first_name AS student_first, sip.last_name AS student_last, ' +
  '       s.provider_id::text AS provider_id, ' +
  '       p.provider_name, p.speciality AS provider_speciality, ' +
  '       s.scheduled_at::text AS scheduled_at, s.duration_minutes, s.status, ' +
  '       s.meeting_url, s.session_notes_s3_key, ' +
  '       s.consent_signature_id::text AS consent_signature_id, ' +
  '       s.consent_received_at::text AS consent_received_at, ' +
  '       s.completed_at::text AS completed_at, ' +
  '       s.cancelled_at::text AS cancelled_at, s.cancellation_reason, ' +
  '       s.created_at::text AS created_at, s.updated_at::text AS updated_at ' +
  'FROM hlth_telehealth_sessions s ' +
  'LEFT JOIN hlth_telehealth_providers p ON p.id = s.provider_id AND p.school_id = s.school_id ' +
  'LEFT JOIN sis_students sst ON sst.id = s.student_id ' +
  'LEFT JOIN platform.platform_students sps ON sps.id = sst.platform_student_id ' +
  'LEFT JOIN platform.iam_person sip ON sip.id = sps.person_id ';

const SELECT_DOC_BASE =
  'SELECT d.id::text AS id, d.session_id::text AS session_id, d.document_type, ' +
  '       d.s3_key, d.file_size_bytes, ' +
  '       d.signature_request_id::text AS signature_request_id, ' +
  '       d.uploaded_by::text AS uploaded_by, ' +
  '       ip.first_name AS uploaded_by_first, ip.last_name AS uploaded_by_last, ' +
  '       d.uploaded_at::text AS uploaded_at ' +
  'FROM hlth_telehealth_documents d ' +
  'LEFT JOIN platform.platform_users pu ON pu.id = d.uploaded_by ' +
  'LEFT JOIN platform.iam_person ip ON ip.id = pu.person_id ';

@Injectable()
export class TelehealthSessionService {
  private readonly logger = new Logger(TelehealthSessionService.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
    private readonly providers: TelehealthProviderService,
    private readonly accessLog: HealthAccessLogService,
  ) {}

  /**
   * Schedule a telehealth session. The provider must exist + be active in
   * this school. consent_signature_id is a soft ref to a future
   * platform_signature_requests row — the request creation lives in the
   * signature module (not yet shipped); for this cycle we accept the
   * `requestParentConsent` flag and stamp consent_received_at later via
   * PATCH /:id when the parent confirms.
   */
  async schedule(
    input: CreateTelehealthSessionDto,
    actor: ResolvedActor,
  ): Promise<TelehealthSessionDto> {
    await this.assertTelehealthScope(actor);
    const tenant = getCurrentTenant();

    // Validate the provider belongs to this school + is active.
    await this.providers.loadActiveOrFail(input.providerId);

    // Validate the student belongs to this school.
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT id FROM sis_students WHERE id = $1::uuid LIMIT 1',
        input.studentId,
      )) as Array<{ id: string }>;
      if (rows.length === 0) {
        throw new BadRequestException('Student not found in this school');
      }
    });

    const id = generateId();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO hlth_telehealth_sessions ' +
          '(id, school_id, student_id, provider_id, scheduled_at, duration_minutes, ' +
          ' status, meeting_url) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::timestamptz, $6, $7, $8)',
        id,
        tenant.schoolId,
        input.studentId,
        input.providerId,
        input.scheduledAt,
        input.durationMinutes ?? null,
        'SCHEDULED',
        input.meetingUrl ?? null,
      );
      const rows = (await tx.$queryRawUnsafe(
        SELECT_SESSION_BASE + 'WHERE s.id = $1::uuid LIMIT 1',
        id,
      )) as SessionRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  async list(
    args: ListTelehealthSessionsQueryDto,
    actor: ResolvedActor,
  ): Promise<TelehealthSessionDto[]> {
    await this.assertReadScope(actor);
    const tenant = getCurrentTenant();
    const limit = Math.min(args.limit ?? 50, 200);
    const params: unknown[] = [tenant.schoolId];
    let where = 'WHERE s.school_id = $1::uuid';
    if (args.studentId) {
      params.push(args.studentId);
      where += ' AND s.student_id = $' + params.length + '::uuid';
    }
    if (args.status) {
      params.push(args.status);
      where += ' AND s.status = $' + params.length;
    }

    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return (await client.$queryRawUnsafe(
        SELECT_SESSION_BASE + where + ' ORDER BY s.scheduled_at DESC LIMIT ' + limit,
        ...params,
      )) as SessionRow[];
    });

    // HIPAA: every read of a telehealth session writes hlth_health_access_log
    // with access_type=VIEW_TELEHEALTH. Per-row entry so the audit trail
    // captures exactly which records were exposed to which staff member.
    for (const r of rows) {
      try {
        await this.accessLog.recordAccess(actor, r.student_id, 'VIEW_TELEHEALTH');
      } catch (e: any) {
        // Audit-log failure must not silently swallow. Throw so the
        // controller fails closed and the SELECT result is not returned.
        this.logger.error(
          'hlth_access_log write failed (VIEW_TELEHEALTH session=' +
            r.id +
            '): ' +
            (e?.message || e),
        );
        throw e;
      }
    }
    return rows.map((r) => this.rowToDto(r));
  }

  async getById(id: string, actor: ResolvedActor): Promise<TelehealthSessionDto> {
    await this.assertReadScope(actor);
    const tenant = getCurrentTenant();
    const row = await this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_SESSION_BASE + 'WHERE s.school_id = $1::uuid AND s.id = $2::uuid LIMIT 1',
        tenant.schoolId,
        id,
      )) as SessionRow[];
      if (rows.length === 0) throw new NotFoundException('Session not found');
      return rows[0]!;
    });
    // HIPAA audit row for the single-record read.
    await this.accessLog.recordAccess(actor, row.student_id, 'VIEW_TELEHEALTH');
    return this.rowToDto(row);
  }

  /**
   * Status transitions:
   *  SCHEDULED → IN_PROGRESS / COMPLETED / NO_SHOW / CANCELLED
   *  IN_PROGRESS → COMPLETED / CANCELLED
   * COMPLETED + NO_SHOW are terminal. CANCELLED is terminal too.
   *
   * Multi-column completed_chk in schema requires completed_at NOT NULL
   * when status=COMPLETED; cancelled_chk requires cancelled_at NOT NULL
   * when status=CANCELLED. Both are stamped atomically in the same UPDATE.
   */
  async patch(
    id: string,
    input: UpdateTelehealthSessionDto,
    actor: ResolvedActor,
  ): Promise<TelehealthSessionDto> {
    await this.assertTelehealthScope(actor);
    const tenant = getCurrentTenant();

    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, status FROM hlth_telehealth_sessions ' +
          'WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        id,
      )) as Array<{ id: string; status: string }>;
      if (lock.length === 0) throw new NotFoundException('Session not found');
      const cur = lock[0]!.status as TelehealthSessionStatus;

      const sets: string[] = [];
      const values: unknown[] = [];
      let n = 1;
      const push = (col: string, value: unknown) => {
        sets.push(col + ' = $' + n);
        values.push(value);
        n += 1;
      };

      if (input.meetingUrl !== undefined) push('meeting_url', input.meetingUrl);
      if (input.sessionNotesS3Key !== undefined)
        push('session_notes_s3_key', input.sessionNotesS3Key);

      if (input.status !== undefined && input.status !== cur) {
        const target = input.status;
        if (cur === 'COMPLETED' || cur === 'NO_SHOW' || cur === 'CANCELLED') {
          throw new BadRequestException('Cannot transition out of terminal status ' + cur + '.');
        }
        if (cur === 'SCHEDULED' && !TELEHEALTH_SESSION_STATUSES.includes(target)) {
          throw new BadRequestException('Invalid status target ' + target);
        }
        push('status', target);
        if (target === 'COMPLETED') {
          sets.push('completed_at = now()');
        } else if (target === 'CANCELLED') {
          sets.push('cancelled_at = now()');
          if (input.cancellationReason !== undefined) {
            push('cancellation_reason', input.cancellationReason);
          }
        }
      } else if (input.cancellationReason !== undefined) {
        push('cancellation_reason', input.cancellationReason);
      }

      if (sets.length === 0) {
        const rows = (await tx.$queryRawUnsafe(
          SELECT_SESSION_BASE + 'WHERE s.id = $1::uuid LIMIT 1',
          id,
        )) as SessionRow[];
        return this.rowToDto(rows[0]!);
      }
      sets.push('updated_at = now()');
      values.push(tenant.schoolId, id);
      await tx.$executeRawUnsafe(
        'UPDATE hlth_telehealth_sessions SET ' +
          sets.join(', ') +
          ' WHERE school_id = $' +
          n +
          '::uuid AND id = $' +
          (n + 1) +
          '::uuid',
        ...values,
      );
      const rows = (await tx.$queryRawUnsafe(
        SELECT_SESSION_BASE + 'WHERE s.id = $1::uuid LIMIT 1',
        id,
      )) as SessionRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  /**
   * Stamp consent_received_at + consent_signature_id. Called when the
   * parent confirms via the (future) platform_signature_requests
   * surface; until that ships, admins can call this directly.
   */
  async recordConsent(
    id: string,
    consentSignatureId: string | null,
    actor: ResolvedActor,
  ): Promise<TelehealthSessionDto> {
    await this.assertTelehealthScope(actor);
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id FROM hlth_telehealth_sessions WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        id,
      )) as Array<{ id: string }>;
      if (lock.length === 0) throw new NotFoundException('Session not found');
      await tx.$executeRawUnsafe(
        'UPDATE hlth_telehealth_sessions SET consent_received_at = now(), ' +
          '  consent_signature_id = $1::uuid, updated_at = now() ' +
          'WHERE school_id = $2::uuid AND id = $3::uuid',
        consentSignatureId,
        tenant.schoolId,
        id,
      );
      const rows = (await tx.$queryRawUnsafe(
        SELECT_SESSION_BASE + 'WHERE s.id = $1::uuid LIMIT 1',
        id,
      )) as SessionRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  // ---------- documents ----------------------------------------------------

  async listDocuments(sessionId: string, actor: ResolvedActor): Promise<TelehealthDocumentDto[]> {
    // Reads of documents inherit the parent session's HIPAA audit. Look up
    // the session first to validate row scope + write the access log row.
    const session = await this.getById(sessionId, actor);
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_DOC_BASE + 'WHERE d.session_id = $1::uuid ORDER BY d.uploaded_at DESC',
        session.id,
      )) as DocumentRow[];
      return rows.map((r) => this.docRowToDto(r));
    });
  }

  /**
   * Upload an encrypted document to a telehealth session. Per HIPAA,
   * the s3_key references an object encrypted at rest using the
   * Cycle 22 IT vault wire format. The s3_key is recorded; the
   * encryption itself happens upstream of this endpoint (the upload
   * service applies AES-256-GCM before the s3 put).
   */
  async uploadDocument(
    sessionId: string,
    input: UploadTelehealthDocumentDto,
    actor: ResolvedActor,
  ): Promise<TelehealthDocumentDto> {
    await this.assertTelehealthScope(actor);
    const tenant = getCurrentTenant();

    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const sessionLookup = (await tx.$queryRawUnsafe(
        'SELECT id FROM hlth_telehealth_sessions WHERE school_id = $1::uuid AND id = $2::uuid LIMIT 1',
        tenant.schoolId,
        sessionId,
      )) as Array<{ id: string }>;
      if (sessionLookup.length === 0) throw new NotFoundException('Session not found');

      const id = generateId();
      await tx.$executeRawUnsafe(
        'INSERT INTO hlth_telehealth_documents ' +
          '(id, session_id, document_type, s3_key, file_size_bytes, signature_request_id, uploaded_by) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7::uuid)',
        id,
        sessionId,
        input.documentType,
        input.s3Key,
        input.fileSizeBytes ?? null,
        input.signatureRequestId ?? null,
        actor.accountId,
      );
      const rows = (await tx.$queryRawUnsafe(
        SELECT_DOC_BASE + 'WHERE d.id = $1::uuid LIMIT 1',
        id,
      )) as DocumentRow[];
      return this.docRowToDto(rows[0]!);
    });
  }

  // ---------- authorization helpers ---------------------------------------

  private async assertTelehealthScope(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'hlt-006:write',
    ]);
    if (!ok) {
      throw new ForbiddenException(
        'Telehealth scheduling and updates require hlt-006:write or school admin.',
      );
    }
  }

  private async assertReadScope(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'hlt-006:read',
    ]);
    if (!ok) {
      throw new ForbiddenException('Telehealth read access requires hlt-006:read or school admin.');
    }
  }

  // ---------- DTO mappers --------------------------------------------------

  private rowToDto(r: SessionRow): TelehealthSessionDto {
    const studentName =
      r.student_first || r.student_last
        ? [r.student_first, r.student_last].filter(Boolean).join(' ')
        : null;
    return {
      id: r.id,
      schoolId: r.school_id,
      studentId: r.student_id,
      studentName,
      providerId: r.provider_id,
      providerName: r.provider_name,
      providerSpeciality: r.provider_speciality,
      scheduledAt: r.scheduled_at,
      durationMinutes: r.duration_minutes,
      status: r.status as TelehealthSessionStatus,
      meetingUrl: r.meeting_url,
      sessionNotesS3Key: r.session_notes_s3_key,
      consentSignatureId: r.consent_signature_id,
      consentReceivedAt: r.consent_received_at,
      completedAt: r.completed_at,
      cancelledAt: r.cancelled_at,
      cancellationReason: r.cancellation_reason,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private docRowToDto(r: DocumentRow): TelehealthDocumentDto {
    const uploadedByName =
      r.uploaded_by_first || r.uploaded_by_last
        ? [r.uploaded_by_first, r.uploaded_by_last].filter(Boolean).join(' ')
        : null;
    return {
      id: r.id,
      sessionId: r.session_id,
      documentType: r.document_type as TelehealthDocumentType,
      s3Key: r.s3_key,
      fileSizeBytes: r.file_size_bytes,
      signatureRequestId: r.signature_request_id,
      uploadedBy: r.uploaded_by,
      uploadedByName,
      uploadedAt: r.uploaded_at,
    };
  }
}
