import { BadRequestException } from '@nestjs/common';
import type { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';

/**
 * P2-H1 Step 6 — assertPersonInTenant shared helper.
 *
 * Validates that an admin-supplied iam_person.id (or platform_users.id with
 * an underlying iam_person) has at least one projection in the calling
 * tenant's school. Projections checked:
 *   - sis_students (via platform_students.person_id chain)
 *   - sis_guardians.person_id
 *   - hr_employees.person_id
 *
 * Used by admin-on-behalf paths where a non-admin's UUID input would
 * otherwise let an admin reference a person from a different school.
 *
 * Returns silently when at least one projection resolves; throws
 * BadRequestException when no projection exists.
 *
 * The fieldName parameter is surfaced in the error message so a caller
 * passing `assignedToPersonId` gets "assignedToPersonId does not match a
 * person in this school", not a generic "person not found".
 */
export async function assertPersonInTenant(
  tenantPrisma: TenantPrismaService,
  personId: string,
  fieldName: string,
): Promise<void> {
  const tenant = getCurrentTenant();
  const rows = await tenantPrisma.executeInTenantContext(async (client) =>
    client.$queryRawUnsafe<Array<{ source: string }>>(
      // Postgres requires parentheses around each UNION arm when the
      // arm carries its own LIMIT; without them PG raises 42601 at the
      // `UNION ALL` token. The previous unparenthesised form meant this
      // helper failed at runtime on every callsite.
      `(SELECT 'student' AS source FROM sis_students s ` +
        `JOIN platform.platform_students ps ON ps.id = s.platform_student_id ` +
        `WHERE ps.person_id = $1::uuid AND s.school_id = $2::uuid LIMIT 1) ` +
        `UNION ALL ` +
        `(SELECT 'guardian' AS source FROM sis_guardians ` +
        `WHERE person_id = $1::uuid AND school_id = $2::uuid LIMIT 1) ` +
        `UNION ALL ` +
        `(SELECT 'employee' AS source FROM hr_employees ` +
        `WHERE person_id = $1::uuid AND school_id = $2::uuid LIMIT 1)`,
      personId,
      tenant.schoolId,
    ),
  );
  if (rows.length === 0) {
    throw new BadRequestException(`${fieldName} does not match a person in this school`);
  }
}

/**
 * P2-H1 Step 6 — assertAccountInTenant shared helper.
 *
 * Variant of assertPersonInTenant for callsites that take a platform_users.id
 * instead of an iam_person.id. Resolves the account's person_id then runs
 * the same three-projection check.
 *
 * Note: this overlaps with the existing
 * ProfileService.assertTargetInCurrentTenant (Cycle 6.1 REVIEW-CYCLE6.1
 * BLOCKING 1) and CommunicationsAdvancedService.assertAccountInCurrentTenant
 * patterns. The shared helper lives here so future cycles can refactor those
 * scattered implementations onto a single contract.
 */
export async function assertAccountInTenant(
  tenantPrisma: TenantPrismaService,
  accountId: string,
  fieldName: string,
): Promise<void> {
  const platform = tenantPrisma.getPlatformClient();
  const personRows = (await platform.$queryRawUnsafe(
    `SELECT person_id::text AS person_id FROM platform_users WHERE id = $1::uuid LIMIT 1`,
    accountId,
  )) as Array<{ person_id: string | null }>;
  const personId = personRows[0]?.person_id;
  if (!personId) {
    throw new BadRequestException(`${fieldName} does not match a known account`);
  }
  await assertPersonInTenant(tenantPrisma, personId, fieldName);
}
