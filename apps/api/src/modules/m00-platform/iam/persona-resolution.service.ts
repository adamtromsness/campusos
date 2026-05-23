import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';

/**
 * PersonaResolutionService — discover + cache personas per person.
 *
 * A "persona" is one of the runtime roles a person plays on the platform:
 * PARENT, STUDENT, STAFF, SUBSTITUTE, ALUMNI, COMMUNITY. Personas are
 * never assigned by an admin; they're DERIVED from real actions captured
 * by projection tables (LINKED child, hr_employees row, sis_students,
 * sub_profile, alm_profile, grp_member).
 *
 * resolveForPerson — reads the projection tables and returns the live
 *   persona set. Slow: iterates every tenant schema. Call sparingly.
 * refreshPersonaCache — resolves, then UPSERTs platform_personas. Deletes
 *   rows that no longer have a backing projection.
 * getActivePersonas — fast read of platform_personas (hot path for
 *   /auth/me and /auth/switch-persona).
 *
 * Tenant-scoped projection tables (hr_employees, sis_students,
 * alm_alumni_profiles, grp_members) live inside each tenant schema; we
 * iterate platform_tenant_routing and query each distinct schema. The
 * cross-tenant fanout is acceptable because resolveForPerson runs on
 * persona-changing actions and login — never on the request hot path.
 */

export interface Persona {
  type: 'PARENT' | 'STUDENT' | 'STAFF' | 'SUBSTITUTE' | 'ALUMNI' | 'COMMUNITY';
  schoolId: string | null;
  label: string;
}

interface TenantSchema {
  schemaName: string;
  schoolId: string;
  schoolName: string;
}

