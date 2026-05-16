import { ForbiddenException } from '@nestjs/common';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import { getCurrentTenant } from '../tenant/tenant.context';

/**
 * P2-24 — Shared access helpers for the Parent Engagement module.
 *
 * Controller-level gating uses MTG-002 for conference scheduling
 * surfaces and ENG-001 for engagement scoring + surveys. The service
 * layer is the actual access boundary on every endpoint:
 *
 *   assertConferenceAdmin     — admin/teacher/staff who can publish
 *                               slots + document outcomes
 *   assertEngagementAdmin     — admin-only writes for survey + score
 *                               weight configuration
 *   assertEngagementReader    — admin OR teacher with ENG-001:read
 *                               (engagement dashboard visibility)
 */

export function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e.code === 'P2002') return true;
  if (e.code === 'P2010' && e.meta?.code === '23505') return true;
  if (e.code === '23505') return true;
  return typeof e.message === 'string' && e.message.includes('23505');
}

export async function assertConferenceAdmin(
  actor: ResolvedActor,
  permCheck: PermissionCheckService,
  surface: string,
): Promise<void> {
  if (actor.isSchoolAdmin) return;
  const tenant = getCurrentTenant();
  // MTG-002:write is held by Teacher + Staff + School Admin per the
  // P2-24 seed. Parents hold MTG-002:write for booking only — the
  // service layer filters them out via personType check.
  if (actor.personType === 'GUARDIAN' || actor.personType === 'STUDENT') {
    throw new ForbiddenException(`${surface} is restricted to school staff and administrators`);
  }
  const ok = await permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
    'mtg-002:write',
    'mtg-002:admin',
  ]);
  if (!ok) {
    throw new ForbiddenException(`${surface} is restricted to school staff and administrators`);
  }
}

export async function assertEngagementAdmin(
  actor: ResolvedActor,
  permCheck: PermissionCheckService,
  surface: string,
): Promise<void> {
  if (actor.isSchoolAdmin) return;
  const tenant = getCurrentTenant();
  // Survey creation, score weight configuration, and engagement
  // dashboard writes are admin-only. ENG-001:admin is granted only
  // through everyFunction (School Admin + Platform Admin); generic
  // Staff holds ENG-001:read for the read surface but not :admin.
  const ok = await permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
    'eng-001:admin',
  ]);
  if (!ok) {
    throw new ForbiddenException(`${surface} is restricted to school administrators`);
  }
}

export async function assertEngagementReader(
  actor: ResolvedActor,
  permCheck: PermissionCheckService,
  surface: string,
): Promise<void> {
  if (actor.isSchoolAdmin) return;
  const tenant = getCurrentTenant();
  // ENG-001:read held by Teacher + Staff + Admin per the seed.
  // Parents + Students never hold ENG-001 — engagement data is a
  // staff-side dashboard.
  if (actor.personType === 'GUARDIAN' || actor.personType === 'STUDENT') {
    throw new ForbiddenException(`${surface} is restricted to school staff and administrators`);
  }
  const ok = await permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
    'eng-001:read',
    'eng-001:write',
    'eng-001:admin',
  ]);
  if (!ok) {
    throw new ForbiddenException(`${surface} is restricted to school staff and administrators`);
  }
}

/**
 * P2-H1 Step 5 — capability check (boolean, not throw) for whether the actor
 * may see the component breakdown of an engagement score. School admins +
 * ENG-001:admin holders see components; everyone else sees aggregate-level
 * only (engagement_level + composite_score), with component_* fields
 * stripped server-side.
 *
 * Rationale: component scores expose payment behaviour + communication
 * engagement + conference attendance per family. Treat as sensitive
 * profiling; restrict to admin tier per the hardening plan (Plan IMP-10,
 * GPT COMP-02).
 */
export async function isEngagementAdmin(
  actor: ResolvedActor,
  permCheck: PermissionCheckService,
): Promise<boolean> {
  if (actor.isSchoolAdmin) return true;
  const tenant = getCurrentTenant();
  return permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, ['eng-001:admin']);
}
