import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { KafkaProducerService } from '../kafka/kafka-producer.service';

/**
 * Cycle 31 Step 7 — DLQ Service.
 *
 * Surfaces every dead-letter message across every consumer group via
 * platform.platform_dlq_messages (created by the Cycle 3
 * KafkaConsumerService retry-park machinery, REVIEW-CYCLE3 BLOCKING 1).
 *
 * Operations:
 *   - list({...filters}) — paginated read for the admin dashboard
 *   - getById(id)        — full payload + headers for diagnosis
 *   - replay(id, actor)  — re-emit the original event to its topic;
 *                          marks the DLQ row resolved with the
 *                          actor + timestamp for audit.
 *   - discard(id, actor, reason) — acknowledge without replay; the
 *                          row stays for audit but is excluded from
 *                          the active queue counts.
 *
 * The dashboard (Step 9 platform admin) hits these endpoints. The
 * Step 8 alerting pipeline pages the on-call engineer when any DLQ
 * row is older than 15 minutes.
 */
@Injectable()
export class DlqService {
  private readonly logger = new Logger(DlqService.name);

  constructor(
    private readonly platform: PrismaClient,
    private readonly kafka: KafkaProducerService,
  ) {}

  async list(args?: {
    consumerGroup?: string;
    topic?: string;
    tenantId?: string;
    resolved?: boolean;
    limit?: number;
  }): Promise<DlqRow[]> {
    const where: Record<string, unknown> = {};
    if (args?.consumerGroup) where.consumerGroup = args.consumerGroup;
    if (args?.topic) where.topic = args.topic;
    if (args?.tenantId) where.tenantId = args.tenantId;
    if (args?.resolved === true) where.resolvedAt = { not: null };
    if (args?.resolved === false) where.resolvedAt = null;

    const rows = await this.platform.platformDlqMessage.findMany({
      where,
      orderBy: { lastFailedAt: 'desc' },
      take: Math.min(args?.limit ?? 100, 500),
    });
    return rows.map(rowToDto);
  }

  async getById(id: string): Promise<DlqRowFull> {
    const row = await this.platform.platformDlqMessage.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`DLQ message ${id} not found.`);
    return {
      ...rowToDto(row),
      payload: row.payload,
      headers: row.headers ?? null,
      errorMessage: row.errorMessage,
    };
  }

  /**
   * Re-emit the original event to its topic. The topic name in the
   * DLQ row is the wire topic (already env-prefixed), so we emit
   * raw via the producer's bypass path. Marks the DLQ row resolved
   * for audit.
   */
  async replay(id: string, actorAccountId: string): Promise<void> {
    const row = await this.platform.platformDlqMessage.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`DLQ message ${id} not found.`);
    if (row.resolvedAt) {
      throw new BadRequestException('DLQ message has already been resolved.');
    }
    // The payload was the entire envelope when parked. Re-publish
    // verbatim so the original consumer chain handles it.
    const envelope = row.payload as { event_type?: string };
    if (!envelope || typeof envelope !== 'object' || !envelope.event_type) {
      throw new BadRequestException(
        'DLQ payload is not a valid envelope; cannot replay automatically. Use discard.',
      );
    }
    await this.kafka.emitRaw({ topic: row.topic, key: row.eventId ?? null, envelope });
    await this.platform.platformDlqMessage.update({
      where: { id },
      data: {
        resolvedAt: new Date(),
        resolvedBy: actorAccountId,
        resolution: 'REPLAYED',
      },
    });
    this.logger.log({
      message: 'DLQ message replayed',
      dlq_id: id,
      topic: row.topic,
      consumer_group: row.consumerGroup,
      actor_id: actorAccountId,
    });
  }

  async discard(id: string, actorAccountId: string, reason: string): Promise<void> {
    const row = await this.platform.platformDlqMessage.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`DLQ message ${id} not found.`);
    if (row.resolvedAt) {
      throw new BadRequestException('DLQ message has already been resolved.');
    }
    await this.platform.platformDlqMessage.update({
      where: { id },
      data: {
        resolvedAt: new Date(),
        resolvedBy: actorAccountId,
        resolution: `DISCARDED: ${reason}`,
      },
    });
  }

  /**
   * Lightweight stat for the platform admin dashboard. Counts
   * unresolved DLQ rows per consumer group + per topic.
   */
  async stats(): Promise<DlqStats> {
    const total = await this.platform.platformDlqMessage.count({ where: { resolvedAt: null } });
    const olderThan15Min = await this.platform.platformDlqMessage.count({
      where: {
        resolvedAt: null,
        lastFailedAt: { lt: new Date(Date.now() - 15 * 60 * 1000) },
      },
    });
    const byGroup = await this.platform.platformDlqMessage.groupBy({
      by: ['consumerGroup'],
      where: { resolvedAt: null },
      _count: true,
    });
    return {
      totalUnresolved: total,
      olderThan15Min,
      byConsumerGroup: byGroup.map((g: { consumerGroup: string; _count: number }) => ({
        consumerGroup: g.consumerGroup,
        count: g._count,
      })),
    };
  }
}

export interface DlqRow {
  id: string;
  topic: string;
  partition: number;
  kafkaOffset: string;
  consumerGroup: string;
  eventId: string | null;
  tenantId: string | null;
  errorClass: string | null;
  retryCount: number;
  firstFailedAt: string;
  lastFailedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolution: string | null;
  ageHours: number;
}

export interface DlqRowFull extends DlqRow {
  payload: unknown;
  headers: unknown;
  errorMessage: string;
}

export interface DlqStats {
  totalUnresolved: number;
  olderThan15Min: number;
  byConsumerGroup: Array<{ consumerGroup: string; count: number }>;
}

function rowToDto(r: {
  id: string;
  topic: string;
  partition: number;
  kafkaOffset: bigint;
  consumerGroup: string;
  eventId: string | null;
  tenantId: string | null;
  errorClass: string | null;
  retryCount: number;
  firstFailedAt: Date;
  lastFailedAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  resolution: string | null;
}): DlqRow {
  const ageMs = Date.now() - r.lastFailedAt.getTime();
  return {
    id: r.id,
    topic: r.topic,
    partition: r.partition,
    kafkaOffset: r.kafkaOffset.toString(),
    consumerGroup: r.consumerGroup,
    eventId: r.eventId,
    tenantId: r.tenantId,
    errorClass: r.errorClass,
    retryCount: r.retryCount,
    firstFailedAt: r.firstFailedAt.toISOString(),
    lastFailedAt: r.lastFailedAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    resolvedBy: r.resolvedBy,
    resolution: r.resolution,
    ageHours: Math.floor(ageMs / (60 * 60 * 1000)),
  };
}
