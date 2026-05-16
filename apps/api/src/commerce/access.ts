import { ForbiddenException } from '@nestjs/common';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import { getCurrentTenant } from '../tenant/tenant.context';

/**
 * P2-29a — Shared access helpers for the Commerce bundle module
 * (Procurement Advanced + Finance Extensions).
 *
 * Controller-level gates use:
 *   PRC-001..004  for vendor catalogues, contracts, spending analytics
 *   FIN-005..006  for departmental budgets + budget transfers
 *   FIN-005..008  for journal entry batches (covering the same scope
 *                 as Cycle 26 fin-005 read / fin-005:admin write)
 *
 * The service layer is the actual access boundary on every endpoint —
 * controller permissions only filter at the gate. Parents and students
 * are never granted any of these codes, so reads collapse at the
 * permission gate; the service layer assertions defend admin paths
 * against staff who hold the read tier but not write.
 */

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

/**
 * Store administration — promotions, inventory adjustments, loyalty
 * config, gift cards, categories, price schedules. School Admin and
 * STR-001:admin holders only.
 */
export async function assertStoreAdmin(
  actor: ResolvedActor,
  permCheck: PermissionCheckService,
  surface: string,
): Promise<void> {
  if (actor.isSchoolAdmin) return;
  if (actor.personType === 'GUARDIAN' || actor.personType === 'STUDENT') {
    throw new ForbiddenException(`${surface} is restricted to store administrators`);
  }
  const tenant = getCurrentTenant();
  const ok = await permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
    'str-001:admin',
    'str-001:write',
    'str-003:admin',
  ]);
  if (!ok) {
    throw new ForbiddenException(`${surface} is restricted to store administrators`);
  }
}

/**
 * Store read — any persona that holds STR-001/002/003 read or write.
 * Wishlists and balance lookups also accept GUARDIAN/STUDENT since
 * those are customer-facing surfaces; per-row authorisation is
 * the service-layer customer_person_id row scope.
 */
export async function assertStoreReader(
  actor: ResolvedActor,
  permCheck: PermissionCheckService,
  surface: string,
): Promise<void> {
  if (actor.isSchoolAdmin) return;
  const tenant = getCurrentTenant();
  const ok = await permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
    'str-001:read',
    'str-002:read',
    'str-003:read',
    'str-001:write',
    'str-002:write',
    'str-003:write',
    'str-001:admin',
  ]);
  if (!ok) {
    throw new ForbiddenException(`${surface} is restricted to school store users`);
  }
}

/**
 * Customer-facing store operations (wishlist add, loyalty balance
 * lookup, gift card redeem from a parent surface). Any authenticated
 * user with str-002:read OR str-001:read passes.
 */
export async function assertStoreCustomer(
  actor: ResolvedActor,
  permCheck: PermissionCheckService,
  surface: string,
): Promise<void> {
  if (actor.isSchoolAdmin) return;
  const tenant = getCurrentTenant();
  const ok = await permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
    'str-001:read',
    'str-002:read',
    'str-002:write',
  ]);
  if (!ok) {
    throw new ForbiddenException(`${surface} is restricted to authenticated store users`);
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
