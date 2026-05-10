import { createHash } from 'node:crypto';
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
import { OutboxService } from '../kafka/outbox.service';

/**
 * REVIEW-P2-8 BLOCKING 5 — deterministic event_id helper for the
 * official-assignment completion outbox emit.
 */
export function deterministicAssignmentCompletedEventId(assignmentId: string): string {
  const hash = createHash('sha1')
    .update(assignmentId + ':ath.official.assignment.completed:v1')
    .digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return (
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-' +
    hex.slice(12, 16) +
    '-' +
    hex.slice(16, 20) +
    '-' +
    hex.slice(20, 32)
  );
}
import {
  CreateOfficialAssignmentDto,
  CreateOfficialAvailabilityDto,
  CreateOfficialProfileDto,
  CreateOfficialRatingDto,
  OfficialAssignmentResponseDto,
  OfficialAssignmentStatus,
  OfficialAvailabilityResponseDto,
  OfficialPaymentStatus,
  OfficialProfileResponseDto,
  OfficialRatingResponseDto,
  OfficialRole,
  RaterType,
  TransitionOfficialAssignmentDto,
  UpdateOfficialProfileDto,
} from './dto/athletics-advanced.dto';

interface AssignmentRow {
  id: string;
  game_id: string;
  official_profile_id: string;
  role: string;
  fee: string;
  status: string;
  payment_status: string;
  accepted_at: string | null;
  confirmed_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  notes: string | null;
  assigned_by: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_ASSIGNMENT =
  'SELECT id::text AS id, game_id::text AS game_id, official_profile_id::text AS official_profile_id, ' +
  'role, fee::text AS fee, status, payment_status, ' +
  'TO_CHAR(accepted_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS accepted_at, ' +
  'TO_CHAR(confirmed_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS confirmed_at, ' +
  'TO_CHAR(completed_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS completed_at, ' +
  'TO_CHAR(cancelled_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS cancelled_at, ' +
  'cancellation_reason, notes, assigned_by::text AS assigned_by, ' +
  'TO_CHAR(created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM ath_official_assignments ';

interface RatingRow {
  id: string;
  assignment_id: string;
  rater_type: string;
  professionalism: number | null;
  knowledge: number | null;
  communication: number | null;
  punctuality: number | null;
  overall: number;
  comments: string | null;
  rated_by: string | null;
  rated_at: string;
  created_at: string;
  updated_at: string;
}

const SELECT_RATING =
  'SELECT id::text AS id, assignment_id::text AS assignment_id, rater_type, ' +
  'professionalism, knowledge, communication, punctuality, overall, comments, ' +
  'rated_by::text AS rated_by, ' +
  'TO_CHAR(rated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS rated_at, ' +
  'TO_CHAR(created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM ath_official_ratings ';

interface OfficialProfileRow {
  id: string;
  person_id: string;
  person_name: string | null;
  sports: string[];
  certification_level: string | null;
  certification_body: string | null;
  certification_expiry: string | null;
  years_experience: number | null;
  max_travel_miles: number | null;
  base_fee: string | null;
  is_available: boolean;
  bio: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  created_at: string;
  updated_at: string;
  average_overall: string | null;
  rating_count: number;
}

interface AvailabilityRow {
  id: string;
  official_profile_id: string;
  available_date: string;
  start_time: string | null;
  end_time: string | null;
  is_available: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

function rowToAssignmentDto(
  r: AssignmentRow,
  officialName: string | null,
): OfficialAssignmentResponseDto {
  return {
    id: r.id,
    gameId: r.game_id,
    officialProfileId: r.official_profile_id,
    officialName,
    role: r.role as OfficialRole,
    fee: Number(r.fee),
    status: r.status as OfficialAssignmentStatus,
    paymentStatus: r.payment_status as OfficialPaymentStatus,
    acceptedAt: r.accepted_at,
    confirmedAt: r.confirmed_at,
    completedAt: r.completed_at,
    cancelledAt: r.cancelled_at,
    cancellationReason: r.cancellation_reason,
    notes: r.notes,
    assignedBy: r.assigned_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToRatingDto(r: RatingRow): OfficialRatingResponseDto {
  return {
    id: r.id,
    assignmentId: r.assignment_id,
    raterType: r.rater_type as RaterType,
    professionalism: r.professionalism,
    knowledge: r.knowledge,
    communication: r.communication,
    punctuality: r.punctuality,
    overall: r.overall,
    comments: r.comments,
    ratedBy: r.rated_by,
    ratedAt: r.rated_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

@Injectable()
export class OfficialService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,

    private readonly outbox: OutboxService,
  ) {}

  /**
   * Local AD scope — admin OR holds ath-003:write. Authority over
   * tenant-scoped surfaces: assignment posting, lifecycle transitions,
   * ratings. Per REVIEW-P2-8 BLOCKING 6 this scope does NOT cover
   * canonical platform-official-profile mutation — `hasMarketplaceAdminScope`
   * is the gate for that.
   */
  async hasOfficialAdminScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'ath-003:write',
    ]);
  }

