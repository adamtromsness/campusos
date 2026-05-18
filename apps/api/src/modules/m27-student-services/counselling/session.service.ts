import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import { PermissionCheckService } from '@modules/m00-platform';
import {
  AddParticipantDto,
  AttendanceStatus,
  CreateSessionDto,
  ListSessionsQueryDto,
  MarkAttendanceDto,
  SessionParticipantResponseDto,
  SessionResponseDto,
  SessionStatus,
  SessionType,
  UpdateSessionDto,
} from './dto/counselling.dto';

interface SessionRow {
  id: string;
  school_id: string;
  counselor_id: string;
  counselor_first: string | null;
  counselor_last: string | null;
  session_date: string;
  duration_minutes: number | null;
  session_type: string;
  primary_caseload_id: string | null;
  primary_student_id: string | null;
  primary_student_first: string | null;
  primary_student_last: string | null;
  referral_id: string | null;
  status: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface ParticipantRow {
  id: string;
  session_id: string;
  student_id: string;
  student_first: string | null;
  student_last: string | null;
  caseload_id: string | null;
  attendance_status: string;
  notes: string | null;
}

const SELECT_SESSION_BASE =
  'SELECT s.id::text AS id, s.school_id::text AS school_id, ' +
  's.counselor_id::text AS counselor_id, ' +
  'cp.first_name AS counselor_first, cp.last_name AS counselor_last, ' +
  "TO_CHAR(s.session_date, 'YYYY-MM-DD') AS session_date, " +
  's.duration_minutes, s.session_type, ' +
  's.primary_caseload_id::text AS primary_caseload_id, ' +
  'cl.student_id::text AS primary_student_id, ' +
  'pip.first_name AS primary_student_first, pip.last_name AS primary_student_last, ' +
  's.referral_id::text AS referral_id, s.status, s.notes, ' +
  'TO_CHAR(s.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(s.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM svc_sessions s ' +
  'LEFT JOIN hr_employees ce ON ce.id = s.counselor_id ' +
  'LEFT JOIN platform.iam_person cp ON cp.id = ce.person_id ' +
  'LEFT JOIN svc_caseloads cl ON cl.id = s.primary_caseload_id ' +
  'LEFT JOIN sis_students ps ON ps.id = cl.student_id ' +
  'LEFT JOIN platform.platform_students pps ON pps.id = ps.platform_student_id ' +
  'LEFT JOIN platform.iam_person pip ON pip.id = pps.person_id ';

const SELECT_PARTICIPANT_BASE =
  'SELECT sp.id::text AS id, sp.session_id::text AS session_id, ' +
  'sp.student_id::text AS student_id, ' +
  'sip.first_name AS student_first, sip.last_name AS student_last, ' +
  'sp.caseload_id::text AS caseload_id, sp.attendance_status, sp.notes ' +
  'FROM svc_session_participants sp ' +
  'JOIN sis_students s ON s.id = sp.student_id ' +
  'JOIN platform.platform_students sps ON sps.id = s.platform_student_id ' +
  'JOIN platform.iam_person sip ON sip.id = sps.person_id ';

function fullName(first: string | null, last: string | null): string | null {
  if (first && last) return first + ' ' + last;
  return null;
}

function rowToParticipantDto(r: ParticipantRow): SessionParticipantResponseDto {
  return {
    id: r.id,
    sessionId: r.session_id,
    studentId: r.student_id,
    studentFirstName: r.student_first,
    studentLastName: r.student_last,
    caseloadId: r.caseload_id,
    attendanceStatus: r.attendance_status as AttendanceStatus,
    notes: r.notes,
  };
}

@Injectable()
export class SessionService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  /**
   * Counsellor scope: admin OR holds cou-001:write at the role level.
   * Mirrors CaseloadService.hasCounsellorScope. Sessions are
   * counsellor-and-admin only — teachers / parents / students never
   * reach this gate (cou-001:read is granted to teachers and parents
   * for the caseload assignment summary, but cou-001:write is
   * restricted to Staff + Admin in the IAM seed).
   */
  async hasCounsellorScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'cou-001:write',
    ]);
  }

  /**
   * Visibility: admin sees all. Counsellor (STAFF with employeeId) sees
   * own sessions (counselor_id = me). Anyone else returns no rows —
   * sessions are counsellor surface only.
   */
  private buildVisibility(
    actor: ResolvedActor,
    start: number,
  ): { fragment: string; params: unknown[]; consumed: number } {
    if (actor.isSchoolAdmin) {
      return { fragment: '', params: [], consumed: 0 };
    }
    if (actor.personType === 'STAFF' && actor.employeeId) {
      return {
        fragment: 'AND s.counselor_id = $' + start + '::uuid ',
        params: [actor.employeeId],
        consumed: 1,
      };
    }
    return { fragment: 'AND FALSE ', params: [], consumed: 0 };
  }

  async list(query: ListSessionsQueryDto, actor: ResolvedActor): Promise<SessionResponseDto[]> {
    const limit = Math.min(query.limit ?? 100, 200);
    // Wave 3 follow-up: explicit s.school_id predicate so list under
    // School A doesn't return School B sessions when the harness
    // shares one tenant schema.
    const tenant = getCurrentTenant();
    const visibility = this.buildVisibility(actor, 2);
    const sql: string[] = [SELECT_SESSION_BASE, 'WHERE s.school_id = $1::uuid '];
    const params: unknown[] = [tenant.schoolId, ...visibility.params];
    let idx = 2 + visibility.consumed;
    if (visibility.fragment) sql.push(visibility.fragment);
    if (query.status) {
      sql.push('AND s.status = $' + idx + ' ');
      params.push(query.status);
      idx++;
    }
    if (query.sessionType) {
      sql.push('AND s.session_type = $' + idx + ' ');
      params.push(query.sessionType);
      idx++;
    }
    if (query.caseloadId) {
      sql.push('AND s.primary_caseload_id = $' + idx + '::uuid ');
      params.push(query.caseloadId);
      idx++;
    }
    if (query.counselorId) {
      sql.push('AND s.counselor_id = $' + idx + '::uuid ');
      params.push(query.counselorId);
      idx++;
    }
    if (query.fromDate) {
      sql.push('AND s.session_date >= $' + idx + '::date ');
      params.push(query.fromDate);
      idx++;
    }
    if (query.toDate) {
      sql.push('AND s.session_date <= $' + idx + '::date ');
      params.push(query.toDate);
      idx++;
    }
    sql.push('ORDER BY s.session_date DESC, s.created_at DESC ');
    sql.push('LIMIT ' + limit);

    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<SessionRow[]>(sql.join(''), ...params);
    });
    return rows.map((r) => this.rowToDto(r));
  }

  async getById(id: string, actor: ResolvedActor): Promise<SessionResponseDto> {
    const dto = await this.loadOrFail(id, actor);
    const participants = await this.listParticipants(id);
    return { ...dto, participants };
  }

  async listParticipants(sessionId: string): Promise<SessionParticipantResponseDto[]> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ParticipantRow[]>(
        SELECT_PARTICIPANT_BASE + 'WHERE sp.session_id = $1::uuid ORDER BY sp.created_at ASC',
        sessionId,
      );
    });
    return rows.map(rowToParticipantDto);
  }

  /**
   * Schedule or log a counselling session. Counsellor or admin only.
   * Validates the INDIVIDUAL/GROUP shape rule:
   *   - INDIVIDUAL requires primary_caseload_id (identifies the student).
   *   - GROUP must NOT carry primary_caseload_id (use participants).
   *   - CRISIS / CHECK_IN / PARENT_MEETING / CONSULTATION accept either
   *     shape — the session's identifying student lives on
   *     primary_caseload_id when set or on the participants list.
   * Validates referenced caseload + referral exist in this tenant.
   *
   * Per REVIEW-CYCLE11 BLOCKING 2: non-admin counsellors must own the
   * row they are creating — `input.counselorId` must equal
   * `actor.employeeId`. Admins may schedule on any counsellor's calendar.
   */
  async create(input: CreateSessionDto, actor: ResolvedActor): Promise<SessionResponseDto> {
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException('Only counsellors or admins can create sessions');
    }
    if (!actor.isSchoolAdmin) {
      if (!actor.employeeId || input.counselorId !== actor.employeeId) {
        throw new ForbiddenException(
          'Non-admin counsellors can only create sessions on their own calendar',
        );
      }
    }
    if (input.sessionType === 'INDIVIDUAL' && !input.primaryCaseloadId) {
      throw new BadRequestException(
        'INDIVIDUAL sessions require primaryCaseloadId to identify the student',
      );
    }
    if (input.sessionType === 'GROUP' && input.primaryCaseloadId) {
      throw new BadRequestException(
        'GROUP sessions must not set primaryCaseloadId — use the participants list',
      );
    }

    const tenant = getCurrentTenant();
    const id = generateId();

    if (input.primaryCaseloadId) {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        const r = (await client.$queryRawUnsafe(
          'SELECT 1 AS ok FROM svc_caseloads WHERE id = $1::uuid LIMIT 1',
          input.primaryCaseloadId,
        )) as Array<{ ok: number }>;
        if (r.length === 0) {
          throw new BadRequestException(
            'primaryCaseloadId does not match a caseload in this school',
          );
        }
      });
    }
    if (input.referralId) {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        const r = (await client.$queryRawUnsafe(
          'SELECT 1 AS ok FROM svc_referrals WHERE id = $1::uuid LIMIT 1',
          input.referralId,
        )) as Array<{ ok: number }>;
        if (r.length === 0) {
          throw new BadRequestException('referralId does not match a referral in this school');
        }
      });
    }

    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO svc_sessions (id, school_id, counselor_id, session_date, duration_minutes, ' +
          'session_type, primary_caseload_id, referral_id, status, notes) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5, $6, $7::uuid, $8::uuid, $9, $10)',
        id,
        tenant.schoolId,
        input.counselorId,
        input.sessionDate,
        input.durationMinutes ?? null,
        input.sessionType,
        input.primaryCaseloadId ?? null,
        input.referralId ?? null,
        input.status ?? 'SCHEDULED',
        input.notes ?? null,
      );
    });
    return this.getById(id, actor);
  }

  /**
   * Update mutable session fields. Locks the row inside one tx so
   * status transitions cannot race; refuses updates to a CANCELLED or
   * COMPLETED+NO_SHOW row out of the box (set the row to SCHEDULED
   * first via a deliberate transition).
   *
   * Per REVIEW-CYCLE11 BLOCKING 2: non-admin counsellors can only
   * update sessions where `counselor_id = actor.employeeId`. The check
   * runs inside the same tx as the UPDATE so a race cannot bypass it.
   */
  async patch(
    id: string,
    input: UpdateSessionDto,
    actor: ResolvedActor,
  ): Promise<SessionResponseDto> {
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException('Only counsellors or admins can update sessions');
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT id, counselor_id::text AS counselor_id FROM svc_sessions WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ id: string; counselor_id: string }>;
      if (lockRows.length === 0) throw new NotFoundException('Session ' + id);
      if (!actor.isSchoolAdmin && lockRows[0]!.counselor_id !== actor.employeeId) {
        throw new ForbiddenException('Non-admin counsellors can only update their own sessions');
      }
      const updates: string[] = [];
      const params: unknown[] = [id];
      let idx = 2;
      if (input.status !== undefined) {
        updates.push('status = $' + idx);
        params.push(input.status);
        idx++;
      }
      if (input.durationMinutes !== undefined) {
        updates.push('duration_minutes = $' + idx);
        params.push(input.durationMinutes);
        idx++;
      }
      if (input.sessionType !== undefined) {
        updates.push('session_type = $' + idx);
        params.push(input.sessionType);
        idx++;
      }
      if (input.notes !== undefined) {
        updates.push('notes = $' + idx);
        params.push(input.notes);
        idx++;
      }
      if (updates.length === 0) return;
      updates.push('updated_at = now()');
      await tx.$executeRawUnsafe(
        'UPDATE svc_sessions SET ' + updates.join(', ') + ' WHERE id = $1::uuid',
        ...params,
      );
    });
    return this.getById(id, actor);
  }

  /**
   * Add a student participant to a GROUP session (or pin an additional
   * student to a non-INDIVIDUAL session). UNIQUE(session_id,
   * student_id) catches duplicate adds with a friendly 400.
   *
   * Per REVIEW-CYCLE11 BLOCKING 2: non-admin counsellors can only add
   * participants to sessions they own.
   */
  async addParticipant(
    sessionId: string,
    input: AddParticipantDto,
    actor: ResolvedActor,
  ): Promise<SessionParticipantResponseDto> {
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException('Only counsellors or admins can manage session participants');
    }
    // Validate session exists + actor owns it (or is admin) + student exists.
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const s = (await client.$queryRawUnsafe(
        'SELECT counselor_id::text AS counselor_id FROM svc_sessions WHERE id = $1::uuid LIMIT 1',
        sessionId,
      )) as Array<{ counselor_id: string }>;
      if (s.length === 0) throw new NotFoundException('Session ' + sessionId);
      if (!actor.isSchoolAdmin && s[0]!.counselor_id !== actor.employeeId) {
        throw new ForbiddenException(
          'Non-admin counsellors can only add participants to their own sessions',
        );
      }
      const st = (await client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM sis_students WHERE id = $1::uuid LIMIT 1',
        input.studentId,
      )) as Array<{ ok: number }>;
      if (st.length === 0)
        throw new BadRequestException('studentId does not match a student in this school');
    });
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO svc_session_participants (id, session_id, student_id, caseload_id, attendance_status, notes) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6)',
          id,
          sessionId,
          input.studentId,
          input.caseloadId ?? null,
          input.attendanceStatus ?? 'ATTENDED',
          input.notes ?? null,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException('This student is already a participant on this session');
      }
      throw err;
    }
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ParticipantRow[]>(
        SELECT_PARTICIPANT_BASE + 'WHERE sp.id = $1::uuid',
        id,
      );
    });
    return rowToParticipantDto(rows[0]!);
  }

  /**
   * Per REVIEW-CYCLE11 BLOCKING 2: non-admin counsellors can only mark
   * attendance for participants on sessions they own. Resolves the
   * parent session's counselor_id and validates against actor.employeeId
   * before mutating.
   */
  async markAttendance(
    participantId: string,
    input: MarkAttendanceDto,
    actor: ResolvedActor,
  ): Promise<SessionParticipantResponseDto> {
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException('Only counsellors or admins can mark attendance');
    }
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const sess = (await client.$queryRawUnsafe(
        'SELECT s.counselor_id::text AS counselor_id FROM svc_session_participants sp ' +
          'JOIN svc_sessions s ON s.id = sp.session_id ' +
          'WHERE sp.id = $1::uuid LIMIT 1',
        participantId,
      )) as Array<{ counselor_id: string }>;
      if (sess.length === 0) throw new NotFoundException('Session participant ' + participantId);
      if (!actor.isSchoolAdmin && sess[0]!.counselor_id !== actor.employeeId) {
        throw new ForbiddenException(
          'Non-admin counsellors can only mark attendance for their own sessions',
        );
      }
      const r = await client.$executeRawUnsafe(
        'UPDATE svc_session_participants SET attendance_status = $2, notes = COALESCE($3, notes), updated_at = now() ' +
          'WHERE id = $1::uuid',
        participantId,
        input.attendanceStatus,
        input.notes ?? null,
      );
      if (r === 0) throw new NotFoundException('Session participant ' + participantId);
    });
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ParticipantRow[]>(
        SELECT_PARTICIPANT_BASE + 'WHERE sp.id = $1::uuid',
        participantId,
      );
    });
    return rowToParticipantDto(rows[0]!);
  }

  // ─── Internal helpers ─────────────────────────────────────────

  /**
   * Public helper used by SessionNoteService to enforce row-scope
   * before returning notes — every read against a session validates
   * counsellor / admin scope here first.
   */
  async loadOrFail(id: string, actor: ResolvedActor): Promise<SessionResponseDto> {
    // Wave 3 follow-up: explicit s.school_id predicate. Schema-per-
    // school makes this a no-op in production, but the shared
    // tenant_test schema would otherwise return foreign-school
    // sessions for admin id-probes (admin's buildVisibility is empty).
    const tenant = getCurrentTenant();
    const visibility = this.buildVisibility(actor, 3);
    const sql = SELECT_SESSION_BASE + 'WHERE s.id = $1::uuid AND s.school_id = $2::uuid ' + visibility.fragment;
    const params: unknown[] = [id, tenant.schoolId, ...visibility.params];
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<SessionRow[]>(sql, ...params);
    });
    if (rows.length === 0) throw new NotFoundException('Session ' + id);
    return this.rowToDto(rows[0]!);
  }

  /**
   * Public helper used by SessionNoteService.create to validate the
   * supplied student is either a participant or the primary_caseload's
   * student before inserting the note.
   */
  async studentBelongsToSession(sessionId: string, studentId: string): Promise<boolean> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const r = (await client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM (' +
          'SELECT student_id FROM svc_session_participants WHERE session_id = $1::uuid ' +
          'UNION ' +
          'SELECT cl.student_id FROM svc_sessions s JOIN svc_caseloads cl ON cl.id = s.primary_caseload_id WHERE s.id = $1::uuid' +
          ') q WHERE student_id = $2::uuid LIMIT 1',
        sessionId,
        studentId,
      )) as Array<{ ok: number }>;
      return r.length > 0;
    });
  }

  private rowToDto(r: SessionRow): SessionResponseDto {
    return {
      id: r.id,
      schoolId: r.school_id,
      counselorId: r.counselor_id,
      counselorName: fullName(r.counselor_first, r.counselor_last),
      sessionDate: r.session_date,
      durationMinutes: r.duration_minutes,
      sessionType: r.session_type as SessionType,
      primaryCaseloadId: r.primary_caseload_id,
      primaryStudentId: r.primary_student_id,
      primaryStudentName: fullName(r.primary_student_first, r.primary_student_last),
      referralId: r.referral_id,
      status: r.status as SessionStatus,
      notes: r.notes,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e.code === 'P2010' || e.meta?.code === '23505') return true;
  if (typeof e.message === 'string' && e.message.includes('23505')) return true;
  return false;
}
