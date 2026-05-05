import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import {
  CaseloadResponseDto,
  CaseloadStatus,
  CloseCaseloadDto,
  CreateCaseloadDto,
  ListCaseloadsQueryDto,
  PrimaryConcern,
  UpdateCaseloadDto,
} from './dto/counselling.dto';

interface CaseloadRow {
  id: string;
  school_id: string;
  counselor_id: string;
  counselor_first: string | null;
  counselor_last: string | null;
  student_id: string;
  student_first: string | null;
  student_last: string | null;
  student_grade: string | null;
  academic_year_id: string;
  academic_year_name: string | null;
  primary_concern: string;
  is_primary_counselor: boolean;
  status: string;
  opened_at: string;
  closed_at: string | null;
  closure_reason: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_CASELOAD_BASE =
  'SELECT cl.id::text AS id, cl.school_id::text AS school_id, ' +
  'cl.counselor_id::text AS counselor_id, ' +
  'cp.first_name AS counselor_first, cp.last_name AS counselor_last, ' +
  'cl.student_id::text AS student_id, ' +
  'sip.first_name AS student_first, sip.last_name AS student_last, s.grade_level AS student_grade, ' +
  'cl.academic_year_id::text AS academic_year_id, ay.name AS academic_year_name, ' +
  'cl.primary_concern, cl.is_primary_counselor, cl.status, ' +
  "TO_CHAR(cl.opened_at, 'YYYY-MM-DD') AS opened_at, " +
  "TO_CHAR(cl.closed_at, 'YYYY-MM-DD') AS closed_at, " +
  'cl.closure_reason, cl.notes, ' +
  'TO_CHAR(cl.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(cl.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM svc_caseloads cl ' +
  'JOIN sis_students s ON s.id = cl.student_id ' +
  'JOIN platform.platform_students sps ON sps.id = s.platform_student_id ' +
  'JOIN platform.iam_person sip ON sip.id = sps.person_id ' +
  'JOIN sis_academic_years ay ON ay.id = cl.academic_year_id ' +
  'LEFT JOIN hr_employees ce ON ce.id = cl.counselor_id ' +
  'LEFT JOIN platform.iam_person cp ON cp.id = ce.person_id ';

function fullName(first: string | null, last: string | null): string | null {
  if (first && last) return first + ' ' + last;
  return null;
}

/**
 * Strip notes for parents and teachers per the Step 5 visibility contract.
 * Parents see counsellor name + concern only. Teachers (non-admin STAFF
 * who aren't the assigned counsellor on the row) see the same minimal
 * shape. The assigned counsellor and admins see notes.
 */
function stripForNonManager(dto: CaseloadResponseDto): CaseloadResponseDto {
  return { ...dto, notes: null, closureReason: null };
}

/**
 * Per-row manager check. Admins always see notes. STAFF see notes only
 * for caseloads where they are the assigned counsellor. GUARDIAN and
 * STUDENT never see notes.
 */
function isRowManager(actor: ResolvedActor, counselorId: string): boolean {
  if (actor.isSchoolAdmin) return true;
  if (actor.personType === 'STAFF' && actor.employeeId === counselorId) return true;
  return false;
}

@Injectable()
export class CaseloadService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  /**
   * Counsellor scope: admin OR holds cou-001:write at the role level.
   * The IAM seed grants cou-001:write to Staff (counsellor + VP + admin
   * assistant) only. Teachers hold cou-001:read but NOT cou-001:write,
   * so this returns false for teachers — keeping caseload writes admin /
   * counsellor only per the Step 5 plan.
   */
  async hasCounsellorScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'cou-001:write',
    ]);
  }

  /**
   * Visibility model:
   *
   * - Admin / counsellor (`isSchoolAdmin`)        → all caseloads in tenant.
   * - Counsellor (STAFF with employeeId) without admin scope → own caseloads
   *   (counselor_id = me).
   * - Teacher (STAFF without admin scope, no own caseloads) → caseloads
   *   for students in their classes (sis_class_teachers + sis_enrollments).
   *   Notes stripped.
   * - Parent (GUARDIAN)                           → own children's caseloads
   *   via sis_student_guardians + sis_guardians keyed on actor.personId.
   *   Notes stripped.
   * - Student / unknown                           → no rows.
   *
   * Returns the SQL fragment + parameter to bind plus a manager flag.
   */
  private buildVisibility(
    actor: ResolvedActor,
    start: number,
  ): { fragment: string; param: string | null; consumed: 0 | 1; isManager: boolean } {
    if (actor.isSchoolAdmin) {
      return { fragment: '', param: null, consumed: 0, isManager: true };
    }
    if (actor.personType === 'STAFF' && actor.employeeId) {
      // Counsellor own caseloads OR teacher class scope. The
      // ReferralService teacher branch uses the same predicate. Either
      // path returns isManager=false so the response is stripped of
      // notes (the Step 8 UI will surface a separate counsellor view).
      return {
        fragment:
          'AND (cl.counselor_id = $' +
          start +
          '::uuid OR cl.student_id IN (' +
          'SELECT e.student_id FROM sis_enrollments e ' +
          'JOIN sis_class_teachers ct ON ct.class_id = e.class_id ' +
          "WHERE e.status = 'ACTIVE' AND ct.teacher_employee_id = $" +
          start +
          '::uuid' +
          ')) ',
        param: actor.employeeId,
        consumed: 1,
        isManager: false,
      };
    }
    if (actor.personType === 'GUARDIAN') {
      return {
        fragment:
          'AND cl.student_id IN (' +
          'SELECT sg.student_id FROM sis_student_guardians sg ' +
          'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
          'WHERE g.person_id = $' +
          start +
          '::uuid' +
          ') ',
        param: actor.personId,
        consumed: 1,
        isManager: false,
      };
    }
    return { fragment: 'AND FALSE ', param: null, consumed: 0, isManager: false };
  }

  async list(query: ListCaseloadsQueryDto, actor: ResolvedActor): Promise<CaseloadResponseDto[]> {
    const limit = Math.min(query.limit ?? 100, 200);
    const visibility = this.buildVisibility(actor, 1);
    const sql: string[] = [SELECT_CASELOAD_BASE, 'WHERE 1=1 '];
    const params: unknown[] = [];
    let idx = 1;
    if (visibility.consumed === 1) {
      sql.push(visibility.fragment);
      params.push(visibility.param);
      idx++;
    } else if (visibility.fragment) {
      sql.push(visibility.fragment);
    }
    if (query.status) {
      sql.push('AND cl.status = $' + idx + ' ');
      params.push(query.status);
      idx++;
    }
    if (query.concern) {
      sql.push('AND cl.primary_concern = $' + idx + ' ');
      params.push(query.concern);
      idx++;
    }
    if (query.academicYearId) {
      sql.push('AND cl.academic_year_id = $' + idx + '::uuid ');
      params.push(query.academicYearId);
      idx++;
    }
    if (query.counselorId) {
      sql.push('AND cl.counselor_id = $' + idx + '::uuid ');
      params.push(query.counselorId);
      idx++;
    }
    sql.push("ORDER BY cl.status = 'ACTIVE' DESC, cl.opened_at DESC ");
    sql.push('LIMIT ' + limit);

    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<CaseloadRow[]>(sql.join(''), ...params);
    });
    return rows.map((r) => {
      const dto = this.rowToDto(r);
      return isRowManager(actor, r.counselor_id) ? dto : stripForNonManager(dto);
    });
  }

  async getById(id: string, actor: ResolvedActor): Promise<CaseloadResponseDto> {
    const dto = await this.loadOrFail(id, actor);
    // Inline session count + last session date + linked BIP for the
    // detail page — only on getById, not on list.
    const stats = await this.tenantPrisma.executeInTenantContext(async (client) => {
      const sessions = (await client.$queryRawUnsafe(
        "SELECT COUNT(*)::int AS c, TO_CHAR(MAX(session_date), 'YYYY-MM-DD') AS last_session " +
          'FROM svc_sessions WHERE primary_caseload_id = $1::uuid',
        id,
      )) as Array<{ c: number; last_session: string | null }>;
      const bip = (await client.$queryRawUnsafe(
        'SELECT id::text AS id FROM svc_behavior_plans WHERE caseload_id = $1::uuid LIMIT 1',
        id,
      )) as Array<{ id: string }>;
      return {
        sessionCount: sessions[0]?.c ?? 0,
        lastSessionDate: sessions[0]?.last_session ?? null,
        linkedBipId: bip[0]?.id ?? null,
      };
    });
    return {
      ...dto,
      sessionCount: stats.sessionCount,
      lastSessionDate: stats.lastSessionDate,
      linkedBipId: stats.linkedBipId,
    };
  }

  /**
   * Open a new caseload. Counsellor or admin only.
   *
   * Pre-flights the partial UNIQUE keystone
   *   `(student_id, academic_year_id) WHERE status='ACTIVE' AND is_primary_counselor=true`
   * surfacing a friendly 400 with the conflicting caseload id rather than
   * letting the schema raise SQLSTATE 23505. Concurrency-loser races on
   * the same keystone are caught via the same isUniqueViolation helper
   * in case two parallel requests slip past the pre-flight (mirrors
   * Cycle 9 BehaviorPlanService.activate REVIEW-CYCLE9 fix).
   *
   * When `fromReferralId` is supplied, asserts the referral exists, is
   * ACCEPTED, and references the same student. The Step 5 keystone for
   * Step 10's CAT scenario.
   */
  async create(input: CreateCaseloadDto, actor: ResolvedActor): Promise<CaseloadResponseDto> {
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException('Only counsellors or admins can open a caseload');
    }
    const tenant = getCurrentTenant();
    const isPrimary = input.isPrimaryCounselor ?? true;

    if (input.fromReferralId) {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        const refRows = (await client.$queryRawUnsafe(
          'SELECT student_id::text AS student_id, status FROM svc_referrals WHERE id = $1::uuid',
          input.fromReferralId,
        )) as Array<{ student_id: string; status: string }>;
        if (refRows.length === 0)
          throw new BadRequestException('fromReferralId does not match a referral');
        if (refRows[0]!.student_id !== input.studentId)
          throw new BadRequestException(
            'Referral student does not match the caseload student — cannot link',
          );
        if (refRows[0]!.status !== 'ACCEPTED' && refRows[0]!.status !== 'IN_PROGRESS')
          throw new BadRequestException(
            'Referral must be ACCEPTED or IN_PROGRESS before a caseload can be opened from it',
          );
      });
    }

    if (isPrimary) {
      // Pre-flight the partial UNIQUE keystone.
      const conflict = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<Array<{ id: string }>>(
          'SELECT id::text AS id FROM svc_caseloads WHERE student_id = $1::uuid ' +
            "AND academic_year_id = $2::uuid AND status = 'ACTIVE' AND is_primary_counselor = true LIMIT 1",
          input.studentId,
          input.academicYearId,
        );
      });
      if (conflict.length > 0) {
        throw new BadRequestException(
          'Student already has a primary counsellor for this academic year (caseload ' +
            conflict[0]!.id +
            '). Close that caseload before opening a new primary, or set is_primary_counselor=false to open as a consultant.',
        );
      }
    }

    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO svc_caseloads (id, school_id, counselor_id, student_id, academic_year_id, ' +
            'primary_concern, is_primary_counselor, status, opened_at, notes) ' +
            "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, 'ACTIVE', $8::date, $9)",
          id,
          tenant.schoolId,
          input.counselorId,
          input.studentId,
          input.academicYearId,
          input.primaryConcern,
          isPrimary,
          input.openedAt,
          input.notes ?? null,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException(
          'A caseload assignment for this counsellor + student + year already exists in ACTIVE status. ' +
            'Close the existing caseload before opening a new one, or use a different academic year.',
        );
      }
      throw err;
    }
    return this.getById(id, actor);
  }

  async patch(
    id: string,
    input: UpdateCaseloadDto,
    actor: ResolvedActor,
  ): Promise<CaseloadResponseDto> {
    await this.assertCanEdit(id, actor);
    const updates: string[] = [];
    const params: unknown[] = [id];
    let idx = 2;
    if (input.primaryConcern !== undefined) {
      updates.push('primary_concern = $' + idx);
      params.push(input.primaryConcern);
      idx++;
    }
    if (input.notes !== undefined) {
      updates.push('notes = $' + idx);
      params.push(input.notes);
      idx++;
    }
    if (updates.length === 0) {
      return this.getById(id, actor);
    }
    updates.push('updated_at = now()');
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const r = await client.$executeRawUnsafe(
        'UPDATE svc_caseloads SET ' + updates.join(', ') + ' WHERE id = $1::uuid',
        ...params,
      );
      if (r === 0) throw new NotFoundException('Caseload ' + id);
    });
    return this.getById(id, actor);
  }

  /**
   * Close a caseload. Stamps closure_reason + closed_at + status=CLOSED in
   * one UPDATE inside a locked tenant tx so the partial UNIQUE keystone
   * releases atomically.
   */
  async close(
    id: string,
    input: CloseCaseloadDto,
    actor: ResolvedActor,
  ): Promise<CaseloadResponseDto> {
    await this.assertCanEdit(id, actor);
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT status FROM svc_caseloads WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ status: string }>;
      if (lockRows.length === 0) throw new NotFoundException('Caseload ' + id);
      if (lockRows[0]!.status !== 'ACTIVE') {
        throw new BadRequestException(
          'Caseload is in status ' + lockRows[0]!.status + '; only ACTIVE caseloads can be closed',
        );
      }
      await tx.$executeRawUnsafe(
        "UPDATE svc_caseloads SET status = 'CLOSED', closed_at = now()::date, " +
          'closure_reason = $2, updated_at = now() WHERE id = $1::uuid',
        id,
        input.closureReason,
      );
    });
    return this.getById(id, actor);
  }

  // ─── Internal helpers ─────────────────────────────────────────

  /**
   * Used by ReferralService.accept when the caller asks to auto-open a
   * caseload from an accepted referral. Bypasses the gate-tier check
   * (caller already passed cou-002 gate to accept the referral) but
   * preserves the partial UNIQUE pre-flight + insert path.
   */
  async createInternal(input: {
    counselorId: string;
    studentId: string;
    academicYearId: string;
    primaryConcern: PrimaryConcern;
    isPrimaryCounselor: boolean;
    openedAt: string;
    notes: string | null;
  }): Promise<string> {
    const tenant = getCurrentTenant();
    if (input.isPrimaryCounselor) {
      const conflict = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<Array<{ id: string }>>(
          'SELECT id::text AS id FROM svc_caseloads WHERE student_id = $1::uuid ' +
            "AND academic_year_id = $2::uuid AND status = 'ACTIVE' AND is_primary_counselor = true LIMIT 1",
          input.studentId,
          input.academicYearId,
        );
      });
      if (conflict.length > 0) {
        throw new BadRequestException(
          'Cannot auto-open a primary caseload — student already has one for this year (caseload ' +
            conflict[0]!.id +
            ')',
        );
      }
    }
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO svc_caseloads (id, school_id, counselor_id, student_id, academic_year_id, ' +
            'primary_concern, is_primary_counselor, status, opened_at, notes) ' +
            "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, 'ACTIVE', $8::date, $9)",
          id,
          tenant.schoolId,
          input.counselorId,
          input.studentId,
          input.academicYearId,
          input.primaryConcern,
          input.isPrimaryCounselor,
          input.openedAt,
          input.notes,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException(
          'A duplicate ACTIVE caseload exists for this counsellor + student + year',
        );
      }
      throw err;
    }
    return id;
  }

  /**
   * Edit gate: admin OR the assigned counsellor (cl.counselor_id ===
   * actor.employeeId) can patch / close. Parents and teachers without
   * admin scope cannot mutate caseloads.
   */
  private async assertCanEdit(id: string, actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    if (!actor.employeeId) {
      throw new ForbiddenException('Only counsellors or admins can edit caseloads');
    }
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ counselor_id: string }>>(
        'SELECT counselor_id::text AS counselor_id FROM svc_caseloads WHERE id = $1::uuid',
        id,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Caseload ' + id);
    if (rows[0]!.counselor_id !== actor.employeeId) {
      throw new ForbiddenException(
        'Only the assigned counsellor or an admin can edit this caseload',
      );
    }
  }

  private async loadOrFail(id: string, actor: ResolvedActor): Promise<CaseloadResponseDto> {
    const visibility = this.buildVisibility(actor, 2);
    const sql = SELECT_CASELOAD_BASE + 'WHERE cl.id = $1::uuid ' + visibility.fragment;
    const params: unknown[] = [id];
    if (visibility.consumed === 1) params.push(visibility.param);
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<CaseloadRow[]>(sql, ...params);
    });
    if (rows.length === 0) throw new NotFoundException('Caseload ' + id);
    const r = rows[0]!;
    const dto = this.rowToDto(r);
    return isRowManager(actor, r.counselor_id) ? dto : stripForNonManager(dto);
  }

  private rowToDto(r: CaseloadRow): CaseloadResponseDto {
    return {
      id: r.id,
      schoolId: r.school_id,
      counselorId: r.counselor_id,
      counselorName: fullName(r.counselor_first, r.counselor_last),
      studentId: r.student_id,
      studentFirstName: r.student_first,
      studentLastName: r.student_last,
      studentGradeLevel: r.student_grade,
      academicYearId: r.academic_year_id,
      academicYearName: r.academic_year_name,
      primaryConcern: r.primary_concern as PrimaryConcern,
      isPrimaryCounselor: r.is_primary_counselor,
      status: r.status as CaseloadStatus,
      openedAt: r.opened_at,
      closedAt: r.closed_at,
      closureReason: r.closure_reason,
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