  /**
   * REVIEW-P2-8 BLOCKING 6 — platform marketplace admin scope. Officials
   * are portable across schools (ADR-063) so their canonical profile +
   * availability rows in `platform.platform_official_profiles` are
   * platform-level data. A tenant AD must NOT be allowed to mutate the
   * shared official's certification, base fee, sports list, or
   * availability — that authority is reserved for Platform Admin /
   * marketplace administrator.
   *
   * Verified by checking the actor holds an admin permission at
   * PLATFORM scope specifically (not the school scope chain). School
   * Admin's role assignments live at SCHOOL scope; only Platform Admin
   * holds an assignment at PLATFORM scope. The Cycle 31 BLOCKING 2 helper
   * `resolvePlatformScope()` is the load-bearing primitive.
   *
   * Today only Platform Admin holds this authority. A future dedicated
   * marketplace-admin role can be added at PLATFORM scope once the
   * official-self-service onboarding path lands.
   */
  async hasMarketplaceAdminScope(actor: ResolvedActor): Promise<boolean> {
    const platformScope = await this.permissions.resolvePlatformScope();
    if (!platformScope) return false;
    return this.permissions.hasAnyPermission(actor.accountId, platformScope, [
      'sys-001:admin',
      'ath-003:admin',
    ]);
  }

  // ── Platform-schema profile management ──────────────────────────

  /**
   * REVIEW-P2-8 MAJOR 3 — strip contact fields for readers without
   * assignment authority. Direct contact (email + phone) is exposed
   * only to ath-003:write holders + admins. Non-admin browse-only
   * readers (other school staff with ath-003:read) get the public
   * marketplace shape: certification + sports + base fee + bio +
   * average rating, but not direct contact details.
   */
  private async stripContactsIfNeeded(
    actor: ResolvedActor | undefined,
    dto: OfficialProfileResponseDto,
  ): Promise<OfficialProfileResponseDto> {
    if (!actor) return { ...dto, contactEmail: null, contactPhone: null };
    const hasAssignmentAuthority = await this.hasOfficialAdminScope(actor);
    if (hasAssignmentAuthority) return dto;
    return { ...dto, contactEmail: null, contactPhone: null };
  }

  async listProfiles(
    filters: {
      sport?: string;
      isAvailable?: boolean;
      availableDate?: string;
      search?: string;
    },
    actor?: ResolvedActor,
  ): Promise<OfficialProfileResponseDto[]> {
    const platform = this.tenantPrisma.getPlatformClient();
    const sql: string[] = [
      'SELECT op.id::text AS id, op.person_id::text AS person_id, ',
      "(p.first_name || ' ' || p.last_name) AS person_name, ",
      'op.sports, op.certification_level, op.certification_body, ',
      "TO_CHAR(op.certification_expiry, 'YYYY-MM-DD') AS certification_expiry, ",
      'op.years_experience, op.max_travel_miles, op.base_fee::text AS base_fee, ',
      'op.is_available, op.bio, op.contact_email, op.contact_phone, ',
      'TO_CHAR(op.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ',
      'TO_CHAR(op.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at, ',
      'NULL::text AS average_overall, 0::int AS rating_count ',
      'FROM platform.platform_official_profiles op ',
      'LEFT JOIN platform.iam_person p ON p.id = op.person_id ',
      'WHERE 1=1 ',
    ];
    const params: unknown[] = [];
    if (filters.sport) {
      params.push(filters.sport);
      sql.push('AND op.sports @> ARRAY[$' + params.length + '::text] ');
    }
    if (filters.isAvailable !== undefined) {
      params.push(filters.isAvailable);
      sql.push('AND op.is_available = $' + params.length + ' ');
    }
    if (filters.availableDate) {
      params.push(filters.availableDate);
      sql.push(
        'AND EXISTS (SELECT 1 FROM platform.platform_official_availability oa WHERE oa.official_profile_id = op.id AND oa.available_date = $' +
          params.length +
          '::date AND oa.is_available = true) ',
      );
    }
    if (filters.search) {
      params.push('%' + filters.search.toLowerCase() + '%');
      sql.push(
        "AND (LOWER(p.first_name || ' ' || p.last_name) LIKE $" +
          params.length +
          ' OR LOWER(op.bio) LIKE $' +
          params.length +
          ') ',
      );
    }
    sql.push('ORDER BY op.is_available DESC, p.last_name ASC LIMIT 200');
    const rows = (await platform.$queryRawUnsafe(sql.join(''), ...params)) as OfficialProfileRow[];
    const dtos = rows.map((r) => this.profileRowToDto(r));
    const stripped = await Promise.all(dtos.map((d) => this.stripContactsIfNeeded(actor, d)));
    return stripped;
  }

