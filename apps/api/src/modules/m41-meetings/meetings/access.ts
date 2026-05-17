import { ForbiddenException } from '@nestjs/common';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

/**
 * REVIEW-P2C28 Round 1 BLOCKING 4 fix — club budget paths must scope
 * through ext_activities.school_id. The budget itself stores
 * activity_id + academic_year_id but no school_id column; cross-
 * school writes would otherwise succeed by UUID.
 */
export async function assertActivityInCurrentSchool(
  tenantPrisma: TenantPrismaService,
  activityId: string,
): Promise<void> {
  const tenant = getCurrentTenant();
  const rows = (await tenantPrisma.executeInTenantContext(async (client) => {
    return client.$queryRawUnsafe(
      'SELECT 1 AS ok FROM ext_activities WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
      activityId,
      tenant.schoolId,
    );
  })) as Array<{ ok: number }>;
  if (rows.length === 0) {
    throw new ForbiddenException('Activity does not belong to this school');
  }
}

export async function assertAcademicYearInCurrentSchool(
  tenantPrisma: TenantPrismaService,
  academicYearId: string,
): Promise<void> {
  const tenant = getCurrentTenant();
  const rows = (await tenantPrisma.executeInTenantContext(async (client) => {
    return client.$queryRawUnsafe(
      'SELECT 1 AS ok FROM sis_academic_years WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
      academicYearId,
      tenant.schoolId,
    );
  })) as Array<{ ok: number }>;
  if (rows.length === 0) {
    throw new ForbiddenException('Academic year does not belong to this school');
  }
}

/**
 * REVIEW-P2C28 Round 1 BLOCKING 5 fix — AI minutes paths must scope
 * through mtg_meetings.school_id. The mtg_ai_minutes row stores
 * meeting_id only — cross-school AI generation, regeneration, or
 * approval would otherwise succeed by UUID.
 */
export async function assertMeetingInCurrentSchool(
  tenantPrisma: TenantPrismaService,
  meetingId: string,
): Promise<void> {
  const tenant = getCurrentTenant();
  const rows = (await tenantPrisma.executeInTenantContext(async (client) => {
    return client.$queryRawUnsafe(
      'SELECT 1 AS ok FROM mtg_meetings WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
      meetingId,
      tenant.schoolId,
    );
  })) as Array<{ ok: number }>;
  if (rows.length === 0) {
    throw new ForbiddenException('Meeting does not belong to this school');
  }
}
