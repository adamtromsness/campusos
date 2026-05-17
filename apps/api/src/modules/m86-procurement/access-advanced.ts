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

/** Procurement administration — vendor catalogues + contracts. */
export async function assertProcurementAdmin(
  actor: ResolvedActor,
  permCheck: PermissionCheckService,
  surface: string,
): Promise<void> {
  if (actor.isSchoolAdmin) return;
  if (actor.personType === 'GUARDIAN' || actor.personType === 'STUDENT') {
    throw new ForbiddenException(
      `${surface} is restricted to procurement staff and administrators`,
    );
  }
  const tenant = getCurrentTenant();
  const ok = await permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
    'prc-002:write',
    'prc-002:admin',
    'prc-004:write',
    'prc-004:admin',
  ]);
  if (!ok) {
    throw new ForbiddenException(
      `${surface} is restricted to procurement staff and administrators`,
    );
  }
}

/** Procurement read — staff + admin only. Parents/students collapse. */
export async function assertProcurementReader(
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
    'prc-001:read',
    'prc-002:read',
    'prc-003:read',
    'prc-004:read',
    'prc-001:write',
    'prc-002:write',
    'prc-004:write',
  ]);
  if (!ok) {
    throw new ForbiddenException(`${surface} is restricted to school staff and administrators`);
  }
}
