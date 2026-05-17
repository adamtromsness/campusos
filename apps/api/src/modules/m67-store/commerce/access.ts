import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

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

/**
 * REVIEW-P2C29 Round 1 BLOCKING 1 fix — loyalty customer affiliation.
 *
 * `customer_person_id` on str_loyalty_transactions references
 * platform.iam_person. The service layer accepts the id from the
 * caller; before that id may be used for any balance read or ledger
 * write the helper verifies the person has a current-school
 * projection in one of:
 *   - sis_students (via platform_students.person_id chain)
 *   - sis_guardians (g.person_id)
 *   - hr_employees (e.person_id)
 *
 * External customers (Cycle 28 `str_external_customers`) are NOT
 * supported by loyalty in the current schema because the column is
 * NOT NULL UUID referencing iam_person — external customers don't
 * carry a person id. A future cycle that wants external loyalty
 * would either widen the column to nullable + add a separate
 * external_customer_id column or projection.
 *
 * Throws BadRequestException with the offending UUID so the operator
 * can debug; admins do not bypass — every loyalty mutation must
 * reference a current-school customer.
 */
export async function assertCustomerAffiliatedWithSchool(
  tenantPrisma: TenantPrismaService,
  customerPersonId: string,
): Promise<void> {
  const tenant = getCurrentTenant();
  const rows = (await tenantPrisma.executeInTenantContext(async (client) => {
    return client.$queryRawUnsafe(
      'SELECT 1 AS ok WHERE EXISTS (' +
        'SELECT 1 FROM sis_students s ' +
        '  JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
        '  WHERE ps.person_id = $1::uuid AND s.school_id = $2::uuid' +
        ') OR EXISTS (' +
        'SELECT 1 FROM sis_student_guardians sg ' +
        '  JOIN sis_guardians g ON g.id = sg.guardian_id ' +
        '  JOIN sis_students s ON s.id = sg.student_id ' +
        '  WHERE g.person_id = $1::uuid AND s.school_id = $2::uuid' +
        ') OR EXISTS (' +
        'SELECT 1 FROM hr_employees e ' +
        '  WHERE e.person_id = $1::uuid AND e.school_id = $2::uuid' +
        ') LIMIT 1',
      customerPersonId,
      tenant.schoolId,
    );
  })) as Array<{ ok: number }>;
  if (rows.length === 0) {
    throw new BadRequestException(
      `customerPersonId ${customerPersonId} does not match a student, guardian, or employee affiliated with this school`,
    );
  }
}

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
