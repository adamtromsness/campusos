import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import { PermissionCheckService } from '@modules/m00-platform';
import { PersonaResolutionService } from '@modules/m00-platform/iam/persona-resolution.service';
import { generateId } from '@campusos/database';
import {
  CreateSubstituteProfileDto,
  RegisterSubstituteSelfDto,
  SubstituteProfileResponseDto,
  SubstituteSearchDto,
} from './dto/substitutes.dto';

/**
 * SubstituteProfileService — P2-9 Step 5.
 *
 * Owns the platform-portable substitute profile surface. Profile creation
 * + search + matching engine all operate against the platform schema
 * (platform_substitute_profiles + platform_sub_credentials +
 * platform_sub_availability + platform_sub_preferences) per ADR-029.
 *
 * The matching engine is the keystone: search() filters substitutes by
 * grade_levels (GIN-indexed && operator), subject_areas, availability for
 * a given date (BLOCKED overrides RECURRING via NOT EXISTS), VERIFIED
 * credentials, and excludes substitutes who have BLOCKED the requesting
 * school in their preferences.
 */
@Injectable()
export class SubstituteProfileService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
    // @Optional — existing test fixtures construct the service with
    // two args; the persona-cache refresh on self-registration is a
    // soft requirement (the next /auth/me reads from the cache, which
    // PersonaResolutionService will rebuild on the next access if
    // needed). Tests that exercise the self-registration path supply
    // the resolver.
    @Optional() private readonly personaResolution?: PersonaResolutionService,
  ) {}

  /**
   * SubMarketplace admin scope — admin OR holds sub-002:write at the
   * current tenant scope. Used for admin-side reads (other substitutes'
   * profiles, full credential history). Substitutes themselves only see
   * their own profile via the row-scope below.
   *
   * REVIEW-P2C9 BLOCKING 1: this was previously
   * `sch-004:write OR sub-001:write`, both of which generic Staff holds
   * as part of self-service / coverage-read. Marketplace administration
   * now requires the dedicated SUB-002 code, held only by School Admin /
   * Platform Admin via everyFunction until a Sub Coordinator role lands.
   */
  async hasMarketplaceScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'sub-002:write',
    ]);
  }

  // ── Profile reads ────────────────────────────────────────────────

  async list(actor: ResolvedActor): Promise<SubstituteProfileResponseDto[]> {
    if (!(await this.hasMarketplaceScope(actor))) {
      throw new ForbiddenException(
        'Only marketplace admins can list substitute profiles. Substitutes see only their own profile via /substitutes/profile/me.',
      );
    }
    const platform = this.tenantPrisma.getPlatformClient();
    const rows = await platform.substituteProfile.findMany({
      where: { isActive: true },
      orderBy: { displayName: 'asc' },
    });
    return rows.map(this.rowToDto);
  }

  async getById(id: string, actor: ResolvedActor): Promise<SubstituteProfileResponseDto> {
    const platform = this.tenantPrisma.getPlatformClient();
    const row = await platform.substituteProfile.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Substitute profile not found');

    // Self can always read own profile. Otherwise marketplace scope required.
    const isSelf = row.personId === actor.personId;
    if (!isSelf && !(await this.hasMarketplaceScope(actor))) {
      // Don't-leak-existence: 404 instead of 403 so substitutes cannot
      // probe for other substitutes' profile ids.
      throw new NotFoundException('Substitute profile not found');
    }
    return this.rowToDto(row);
  }

  async getMyProfile(actor: ResolvedActor): Promise<SubstituteProfileResponseDto | null> {
    if (!actor.personId) return null;
    const platform = this.tenantPrisma.getPlatformClient();
    const row = await platform.substituteProfile.findUnique({
      where: { personId: actor.personId },
    });
    return row ? this.rowToDto(row) : null;
  }

  // ── Profile create / update ──────────────────────────────────────

  async create(
    input: CreateSubstituteProfileDto,
    actor: ResolvedActor,
  ): Promise<SubstituteProfileResponseDto> {
    // Self-service profile create — substitute creates own profile. Admin
    // can also create on behalf via marketplace scope. Either way the
    // person_id MUST match the actor's personId unless admin scope.
    const platform = this.tenantPrisma.getPlatformClient();
    if (input.personId !== actor.personId) {
      if (!(await this.hasMarketplaceScope(actor))) {
        throw new ForbiddenException(
          'A substitute can only create their own profile. Admins use marketplace scope to create on behalf.',
        );
      }
    }

    if (input.gradeLevels.length === 0) {
      throw new ForbiddenException('gradeLevels must not be empty.');
    }

    const id = generateId();
    const created = await platform.substituteProfile.create({
      data: {
        id,
        personId: input.personId,
        displayName: input.displayName,
        bio: input.bio ?? null,
        gradeLevels: input.gradeLevels,
        subjectAreas: input.subjectAreas ?? [],
        yearsExperience: input.yearsExperience ?? null,
        maxDistanceMiles: input.maxTravelMiles ?? null,
        isAvailable: true,
        isActive: true,
      },
    });
    return this.rowToDto(created);
  }

  /**
   * Self-service registration as a substitute teacher. Bound to the
   * caller's own personId — no `personId` field on the DTO, no admin-
   * on-behalf path. Used by the Getting Started "I want to substitute
   * teach" card, where the user holds no IAM permissions yet.
   *
   * Idempotent: a second call on the same person returns the existing
   * profile rather than 409, so the registration page is safe to retry
   * after a network blip. The persona cache is refreshed so SUBSTITUTE
   * surfaces on the next /auth/me without a manual log-out.
   */
  async registerSelf(
    input: RegisterSubstituteSelfDto,
    actor: ResolvedActor,
  ): Promise<SubstituteProfileResponseDto> {
    if (!actor.personId) {
      throw new ForbiddenException('Anonymous registration is not supported');
    }
    const platform = this.tenantPrisma.getPlatformClient();

    // Idempotent — return the existing profile if the caller already
    // registered. This lets the UI safely retry after a network blip
    // without surfacing a confusing 409.
    const existing = await platform.substituteProfile.findUnique({
      where: { personId: actor.personId },
    });
    if (existing) {
      return this.rowToDto(existing);
    }

    if (!input.gradeLevels || input.gradeLevels.length === 0) {
      throw new BadRequestException('Pick at least one grade band.');
    }

    const id = generateId();
    let created;
    try {
      created = await platform.substituteProfile.create({
        data: {
          id,
          personId: actor.personId,
          accountId: actor.accountId,
          displayName: input.displayName ?? 'Substitute',
          bio: input.bio ?? null,
          gradeLevels: input.gradeLevels,
          subjectAreas: input.subjectAreas ?? [],
          yearsExperience: input.yearsExperience ?? null,
          maxDistanceMiles: input.maxDistanceMiles ?? null,
          isAvailable: true,
          isActive: true,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        // Race with a parallel registration — re-read the winning row.
        const after = await platform.substituteProfile.findUnique({
          where: { personId: actor.personId },
        });
        if (after) return this.rowToDto(after);
        throw new ConflictException('A substitute profile already exists for this person');
      }
      throw e;
    }

    if (this.personaResolution) {
      try {
        await this.personaResolution.refreshPersonaCache(actor.personId);
      } catch {
        // Best-effort — next /auth/me will re-resolve.
      }
    }

    return this.rowToDto(created);
  }

  // ── Matching engine — the keystone ───────────────────────────────

  /**
   * Search substitutes that match the supplied filters. The grade_levels
   * filter uses && (array overlap) which is GIN-accelerated. The
   * availability filter resolves RECURRING + SPECIFIC minus BLOCKED
   * (BLOCKED overrides RECURRING). The verified-credentials filter uses
   * the partial WHERE verification_status='VERIFIED' index.
   *
   * BLOCKED schools (per platform_sub_preferences) are excluded from
   * the result set when schoolId is supplied.
   */
  async search(args: SubstituteSearchDto): Promise<SubstituteProfileResponseDto[]> {
    const platform = this.tenantPrisma.getPlatformClient();

    // Build the WHERE incrementally with raw SQL because the && array
    // overlap operator and EXISTS subqueries on availability / preferences
    // are easier to express than the Prisma DSL equivalents.
    const conditions: string[] = ['p.is_active = true'];
    const params: unknown[] = [];
    let pIndex = 1;

    if (args.gradeLevels && args.gradeLevels.length > 0) {
      conditions.push(`p.grade_levels && $${pIndex}::text[]`);
      params.push(args.gradeLevels);
      pIndex++;
    }

    if (args.subjectAreas && args.subjectAreas.length > 0) {
      conditions.push(`p.subject_areas && $${pIndex}::text[]`);
      params.push(args.subjectAreas);
      pIndex++;
    }

    if (args.schoolId) {
      // Exclude substitutes who have BLOCKED this school.
      conditions.push(`NOT EXISTS (
        SELECT 1 FROM platform.platform_sub_preferences pref
        WHERE pref.substitute_id = p.id AND pref.school_id = $${pIndex}::uuid AND pref.preference_type = 'BLOCKED'
      )`);
      params.push(args.schoolId);
      pIndex++;
    }

    if (args.verifiedOnly) {
      conditions.push(`EXISTS (
        SELECT 1 FROM platform.platform_sub_credentials c
        WHERE c.substitute_id = p.id AND c.verification_status = 'VERIFIED'
      )`);
    }

    if (args.availableOn) {
      // BLOCKED overrides RECURRING — the keystone.
      const dateParam = pIndex;
      params.push(args.availableOn);
      pIndex++;
      conditions.push(`(
        EXISTS (
          SELECT 1 FROM platform.platform_sub_availability a
          WHERE a.substitute_id = p.id
            AND a.availability_type = 'RECURRING'
            AND a.day_of_week = EXTRACT(DOW FROM $${dateParam}::date)::int
        )
        OR EXISTS (
          SELECT 1 FROM platform.platform_sub_availability a
          WHERE a.substitute_id = p.id
            AND a.availability_type = 'SPECIFIC'
            AND a.specific_date = $${dateParam}::date
        )
      ) AND NOT EXISTS (
        SELECT 1 FROM platform.platform_sub_availability a
        WHERE a.substitute_id = p.id
          AND a.availability_type = 'BLOCKED'
          AND a.specific_date = $${dateParam}::date
      )`);
    }

    // Note: the PREFERRED-first order is a future enhancement —
    // requires a JOIN to platform_sub_preferences and a CASE expression
    // referencing the schoolId param. P2-9b ships this when the
    // marketplace UI surfaces preferred-substitute prioritisation.

    const sql = `SELECT p.* FROM platform.platform_substitute_profiles p
      WHERE ${conditions.join(' AND ')}
      ORDER BY COALESCE(p.overall_rating, 0) DESC, p.display_name ASC NULLS LAST`;

    const rows = (await platform.$queryRawUnsafe(sql, ...params)) as Array<{
      id: string;
      person_id: string;
      display_name: string | null;
      bio: string | null;
      grade_levels: string[];
      subject_areas: string[];
      years_experience: number | null;
      max_distance_miles: number | null;
      is_available: boolean;
      overall_rating: Prisma.Decimal | null;
      total_assignments: number;
      is_active: boolean;
    }>;
    return rows.map((r) => ({
      id: r.id,
      personId: r.person_id,
      displayName: r.display_name,
      bio: r.bio,
      gradeLevels: r.grade_levels,
      subjectAreas: r.subject_areas ?? [],
      yearsExperience: r.years_experience,
      maxTravelMiles: r.max_distance_miles,
      isAvailable: r.is_available,
      overallRating: r.overall_rating ? r.overall_rating.toString() : null,
      totalAssignments: r.total_assignments,
      isActive: r.is_active,
    }));
  }

  /**
   * Resolve whether a given substitute is available for a given date.
   * Returns true when (RECURRING for that day-of-week OR SPECIFIC for that
   * exact date) AND no BLOCKED row for that exact date exists. The
   * BLOCKED-overrides-RECURRING contract.
   */
  async isAvailableOn(substituteId: string, date: string): Promise<boolean> {
    const platform = this.tenantPrisma.getPlatformClient();
    const rows = (await platform.$queryRawUnsafe(
      `SELECT (
        (EXISTS (
          SELECT 1 FROM platform.platform_sub_availability
          WHERE substitute_id = $1::uuid AND availability_type = 'RECURRING'
            AND day_of_week = EXTRACT(DOW FROM $2::date)::int
        ) OR EXISTS (
          SELECT 1 FROM platform.platform_sub_availability
          WHERE substitute_id = $1::uuid AND availability_type = 'SPECIFIC' AND specific_date = $2::date
        )) AND NOT EXISTS (
          SELECT 1 FROM platform.platform_sub_availability
          WHERE substitute_id = $1::uuid AND availability_type = 'BLOCKED' AND specific_date = $2::date
        )
      ) AS available`,
      substituteId,
      date,
    )) as Array<{ available: boolean }>;
    return rows[0]?.available ?? false;
  }

  // ── Helper ───────────────────────────────────────────────────────

  private rowToDto = (row: {
    id: string;
    personId: string;
    displayName: string | null;
    bio: string | null;
    gradeLevels: string[];
    subjectAreas: string[];
    yearsExperience: number | null;
    maxDistanceMiles: number | null;
    isAvailable: boolean;
    overallRating: Prisma.Decimal | null;
    totalAssignments: number;
    isActive: boolean;
  }): SubstituteProfileResponseDto => ({
    id: row.id,
    personId: row.personId,
    displayName: row.displayName,
    bio: row.bio,
    gradeLevels: row.gradeLevels ?? [],
    subjectAreas: row.subjectAreas ?? [],
    yearsExperience: row.yearsExperience,
    maxTravelMiles: row.maxDistanceMiles,
    isAvailable: row.isAvailable,
    overallRating: row.overallRating ? row.overallRating.toString() : null,
    totalAssignments: row.totalAssignments,
    isActive: row.isActive,
  });
}
