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
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import {
  CancelDrillDto,
  CompleteDrillDto,
  CreateDrillDto,
  DrillDto,
  DrillStatus,
  OverdueDrillDto,
  ProcedureType,
  PROCEDURE_TYPES,
} from '../incidents/dto/incident.dto';

interface DrillRow {
  id: string;
  school_id: string;
  incident_type_id: string | null;
  procedure_type: string;
  scheduled_at: string;
  completed_at: string | null;
  duration_seconds: number | null;
  participation_rate: string | null;
  notes: string | null;
  status: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

const SELECT_DRILL_BASE =
  'SELECT id::text AS id, school_id::text AS school_id, ' +
  '       incident_type_id::text AS incident_type_id, procedure_type, ' +
  '       scheduled_at::text AS scheduled_at, completed_at::text AS completed_at, ' +
  '       duration_seconds, participation_rate::text AS participation_rate, notes, ' +
  '       status, created_by::text AS created_by, ' +
  '       created_at::text AS created_at, updated_at::text AS updated_at ' +
  'FROM inc_drills ';

@Injectable()
export class DrillService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  async list(status?: DrillStatus): Promise<DrillDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const params: unknown[] = [tenant.schoolId];
      let where = 'WHERE school_id = $1::uuid';
      if (status) {
        params.push(status);
        where += ' AND status = $' + params.length;
      }
      const rows = (await client.$queryRawUnsafe(
        SELECT_DRILL_BASE + where + ' ORDER BY scheduled_at DESC LIMIT 200',
        ...params,
      )) as DrillRow[];
      return rows.map((r) => this.rowToDto(r));
    });
  }

  async create(input: CreateDrillDto, actor: ResolvedActor): Promise<DrillDto> {
    await this.assertDrillManager(actor);
    const tenant = getCurrentTenant();
    const id = generateId();

    return this.tenantPrisma.executeInTenantContext(async (client) => {
      // Validate optional incident_type_id is in this tenant or a platform default.
      if (input.incidentTypeId) {
        const types = (await client.$queryRawUnsafe(
          'SELECT id FROM inc_incident_types WHERE id = $1::uuid AND ' +
            '  (school_id IS NULL OR school_id = $2::uuid) LIMIT 1',
          input.incidentTypeId,
          tenant.schoolId,
        )) as Array<{ id: string }>;
        if (types.length === 0) {
          throw new BadRequestException('incidentTypeId not in this tenant');
        }
      }
      await client.$executeRawUnsafe(
        'INSERT INTO inc_drills ' +
          '(id, school_id, incident_type_id, procedure_type, scheduled_at, status, created_by, notes) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz, $6, $7::uuid, $8)',
        id,
        tenant.schoolId,
        input.incidentTypeId ?? null,
        input.procedureType,
        input.scheduledAt,
        'SCHEDULED',
        actor.accountId,
        input.notes ?? null,
      );
      const rows = (await client.$queryRawUnsafe(
        SELECT_DRILL_BASE + 'WHERE id = $1::uuid LIMIT 1',
        id,
      )) as DrillRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  async complete(id: string, input: CompleteDrillDto, actor: ResolvedActor): Promise<DrillDto> {
    await this.assertDrillManager(actor);
    const tenant = getCurrentTenant();

    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT status FROM inc_drills WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        id,
      )) as Array<{ status: string }>;
      if (lock.length === 0) throw new NotFoundException('Drill not found');
      if (lock[0]!.status !== 'SCHEDULED') {
        throw new BadRequestException('Only SCHEDULED drills can be marked COMPLETED');
      }

      await tx.$executeRawUnsafe(
        'UPDATE inc_drills SET status = $1, completed_at = $2::timestamptz, ' +
          '  duration_seconds = $3, participation_rate = $4, ' +
          '  notes = COALESCE($5, notes), updated_at = now() ' +
          'WHERE school_id = $6::uuid AND id = $7::uuid',
        'COMPLETED',
        input.completedAt,
        input.durationSeconds,
        input.participationRate,
        input.notes ?? null,
        tenant.schoolId,
        id,
      );

      const rows = (await tx.$queryRawUnsafe(
        SELECT_DRILL_BASE + 'WHERE id = $1::uuid LIMIT 1',
        id,
      )) as DrillRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  async cancel(id: string, input: CancelDrillDto, actor: ResolvedActor): Promise<DrillDto> {
    await this.assertDrillManager(actor);
    const tenant = getCurrentTenant();

    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT status FROM inc_drills WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        id,
      )) as Array<{ status: string }>;
      if (lock.length === 0) throw new NotFoundException('Drill not found');
      if (lock[0]!.status === 'COMPLETED') {
        throw new BadRequestException('Cannot cancel a COMPLETED drill');
      }
      await tx.$executeRawUnsafe(
        'UPDATE inc_drills SET status = $1, notes = COALESCE($2, notes), updated_at = now() ' +
          'WHERE school_id = $3::uuid AND id = $4::uuid',
        'CANCELLED',
        input.notes ?? null,
        tenant.schoolId,
        id,
      );
      const rows = (await tx.$queryRawUnsafe(
        SELECT_DRILL_BASE + 'WHERE id = $1::uuid LIMIT 1',
        id,
      )) as DrillRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  /**
   * Procedure types with no COMPLETED drill in the last 90 days
   * (90-day cadence per regulatory norms). Returns one row per
   * procedure_type that's overdue, with the last-completed timestamp
   * (null if never run) and days-since-last-drill.
   */
  async overdue(): Promise<OverdueDrillDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'WITH last_done AS ( ' +
          '  SELECT procedure_type, MAX(completed_at) AS last_completed ' +
          '  FROM inc_drills ' +
          "  WHERE school_id = $1::uuid AND status = 'COMPLETED' " +
          '  GROUP BY procedure_type ' +
          ') ' +
          'SELECT t.proc_type AS procedure_type, ' +
          '       l.last_completed::text AS last_completed_at, ' +
          '       COALESCE(EXTRACT(EPOCH FROM (now() - l.last_completed))/86400, 9999)::int ' +
          '         AS days_since_last_drill ' +
          'FROM (VALUES ' +
          // Only the regulatory-required types — we don't surface every
          // 9-value enum as "overdue" because not every school runs them.
          "  ('FIRE_EVACUATION'), ('LOCKDOWN'), ('SHELTER_IN_PLACE'), ('MEDICAL_EMERGENCY') " +
          ') AS t(proc_type) ' +
          'LEFT JOIN last_done l ON l.procedure_type = t.proc_type ' +
          "WHERE l.last_completed IS NULL OR l.last_completed < now() - INTERVAL '90 days' " +
          'ORDER BY days_since_last_drill DESC',
        tenant.schoolId,
      )) as Array<{
        procedure_type: string;
        last_completed_at: string | null;
        days_since_last_drill: number;
      }>;
      return rows.map((r) => ({
        procedureType: r.procedure_type as ProcedureType,
        lastCompletedAt: r.last_completed_at,
        daysSinceLastDrill: r.days_since_last_drill,
      }));
    });
  }

  private async assertDrillManager(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'saf-004:write',
    ]);
    if (!ok) {
      throw new ForbiddenException('Drill management requires saf-004:write or school admin.');
    }
  }

  rowToDto(r: DrillRow): DrillDto {
    return {
      id: r.id,
      schoolId: r.school_id,
      incidentTypeId: r.incident_type_id,
      procedureType: (r.procedure_type as ProcedureType) ?? PROCEDURE_TYPES[0],
      scheduledAt: r.scheduled_at,
      completedAt: r.completed_at,
      durationSeconds: r.duration_seconds,
      participationRate: r.participation_rate !== null ? Number(r.participation_rate) : null,
      notes: r.notes,
      status: r.status as DrillStatus,
      createdBy: r.created_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}
