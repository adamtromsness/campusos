import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  AdmissionStreamResponseDto,
  CapacitySummaryRowDto,
  CreateAdmissionStreamDto,
  CreateEnrollmentPeriodDto,
  CreateIntakeCapacityDto,
  EnrollmentPeriodResponseDto,
  IntakeCapacityResponseDto,
  UpdateEnrollmentPeriodDto,
} from './dto/enrollment-period.dto';

interface PeriodRow {
  id: string;
  school_id: string;
  academic_year_id: string;
  academic_year_name: string;
  name: string;
  opens_at: string;
  closes_at: string;
  status: string;
  allows_mid_year_applications: boolean;
  created_at: string;
  updated_at: string;
}

interface StreamRow {
  id: string;
  enrollment_period_id: string;
  name: string;
  grade_level: string | null;
  opens_at: string | null;
  closes_at: string | null;
  is_active: boolean;
}

interface CapacityRow {
  id: string;
  enrollment_period_id: string;
  stream_id: string | null;
  grade_level: string;
  total_places: number;
  reserved_places: number;
}

interface SummaryRow {
  grade_level: string;
  total_places: number;
  reserved: number;
  applications_received: number;
  offers_issued: number;
  offers_accepted: number;
  waitlisted: number;
  available: number;
}

function streamRowToDto(r: StreamRow): AdmissionStreamResponseDto {
  return {
    id: r.id,
    enrollmentPeriodId: r.enrollment_period_id,
    name: r.name,
    gradeLevel: r.grade_level,
    opensAt: r.opens_at,
    closesAt: r.closes_at,
    isActive: r.is_active,
  };
}

function capacityRowToDto(r: CapacityRow): IntakeCapacityResponseDto {
  return {
    id: r.id,
    enrollmentPeriodId: r.enrollment_period_id,
    streamId: r.stream_id,
    gradeLevel: r.grade_level,
    totalPlaces: Number(r.total_places),
    reservedPlaces: Number(r.reserved_places),
  };
}

function summaryRowToDto(r: SummaryRow): CapacitySummaryRowDto {
  return {
    gradeLevel: r.grade_level,
    totalPlaces: Number(r.total_places),
    reserved: Number(r.reserved),
    applicationsReceived: Number(r.applications_received),
    offersIssued: Number(r.offers_issued),
    offersAccepted: Number(r.offers_accepted),
    waitlisted: Number(r.waitlisted),
    available: Number(r.available),
  };
}

function periodRowToDto(
  r: PeriodRow,
  streams: StreamRow[],
  capacities: CapacityRow[],
  summary: SummaryRow[],
): EnrollmentPeriodResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    academicYearId: r.academic_year_id,
    academicYearName: r.academic_year_name,
    name: r.name,
    opensAt: r.opens_at,
    closesAt: r.closes_at,
    status: r.status as EnrollmentPeriodResponseDto['status'],
    allowsMidYearApplications: r.allows_mid_year_applications,
    streams: streams.filter((s) => s.enrollment_period_id === r.id).map(streamRowToDto),
    capacities: capacities.filter((c) => c.enrollment_period_id === r.id).map(capacityRowToDto),
    capacitySummary: summary.map(summaryRowToDto),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

var SELECT_PERIOD_BASE =
  'SELECT p.id, p.school_id, p.academic_year_id, ay.name AS academic_year_name, p.name, ' +
  'p.opens_at, p.closes_at, p.status, p.allows_mid_year_applications, p.created_at, p.updated_at ' +
  'FROM enr_enrollment_periods p ' +
  'JOIN sis_academic_years ay ON ay.id = p.academic_year_id ';

