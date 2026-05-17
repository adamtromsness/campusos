import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import {
  CreateServiceProgrammeDto,
  ServiceProgrammeDto,
  ServiceProgressDto,
} from './dto/clubs.dto';

interface ProgrammeRow {
  id: string;
  school_id: string;
  name: string;
  description: string | null;
  academic_year_id: string;
  target_hours: string;
  start_date: string | null;
  end_date: string | null;
  is_active: boolean;
  eligible_grade_levels: string[] | null;
}

const SELECT_PROGRAMME =
  'SELECT id::text AS id, school_id::text AS school_id, name, description, ' +
  'academic_year_id::text AS academic_year_id, target_hours::text AS target_hours, ' +
  "TO_CHAR(start_date, 'YYYY-MM-DD') AS start_date, " +
  "TO_CHAR(end_date, 'YYYY-MM-DD') AS end_date, " +
  'is_active, eligible_grade_levels FROM ext_service_programmes ';

function rowToDto(r: ProgrammeRow): ServiceProgrammeDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    name: r.name,
    description: r.description,
    academicYearId: r.academic_year_id,
    targetHours: Number(r.target_hours),
    startDate: r.start_date,
    endDate: r.end_date,
    isActive: r.is_active,
    eligibleGradeLevels: r.eligible_grade_levels,
  };
}

@Injectable()
export class ServiceProgrammeService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private isManager(actor: ResolvedActor): boolean {
    return actor.isSchoolAdmin || actor.personType === 'STAFF';
  }

  async list(includeInactive = false): Promise<ServiceProgrammeDto[]> {
    const tenant = getCurrentTenant();
    const sql =
      SELECT_PROGRAMME +
      'WHERE school_id = $1::uuid' +
      (includeInactive ? '' : ' AND is_active = true') +
      ' ORDER BY name';
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(sql, tenant.schoolId);
    })) as ProgrammeRow[];
    return rows.map(rowToDto);
  }

  async getById(id: string): Promise<ServiceProgrammeDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_PROGRAMME + 'WHERE id = $1::uuid', id);
    })) as ProgrammeRow[];
    if (rows.length === 0) throw new NotFoundException('Service programme not found');
    return rowToDto(rows[0]!);
  }

  async create(
    input: CreateServiceProgrammeDto,
    actor: ResolvedActor,
  ): Promise<ServiceProgrammeDto> {
    if (!this.isManager(actor)) {
      throw new ForbiddenException('Only Staff or admins can create service programmes');
    }
    if (input.startDate && input.endDate && new Date(input.endDate) < new Date(input.startDate)) {
      throw new BadRequestException('endDate must be on or after startDate');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO ext_service_programmes (id, school_id, name, description, academic_year_id, target_hours, start_date, end_date, eligible_grade_levels) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6, $7::date, $8::date, $9::text[])',
          id,
          tenant.schoolId,
          input.name,
          input.description ?? null,
          input.academicYearId,
          input.targetHours,
          input.startDate ?? null,
          input.endDate ?? null,
          input.eligibleGradeLevels ?? null,
        );
      });
    } catch (e) {
      const err = e as { code?: string; meta?: { code?: string }; message?: string };
      if (err.code === '23505' || /duplicate key|already exists/i.test(err.message ?? '')) {
        throw new BadRequestException(
          'A service programme named "' + input.name + '" already exists for this academic year',
        );
      }
      throw e;
    }
    return this.getById(id);
  }

  /**
   * REVIEW-CYCLE17 MAJOR 6 — restrict the leaderboard to admin/staff.
   * Service-hour progress (student names + completion state) is
   * sensitive enough that the per-programme leaderboard is a
   * coordinator surface only. Students see their own progress via
   * ServiceHourService.myProgress; an anonymised student-visible
   * class ranking can land in Phase 2 if a school product decision
   * approves it.
   */
  async getLeaderboard(programmeId: string, actor: ResolvedActor): Promise<ServiceProgressDto[]> {
    if (!actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      throw new ForbiddenException('Service hour leaderboards are restricted to staff and admins');
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT pr.id::text AS id, pr.programme_id::text AS programme_id, ' +
          'p.name AS programme_name, p.target_hours::text AS target_hours, ' +
          'pr.student_id::text AS student_id, ' +
          "(SELECT (ip.first_name || ' ' || ip.last_name) FROM sis_students s " +
          '  JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          '  JOIN platform.iam_person ip ON ip.id = ps.person_id ' +
          '  WHERE s.id = pr.student_id) AS student_name, ' +
          'pr.approved_hours::text AS approved_hours, pr.pending_hours::text AS pending_hours, ' +
          'pr.is_complete ' +
          'FROM ext_service_progress pr ' +
          'JOIN ext_service_programmes p ON p.id = pr.programme_id ' +
          'WHERE pr.programme_id = $1::uuid ' +
          'ORDER BY pr.approved_hours DESC, pr.pending_hours DESC',
        programmeId,
      );
    })) as Array<{
      id: string;
      programme_id: string;
      programme_name: string;
      target_hours: string;
      student_id: string;
      student_name: string | null;
      approved_hours: string;
      pending_hours: string;
      is_complete: boolean;
    }>;
    return rows.map((r) => ({
      id: r.id,
      programmeId: r.programme_id,
      programmeName: r.programme_name,
      targetHours: Number(r.target_hours),
      studentId: r.student_id,
      studentName: r.student_name,
      approvedHours: Number(r.approved_hours),
      pendingHours: Number(r.pending_hours),
      isComplete: r.is_complete,
    }));
  }
}
