import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { CreateTimelineEntryDto, TimelineEntryDto } from './dto/incident.dto';

interface TimelineRow {
  id: string;
  incident_id: string;
  recorded_by: string;
  recorded_by_first: string | null;
  recorded_by_last: string | null;
  event_type: string;
  description: string;
  metadata: unknown;
  recorded_at: string;
}

const SELECT_TIMELINE_BASE =
  'SELECT t.id::text AS id, t.incident_id::text AS incident_id, ' +
  '       t.recorded_by::text AS recorded_by, ' +
  '       ip.first_name AS recorded_by_first, ip.last_name AS recorded_by_last, ' +
  '       t.event_type, t.description, t.metadata, ' +
  '       t.recorded_at::text AS recorded_at ' +
  'FROM inc_incident_timeline t ' +
  'LEFT JOIN platform.platform_users pu ON pu.id = t.recorded_by ' +
  'LEFT JOIN platform.iam_person ip ON ip.id = pu.person_id ';

/**
 * P2C2 Step 6 — Immutable incident timeline.
 *
 * Append-only legal record of incident events. The service exposes
 * exactly two methods - `append` and `listForIncident`. There is
 * **no PATCH method, no DELETE method, no archive method** -
 * the immutability invariant is enforced by service-side discipline
 * per ADR-010 mirroring Cycle 8 tkt_ticket_activity, Cycle 10
 * hlth_health_access_log, and Cycle 11 svc_referral_activity.
 *
 * The timeline is the auto-generation source for the after-action
 * report. Every event during an incident must be captured here.
 */
@Injectable()
export class TimelineService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  /** Append a timeline entry. The only mutation method on the service. */
  async append(
    incidentId: string,
    input: CreateTimelineEntryDto,
    actor: ResolvedActor,
  ): Promise<TimelineEntryDto> {
    await this.assertResponder(actor);
    const tenant = getCurrentTenant();

    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Validate the incident belongs to this tenant.
      const incs = (await tx.$queryRawUnsafe(
        'SELECT id FROM inc_incidents WHERE school_id = $1::uuid AND id = $2::uuid LIMIT 1',
        tenant.schoolId,
        incidentId,
      )) as Array<{ id: string }>;
      if (incs.length === 0) throw new NotFoundException('Incident not found');

      const id = generateId();
      await tx.$executeRawUnsafe(
        'INSERT INTO inc_incident_timeline ' +
          '(id, incident_id, recorded_by, event_type, description, metadata) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::jsonb)',
        id,
        incidentId,
        actor.accountId,
        input.eventType,
        input.description,
        input.metadata ? JSON.stringify(input.metadata) : null,
      );

      const rows = (await tx.$queryRawUnsafe(
        SELECT_TIMELINE_BASE + 'WHERE t.id = $1::uuid LIMIT 1',
        id,
      )) as TimelineRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  async listForIncident(incidentId: string): Promise<TimelineEntryDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      // JOIN through inc_incidents enforces school_id scoping even if a
      // caller probes a foreign incident_id directly.
      const rows = (await client.$queryRawUnsafe(
        SELECT_TIMELINE_BASE +
          'JOIN inc_incidents i ON i.id = t.incident_id AND i.school_id = $1::uuid ' +
          'WHERE t.incident_id = $2::uuid ORDER BY t.recorded_at ASC, t.id ASC',
        tenant.schoolId,
        incidentId,
      )) as TimelineRow[];
      return rows.map((r) => this.rowToDto(r));
    });
  }

  private async assertResponder(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'saf-001:write',
    ]);
    if (!ok) {
      throw new ForbiddenException(
        'Timeline append requires saf-001:write or school admin (no admin override on read).',
      );
    }
  }

  private rowToDto(r: TimelineRow): TimelineEntryDto {
    const recordedByName =
      r.recorded_by_first || r.recorded_by_last
        ? [r.recorded_by_first, r.recorded_by_last].filter(Boolean).join(' ')
        : null;
    return {
      id: r.id,
      incidentId: r.incident_id,
      recordedBy: r.recorded_by,
      recordedByName,
      eventType: r.event_type,
      description: r.description,
      metadata: (r.metadata as Record<string, unknown> | null) ?? null,
      recordedAt: r.recorded_at,
    };
  }
}
