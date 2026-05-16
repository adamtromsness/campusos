import { BadRequestException } from '@nestjs/common';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';

export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e?.code === 'P2002') return true;
  if (e?.code === 'P2010' && e?.meta?.code === '23505') return true;
  if (typeof e?.message === 'string' && e.message.includes('23505')) return true;
  return false;
}

// REVIEW-CYCLE25 BLOCKING 1 / 2 / 3 / 4 — shared access helpers.
//
// canEditPublication: school admin OR pub-001:write OR pub-002:write OR
//                     a collaborator on the publication. Used as the
//                     "can read non-published content + sections + comments"
//                     gate.
// canApproveSection: school admin OR publication.created_by OR
//                    EDITOR/REVIEWER collaborator. The Section approval
//                    authority gate.
// assertAccountInCurrentTenant: validates a soft platform_users.id ref
//                               has at least one current-tenant projection
//                               in sis_students / sis_guardians / hr_employees.

export async function canEditPublication(
  tenantPrisma: TenantPrismaService,
  permCheck: PermissionCheckService,
  actor: ResolvedActor,
  publicationId: string,
): Promise<boolean> {
  if (actor.isSchoolAdmin) return true;
  const tenant = getCurrentTenant();
  const writerOk = await permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
    'pub-001:write',
    'pub-002:write',
  ]);
  if (writerOk && actor.personType === 'STAFF') return true;
  // Collaborator check — the actor's account holds a row on this publication.
  const rows = (await tenantPrisma.executeInTenantContext(async (client) => {
    return client.$queryRawUnsafe(
      'SELECT 1 FROM pub_publication_collaborators WHERE publication_id = $1::uuid AND user_id = $2::uuid LIMIT 1',
      publicationId,
      actor.accountId,
    );
  })) as Array<unknown>;
  return rows.length > 0;
}

export async function canApproveSection(
  tenantPrisma: TenantPrismaService,
  actor: ResolvedActor,
  publicationId: string,
): Promise<boolean> {
  if (actor.isSchoolAdmin) return true;
  const rows = (await tenantPrisma.executeInTenantContext(async (client) => {
    return client.$queryRawUnsafe(
      `SELECT 1 FROM pub_publications p WHERE p.id = $1::uuid AND p.created_by = $2::uuid LIMIT 1`,
      publicationId,
      actor.accountId,
    );
  })) as Array<unknown>;
  if (rows.length > 0) return true;
  const collab = (await tenantPrisma.executeInTenantContext(async (client) => {
    return client.$queryRawUnsafe(
      "SELECT 1 FROM pub_publication_collaborators WHERE publication_id = $1::uuid AND user_id = $2::uuid AND role IN ('EDITOR', 'REVIEWER') LIMIT 1",
      publicationId,
      actor.accountId,
    );
  })) as Array<unknown>;
  return collab.length > 0;
}

export async function isStudentCollaborator(
  tenantPrisma: TenantPrismaService,
  actor: ResolvedActor,
  publicationId: string,
): Promise<boolean> {
  if (actor.personType !== 'STUDENT') return false;
  const rows = (await tenantPrisma.executeInTenantContext(async (client) => {
    return client.$queryRawUnsafe(
      "SELECT 1 FROM pub_publication_collaborators WHERE publication_id = $1::uuid AND user_id = $2::uuid AND role IN ('EDITOR', 'CONTRIBUTOR') LIMIT 1",
      publicationId,
      actor.accountId,
    );
  })) as Array<unknown>;
  return rows.length > 0;
}

// REVIEW-CYCLE25 BLOCKING 4 — soft platform_users.id refs must point at a
// person who has a current-tenant projection. Walks sis_students (via
// platform_students.person_id) + sis_guardians.person_id + hr_employees.person_id.
//
// REVIEW-P2C26 R-M1 — each projection now carries a `school_id = tenant.schoolId`
// predicate so a cross-school user in the same tenant schema cannot satisfy
// the existence check. Without this, a School A staff editor could invite a
// School B user as a publication collaborator (or pass their accountId to
// any future feature that uses this helper) because both schools live in
// the same tenant schema today.
export async function assertAccountInCurrentTenant(
  tenantPrisma: TenantPrismaService,
  accountId: string,
  fieldName = 'accountId',
): Promise<void> {
  if (!accountId) {
    throw new BadRequestException(`${fieldName} is required`);
  }
  const tenant = getCurrentTenant();
  const rows = (await tenantPrisma.executeInTenantContext(async (client) => {
    return client.$queryRawUnsafe(
      `SELECT 1 FROM platform.platform_users pu
       WHERE pu.id = $1::uuid AND (
         EXISTS (
           SELECT 1 FROM sis_students s
           JOIN platform.platform_students ps ON ps.id = s.platform_student_id
           WHERE ps.person_id = pu.person_id AND s.school_id = $2::uuid
         )
         OR EXISTS (
           SELECT 1 FROM sis_guardians g WHERE g.person_id = pu.person_id AND g.school_id = $2::uuid
         )
         OR EXISTS (
           SELECT 1 FROM hr_employees e WHERE e.person_id = pu.person_id AND e.school_id = $2::uuid
         )
       )
       LIMIT 1`,
      accountId,
      tenant.schoolId,
    );
  })) as Array<unknown>;
  if (rows.length === 0) {
    throw new BadRequestException(`${fieldName} does not match a user in this school.`);
  }
}
