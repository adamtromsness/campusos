import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';

/**
 * P2-22a — Shared access helpers for the Alumni module.
 *
 * Three keystones encoded in code:
 *   1. RLS — alumni can read + update only their OWN alm_alumni_profile.
 *      An alumnus is the iam_person referenced by the profile's
 *      person_id column. Admins (school admin OR PUB-004:admin) bypass
 *      RLS for management surfaces. Non-admin readers see only opted-in
 *      directory entries.
 *   2. Staff scope — campaign / news / event / reunion management is
 *      gated on Staff or admin scope, validated at the service layer
 *      via hasStaffScope. Generic PUB-004:write at the role tier is not
 *      sufficient on its own — non-admin students with PUB-004:write
 *      only manage their own profile + own tags.
 *   3. Anonymous donation visibility — DonationService.toDto strips
 *      donor_alumni_id + donorDisplayName for non-admin callers when
 *      is_anonymous=true, while leaving the amount and timestamp
 *      visible so the public campaign page still aggregates correctly.
 */

export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e?.code === 'P2002') return true;
  if (e?.code === 'P2010' && e?.meta?.code === '23505') return true;
  if (typeof e?.message === 'string' && e.message.includes('23505')) return true;
  return false;
}

/**
 * Resolve the calling actor's alm_alumni_profiles.id, if any. NULL when
 * the actor is not registered as an alumnus at this school.
 */
export async function resolveOwnAlumniId(
  tenantPrisma: TenantPrismaService,
  actor: ResolvedActor,
): Promise<string | null> {
  if (!actor.personId) return null;
  const rows = (await tenantPrisma.executeInTenantContext(async (client) => {
    return client.$queryRawUnsafe(
      'SELECT id::text AS id FROM alm_alumni_profiles WHERE person_id = $1::uuid LIMIT 1',
      actor.personId,
    );
  })) as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

/**
 * Staff or admin scope. Used to gate campaign / news / event / reunion
 * management surfaces. Admins always pass. Non-admin actors must hold
 * pub-004:write AND have STAFF personType — pure students with the
 * same role-tier grant fail this check and are bound to own-profile
 * surfaces only.
 */
export async function hasStaffScope(
  permCheck: PermissionCheckService,
  actor: ResolvedActor,
): Promise<boolean> {
  if (actor.isSchoolAdmin) return true;
  const tenant = getCurrentTenant();
  const hasAdmin = await permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
    'pub-004:admin',
  ]);
  if (hasAdmin) return true;
  if (actor.personType !== 'STAFF') return false;
  return permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, ['pub-004:write']);
}

/**
 * Validate that an alm_alumni_profiles.id refers to a row in the
 * current tenant. Returns the row's school_id + person_id so callers
 * can apply downstream RLS without a second roundtrip.
 */
export async function loadAlumniProfileOrFail(
  tenantPrisma: TenantPrismaService,
  alumniId: string,
): Promise<{ id: string; schoolId: string; personId: string; isOptedIn: boolean }> {
  if (!alumniId) {
    throw new BadRequestException('alumniId is required');
  }
  const rows = (await tenantPrisma.executeInTenantContext(async (client) => {
    return client.$queryRawUnsafe(
      `SELECT id::text AS id, school_id::text AS school_id, person_id::text AS person_id, is_opted_in
       FROM alm_alumni_profiles WHERE id = $1::uuid LIMIT 1`,
      alumniId,
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
 * tenant and return its school + status + reporting currency so the
 * caller can short-circuit downstream checks.
 */
export async function loadCampaignOrFail(
  tenantPrisma: TenantPrismaService,
  campaignId: string,
): Promise<{ id: string; schoolId: string; status: string; reportingCurrency: string }> {
  if (!campaignId) {
    throw new BadRequestException('campaignId is required');
  }
  const rows = (await tenantPrisma.executeInTenantContext(async (client) => {
    return client.$queryRawUnsafe(
      `SELECT id::text AS id, school_id::text AS school_id, status, reporting_currency
       FROM alm_campaigns WHERE id = $1::uuid LIMIT 1`,
      campaignId,
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