  async getProfileById(id: string, actor?: ResolvedActor): Promise<OfficialProfileResponseDto> {
    const platform = this.tenantPrisma.getPlatformClient();
    const rows = (await platform.$queryRawUnsafe(
      'SELECT op.id::text AS id, op.person_id::text AS person_id, ' +
        "(p.first_name || ' ' || p.last_name) AS person_name, " +
        'op.sports, op.certification_level, op.certification_body, ' +
        "TO_CHAR(op.certification_expiry, 'YYYY-MM-DD') AS certification_expiry, " +
        'op.years_experience, op.max_travel_miles, op.base_fee::text AS base_fee, ' +
        'op.is_available, op.bio, op.contact_email, op.contact_phone, ' +
        'TO_CHAR(op.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
        'TO_CHAR(op.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at, ' +
        'NULL::text AS average_overall, 0::int AS rating_count ' +
        'FROM platform.platform_official_profiles op ' +
        'LEFT JOIN platform.iam_person p ON p.id = op.person_id ' +
        'WHERE op.id = $1::uuid',
      id,
    )) as OfficialProfileRow[];
    if (rows.length === 0) throw new NotFoundException('Official profile not found');
    const dto = this.profileRowToDto(rows[0]!);
    // Compute average rating across all tenants by walking ratings within this tenant only.
    const tenant = getCurrentTenant();
    const ratingRows = (await this.tenantPrisma.executeInTenantContext((client) =>
      (
        client as { $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T> }
      ).$queryRawUnsafe<Array<{ avg: string | null; cnt: number }>>(
        'SELECT AVG(r.overall)::text AS avg, COUNT(*)::int AS cnt FROM ath_official_ratings r ' +
          'JOIN ath_official_assignments a ON a.id = r.assignment_id ' +
          "WHERE a.official_profile_id = $1::uuid AND r.rater_type = 'SCHOOL_RATES_OFFICIAL'",
        id,
      ),
    )) as Array<{ avg: string | null; cnt: number }>;
    if (ratingRows[0]) {
      dto.averageOverallRating = ratingRows[0].avg === null ? null : Number(ratingRows[0].avg);
      dto.ratingCount = Number(ratingRows[0].cnt);
    }
    void tenant;
    return this.stripContactsIfNeeded(actor, dto);
  }

