import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import { PermissionCheckService } from '@modules/m00-platform';
import { KafkaProducerService } from '@shared/kafka';
import {
  CreateNonDisciplineDto,
  ListNonDisciplineQueryDto,
  NonDisciplineIncidentDto,
  NonDisciplineIncidentType,
  NonDisciplineSeverity,
  NonDisciplineStatus,
  UpdateNonDisciplineDto,
} from './dto/incident.dto';

interface NonDiscRow {
  id: string;
  school_id: string;
  incident_type: string;
  location: string | null;
  incident_date: string;
  description: string;
  students_involved: string[] | null;
  staff_involved: string[] | null;
  witnesses: string | null;
  reported_by: string;
  reported_by_first: string | null;
  reported_by_last: string | null;
  severity: string;
  follow_up_ticket_id: string | null;
  resolution: string | null;
  status: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_NONDISC_BASE =
  'SELECT n.id::text AS id, n.school_id::text AS school_id, n.incident_type, n.location, ' +
  '       n.incident_date::text AS incident_date, n.description, ' +
  '       n.students_involved, n.staff_involved, n.witnesses, ' +
  '       n.reported_by::text AS reported_by, ' +
  '       ip.first_name AS reported_by_first, ip.last_name AS reported_by_last, ' +
  '       n.severity, n.follow_up_ticket_id::text AS follow_up_ticket_id, ' +
  '       n.resolution, n.status, n.reviewed_by::text AS reviewed_by, ' +
  '       n.reviewed_at::text AS reviewed_at, n.closed_at::text AS closed_at, ' +
  '       n.created_at::text AS created_at, n.updated_at::text AS updated_at ' +
  'FROM inc_non_discipline_incidents n ' +
  'LEFT JOIN platform.platform_users pu ON pu.id = n.reported_by ' +
  'LEFT JOIN platform.iam_person ip ON ip.id = pu.person_id ';

@Injectable()
export class NonDisciplineIncidentService {
  private readonly logger = new Logger(NonDisciplineIncidentService.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
    private readonly kafka: KafkaProducerService,
  ) {}

