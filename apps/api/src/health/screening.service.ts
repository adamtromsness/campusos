import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { HealthAccessLogService } from './health-access-log.service';
import { HealthRecordService } from './health-record.service';
import {
  CreateScreeningDto,
  ListScreeningsQueryDto,
  ScreeningResponseDto,
  ScreeningResult,
  UpdateScreeningDto,
} from './dto/health.dto';

interface ScreeningRow {
  id: string;
  school_id: string;
  student_id: string;
  student_first: string | null;
  student_last: string | null;
  screening_type: string;
  screening_date: string;
  screened_by: string | null;
  screened_first: string | null;
  screened_last: string | null;
  result: string | null;
  result_notes: string | null;
  follow_up_required: boolean;
  follow_up_completed: boolean;
  referral_notes: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_BASE =
  'SELECT s.id::text AS id, s.school_id::text AS school_id, ' +
  's.student_id::text AS student_id, ' +
  'sip.first_name AS student_first, sip.last_name AS student_last, ' +
  "s.screening_type, TO_CHAR(s.screening_date, 'YYYY-MM-DD') AS screening_date, " +
  's.screened_by::text AS screened_by, ' +
  'scp.first_name AS screened_first, scp.last_name AS screened_last, ' +
  's.result, s.result_notes, s.follow_up_required, s.follow_up_completed, s.referral_notes, ' +
  'TO_CHAR(s.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(s.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM hlth_screenings s ' +
  'JOIN sis_students st ON st.id = s.student_id ' +
  'JOIN platform.platform_students sps ON sps.id = st.platform_student_id ' +
  'JOIN platform.iam_person sip ON sip.id = sps.person_id ' +
  'LEFT JOIN hr_employees sce ON sce.id = s.screened_by ' +
  'LEFT JOIN platform.iam_person scp ON scp.id = sce.person_id ';

function fullName(first: string | null, last: string | null): string | null {
  if (first && last) return first + ' ' + last;
  return null;
}

/**
 * ScreeningService — Cycle 10 Step 7.
 *
 * Per-student screening result CRUD. Admin / nurse only — gated on
 * `hlt-004:read` / `hlt-004:write`. The follow-up queue partial INDEX
 * `WHERE follow_up_required=true AND follow_up_completed=false` is
 * the canonical admin-queue hot path; the dedicated GET /follow-up
 * endpoint hits it.
 */
@Injectable()
export class ScreeningService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly accessLog: HealthAccessLogService,
    private readonly records: HealthRecordService,
  ) {}

  async list(query: ListScreeningsQueryDto, actor: ResolvedActor): Promise<ScreeningResponseDto[]> {
    if (!(await this.records.hasNurseScope(actor))) {
      throw new ForbiddenException(
        'Screenings are visible to nurses, counsellors, and admins only',
      );
    }
    const tenant = getCurrentTenant();
    const limit = Math.min(query.limit ?? 100, 500);
    const sql: string[] = [SELECT_BASE, 'WHERE s.school_id = $1::uuid '];
    const params: unknown[] = [tenant.schoolId];
    let idx = 2;
    if (query.studentId) {
      sql.push('AND s.student_id = $' + idx + '::uuid ');
      params.push(query.studentId);
      idx++;
    }
    if (query.screeningType) {
      sql.push('AND s.screening_type = $' + idx + ' ');
      params.push(query.screeningType);
      idx++;
    }
    if (query.result) {
      sql.push('AND s.result = $' + idx + ' ');
      params.push(query.result);
      idx++;
    }
    if (query.fromDate) {
      sql.push('AND s.screening_date >= $' + idx + '::date ');
      params.push(query.fromDate);
      idx++;
    }
    if (query.toDate) {
      sql.push('AND s.screening_date <= $' + idx + '::date ');
      params.push(query.toDate);
      idx++;
    }
    sql.push('ORDER BY s.screening_date DESC LIMIT ' + limit);

    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return (await client.$queryRawUnsafe(sql.join(''), ...params)) as ScreeningRow[];
    });

    // VIEW_SCREENING audit per distinct student in the result set.
    const studentIds = new Set<string>();
    for (const r of rows) studentIds.add(r.student_id);
    for (const sid of studentIds) {
      await this.accessLog.recordAccess(actor, sid, 'VIEW_SCREENING');
    }
    return rows.map((r) => this.rowToDto(r));
  }

  /**
   * Admin follow-up queue — partial INDEX hot path. Returns every
   * REFER (or other follow-up-required) screening with
   * follow_up_completed=false.
   */
  async listFollowUp(actor: ResolvedActor): Promise<ScreeningResponseDto[]> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can read the screening follow-up queue');
    }
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return (await client.$queryRawUnsafe(
        SELECT_BASE +
          'WHERE s.school_id = $1::uuid AND s.follow_up_required = true AND s.follow_up_completed = false ' +
          'ORDER BY s.screening_date ASC',
        tenant.schoolId,
      )) as ScreeningRow[];
    });
    return rows.map((r) => this.rowToDto(r));
  }

  async create(input: CreateScreeningDto, actor: ResolvedActor): Promise<ScreeningResponseDto> {
    if (!(await this.records.hasNurseScope(actor))) {
      throw new ForbiddenException('Only nurses, counsellors, and admins can record screenings');
    }
    if (!actor.employeeId) {
      throw new ForbiddenException(
        'Screening staff member must have an employee record (no hr_employees row)',
      );
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO hlth_screenings ' +
          '(id, school_id, student_id, screening_type, screening_date, screened_by, result, ' +
          ' result_notes, follow_up_required, follow_up_completed, referral_notes) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::date, $6::uuid, $7, $8, $9, false, $10)',
        id,
        tenant.schoolId,
        input.studentId,
        input.screeningType,
        input.screeningDate,
        actor.employeeId,
        input.result ?? null,
        input.resultNotes ?? null,
        input.followUpRequired ?? false,
        input.referralNotes ?? null,
      );
    });
    return this.loadOrFail(id);
  }

  async update(
    id: string,
    input: UpdateScreeningDto,
    actor: ResolvedActor,
  ): Promise<ScreeningResponseDto> {
    if (!(await this.records.hasNurseScope(actor))) {
      throw new ForbiddenException('Only nurses, counsellors, and admins can update screenings');
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (input.result !== undefined) {
      sets.push('result = $' + idx);
      params.push(input.result);
      idx++;
    }
    if (input.resultNotes !== undefined) {
      sets.push('result_notes = $' + idx);
      params.push(input.resultNotes);
      idx++;
    }
    if (input.followUpRequired !== undefined) {
      sets.push('follow_up_required = $' + idx);
      params.push(input.followUpRequired);
      idx++;
    }
    if (input.followUpCompleted !== undefined) {
      sets.push('follow_up_completed = $' + idx);
      params.push(input.followUpCompleted);
      idx++;
    }
    if (input.referralNotes !== undefined) {
      sets.push('referral_notes = $' + idx);
      params.push(input.referralNotes);
      idx++;
    }
    if (sets.length === 0) return this.loadOrFail(id);
    sets.push('updated_at = now()');
    params.push(id);

    const result = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$executeRawUnsafe(
        'UPDATE hlth_screenings SET ' + sets.join(', ') + ' WHERE id = $' + idx + '::uuid',
        ...params,
      );
    });
    if (result === 0) throw new NotFoundException('Screening ' + id);
    return this.loadOrFail(id);
  }

  // ─── Internal ────────────────────────────────────────────────

  private async loadOrFail(id: string): Promise<ScreeningResponseDto> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return (await client.$queryRawUnsafe(
        SELECT_BASE + 'WHERE s.id = $1::uuid LIMIT 1',
        id,
      )) as ScreeningRow[];
    });
    if (rows.length === 0) throw new NotFoundException('Screening ' + id);
    return this.rowToDto(rows[0]!);
  }

  private rowToDto(r: ScreeningRow): ScreeningResponseDto {
    return {
      id: r.id,
      schoolId: r.school_id,
      studentId: r.student_id,
      studentName: fullName(r.student_first, r.student_last),
      screeningType: r.screening_type,
      screeningDate: r.screening_date,
      screenedById: r.screened_by,
      screenedByName: fullName(r.screened_first, r.screened_last),
      result: r.result as ScreeningResult | null,
      resultNotes: r.result_notes,
      followUpRequired: r.follow_up_required,
      followUpCompleted: r.follow_up_completed,
      referralNotes: r.referral_notes,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}