  private profileRowToDto(r: OfficialProfileRow): OfficialProfileResponseDto {
    return {
      id: r.id,
      personId: r.person_id,
      personName: r.person_name,
      sports: r.sports,
      certificationLevel: r.certification_level,
      certificationBody: r.certification_body,
      certificationExpiry: r.certification_expiry,
      yearsExperience: r.years_experience,
      maxTravelMiles: r.max_travel_miles,
      baseFee: r.base_fee === null ? null : Number(r.base_fee),
      isAvailable: r.is_available,
      bio: r.bio,
      contactEmail: r.contact_email,
      contactPhone: r.contact_phone,
      averageOverallRating: r.average_overall === null ? null : Number(r.average_overall),
      ratingCount: r.rating_count,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  async createProfile(
    input: CreateOfficialProfileDto,
    actor: ResolvedActor,
  ): Promise<OfficialProfileResponseDto> {
    // REVIEW-P2-8 BLOCKING 6 — official profiles live in the platform
    // schema and are shared across schools (ADR-063). Tenant ADs must
    // NOT be allowed to mutate the canonical record. Only platform
    // marketplace admin / Platform Admin can create an official profile.
    if (!(await this.hasMarketplaceAdminScope(actor))) {
      throw new ForbiddenException(
        'Only platform marketplace admins can create official profiles. School ADs can post assignments + submit ratings under ath-003:write but cannot mutate the canonical platform record.',
      );
    }
    if (input.sports.length === 0) {
      throw new BadRequestException('sports must contain at least one entry');
    }
    const platform = this.tenantPrisma.getPlatformClient();
    // UNIQUE(person_id) — surface friendly 400 on collision
    const existing = (await platform.$queryRawUnsafe(
      'SELECT id::text AS id FROM platform.platform_official_profiles WHERE person_id = $1::uuid',
      input.personId,
    )) as Array<{ id: string }>;
    if (existing.length > 0) {
      throw new BadRequestException(
        'Official profile already exists for this person (' + existing[0]!.id + ')',
      );
    }
    const id = generateId();
    await platform.$executeRawUnsafe(
      'INSERT INTO platform.platform_official_profiles (id, person_id, sports, certification_level, certification_body, certification_expiry, years_experience, max_travel_miles, base_fee, is_available, bio, contact_email, contact_phone) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::date, $7, $8, $9, $10, $11, $12, $13)',
      id,
      input.personId,
      input.sports,
      input.certificationLevel ?? null,
      input.certificationBody ?? null,
      input.certificationExpiry ?? null,
      input.yearsExperience ?? null,
      input.maxTravelMiles ?? null,
      input.baseFee ?? null,
      input.isAvailable ?? true,
      input.bio ?? null,
      input.contactEmail ?? null,
      input.contactPhone ?? null,
    );
    return this.getProfileById(id);
  }

  async updateProfile(
    id: string,
    input: UpdateOfficialProfileDto,
    actor: ResolvedActor,
  ): Promise<OfficialProfileResponseDto> {
    // REVIEW-P2-8 BLOCKING 6 — same gate as createProfile.
    if (!(await this.hasMarketplaceAdminScope(actor))) {
      throw new ForbiddenException(
        'Only platform marketplace admins can update official profiles. The canonical record is shared across schools.',
      );
    }
    const platform = this.tenantPrisma.getPlatformClient();
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.sports !== undefined) {
      if (input.sports.length === 0) {
        throw new BadRequestException('sports must contain at least one entry');
      }
      params.push(input.sports);
      sets.push('sports = $' + params.length);
    }
    if (input.certificationLevel !== undefined) {
      params.push(input.certificationLevel);
      sets.push('certification_level = $' + params.length);
    }
    if (input.certificationBody !== undefined) {
      params.push(input.certificationBody);
      sets.push('certification_body = $' + params.length);
    }
    if (input.certificationExpiry !== undefined) {
      params.push(input.certificationExpiry);
      sets.push('certification_expiry = $' + params.length + '::date');
    }
    if (input.yearsExperience !== undefined) {
      params.push(input.yearsExperience);
      sets.push('years_experience = $' + params.length);
    }
    if (input.maxTravelMiles !== undefined) {
      params.push(input.maxTravelMiles);
      sets.push('max_travel_miles = $' + params.length);
    }
    if (input.baseFee !== undefined) {
      params.push(input.baseFee);
      sets.push('base_fee = $' + params.length);
    }
    if (input.isAvailable !== undefined) {
      params.push(input.isAvailable);
      sets.push('is_available = $' + params.length);
    }
    if (input.bio !== undefined) {
      params.push(input.bio);
      sets.push('bio = $' + params.length);
    }
    if (input.contactEmail !== undefined) {
      params.push(input.contactEmail);
      sets.push('contact_email = $' + params.length);
    }
    if (input.contactPhone !== undefined) {
      params.push(input.contactPhone);
      sets.push('contact_phone = $' + params.length);
    }
    if (sets.length === 0) return this.getProfileById(id);
    sets.push('updated_at = now()');
    params.push(id);
    const updated = await platform.$executeRawUnsafe(
      'UPDATE platform.platform_official_profiles SET ' +
        sets.join(', ') +
        ' WHERE id = $' +
        params.length +
        '::uuid',
      ...params,
    );
    if (updated === 0) throw new NotFoundException('Official profile not found');
    return this.getProfileById(id);
  }

  // ── Platform-schema availability ────────────────────────────────

  async listAvailability(officialProfileId: string): Promise<OfficialAvailabilityResponseDto[]> {
    const platform = this.tenantPrisma.getPlatformClient();
    const rows = (await platform.$queryRawUnsafe(
      'SELECT id::text AS id, official_profile_id::text AS official_profile_id, ' +
        "TO_CHAR(available_date, 'YYYY-MM-DD') AS available_date, " +
        "TO_CHAR(start_time, 'HH24:MI:SS') AS start_time, " +
        "TO_CHAR(end_time, 'HH24:MI:SS') AS end_time, " +
        'is_available, notes, ' +
        'TO_CHAR(created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
        'TO_CHAR(updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
        'FROM platform.platform_official_availability ' +
        'WHERE official_profile_id = $1::uuid ' +
        'ORDER BY available_date ASC, start_time ASC NULLS FIRST LIMIT 500',
      officialProfileId,
    )) as AvailabilityRow[];
    return rows.map((r) => ({
      id: r.id,
      officialProfileId: r.official_profile_id,
      availableDate: r.available_date,
      startTime: r.start_time,
      endTime: r.end_time,
      isAvailable: r.is_available,
      notes: r.notes,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  async createAvailability(
    officialProfileId: string,
    input: CreateOfficialAvailabilityDto,
    actor: ResolvedActor,
  ): Promise<OfficialAvailabilityResponseDto> {
    // REVIEW-P2-8 BLOCKING 6 — availability is part of the canonical
    // platform record. School ADs cannot author it on behalf; the
    // official-self-service flow lives at marketplace-admin scope today.
    if (!(await this.hasMarketplaceAdminScope(actor))) {
      throw new ForbiddenException(
        'Only platform marketplace admins can set official availability. The canonical record is shared across schools.',
      );
    }
    if (
      (input.startTime !== undefined && input.endTime === undefined) ||
      (input.startTime === undefined && input.endTime !== undefined)
    ) {
      throw new BadRequestException(
        'startTime and endTime must both be provided or both omitted (all-day)',
      );
    }
    const platform = this.tenantPrisma.getPlatformClient();
    // Verify profile exists
    const exists = (await platform.$queryRawUnsafe(
      'SELECT id FROM platform.platform_official_profiles WHERE id = $1::uuid',
      officialProfileId,
    )) as Array<{ id: string }>;
    if (exists.length === 0) {
      throw new BadRequestException('officialProfileId does not match an official profile');
    }
    const id = generateId();
    try {
      await platform.$executeRawUnsafe(
        'INSERT INTO platform.platform_official_availability (id, official_profile_id, available_date, start_time, end_time, is_available, notes) ' +
          'VALUES ($1::uuid, $2::uuid, $3::date, $4::time, $5::time, $6, $7)',
        id,
        officialProfileId,
        input.availableDate,
        input.startTime ?? null,
        input.endTime ?? null,
        input.isAvailable ?? true,
        input.notes ?? null,
      );
    } catch (err) {
      const e = err as { code?: string; meta?: { code?: string } };
      if (e.code === '23505' || e.meta?.code === '23505') {
        throw new BadRequestException(
          'Availability slot already exists for this (date, start_time) pair',
        );
      }
      throw err;
    }
    const rows = (await platform.$queryRawUnsafe(
      'SELECT id::text AS id, official_profile_id::text AS official_profile_id, ' +
        "TO_CHAR(available_date, 'YYYY-MM-DD') AS available_date, " +
        "TO_CHAR(start_time, 'HH24:MI:SS') AS start_time, " +
        "TO_CHAR(end_time, 'HH24:MI:SS') AS end_time, " +
        'is_available, notes, ' +
        'TO_CHAR(created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
        'TO_CHAR(updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
        'FROM platform.platform_official_availability WHERE id = $1::uuid',
      id,
    )) as AvailabilityRow[];
    const r = rows[0]!;
    return {
      id: r.id,
      officialProfileId: r.official_profile_id,
      availableDate: r.available_date,
      startTime: r.start_time,
      endTime: r.end_time,
      isAvailable: r.is_available,
      notes: r.notes,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  // ── Tenant assignment management ────────────────────────────────

  private async assertGameInSchool(
    client: { $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T> },
    gameId: string,
  ): Promise<void> {
    const tenant = getCurrentTenant();
    const rows = await client.$queryRawUnsafe<Array<{ id: string }>>(
      'SELECT g.id FROM ath_games g JOIN ath_seasons sea ON sea.id = g.season_id JOIN ath_programmes pr ON pr.id = sea.programme_id WHERE g.id = $1::uuid AND pr.school_id = $2::uuid',
      gameId,
      tenant.schoolId,
    );
    if (rows.length === 0) {
      throw new BadRequestException('gameId does not match a game in this school');
    }
  }

  private async resolveOfficialName(officialProfileId: string): Promise<string | null> {
    const platform = this.tenantPrisma.getPlatformClient();
    const rows = (await platform.$queryRawUnsafe(
      "SELECT (p.first_name || ' ' || p.last_name) AS name FROM platform.platform_official_profiles op LEFT JOIN platform.iam_person p ON p.id = op.person_id WHERE op.id = $1::uuid",
      officialProfileId,
    )) as Array<{ name: string | null }>;
    return rows[0]?.name ?? null;
  }

  async listAssignmentsForGame(gameId: string): Promise<OfficialAssignmentResponseDto[]> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      const c = client as { $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T> };
      return c.$queryRawUnsafe<AssignmentRow[]>(
        SELECT_ASSIGNMENT +
          'WHERE game_id = $1::uuid AND EXISTS (SELECT 1 FROM ath_games g JOIN ath_seasons sea ON sea.id = g.season_id JOIN ath_programmes pr ON pr.id = sea.programme_id WHERE g.id = $1::uuid AND pr.school_id = $2::uuid) ' +
          'ORDER BY created_at DESC LIMIT 100',
        gameId,
        tenant.schoolId,
      );
    });
    const result: OfficialAssignmentResponseDto[] = [];
    for (const r of rows as AssignmentRow[]) {
      const name = await this.resolveOfficialName(r.official_profile_id);
      result.push(rowToAssignmentDto(r, name));
    }
    return result;
  }

  async listAssignmentsForOfficial(
    officialProfileId: string,
  ): Promise<OfficialAssignmentResponseDto[]> {
    // Within this tenant only — cross-tenant aggregation is a future Phase 3 feature.
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext((client) =>
      (
        client as { $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T> }
      ).$queryRawUnsafe<AssignmentRow[]>(
        SELECT_ASSIGNMENT +
          'WHERE official_profile_id = $1::uuid AND EXISTS (SELECT 1 FROM ath_games g JOIN ath_seasons sea ON sea.id = g.season_id JOIN ath_programmes pr ON pr.id = sea.programme_id WHERE g.id = ath_official_assignments.game_id AND pr.school_id = $2::uuid) ' +
          'ORDER BY created_at DESC LIMIT 200',
        officialProfileId,
        tenant.schoolId,
      ),
    );
    const result: OfficialAssignmentResponseDto[] = [];
    for (const r of rows as AssignmentRow[]) {
      const name = await this.resolveOfficialName(r.official_profile_id);
      result.push(rowToAssignmentDto(r, name));
    }
    return result;
  }

  async getAssignmentById(id: string): Promise<OfficialAssignmentResponseDto> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext((client) =>
      (
        client as { $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T> }
      ).$queryRawUnsafe<AssignmentRow[]>(
        SELECT_ASSIGNMENT +
          'WHERE id = $1::uuid AND EXISTS (SELECT 1 FROM ath_games g JOIN ath_seasons sea ON sea.id = g.season_id JOIN ath_programmes pr ON pr.id = sea.programme_id WHERE g.id = ath_official_assignments.game_id AND pr.school_id = $2::uuid)',
        id,
        tenant.schoolId,
      ),
    );
    if ((rows as AssignmentRow[]).length === 0) {
      throw new NotFoundException('Official assignment not found');
    }
    const r = (rows as AssignmentRow[])[0]!;
    const name = await this.resolveOfficialName(r.official_profile_id);
    return rowToAssignmentDto(r, name);
  }

  async createAssignment(
    gameId: string,
    input: CreateOfficialAssignmentDto,
    actor: ResolvedActor,
  ): Promise<OfficialAssignmentResponseDto> {
    if (!(await this.hasOfficialAdminScope(actor))) {
      throw new ForbiddenException('Only the AD or admin can post official assignments');
    }
    // Verify the official profile exists in the platform schema
    const platform = this.tenantPrisma.getPlatformClient();
    const exists = (await platform.$queryRawUnsafe(
      'SELECT id FROM platform.platform_official_profiles WHERE id = $1::uuid',
      input.officialProfileId,
    )) as Array<{ id: string }>;
    if (exists.length === 0) {
      throw new BadRequestException('officialProfileId does not match an official profile');
    }
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const c = client as {
        $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T>;
        $executeRawUnsafe: (sql: string, ...args: unknown[]) => Promise<number>;
      };
      await this.assertGameInSchool(c, gameId);
      try {
        await c.$executeRawUnsafe(
          'INSERT INTO ath_official_assignments (id, game_id, official_profile_id, role, fee, status, payment_status, notes, assigned_by) ' +
            "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'POSTED', 'PENDING', $6, $7::uuid)",
          id,
          gameId,
          input.officialProfileId,
          input.role,
          input.fee,
          input.notes ?? null,
          actor.personId ?? null,
        );
      } catch (err) {
        const e = err as { code?: string; meta?: { code?: string } };
        if (e.code === '23505' || e.meta?.code === '23505') {
          throw new BadRequestException(
            'This official is already assigned to this game in this role',
          );
        }
        throw err;
      }
    });
    return this.getAssignmentById(id);
  }

  async transitionAssignment(
    id: string,
    input: TransitionOfficialAssignmentDto,
    actor: ResolvedActor,
  ): Promise<OfficialAssignmentResponseDto> {
    if (!(await this.hasOfficialAdminScope(actor))) {
      throw new ForbiddenException('Only the AD or admin can transition official assignments');
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const t = tx as {
        $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T>;
        $executeRawUnsafe: (sql: string, ...args: unknown[]) => Promise<number>;
      };
      const tenant = getCurrentTenant();
      const lock = await t.$queryRawUnsafe<
        Array<{
          id: string;
          status: string;
          official_profile_id: string;
          game_id: string;
          fee: string;
          role: string;
          school_id: string;
        }>
      >(
        'SELECT a.id::text AS id, a.status, a.official_profile_id::text AS official_profile_id, a.game_id::text AS game_id, a.fee::text AS fee, a.role, pr.school_id::text AS school_id ' +
          'FROM ath_official_assignments a JOIN ath_games g ON g.id = a.game_id JOIN ath_seasons sea ON sea.id = g.season_id JOIN ath_programmes pr ON pr.id = sea.programme_id ' +
          'WHERE a.id = $1::uuid FOR UPDATE OF a',
        id,
      );
      if (lock.length === 0) throw new NotFoundException('Official assignment not found');
      if (lock[0]!.school_id !== tenant.schoolId) {
        throw new NotFoundException('Official assignment not found');
      }
      const currentStatus = lock[0]!.status as OfficialAssignmentStatus;
      const allowed: Record<OfficialAssignmentStatus, OfficialAssignmentStatus[]> = {
        POSTED: ['ACCEPTED', 'CANCELLED'],
        ACCEPTED: ['CONFIRMED', 'CANCELLED', 'NO_SHOW'],
        CONFIRMED: ['COMPLETED', 'CANCELLED', 'NO_SHOW'],
        COMPLETED: [],
        CANCELLED: [],
        NO_SHOW: [],
      };
      if (!allowed[currentStatus].includes(input.status)) {
        throw new BadRequestException(
          'Illegal assignment transition ' + currentStatus + ' → ' + input.status,
        );
      }
      const sets: string[] = ['status = $1', 'updated_at = now()'];
      const params: unknown[] = [input.status];
      if (input.status === 'ACCEPTED') {
        sets.push('accepted_at = now()');
      }
      if (input.status === 'CONFIRMED') {
        sets.push('confirmed_at = now()');
      }
      if (input.status === 'COMPLETED') {
        sets.push('completed_at = now()');
      }
      if (input.status === 'CANCELLED') {
        if (!input.cancellationReason || input.cancellationReason.trim().length === 0) {
          throw new BadRequestException('cancellationReason is required when status=CANCELLED');
        }
        sets.push('cancelled_at = now()');
        params.push(input.cancellationReason);
        sets.push('cancellation_reason = $' + params.length);
      }
      if (input.notes !== undefined) {
        params.push(input.notes);
        sets.push('notes = $' + params.length);
      }
      params.push(id);
      await t.$executeRawUnsafe(
        'UPDATE ath_official_assignments SET ' +
          sets.join(', ') +
          ' WHERE id = $' +
          params.length +
          '::uuid',
        ...params,
      );
      // REVIEW-P2-8 BLOCKING 5 — durable outbox INSIDE the same tx so
      // a Kafka outage never drops the AP-billing event silently. The
      // OutboxPublisherWorker delivers with retry; the deterministic
      // event_id makes downstream AP consumer idempotency catch redelivery.
      if (input.status === 'COMPLETED') {
        await this.outbox.enqueueInTx(tx as never, {
          topic: 'ath.official.assignment.completed',
          key: id,
          sourceModule: 'athletics',
          eventId: deterministicAssignmentCompletedEventId(id),
          payload: {
            assignmentId: id,
            gameId: lock[0]!.game_id,
            officialProfileId: lock[0]!.official_profile_id,
            role: lock[0]!.role,
            fee: Number(lock[0]!.fee),
            schoolId: tenant.schoolId,
            completedAt: new Date().toISOString(),
            sourceRefId: id,
          },
        });
      }
    });

    return this.getAssignmentById(id);
  }

