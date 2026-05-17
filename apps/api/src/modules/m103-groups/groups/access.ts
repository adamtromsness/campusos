import { ForbiddenException } from '@nestjs/common';
import { getCurrentTenant } from '@shared/tenant';
import { TenantPrismaService } from '@shared/tenant';

/**
 * REVIEW-P2C28 Round 1 BLOCKING 2 fix — school-admin override paths
 * MUST still validate the target group belongs to the current school
 * before any create / update / delete / recompute. The GroupService
 * authorisation helpers short-circuit for school admins without
 * checking the group is in the current school, so a School A admin
 * with a School B group UUID would otherwise write across schools
 * inside the same tenant pool.
 *
 * `assertGroupInCurrentSchool(groupId)` is the single source of truth
 * — every advanced service calls it before insert / update / delete
 * on grp_group_polls / grp_resource_library / grp_group_invitations
 * / grp_group_events / grp_group_analytics rows scoped to a group.
 */
export async function assertGroupInCurrentSchool(
  tenantPrisma: TenantPrismaService,
  groupId: string,
): Promise<void> {
  const tenant = getCurrentTenant();
  const rows = (await tenantPrisma.executeInTenantContext(async (client) => {
    return client.$queryRawUnsafe(
      'SELECT 1 AS ok FROM grp_groups WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
      groupId,
      tenant.schoolId,
    );
  })) as Array<{ ok: number }>;
  if (rows.length === 0) {
    throw new ForbiddenException('Group does not belong to this school');
  }
}

/**
 * REVIEW-P2C28 Round 1 BLOCKING 3 fix — invited platform_users.id must
 * have a projection in the CURRENT SCHOOL, not just somewhere in the
 * tenant schema. School A group manager inviting a School B platform
 * user would otherwise succeed.
 */
export async function assertAccountInCurrentSchool(
  tenantPrisma: TenantPrismaService,
  accountId: string,
): Promise<void> {
  const tenant = getCurrentTenant();
  const rows = (await tenantPrisma.executeInTenantContext(async (client) => {
    return client.$queryRawUnsafe(
      'SELECT 1 AS ok FROM platform.platform_users pu WHERE pu.id = $1::uuid AND (' +
        'EXISTS (SELECT 1 FROM sis_students s ' +
        '  JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
        '  WHERE ps.person_id = pu.person_id AND s.school_id = $2::uuid) ' +
        'OR EXISTS (SELECT 1 FROM sis_student_guardians sg ' +
        '  JOIN sis_students s ON s.id = sg.student_id ' +
        '  JOIN sis_guardians g ON g.id = sg.guardian_id ' +
        '  WHERE g.person_id = pu.person_id AND s.school_id = $2::uuid) ' +
        'OR EXISTS (SELECT 1 FROM hr_employees e ' +
        '  WHERE e.person_id = pu.person_id AND e.school_id = $2::uuid) ' +
        ') LIMIT 1',
      accountId,
      tenant.schoolId,
    );
  })) as Array<{ ok: number }>;
  if (rows.length === 0) {
    throw new ForbiddenException('Invited account does not belong to a user in this school');
  }
}