  async list(
    args: ListNonDisciplineQueryDto,
    actor: ResolvedActor,
  ): Promise<NonDisciplineIncidentDto[]> {
    const tenant = getCurrentTenant();
    const limit = Math.min(args.limit ?? 100, 500);
    const params: unknown[] = [tenant.schoolId];
    let where = 'WHERE n.school_id = $1::uuid';
    if (args.status) {
      params.push(args.status);
      where += ' AND n.status = $' + params.length;
    }
    if (args.incidentType) {
      params.push(args.incidentType);
      where += ' AND n.incident_type = $' + params.length;
    }

    // Row-scope: non-admin teachers / staff who do not hold saf-003:admin
    // see only their own reports. Reviewers (admin / saf-003:admin) see all.
    if (!actor.isSchoolAdmin) {
      const isReviewer = await this.permissions.hasAnyPermissionInTenant(
        actor.accountId,
        tenant.schoolId,
        ['saf-003:admin'],
      );
      if (!isReviewer) {
        params.push(actor.accountId);
        where += ' AND n.reported_by = $' + params.length + '::uuid';
      }
    }

    if (args.mineOnly) {
      params.push(actor.accountId);
      where += ' AND n.reported_by = $' + params.length + '::uuid';
    }

    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_NONDISC_BASE + where + ' ORDER BY n.incident_date DESC LIMIT ' + limit,
        ...params,
      )) as NonDiscRow[];
      return rows.map((r) => this.rowToDto(r));
    });
  }

  async getById(id: string, actor: ResolvedActor): Promise<NonDisciplineIncidentDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_NONDISC_BASE + 'WHERE n.school_id = $1::uuid AND n.id = $2::uuid LIMIT 1',
        tenant.schoolId,
        id,
      )) as NonDiscRow[];
      if (rows.length === 0) throw new NotFoundException('Incident report not found');
      const row = rows[0]!;

      // Same row scope as list — non-admin non-reviewer can only see own reports.
      if (!actor.isSchoolAdmin && row.reported_by !== actor.accountId) {
        const isReviewer = await this.permissions.hasAnyPermissionInTenant(
          actor.accountId,
          tenant.schoolId,
          ['saf-003:admin'],
        );
        if (!isReviewer) throw new NotFoundException('Incident report not found');
      }
      return this.rowToDto(row);
    });
  }

  async create(
    input: CreateNonDisciplineDto,
    actor: ResolvedActor,
  ): Promise<NonDisciplineIncidentDto> {
    await this.assertReporter(actor);
    const tenant = getCurrentTenant();
    const id = generateId();

    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Validate students_involved are in this tenant.
      if (input.studentsInvolved && input.studentsInvolved.length > 0) {
        const found = (await tx.$queryRawUnsafe(
          'SELECT id::text AS id FROM sis_students WHERE id = ANY($1::uuid[])',
          input.studentsInvolved,
        )) as Array<{ id: string }>;
        if (found.length !== input.studentsInvolved.length) {
          throw new BadRequestException('studentsInvolved contains ids not in this tenant');
        }
      }
      // Validate staff_involved are in this tenant.
      if (input.staffInvolved && input.staffInvolved.length > 0) {
        const found = (await tx.$queryRawUnsafe(
          'SELECT id::text AS id FROM hr_employees WHERE id = ANY($1::uuid[])',
          input.staffInvolved,
        )) as Array<{ id: string }>;
        if (found.length !== input.staffInvolved.length) {
          throw new BadRequestException('staffInvolved contains ids not in this tenant');
        }
      }

      await tx.$executeRawUnsafe(
        'INSERT INTO inc_non_discipline_incidents ' +
          '(id, school_id, incident_type, location, incident_date, description, ' +
          ' students_involved, staff_involved, witnesses, reported_by, severity, ' +
          ' follow_up_ticket_id) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5::timestamptz, $6, ' +
          ' $7::uuid[], $8::uuid[], $9, $10::uuid, $11, $12::uuid)',
        id,
        tenant.schoolId,
        input.incidentType,
        input.location ?? null,
        input.incidentDate,
        input.description,
        input.studentsInvolved && input.studentsInvolved.length > 0
          ? '{' + input.studentsInvolved.join(',') + '}'
          : '{}',
        input.staffInvolved && input.staffInvolved.length > 0
          ? '{' + input.staffInvolved.join(',') + '}'
          : '{}',
        input.witnesses ?? null,
        actor.accountId,
        input.severity,
        input.followUpTicketId ?? null,
      );

      const rows = (await tx.$queryRawUnsafe(
        SELECT_NONDISC_BASE + 'WHERE n.id = $1::uuid LIMIT 1',
        id,
      )) as NonDiscRow[];
      const dto = this.rowToDto(rows[0]!);

      // Emit AFTER tx commits.
      void this.kafka
        .emit({
          topic: 'inc.incident.reported',
          key: id,
          sourceModule: 'incident',
          payload: {
            incidentId: id,
            schoolId: tenant.schoolId,
            incidentType: input.incidentType,
            severity: input.severity,
            location: input.location ?? null,
            reportedBy: actor.accountId,
            studentsInvolvedCount: input.studentsInvolved?.length ?? 0,
            staffInvolvedCount: input.staffInvolved?.length ?? 0,
            followUpTicketId: input.followUpTicketId ?? null,
            sourceRefId: id,
          },
        })
        .catch((e) => this.logger.warn('inc.incident.reported emit failed: ' + (e?.message || e)));

      return dto;
    });
  }

  async patch(
    id: string,
    input: UpdateNonDisciplineDto,
    actor: ResolvedActor,
  ): Promise<NonDisciplineIncidentDto> {
    await this.assertReviewer(actor);
    const tenant = getCurrentTenant();

    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, status FROM inc_non_discipline_incidents ' +
          'WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        id,
      )) as Array<{ id: string; status: string }>;
      if (lock.length === 0) throw new NotFoundException('Incident report not found');
      const cur = lock[0]!.status;

      const sets: string[] = [];
      const values: unknown[] = [];
      let n = 1;
      const push = (sql: string, v: unknown) => {
        sets.push(sql + ' = $' + n);
        values.push(v);
        n += 1;
      };

      if (input.followUpTicketId !== undefined) {
        sets.push('follow_up_ticket_id = $' + n + '::uuid');
        values.push(input.followUpTicketId);
        n += 1;
      }
      if (input.resolution !== undefined) push('resolution', input.resolution);

      if (input.status !== undefined && input.status !== cur) {
        // Validate transition.
        if (input.status === 'OPEN' && cur === 'CLOSED') {
          throw new BadRequestException('Cannot reopen a CLOSED incident report');
        }
        push('status', input.status);
        if (input.status === 'CLOSED') {
          // Multi-column closed_chk: closed_at must be NOT NULL on CLOSED.
          sets.push('closed_at = now()');
          sets.push('reviewed_by = $' + n + '::uuid');
          values.push(actor.accountId);
          n += 1;
          sets.push('reviewed_at = now()');
        } else {
          sets.push('closed_at = NULL');
        }
        if (input.status === 'UNDER_REVIEW') {
          sets.push('reviewed_by = $' + n + '::uuid');
          values.push(actor.accountId);
          n += 1;
          sets.push('reviewed_at = now()');
        }
      }
      if (sets.length === 0) {
        const rows = (await tx.$queryRawUnsafe(
          SELECT_NONDISC_BASE + 'WHERE n.id = $1::uuid LIMIT 1',
          id,
        )) as NonDiscRow[];
        return this.rowToDto(rows[0]!);
      }
      sets.push('updated_at = now()');
      values.push(id, tenant.schoolId);

      await tx.$executeRawUnsafe(
        'UPDATE inc_non_discipline_incidents SET ' +
          sets.join(', ') +
          ' WHERE id = $' +
          n +
          '::uuid AND school_id = $' +
          (n + 1) +
          '::uuid',
        ...values,
      );

      const rows = (await tx.$queryRawUnsafe(
        SELECT_NONDISC_BASE + 'WHERE n.id = $1::uuid LIMIT 1',
        id,
      )) as NonDiscRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  private async assertReporter(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'saf-003:write',
    ]);
    if (!ok) {
      throw new ForbiddenException('Reporting incidents requires saf-003:write.');
    }
  }

  private async assertReviewer(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'saf-003:admin',
    ]);
    if (!ok) {
      throw new ForbiddenException(
        'Reviewing incident reports requires saf-003:admin or school admin.',
      );
    }
  }

  private rowToDto(r: NonDiscRow): NonDisciplineIncidentDto {
    const reportedByName =
      r.reported_by_first || r.reported_by_last
        ? [r.reported_by_first, r.reported_by_last].filter(Boolean).join(' ')
        : null;
    return {
      id: r.id,
      schoolId: r.school_id,
      incidentType: r.incident_type as NonDisciplineIncidentType,
      location: r.location,
      incidentDate: r.incident_date,
      description: r.description,
      studentsInvolved: Array.isArray(r.students_involved) ? r.students_involved : [],
      staffInvolved: Array.isArray(r.staff_involved) ? r.staff_involved : [],
      witnesses: r.witnesses,
      reportedBy: r.reported_by,
      reportedByName,
      severity: r.severity as NonDisciplineSeverity,
      followUpTicketId: r.follow_up_ticket_id,
      resolution: r.resolution,
      status: r.status as NonDisciplineStatus,
      reviewedBy: r.reviewed_by,
      reviewedAt: r.reviewed_at,
      closedAt: r.closed_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}
