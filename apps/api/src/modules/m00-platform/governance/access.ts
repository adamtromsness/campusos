import { BadRequestException, Injectable } from '@nestjs/common';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';

/**
 * REVIEW-CYCLE30 BLOCKING 3 + 4 — shared helpers for soft-reference
 * tenant validation across the governance services.
 *
 * Mirrors the Cycle 6.1 / Cycle 22 / Cycle 25 / Cycle 29 pattern:
 * every supplied platform.iam_person.id MUST project into the calling
 * tenant via sis_students (through platform_students.person_id) /
 * sis_guardians.person_id / hr_employees.person_id. Without this gate
 * a DPO/staff actor in tenant A could create SAR / erasure / consent
 * records against arbitrary platform people in tenant B.
 *
 * The processing-activity helper (BLOCKING 4) checks that the supplied
 * dpo_processing_activities.id resolves to a current-school row; the
 * `requireActive` flag adds an `is_active=true` predicate so consent
 * records cannot be filed against inactive activities.
 */
@Injectable()
export class GovernanceAccess {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async assertDataSubjectInCurrentTenant(
    dataSubjectId: string,
    fieldName = 'dataSubjectId',
  ): Promise<void> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT 1 AS found
           FROM platform.iam_person ip
          WHERE ip.id = $1::uuid
            AND (
              EXISTS (SELECT 1 FROM sis_students s
                       JOIN platform.platform_students ps ON ps.id = s.platform_student_id
                       WHERE ps.person_id = ip.id)
              OR EXISTS (SELECT 1 FROM sis_guardians g WHERE g.person_id = ip.id)
              OR EXISTS (SELECT 1 FROM hr_employees e WHERE e.person_id = ip.id)
            )
          LIMIT 1`,
        dataSubjectId,
      );
    })) as Array<unknown>;
    if (rows.length === 0) {
      throw new BadRequestException(
        `${fieldName} ${dataSubjectId} does not match a person affiliated with this school.`,
      );
    }
  }

  /**
   * BLOCKING 4 — consent records must reference a real, current-school
   * processing activity. `requireActive=true` additionally rejects
   * activities flagged is_active=false (default for consent paths).
   */
  async assertProcessingActivityInCurrentSchool(
    processingActivityId: string,
    options: { requireActive?: boolean } = {},
  ): Promise<void> {
    const tenant = getCurrentTenant();
    const where = options.requireActive
      ? `pa.id = $1::uuid AND pa.school_id = $2::uuid AND pa.is_active = true`
      : `pa.id = $1::uuid AND pa.school_id = $2::uuid`;
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT 1 AS found FROM dpo_processing_activities pa WHERE ${where} LIMIT 1`,
        processingActivityId,
        tenant.schoolId,
      );
    })) as Array<unknown>;
    if (rows.length === 0) {
      throw new BadRequestException(
        options.requireActive
          ? `processingActivityId ${processingActivityId} does not match an active processing activity in this school.`
          : `processingActivityId ${processingActivityId} does not match a processing activity in this school.`,
      );
    }
  }
}
