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
import { PermissionCheckService } from '../iam/permission-check.service';
import {
  AttachTeamMeetingStudentDto,
  CreateMtssTierDto,
  CreateTeamMeetingDto,
  ListMtssTiersQueryDto,
  MeetingOutcome,
  MtssDashboardCellDto,
  MtssDashboardDto,
  MtssDomain,
  MtssTier,
  MtssTierResponseDto,
  MtssTierStatus,
  TeamMeetingResponseDto,
  TeamMeetingStudentResponseDto,
  UpdateMtssTierDto,
} from './dto/counselling.dto';

interface TierRow {
  id: string;
  school_id: string;
  student_id: string;
  student_first: string | null;
  student_last: string | null;
  academic_year_id: string;
  academic_year_name: string | null;
  tier: string;
  domain: string;
  assigned_by: string;
  assigner_first: string | null;
  assigner_last: string | null;
  assigned_at: string;
  review_date: string;
  exit_date: string | null;
  exit_reason: string | null;
  status: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface MeetingRow {
  id: string;
  school_id: string;
  meeting_id: string | null;
  academic_year_id: string;
  facilitated_by: string;
  facilitator_first: string | null;
  facilitator_last: string | null;
  meeting_date: string;
  notes: string | null;
  created_at: string;
}

interface MeetingStudentRow {
  id: string;
  team_meeting_id: string;
  student_id: string;
  student_first: string | null;
  student_last: string | null;
  tier_id: string | null;
  outcome: string | null;
  outcome_notes: string | null;
}

const SELECT_TIER_BASE =
  'SELECT t.id::text AS id, t.school_id::text AS school_id, ' +
  't.student_id::text AS student_id, ' +
  'sip.first_name AS student_first, sip.last_name AS student_last, ' +
  't.academic_year_id::text AS academic_year_id, ay.name AS academic_year_name, ' +
  't.tier, t.domain, ' +
  't.assigned_by::text AS assigned_by, ' +
  'ap.first_name AS assigner_first, ap.last_name AS assigner_last, ' +
  "TO_CHAR(t.assigned_at, 'YYYY-MM-DD') AS assigned_at, " +
  "TO_CHAR(t.review_date, 'YYYY-MM-DD') AS review_date, " +
  "TO_CHAR(t.exit_date, 'YYYY-MM-DD') AS exit_date, " +
  't.exit_reason, t.status, t.notes, ' +
  'TO_CHAR(t.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(t.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM svc_mtss_tiers t ' +
  'JOIN sis_students s ON s.id = t.student_id ' +
  'JOIN platform.platform_students sps ON sps.id = s.platform_student_id ' +
  'JOIN platform.iam_person sip ON sip.id = sps.person_id ' +
  'JOIN sis_academic_years ay ON ay.id = t.academic_year_id ' +
  'LEFT JOIN hr_employees ae ON ae.id = t.assigned_by ' +
  'LEFT JOIN platform.iam_person ap ON ap.id = ae.person_id ';

const SELECT_MEETING_BASE =
  'SELECT m.id::text AS id, m.school_id::text AS school_id, ' +
  'm.meeting_id::text AS meeting_id, m.academic_year_id::text AS academic_year_id, ' +
  'm.facilitated_by::text AS facilitated_by, ' +
  'fp.first_name AS facilitator_first, fp.last_name AS facilitator_last, ' +
  "TO_CHAR(m.meeting_date, 'YYYY-MM-DD') AS meeting_date, " +
  'm.notes, ' +
  'TO_CHAR(m.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at ' +
  'FROM svc_mtss_team_meetings m ' +
  'LEFT JOIN hr_employees fe ON fe.id = m.facilitated_by ' +
  'LEFT JOIN platform.iam_person fp ON fp.id = fe.person_id ';

const SELECT_MEETING_STUDENT_BASE =
  'SELECT ms.id::text AS id, ms.team_meeting_id::text AS team_meeting_id, ' +
  'ms.student_id::text AS student_id, ' +
  'sip.first_name AS student_first, sip.last_name AS student_last, ' +
  'ms.tier_id::text AS tier_id, ms.outcome, ms.outcome_notes ' +
  'FROM svc_mtss_team_meeting_students ms ' +
  'JOIN sis_students s ON s.id = ms.student_id ' +
  'JOIN platform.platform_students sps ON sps.id = s.platform_student_id ' +
  'JOIN platform.iam_person sip ON sip.id = sps.person_id ';

function fullName(first: string | null, last: string | null): string | null {
  if (first && last) return first + ' ' + last;
  return null;
}

function rowToTierDto(r: TierRow): MtssTierResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    studentId: r.student_id,
    studentFirstName: r.student_first,
    studentLastName: r.student_last,
    academicYearId: r.academic_year_id,
    academicYearName: r.academic_year_name,
    tier: r.tier as MtssTier,
    domain: r.domain as MtssDomain,
    assignedById: r.assigned_by,
    assignedByName: fullName(r.assigner_first, r.assigner_last),
    assignedAt: r.assigned_at,
    reviewDate: r.review_date,
    exitDate: r.exit_date,
    exitReason: r.exit_reason,
    status: r.status as MtssTierStatus,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToMeetingStudentDto(r: MeetingStudentRow): TeamMeetingStudentResponseDto {
  return {
    id: r.id,
    teamMeetingId: r.team_meeting_id,
    studentId: r.student_id,
    studentFirstName: r.student_first,
    studentLastName: r.student_last,
    tierId: r.tier_id,
    outcome: r.outcome as MeetingOutcome | null,
    outcomeNotes: r.outcome_notes,
  };
}

function rowToMeetingDto(r: MeetingRow): TeamMeetingResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    meetingId: r.meeting_id,
    academicYearId: r.academic_year_id,
    facilitatedById: r.facilitated_by,
    facilitatedByName: fullName(r.facilitator_first, r.facilitator_last),
    meetingDate: r.meeting_date,
    notes: r.notes,
    createdAt: r.created_at,
  };
}

