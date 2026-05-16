import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { runWithTenantContext } from '../../tenant/tenant.context';
import { PromotionService } from '../promotion.service';
import { LoyaltyService } from '../loyalty.service';
import { WishlistService } from '../wishlist.service';
import { PriceScheduleService } from '../price-schedule.service';
import { JournalBatchService } from '../journal-batch.service';

/**
 * REVIEW-P2C29 ROUND 1 — regression tests pinning the 5 BLOCKING +
 * 2 actionable MAJOR fixes so future maintenance cannot regress them.
 *
 *   R-B1  Loyalty customerPersonId affiliation
 *   R-B2  Wishlist update/remove school-scope through product → store
 *   R-B3  Promotion patch UPDATE joins through str_stores.school_id
 *   R-B4  PriceScheduleWorker apply/revert UPDATEs carry school predicate
 *   R-B5  JournalBatchService.post no longer writes fin_gl_entries
 *         directly; finance JournalBatchPostedConsumer owns the GL
 *         materialisation via PostingService.createAndPost
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

const STUDENT_ACTOR = {
  accountId: 'student-account',
  personId: 'maya-person',
  employeeId: null,
  personType: 'STUDENT' as const,
  isSchoolAdmin: false,
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
    // PriceScheduleWorker enters per-tenant via executeInExplicitSchema —
    // the fake routes the worker path through the same captured client
    // so the SQL shape assertions still see every UPDATE.
    executeInExplicitSchema: async (_schema: string, fn: (c: unknown) => Promise<unknown>) =>
      fn(client),
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

// ─────────────────────────────────────────────────────────────
// R-B1 — Loyalty customerPersonId affiliation
// ─────────────────────────────────────────────────────────────

describe('R-B1 — REVIEW-P2C29 BLOCKING 1: loyalty customer affiliation', () => {
  it('earn() throws BadRequestException when customerPersonId is not affiliated with current school', async () => {
    const fake = makeFake((call) => {
      // assertCustomerAffiliatedWithSchool — return empty so the
      // affiliation gate fires.
      if (call.sql.includes('FROM sis_students s') && call.sql.includes('FROM hr_employees e')) {
        return [];
      }
      // store ownership check (would only fire if affiliation passed)
      if (call.sql.includes('FROM str_stores WHERE id')) {
        return [{ ok: 1 }];
      }
      return [];
    });
    const svc = new LoyaltyService(fake.tenantPrisma as never, makePermCheck());
    await expect(
      withTenant(() =>
        svc.earn(ADMIN_ACTOR as never, {
          storeId: 'store-1',
          customerPersonId: 'foreign-person-uuid',
          points: 100,
        }),
      ),
    ).rejects.toThrow(BadRequestException);

    const affiliationCall = fake.capture.find(
      (c) => c.sql.includes('FROM sis_students s') && c.sql.includes('FROM hr_employees e'),
    );
    expect(affiliationCall).toBeDefined();
    // The helper binds (personId, schoolId)
    expect(affiliationCall!.args[0]).toBe('foreign-person-uuid');
    expect(affiliationCall!.args[1]).toBe(SCHOOL.schoolId);

    // The mutation INSERT must NOT have fired since the affiliation
    // gate threw BEFORE the insert path.
    const insertCall = fake.capture.find((c) =>
      c.sql.includes('INSERT INTO str_loyalty_transactions'),
    );
    expect(insertCall).toBeUndefined();
  });

  it('redeem() requires customer affiliation even when actor is the customer themself', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM sis_students s') && call.sql.includes('FROM hr_employees e')) {
        return [];
      }
      return [];
    });
    const svc = new LoyaltyService(fake.tenantPrisma as never, makePermCheck());
    await expect(
      withTenant(() =>
        svc.redeem(STUDENT_ACTOR as never, {
          storeId: 'store-1',
          customerPersonId: STUDENT_ACTOR.personId,
          points: 100,
        }),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('balance() applies affiliation check before scanning ledger', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM sis_students s') && call.sql.includes('FROM hr_employees e')) {
        return [];
      }
      return [];
    });
    const svc = new LoyaltyService(fake.tenantPrisma as never, makePermCheck());
    await expect(
      withTenant(() => svc.getBalance(ADMIN_ACTOR as never, 'store-1', 'foreign-person-uuid')),
    ).rejects.toThrow(BadRequestException);
    const ledgerScan = fake.capture.find((c) => c.sql.includes('FROM str_loyalty_transactions'));
    expect(ledgerScan).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────
// R-B2 — Wishlist update/remove school-scope
// ─────────────────────────────────────────────────────────────

describe('R-B2 — REVIEW-P2C29 BLOCKING 2: wishlist update/remove join through store', () => {
  it('update() UPDATE statement joins str_products + str_stores with school predicate', async () => {
    const fake = makeFake(() => [
      {
        id: 'wishlist-1',
        customer_person_id: ADMIN_ACTOR.personId,
        product_id: 'product-1',
        notify_on_restock: false,
        created_at: '2026-05-16',
      },
    ]);
    const svc = new WishlistService(fake.tenantPrisma as never, makePermCheck());
    await withTenant(() =>
      svc.update(ADMIN_ACTOR as never, ADMIN_ACTOR.personId, 'product-1', {
        notifyOnRestock: false,
      }),
    );
    const updateCall = fake.capture.find((c) => c.sql.includes('UPDATE str_wishlists'));
    expect(updateCall).toBeDefined();
    // Mutation joins through str_products + str_stores with
    // s.school_id predicate — Round 1 BLOCKING 2 keystone.
    expect(updateCall!.sql).toContain('FROM str_products');
    expect(updateCall!.sql).toMatch(/JOIN str_stores s\s+ON s\.id = p\.store_id/);
    expect(updateCall!.sql).toContain('s.school_id = $2::uuid');
    expect(updateCall!.args[1]).toBe(SCHOOL.schoolId);
  });

  it('remove() DELETE statement joins str_products + str_stores with school predicate', async () => {
    const fake = makeFake(() => 1);
    const svc = new WishlistService(fake.tenantPrisma as never, makePermCheck());
    await withTenant(() => svc.remove(ADMIN_ACTOR as never, ADMIN_ACTOR.personId, 'product-1'));
    const deleteCall = fake.capture.find(
      (c) => c.fn === 'e' && c.sql.includes('DELETE FROM str_wishlists'),
    );
    expect(deleteCall).toBeDefined();
    expect(deleteCall!.sql).toContain('USING str_products');
    expect(deleteCall!.sql).toMatch(/JOIN str_stores s\s+ON s\.id = p\.store_id/);
    expect(deleteCall!.sql).toContain('s.school_id = $1::uuid');
    expect(deleteCall!.args[0]).toBe(SCHOOL.schoolId);
  });
});

// ─────────────────────────────────────────────────────────────
// R-B3 — Promotion patch UPDATE through store join
// ─────────────────────────────────────────────────────────────

describe('R-B3 — REVIEW-P2C29 BLOCKING 3: promotion patch joins through str_stores', () => {
  it('patch() UPDATE statement carries school predicate via FROM str_stores', async () => {
    const fake = makeFake((call) => {
      // pre-lock SELECT
      if (
        call.sql.includes('FROM str_promotions p') &&
        call.sql.includes('JOIN str_stores s') &&
        call.sql.includes('FOR UPDATE OF p')
      ) {
        return [
          {
            id: 'promo-1',
            discount_type: 'PERCENTAGE',
            starts_at: '2026-01-01T00:00:00Z',
            ends_at: '2026-12-31T00:00:00Z',
          },
        ];
      }
      // UPDATE returning
      if (call.sql.includes('UPDATE str_promotions p')) {
        return [
          {
            id: 'promo-1',
            store_id: 'store-1',
            name: 'Updated',
            description: null,
            discount_type: 'PERCENTAGE',
            discount_value: '10',
            min_order_amount: null,
            promo_code: 'BACK2SCHOOL',
            starts_at: '2026-01-01',
            ends_at: '2026-12-31',
            max_uses: null,
            current_uses: 0,
            is_active: true,
            created_by: ADMIN_ACTOR.employeeId,
            created_at: '2026-01-01',
            updated_at: '2026-05-16',
          },
        ];
      }
      return [];
    });
    const { outbox } = makeOutbox();
    const svc = new PromotionService(fake.tenantPrisma as never, makePermCheck(), outbox as never);
    await withTenant(() => svc.patch(ADMIN_ACTOR as never, 'promo-1', { name: 'Updated' }));
    const updateCall = fake.capture.find(
      (c) => c.sql.includes('UPDATE str_promotions p') && c.sql.includes('SET'),
    );
    expect(updateCall).toBeDefined();
    // The UPDATE must join through str_stores and carry s.school_id
    // — Round 1 BLOCKING 3 keystone. Phase 2 style guide requires
    // every tenant mutation to thread the school predicate through
    // the statement itself, not just a pre-lock SELECT.
    expect(updateCall!.sql).toContain('FROM str_stores s');
    expect(updateCall!.sql).toContain('s.id = p.store_id');
    expect(updateCall!.sql).toMatch(/s\.school_id = \$\d+::uuid/);
    // The args list ends with [id, schoolId]
    const lastArg = updateCall!.args[updateCall!.args.length - 1];
    expect(lastArg).toBe(SCHOOL.schoolId);
  });
});

// ─────────────────────────────────────────────────────────────
// R-B4 — PriceScheduleWorker apply/revert carry school predicate
// ─────────────────────────────────────────────────────────────

describe('R-B4 — REVIEW-P2C29 BLOCKING 4: price schedule worker UPDATEs join through stores', () => {
  it('tickForSchool apply path UPDATEs both str_products and str_price_schedules with school predicate', async () => {
    const fake = makeFake((call) => {
      // ripe schedule
      if (
        call.sql.includes('FROM str_price_schedules ps') &&
        call.sql.includes('ps.applied_at IS NULL') &&
        call.sql.includes('ps.effective_from <= now()')
      ) {
        return [
          {
            id: 'sched-1',
            product_id: 'product-1',
            scheduled_price: '19.99',
            effective_from: '2026-01-01T00:00:00Z',
            effective_to: null,
          },
        ];
      }
      // revert path returns empty so we only test apply UPDATEs
      return [];
    });
    const { outbox } = makeOutbox();
    const svc = new PriceScheduleService(
      fake.tenantPrisma as never,
      makePermCheck(),
      outbox as never,
    );
    await svc.tickForSchool('tenant_demo', SCHOOL.schoolId, 'demo');

    // The product price UPDATE must join str_stores via FROM
    const productUpdate = fake.capture.find(
      (c) => c.fn === 'e' && c.sql.includes('UPDATE str_products p'),
    );
    expect(productUpdate).toBeDefined();
    expect(productUpdate!.sql).toContain('FROM str_stores s');
    expect(productUpdate!.sql).toMatch(/s\.school_id = \$2::uuid/);
    expect(productUpdate!.args[1]).toBe(SCHOOL.schoolId);

    // The schedule stamp UPDATE must also join through str_products + str_stores
    const scheduleStamp = fake.capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.includes('UPDATE str_price_schedules ps') &&
        c.sql.includes('applied_at'),
    );
    expect(scheduleStamp).toBeDefined();
    expect(scheduleStamp!.sql).toContain('FROM str_products');
    expect(scheduleStamp!.sql).toContain('JOIN str_stores s');
    expect(scheduleStamp!.sql).toMatch(/s\.school_id = \$1::uuid/);
    expect(scheduleStamp!.args[0]).toBe(SCHOOL.schoolId);
  });

  it('tickForSchool revert path UPDATE joins through str_products + str_stores with school predicate', async () => {
    const fake = makeFake((call) => {
      // apply path returns empty
      if (
        call.sql.includes('FROM str_price_schedules ps') &&
        call.sql.includes('ps.applied_at IS NULL')
      ) {
        return [];
      }
      // revertable rows
      if (
        call.sql.includes('FROM str_price_schedules ps') &&
        call.sql.includes('ps.applied_at IS NOT NULL') &&
        call.sql.includes('ps.reverted_at IS NULL')
      ) {
        return [
          {
            id: 'sched-revert',
            product_id: 'product-1',
            effective_to: '2026-05-01T00:00:00Z',
          },
        ];
      }
      return [];
    });
    const { outbox } = makeOutbox();
    const svc = new PriceScheduleService(
      fake.tenantPrisma as never,
      makePermCheck(),
      outbox as never,
    );
    await svc.tickForSchool('tenant_demo', SCHOOL.schoolId, 'demo');

    const revertStamp = fake.capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.includes('UPDATE str_price_schedules ps') &&
        c.sql.includes('reverted_at'),
    );
    expect(revertStamp).toBeDefined();
    expect(revertStamp!.sql).toContain('FROM str_products');
    expect(revertStamp!.sql).toContain('JOIN str_stores s');
    expect(revertStamp!.sql).toMatch(/s\.school_id = \$1::uuid/);
    expect(revertStamp!.args[0]).toBe(SCHOOL.schoolId);
  });
});

// ─────────────────────────────────────────────────────────────
// R-B5 — JournalBatchService.post emits-only, no direct GL write
// ─────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────
// Sanity — affiliation helper is exported and signature matches
// ─────────────────────────────────────────────────────────────

describe('access.ts affiliation helper export', () => {
  it('assertCustomerAffiliatedWithSchool is exported from commerce/access', async () => {
    const access = await import('../access');
    expect(typeof access.assertCustomerAffiliatedWithSchool).toBe('function');
  });
});

// Suppress unused-import warnings for ConflictException + NotFoundException
// — kept available for future regression assertions.
void ConflictException;
void NotFoundException;
