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
  AccountabilityPersonType,
  AccountabilityRecordDto,
  AccountabilityStatus,
  AccountabilitySummaryDto,
  BulkUpdateAccountabilityDto,
  UpdateAccountabilityDto,
} from '../incidents/dto/incident.dto';

interface AccountabilityRow {
  id: string;
  incident_id: string;
  person_id: string;
  person_type: string;
  status: string;
  last_updated_by: string | null;
  last_updated_at: string | null;
  notes: string | null;
  created_at: string;
}

interface SummaryRow {
  incident_id: string;
  total_people: number;
  accounted_for: number;
  unknown: number;
  evacuated: number;
  medical_assistance: number;
  missing: number;
  last_updated_at: string;
}

const SELECT_ACC_BASE =
  'SELECT id::text AS id, incident_id::text AS incident_id, ' +
  '       person_id::text AS person_id, person_type, status, ' +
  '       last_updated_by::text AS last_updated_by, ' +
  '       last_updated_at::text AS last_updated_at, ' +
  '       notes, created_at::text AS created_at ' +
  'FROM inc_accountability_records ';

const SELECT_SUMMARY_BASE =
  'SELECT incident_id::text AS incident_id, total_people, accounted_for, unknown, ' +
  '       evacuated, medical_assistance, missing, last_updated_at::text AS last_updated_at ' +
  'FROM inc_accountability_summary ';

