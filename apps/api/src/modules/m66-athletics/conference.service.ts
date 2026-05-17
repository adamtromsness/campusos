import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import {
  ConferenceMembershipResponseDto,
  ConferenceResponseDto,
  ConferenceScheduleResponseDto,
  CreateConferenceDto,
  CreateConferenceMembershipDto,
  CreateConferenceScheduleDto,
  UpdateConferenceDto,
} from './dto/athletics-advanced.dto';

interface ConferenceRow {
  id: string;
  name: string;
  sport: string;
  region: string | null;
  governing_body: string | null;
  is_active: boolean;
  membership_count: number;
  created_at: string;
  updated_at: string;
}

const SELECT_CONFERENCE =
  'SELECT c.id::text AS id, c.name, c.sport, c.region, c.governing_body, c.is_active, ' +
  '(SELECT count(*)::int FROM ath_conference_memberships m WHERE m.conference_id = c.id AND m.is_active) AS membership_count, ' +
  'TO_CHAR(c.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(c.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM ath_conferences c ';

interface MembershipRow {
  id: string;
  conference_id: string;
  school_id: string;
  programme_id: string;
  programme_name: string | null;
  joined_date: string;
  level: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

const SELECT_MEMBERSHIP =
  'SELECT m.id::text AS id, m.conference_id::text AS conference_id, m.school_id::text AS school_id, ' +
  'm.programme_id::text AS programme_id, p.sport_name AS programme_name, ' +
  "TO_CHAR(m.joined_date, 'YYYY-MM-DD') AS joined_date, m.level, m.is_active, " +
  'TO_CHAR(m.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(m.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM ath_conference_memberships m LEFT JOIN ath_programmes p ON p.id = m.programme_id ';

interface ScheduleRow {
  id: string;
  conference_id: string;
  season_id: string | null;
  home_school_id: string;
  away_school_id: string;
  scheduled_date: string;
  scheduled_time: string | null;
  linked_game_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_SCHEDULE =
  'SELECT id::text AS id, conference_id::text AS conference_id, season_id::text AS season_id, ' +
  'home_school_id::text AS home_school_id, away_school_id::text AS away_school_id, ' +
  "TO_CHAR(scheduled_date, 'YYYY-MM-DD') AS scheduled_date, scheduled_time::text AS scheduled_time, " +
  'linked_game_id::text AS linked_game_id, notes, ' +
  'TO_CHAR(created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM ath_conference_schedules ';

function rowToConfDto(r: ConferenceRow): ConferenceResponseDto {
  return {
    id: r.id,
    name: r.name,
    sport: r.sport,
    region: r.region,
    governingBody: r.governing_body,
    isActive: r.is_active,
    membershipCount: r.membership_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToMembershipDto(r: MembershipRow): ConferenceMembershipResponseDto {
  return {
    id: r.id,
    conferenceId: r.conference_id,
    schoolId: r.school_id,
    programmeId: r.programme_id,
    programmeName: r.programme_name,
    joinedDate: r.joined_date,
    level: r.level,
    isActive: r.is_active,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToScheduleDto(r: ScheduleRow): ConferenceScheduleResponseDto {
  let scheduledTime: string | null = null;
  if (r.scheduled_time) {
    // Postgres time::text returns "HH:MM:SS" — trim seconds for HH:MM
    scheduledTime = r.scheduled_time.length >= 5 ? r.scheduled_time.slice(0, 5) : r.scheduled_time;
  }
  return {
    id: r.id,
    conferenceId: r.conference_id,
    seasonId: r.season_id,
    homeSchoolId: r.home_school_id,
    awaySchoolId: r.away_school_id,
    scheduledDate: r.scheduled_date,
    scheduledTime,
    linkedGameId: r.linked_game_id,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

@Injectable()
export class ConferenceService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  /**
   * Local AD scope — admin OR holds ath-003:write. Authority over
   * tenant-scoped surfaces: schedules involving THIS school, membership
   * of THIS school's programmes. Per REVIEW-P2-8 BLOCKING 3 this scope
   * does NOT cover catalogue mutation or cross-school schedule creation.
   */
  async hasConferenceScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'ath-003:write',
    ]);
  }

  /**
   * REVIEW-P2-8 BLOCKING 3 — conference catalogue admin scope. The
   * `ath_conferences` rows are conceptually platform-level (the table
   * spans schools per the migration COMMENT) so a single school AD must
   * NOT be allowed to create/edit a shared conference record. Authority
   * is reserved for Platform Admin / conference administrator.
   *
   * Mirrors `hasMarketplaceAdminScope` in OfficialService — checks the
   * actor holds an admin permission at PLATFORM scope specifically.
   * School Admin's role assignments live at SCHOOL scope, only Platform
   * Admin holds an assignment at PLATFORM scope.
   */
  async hasCatalogueAdminScope(actor: ResolvedActor): Promise<boolean> {
    const platformScope = await this.permissions.resolvePlatformScope();
    if (!platformScope) return false;
    return this.permissions.hasAnyPermission(actor.accountId, platformScope, [
      'sys-001:admin',
      'ath-003:admin',
    ]);
  }

  async list(filters: {
    sport?: string;
    includeInactive?: boolean;
  }): Promise<ConferenceResponseDto[]> {
    const sql: string[] = [SELECT_CONFERENCE, 'WHERE 1=1 '];
    const params: unknown[] = [];
    if (!filters.includeInactive) {
      sql.push('AND c.is_active = true ');
    }
    if (filters.sport) {
      params.push(filters.sport);
      sql.push('AND c.sport = $' + params.length + ' ');
    }
    sql.push('ORDER BY c.sport, c.name LIMIT 200');
    const rows = await this.tenantPrisma.executeInTenantContext((client) =>
      client.$queryRawUnsafe<ConferenceRow[]>(sql.join(''), ...params),
    );
    return rows.map(rowToConfDto);
  }

  async getById(id: string): Promise<ConferenceResponseDto> {
    const rows = await this.tenantPrisma.executeInTenantContext((client) =>
      client.$queryRawUnsafe<ConferenceRow[]>(SELECT_CONFERENCE + 'WHERE c.id = $1::uuid', id),
    );
    if (rows.length === 0) throw new NotFoundException('Conference not found');
    return rowToConfDto(rows[0]!);
  }

  async create(input: CreateConferenceDto, actor: ResolvedActor): Promise<ConferenceResponseDto> {
    // REVIEW-P2-8 BLOCKING 3 — conference catalogue is conceptually
    // platform-level (cross-school). Tenant ADs cannot author a shared
    // conference record; the canonical row is reserved for Platform
    // Admin / conference administrator authority.
    if (!(await this.hasCatalogueAdminScope(actor))) {
      throw new ForbiddenException(
        'Only platform / conference admins can create conferences. The conference catalogue spans schools and is reserved for cross-school authority.',
      );
    }
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext((client) =>
        client.$executeRawUnsafe(
          'INSERT INTO ath_conferences (id, name, sport, region, governing_body) VALUES ($1::uuid, $2, $3, $4, $5)',
          id,
          input.name,
          input.sport,
          input.region ?? null,
          input.governingBody ?? null,
        ),
      );
    } catch (e) {
      const err = e as { code?: string; meta?: { code?: string } };
      if (err?.code === '23505' || err?.meta?.code === '23505') {
        throw new BadRequestException(
          'A conference named "' + input.name + '" already exists for sport ' + input.sport,
        );
      }
      throw e;
    }
    return this.getById(id);
  }

  async patch(
    id: string,
    input: UpdateConferenceDto,
    actor: ResolvedActor,
  ): Promise<ConferenceResponseDto> {
    // REVIEW-P2-8 BLOCKING 3 — same gate as create.
    if (!(await this.hasCatalogueAdminScope(actor))) {
      throw new ForbiddenException(
        'Only platform / conference admins can edit conferences. The canonical record spans schools.',
      );
    }
    await this.getById(id);
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.name !== undefined) {
      params.push(input.name);
      sets.push('name = $' + params.length);
    }
    if (input.sport !== undefined) {
      params.push(input.sport);
      sets.push('sport = $' + params.length);
    }
    if (input.region !== undefined) {
      params.push(input.region);
      sets.push('region = $' + params.length);
    }
    if (input.governingBody !== undefined) {
      params.push(input.governingBody);
      sets.push('governing_body = $' + params.length);
    }
    if (input.isActive !== undefined) {
      params.push(input.isActive);
      sets.push('is_active = $' + params.length);
    }
    if (sets.length === 0) return this.getById(id);
    sets.push('updated_at = now()');
    params.push(id);
    const sql =
      'UPDATE ath_conferences SET ' + sets.join(', ') + ' WHERE id = $' + params.length + '::uuid';
    try {
      await this.tenantPrisma.executeInTenantContext((client) =>
        client.$executeRawUnsafe(sql, ...params),
      );
    } catch (e) {
      const err = e as { code?: string; meta?: { code?: string } };
      if (err?.code === '23505' || err?.meta?.code === '23505') {
        throw new BadRequestException('A conference with that (name, sport) tuple already exists.');
      }
      throw e;
    }
    return this.getById(id);
  }

  // ── Memberships ─────────────────────────────────────────────────

  async listMemberships(conferenceId: string): Promise<ConferenceMembershipResponseDto[]> {
    await this.getById(conferenceId);
    const rows = await this.tenantPrisma.executeInTenantContext((client) =>
      client.$queryRawUnsafe<MembershipRow[]>(
        SELECT_MEMBERSHIP + 'WHERE m.conference_id = $1::uuid ORDER BY m.joined_date ASC LIMIT 500',
        conferenceId,
      ),
    );
    return rows.map(rowToMembershipDto);
  }

  async addMembership(
    conferenceId: string,
    input: CreateConferenceMembershipDto,
    actor: ResolvedActor,
  ): Promise<ConferenceMembershipResponseDto> {
    if (!(await this.hasConferenceScope(actor))) {
      throw new ForbiddenException('Only the AD or admin can add conference memberships');
    }
    const tenant = getCurrentTenant();
    await this.getById(conferenceId);
    // Validate programme exists in this school
    const prog = await this.tenantPrisma.executeInTenantContext((client) =>
      client.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id FROM ath_programmes WHERE id = $1::uuid AND school_id = $2::uuid',
        input.programmeId,
        tenant.schoolId,
      ),
    );
    if (prog.length === 0) {
      throw new BadRequestException('programmeId does not match a programme in this school');
    }
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext((client) =>
        client.$executeRawUnsafe(
          'INSERT INTO ath_conference_memberships (id, conference_id, school_id, programme_id, joined_date, level) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6)',
          id,
          conferenceId,
          tenant.schoolId,
          input.programmeId,
          input.joinedDate ?? new Date().toISOString().slice(0, 10),
          input.level ?? null,
        ),
      );
    } catch (e) {
      const err = e as { code?: string; meta?: { code?: string } };
      if (err?.code === '23505' || err?.meta?.code === '23505') {
        throw new BadRequestException(
          'This programme is already a member of this conference for this school.',
        );
      }
      throw e;
    }
    const rows = await this.tenantPrisma.executeInTenantContext((client) =>
      client.$queryRawUnsafe<MembershipRow[]>(SELECT_MEMBERSHIP + 'WHERE m.id = $1::uuid', id),
    );
    return rowToMembershipDto(rows[0]!);
  }

