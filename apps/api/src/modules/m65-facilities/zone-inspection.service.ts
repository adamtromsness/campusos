import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import { PermissionCheckService } from '@modules/m00-platform';
import { OutboxService } from '@shared/kafka';
import { assertCanManage } from './buildings.service';
import { deterministicWorkOrderCreatedEventId } from './event-ids';
import {
  CreateZoneInspectionDto,
  ZoneInspectionRating,
  ZoneInspectionResponseDto,
} from './dto/facilities.dto';

/**
 * ZoneInspectionService — P2-18a Step 2.
 *
 * Per-zone supervisor spot checks. THE KEYSTONE — on FAIL, the service
 * creates a follow-up fac_work_orders row in the same tenant tx as the
 * inspection insert and back-fills follow_up_work_order_id so the audit
 * chain stays atomic. The work order lands as priority=HIGH,
 * work_order_type=DEEP_CLEAN, status=OPEN, with a description that
 * threads the inspection's notes for the assigned FM.
 *
 * On NEEDS_IMPROVEMENT the inspector can still flag follow_up_required
 * for manual queueing — the auto-work-order path is FAIL-only by
 * design so schools do not get spammed with low-stakes work orders.
 */
@Injectable()
export class ZoneInspectionService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly outbox: OutboxService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  async list(args: {
    zoneId?: string;
    rating?: ZoneInspectionRating;
    fromDate?: string;
    toDate?: string;
  }): Promise<ZoneInspectionResponseDto[]> {
    const tenant = getCurrentTenant();
    const where: string[] = ['z.school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    if (args.zoneId) {
      where.push('i.zone_id = $' + (params.length + 1) + '::uuid');
      params.push(args.zoneId);
    }
    if (args.rating) {
      where.push('i.overall_rating = $' + (params.length + 1));
      params.push(args.rating);
    }
    if (args.fromDate) {
      where.push('i.inspection_date >= $' + (params.length + 1) + '::date');
      params.push(args.fromDate);
    }
    if (args.toDate) {
      where.push('i.inspection_date <= $' + (params.length + 1) + '::date');
      params.push(args.toDate);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        INSP_SELECT +
          'JOIN fac_zones z ON z.id = i.zone_id ' +
          'WHERE ' +
          where.join(' AND ') +
          ' ORDER BY i.inspection_date DESC, i.created_at DESC LIMIT 200',
        ...params,
      );
    })) as InspRow[];
    return rows.map(inspRowToDto);
  }

  async getById(id: string): Promise<ZoneInspectionResponseDto> {
    // REVIEW-P2C18 BLOCKING 4 — school-scope the inspection fetch via
    // fac_zones.school_id. A School A facilities reader with a School B
    // inspection UUID now collapses to 404 don't-leak-existence rather
    // than reading the foreign-school row.
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        INSP_SELECT +
          'JOIN fac_zones z ON z.id = i.zone_id ' +
          'WHERE i.id = $1::uuid AND z.school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      );
    })) as InspRow[];
    if (rows.length === 0) throw new NotFoundException('Zone inspection not found');
    return inspRowToDto(rows[0]!);
  }

  async create(
    input: CreateZoneInspectionDto,
    actor: ResolvedActor,
  ): Promise<ZoneInspectionResponseDto> {
    await assertCanManage(actor, this.permCheck);
    if (!actor.personId) {
      throw new ForbiddenException('Zone inspection creation requires an authenticated person');
    }
    const tenant = getCurrentTenant();
    const inspectionId = generateId();
    let workOrderId: string | null = null;

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Validate zone belongs to this tenant.
      const zone = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, name FROM fac_zones WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        input.zoneId,
        tenant.schoolId,
      )) as Array<{ id: string; name: string }>;
      if (zone.length === 0) {
        throw new NotFoundException('Zone not found in this school');
      }

      // On FAIL: auto-create the follow-up work order FIRST, capture its
      // id, then INSERT the inspection with follow_up_work_order_id
      // populated so the audit chain is atomic.
      //
      // REVIEW-P2C18 BLOCKING 1 — enqueue the durable
      // fac.work_order.created emit INSIDE this tenant tx via
      // OutboxService.enqueueInTx. The outbox row commits with the
      // work order + inspection INSERTs so a broker outage no longer
      // drops the downstream FM notification. Deterministic event_id
      // keyed on the work_order id so retries land the same envelope.
      if (input.overallRating === 'FAIL') {
        workOrderId = generateId();
        const noteSuffix = input.notes ? ' Notes: ' + input.notes : '';
        await tx.$executeRawUnsafe(
          'INSERT INTO fac_work_orders (id, school_id, work_order_type, priority, status, description, created_by) ' +
            "VALUES ($1::uuid, $2::uuid, 'DEEP_CLEAN', 'HIGH', 'OPEN', $3, $4::uuid)",
          workOrderId,
          tenant.schoolId,
          'Auto-created from FAILED zone inspection on ' + zone[0]!.name + '.' + noteSuffix,
          actor.personId,
        );
        await this.outbox.enqueueInTx(tx, {
          topic: 'fac.work_order.created',
          key: workOrderId,
          sourceModule: 'facilities',
          eventId: deterministicWorkOrderCreatedEventId(workOrderId),
          payload: {
            workOrderId: workOrderId,
            sourceRefId: workOrderId,
            schoolId: tenant.schoolId,
            workOrderType: 'DEEP_CLEAN',
            priority: 'HIGH',
            status: 'OPEN',
            originZoneInspectionId: inspectionId,
          },
        });
      }

      const followUpRequired = input.followUpRequired === true || input.overallRating === 'FAIL';

      await tx.$executeRawUnsafe(
        'INSERT INTO fac_zone_inspections ' +
          '(id, zone_id, inspector_id, inspection_date, overall_rating, notes, follow_up_required, follow_up_work_order_id) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5, $6, $7, $8::uuid)',
        inspectionId,
        input.zoneId,
        actor.personId,
        input.inspectionDate,
        input.overallRating,
        input.notes ?? null,
        followUpRequired,
        workOrderId,
      );
    });

    // REVIEW-P2C18 BLOCKING 1 — emit is now enqueued INSIDE the tenant
    // tx above via OutboxService.enqueueInTx so a broker hiccup can no
    // longer cause the inspection + auto-work-order + downstream
    // notification trio to drift apart.

    return this.getById(inspectionId);
  }
}

