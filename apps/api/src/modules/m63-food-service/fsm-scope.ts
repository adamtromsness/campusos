import { ForbiddenException } from '@nestjs/common';
import { getCurrentTenant } from '@shared/tenant';
import { PermissionCheckService } from '@modules/m00-platform';
import type { ResolvedActor } from '@modules/m00-platform';

/**
 * REVIEW-P2-10a ROUND 1 BLOCKING 4 — FSM admin scope helper.
 *
 * Replaces the broad `personType === 'STAFF'` check that previously
 * gated every recipe, inventory, transfer, and staff-meal mutation.
 * Generic Staff (teacher, office assistant, custodian — anyone with
 * personType=STAFF) should NOT automatically be able to alter
 * inventory, complete transfers, or charge staff meal accounts.
 *
 * The check is admin OR holds `fds-006:write` at the school + platform
 * scope chain. The IAM seed grants FDS-006:read+write to the Staff
 * role specifically — admin tiers (read/write/admin) reach School
 * Admin / Platform Admin via `everyFunction`.
 *
 * Joins the broader role-split work in the Wave 2 Phase 2 punch
 * list. Pre-pilot, a dedicated Food Service Manager role holds the
 * FDS-* codes alone.
 */
export async function assertFsmAdminScope(
  permCheck: PermissionCheckService,
  actor: ResolvedActor,
  surface: string,
): Promise<void> {
  if (actor.isSchoolAdmin) return;
  const tenant = getCurrentTenant();
  const ok = await permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
    'fds-006:write',
  ]);
  if (!ok) {
    throw new ForbiddenException(
      'Only school admins or Food Service administrators (FDS-006:write) can ' + surface,
    );
  }
}
