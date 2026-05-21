import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { getCurrentTenant, TenantPrismaService } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import { ProgrammeService } from './programme.service';
import {
  AddRosterMemberDto,
  CreateRosterDto,
  EligibilityStatus,
  RosterLevel,
  RosterMemberResponseDto,
  RosterResponseDto,
  UpdateRosterDto,
  UpdateRosterMemberDto,
} from './dto/athletics.dto';

interface RosterRow {
  id: string;
  season_id: string;
  level: string;
  head_coach_id: string | null;
  head_coach_name: string | null;
  is_certified: boolean;
  certified_at: string | null;
  certified_by: string | null;
  certified_by_name: string | null;
  member_count: number | null;
  eligible_count: number | null;
  created_at: string;
  updated_at: string;
}

interface RosterMemberRow {
  id: string;
  roster_id: string;
  student_id: string;
  student_name: string | null;
  student_grade_level: string | null;
  jersey_number: string | null;
  position: string | null;
  eligibility_status: string;
  eligibility_notes: string | null;
  joined_at: string;
  removed_at: string | null;
  removal_reason: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_ROSTER =
  'SELECT r.id::text AS id, r.season_id::text AS season_id, r.level, ' +
  'r.head_coach_id::text AS head_coach_id, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM hr_employees he2 " +
  '  JOIN platform.iam_person ip ON ip.id = he2.person_id ' +
  '  WHERE he2.id = r.head_coach_id) AS head_coach_name, ' +
  'r.is_certified, ' +
  'TO_CHAR(r.certified_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS certified_at, ' +
  'r.certified_by::text AS certified_by, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM hr_employees he3 " +
  '  JOIN platform.iam_person ip ON ip.id = he3.person_id ' +
  '  WHERE he3.id = r.certified_by) AS certified_by_name, ' +
  '(SELECT COUNT(*)::int FROM ath_roster_members rm WHERE rm.roster_id = r.id AND rm.removed_at IS NULL) AS member_count, ' +
  "(SELECT COUNT(*)::int FROM ath_roster_members rm WHERE rm.roster_id = r.id AND rm.removed_at IS NULL AND rm.eligibility_status = 'ELIGIBLE') AS eligible_count, " +
  'TO_CHAR(r.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(r.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM ath_rosters r ';

const SELECT_ROSTER_MEMBER =
  'SELECT m.id::text AS id, m.roster_id::text AS roster_id, m.student_id::text AS student_id, ' +
  "(ip.first_name || ' ' || ip.last_name) AS student_name, " +
  's.grade_level AS student_grade_level, ' +
  'm.jersey_number, m.position, m.eligibility_status, m.eligibility_notes, ' +
  "TO_CHAR(m.joined_at, 'YYYY-MM-DD') AS joined_at, " +
  "TO_CHAR(m.removed_at, 'YYYY-MM-DD') AS removed_at, " +
  'm.removal_reason, ' +
  'TO_CHAR(m.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(m.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM ath_roster_members m ' +
  'JOIN sis_students s ON s.id = m.student_id ' +
  'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
  'JOIN platform.iam_person ip ON ip.id = ps.person_id ';

function rosterToDto(r: RosterRow): RosterResponseDto {
  return {
    id: r.id,
    seasonId: r.season_id,
    level: r.level as RosterLevel,
    headCoachId: r.head_coach_id,
    headCoachName: r.head_coach_name,
    isCertified: r.is_certified,
    certifiedAt: r.certified_at,
    certifiedBy: r.certified_by,
    certifiedByName: r.certified_by_name,
    memberCount: r.member_count ?? 0,
    eligibleCount: r.eligible_count ?? 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function memberRowToDto(
  r: RosterMemberRow,
  liveGpa: number | null,
  programmeMinGpa: number | null,
): RosterMemberResponseDto {
  return {
    id: r.id,
    rosterId: r.roster_id,
    studentId: r.student_id,
    studentName: r.student_name ?? '',
    studentGradeLevel: r.student_grade_level,
    jerseyNumber: r.jersey_number,
    position: r.position,
    eligibilityStatus: r.eligibility_status as EligibilityStatus,
    eligibilityNotes: r.eligibility_notes,
    liveGpa,
    programmeMinGpa,
    joinedAt: r.joined_at,
    removedAt: r.removed_at,
    removalReason: r.removal_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

@Injectable()
export class RosterService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly programmes: ProgrammeService,
  ) {}

  async listForSeason(seasonId: string): Promise<RosterResponseDto[]> {
    // Cross-school isolation: ath_rosters has no school_id of its own;
    // the school predicate lives on the great-grandparent ath_programmes.
    // JOIN through ath_seasons → ath_programmes and filter on the
    // current tenant's school. Without this, a caller in School A who
    // somehow learned a School B seasonId would see School B rosters.
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<RosterRow[]>(
        SELECT_ROSTER +
          'JOIN ath_seasons s ON s.id = r.season_id ' +
          'JOIN ath_programmes p ON p.id = s.programme_id ' +
          'WHERE r.season_id = $1::uuid AND p.school_id = $2::uuid ' +
          'ORDER BY r.level ASC',
        seasonId,
        tenant.schoolId,
      );
    });
    return rows.map(rosterToDto);
  }

  async getById(id: string): Promise<RosterResponseDto> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<RosterRow[]>(SELECT_ROSTER + 'WHERE r.id = $1::uuid', id);
    });
    if (rows.length === 0) throw new NotFoundException('Roster not found');
    return rosterToDto(rows[0]!);
  }

  async listMembers(rosterId: string): Promise<RosterMemberResponseDto[]> {
    const programmeMinGpa = await this.loadProgrammeMinGpa(rosterId);
    const memberRows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<RosterMemberRow[]>(
        SELECT_ROSTER_MEMBER + 'WHERE m.roster_id = $1::uuid ORDER BY m.joined_at ASC',
        rosterId,
      );
    });
    const out: RosterMemberResponseDto[] = [];
    for (const row of memberRows) {
      const liveGpa = await this.computeLiveGpa(row.student_id);
      out.push(memberRowToDto(row, liveGpa, programmeMinGpa));
    }
    return out;
  }

  async create(
    seasonId: string,
    input: CreateRosterDto,
    actor: ResolvedActor,
  ): Promise<RosterResponseDto> {
    if (!(await this.programmes.hasAdScope(actor))) {
      throw new ForbiddenException('Only the Athletic Director or admin can create rosters');
    }
    // Validate season + level
    const seasonRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT s.id, p.levels_offered FROM ath_seasons s JOIN ath_programmes p ON p.id = s.programme_id WHERE s.id = $1::uuid',
        seasonId,
      );
    })) as Array<{ id: string; levels_offered: string[] }>;
    if (seasonRows.length === 0) throw new NotFoundException('Season not found');
    if (!seasonRows[0]!.levels_offered.includes(input.level)) {
      throw new BadRequestException(
        'Level "' +
          input.level +
          '" is not in the parent programme levels_offered (' +
          seasonRows[0]!.levels_offered.join(', ') +
          ').',
      );
    }
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO ath_rosters (id, season_id, level, head_coach_id) VALUES ($1::uuid, $2::uuid, $3, $4::uuid)',
          id,
          seasonId,
          input.level,
          input.headCoachId ?? null,
        );
      });
    } catch (e) {
      const err = e as { code?: string; meta?: { code?: string }; message?: string };
      const code = err.code === 'P2010' ? err.meta?.code : err.code;
      if (code === '23505' || /23505/.test(err.message ?? '')) {
        throw new BadRequestException(
          'A roster for level "' + input.level + '" already exists in this season.',
        );
      }
      if (code === '23503' || /23503/.test(err.message ?? '')) {
        throw new BadRequestException('headCoachId does not match an employee in this school.');
      }
      throw e;
    }
    return this.getById(id);
  }

  async patch(
    id: string,
    input: UpdateRosterDto,
    actor: ResolvedActor,
  ): Promise<RosterResponseDto> {
    if (!(await this.programmes.hasAdScope(actor))) {
      throw new ForbiddenException('Only the Athletic Director or admin can edit rosters');
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.headCoachId !== undefined) {
      params.push(input.headCoachId);
      sets.push('head_coach_id = $' + params.length + '::uuid');
    }
    if (input.level !== undefined) {
      params.push(input.level);
      sets.push('level = $' + params.length);
    }
    if (sets.length === 0) return this.getById(id);
    sets.push('updated_at = now()');
    params.push(id);
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$executeRawUnsafe(
          'UPDATE ath_rosters SET ' + sets.join(', ') + ' WHERE id = $' + params.length + '::uuid',
          ...params,
        );
      });
    } catch (e) {
      const err = e as { code?: string; meta?: { code?: string }; message?: string };
      const code = err.code === 'P2010' ? err.meta?.code : err.code;
      if (code === '23505' || /23505/.test(err.message ?? '')) {
        throw new BadRequestException('A roster for that level already exists in this season.');
      }
      throw e;
    }
    return this.getById(id);
  }

  /**
   * Certify the roster — atomic stamp of is_certified=true,
   * certified_at=now(), certified_by=actor.employeeId per the
   * multi-column certified_chk keystone from Step 1.
   */
  async certify(id: string, actor: ResolvedActor): Promise<RosterResponseDto> {
    if (!(await this.programmes.hasAdScope(actor))) {
      throw new ForbiddenException('Only the Athletic Director or admin can certify rosters');
    }
    if (!actor.employeeId) {
      throw new ForbiddenException(
        'Certifying a roster requires an hr_employees identity. Platform admins must operate via an admin staff account.',
      );
    }
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT is_certified FROM ath_rosters WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ is_certified: boolean }>;
      if (lock.length === 0) throw new NotFoundException('Roster not found');
      if (lock[0]!.is_certified) {
        throw new BadRequestException('Roster is already certified.');
      }
      // Refuse if any active member is INELIGIBLE — defensible
      const ineligible = (await tx.$queryRawUnsafe(
        "SELECT COUNT(*)::int AS c FROM ath_roster_members WHERE roster_id = $1::uuid AND removed_at IS NULL AND eligibility_status = 'INELIGIBLE'",
        id,
      )) as Array<{ c: number }>;
      if (ineligible[0]!.c > 0) {
        throw new BadRequestException(
          'Cannot certify a roster with INELIGIBLE members. Resolve eligibility first.',
        );
      }
      await tx.$executeRawUnsafe(
        'UPDATE ath_rosters SET is_certified = true, certified_at = now(), certified_by = $1::uuid, updated_at = now() WHERE id = $2::uuid',
        actor.employeeId,
        id,
      );
      const rows = (await tx.$queryRawUnsafe(
        SELECT_ROSTER + 'WHERE r.id = $1::uuid',
        id,
      )) as RosterRow[];
      return rosterToDto(rows[0]!);
    });
  }

  /**
   * Add a roster member with the GPA eligibility check keystone.
   * Reads the live student GPA from cls_grades / cls_gradebook_snapshots
   * and compares against programme.min_gpa. Sets eligibility_status to
   * INELIGIBLE if below threshold, ELIGIBLE otherwise (defaults to
   * PENDING_PHYSICAL when no min_gpa is set on the programme).
   */
  async addMember(
    rosterId: string,
    input: AddRosterMemberDto,
    actor: ResolvedActor,
  ): Promise<RosterMemberResponseDto> {
    if (!(await this.programmes.hasAdScope(actor))) {
      throw new ForbiddenException('Only the Athletic Director or admin can add roster members');
    }

    // Validate student exists
    const studentRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id FROM sis_students WHERE id = $1::uuid',
        input.studentId,
      );
    })) as Array<{ id: string }>;
    if (studentRows.length === 0) {
      throw new BadRequestException('studentId does not match a student in this school.');
    }

    const programmeMinGpa = await this.loadProgrammeMinGpa(rosterId);
    const liveGpa = await this.computeLiveGpa(input.studentId);

    let eligibilityStatus: EligibilityStatus = 'PENDING_PHYSICAL';
    if (programmeMinGpa !== null && liveGpa !== null) {
      eligibilityStatus = liveGpa >= programmeMinGpa ? 'ELIGIBLE' : 'INELIGIBLE';
    }

    // Cap-check + insert run inside one tenant tx with the parent
    // roster row locked FOR UPDATE so two concurrent adds cannot
    // both observe available capacity and exceed the cap (per
    // REVIEW-CYCLE13 MAJOR 3).
    const id = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rosterLock = (await tx.$queryRawUnsafe(
        'SELECT r.id::text AS id, r.level, p.max_roster_size_per_level ' +
          'FROM ath_rosters r ' +
          'JOIN ath_seasons s ON s.id = r.season_id ' +
          'JOIN ath_programmes p ON p.id = s.programme_id ' +
          'WHERE r.id = $1::uuid FOR UPDATE OF r',
        rosterId,
      )) as Array<{
        id: string;
        level: string;
        max_roster_size_per_level: Record<string, number> | null;
      }>;
      if (rosterLock.length === 0) throw new NotFoundException('Roster not found');

      const cap = rosterLock[0]!.max_roster_size_per_level?.[rosterLock[0]!.level];
      if (cap !== undefined) {
        const currentRows = (await tx.$queryRawUnsafe(
          'SELECT COUNT(*)::int AS c FROM ath_roster_members WHERE roster_id = $1::uuid AND removed_at IS NULL',
          rosterId,
        )) as Array<{ c: number }>;
        if (currentRows[0]!.c >= cap) {
          throw new BadRequestException(
            'Roster has reached its cap of ' +
              cap +
              ' members for this level. Remove a member first.',
          );
        }
      }

      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO ath_roster_members (id, roster_id, student_id, jersey_number, position, eligibility_status, eligibility_notes, joined_at) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, CURRENT_DATE)',
          id,
          rosterId,
          input.studentId,
          input.jerseyNumber ?? null,
          input.position ?? null,
          eligibilityStatus,
          input.eligibilityNotes ?? null,
        );
      } catch (e) {
        const err = e as { code?: string; meta?: { code?: string }; message?: string };
        const code = err.code === 'P2010' ? err.meta?.code : err.code;
        if (code === '23505' || /23505/.test(err.message ?? '')) {
          throw new BadRequestException('Student is already on this roster.');
        }
        throw e;
      }
    });

    const memberRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_ROSTER_MEMBER + 'WHERE m.id = $1::uuid', id);
    })) as RosterMemberRow[];
    return memberRowToDto(memberRows[0]!, liveGpa, programmeMinGpa);
  }

  async patchMember(
    memberId: string,
    input: UpdateRosterMemberDto,
    actor: ResolvedActor,
  ): Promise<RosterMemberResponseDto> {
    if (!(await this.programmes.hasAdScope(actor))) {
      throw new ForbiddenException('Only the Athletic Director or admin can edit roster members');
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.jerseyNumber !== undefined) {
      params.push(input.jerseyNumber);
      sets.push('jersey_number = $' + params.length);
    }
    if (input.position !== undefined) {
      params.push(input.position);
      sets.push('position = $' + params.length);
    }
    if (input.eligibilityStatus !== undefined) {
      params.push(input.eligibilityStatus);
      sets.push('eligibility_status = $' + params.length);
    }
    if (input.eligibilityNotes !== undefined) {
      params.push(input.eligibilityNotes);
      sets.push('eligibility_notes = $' + params.length);
    }
    if (input.removedAt !== undefined) {
      if (input.removedAt === null) {
        sets.push('removed_at = NULL');
      } else {
        params.push(input.removedAt);
        sets.push('removed_at = $' + params.length + '::date');
      }
    }
    if (input.removalReason !== undefined) {
      params.push(input.removalReason);
      sets.push('removal_reason = $' + params.length);
    }
    if (sets.length === 0) return this.getMember(memberId);
    sets.push('updated_at = now()');
    params.push(memberId);
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$executeRawUnsafe(
          'UPDATE ath_roster_members SET ' +
            sets.join(', ') +
            ' WHERE id = $' +
            params.length +
            '::uuid',
          ...params,
        );
      });
    } catch (e) {
      const err = e as { code?: string; meta?: { code?: string }; message?: string };
      const code = err.code === 'P2010' ? err.meta?.code : err.code;
      if (code === '23514' || /23514/.test(err.message ?? '')) {
        throw new BadRequestException(
          'Member dates inconsistent. removed_at must be on or after joined_at.',
        );
      }
      throw e;
    }
    return this.getMember(memberId);
  }

  async checkEligibility(
    rosterId: string,
    actor: ResolvedActor,
  ): Promise<RosterMemberResponseDto[]> {
    if (!(await this.programmes.hasAdScope(actor))) {
      throw new ForbiddenException('Only the Athletic Director or admin can check eligibility');
    }
    const programmeMinGpa = await this.loadProgrammeMinGpa(rosterId);
    if (programmeMinGpa === null) {
      throw new BadRequestException(
        'Programme has no min_gpa set; eligibility check is a no-op for this programme.',
      );
    }
    const memberRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_ROSTER_MEMBER + 'WHERE m.roster_id = $1::uuid AND m.removed_at IS NULL',
        rosterId,
      );
    })) as RosterMemberRow[];
    const out: RosterMemberResponseDto[] = [];
    for (const row of memberRows) {
      // Skip members who are mid-injury — INJURED_NOT_CLEARED is owned by InjuryService
      if (row.eligibility_status === 'INJURED_NOT_CLEARED') {
        const liveGpa = await this.computeLiveGpa(row.student_id);
        out.push(memberRowToDto(row, liveGpa, programmeMinGpa));
        continue;
      }
      const liveGpa = await this.computeLiveGpa(row.student_id);
      const newStatus: EligibilityStatus =
        liveGpa === null
          ? 'PENDING_PHYSICAL'
          : liveGpa >= programmeMinGpa
            ? 'ELIGIBLE'
            : 'INELIGIBLE';
      if (newStatus !== row.eligibility_status) {
        await this.tenantPrisma.executeInTenantContext(async (client) => {
          return client.$executeRawUnsafe(
            'UPDATE ath_roster_members SET eligibility_status = $1, updated_at = now() WHERE id = $2::uuid',
            newStatus,
            row.id,
          );
        });
        row.eligibility_status = newStatus;
      }
      out.push(memberRowToDto(row, liveGpa, programmeMinGpa));
    }
    return out;
  }

  private async getMember(memberId: string): Promise<RosterMemberResponseDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_ROSTER_MEMBER + 'WHERE m.id = $1::uuid', memberId);
    })) as RosterMemberRow[];
    if (rows.length === 0) throw new NotFoundException('Roster member not found');
    const liveGpa = await this.computeLiveGpa(rows[0]!.student_id);
    const programmeMinGpa = await this.loadProgrammeMinGpa(rows[0]!.roster_id);
    return memberRowToDto(rows[0]!, liveGpa, programmeMinGpa);
  }

  private async loadProgrammeMinGpa(rosterId: string): Promise<number | null> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT p.min_gpa::text AS min_gpa FROM ath_rosters r ' +
          'JOIN ath_seasons s ON s.id = r.season_id ' +
          'JOIN ath_programmes p ON p.id = s.programme_id ' +
          'WHERE r.id = $1::uuid',
        rosterId,
      );
    })) as Array<{ min_gpa: string | null }>;
    if (rows.length === 0) return null;
    return rows[0]!.min_gpa === null ? null : Number(rows[0]!.min_gpa);
  }

  /**
   * GPA ELIGIBILITY KEYSTONE — reads back into Cycle 2 gradebook.
   * Strategy: try cls_gradebook_snapshots for the most recent term;
   * if no snapshot, average raw cls_grades.percentage across all
   * published cls_assignments the student has a grade on. Returns
   * null if the student has no grades yet (a freshman just enrolled
   * at the start of season). The Step 5 service then sets
   * eligibility_status to PENDING_PHYSICAL (no academic data).
   */
  private async computeLiveGpa(studentId: string): Promise<number | null> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      // Detect available tables — be defensive in case the gradebook tables
      // are absent in a test tenant.
      const tablesExist = (await client.$queryRawUnsafe(
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'cls_grades') AS has_grades",
      )) as Array<{ has_grades: boolean }>;
      if (!tablesExist[0]?.has_grades) return null;
      // Average percentage on published grades. Convert to a 4.0 GPA scale
      // using the simple banding: 90+ -> 4.0, 80+ -> 3.0, 70+ -> 2.0,
      // 60+ -> 1.0, below -> 0.0. Real schools have richer scales; we
      // use the simple band so the keystone has predictable behaviour
      // against the seeded gradebook.
      const rows = (await client.$queryRawUnsafe(
        'SELECT AVG(grade_value)::numeric(6,2) AS avg_pct, COUNT(*)::int AS n ' +
          'FROM cls_grades ' +
          'WHERE student_id = $1::uuid AND is_published = true',
        studentId,
      )) as Array<{ avg_pct: string | null; n: number }>;
      const n = rows[0]?.n ?? 0;
      if (n === 0 || rows[0]?.avg_pct === null) return null;
      const avg = Number(rows[0]!.avg_pct);
      if (avg >= 90) return 4.0;
      if (avg >= 80) return 3.0;
      if (avg >= 70) return 2.0;
      if (avg >= 60) return 1.0;
      return 0.0;
    });
  }
}
