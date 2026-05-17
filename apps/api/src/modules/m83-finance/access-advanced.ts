import { ForbiddenException } from '@nestjs/common';
import type { ResolvedActor } from '@modules/m00-platform';
import { PermissionCheckService } from '@modules/m00-platform';
import { getCurrentTenant } from '@shared/tenant';

export function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e.code === 'P2002') return true;
  if (e.code === 'P2010' && e.meta?.code === '23505') return true;
  if (e.code === '23505') return true;
  return typeof e.message === 'string' && e.message.includes('23505');
}

/** Finance administration — budgets, transfers, journal batches. */
export async function assertFinanceAdmin(
  actor: ResolvedActor,
  permCheck: PermissionCheckService,
  surface: string,
): Promise<void> {
  if (actor.isSchoolAdmin) return;
  if (actor.personType === 'GUARDIAN' || actor.personType === 'STUDENT') {
    throw new ForbiddenException(`${surface} is restricted to finance administrators`);
  }
  const tenant = getCurrentTenant();
  const ok = await permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
    'fin-005:admin',
    'fin-006:admin',
    'fin-005:write',
    'fin-006:write',
  ]);
  if (!ok) {
    throw new ForbiddenException(`${surface} is restricted to finance administrators`);
  }
}

/** Finance read — staff + admin. */
export async function assertFinanceReader(
  actor: ResolvedActor,
  permCheck: PermissionCheckService,
  surface: string,
): Promise<void> {
  if (actor.isSchoolAdmin) return;
  if (actor.personType === 'GUARDIAN' || actor.personType === 'STUDENT') {
    throw new ForbiddenException(`${surface} is restricted to school staff and administrators`);
  }
  const tenant = getCurrentTenant();
  const ok = await permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
    'fin-005:read',
    'fin-006:read',
    'fin-007:read',
    'fin-008:read',
    'fin-005:write',
    'fin-006:write',
  ]);
  if (!ok) {
    throw new ForbiddenException(`${surface} is restricted to school staff and administrators`);
  }
}
