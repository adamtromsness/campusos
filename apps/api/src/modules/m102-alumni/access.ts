import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';

/**
 * P2-22a — Shared access helpers for the Alumni module.
 *
 * REVIEW-P2C22 ROUND 1 hardening:
 *   - BLOCKING 2 — every loader (`loadAlumniProfileOrFail`,
 *     `loadCampaignOrFail`, `resolveOwnAlumniId`) now binds to the
 *     current tenant's `school_id`. Cross-school UUIDs collapse to
 *     404 NotFoundException at the loader layer instead of being
 *     accepted by downstream services.
 *   - BLOCKING 6 — `hasStaffScope` retired. Management surfaces
 *     (campaigns / news / events / reunions / donation-on-behalf /
 *     outreach) now require `hasAdminScope`, which gates on
 *     `actor.isSchoolAdmin OR pub-004:admin`. Generic Staff with
 *     `pub-004:write` continues to manage their OWN profile + own
 *     tags via per-row owner checks in the profile/tag services,
 *     but does not get module-wide admin authority.
 *
 * Three keystones encoded in code:
 *   1. RLS — alumni can read + update only their OWN
 *      alm_alumni_profile. Admins (school admin OR PUB-004:admin)
 *      bypass RLS for management surfaces. Non-admin readers see
 *      only opted-in directory entries.
 *   2. Admin scope — campaign / news / event / reunion management
 *      is gated on `hasAdminScope` (school admin OR PUB-004:admin).
 *      Generic PUB-004:write is sufficient for own-profile + own-
 *      tag writes only.
 *   3. Anonymous donation visibility — `DonationService.toDto`
 *      strips donor identity + payment refs for non-admin callers
 *      when is_anonymous=true, while leaving the amount + timestamp
 *      visible so the public campaign page still aggregates
 *      correctly.
 */

export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e?.code === 'P2002') return true;
  if (e?.code === 'P2010' && e?.meta?.code === '23505') return true;
  if (typeof e?.message === 'string' && e.message.includes('23505')) return true;
  return false;
}

/**
 * Resolve the calling actor's alm_alumni_profiles.id, if any, within
 * the current tenant. NULL when the actor is not registered as an
 * alumnus at this school. REVIEW-P2C22 BLOCKING 2 — the SQL now
 * binds to `school_id` so a person registered as an alumnus at a
 * sister school cannot accidentally resolve into this tenant's
 * surfaces.
 */
export async function resolveOwnAlumniId(
  tenantPrisma: TenantPrismaService,
  actor: ResolvedActor,
): Promise<string | null> {
  if (!actor.personId) return null;
  const tenant = getCurrentTenant();
  const rows = (await tenantPrisma.executeInTenantContext(async (client) => {
    return client.$queryRawUnsafe(
      `SELECT id::text AS id
       FROM alm_alumni_profiles
       WHERE person_id = $1::uuid AND school_id = $2::uuid
       LIMIT 1`,
      actor.personId,
      tenant.schoolId,
    );
  })) as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

/**
 * REVIEW-P2C22 BLOCKING 6 — admin scope check for module-wide
 * management surfaces. Replaces the prior `hasStaffScope` which
 * accepted any STAFF actor holding PUB-004:write — the seed grants
 * that combination to VP / counsellor / admin assistant, none of
 * whom should automatically inherit fundraising / outreach / news /
 * event management power.
 *
 * Passes when:
 *   (a) actor is a school admin (sch-001:admin), OR
 *   (b) actor holds pub-004:admin at the tenant scope.
 *
 * Generic STAFF + pub-004:write continues to manage their OWN
 * profile + own tags via per-row owner checks at the service layer.
 */
export async function hasAdminScope(
  permCheck: PermissionCheckService,
  actor: ResolvedActor,
): Promise<boolean> {
  if (actor.isSchoolAdmin) return true;
  const tenant = getCurrentTenant();
  return permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, ['pub-004:admin']);
}

/**
 * Legacy alias kept temporarily so existing call sites compile —
 * resolves to the new admin-only check. Will be removed in a
 * follow-up sweep once all call sites have been updated.
 *
 * @deprecated Use `hasAdminScope` directly.
 */
export async function hasStaffScope(
  permCheck: PermissionCheckService,
  actor: ResolvedActor,
): Promise<boolean> {
  return hasAdminScope(permCheck, actor);
}

/**
 * Validate that an alm_alumni_profiles.id refers to a row in the
 * current tenant. REVIEW-P2C22 BLOCKING 2 — the WHERE now carries
 * `school_id = tenant.schoolId` so a cross-school UUID collapses
 * to 404 at the loader. Returns the row's school_id + person_id so
 * callers can apply downstream RLS without a second roundtrip.
 */
export async function loadAlumniProfileOrFail(
  tenantPrisma: TenantPrismaService,
  alumniId: string,
): Promise<{ id: string; schoolId: string; personId: string; isOptedIn: boolean }> {
  if (!alumniId) {
    throw new BadRequestException('alumniId is required');
  }
  const tenant = getCurrentTenant();
  const rows = (await tenantPrisma.executeInTenantContext(async (client) => {
    return client.$queryRawUnsafe(
      `SELECT id::text AS id, school_id::text AS school_id, person_id::text AS person_id, is_opted_in
       FROM alm_alumni_profiles
       WHERE id = $1::uuid AND school_id = $2::uuid
       LIMIT 1`,
      alumniId,
      tenant.schoolId,
    );
  })) as Array<{ id: string; school_id: string; person_id: string; is_opted_in: boolean }>;
  if (rows.length === 0) {
    throw new NotFoundException('Alumni profile not found');
  }
  return {
    id: rows[0]!.id,
    schoolId: rows[0]!.school_id,
    personId: rows[0]!.person_id,
    isOptedIn: rows[0]!.is_opted_in,
  };
}

/**
 * Validate that an alm_campaigns.id refers to a row in the current
 * tenant. REVIEW-P2C22 BLOCKING 2 — the WHERE now binds to
 * `school_id = tenant.schoolId`. Cross-school campaign UUIDs
 * collapse to 404 at the loader.
 */
export async function loadCampaignOrFail(
  tenantPrisma: TenantPrismaService,
  campaignId: string,
): Promise<{ id: string; schoolId: string; status: string; reportingCurrency: string }> {
  if (!campaignId) {
    throw new BadRequestException('campaignId is required');
  }
  const tenant = getCurrentTenant();
  const rows = (await tenantPrisma.executeInTenantContext(async (client) => {
    return client.$queryRawUnsafe(
      `SELECT id::text AS id, school_id::text AS school_id, status, reporting_currency
       FROM alm_campaigns
       WHERE id = $1::uuid AND school_id = $2::uuid
       LIMIT 1`,
      campaignId,
      tenant.schoolId,
    );
  })) as Array<{ id: string; school_id: string; status: string; reporting_currency: string }>;
  if (rows.length === 0) {
    throw new NotFoundException('Campaign not found');
  }
  return {
    id: rows[0]!.id,
    schoolId: rows[0]!.school_id,
    status: rows[0]!.status,
    reportingCurrency: rows[0]!.reporting_currency,
  };
}

export function assertSchoolAdmin(actor: ResolvedActor, what: string): void {
  if (!actor.isSchoolAdmin) {
    throw new ForbiddenException(`${what} requires school admin scope`);
  }
}
