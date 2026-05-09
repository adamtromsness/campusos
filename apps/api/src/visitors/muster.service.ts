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
import { PermissionCheckService } from '../iam/permission-check.service';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import type {
  CreateMusterDto,
  DrillType,
  MusterDetailDto,
  MusterDto,
  MusterEntryDto,
  MusterEntryStatus,
  MusterSummaryDto,
  UpdateMusterEntryDto,
} from './dto/visitor.dto';

interface MusterRow {
  id: string;
  school_id: string;
  drill_type: string;
  description: string | null;
  incident_id: string | null;
  created_by: string;
  created_first: string | null;
  created_last: string | null;
  total_on_site_at_snapshot: number;
  closed_at: string | null;
  closed_by: string | null;
  created_at: string;
}

interface MusterEntryRow {
  id: string;
  muster_id: string;
  sign_in_id: string;
  visitor_name: string;
  visitor_type: string;
  visitor_company: string | null;
  building: string | null;
  status: string;
  notes: string | null;
  marked_by: string | null;
  marked_first: string | null;
  marked_last: string | null;
  marked_at: string | null;
  created_at: string;
}

const SELECT_MUSTER_BASE =
  'SELECT m.id::text AS id, m.school_id::text AS school_id, m.drill_type, m.description, ' +
  'm.incident_id::text AS incident_id, m.created_by::text AS created_by, ' +
  'cp.first_name AS created_first, cp.last_name AS created_last, ' +
  'm.total_on_site_at_snapshot, ' +
  'TO_CHAR(m.closed_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS closed_at, ' +
  'm.closed_by::text AS closed_by, ' +
  'TO_CHAR(m.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at ' +
  'FROM vis_emergency_muster m ' +
  'LEFT JOIN platform.platform_users cpu ON cpu.id = m.created_by ' +
  'LEFT JOIN platform.iam_person cp ON cp.id = cpu.person_id ';

const SELECT_ENTRY_BASE =
  'SELECT e.id::text AS id, e.muster_id::text AS muster_id, e.sign_in_id::text AS sign_in_id, ' +
  'e.visitor_name, e.visitor_type, e.visitor_company, e.building, e.status, e.notes, ' +
  'e.marked_by::text AS marked_by, ' +
  'mp.first_name AS marked_first, mp.last_name AS marked_last, ' +
  'TO_CHAR(e.marked_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS marked_at, ' +
  'TO_CHAR(e.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at ' +
  'FROM vis_muster_entries e ' +
  'LEFT JOIN platform.platform_users mpu ON mpu.id = e.marked_by ' +
  'LEFT JOIN platform.iam_person mp ON mp.id = mpu.person_id ';

function nameOrNull(first: string | null, last: string | null): string | null {
  if (!first && !last) return null;
  return [first ?? '', last ?? ''].filter(Boolean).join(' ');
}

/**
 * MusterService — emergency muster snapshot + accountability tracker.
 *
 * EMERGENCY SNAPSHOT KEYSTONE — create() walks the partial INDEX
 * vis_si_active_idx (school_id, signed_in_at) WHERE signed_out_at
 * IS NULL in one batch INSERT to materialise vis_muster_entries
 * rows for everyone currently on-site. visitor_name + visitor_type
 * + building are SNAPSHOT fields, frozen at creation time so the
 * audit row remains meaningful even when the underlying visitor /
 * visitor type is later updated.
 */
