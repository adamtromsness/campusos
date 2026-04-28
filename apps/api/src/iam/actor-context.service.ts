import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PermissionCheckService } from './permission-check.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';

/**
 * Resolved caller identity used for row-level authorisation.
 *
 * Row-level filters (Cycle 1 review): a parent must only see their own
 * children, a student only themselves, a teacher only the students in
 * their assigned classes, an admin sees the school. The PermissionGuard
 * gates the *endpoint*; this service resolves the *row scope*.
 *
 * employeeId (Cycle 4 Step 0): for STAFF personas with an active
 * hr_employees row in the current tenant, this is the canonical id used
 * by sis_class_teachers.teacher_employee_id, cls_grades.teacher_id,
 * cls_lessons.teacher_id, and cls_student_progress_notes.author_id.
 * Null for parents, students, and any staff member without an
 * hr_employees row (e.g. the Platform Admin persona).
 */
export interface ResolvedActor {
  accountId: string;
  personId: string;
  employeeId: string | null;
  personType: string | null;
  isSchoolAdmin: boolean;
}

@Injectable()
export class ActorContextService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly permCheck: PermissionCheckService,
    private readonly tenantPrisma: TenantPrismaService,
  ) {}

  /**
   * Resolve the actor profile for the current request. School-admin status
   * is checked against the *current tenant's* scope chain only (school
   * then platform) — never across all cached scopes. A Platform Admin
   * inherits admin status via the platform scope; a teacher at school A
   * does not gain admin status against school B.
   *
   * sch-001:admin (School Administration admin tier) is the canonical
   * "school admin" code. Platform Admins hold it via the platform scope
   * because they're assigned the all-permissions role.
   */
  async resolveActor(accountId: string, personId: string): Promise<ResolvedActor> {
    var tenant = getCurrentTenant();

    var person = await this.prisma.iamPerson.findUnique({
      where: { id: personId },
      select: { personType: true },
    });

    var isSchoolAdmin = await this.permCheck.hasAnyPermissionInTenant(accountId, tenant.schoolId, [
      'sch-001:admin',
    ]);

    var employeeId = await this.resolveEmployeeId(personId);

    return {
      accountId,
      personId,
      employeeId,
      personType: person?.personType ?? null,
      isSchoolAdmin,
    };
  }

  /**
   * Resolve the active hr_employees.id for the calling iam_person within
   * the current tenant. Returns null for non-staff personas, terminated /
   * suspended employees, and the Platform Admin persona (which has no
   * hr_employees row by design).
   */
  private async resolveEmployeeId(personId: string): Promise<string | null> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ id: string }>>(
        "SELECT id::text AS id FROM hr_employees WHERE person_id = $1::uuid AND employment_status = 'ACTIVE' LIMIT 1",
        personId,
      );
    });
    return rows[0]?.id ?? null;
  }
}
