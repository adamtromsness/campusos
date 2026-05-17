import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

export function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e.code === 'P2002') return true;
  if (e.code === 'P2010' && e.meta?.code === '23505') return true;
  if (e.code === '23505') return true;
  return typeof e.message === 'string' && e.message.includes('23505');
}

/**
 * `customer_person_id` on str_loyalty_transactions references
 * platform.iam_person. The service layer accepts the id from the
 * caller; before that id may be used for any balance read or ledger
 * write the helper verifies the person has a current-school
 * projection in one of:
 *   - sis_students (via platform_students.person_id chain)
 *   - sis_guardians (g.person_id)
 *   - hr_employees (e.person_id)
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
 * lookup, gift card redeem from a parent surface).
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
