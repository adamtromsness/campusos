import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import {
  BroadcastAnalyticsDto,
  BroadcastAnalyticsRowDto,
  BroadcastDeliveryEventDto,
} from './dto/communications-advanced.dto';

interface AnalyticsRow {
  id: string;
  broadcast_id: string;
  segment_id: string | null;
  segment_name: string | null;
  total_recipients: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  unsubscribed: number;
  delivery_rate: string | null;
  open_rate: string | null;
  click_rate: string | null;
  last_updated_at: string | null;
}

function rowToDto(row: AnalyticsRow): BroadcastAnalyticsRowDto {
  return {
    id: row.id,
    broadcastId: row.broadcast_id,
    segmentId: row.segment_id,
    segmentName: row.segment_name,
    totalRecipients: Number(row.total_recipients),
    delivered: Number(row.delivered),
    opened: Number(row.opened),
    clicked: Number(row.clicked),
    bounced: Number(row.bounced),
    unsubscribed: Number(row.unsubscribed),
    deliveryRate: row.delivery_rate !== null ? Number(row.delivery_rate) : null,
    openRate: row.open_rate !== null ? Number(row.open_rate) : null,
    clickRate: row.click_rate !== null ? Number(row.click_rate) : null,
    lastUpdatedAt: row.last_updated_at,
  };
}

/**
 * BroadcastAnalyticsService — read surface plus the worker entry
 * point for delivery webhook events.
 *
 * Read contract: `getForBroadcast(broadcastId)` returns one row per
 * segment plus the (segment_id IS NULL) aggregate row. The dashboard
 * renders the per-segment funnel underneath the aggregate.
 *
 * Worker contract: `applyDeliveryEvent(event)` is called by the
 * BroadcastAnalyticsWorker on every inbound delivery webhook. The
 * update is an UPSERT keyed on UNIQUE(broadcast_id, segment_id) —
 * duplicate webhooks land as updates (not new rows), so the
 * dashboard counts stay monotonic.
 *
 * Rate computation: delivery_rate = delivered / total_recipients,
 * open_rate = opened / delivered, click_rate = clicked / opened.
 * NULL when the denominator is 0 to avoid division blowups.
 */
