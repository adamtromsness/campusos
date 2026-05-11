import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { PermissionCheckService } from '../iam/permission-check.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  REPORTING_PERIOD_STATUSES,
  REPORTING_PERIOD_TYPES,
  type CreateReportingPeriodDto,
  type PatchReportingPeriodStatusDto,
  type ReportingPeriodDto,
  type ReportingPeriodStatus,
  type ReportingPeriodType,
} from './dto/sis-transcripts.dto';

interface PeriodRow {
  id: string;
  academic_year_id: string;
  name: string;
  period_type: string;
  start_date: string;
  end_date: string;
  grades_due_date: string;
  comments_due_date: string | null;
  status: string;
  published_at: string | null;
}

const ALLOWED_TRANSITIONS: Record<ReportingPeriodStatus, ReportingPeriodStatus[]> = {
  UPCOMING: ['OPEN'],
  OPEN: ['GRADING_CLOSED'],
  GRADING_CLOSED: ['PUBLISHED'],
  PUBLISHED: [],
};

/**
 * ReportingPeriodService — per-school grading windows.
 *
 * Service enforces the strict transition graph UPCOMING → OPEN →
 * GRADING_CLOSED → PUBLISHED. No skipping forward, no walking backward.
 * Status writes always lock the row + run the transition check inside
 * one tenant tx. PUBLISHED stamps published_at atomically.
 */
@Injectable()
export class ReportingPeriodService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  private rowToDto(r: PeriodRow): ReportingPeriodDto {
    return {
      id: r.id,
      academicYearId: r.academic_year_id,
      name: r.name,
      periodType: r.period_type as ReportingPeriodType,
      startDate: r.start_date,
      endDate: r.end_date,
      gradesDueDate: r.grades_due_date,
      commentsDueDate: r.comments_due_date,
      status: r.status as ReportingPeriodStatus,
      publishedAt: r.published_at,
    };
  }

  private async assertAdmin(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'stu-005:admin',
    ]);
    if (!ok) {
      throw new ForbiddenException('Only admins can manage reporting periods.');
    }
  }

  async list(): Promise<ReportingPeriodDto[]> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<PeriodRow[]>(
        'SELECT id::text, academic_year_id::text, name, period_type, start_date::text, ' +
          'end_date::text, grades_due_date::text, comments_due_date::text, status, ' +
          'published_at::text FROM sis_reporting_periods WHERE school_id = $1::uuid ' +
          'ORDER BY start_date',
        tenant.schoolId,
      ),
    );
    return rows.map((r) => this.rowToDto(r));
  }

  async getById(id: string): Promise<ReportingPeriodDto> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<PeriodRow[]>(
        'SELECT id::text, academic_year_id::text, name, period_type, start_date::text, ' +
          'end_date::text, grades_due_date::text, comments_due_date::text, status, ' +
          'published_at::text FROM sis_reporting_periods WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      ),
    );
    if (rows.length === 0) throw new NotFoundException('Reporting period not found');
    return this.rowToDto(rows[0]!);
  }

  async current(): Promise<ReportingPeriodDto | null> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<PeriodRow[]>(
        'SELECT id::text, academic_year_id::text, name, period_type, start_date::text, ' +
          'end_date::text, grades_due_date::text, comments_due_date::text, status, ' +
          'published_at::text FROM sis_reporting_periods ' +
          "WHERE school_id = $1::uuid AND status = 'OPEN' " +
          'ORDER BY start_date LIMIT 1',
        tenant.schoolId,
      ),
    );
    if (rows.length === 0) return null;
    return this.rowToDto(rows[0]!);
  }

  async create(dto: CreateReportingPeriodDto, actor: ResolvedActor): Promise<ReportingPeriodDto> {
    await this.assertAdmin(actor);
    if (!REPORTING_PERIOD_TYPES.includes(dto.periodType)) {
      throw new BadRequestException(
        `periodType must be one of ${REPORTING_PERIOD_TYPES.join(', ')}`,
      );
    }
    if (new Date(dto.endDate) < new Date(dto.startDate)) {
      throw new BadRequestException('endDate must be >= startDate');
    }
    const tenant = getCurrentTenant();

    // Validate academic year belongs to this school.
    const yearRows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM sis_academic_years WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        dto.academicYearId,
        tenant.schoolId,
      ),
    );
    if (yearRows.length === 0) {
      throw new BadRequestException(
        'academicYearId does not match an academic year in this school',
      );
    }

    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) =>
        client.$executeRawUnsafe(
          'INSERT INTO sis_reporting_periods (id, school_id, academic_year_id, name, period_type, ' +
            'start_date, end_date, grades_due_date, comments_due_date, status) ' +
            "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::date, $7::date, $8::date, $9::date, 'UPCOMING')",
          id,
          tenant.schoolId,
          dto.academicYearId,
          dto.name,
          dto.periodType,
          dto.startDate,
          dto.endDate,
          dto.gradesDueDate,
          dto.commentsDueDate ?? null,
        ),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('sis_reporting_period_unique')) {
        throw new BadRequestException(
          `A reporting period named ${dto.name} already exists for this academic year.`,
        );
      }
      throw err;
    }
    return this.getById(id);
  }

  async patchStatus(
    id: string,
    dto: PatchReportingPeriodStatusDto,
    actor: ResolvedActor,
  ): Promise<ReportingPeriodDto> {
    await this.assertAdmin(actor);
    if (!REPORTING_PERIOD_STATUSES.includes(dto.status)) {
      throw new BadRequestException(
        `status must be one of ${REPORTING_PERIOD_STATUSES.join(', ')}`,
      );
    }
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<{ status: string; school_id: string }>>(
        'SELECT status, school_id::text AS school_id FROM sis_reporting_periods WHERE id = $1::uuid FOR UPDATE',
        id,
      );
      if (rows.length === 0) throw new NotFoundException('Reporting period not found');
      const row = rows[0]!;
      if (row.school_id !== tenant.schoolId)
        throw new NotFoundException('Reporting period not found');
      const current = row.status as ReportingPeriodStatus;
      const allowed = ALLOWED_TRANSITIONS[current] ?? [];
      if (!allowed.includes(dto.status)) {
        throw new BadRequestException(
          `Cannot transition reporting period from ${current} to ${dto.status}. Allowed forward path: UPCOMING -> OPEN -> GRADING_CLOSED -> PUBLISHED.`,
        );
      }
      await tx.$executeRawUnsafe(
        'UPDATE sis_reporting_periods SET status = $1, ' +
          "published_at = CASE WHEN $1 = 'PUBLISHED' THEN now() ELSE NULL END, " +
          'updated_at = now() WHERE id = $2::uuid',
        dto.status,
        id,
      );
    });
    return this.getById(id);
  }
}
