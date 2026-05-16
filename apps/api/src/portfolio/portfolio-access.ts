import type { ResolvedActor } from '../iam/actor-context.service';
import type { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';

/**
 * Shared portfolio-domain access + tenant helpers used by the P2-27
 * Step 5 + 6 services. Extracted from portfolio.service.ts so the
 * section / reflection / endorsement / readiness / college /
 * resume services reuse the canonical row-scope logic without
 * mutual-injection between request-path service files.
 *
 * REVIEW-P2C27 BLOCKING 2 — every helper carries the current school
 * predicate so cross-school identities in a shared multi-school
 * tenant schema cannot satisfy owner / guardian / assigned-teacher
 * checks. The predicate joins through `sis_students.school_id` (the
 * canonical student-school binding) and matches the Phase 2 standard
 * established by P2-25 + P2-26.
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
  const tenant = getCurrentTenant();
  const rows = (await tenantPrisma.executeInTenantContext(async (client) => {
    return client.$queryRawUnsafe(
      `SELECT s.id::text AS id
       FROM sis_students s
       JOIN platform.platform_students ps ON ps.id = s.platform_student_id
       WHERE ps.person_id = $1::uuid
         AND s.school_id = $2::uuid
       LIMIT 1`,
      actor.personId,
      tenant.schoolId,
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
  const tenant = getCurrentTenant();
  const rows = (await tenantPrisma.executeInTenantContext(async (client) => {
    return client.$queryRawUnsafe(
      `SELECT 1
       FROM sis_class_teachers ct
       JOIN sis_enrollments e ON e.class_id = ct.class_id
       JOIN sis_students s ON s.id = e.student_id
       WHERE ct.teacher_employee_id = $1::uuid
         AND e.student_id = $2::uuid
         AND e.status = 'ACTIVE'
         AND s.school_id = $3::uuid
       LIMIT 1`,
      actor.employeeId,
      studentId,
      tenant.schoolId,
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
  const tenant = getCurrentTenant();
  const rows = (await tenantPrisma.executeInTenantContext(async (client) => {
    return client.$queryRawUnsafe(
      `SELECT 1
       FROM sis_student_guardians sg
       JOIN sis_guardians g ON g.id = sg.guardian_id
       JOIN sis_students s ON s.id = sg.student_id
       WHERE g.person_id = $1::uuid
         AND sg.student_id = $2::uuid
         AND s.school_id = $3::uuid
       LIMIT 1`,
      actor.personId,
      studentId,
      tenant.schoolId,
    );
  })) as Array<unknown>;
  return rows.length > 0;
}

/**
 * Resolves whether the actor is the owning student for the given
 * student id. Returns true for an admin (admin override), the owning
 * student in the current school, or for STAFF / GUARDIAN callers via
 * the school-scoped relationship helpers. PRIVATE / TEACHER / PARENT /
 * PUBLIC visibility is enforced by the caller — this helper is the
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
 * Validate that a supplied studentId belongs to the current school
 * before performing any mutation that references it. Returns true on
 * a match. Used by services that accept a studentId argument from
 * the caller (e.g. pathway assignment, college application creation,
 * resume access) to fail fast with 400 before INSERTing a row that
 * would otherwise carry a foreign-school student_id.
 */
export async function isStudentInCurrentSchool(
  tenantPrisma: TenantPrismaService,
  studentId: string,
): Promise<boolean> {
  const tenant = getCurrentTenant();
  const rows = (await tenantPrisma.executeInTenantContext(async (client) => {
    return client.$queryRawUnsafe(
      'SELECT 1 FROM sis_students WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
      studentId,
      tenant.schoolId,
    );
  })) as Array<unknown>;
  return rows.length > 0;
}
