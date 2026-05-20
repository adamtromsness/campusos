import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import { PermissionCheckService } from '@modules/m00-platform';
import type { ResolvedActor } from '@modules/m00-platform';
import {
  isLinkedGuardianOf,
  isStudentInCurrentSchool,
  isUniqueViolation,
  resolveStudentIdForActor,
} from './portfolio-access';
import type {
  GenerateResumePdfResponseDto,
  ResumeProfileDto,
  UpdateResumeDto,
} from './dto/portfolio-advanced.dto';

interface ResumeRow {
  id: string;
  student_id: string;
  student_name: string | null;
  objective_statement: string | null;
  skills: string[];
  work_experience: unknown[];
  extracurriculars: unknown[];
  awards: unknown[];
  service_hours_total: number;
  references: unknown[];
  pdf_s3_key: string | null;
  last_generated_at: string | null;
  created_at: string;
  updated_at: string;
}

// REVIEW-P2C27 BLOCKING 6 — every resume read joins through sis_students
// so the school predicate is bound on every list / get / reload.
const SELECT_RESUME_BASE = `
  SELECT
    r.id::text AS id,
    r.student_id::text AS student_id,
    (SELECT ip.first_name || ' ' || ip.last_name
       FROM platform.platform_students ps
       JOIN platform.iam_person ip ON ip.id = ps.person_id
       WHERE ps.id = s.platform_student_id LIMIT 1) AS student_name,
    r.objective_statement,
    r.skills,
    r.work_experience,
    r.extracurriculars,
    r.awards,
    r.service_hours_total,
    r."references",
    r.pdf_s3_key,
    r.last_generated_at::text AS last_generated_at,
    r.created_at::text AS created_at,
    r.updated_at::text AS updated_at
  FROM pfl_resume_profiles r
  JOIN sis_students s ON s.id = r.student_id
`;

