import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { runWithTenantContext } from '@shared/tenant';
import { JournalBatchService } from '../journal-batch.service';

/**
 * REVIEW-P2C29 BLOCKING 5 — `JournalBatchService.post` is emit-only.
 *
 * The service no longer writes `fin_gl_entries` directly; the Finance
 * `JournalBatchPostedConsumer` owns the GL materialisation through
 * `PostingService.createAndPost`. This regression suite pins both
 * sides of that contract:
 *   - successful post emits `fin.journal_batch.posted` with the lines
 *     payload the consumer needs and does NOT issue any `INSERT INTO
 *     fin_gl_entries` / `INSERT INTO fin_journal_batches` from inside
 *     `post()`.
 *   - unbalanced batches throw `BadRequestException` before any
 *     status-flip UPDATE fires and before any outbox emit.
 *
 * Split out of the previous m67-store/__tests__/commerce-review-p2c29
 * suite because R-B5 covers finance-owned code; the other R-B blocks
 * (loyalty, wishlist, promotion, price-schedule) remain in m67-store.
 */

const SCHOOL = {
  schoolId: 'school-aaaa',
  schemaName: 'tenant_demo',
  organisationId: null,
  subdomain: 'demo',
  isFrozen: false,
  planTier: 'SMALL',
  homeRegion: 'us-east-1',
} as const;

const ADMIN_ACTOR = {
  accountId: 'admin-account',
  personId: 'admin-person',
  employeeId: 'admin-emp',
  personType: 'STAFF' as const,
  isSchoolAdmin: true,
};

interface CapturedCall {
  sql: string;
  args: unknown[];
  fn: 'q' | 'e';
}

function makeFake(handler: (call: CapturedCall) => unknown) {
  const capture: CapturedCall[] = [];
  const client = {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      const call: CapturedCall = { sql, args, fn: 'q' };
      capture.push(call);
      return handler(call) ?? [];
    },
    $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
      const call: CapturedCall = { sql, args, fn: 'e' };
      capture.push(call);
      return handler(call) ?? 0;
    },
  };
  const tenantPrisma = {
    executeInTenantContext: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
    executeInTenantTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
  };
  return { capture, client, tenantPrisma };
}

function makeOutbox() {
  const enqueued: Array<{
    topic: string;
    sourceModule: string;
    key: string;
    eventId?: string;
    payload: Record<string, unknown>;
  }> = [];
  const outbox = {
    enqueueInTx: async (_tx: unknown, opts: any) => {
      enqueued.push({
        topic: opts.topic,
        sourceModule: opts.sourceModule,
        key: opts.key,
        eventId: opts.eventId,
        payload: opts.payload,
      });
    },
  };
  return { outbox, enqueued };
}

function makePermCheck(allow = true) {
  return {
    hasAnyPermissionInTenant: async () => allow,
  } as never;
}

function withTenant<T>(fn: () => T | Promise<T>): Promise<T> {
  return runWithTenantContext({ tenant: SCHOOL }, async () => fn()) as Promise<T>;
}

describe('R-B5 — REVIEW-P2C29 BLOCKING 5: post() no longer writes fin_gl_entries', () => {
  it('post() emits fin.journal_batch.posted with lines payload + does NOT insert fin_gl_entries', async () => {
    const fake = makeFake((call) => {
      // batch lock + status
      if (call.sql.includes('FROM fin_journal_entry_batches') && call.sql.includes('FOR UPDATE')) {
        return [
          {
            id: 'batch-1',
            status: 'DRAFT',
            entry_count: 2,
            total_debits: '100.00',
            total_credits: '100.00',
            is_balanced: true,
          },
        ];
      }
      // fresh re-aggregation
      if (
        call.sql.includes('COUNT(*)::int AS n') &&
        call.sql.includes('FROM fin_journal_entry_lines')
      ) {
        return [{ n: 2, d: '100', c: '100' }];
      }
      // lines read
      if (
        call.sql.includes('FROM fin_journal_entry_lines') &&
        call.sql.includes('ORDER BY line_order')
      ) {
        return [
          {
            id: 'line-1',
            account_id: 'account-cash',
            debit: '100',
            credit: '0',
            description: 'Cash',
            line_order: 0,
          },
          {
            id: 'line-2',
            account_id: 'account-revenue',
            debit: '0',
            credit: '100',
            description: 'Revenue',
            line_order: 1,
          },
        ];
      }
      // status flip UPDATE returning
      if (call.sql.includes('UPDATE fin_journal_entry_batches') && call.sql.includes('POSTED')) {
        return [
          {
            id: 'batch-1',
            school_id: SCHOOL.schoolId,
            batch_name: 'Test batch',
            description: null,
            entry_count: 2,
            total_debits: '100',
            total_credits: '100',
            is_balanced: true,
            status: 'POSTED',
            created_by: ADMIN_ACTOR.employeeId,
            posted_by: ADMIN_ACTOR.employeeId,
            posted_at: '2026-05-16',
            voided_by: null,
            voided_at: null,
            void_reason: null,
            created_at: '2026-05-16',
            updated_at: '2026-05-16',
          },
        ];
      }
      return [];
    });
    const { outbox, enqueued } = makeOutbox();
    const svc = new JournalBatchService(
      fake.tenantPrisma as never,
      makePermCheck(),
      outbox as never,
    );
    await withTenant(() => svc.post(ADMIN_ACTOR as never, 'batch-1'));

    // KEYSTONE — post() must NOT issue INSERT INTO fin_gl_entries.
    const ledgerInsert = fake.capture.find((c) => c.sql.includes('INSERT INTO fin_gl_entries'));
    expect(ledgerInsert).toBeUndefined();

    // post() must also NOT insert a companion fin_journal_batches row.
    const companionBatch = fake.capture.find((c) =>
      c.sql.includes('INSERT INTO fin_journal_batches'),
    );
    expect(companionBatch).toBeUndefined();

    // Outbox emit must fire with topic + the line shape the Finance
    // consumer needs to materialise GL entries.
    expect(enqueued).toHaveLength(1);
    const emit = enqueued[0]!;
    expect(emit.topic).toBe('fin.journal_batch.posted');
    expect(emit.sourceModule).toBe('commerce');
    expect(Array.isArray((emit.payload as { lines: unknown }).lines)).toBe(true);
    const lines = (
      emit.payload as { lines: Array<{ accountId: string; debit: number; credit: number }> }
    ).lines;
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatchObject({ accountId: 'account-cash', debit: 100, credit: 0 });
    expect(lines[1]).toMatchObject({ accountId: 'account-revenue', debit: 0, credit: 100 });
  });

  it('post() rejects unbalanced batches before any UPDATE fires', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM fin_journal_entry_batches') && call.sql.includes('FOR UPDATE')) {
        return [
          {
            id: 'batch-1',
            status: 'DRAFT',
            entry_count: 2,
            total_debits: '100.00',
            total_credits: '50.00', // unbalanced
            is_balanced: false,
          },
        ];
      }
      return [];
    });
    const { outbox, enqueued } = makeOutbox();
    const svc = new JournalBatchService(
      fake.tenantPrisma as never,
      makePermCheck(),
      outbox as never,
    );
    await expect(withTenant(() => svc.post(ADMIN_ACTOR as never, 'batch-1'))).rejects.toThrow(
      BadRequestException,
    );
    expect(enqueued).toHaveLength(0);
    const statusFlip = fake.capture.find(
      (c) => c.sql.includes('UPDATE fin_journal_entry_batches') && c.sql.includes('POSTED'),
    );
    expect(statusFlip).toBeUndefined();
  });
});
