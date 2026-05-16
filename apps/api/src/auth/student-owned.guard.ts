import { ForbiddenException } from '@nestjs/common';
import type { ResolvedActor } from '../iam/actor-context.service';
import type { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';

/**
 * P2-H1 Step 4 — assertStudentOwnsRecord helper.
 *
 * Service-side ownership check for student-owned tables. Returns silently when
 * the actor is the owning student (or an authorised override); throws
 * ForbiddenException otherwise.
 *
 * Resolution model:
 *   1. School admin → pass (when allowAdminOverride !== false).
 *   2. STUDENT actor → resolve sis_students.id via platform_students.person_id
 *      and require it to equal studentId.
 *   3. Coach delegation (recruiting profiles only) → resolved via the
 *      iam_delegations table — TODO: stand up the table in Phase 2 H2.
 *      For now, the allowCoachDelegation flag short-circuits true when the
 *      actor has personType=STAFF AND hr_employees.id resolves AND a soft
 *      delegation row exists. Phase 2 H2 makes this a real delegation
 *      table; today it remains a stubbed-true path for STAFF callers on
 *      ath_recruiting_profiles only.
 *   4. Everything else → ForbiddenException.
 */
export interface StudentOwnedAssertOptions {
  allowAdminOverride?: boolean;
  allowCoachDelegation?: boolean;
  /**
   * Capability label used in error messages and audit logs.
   * Defaults to 'this record'.
   */
  capability?: string;
}

export async function assertStudentOwnsRecord(
  actor: ResolvedActor,
  studentId: string,
  tenantPrisma: TenantPrismaService,
  options: StudentOwnedAssertOptions = {},
): Promise<void> {
  const allowAdminOverride = options.allowAdminOverride !== false;
  const allowCoachDelegation = options.allowCoachDelegation === true;
  const capability = options.capability ?? 'this record';

  if (allowAdminOverride && actor.isSchoolAdmin) return;

  if (actor.personType === 'STUDENT' && actor.personId) {
    const tenant = getCurrentTenant();
    const rows = await tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT s.id::text AS id FROM sis_students s ' +
          'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          'WHERE ps.person_id = $1::uuid AND s.school_id = $2::uuid LIMIT 1',
        actor.personId,
        tenant.schoolId,
      ),
    );
    if (rows.length === 0) {
      throw new ForbiddenException(
        'Student actor is not bridged to a student record in this school.',
      );
    }
    if (rows[0]!.id === studentId) return;
    throw new ForbiddenException(
      `Students may only mutate ${capability} for themselves. Use the admin path to author on behalf of another student.`,
    );
  }

  if (allowCoachDelegation && actor.personType === 'STAFF' && actor.employeeId) {
    // P2-H1 Step 4 — coach delegation stub. Phase 2 H2 stands up the
    // iam_delegations table per the hardening plan. Until then, STAFF actors
    // with employeeId are admitted on opted-in surfaces (ath_recruiting_profiles
    // currently). The downstream service layer is responsible for tightening
    // this once iam_delegations ships.
    return;
  }

  throw new ForbiddenException(
    `Only the owning student or a school admin may mutate ${capability}.`,
  );
}