@Injectable()
export class AccountabilityService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  async listForIncident(incidentId: string): Promise<AccountabilityRecordDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_ACC_BASE +
          'WHERE incident_id IN (SELECT id FROM inc_incidents WHERE school_id = $1::uuid AND id = $2::uuid) ' +
          'ORDER BY person_type, status, created_at',
        tenant.schoolId,
        incidentId,
      )) as AccountabilityRow[];
      return rows.map((r) => this.rowToDto(r));
    });
  }

  async getSummary(incidentId: string): Promise<AccountabilitySummaryDto | null> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      // Validate incident is in this tenant before exposing the summary.
      const incs = (await client.$queryRawUnsafe(
        'SELECT id FROM inc_incidents WHERE school_id = $1::uuid AND id = $2::uuid LIMIT 1',
        tenant.schoolId,
        incidentId,
      )) as Array<{ id: string }>;
      if (incs.length === 0) throw new NotFoundException('Incident not found');

      const rows = (await client.$queryRawUnsafe(
        SELECT_SUMMARY_BASE + 'WHERE incident_id = $1::uuid LIMIT 1',
        incidentId,
      )) as SummaryRow[];
      if (rows.length === 0) return null;
      return this.summaryRowToDto(rows[0]!);
    });
  }

  /**
   * Update a single accountability record. Locks the row, validates
   * the incident school_id projection, then UPDATE + recomputes the
   * summary atomically in the same tenant tx.
   */
  async update(
    recordId: string,
    input: UpdateAccountabilityDto,
    actor: ResolvedActor,
  ): Promise<AccountabilityRecordDto> {
    await this.assertResponder(actor);
    const tenant = getCurrentTenant();

    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT a.id::text AS id, a.incident_id::text AS incident_id ' +
          'FROM inc_accountability_records a ' +
          'JOIN inc_incidents i ON i.id = a.incident_id AND i.school_id = $1::uuid ' +
          'WHERE a.id = $2::uuid FOR UPDATE OF a',
        tenant.schoolId,
        recordId,
      )) as Array<{ id: string; incident_id: string }>;
      if (lock.length === 0) throw new NotFoundException('Accountability record not found');

      await tx.$executeRawUnsafe(
        'UPDATE inc_accountability_records SET status = $1, ' +
          '  last_updated_by = $2::uuid, last_updated_at = now(), notes = $3 ' +
          'WHERE id = $4::uuid',
        input.status,
        actor.accountId,
        input.notes ?? null,
        recordId,
      );

      // Real-time materialisation in the same tx — the summary always
      // matches the records snapshot at commit time.
      await this.recomputeSummaryInTx(tx, lock[0]!.incident_id);

      const rows = (await tx.$queryRawUnsafe(
        SELECT_ACC_BASE + 'WHERE id = $1::uuid LIMIT 1',
        recordId,
      )) as AccountabilityRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  /**
   * Bulk update many accountability records at once - the "Mark Room
   * Accounted" button. All records must belong to the same incident.
   */
  async bulkUpdate(
    incidentId: string,
    input: BulkUpdateAccountabilityDto,
    actor: ResolvedActor,
  ): Promise<{ updated: number }> {
    await this.assertResponder(actor);
    if (input.recordIds.length === 0) {
      throw new BadRequestException('recordIds must not be empty');
    }
    const tenant = getCurrentTenant();

    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const incs = (await tx.$queryRawUnsafe(
        'SELECT id FROM inc_incidents WHERE school_id = $1::uuid AND id = $2::uuid LIMIT 1',
        tenant.schoolId,
        incidentId,
      )) as Array<{ id: string }>;
      if (incs.length === 0) throw new NotFoundException('Incident not found');

      const result = (await tx.$queryRawUnsafe(
        'WITH upd AS ( ' +
          '  UPDATE inc_accountability_records SET status = $1, ' +
          '    last_updated_by = $2::uuid, last_updated_at = now(), ' +
          '    notes = COALESCE($3, notes) ' +
          '  WHERE incident_id = $4::uuid AND id = ANY($5::uuid[]) RETURNING 1 ' +
          ') SELECT COUNT(*)::int AS n FROM upd',
        input.status,
        actor.accountId,
        input.notes ?? null,
        incidentId,
        input.recordIds,
      )) as Array<{ n: number }>;

      await this.recomputeSummaryInTx(tx, incidentId);
      return { updated: result[0]?.n ?? 0 };
    });
  }

  /**
   * AccountabilitySummaryWorker - the materialisation primitive used
   * by every mutation path above. Public so the outbox-worker
   * muster step can call it after seeding initial UNKNOWN rows.
   */
  async recomputeSummary(incidentId: string): Promise<AccountabilitySummaryDto> {
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await this.recomputeSummaryInTx(tx, incidentId);
      const rows = (await tx.$queryRawUnsafe(
        SELECT_SUMMARY_BASE + 'WHERE incident_id = $1::uuid LIMIT 1',
        incidentId,
      )) as SummaryRow[];
      if (rows.length === 0) {
        throw new NotFoundException('Summary not materialised for this incident');
      }
      return this.summaryRowToDto(rows[0]!);
    });
  }

  /** Caller is expected to have the tx open. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async recomputeSummaryInTx(tx: any, incidentId: string): Promise<void> {
    const counts = (await tx.$queryRawUnsafe(
      'SELECT ' +
        '  COUNT(*)::int AS total, ' +
        "  COUNT(*) FILTER (WHERE status='ACCOUNTED_FOR')::int AS accounted_for, " +
        "  COUNT(*) FILTER (WHERE status='UNKNOWN')::int AS unknown, " +
        "  COUNT(*) FILTER (WHERE status='EVACUATED')::int AS evacuated, " +
        "  COUNT(*) FILTER (WHERE status='MEDICAL_ASSISTANCE')::int AS medical_assistance, " +
        "  COUNT(*) FILTER (WHERE status='MISSING')::int AS missing " +
        'FROM inc_accountability_records WHERE incident_id = $1::uuid',
      incidentId,
    )) as Array<{
      total: number;
      accounted_for: number;
      unknown: number;
      evacuated: number;
      medical_assistance: number;
      missing: number;
    }>;
    const c = counts[0] ?? {
      total: 0,
      accounted_for: 0,
      unknown: 0,
      evacuated: 0,
      medical_assistance: 0,
      missing: 0,
    };
    await tx.$executeRawUnsafe(
      'INSERT INTO inc_accountability_summary ' +
        '(id, incident_id, total_people, accounted_for, unknown, evacuated, ' +
        ' medical_assistance, missing, last_updated_at) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, now()) ' +
        'ON CONFLICT (incident_id) DO UPDATE SET ' +
        '  total_people = EXCLUDED.total_people, ' +
        '  accounted_for = EXCLUDED.accounted_for, ' +
        '  unknown = EXCLUDED.unknown, ' +
        '  evacuated = EXCLUDED.evacuated, ' +
        '  medical_assistance = EXCLUDED.medical_assistance, ' +
        '  missing = EXCLUDED.missing, ' +
        '  last_updated_at = now()',
      generateId(),
      incidentId,
      c.total,
      c.accounted_for,
      c.unknown,
      c.evacuated,
      c.medical_assistance,
      c.missing,
    );
  }

  private async assertResponder(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'saf-001:write',
    ]);
    if (!ok) {
      throw new ForbiddenException('Accountability updates require saf-001:write or school admin.');
    }
  }

  private rowToDto(r: AccountabilityRow): AccountabilityRecordDto {
    return {
      id: r.id,
      incidentId: r.incident_id,
      personId: r.person_id,
      personType: r.person_type as AccountabilityPersonType,
      status: r.status as AccountabilityStatus,
      lastUpdatedBy: r.last_updated_by,
      lastUpdatedAt: r.last_updated_at,
      notes: r.notes,
      createdAt: r.created_at,
      personName: null,
    };
  }

  private summaryRowToDto(r: SummaryRow): AccountabilitySummaryDto {
    return {
      incidentId: r.incident_id,
      totalPeople: r.total_people,
      accountedFor: r.accounted_for,
      unknown: r.unknown,
      evacuated: r.evacuated,
      medicalAssistance: r.medical_assistance,
      missing: r.missing,
      lastUpdatedAt: r.last_updated_at,
    };
  }
}
