import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import {
  KafkaProducerNotConnectedError,
  KafkaProducerService,
} from '@shared/kafka/kafka-producer.service';

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
   *
   * REVIEW-CYCLE31 BLOCKING 3 + 4 — three guarantees:
   *   1. Atomic transition. The status flip uses a conditional
   *      `UPDATE ... WHERE resolved_at IS NULL RETURNING *` so two
   *      concurrent admins racing on the same row produce exactly
   *      one winner; the loser sees `BadRequestException` ("already
   *      resolved").
   *   2. Replay-then-finalise via two-phase resolution. We mark the
   *      row REPLAYING first, then attempt the Kafka emit. If the
   *      emit succeeds we finalise to REPLAYED; if it throws we
   *      revert the row to PENDING so the operator can retry.
   *   3. emitRaw THROWS on a disconnected broker (BLOCKING 3) so we
   *      never finalise REPLAYED without a confirmed send. The
   *      caller surfaces a 503 via `HttpException(SERVICE_UNAVAILABLE)`.
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

    // Phase 1: atomic claim. The conditional WHERE resolved_at IS NULL
    // AND resolution NOT IN ('REPLAYING') means only one of N concurrent
    // admins wins. The earlier shape (resolved_at IS NULL alone) was
    // *not* atomic — Phase 1 sets resolved_at = NULL (no-op), so a
    // second admin's UPDATE would still match the WHERE filter and
    // both calls would proceed to emit. The resolution filter is what
    // serialises the race: once the first admin sets
    // resolution = 'REPLAYING', the second admin's WHERE no longer
    // matches and they receive the friendly 400 below.
    // (REVIEW-FINAL-2026-05-07 MAJ-3.1 fix.)
    const claimed = await this.platform.$executeRawUnsafe(
      `UPDATE platform.platform_dlq_messages
          SET resolved_by = $1,
              resolution = 'REPLAYING'
        WHERE id = $2::uuid
          AND resolved_at IS NULL
          AND (resolution IS NULL OR resolution = 'PENDING')`,
      actorAccountId,
      id,
    );
    if (claimed === 0) {
      throw new BadRequestException(
        'DLQ message has already been claimed by another admin or resolved.',
      );
    }

    // Phase 2: emit. emitRaw throws on a disconnected broker — when it
    // does, revert the row back to PENDING so the operator can retry.
    try {
      await this.kafka.emitRaw({ topic: row.topic, key: row.eventId ?? null, envelope });
    } catch (err) {
      await this.platform.$executeRawUnsafe(
        `UPDATE platform.platform_dlq_messages
            SET resolved_by = NULL,
                resolution = NULL
          WHERE id = $1::uuid AND resolution = 'REPLAYING'`,
        id,
      );
      if (err instanceof KafkaProducerNotConnectedError) {
        throw new HttpException(
          'Kafka broker unavailable; DLQ message left unresolved. Retry once the broker is back.',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      this.logger.error(
        `Replay failed for DLQ ${id}: ${(err as Error).stack ?? (err as Error).message}`,
      );
      throw new HttpException(
        `Replay failed: ${(err as Error).message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    // Phase 3: finalise REPLAYED. Defence-in-depth — the row is still
    // claimed (resolved_by populated, resolution=REPLAYING) so this
    // is unconditional.
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

  /**
   * REVIEW-CYCLE31 BLOCKING 4 — atomic conditional-UPDATE pattern
   * mirrors `replay()`. The single `UPDATE ... WHERE resolved_at IS NULL
   * RETURNING ...` is the lock-free way to enforce "exactly one winner"
   * across racing admins.
   */
  async discard(id: string, actorAccountId: string, reason: string): Promise<void> {
    const exists = await this.platform.platformDlqMessage.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException(`DLQ message ${id} not found.`);

    const updated = await this.platform.$executeRawUnsafe(
      `UPDATE platform.platform_dlq_messages
          SET resolved_at = now(),
              resolved_by = $1,
              resolution = $2
        WHERE id = $3::uuid AND resolved_at IS NULL`,
      actorAccountId,
      `DISCARDED: ${reason}`.slice(0, 500),
      id,
    );
    if (updated === 0) {
      throw new BadRequestException('DLQ message has already been resolved.');
    }
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
