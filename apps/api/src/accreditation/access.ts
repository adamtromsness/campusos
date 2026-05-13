import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';

/**
 * P2-23a — Shared access helpers for the Accreditation module.
 *
 * Permission gating reuses TCH-008 (Curriculum Management) per the
 * plan ("TCH-008 extended"). The IAM seed grants TCH-008:read+write
 * to Teacher / VP / Staff and TCH-008:read to Parent + Student for
 * the Cycle 23 curriculum surface. Accreditation re-uses that gate
 * because the plan deliberately avoids minting a new function code.
 *
 * The plan's visibility scenario says "Students/parents cannot
 * access accreditation module." So while Parent + Student pass the
 * controller-level @RequirePermission('tch-008:read') gate (held
 * for curriculum reads), the service layer must refuse them.
 *
 * `assertStaffOrAdmin` is the canonical entry-point for every read
 * + write path. Parents + Students get 403 even though they hold
 * the gate-tier permission for the curriculum surface.
 *
 * `assertCoordinatorScope` adds the write-side check — coordinator
 * = isSchoolAdmin OR holds tch-008:write. Generic STAFF with
 * tch-008:read alone cannot rate, approve evidence, or manage
 * action plans.
 */

export function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e.code === 'P2002') return true;
  if (e.code === 'P2010' && e.meta?.code === '23505') return true;
  if (e.code === '23505') return true;
  return typeof e.message === 'string' && e.message.includes('23505');
}

export function assertStaffOrAdmin(actor: ResolvedActor, surface: string): void {
  if (actor.isSchoolAdmin) return;
  // STAFF includes school admin substitutes (VP, counsellor, principal).
  // GUARDIAN + STUDENT are explicitly refused even though they may hold
  // the gate-tier tch-008:read permission for the curriculum surface.
  if (actor.personType === 'STAFF') return;
  throw new ForbiddenException(
    `${surface} is restricted to staff and administrators — accreditation data is not parent/student-facing`,
  );
}

export async function assertCoordinatorScope(
  actor: ResolvedActor,
  permCheck: PermissionCheckService,
  surface: string,
): Promise<void> {
  if (actor.isSchoolAdmin) return;
  if (actor.personType !== 'STAFF') {
    throw new ForbiddenException(
      `${surface} is restricted to the accreditation coordinator or school administrators`,
    );
  }
  const tenant = getCurrentTenant();
  const ok = await permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
    'tch-008:write',
    'tch-008:admin',
  ]);
  if (!ok) {
    throw new ForbiddenException(
      `${surface} is restricted to the accreditation coordinator or school administrators`,
    );
  }
}

/**
 * SOFT INTEGRITY resolver for standard_id. Resolves a UUID to either
 * a platform.acc_standards_platform row (national framework) OR a
 * tenant custom standard within an acc_frameworks row. Returns the
 * resolved metadata or throws NotFoundException.
 *
 * For P2-23a the tenant custom-standard child table is deferred —
 * the acc_frameworks row carries no per-standard child rows yet, so
 * the only way standard_id resolves on the tenant side is via a
 * future custom-standard table or via direct linkage from the seed.
 * Today the resolver checks the platform table first; if no match
 * AND a tenant `acc_custom_standards` table exists, it tries that.
 * If both miss, the call returns null and the caller decides whether
 * to throw 404 (creation paths) or skip (read paths that aggregate
 * across many standards).
 */
export type StandardResolution = {
  source: 'PLATFORM' | 'TENANT';
  id: string;
  domain: string | null;
  standardCode: string;
  standardText: string;
  frameworkId: string;
};

export async function resolveStandard(
  tenantPrisma: TenantPrismaService,
  standardId: string,
): Promise<StandardResolution | null> {
  if (!standardId) return null;
  const tenant = getCurrentTenant();

  // Try platform first.
  const platformRows = (await tenantPrisma.executeInTenantContext(async (client) => {
    return client.$queryRawUnsafe(
      `SELECT id::text AS id, framework_id::text AS framework_id,
              standard_code, domain, standard_text
       FROM platform.acc_standards_platform
       WHERE id = $1::uuid
       LIMIT 1`,
      standardId,
    );
  })) as Array<{
    id: string;
    framework_id: string;
    standard_code: string;
    domain: string;
    standard_text: string;
  }>;
  if (platformRows.length > 0) {
    const r = platformRows[0]!;
    return {
      source: 'PLATFORM',
      id: r.id,
      frameworkId: r.framework_id,
      standardCode: r.standard_code,
      domain: r.domain,
      standardText: r.standard_text,
    };
  }

  // Try tenant custom standard. The custom standards child table is
  // deferred (M85 future) — but if a school has a custom acc_frameworks
  // row whose id matches the supplied standard_id we treat the
  // framework row itself as the standard for now. This keeps the
  // SOFT INTEGRITY contract honoured without requiring the deferred
  // table to ship in P2-23a.
  const tenantRows = (await tenantPrisma.executeInTenantContext(async (client) => {
    return client.$queryRawUnsafe(
      `SELECT id::text AS id, name
       FROM acc_frameworks
       WHERE id = $1::uuid AND school_id = $2::uuid
       LIMIT 1`,
      standardId,
      tenant.schoolId,
    );
  })) as Array<{ id: string; name: string }>;
  if (tenantRows.length > 0) {
    const r = tenantRows[0]!;
    return {
      source: 'TENANT',
      id: r.id,
      frameworkId: r.id,
      standardCode: r.name,
      domain: null,
      standardText: r.name,
    };
  }

  return null;
}

export async function assertStandardResolves(
  tenantPrisma: TenantPrismaService,
  standardId: string,
): Promise<StandardResolution> {
  const resolved = await resolveStandard(tenantPrisma, standardId);
  if (!resolved) {
    throw new NotFoundException(
      `Standard ${standardId} not found in platform or tenant catalogues`,
    );
  }
  return resolved;
}