@Injectable()
export class EnrollmentPeriodService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async list(): Promise<EnrollmentPeriodResponseDto[]> {
    var data = await this.tenantPrisma.executeInTenantContext(async (client) => {
      var periods = await client.$queryRawUnsafe<PeriodRow[]>(
        SELECT_PERIOD_BASE + 'ORDER BY p.opens_at DESC',
      );
      var ids = periods.map((p) => p.id);
      var streams = await this.loadStreamsFor(client, ids);
      var capacities = await this.loadCapacitiesFor(client, ids);
      return { periods, streams, capacities };
    });
    var summaries: Record<string, SummaryRow[]> = {};
    for (var i = 0; i < data.periods.length; i++) {
      summaries[data.periods[i]!.id] = await this.loadSummaryFor(data.periods[i]!.id);
    }
    return data.periods.map((p) =>
      periodRowToDto(p, data.streams, data.capacities, summaries[p.id] ?? []),
    );
  }

  async getById(id: string): Promise<EnrollmentPeriodResponseDto> {
    var data = await this.tenantPrisma.executeInTenantContext(async (client) => {
      var rows = await client.$queryRawUnsafe<PeriodRow[]>(
        SELECT_PERIOD_BASE + 'WHERE p.id = $1::uuid',
        id,
      );
      if (rows.length === 0) return null;
      var streams = await this.loadStreamsFor(client, [id]);
      var capacities = await this.loadCapacitiesFor(client, [id]);
      return { row: rows[0]!, streams, capacities };
    });
    if (!data) throw new NotFoundException('Enrollment period ' + id + ' not found');
    var summary = await this.loadSummaryFor(id);
    return periodRowToDto(data.row, data.streams, data.capacities, summary);
  }

  async create(
    body: CreateEnrollmentPeriodDto,
    actor: ResolvedActor,
  ): Promise<EnrollmentPeriodResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can create enrollment periods');
    }
    if (new Date(body.closesAt) <= new Date(body.opensAt)) {
      throw new BadRequestException('closesAt must be after opensAt');
    }
    var schoolId = getCurrentTenant().schoolId;
    var periodId = generateId();

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      var ayRows = (await tx.$queryRawUnsafe(
        'SELECT id FROM sis_academic_years WHERE id = $1::uuid',
        body.academicYearId,
      )) as Array<{ id: string }>;
      if (ayRows.length === 0) {
        throw new NotFoundException('Academic year ' + body.academicYearId + ' not found');
      }
      await tx.$executeRawUnsafe(
        'INSERT INTO enr_enrollment_periods (id, school_id, academic_year_id, name, opens_at, closes_at, status, allows_mid_year_applications) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz, $6::timestamptz, 'UPCOMING', $7)",
        periodId,
        schoolId,
        body.academicYearId,
        body.name,
        body.opensAt,
        body.closesAt,
        body.allowsMidYearApplications ?? false,
      );
    });
    return this.getById(periodId);
  }

  /**
   * Patch an enrollment period — admins only. Locks the row with FOR
   * UPDATE inside the same tx that writes the change so a status flip
   * raced against another admin serialises and the second one re-reads
   * the new state.
   */
  async update(
    id: string,
    body: UpdateEnrollmentPeriodDto,
    actor: ResolvedActor,
  ): Promise<EnrollmentPeriodResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can update enrollment periods');
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      var rows = (await tx.$queryRawUnsafe(
        'SELECT id, opens_at, closes_at FROM enr_enrollment_periods WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ id: string; opens_at: string; closes_at: string }>;
      if (rows.length === 0) {
        throw new NotFoundException('Enrollment period ' + id + ' not found');
      }
      var current = rows[0]!;
      var newOpens = body.opensAt ?? current.opens_at;
      var newCloses = body.closesAt ?? current.closes_at;
      if (new Date(newCloses) <= new Date(newOpens)) {
        throw new BadRequestException('closesAt must be after opensAt');
      }

      var setClauses: string[] = [];
      var params: any[] = [];
      var idx = 1;
      if (body.name !== undefined) {
        setClauses.push('name = $' + idx);
        params.push(body.name);
        idx++;
      }
      if (body.opensAt !== undefined) {
        setClauses.push('opens_at = $' + idx + '::timestamptz');
        params.push(body.opensAt);
        idx++;
      }
      if (body.closesAt !== undefined) {
        setClauses.push('closes_at = $' + idx + '::timestamptz');
        params.push(body.closesAt);
        idx++;
      }
      if (body.status !== undefined) {
        setClauses.push('status = $' + idx);
        params.push(body.status);
        idx++;
      }
      if (body.allowsMidYearApplications !== undefined) {
        setClauses.push('allows_mid_year_applications = $' + idx);
        params.push(body.allowsMidYearApplications);
        idx++;
      }
      if (setClauses.length === 0) return;
      setClauses.push('updated_at = now()');
      params.push(id);
      await tx.$executeRawUnsafe(
        'UPDATE enr_enrollment_periods SET ' +
          setClauses.join(', ') +
          ' WHERE id = $' +
          idx +
          '::uuid',
        ...params,
      );
    });
    return this.getById(id);
  }

  async createStream(
    periodId: string,
    body: CreateAdmissionStreamDto,
    actor: ResolvedActor,
  ): Promise<EnrollmentPeriodResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can create admission streams');
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      var rows = (await tx.$queryRawUnsafe(
        'SELECT id FROM enr_enrollment_periods WHERE id = $1::uuid',
        periodId,
      )) as Array<{ id: string }>;
      if (rows.length === 0) {
        throw new NotFoundException('Enrollment period ' + periodId + ' not found');
      }
      await tx.$executeRawUnsafe(
        'INSERT INTO enr_admission_streams (id, enrollment_period_id, name, grade_level, opens_at, closes_at, is_active) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5::timestamptz, $6::timestamptz, $7)',
        generateId(),
        periodId,
        body.name,
        body.gradeLevel ?? null,
        body.opensAt ?? null,
        body.closesAt ?? null,
        body.isActive ?? true,
      );
    });
    return this.getById(periodId);
  }

  async createCapacity(
    periodId: string,
    body: CreateIntakeCapacityDto,
    actor: ResolvedActor,
  ): Promise<EnrollmentPeriodResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can create intake capacities');
    }
    if ((body.reservedPlaces ?? 0) > body.totalPlaces) {
      throw new BadRequestException('reservedPlaces cannot exceed totalPlaces');
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      var rows = (await tx.$queryRawUnsafe(
        'SELECT id FROM enr_enrollment_periods WHERE id = $1::uuid',
        periodId,
      )) as Array<{ id: string }>;
      if (rows.length === 0) {
        throw new NotFoundException('Enrollment period ' + periodId + ' not found');
      }
      await tx.$executeRawUnsafe(
        'INSERT INTO enr_intake_capacities (id, enrollment_period_id, stream_id, grade_level, total_places, reserved_places) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::int, $6::int)',
        generateId(),
        periodId,
        body.streamId ?? null,
        body.gradeLevel,
        body.totalPlaces,
        body.reservedPlaces ?? 0,
      );
    });
    return this.getById(periodId);
  }

  private async loadStreamsFor(client: any, periodIds: string[]): Promise<StreamRow[]> {
    if (periodIds.length === 0) return [];
    var placeholders = periodIds.map((_: string, i: number) => '$' + (i + 1) + '::uuid').join(',');
    return client.$queryRawUnsafe(
      'SELECT id, enrollment_period_id, name, grade_level, opens_at, closes_at, is_active ' +
        'FROM enr_admission_streams WHERE enrollment_period_id IN (' +
        placeholders +
        ') ORDER BY name',
      ...periodIds,
    );
  }

  private async loadCapacitiesFor(client: any, periodIds: string[]): Promise<CapacityRow[]> {
    if (periodIds.length === 0) return [];
    var placeholders = periodIds.map((_: string, i: number) => '$' + (i + 1) + '::uuid').join(',');
    return client.$queryRawUnsafe(
      'SELECT id, enrollment_period_id, stream_id, grade_level, total_places::int AS total_places, reserved_places::int AS reserved_places ' +
        'FROM enr_intake_capacities WHERE enrollment_period_id IN (' +
        placeholders +
        ') ORDER BY grade_level, stream_id NULLS FIRST',
      ...periodIds,
    );
  }

  private async loadSummaryFor(periodId: string): Promise<SummaryRow[]> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<SummaryRow[]>(
        'SELECT grade_level, total_places::int AS total_places, reserved::int AS reserved, ' +
          'applications_received::int AS applications_received, offers_issued::int AS offers_issued, ' +
          'offers_accepted::int AS offers_accepted, waitlisted::int AS waitlisted, available::int AS available ' +
          'FROM enr_capacity_summary WHERE enrollment_period_id = $1::uuid ORDER BY grade_level',
        periodId,
      );
    });
  }
}
