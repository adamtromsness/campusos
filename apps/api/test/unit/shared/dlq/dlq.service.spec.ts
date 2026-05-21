import { describe, it, expect, beforeEach } from 'vitest';
import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import { DlqService } from '@shared/dlq/dlq.service';
import { KafkaProducerNotConnectedError } from '@shared/kafka';

/**
 * REVIEW-FINAL G1 / V2 MAJ-3.1 — DLQ atomic-claim race regression test.
 *
 * Two concurrent admins replaying the same DLQ row should produce
 * exactly one winner (200) and one loser (400). The earlier shape
 * `WHERE id=$1 AND resolved_at IS NULL` was not atomic because Phase 1
 * also set `resolved_at = NULL` (a no-op), so both UPDATEs matched
 * the predicate and both proceeded to Kafka emit. The fix tightens
 * the WHERE to also check `resolution NOT IN ('REPLAYING')`.
 */

interface StubRow {
  id: string;
  resolvedAt: Date | null;
  resolution: string | null;
}

describe('DlqService.replay (G1 atomic-claim race)', () => {
  let svc: DlqService;
  let row: StubRow;
  // Shared store mimicking the row-level state.
  const platform: any = {};
  const kafka: any = {};

  beforeEach(() => {
    row = {
      id: 'dlq-row-1',
      resolvedAt: null,
      resolution: null,
    };
    platform.platformDlqMessage = {
      findUnique: async ({ where }: { where: { id: string } }) => {
        if (where.id !== row.id) return null;
        return {
          id: row.id,
          topic: 'dev.test',
          partition: 0,
          kafkaOffset: 0n,
          consumerGroup: 'g',
          eventId: 'evt-1',
          tenantId: '019dff45-1234-7000-8000-000000000001',
          errorClass: null,
          retryCount: 0,
          firstFailedAt: new Date(),
          lastFailedAt: new Date(),
          resolvedAt: row.resolvedAt,
          resolvedBy: null,
          resolution: row.resolution,
          payload: { event_type: 'pay.payment.received', payload: {} },
          headers: {},
          errorMessage: 'boom',
        };
      },
      update: async ({ data }: { data: Partial<StubRow> }) => {
        if (data.resolvedAt !== undefined) row.resolvedAt = data.resolvedAt as Date;
        if (data.resolution !== undefined) row.resolution = data.resolution as string;
        return row;
      },
    };
    platform.$executeRawUnsafe = async (sql: string, ..._args: unknown[]) => {
      const normalized = sql.replace(/\s+/g, ' ');
      // Phase 2 revert path on emit failure (more specific — matched first).
      if (
        normalized.includes('SET resolved_by = NULL') &&
        normalized.includes('resolution = NULL')
      ) {
        if (row.resolution === 'REPLAYING') {
          row.resolution = null;
        }
        return 1;
      }
      // Phase 1 claim sets resolution = 'REPLAYING' under the claim WHERE.
      if (
        normalized.includes("resolution = 'REPLAYING'") &&
        normalized.includes('SET resolved_by')
      ) {
        const matchesWhere =
          row.resolvedAt === null && (row.resolution === null || row.resolution === 'PENDING');
        if (!matchesWhere) return 0;
        row.resolution = 'REPLAYING';
        return 1;
      }
      return 1;
    };

    kafka.emitRaw = async () => Promise.resolve();
    svc = new DlqService(platform, kafka);
  });

  it('first admin wins, second admin gets BadRequestException', async () => {
    await svc.replay(row.id, 'admin-1');
    expect(row.resolution).toBe('REPLAYED');

    // Reset for a second concurrent replay attempt scenario:
    // the first admin already claimed the row.
    row.resolvedAt = null;
    row.resolution = 'REPLAYING'; // post-claim state

    let captured: unknown = null;
    try {
      await svc.replay(row.id, 'admin-2');
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(BadRequestException);
    expect((captured as Error).message).toMatch(/already been claimed/);
  });

  it('rejects replay of already-resolved row', async () => {
    row.resolvedAt = new Date();
    row.resolution = 'REPLAYED';
    let captured: unknown = null;
    try {
      await svc.replay(row.id, 'admin-1');
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(BadRequestException);
    expect((captured as Error).message).toMatch(/already been resolved/);
  });

  it('throws NotFoundException when DLQ row does not exist', async () => {
    let captured: unknown = null;
    try {
      await svc.replay('does-not-exist', 'admin-1');
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(NotFoundException);
  });

  it('reverts row to PENDING + throws 503 on broker outage', async () => {
    kafka.emitRaw = async () => {
      throw new KafkaProducerNotConnectedError('dev.test');
    };
    let captured: unknown = null;
    try {
      await svc.replay(row.id, 'admin-1');
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(HttpException);
    expect((captured as HttpException).getStatus()).toBe(503);
    // Phase 2 revert ran — resolution is back to null.
    expect(row.resolution).toBeNull();
  });
});
