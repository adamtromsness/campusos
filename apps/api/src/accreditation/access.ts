import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';

/**
 * P2-23 — Shared access helpers for the Accreditation module.
 *
 * Controller-level gating uses TCH-008 for reads (so generic Staff
 * who already hold curriculum-read for the Curriculum module can
 * navigate into the Accreditation tile) and ACR-001:write for writes
 * (so curriculum-management authority does NOT confer accreditation
 * coordinator authority). The service layer is the actual access
 * boundary on every endpoint:
 *
 * `assertStaffOrAdmin` — every read + write entry point. Parents +
 * Students are refused at the service layer even though they hold
 * the gate-tier TCH-008:read for the curriculum surface.
 *
 * `assertCoordinatorScope` — write-side check for evidence approval,
 * self-study ratings, framework adoption, action plan management,
 * and site visit prep. REVIEW-P2C23 BLOCKING 1 fix: coordinator
 * authority is now `isSchoolAdmin OR holds acr-001:write` (was
 * `tch-008:write` which was broadly granted to Teacher / VP / Staff
 * for curriculum management). ACR-001 is the dedicated accreditation
 * function code; Teacher does NOT hold ACR-001 at any tier — only
 * Staff (coordinator stand-in) + VP + admins hold it.
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
  // REVIEW-P2C23 BLOCKING 1 fix — dedicated ACR-001 code so curriculum
  // TCH-008:write authority does NOT confer accreditation coordinator
  // authority. Teachers + non-coordinator Staff are refused.
  const ok = await permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
    'acr-001:write',
    'acr-001:admin',
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

  // Try platform first. REVIEW-P2C23 MAJOR 1 fix — platform standards
  // are only valid when their parent framework is adopted by the
  // current school. Without this JOIN, evidence / ratings / action
  // plans could be created against frameworks the school has not
  // adopted, distorting self-study reports + readiness scores even
  // though the rows wouldn't count in the readiness denominator.
  const platformRows = (await tenantPrisma.executeInTenantContext(async (client) => {
    return client.$queryRawUnsafe(
      `SELECT s.id::text AS id, s.framework_id::text AS framework_id,
              s.standard_code, s.domain, s.standard_text
       FROM platform.acc_standards_platform s
       JOIN acc_school_framework_adoptions a
         ON a.platform_framework_id = s.framework_id
       WHERE s.id = $1::uuid
         AND a.school_id = $2::uuid
         AND a.is_active = true
       LIMIT 1`,
      standardId,
      tenant.schoolId,
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
      `Standard ${standardId} not found in this school's adopted platform catalogue or tenant custom frameworks. Adopt the parent framework first.`,
    );
  }
  return resolved;
}