  // ── Bidirectional ratings ───────────────────────────────────────

  async listRatingsForAssignment(assignmentId: string): Promise<OfficialRatingResponseDto[]> {
    // Verify the assignment is in this school
    await this.getAssignmentById(assignmentId);
    const rows = await this.tenantPrisma.executeInTenantContext((client) =>
      (
        client as { $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T> }
      ).$queryRawUnsafe<RatingRow[]>(
        SELECT_RATING + 'WHERE assignment_id = $1::uuid ORDER BY rated_at DESC',
        assignmentId,
      ),
    );
    return (rows as RatingRow[]).map(rowToRatingDto);
  }

  async createRating(
    assignmentId: string,
    input: CreateOfficialRatingDto,
    actor: ResolvedActor,
  ): Promise<OfficialRatingResponseDto> {
    // Authorisation depends on rater_type.
    //   SCHOOL_RATES_OFFICIAL — admin/AD only.
    //   OFFICIAL_RATES_SCHOOL — admin/AD only this cycle (the official-self-service
    //     path lands as a Phase 2 carry-over once officials hold platform user
    //     accounts; until then the AD records the official's rating on their behalf).
    if (!(await this.hasOfficialAdminScope(actor))) {
      throw new ForbiddenException('Only the AD or admin can submit official ratings this cycle');
    }
    if (input.overall < 1 || input.overall > 5) {
      throw new BadRequestException('overall must be between 1 and 5');
    }
    for (const k of ['professionalism', 'knowledge', 'communication', 'punctuality'] as const) {
      const v = input[k];
      if (v !== undefined && v !== null && (v < 1 || v > 5)) {
        throw new BadRequestException(k + ' must be between 1 and 5');
      }
    }
    // Verify assignment is COMPLETED in this school + UNIQUE catch
    const assignment = await this.getAssignmentById(assignmentId);
    if (assignment.status !== 'COMPLETED') {
      throw new BadRequestException(
        'Ratings can only be submitted for COMPLETED assignments (current: ' +
          assignment.status +
          ')',
      );
    }
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const c = client as {
        $executeRawUnsafe: (sql: string, ...args: unknown[]) => Promise<number>;
      };
      try {
        await c.$executeRawUnsafe(
          'INSERT INTO ath_official_ratings (id, assignment_id, rater_type, professionalism, knowledge, communication, punctuality, overall, comments, rated_by) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10::uuid)',
          id,
          assignmentId,
          input.raterType,
          input.professionalism ?? null,
          input.knowledge ?? null,
          input.communication ?? null,
          input.punctuality ?? null,
          input.overall,
          input.comments ?? null,
          actor.personId ?? null,
        );
      } catch (err) {
        const e = err as { code?: string; meta?: { code?: string } };
        if (e.code === '23505' || e.meta?.code === '23505') {
          throw new BadRequestException(
            'A rating already exists for this (assignment, rater_type) pair',
          );
        }
        throw err;
      }
    });
    const rows = await this.tenantPrisma.executeInTenantContext((client) =>
      (
        client as { $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T> }
      ).$queryRawUnsafe<RatingRow[]>(SELECT_RATING + 'WHERE id = $1::uuid', id),
    );
    return rowToRatingDto((rows as RatingRow[])[0]!);
  }
}