@Injectable()
export class MtssTierService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
    private readonly permissions: PermissionCheckService,
  ) {}

  /**
   * Counsellor scope: admin OR holds cou-001:write — same canonical
   * counsellor signal used across CaseloadService and ReferralService.
   */
  private async hasCounsellorScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'cou-001:write',
    ]);
  }

  /**
   * Visibility: admin sees school-wide. Counsellor (STAFF with
   * employeeId, no admin scope) sees only tiers for students linked to
   * their own caseloads (counselor_id = me on svc_caseloads). Anyone
   * else returns no rows — MTSS tier writes / reads are counsellor +
   * admin only at the controller gate (cou-003:read), so the only
   * STAFF callers we expect are counsellors.
   */
  private buildTierVisibility(
    actor: ResolvedActor,
    start: number,
  ): { fragment: string; params: unknown[]; consumed: number } {
    if (actor.isSchoolAdmin) return { fragment: '', params: [], consumed: 0 };
    if (actor.personType === 'STAFF' && actor.employeeId) {
      return {
        fragment:
          'AND t.student_id IN (' +
          'SELECT student_id FROM svc_caseloads WHERE counselor_id = $' +
          start +
          '::uuid' +
          ') ',
        params: [actor.employeeId],
        consumed: 1,
      };
    }
    return { fragment: 'AND FALSE ', params: [], consumed: 0 };
  }

  async list(query: ListMtssTiersQueryDto, actor: ResolvedActor): Promise<MtssTierResponseDto[]> {
    const limit = Math.min(query.limit ?? 100, 200);
    const visibility = this.buildTierVisibility(actor, 1);
    const sql: string[] = [SELECT_TIER_BASE, 'WHERE 1=1 '];
    const params: unknown[] = [...visibility.params];
    let idx = 1 + visibility.consumed;
    if (visibility.fragment) sql.push(visibility.fragment);
    if (query.tier) {
      sql.push('AND t.tier = $' + idx + ' ');
      params.push(query.tier);
      idx++;
    }
    if (query.domain) {
      sql.push('AND t.domain = $' + idx + ' ');
      params.push(query.domain);
      idx++;
    }
    if (query.status) {
      sql.push('AND t.status = $' + idx + ' ');
      params.push(query.status);
      idx++;
    }
    if (query.academicYearId) {
      sql.push('AND t.academic_year_id = $' + idx + '::uuid ');
      params.push(query.academicYearId);
      idx++;
    }
    if (query.studentId) {
      sql.push('AND t.student_id = $' + idx + '::uuid ');
      params.push(query.studentId);
      idx++;
    }
    sql.push("ORDER BY t.status = 'ACTIVE' DESC, t.assigned_at DESC ");
    sql.push('LIMIT ' + limit);
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<TierRow[]>(sql.join(''), ...params);
    });
    return rows.map(rowToTierDto);
  }

  async getById(id: string, actor: ResolvedActor): Promise<MtssTierResponseDto> {
    const visibility = this.buildTierVisibility(actor, 2);
    const sql = SELECT_TIER_BASE + 'WHERE t.id = $1::uuid ' + visibility.fragment;
    const params: unknown[] = [id, ...visibility.params];
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<TierRow[]>(sql, ...params);
    });
    if (rows.length === 0) throw new NotFoundException('MTSS tier ' + id);
    return rowToTierDto(rows[0]!);
  }

  /**
   * Admin-only school-wide tier-distribution rollup. Returns a flat
   * cells array of (tier, domain, count) for ACTIVE rows plus a
   * totalActive scalar. Drives the Step 9 dashboard panel.
   */
  async dashboard(actor: ResolvedActor): Promise<MtssDashboardDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can view the school-wide MTSS dashboard');
    }
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ tier: string; domain: string; c: number }>>(
        "SELECT tier, domain, COUNT(*)::int AS c FROM svc_mtss_tiers WHERE status='ACTIVE' GROUP BY tier, domain",
      );
    });
    const cells: MtssDashboardCellDto[] = rows.map((r) => ({
      tier: r.tier as MtssTier,
      domain: r.domain as MtssDomain,
      count: r.c,
    }));
    const totalActive = cells.reduce((s, c) => s + c.count, 0);
    return { cells, totalActive };
  }

  /**
   * Assign a new tier. Counsellor or admin only. Pre-flights the
   * partial UNIQUE keystone on `(student_id, academic_year_id,
   * domain) WHERE status='ACTIVE'` and surfaces the conflicting tier
   * id in a friendly 400. Emits svc.tier.changed on success.
   */
  async create(input: CreateMtssTierDto, actor: ResolvedActor): Promise<MtssTierResponseDto> {
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException('Only counsellors or admins can assign MTSS tiers');
    }
    if (!actor.employeeId) {
      throw new ForbiddenException('Assigning counsellor must have an employee record');
    }
    const tenant = getCurrentTenant();
    const conflict = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ id: string; tier: string }>>(
        'SELECT id::text AS id, tier FROM svc_mtss_tiers ' +
          "WHERE student_id = $1::uuid AND academic_year_id = $2::uuid AND domain = $3 AND status = 'ACTIVE' LIMIT 1",
        input.studentId,
        input.academicYearId,
        input.domain,
      );
    });
    if (conflict.length > 0) {
      throw new BadRequestException(
        'Student already has an ACTIVE ' +
          input.domain +
          ' tier (' +
          conflict[0]!.tier +
          ', id ' +
          conflict[0]!.id +
          ') for this academic year. Exit / promote / demote that tier first.',
      );
    }
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO svc_mtss_tiers (id, school_id, student_id, academic_year_id, tier, domain, ' +
            'assigned_by, assigned_at, review_date, status, notes) ' +
            "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::uuid, $8::date, $9::date, 'ACTIVE', $10)",
          id,
          tenant.schoolId,
          input.studentId,
          input.academicYearId,
          input.tier,
          input.domain,
          actor.employeeId,
          input.assignedAt,
          input.reviewDate,
          input.notes ?? null,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException(
          'A duplicate ACTIVE tier exists for this student / year / domain — concurrent assignment race',
        );
      }
      throw err;
    }
    void this.emitTierChanged(id, 'CREATED', null);
    return this.getById(id, actor);
  }

  /**
   * Update an existing tier. Locks the row inside one tx. When the
   * tier value changes, re-emits svc.tier.changed with the old + new
   * tier in the payload. Status transitions ACTIVE → EXITED /
   * PROMOTED / DEMOTED release the partial UNIQUE keystone — once
   * non-ACTIVE the row no longer participates in the keystone.
   */
  async patch(
    id: string,
    input: UpdateMtssTierDto,
    actor: ResolvedActor,
  ): Promise<MtssTierResponseDto> {
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException('Only counsellors or admins can update MTSS tiers');
    }
    let oldTier: string | null = null;
    let newTier: string | null = null;
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT tier, status FROM svc_mtss_tiers WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ tier: string; status: string }>;
      if (lockRows.length === 0) throw new NotFoundException('MTSS tier ' + id);
      oldTier = lockRows[0]!.tier;
      const updates: string[] = [];
      const params: unknown[] = [id];
      let idx = 2;
      if (input.tier !== undefined) {
        updates.push('tier = $' + idx);
        params.push(input.tier);
        idx++;
        newTier = input.tier;
      }
      if (input.status !== undefined) {
        updates.push('status = $' + idx);
        params.push(input.status);
        idx++;
      }
      if (input.reviewDate !== undefined) {
        updates.push('review_date = $' + idx + '::date');
        params.push(input.reviewDate);
        idx++;
      }
      if (input.exitDate !== undefined) {
        updates.push('exit_date = $' + idx + '::date');
        params.push(input.exitDate);
        idx++;
      }
      if (input.exitReason !== undefined) {
        updates.push('exit_reason = $' + idx);
        params.push(input.exitReason);
        idx++;
      }
      if (input.notes !== undefined) {
        updates.push('notes = $' + idx);
        params.push(input.notes);
        idx++;
      }
      if (updates.length === 0) return;
      updates.push('updated_at = now()');
      try {
        await tx.$executeRawUnsafe(
          'UPDATE svc_mtss_tiers SET ' + updates.join(', ') + ' WHERE id = $1::uuid',
          ...params,
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new BadRequestException(
            'Update would create a duplicate ACTIVE tier for this student / year / domain',
          );
        }
        throw err;
      }
    });
    if (newTier && oldTier && newTier !== oldTier) {
      void this.emitTierChanged(id, 'TIER_CHANGED', oldTier);
    } else if (input.status !== undefined) {
      void this.emitTierChanged(id, 'STATUS_CHANGED', null);
    }
    return this.getById(id, actor);
  }

  // ─── Team meetings ────────────────────────────────────────────

  async listMeetings(
    query: { fromDate?: string; toDate?: string; academicYearId?: string },
    actor: ResolvedActor,
  ): Promise<TeamMeetingResponseDto[]> {
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException('Only counsellors or admins can view MTSS team meetings');
    }
    const sql: string[] = [SELECT_MEETING_BASE, 'WHERE 1=1 '];
    const params: unknown[] = [];
    let idx = 1;
    if (query.fromDate) {
      sql.push('AND m.meeting_date >= $' + idx + '::date ');
      params.push(query.fromDate);
      idx++;
    }
    if (query.toDate) {
      sql.push('AND m.meeting_date <= $' + idx + '::date ');
      params.push(query.toDate);
      idx++;
    }
    if (query.academicYearId) {
      sql.push('AND m.academic_year_id = $' + idx + '::uuid ');
      params.push(query.academicYearId);
      idx++;
    }
    sql.push('ORDER BY m.meeting_date DESC, m.created_at DESC LIMIT 200');
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<MeetingRow[]>(sql.join(''), ...params);
    });
    return rows.map(rowToMeetingDto);
  }

  async getMeetingById(id: string, actor: ResolvedActor): Promise<TeamMeetingResponseDto> {
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException('Only counsellors or admins can view MTSS team meetings');
    }
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<MeetingRow[]>(
        SELECT_MEETING_BASE + 'WHERE m.id = $1::uuid',
        id,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Team meeting ' + id);
    const dto = rowToMeetingDto(rows[0]!);
    const studentRows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<MeetingStudentRow[]>(
        SELECT_MEETING_STUDENT_BASE +
          'WHERE ms.team_meeting_id = $1::uuid ORDER BY ms.created_at ASC',
        id,
      );
    });
    return { ...dto, students: studentRows.map(rowToMeetingStudentDto) };
  }

  async createMeeting(
    input: CreateTeamMeetingDto,
    actor: ResolvedActor,
  ): Promise<TeamMeetingResponseDto> {
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException('Only counsellors or admins can create team meetings');
    }
    if (!actor.employeeId) {
      throw new ForbiddenException('Facilitator must have an employee record');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO svc_mtss_team_meetings (id, school_id, academic_year_id, facilitated_by, meeting_date, notes) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6)',
        id,
        tenant.schoolId,
        input.academicYearId,
        actor.employeeId,
        input.meetingDate,
        input.notes ?? null,
      );
    });
    return this.getMeetingById(id, actor);
  }

  async attachMeetingStudent(
    meetingId: string,
    input: AttachTeamMeetingStudentDto,
    actor: ResolvedActor,
  ): Promise<TeamMeetingStudentResponseDto> {
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException('Only counsellors or admins can attach students to meetings');
    }
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO svc_mtss_team_meeting_students (id, team_meeting_id, student_id, tier_id, outcome, outcome_notes) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6)',
          id,
          meetingId,
          input.studentId,
          input.tierId ?? null,
          input.outcome ?? null,
          input.outcomeNotes ?? null,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException('This student is already attached to this meeting');
      }
      throw err;
    }
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<MeetingStudentRow[]>(
        SELECT_MEETING_STUDENT_BASE + 'WHERE ms.id = $1::uuid',
        id,
      );
    });
    return rowToMeetingStudentDto(rows[0]!);
  }

  // ─── Internal: Kafka emit ─────────────────────────────────────

  private async emitTierChanged(
    tierId: string,
    reason: 'CREATED' | 'TIER_CHANGED' | 'STATUS_CHANGED',
    oldTier: string | null,
  ): Promise<void> {
    try {
      // Re-read the row so the payload reflects the post-change snapshot.
      const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<TierRow[]>(
          SELECT_TIER_BASE + 'WHERE t.id = $1::uuid',
          tierId,
        );
      });
      if (rows.length === 0) return;
      const r = rows[0]!;
      const tenant = getCurrentTenant();
      void this.kafka.emit({
        topic: 'svc.tier.changed',
        key: tierId,
        sourceModule: 'counselling',
        payload: {
          tierId,
          sourceRefId: tierId,
          schoolId: tenant.schoolId,
          studentId: r.student_id,
          studentName: fullName(r.student_first, r.student_last),
          academicYearId: r.academic_year_id,
          tier: r.tier,
          domain: r.domain,
          status: r.status,
          oldTier: oldTier ?? null,
          reason,
          assignedById: r.assigned_by,
          assignedByName: fullName(r.assigner_first, r.assigner_last),
          assignedAt: r.assigned_at,
          reviewDate: r.review_date,
        },
        tenantId: tenant.schoolId,
        tenantSubdomain: tenant.subdomain,
      });
    } catch {
      // Best-effort emit per ADR-001/020 — never fail the request on a
      // broker hiccup.
    }
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e.code === 'P2010' || e.meta?.code === '23505') return true;
  if (typeof e.message === 'string' && e.message.includes('23505')) return true;
  return false;
}