@Injectable()
export class PersonaResolutionService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly tenantPrisma: TenantPrismaService,
  ) {}

  /**
   * Resolve the complete persona set for a person by reading every
   * projection table. Cross-tenant — iterates platform_tenant_routing.
   *
   * Returns an empty array if the person has no backing projections
   * (the "0 personas → Getting Started" state from the design doc).
   */
  async resolveForPerson(personId: string): Promise<Persona[]> {
    const personas: Persona[] = [];

    // SUBSTITUTE — platform schema, single query.
    const subProfile = await this.prisma.substituteProfile.findUnique({
      where: { personId },
      select: { id: true, isActive: true },
    });
    if (subProfile && subProfile.isActive) {
      personas.push({ type: 'SUBSTITUTE', schoolId: null, label: 'Substitute Teacher' });
    }

    // PARENT — any LINKED children in any family the person belongs to.
    // The PARENT persona's schoolId resolves to each school where one of
    // the LINKED children is enrolled (via tenant sis_students). If no
    // child has an enrolment yet, emit a single platform-wide PARENT row
    // so the parent persona still activates (Scenario A — parent has
    // children, no school selected yet).
    const linkedChildren = await this.prisma.$queryRawUnsafe<Array<{ child_person_id: string }>>(
      `SELECT DISTINCT pfc.person_id::text AS child_person_id
       FROM platform.platform_family_children pfc
       JOIN platform.platform_family_members pfm ON pfm.family_id = pfc.family_id
       WHERE pfm.person_id = $1::uuid
         AND pfc.status = 'LINKED'
         AND pfc.person_id IS NOT NULL`,
      personId,
    );

    const tenants = await this.listTenantSchemas();

    if (linkedChildren.length > 0) {
      const childIds = linkedChildren.map((r) => r.child_person_id);
      const schoolsWithChildren = await this.getSchoolsWithEnrolledStudents(tenants, childIds);
      if (schoolsWithChildren.length > 0) {
        for (const s of schoolsWithChildren) {
          personas.push({
            type: 'PARENT',
            schoolId: s.schoolId,
            label: `Parent at ${s.schoolName}`,
          });
        }
      } else {
        personas.push({ type: 'PARENT', schoolId: null, label: 'Parent' });
      }
    }

    // STAFF / STUDENT / ALUMNI / COMMUNITY — iterate tenant schemas.
    const seenSchemas = new Set<string>();
    for (const t of tenants) {
      if (seenSchemas.has(t.schemaName)) continue;
      seenSchemas.add(t.schemaName);
      await this.tenantPrisma.executeInExplicitSchema(t.schemaName, async (client) => {
        // STAFF
        const employments = await client.$queryRawUnsafe<
          Array<{ school_id: string; school_name: string; employment_status: string }>
        >(
          `SELECT e.school_id::text AS school_id,
                  s.name AS school_name,
                  e.employment_status
           FROM hr_employees e
           JOIN platform.schools s ON s.id = e.school_id
           WHERE e.person_id = $1::uuid
             AND e.employment_status IN ('ACTIVE', 'ON_LEAVE')`,
          personId,
        );
        for (const e of employments) {
          personas.push({
            type: 'STAFF',
            schoolId: e.school_id,
            label: `Staff at ${e.school_name}`,
          });
        }

        // STUDENT — sis_students projects platform_students(person_id).
        const enrolments = await client.$queryRawUnsafe<
          Array<{ school_id: string; school_name: string }>
        >(
          `SELECT st.school_id::text AS school_id, sc.name AS school_name
           FROM sis_students st
           JOIN platform.platform_students ps ON ps.id = st.platform_student_id
           JOIN platform.schools sc ON sc.id = st.school_id
           WHERE ps.person_id = $1::uuid
             AND st.enrollment_status = 'ENROLLED'`,
          personId,
        );
        for (const en of enrolments) {
          personas.push({
            type: 'STUDENT',
            schoolId: en.school_id,
            label: `Student at ${en.school_name}`,
          });
        }

        // ALUMNI
        const alumni = await client.$queryRawUnsafe<
          Array<{ school_id: string; school_name: string; graduation_year: number }>
        >(
          `SELECT a.school_id::text AS school_id,
                  s.name AS school_name,
                  a.graduation_year
           FROM alm_alumni_profiles a
           JOIN platform.schools s ON s.id = a.school_id
           WHERE a.person_id = $1::uuid`,
          personId,
        );
        for (const al of alumni) {
          personas.push({
            type: 'ALUMNI',
            schoolId: al.school_id,
            label: `Alumni — ${al.school_name} ${al.graduation_year}`,
          });
        }

        // COMMUNITY — active grp_members rows. Group can be scoped to a
        // school or be platform-wide; for the persona we collapse to a
        // single COMMUNITY row per tenant since the group app surface
        // doesn't need per-school disambiguation.
        const communityCount = await client.$queryRawUnsafe<Array<{ cnt: bigint }>>(
          `SELECT COUNT(*) AS cnt FROM grp_members
           WHERE person_id = $1::uuid AND status = 'ACTIVE'`,
          personId,
        );
        if (communityCount[0] && Number(communityCount[0].cnt) > 0) {
          personas.push({
            type: 'COMMUNITY',
            schoolId: t.schoolId,
            label: `Community member at ${t.schoolName}`,
          });
        }
      });
    }

    return personas;
  }

  /**
   * Resolve fresh personas and reconcile platform_personas to match.
   * UPSERTs each resolved persona; deletes any cached row that no longer
   * has a backing projection. Idempotent — safe to re-run.
   */
  async refreshPersonaCache(personId: string): Promise<void> {
    const resolved = await this.resolveForPerson(personId);

    const existing = await this.prisma.platformPersona.findMany({
      where: { personId },
      select: { id: true, type: true, schoolId: true },
    });

    const keyOf = (p: { type: string; schoolId: string | null }): string =>
      `${p.type}|${p.schoolId ?? '_'}`;

    const resolvedKeys = new Set<string>(resolved.map(keyOf));
    const staleIds = existing.filter((r) => !resolvedKeys.has(keyOf(r))).map((r) => r.id);
    if (staleIds.length > 0) {
      await this.prisma.platformPersona.deleteMany({ where: { id: { in: staleIds } } });
    }

    for (const p of resolved) {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO platform.platform_personas (id, person_id, type, school_id, label, is_active, created_at)
         VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, true, now())
         ON CONFLICT (person_id, type, COALESCE(school_id, '00000000-0000-0000-0000-000000000000'::uuid))
         DO UPDATE SET label = EXCLUDED.label, is_active = true`,
        generateId(),
        personId,
        p.type,
        p.schoolId,
        p.label,
      );
    }
  }

  /**
   * Hot-path read of cached personas for /auth/me and persona switcher.
   * Returns rows verbatim from platform_personas where is_active=true.
   */
  async getActivePersonas(
    personId: string,
  ): Promise<Array<{ id: string; type: string; schoolId: string | null; label: string }>> {
    const rows = await this.prisma.platformPersona.findMany({
      where: { personId, isActive: true },
      orderBy: [{ type: 'asc' }, { label: 'asc' }],
      select: { id: true, type: true, schoolId: true, label: true },
    });
    return rows;
  }

  // ─── helpers ────────────────────────────────────────────────

  private async listTenantSchemas(): Promise<TenantSchema[]> {
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ schema_name: string; school_id: string; school_name: string }>
    >(
      `SELECT r.schema_name AS schema_name,
              r.tenant_id::text AS school_id,
              s.name AS school_name
       FROM platform.platform_tenant_routing r
       JOIN platform.schools s ON s.id = r.tenant_id
       WHERE r.is_active = true`,
    );
    return rows.map((r) => ({
      schemaName: r.schema_name,
      schoolId: r.school_id,
      schoolName: r.school_name,
    }));
  }

  private async getSchoolsWithEnrolledStudents(
    tenants: TenantSchema[],
    childPersonIds: string[],
  ): Promise<Array<{ schoolId: string; schoolName: string }>> {
    if (childPersonIds.length === 0) return [];
    const seenSchools = new Set<string>();
    const result: Array<{ schoolId: string; schoolName: string }> = [];
    const seenSchemas = new Set<string>();
    for (const t of tenants) {
      if (seenSchemas.has(t.schemaName)) continue;
      seenSchemas.add(t.schemaName);
      const rows = await this.tenantPrisma.executeInExplicitSchema(t.schemaName, async (client) => {
        return client.$queryRawUnsafe<Array<{ school_id: string; school_name: string }>>(
          `SELECT DISTINCT st.school_id::text AS school_id, sc.name AS school_name
           FROM sis_students st
           JOIN platform.platform_students ps ON ps.id = st.platform_student_id
           JOIN platform.schools sc ON sc.id = st.school_id
           WHERE ps.person_id = ANY($1::uuid[])
             AND st.enrollment_status = 'ENROLLED'`,
          childPersonIds,
        );
      });
      for (const r of rows) {
        if (seenSchools.has(r.school_id)) continue;
        seenSchools.add(r.school_id);
        result.push({ schoolId: r.school_id, schoolName: r.school_name });
      }
    }
    return result;
  }
}