const INSP_SELECT =
  'SELECT i.id::text AS id, i.zone_id::text AS zone_id, ' +
  '(SELECT name FROM fac_zones WHERE id = i.zone_id) AS zone_name, ' +
  'i.inspector_id::text AS inspector_id, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.iam_person ip WHERE ip.id = i.inspector_id) AS inspector_name, " +
  'i.inspection_date::text AS inspection_date, i.overall_rating, i.notes, i.follow_up_required, ' +
  'i.follow_up_work_order_id::text AS follow_up_work_order_id FROM fac_zone_inspections i ';

interface InspRow {
  id: string;
  zone_id: string;
  zone_name: string | null;
  inspector_id: string;
  inspector_name: string | null;
  inspection_date: string;
  overall_rating: string;
  notes: string | null;
  follow_up_required: boolean;
  follow_up_work_order_id: string | null;
}

function inspRowToDto(r: InspRow): ZoneInspectionResponseDto {
  return {
    id: r.id,
    zoneId: r.zone_id,
    zoneName: r.zone_name,
    inspectorId: r.inspector_id,
    inspectorName: r.inspector_name,
    inspectionDate: r.inspection_date,
    overallRating: r.overall_rating as ZoneInspectionRating,
    notes: r.notes,
    followUpRequired: r.follow_up_required,
    followUpWorkOrderId: r.follow_up_work_order_id,
  };
}