@Injectable()
export class BroadcastAnalyticsService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async getForBroadcast(broadcastId: string): Promise<BroadcastAnalyticsDto> {
    return this.tenantPrisma.executeInTenantContext(async (client: PrismaClient) => {
      const rows = await client.$queryRawUnsafe<AnalyticsRow[]>(
        'SELECT a.id::text AS id, a.broadcast_id::text AS broadcast_id, ' +
          'a.segment_id::text AS segment_id, s.name AS segment_name, ' +
          'a.total_recipients, a.delivered, a.opened, a.clicked, a.bounced, a.unsubscribed, ' +
          'a.delivery_rate::text AS delivery_rate, a.open_rate::text AS open_rate, ' +
          'a.click_rate::text AS click_rate, a.last_updated_at::text AS last_updated_at ' +
          'FROM msg_broadcast_analytics a ' +
          'LEFT JOIN msg_broadcast_segments s ON s.id = a.segment_id ' +
          'WHERE a.broadcast_id = $1::uuid ' +
          'ORDER BY a.segment_id NULLS FIRST',
        broadcastId,
      );
      const perSegment: BroadcastAnalyticsRowDto[] = [];
      let aggregate: BroadcastAnalyticsRowDto | null = null;
      for (const row of rows) {
        const dto = rowToDto(row);
        if (dto.segmentId === null) aggregate = dto;
        else perSegment.push(dto);
      }
      return { broadcastId, perSegment, aggregate };
    });
  }

  /**
   * Worker entry point — upsert delivery counters from a webhook
   * event. Rates are recomputed inside the same statement.
   */
  async applyDeliveryEvent(event: BroadcastDeliveryEventDto): Promise<BroadcastAnalyticsRowDto> {
    if (!event.broadcastId) {
      throw new BadRequestException('broadcastId is required');
    }
    const totalRecipients = event.totalRecipients ?? 0;
    if (totalRecipients < 0) {
      throw new BadRequestException('totalRecipients must be >= 0');
    }
    const delivered = event.delivered ?? 0;
    const opened = event.opened ?? 0;
    const clicked = event.clicked ?? 0;
    const bounced = event.bounced ?? 0;
    const unsubscribed = event.unsubscribed ?? 0;
    const deliveryRate = totalRecipients > 0 ? delivered / totalRecipients : null;
    const openRate = delivered > 0 ? opened / delivered : null;
    const clickRate = opened > 0 ? clicked / opened : null;

    return this.tenantPrisma.executeInTenantTransaction(async (tx: PrismaClient) => {
      // UPSERT keyed on (broadcast_id, segment_id) — segment_id NULL
      // is the aggregate slot enforced by the partial UNIQUE INDEX
      // msg_broadcast_analytics_broadcast_no_segment_uq.
      const newId = generateId();
      // Branch by whether segment_id is NULL since Postgres treats
      // NULL=NULL as not-equal in regular UNIQUE constraints; the
      // aggregate path uses the partial unique index. We look the
      // existing row up first and either INSERT or UPDATE.
      const existing = event.segmentId
        ? await tx.$queryRawUnsafe<Array<{ id: string }>>(
            'SELECT id::text AS id FROM msg_broadcast_analytics ' +
              'WHERE broadcast_id = $1::uuid AND segment_id = $2::uuid LIMIT 1',
            event.broadcastId,
            event.segmentId,
          )
        : await tx.$queryRawUnsafe<Array<{ id: string }>>(
            'SELECT id::text AS id FROM msg_broadcast_analytics ' +
              'WHERE broadcast_id = $1::uuid AND segment_id IS NULL LIMIT 1',
            event.broadcastId,
          );

      if (existing.length === 0) {
        await tx.$executeRawUnsafe(
          'INSERT INTO msg_broadcast_analytics ' +
            '(id, broadcast_id, segment_id, total_recipients, delivered, opened, clicked, ' +
            'bounced, unsubscribed, delivery_rate, open_rate, click_rate, last_updated_at) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())',
          newId,
          event.broadcastId,
          event.segmentId ?? null,
          totalRecipients,
          delivered,
          opened,
          clicked,
          bounced,
          unsubscribed,
          deliveryRate,
          openRate,
          clickRate,
        );
      } else {
        await tx.$executeRawUnsafe(
          'UPDATE msg_broadcast_analytics SET ' +
            'total_recipients = $2, delivered = $3, opened = $4, clicked = $5, ' +
            'bounced = $6, unsubscribed = $7, delivery_rate = $8, open_rate = $9, ' +
            'click_rate = $10, last_updated_at = now() ' +
            'WHERE id = $1::uuid',
          existing[0]!.id,
          totalRecipients,
          delivered,
          opened,
          clicked,
          bounced,
          unsubscribed,
          deliveryRate,
          openRate,
          clickRate,
        );
      }

      const rows = await (event.segmentId
        ? tx.$queryRawUnsafe<AnalyticsRow[]>(
            'SELECT a.id::text AS id, a.broadcast_id::text AS broadcast_id, ' +
              'a.segment_id::text AS segment_id, s.name AS segment_name, ' +
              'a.total_recipients, a.delivered, a.opened, a.clicked, a.bounced, a.unsubscribed, ' +
              'a.delivery_rate::text AS delivery_rate, a.open_rate::text AS open_rate, ' +
              'a.click_rate::text AS click_rate, a.last_updated_at::text AS last_updated_at ' +
              'FROM msg_broadcast_analytics a ' +
              'LEFT JOIN msg_broadcast_segments s ON s.id = a.segment_id ' +
              'WHERE a.broadcast_id = $1::uuid AND a.segment_id = $2::uuid LIMIT 1',
            event.broadcastId,
            event.segmentId,
          )
        : tx.$queryRawUnsafe<AnalyticsRow[]>(
            'SELECT a.id::text AS id, a.broadcast_id::text AS broadcast_id, ' +
              'a.segment_id::text AS segment_id, NULL::text AS segment_name, ' +
              'a.total_recipients, a.delivered, a.opened, a.clicked, a.bounced, a.unsubscribed, ' +
              'a.delivery_rate::text AS delivery_rate, a.open_rate::text AS open_rate, ' +
              'a.click_rate::text AS click_rate, a.last_updated_at::text AS last_updated_at ' +
              'FROM msg_broadcast_analytics a ' +
              'WHERE a.broadcast_id = $1::uuid AND a.segment_id IS NULL LIMIT 1',
            event.broadcastId,
          ));
      return rowToDto(rows[0]!);
    });
  }
}
