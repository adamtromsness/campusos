import type { ResolvedActor } from '../iam/actor-context.service';
import type { TenantPrismaService } from '../tenant/tenant-prisma.service';

/**
 * Shared portfolio-domain access + tenant helpers used by the P2-27
 * Step 5 + 6 services. Extracted from portfolio.service.ts so the
 * section / reflection / endorsement / readiness / college /
 * resume services can reuse the canonical row-scope logic without
 * mutual-injection between the request-path service files.
 */

export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e?.code === 'P2002') return true;
  if (e?.code === 'P2010' && e?.meta?.code === '23505') return true;
  if (typeof e?.message === 'string' && e.message.includes('23505')) return true;
  return false;
}

export async function resolveStudentIdForActor(
  tenantPrisma: TenantPrismaService,
  actor: ResolvedActor,
): Promise<string | null> {
  if (actor.personType !== 'STUDENT') return null;
  const rows = (await tenantPrisma.executeInTenantContext(async (client) => {
    return client.$queryRawUnsafe(
      'SELECT s.id::text AS id FROM sis_students s JOIN platform.platform_students ps ON ps.id = s.platform_student_id WHERE ps.person_id = $1::uuid LIMIT 1',
      actor.personId,
    );
  })) as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

export async function isAssignedTeacherOf(
  tenantPrisma: TenantPrismaService,
  actor: ResolvedActor,
  studentId: string,
): Promise<boolean> {
  if (actor.personType !== 'STAFF' || !actor.employeeId) return false;
  const rows = (await tenantPrisma.executeInTenantContext(async (client) => {
    return client.$queryRawUnsafe(
      "SELECT 1 FROM sis_class_teachers ct JOIN sis_enrollments e ON e.class_id = ct.class_id WHERE ct.teacher_employee_id = $1::uuid AND e.student_id = $2::uuid AND e.status = 'ACTIVE' LIMIT 1",
      actor.employeeId,
      studentId,
    );
  })) as Array<unknown>;
  return rows.length > 0;
}

export async function isLinkedGuardianOf(
  tenantPrisma: TenantPrismaService,
  actor: ResolvedActor,
  studentId: string,
): Promise<boolean> {
  if (actor.personType !== 'GUARDIAN') return false;
  const rows = (await tenantPrisma.executeInTenantContext(async (client) => {
    return client.$queryRawUnsafe(
      'SELECT 1 FROM sis_student_guardians sg JOIN sis_guardians g ON g.id = sg.guardian_id WHERE g.person_id = $1::uuid AND sg.student_id = $2::uuid LIMIT 1',
      actor.personId,
      studentId,
    );
  })) as Array<unknown>;
  return rows.length > 0;
}

/**
 * Resolves whether the actor is the owning student for the given
 * student id. Returns true for an admin (admin override on owner
 * scope is the canonical contract), the owning student, or any
 * STAFF / GUARDIAN who can pass the assigned-teacher / linked-
 * guardian row-scope check. PRIVATE / TEACHER / PARENT / PUBLIC
 * visibility is enforced by the caller — this helper is the
 * row-scope primitive.
 */
export async function isOwningStudent(
  tenantPrisma: TenantPrismaService,
  actor: ResolvedActor,
  studentId: string,
): Promise<boolean> {
  if (actor.isSchoolAdmin) return true;
  const ownerStudentId = await resolveStudentIdForActor(tenantPrisma, actor);
  return ownerStudentId === studentId;
}

/**
 * Counsellor scope = isSchoolAdmin OR holds ach-003:write at the
 * tenant scope. The Step 5 + 6 services that gate counsellor-only
 * surfaces (pathway assignment, milestone update, etc.) use this.
 * The IAM seed grants ach-003:write to Staff + Counsellor + Student
 * — the service still narrows by persona where appropriate (e.g.
 * a student updating own milestone progress).
 */