  // ── Schedules ───────────────────────────────────────────────────

  async listSchedule(conferenceId: string): Promise<ConferenceScheduleResponseDto[]> {
    await this.getById(conferenceId);
    const rows = await this.tenantPrisma.executeInTenantContext((client) =>
      client.$queryRawUnsafe<ScheduleRow[]>(
        SELECT_SCHEDULE + 'WHERE conference_id = $1::uuid ORDER BY scheduled_date ASC LIMIT 500',
        conferenceId,
      ),
    );
    return rows.map(rowToScheduleDto);
  }

  async addScheduleEntry(
    conferenceId: string,
    input: CreateConferenceScheduleDto,
    actor: ResolvedActor,
  ): Promise<ConferenceScheduleResponseDto> {
    if (!(await this.hasConferenceScope(actor))) {
      throw new ForbiddenException('Only the AD or admin can manage conference schedules');
    }
    await this.getById(conferenceId);
    if (input.homeSchoolId === input.awaySchoolId) {
      throw new BadRequestException('Home and away school must differ');
    }
    // REVIEW-P2-8 BLOCKING 3 — restrict cross-school schedule fabrication.
    // Tenant ADs may only schedule games involving their own school (as
    // home or away). Cross-school authority (e.g. School A scheduling
    // School B vs School C) is reserved for catalogue admin scope.
    const tenant = getCurrentTenant();
    const isCatalogueAdmin = await this.hasCatalogueAdminScope(actor);
    if (
      !isCatalogueAdmin &&
      input.homeSchoolId !== tenant.schoolId &&
      input.awaySchoolId !== tenant.schoolId
    ) {
      throw new ForbiddenException(
        'Tenant ADs can only schedule games involving their own school. Cross-school schedule authority is reserved for the conference administrator.',
      );
    }
    // Validate season belongs to the current school when supplied
    if (input.seasonId) {
      const seasonRows = (await this.tenantPrisma.executeInTenantContext((client) =>
        client.$queryRawUnsafe<Array<{ id: string }>>(
          'SELECT s.id FROM ath_seasons s JOIN ath_programmes pr ON pr.id = s.programme_id WHERE s.id = $1::uuid AND pr.school_id = $2::uuid',
          input.seasonId,
          tenant.schoolId,
        ),
      )) as Array<{ id: string }>;
      if (seasonRows.length === 0) {
        throw new BadRequestException('seasonId does not match a season in this school');
      }
    }
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext((client) =>
      client.$executeRawUnsafe(
        'INSERT INTO ath_conference_schedules (id, conference_id, season_id, home_school_id, away_school_id, scheduled_date, scheduled_time, notes) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::date, $7::time, $8)',
        id,
        conferenceId,
        input.seasonId ?? null,
        input.homeSchoolId,
        input.awaySchoolId,
        input.scheduledDate,
        input.scheduledTime ?? null,
        input.notes ?? null,
      ),
    );
    const rows = await this.tenantPrisma.executeInTenantContext((client) =>
      client.$queryRawUnsafe<ScheduleRow[]>(SELECT_SCHEDULE + 'WHERE id = $1::uuid', id),
    );
    return rowToScheduleDto(rows[0]!);
  }
}