@Injectable()
export class MusterService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
    private readonly kafka: KafkaProducerService,
  ) {}

  private async assertStaff(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'saf-002:write',
    ]);
    if (!ok) {
      throw new ForbiddenException('Emergency muster requires saf-002:write');
    }
  }

  async list(): Promise<MusterDto[]> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const tenant = getCurrentTenant();
      const rows = (await client.$queryRawUnsafe(
        SELECT_MUSTER_BASE + 'WHERE m.school_id = $1::uuid ORDER BY m.created_at DESC LIMIT 100',
        tenant.schoolId,
      )) as MusterRow[];
      return rows.map((r) => this.rowToDto(r));
    });
  }

  async create(input: CreateMusterDto, actor: ResolvedActor): Promise<MusterDetailDto> {
    await this.assertStaff(actor);
    const tenant = getCurrentTenant();
    const musterId = generateId();
    const drillType: DrillType = input.drillType ?? 'FIRE_DRILL';

    const detail = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Snapshot — pull active sign-ins under the same tx so a
      // visitor signing out mid-snapshot is still captured.
      const active = (await tx.$queryRawUnsafe(
        'SELECT s.id::text AS sign_in_id, ' +
          "v.first_name || ' ' || v.last_name AS visitor_name, " +
          'vt.name AS visitor_type, v.company AS visitor_company ' +
          'FROM vis_sign_ins s ' +
          'JOIN vis_visitors v ON v.id = s.visitor_id ' +
          'LEFT JOIN vis_visitor_types vt ON vt.id = v.visitor_type_id ' +
          'WHERE s.school_id = $1::uuid AND s.signed_out_at IS NULL ' +
          'ORDER BY s.signed_in_at ASC',
        tenant.schoolId,
      )) as Array<{
        sign_in_id: string;
        visitor_name: string;
        visitor_type: string | null;
        visitor_company: string | null;
      }>;

      await tx.$executeRawUnsafe(
        'INSERT INTO vis_emergency_muster (id, school_id, incident_id, drill_type, description, created_by, total_on_site_at_snapshot) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid, $7)',
        musterId,
        tenant.schoolId,
        input.incidentId ?? null,
        drillType,
        input.description ?? null,
        actor.accountId,
        active.length,
      );

      for (const row of active) {
        await tx.$executeRawUnsafe(
          'INSERT INTO vis_muster_entries (id, muster_id, sign_in_id, visitor_name, visitor_type, visitor_company) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6)',
          generateId(),
          musterId,
          row.sign_in_id,
          row.visitor_name,
          row.visitor_type ?? 'Unknown',
          row.visitor_company,
        );
      }

      const musterRows = (await tx.$queryRawUnsafe(
        SELECT_MUSTER_BASE + 'WHERE m.id = $1::uuid',
        musterId,
      )) as MusterRow[];
      const entryRows = (await tx.$queryRawUnsafe(
        SELECT_ENTRY_BASE + 'WHERE e.muster_id = $1::uuid ORDER BY e.visitor_name ASC',
        musterId,
      )) as MusterEntryRow[];
      return {
        muster: this.rowToDto(musterRows[0]!),
        entries: entryRows.map((er) => this.entryRowToDto(er)),
        summary: this.summarise(entryRows),
      };
    });

    await this.kafka.emit({
      topic: 'vis.muster.created',
      key: musterId,
      sourceModule: 'visitors',
      payload: {
        musterId,
        schoolId: tenant.schoolId,
        drillType,
        totalOnSiteAtSnapshot: detail.muster.totalOnSiteAtSnapshot,
        createdBy: actor.accountId,
        sourceRefId: musterId,
      },
    });

    return detail;
  }

  /** Used by the Step 8 reception dashboard — returns active muster (closed_at IS NULL) for the prompt. */
  async getActive(): Promise<MusterDto | null> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const tenant = getCurrentTenant();
      const rows = (await client.$queryRawUnsafe(
        SELECT_MUSTER_BASE +
          'WHERE m.school_id = $1::uuid AND m.closed_at IS NULL ORDER BY m.created_at DESC LIMIT 1',
        tenant.schoolId,
      )) as MusterRow[];
      if (rows.length === 0) return null;
      return this.rowToDto(rows[0]!);
    });
  }

  async getDetail(id: string): Promise<MusterDetailDto> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const tenant = getCurrentTenant();
      const musterRows = (await client.$queryRawUnsafe(
        SELECT_MUSTER_BASE + 'WHERE m.school_id = $1::uuid AND m.id = $2::uuid',
        tenant.schoolId,
        id,
      )) as MusterRow[];
      if (musterRows.length === 0) throw new NotFoundException('Muster not found');
      const entryRows = (await client.$queryRawUnsafe(
        SELECT_ENTRY_BASE + 'WHERE e.muster_id = $1::uuid ORDER BY e.visitor_name ASC',
        id,
      )) as MusterEntryRow[];
      return {
        muster: this.rowToDto(musterRows[0]!),
        entries: entryRows.map((er) => this.entryRowToDto(er)),
        summary: this.summarise(entryRows),
      };
    });
  }

  async updateEntry(
    entryId: string,
    input: UpdateMusterEntryDto,
    actor: ResolvedActor,
  ): Promise<MusterEntryDto> {
    await this.assertStaff(actor);
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, muster_id::text AS muster_id FROM vis_muster_entries WHERE id = $1::uuid FOR UPDATE',
        entryId,
      )) as Array<{ id: string; muster_id: string }>;
      if (lock.length === 0) throw new NotFoundException('Muster entry not found');
      // Ensure the entry belongs to a muster in the calling tenant.
      const tenantCheck = (await tx.$queryRawUnsafe(
        'SELECT m.school_id::text AS school_id FROM vis_emergency_muster m WHERE m.id = $1::uuid',
        lock[0]!.muster_id,
      )) as Array<{ school_id: string }>;
      const tenant = getCurrentTenant();
      if (tenantCheck.length === 0 || tenantCheck[0]!.school_id !== tenant.schoolId) {
        throw new NotFoundException('Muster entry not found');
      }
      // UNKNOWN status with marked_by set is rejected by the schema
      // CHECK; service-side enforce the lockstep so we always pass.
      if (input.status === 'UNKNOWN') {
        await tx.$executeRawUnsafe(
          "UPDATE vis_muster_entries SET status = 'UNKNOWN', notes = $1, " +
            'marked_by = NULL, marked_at = NULL, updated_at = now() WHERE id = $2::uuid',
          input.notes ?? null,
          entryId,
        );
      } else {
        await tx.$executeRawUnsafe(
          'UPDATE vis_muster_entries SET status = $1, notes = $2, ' +
            'marked_by = $3::uuid, marked_at = now(), updated_at = now() WHERE id = $4::uuid',
          input.status,
          input.notes ?? null,
          actor.accountId,
          entryId,
        );
      }
      const rows = (await tx.$queryRawUnsafe(
        SELECT_ENTRY_BASE + 'WHERE e.id = $1::uuid',
        entryId,
      )) as MusterEntryRow[];
      return this.entryRowToDto(rows[0]!);
    });
  }

  async getSummary(id: string): Promise<MusterSummaryDto> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const tenant = getCurrentTenant();
      const rows = (await client.$queryRawUnsafe(
        'SELECT e.status, COUNT(*)::int AS c FROM vis_muster_entries e ' +
          'JOIN vis_emergency_muster m ON m.id = e.muster_id ' +
          'WHERE m.school_id = $1::uuid AND e.muster_id = $2::uuid GROUP BY e.status',
        tenant.schoolId,
        id,
      )) as Array<{ status: string; c: number }>;
      const counts: Record<string, number> = {
        UNKNOWN: 0,
        ACCOUNTED_FOR: 0,
        EVACUATED: 0,
        ASSISTANCE_NEEDED: 0,
      };
      for (const r of rows) counts[r.status] = r.c;
      const u = counts.UNKNOWN ?? 0;
      const af = counts.ACCOUNTED_FOR ?? 0;
      const ev = counts.EVACUATED ?? 0;
      const an = counts.ASSISTANCE_NEEDED ?? 0;
      return {
        total: u + af + ev + an,
        unknown: u,
        accountedFor: af,
        evacuated: ev,
        assistanceNeeded: an,
      };
    });
  }

  async close(id: string, actor: ResolvedActor): Promise<MusterDto> {
    await this.assertStaff(actor);
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const tenant = getCurrentTenant();
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, closed_at FROM vis_emergency_muster WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        id,
      )) as Array<{ id: string; closed_at: string | null }>;
      if (lock.length === 0) throw new NotFoundException('Muster not found');
      if (lock[0]!.closed_at !== null) {
        throw new BadRequestException('Muster already closed');
      }
      await tx.$executeRawUnsafe(
        'UPDATE vis_emergency_muster SET closed_at = now(), closed_by = $1::uuid, updated_at = now() WHERE id = $2::uuid',
        actor.accountId,
        id,
      );
      const rows = (await tx.$queryRawUnsafe(
        SELECT_MUSTER_BASE + 'WHERE m.id = $1::uuid',
        id,
      )) as MusterRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  private summarise(entries: MusterEntryRow[]): MusterSummaryDto {
    const counts: Record<string, number> = {
      UNKNOWN: 0,
      ACCOUNTED_FOR: 0,
      EVACUATED: 0,
      ASSISTANCE_NEEDED: 0,
    };
    for (const e of entries) counts[e.status] = (counts[e.status] ?? 0) + 1;
    return {
      total: entries.length,
      unknown: counts.UNKNOWN ?? 0,
      accountedFor: counts.ACCOUNTED_FOR ?? 0,
      evacuated: counts.EVACUATED ?? 0,
      assistanceNeeded: counts.ASSISTANCE_NEEDED ?? 0,
    };
  }

  private rowToDto(r: MusterRow): MusterDto {
    return {
      id: r.id,
      schoolId: r.school_id,
      drillType: r.drill_type as DrillType,
      description: r.description,
      incidentId: r.incident_id,
      createdBy: r.created_by,
      createdByName: nameOrNull(r.created_first, r.created_last),
      totalOnSiteAtSnapshot: r.total_on_site_at_snapshot,
      closedAt: r.closed_at,
      closedBy: r.closed_by,
      createdAt: r.created_at,
    };
  }

  private entryRowToDto(r: MusterEntryRow): MusterEntryDto {
    return {
      id: r.id,
      musterId: r.muster_id,
      signInId: r.sign_in_id,
      visitorName: r.visitor_name,
      visitorType: r.visitor_type,
      visitorCompany: r.visitor_company,
      building: r.building,
      status: r.status as MusterEntryStatus,
      notes: r.notes,
      markedBy: r.marked_by,
      markedByName: nameOrNull(r.marked_first, r.marked_last),
      markedAt: r.marked_at,
      createdAt: r.created_at,
    };
  }
}