@Injectable()
export class ResumeService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  private rowToDto(r: ResumeRow): ResumeProfileDto {
    return {
      id: r.id,
      studentId: r.student_id,
      studentName: r.student_name,
      objectiveStatement: r.objective_statement,
      skills: r.skills,
      workExperience: Array.isArray(r.work_experience) ? r.work_experience : [],
      extracurriculars: Array.isArray(r.extracurriculars) ? r.extracurriculars : [],
      awards: Array.isArray(r.awards) ? r.awards : [],
      serviceHoursTotal: Number(r.service_hours_total),
      references: Array.isArray(r.references) ? r.references : [],
      pdfS3Key: r.pdf_s3_key,
      lastGeneratedAt: r.last_generated_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private async hasCounsellorScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'ach-003:write',
      'ach-003:admin',
    ]);
  }

  private async assertOwnerOrAdminFor(actor: ResolvedActor, studentId: string): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const ownerStudentId = await resolveStudentIdForActor(this.tenantPrisma, actor);
    if (ownerStudentId === studentId) return;
    throw new ForbiddenException(
      'Resume is student-owned. Only the owning student or a school admin can edit.',
    );
  }

  async getForStudent(studentId: string, actor: ResolvedActor): Promise<ResumeProfileDto> {
    const tenant = getCurrentTenant();
    // REVIEW-P2C27 BLOCKING 6 — the studentId must belong to the calling
    // school before any read / auto-create fires.
    const studentOk = await isStudentInCurrentSchool(this.tenantPrisma, studentId);
    if (!studentOk) {
      throw new NotFoundException('Resume not found');
    }
    if (!actor.isSchoolAdmin) {
      const ownerStudentId = await resolveStudentIdForActor(this.tenantPrisma, actor);
      const isOwner = ownerStudentId === studentId;
      const isGuardian = await isLinkedGuardianOf(this.tenantPrisma, actor, studentId);
      const isCounsellor = await this.hasCounsellorScope(actor);
      if (!isOwner && !isGuardian && !isCounsellor) {
        throw new NotFoundException('Resume not found');
      }
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_RESUME_BASE + ' WHERE r.student_id = $1::uuid AND s.school_id = $2::uuid LIMIT 1',
        studentId,
        tenant.schoolId,
      );
    })) as ResumeRow[];
    if (rows.length === 0) {
      // Auto-create — owner / admin only.
      const ownerStudentId = await resolveStudentIdForActor(this.tenantPrisma, actor);
      if (!actor.isSchoolAdmin && ownerStudentId !== studentId) {
        throw new NotFoundException('Resume not found');
      }
      const id = generateId();
      try {
        await this.tenantPrisma.executeInTenantContext(async (client) => {
          await client.$executeRawUnsafe(
            'INSERT INTO pfl_resume_profiles (id, student_id) VALUES ($1::uuid, $2::uuid)',
            id,
            studentId,
          );
        });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
      const created = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          SELECT_RESUME_BASE + ' WHERE r.student_id = $1::uuid AND s.school_id = $2::uuid LIMIT 1',
          studentId,
          tenant.schoolId,
        );
      })) as ResumeRow[];
      return this.rowToDto(created[0]!);
    }
    return this.rowToDto(rows[0]!);
  }

  async patch(
    studentId: string,
    actor: ResolvedActor,
    input: UpdateResumeDto,
  ): Promise<ResumeProfileDto> {
    await this.assertOwnerOrAdminFor(actor, studentId);
    // REVIEW-P2C27 BLOCKING 6 — defence-in-depth: the studentId must belong
    // to the current school.
    const studentOk = await isStudentInCurrentSchool(this.tenantPrisma, studentId);
    if (!studentOk) {
      throw new NotFoundException('Resume not found');
    }
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (client) => {
      const existing = (await client.$queryRawUnsafe(
        `SELECT r.id::text AS id
         FROM pfl_resume_profiles r
         JOIN sis_students s ON s.id = r.student_id
         WHERE r.student_id = $1::uuid AND s.school_id = $2::uuid
         LIMIT 1 FOR UPDATE OF r`,
        studentId,
        tenant.schoolId,
      )) as Array<{ id: string }>;
      if (existing.length === 0) {
        const id = generateId();
        try {
          await client.$executeRawUnsafe(
            'INSERT INTO pfl_resume_profiles (id, student_id) VALUES ($1::uuid, $2::uuid)',
            id,
            studentId,
          );
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
        }
      }

      const sets: string[] = [];
      const params: unknown[] = [];
      const push = (col: string, value: unknown, cast?: string) => {
        params.push(value);
        sets.push(`${col} = $${params.length}${cast ?? ''}`);
      };
      if (input.objectiveStatement !== undefined)
        push('objective_statement', input.objectiveStatement);
      if (input.skills !== undefined) push('skills', input.skills);
      if (input.workExperience !== undefined)
        push('work_experience', JSON.stringify(input.workExperience), '::jsonb');
      if (input.extracurriculars !== undefined)
        push('extracurriculars', JSON.stringify(input.extracurriculars), '::jsonb');
      if (input.awards !== undefined) push('awards', JSON.stringify(input.awards), '::jsonb');
      if (input.serviceHoursTotal !== undefined)
        push('service_hours_total', input.serviceHoursTotal);
      if (input.references !== undefined)
        push('"references"', JSON.stringify(input.references), '::jsonb');
      if (sets.length === 0) {
        const cur = (await client.$queryRawUnsafe(
          SELECT_RESUME_BASE + ' WHERE r.student_id = $1::uuid AND s.school_id = $2::uuid',
          studentId,
          tenant.schoolId,
        )) as ResumeRow[];
        return this.rowToDto(cur[0]!);
      }
      sets.push('updated_at = now()');
      params.push(studentId);
      params.push(tenant.schoolId);
      // REVIEW-P2C27 BLOCKING 6 — UPDATE joins through sis_students so the
      // school predicate is enforced on the write.
      await client.$executeRawUnsafe(
        `UPDATE pfl_resume_profiles AS upd
         SET ${sets.join(', ')}
         FROM sis_students s
         WHERE s.id = upd.student_id
           AND upd.student_id = $${params.length - 1}::uuid
           AND s.school_id = $${params.length}::uuid`,
        ...params,
      );
      const after = (await client.$queryRawUnsafe(
        SELECT_RESUME_BASE + ' WHERE r.student_id = $1::uuid AND s.school_id = $2::uuid',
        studentId,
        tenant.schoolId,
      )) as ResumeRow[];
      return this.rowToDto(after[0]!);
    });
  }

  /**
   * Generate (or regenerate) the resume PDF. Pulls cross-module data
   * with every aggregation school-scoped through sis_students (REVIEW-
   * P2C27 BLOCKING 6).
   */
  async generatePdf(
    studentId: string,
    actor: ResolvedActor,
  ): Promise<GenerateResumePdfResponseDto> {
    await this.assertOwnerOrAdminFor(actor, studentId);
    // REVIEW-P2C27 BLOCKING 6 — defence-in-depth: studentId must be in
    // current school before any cross-module aggregation fires.
    const studentOk = await isStudentInCurrentSchool(this.tenantPrisma, studentId);
    if (!studentOk) {
      throw new NotFoundException('Resume not found');
    }
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (client) => {
      const existing = (await client.$queryRawUnsafe(
        SELECT_RESUME_BASE +
          ' WHERE r.student_id = $1::uuid AND s.school_id = $2::uuid LIMIT 1 FOR UPDATE OF r',
        studentId,
        tenant.schoolId,
      )) as ResumeRow[];
      if (existing.length === 0) {
        throw new BadRequestException(
          'Resume profile must be initialised before PDF generation. PATCH /portfolio/resume/:studentId first.',
        );
      }
      const resume = existing[0]!;

      // REVIEW-P2C27 BLOCKING 6 — endorsement skills aggregation joins
      // through pfl_portfolios.school_id so a cross-school portfolio's
      // endorsement skills cannot leak into the resume.
      const endorsementSkillRows = (await client.$queryRawUnsafe(
        `SELECT DISTINCT unnest(e.skills) AS skill
         FROM pfl_endorsements e
         JOIN pfl_portfolios p ON p.id = e.portfolio_id
         WHERE p.student_id = $1::uuid AND p.school_id = $2::uuid`,
        studentId,
        tenant.schoolId,
      )) as Array<{ skill: string }>;
      const endorsementSkills = endorsementSkillRows.map((r) => r.skill);
      const mergedSkills = Array.from(
        new Set<string>([...(resume.skills ?? []), ...endorsementSkills]),
      );

      // REVIEW-P2C27 BLOCKING 6 — service hours aggregation joins through
      // sis_students.school_id so cross-school service hour entries cannot
      // contaminate the total. Defensive try/catch preserves the manually
      // edited value when the cross-cycle table is absent in this tenant.
      // Column is `hours` per sis_service_learning_hours schema (migration
      // 143_sis_graduation_gpa.sql) — fixed from the erroneous `hours_logged`
      // reference in the comment of 170_pfl_college_resume.sql.
      let serviceHours = resume.service_hours_total;
      try {
        const rows = (await client.$queryRawUnsafe(
          `SELECT COALESCE(SUM(slh.hours), 0)::numeric(5,1) AS total
           FROM sis_service_learning_hours slh
           JOIN sis_students s ON s.id = slh.student_id
           WHERE slh.student_id = $1::uuid
             AND s.school_id = $2::uuid
             AND slh.status = 'APPROVED'`,
          studentId,
          tenant.schoolId,
        )) as Array<{ total: number }>;
        serviceHours = Number(rows[0]?.total ?? 0);
      } catch (err) {
        void err;
      }

      // REVIEW-P2C27 BLOCKING 6 — achievements aggregation joins through
      // sis_students so cross-school achievement rows cannot leak.
      const achievementRows = (await client.$queryRawUnsafe(
        `SELECT a.title, a.achievement_type AS type, a.awarded_at::text AS awarded_at
         FROM pfl_achievements a
         JOIN sis_students s ON s.id = a.student_id
         WHERE a.student_id = $1::uuid AND s.school_id = $2::uuid
         ORDER BY a.awarded_at DESC`,
        studentId,
        tenant.schoolId,
      )) as Array<{ title: string; type: string; awarded_at: string }>;
      const aggregatedAwards = achievementRows.map((r) => ({
        title: r.title,
        type: r.type,
        date: r.awarded_at,
      }));
      const existingAwards = Array.isArray(resume.awards) ? resume.awards : [];
      const existingTitles = new Set(
        (existingAwards as Array<{ title?: string }>).map((a) => a.title).filter(Boolean),
      );
      const mergedAwards = [
        ...existingAwards,
        ...aggregatedAwards.filter((a) => !existingTitles.has(a.title)),
      ];

      // REVIEW-P2C27 BLOCKING 6 — extracurriculars aggregation joins through
      // sis_students.school_id so cross-school activity memberships cannot
      // leak. ext_activity_members.student_id is the sis_students soft FK
      // (per migration 058_ext_activities.sql) — fixed from the erroneous
      // person_id reference that always returned an empty result.
      let mergedExtracurriculars = Array.isArray(resume.extracurriculars)
        ? resume.extracurriculars
        : [];
      try {
        const rows = (await client.$queryRawUnsafe(
          `SELECT a.name AS activity, em.role, em.joined_at::text AS joined_at
           FROM ext_activity_members em
           JOIN ext_activities a ON a.id = em.activity_id
           JOIN sis_students s ON s.id = em.student_id
           WHERE em.student_id = $1::uuid
             AND s.school_id = $2::uuid`,
          studentId,
          tenant.schoolId,
        )) as Array<{ activity: string; role: string | null; joined_at: string }>;
        if (rows.length > 0) {
          const seen = new Set(
            (mergedExtracurriculars as Array<{ activity?: string }>)
              .map((e) => e.activity)
              .filter(Boolean),
          );
          const aggregated = rows
            .filter((r) => !seen.has(r.activity))
            .map((r) => ({ activity: r.activity, role: r.role, joined_at: r.joined_at }));
          mergedExtracurriculars = [...mergedExtracurriculars, ...aggregated];
        }
      } catch (err) {
        void err;
      }

      const pdfS3Key = `resumes/${studentId}/${Date.now()}.pdf`;
      const generatedAt = new Date().toISOString();
      // REVIEW-P2C27 BLOCKING 6 — final UPDATE joins through sis_students
      // so the school predicate is enforced on the write.
      await client.$executeRawUnsafe(
        `UPDATE pfl_resume_profiles AS upd
         SET skills = $1,
             awards = $2::jsonb,
             extracurriculars = $3::jsonb,
             service_hours_total = $4,
             pdf_s3_key = $5,
             last_generated_at = $6::timestamptz,
             updated_at = now()
         FROM sis_students s
         WHERE s.id = upd.student_id
           AND upd.student_id = $7::uuid
           AND s.school_id = $8::uuid`,
        mergedSkills,
        JSON.stringify(mergedAwards),
        JSON.stringify(mergedExtracurriculars),
        serviceHours,
        pdfS3Key,
        generatedAt,
        studentId,
        tenant.schoolId,
      );

      return {
        resumeId: resume.id,
        pdfS3Key,
        lastGeneratedAt: generatedAt,
        skillsCount: mergedSkills.length,
        awardsCount: mergedAwards.length,
        serviceHoursTotal: Number(serviceHours),
        extracurricularsCount: (mergedExtracurriculars as unknown[]).length,
      };
    });
  }
}
