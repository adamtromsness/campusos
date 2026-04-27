import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PermissionCheckService } from './permission-check.service';
import { getCurrentTenant } from '../tenant/tenant.context';

/**
 * Resolved caller identity used for row-level authorisation.
 *
 * Row-level filters (Cycle 1 review): a parent must only see their own
 * children, a student only themselves, a teacher only the students in
 * their assigned classes, an admin sees the school. The PermissionGuard
 * gates the *endpoint*; this service resolves the *row scope*.
 */
export interface ResolvedActor {
  accountId: string;
  personId: string;
  personType: string | null;
  isSchoolAdmin: boolean;
}

@Injectable()
export class ActorContextService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly permCheck: PermissionCheckService,
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

    return {
      accountId,
      personId,
      personType: person?.personType ?? null,
      isSchoolAdmin,
    };
  }
}
