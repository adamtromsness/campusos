import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { JournalBatchService } from '@modules/m83-finance/journal-batch.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
  TEST_SCHEMA,
} from '../helpers/tenant-context';
import {
  adminActor,
  officerActor,
  studentActor,
  parentActor,
  TEST_OFFICER_ACCOUNT_ID,
  TEST_ADMIN_EMPLOYEE_ID,
  TEST_OFFICER_EMPLOYEE_ID,
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';
import {
  TEST_COA_CASH_ID,
  TEST_COA_AR_ID,
  TEST_COA_AP_ID,
  TEST_COA_REVENUE_ID,
  TEST_COA_SUPPLIES_ID,
  TEST_COA_SUPPLIES_B_ID,
} from '../fixtures/finance';

/**
 * DB-backed integration tests for JournalBatchService — manual GL
 * adjustment batches with the POST keystone (locks, balance check,
 * outbox-in-tx emit of fin.journal_batch.posted carrying the line
 * payload for the consumer to materialise fin_gl_entries).
 *
 * Coverage areas:
 *   - create: admin-only, fresh DRAFT batch with totals=0
 *   - addLine: single-side rule, non-negative, non-zero, FOR UPDATE
 *     lock, only-DRAFT, account-in-school validation, recompute totals
 *   - removeLine: only-DRAFT, recompute, NotFound
 *   - post: rejects unbalanced, rejects empty, locks row, copies lines
 *     payload, flips to POSTED, stamps posted_by/posted_at, emits
 *     fin.journal_batch.posted with deterministic event_id
 *   - void: POSTED-only transition, stamps voided fields + reason
 *   - cross-school isolation
 *   - persona authorisation (admin / officer-with-perm / non-finance)
 */
describe('integration:m83-finance/journal-batches', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let outbox: OutboxService;
  let service: JournalBatchService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    outbox = new OutboxService(rawClient);
    service = new JournalBatchService(tenantPrisma, permCheck, outbox);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.fin_journal_entry_lines WHERE batch_id IN
         (SELECT id FROM ${TEST_SCHEMA}.fin_journal_entry_batches WHERE school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.fin_journal_entry_batches WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_outbox WHERE topic = 'fin.journal_batch.posted'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE account_id = $1::uuid`,
      TEST_OFFICER_ACCOUNT_ID,
    );
  });

  async function grantOfficer(codes: string[]): Promise<void> {
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache
         (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], now(), 'test-hash')
       ON CONFLICT (account_id, scope_id) DO UPDATE
         SET permission_codes = EXCLUDED.permission_codes, computed_at = now()`,
      generateId(),
      TEST_OFFICER_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
      codes,
    );
  }

  function baseBatch(overrides: Record<string, unknown> = {}) {
    return {
      batchName: 'Adjusting Entries Q1',
      description: 'Quarterly accruals',
      ...overrides,
    };
  }

  describe('create', () => {
    it('admin creates a DRAFT batch with zero totals', async () => {
      const b = await withTestTenant(async () => service.create(adminActor(), baseBatch()));
      expect(b.status).toBe('DRAFT');
      expect(b.totalDebits).toBe(0);
      expect(b.totalCredits).toBe(0);
      expect(b.entryCount).toBe(0);
      expect(b.isBalanced).toBe(true); // schema default true on empty
      expect(b.createdBy).toBe(TEST_ADMIN_EMPLOYEE_ID);
    });

    it('officer with fin-005:write can create', async () => {
      await grantOfficer(['fin-005:write']);
      const b = await withTestTenant(async () => service.create(officerActor(), baseBatch()));
      expect(b.createdBy).toBe(TEST_OFFICER_EMPLOYEE_ID);
    });

    it('officer without finance perm → Forbidden', async () => {
      await expect(
        withTestTenant(async () => service.create(officerActor(), baseBatch())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('student → Forbidden (persona collapse)', async () => {
      await expect(
        withTestTenant(async () => service.create(studentActor(), baseBatch())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => service.create(parentActor(), baseBatch())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('description optional', async () => {
      const input = baseBatch();
      delete (input as { description?: string }).description;
      const b = await withTestTenant(async () => service.create(adminActor(), input));
      expect(b.description).toBeNull();
    });
  });

  describe('list + getById', () => {
    it('list scoped to current school; cross-school invisible', async () => {
      const a = await withTestTenant(async () => service.create(adminActor(), baseBatch()));
      const b = await withTestTenantB(async () => service.create(adminActor(), baseBatch()));
      const listA = await withTestTenant(async () => service.list(adminActor()));
      expect(listA.find((r) => r.id === a.id)).toBeDefined();
      expect(listA.find((r) => r.id === b.id)).toBeUndefined();
    });

    it('list filters by status', async () => {
      const a = await withTestTenant(async () => service.create(adminActor(), baseBatch()));
      const drafts = await withTestTenant(async () => service.list(adminActor(), 'DRAFT'));
      expect(drafts.find((r) => r.id === a.id)).toBeDefined();
      const posted = await withTestTenant(async () => service.list(adminActor(), 'POSTED'));
      expect(posted.find((r) => r.id === a.id)).toBeUndefined();
    });

    it('getById returns batch with empty lines array', async () => {
      const b = await withTestTenant(async () => service.create(adminActor(), baseBatch()));
      const detail = await withTestTenant(async () => service.getById(adminActor(), b.id));
      expect(detail.lines).toEqual([]);
    });

    it('missing batch → NotFound', async () => {
      await expect(
        withTestTenant(async () => service.getById(adminActor(), generateId())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school getById → NotFound', async () => {
      const b = await withTestTenant(async () => service.create(adminActor(), baseBatch()));
      await expect(
        withTestTenantB(async () => service.getById(adminActor(), b.id)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('list as student → Forbidden', async () => {
      await expect(
        withTestTenant(async () => service.list(studentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('officer with fin-005:read can list', async () => {
      await grantOfficer(['fin-005:read']);
      const list = await withTestTenant(async () => service.list(officerActor()));
      expect(Array.isArray(list)).toBe(true);
    });
  });

  describe('addLine', () => {
    async function seed(): Promise<string> {
      const b = await withTestTenant(async () => service.create(adminActor(), baseBatch()));
      return b.id;
    }

    it('adds a debit line and recomputes totals', async () => {
      const id = await seed();
      await withTestTenant(async () =>
        service.addLine(adminActor(), id, {
          accountId: TEST_COA_CASH_ID,
          debit: 100,
          credit: 0,
          description: 'Cash receipt',
        }),
      );
      const detail = await withTestTenant(async () => service.getById(adminActor(), id));
      expect(detail.entryCount).toBe(1);
      expect(detail.totalDebits).toBe(100);
      expect(detail.totalCredits).toBe(0);
      expect(detail.isBalanced).toBe(false);
    });

    it('adds a credit line; balanced flag flips when totals match', async () => {
      const id = await seed();
      await withTestTenant(async () =>
        service.addLine(adminActor(), id, {
          accountId: TEST_COA_CASH_ID,
          debit: 100,
          credit: 0,
        }),
      );
      await withTestTenant(async () =>
        service.addLine(adminActor(), id, {
          accountId: TEST_COA_REVENUE_ID,
          debit: 0,
          credit: 100,
        }),
      );
      const detail = await withTestTenant(async () => service.getById(adminActor(), id));
      expect(detail.entryCount).toBe(2);
      expect(detail.isBalanced).toBe(true);
      expect(detail.totalDebits).toBe(100);
      expect(detail.totalCredits).toBe(100);
    });

    it('negative debit → BadRequest (pre-INSERT validation)', async () => {
      const id = await seed();
      await expect(
        withTestTenant(async () =>
          service.addLine(adminActor(), id, { accountId: TEST_COA_CASH_ID, debit: -10, credit: 0 }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('negative credit → BadRequest', async () => {
      const id = await seed();
      await expect(
        withTestTenant(async () =>
          service.addLine(adminActor(), id, { accountId: TEST_COA_CASH_ID, debit: 0, credit: -5 }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('debit AND credit > 0 → BadRequest (single-sided rule)', async () => {
      const id = await seed();
      await expect(
        withTestTenant(async () =>
          service.addLine(adminActor(), id, { accountId: TEST_COA_CASH_ID, debit: 50, credit: 50 }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('debit=0 AND credit=0 → BadRequest', async () => {
      const id = await seed();
      await expect(
        withTestTenant(async () =>
          service.addLine(adminActor(), id, { accountId: TEST_COA_CASH_ID, debit: 0, credit: 0 }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cross-school account → BadRequest', async () => {
      const id = await seed();
      await expect(
        withTestTenant(async () =>
          service.addLine(adminActor(), id, {
            accountId: TEST_COA_SUPPLIES_B_ID,
            debit: 50,
            credit: 0,
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('inactive account → BadRequest', async () => {
      const id = await seed();
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.fin_chart_of_accounts SET is_active = false WHERE id = $1::uuid`,
        TEST_COA_AR_ID,
      );
      try {
        await expect(
          withTestTenant(async () =>
            service.addLine(adminActor(), id, { accountId: TEST_COA_AR_ID, debit: 25, credit: 0 }),
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      } finally {
        await rawClient.$executeRawUnsafe(
          `UPDATE ${TEST_SCHEMA}.fin_chart_of_accounts SET is_active = true WHERE id = $1::uuid`,
          TEST_COA_AR_ID,
        );
      }
    });

    it('adding to a POSTED batch → BadRequest', async () => {
      const id = await seed();
      // Balance + post
      await withTestTenant(async () =>
        service.addLine(adminActor(), id, { accountId: TEST_COA_CASH_ID, debit: 100, credit: 0 }),
      );
      await withTestTenant(async () =>
        service.addLine(adminActor(), id, { accountId: TEST_COA_REVENUE_ID, debit: 0, credit: 100 }),
      );
      await withTestTenant(async () => service.post(adminActor(), id));
      await expect(
        withTestTenant(async () =>
          service.addLine(adminActor(), id, { accountId: TEST_COA_CASH_ID, debit: 10, credit: 0 }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('missing batch → NotFound', async () => {
      await expect(
        withTestTenant(async () =>
          service.addLine(adminActor(), generateId(), {
            accountId: TEST_COA_CASH_ID,
            debit: 10,
            credit: 0,
          }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-admin → Forbidden', async () => {
      const id = await seed();
      await expect(
        withTestTenant(async () =>
          service.addLine(officerActor(), id, { accountId: TEST_COA_CASH_ID, debit: 10, credit: 0 }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('cross-school addLine → NotFound (batch in other school)', async () => {
      const id = await seed();
      await expect(
        withTestTenantB(async () =>
          service.addLine(adminActor(), id, { accountId: TEST_COA_CASH_ID, debit: 10, credit: 0 }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('line_order defaults to 0 when omitted', async () => {
      const id = await seed();
      await withTestTenant(async () =>
        service.addLine(adminActor(), id, { accountId: TEST_COA_CASH_ID, debit: 1, credit: 0 }),
      );
      const detail = await withTestTenant(async () => service.getById(adminActor(), id));
      expect(detail.lines[0]!.lineOrder).toBe(0);
    });
  });

  describe('removeLine', () => {
    async function seedWithLines(): Promise<{ batchId: string; lineId: string }> {
      const b = await withTestTenant(async () => service.create(adminActor(), baseBatch()));
      const line = await withTestTenant(async () =>
        service.addLine(adminActor(), b.id, {
          accountId: TEST_COA_CASH_ID,
          debit: 100,
          credit: 0,
        }),
      );
      return { batchId: b.id, lineId: line.id };
    }

    it('removes a line and recomputes totals', async () => {
      const { batchId, lineId } = await seedWithLines();
      await withTestTenant(async () => service.removeLine(adminActor(), batchId, lineId));
      // Re-read after the removal returns — getById opens a fresh tx so it
      // sees the recompute committed.
      const detail = await withTestTenant(async () => service.getById(adminActor(), batchId));
      expect(detail.entryCount).toBe(0);
      expect(detail.totalDebits).toBe(0);
      expect(detail.lines).toEqual([]);
    });

    it('cannot remove from POSTED batch → BadRequest', async () => {
      const { batchId, lineId } = await seedWithLines();
      // balance + post
      await withTestTenant(async () =>
        service.addLine(adminActor(), batchId, {
          accountId: TEST_COA_REVENUE_ID,
          debit: 0,
          credit: 100,
        }),
      );
      await withTestTenant(async () => service.post(adminActor(), batchId));
      await expect(
        withTestTenant(async () => service.removeLine(adminActor(), batchId, lineId)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('non-existent line → NotFound', async () => {
      const { batchId } = await seedWithLines();
      await expect(
        withTestTenant(async () => service.removeLine(adminActor(), batchId, generateId())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('missing batch → NotFound', async () => {
      const { lineId } = await seedWithLines();
      await expect(
        withTestTenant(async () => service.removeLine(adminActor(), generateId(), lineId)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-admin → Forbidden', async () => {
      const { batchId, lineId } = await seedWithLines();
      await expect(
        withTestTenant(async () => service.removeLine(officerActor(), batchId, lineId)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('post — KEYSTONE: balance check + outbox emit', () => {
    async function seedBalanced(): Promise<string> {
      const b = await withTestTenant(async () => service.create(adminActor(), baseBatch()));
      await withTestTenant(async () =>
        service.addLine(adminActor(), b.id, {
          accountId: TEST_COA_CASH_ID,
          debit: 100,
          credit: 0,
        }),
      );
      await withTestTenant(async () =>
        service.addLine(adminActor(), b.id, {
          accountId: TEST_COA_REVENUE_ID,
          debit: 0,
          credit: 100,
        }),
      );
      return b.id;
    }

    it('balanced batch posts; flips status + stamps posted_by/posted_at + emits outbox', async () => {
      const id = await seedBalanced();
      const posted = await withTestTenant(async () => service.post(adminActor(), id));
      expect(posted.status).toBe('POSTED');
      expect(posted.postedBy).toBe(TEST_ADMIN_EMPLOYEE_ID);
      expect(posted.postedAt).toBeTruthy();

      // Outbox row
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT topic, message_key, envelope::text AS envelope FROM platform.platform_outbox
          WHERE topic = 'fin.journal_batch.posted' AND message_key = $1`,
        id,
      )) as Array<{ topic: string; message_key: string; envelope: string }>;
      expect(rows.length).toBe(1);
      const env = JSON.parse(rows[0]!.envelope);
      const payload = env.payload ?? env;
      expect(payload.batchId).toBe(id);
      expect(payload.totalDebits).toBe(100);
      expect(payload.totalCredits).toBe(100);
      expect(payload.entryCount).toBe(2);
      expect(payload.lines).toHaveLength(2);
      const cashLine = payload.lines.find((l: { accountId: string }) => l.accountId === TEST_COA_CASH_ID);
      expect(cashLine.debit).toBe(100);
      expect(cashLine.credit).toBe(0);
    });

    it('empty batch → BadRequest (cannot post)', async () => {
      const b = await withTestTenant(async () => service.create(adminActor(), baseBatch()));
      await expect(
        withTestTenant(async () => service.post(adminActor(), b.id)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('unbalanced batch (debits != credits) → BadRequest', async () => {
      const b = await withTestTenant(async () => service.create(adminActor(), baseBatch()));
      await withTestTenant(async () =>
        service.addLine(adminActor(), b.id, {
          accountId: TEST_COA_CASH_ID,
          debit: 100,
          credit: 0,
        }),
      );
      await withTestTenant(async () =>
        service.addLine(adminActor(), b.id, {
          accountId: TEST_COA_REVENUE_ID,
          debit: 0,
          credit: 50, // mismatch
        }),
      );
      await expect(
        withTestTenant(async () => service.post(adminActor(), b.id)),
      ).rejects.toBeInstanceOf(BadRequestException);

      // No outbox row written
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM platform.platform_outbox WHERE topic = 'fin.journal_batch.posted'`,
      )) as Array<{ n: number }>;
      expect(rows[0]!.n).toBe(0);
    });

    it('already POSTED batch → BadRequest', async () => {
      const id = await seedBalanced();
      await withTestTenant(async () => service.post(adminActor(), id));
      await expect(
        withTestTenant(async () => service.post(adminActor(), id)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('missing batch → NotFound', async () => {
      await expect(
        withTestTenant(async () => service.post(adminActor(), generateId())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school post → NotFound', async () => {
      const id = await seedBalanced();
      await expect(
        withTestTenantB(async () => service.post(adminActor(), id)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-admin → Forbidden', async () => {
      const id = await seedBalanced();
      await expect(
        withTestTenant(async () => service.post(officerActor(), id)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('multi-line balanced batch (3 debits + 1 credit summing to same)', async () => {
      const b = await withTestTenant(async () => service.create(adminActor(), baseBatch()));
      await withTestTenant(async () =>
        service.addLine(adminActor(), b.id, {
          accountId: TEST_COA_CASH_ID,
          debit: 30,
          credit: 0,
        }),
      );
      await withTestTenant(async () =>
        service.addLine(adminActor(), b.id, {
          accountId: TEST_COA_AR_ID,
          debit: 40,
          credit: 0,
        }),
      );
      await withTestTenant(async () =>
        service.addLine(adminActor(), b.id, {
          accountId: TEST_COA_SUPPLIES_ID,
          debit: 30,
          credit: 0,
        }),
      );
      await withTestTenant(async () =>
        service.addLine(adminActor(), b.id, {
          accountId: TEST_COA_AP_ID,
          debit: 0,
          credit: 100,
        }),
      );
      const posted = await withTestTenant(async () => service.post(adminActor(), b.id));
      expect(posted.status).toBe('POSTED');
      expect(posted.totalDebits).toBe(100);
      expect(posted.totalCredits).toBe(100);
      expect(posted.entryCount).toBe(4);
    });
  });

  describe('void', () => {
    async function seedPosted(): Promise<string> {
      const b = await withTestTenant(async () => service.create(adminActor(), baseBatch()));
      await withTestTenant(async () =>
        service.addLine(adminActor(), b.id, {
          accountId: TEST_COA_CASH_ID,
          debit: 100,
          credit: 0,
        }),
      );
      await withTestTenant(async () =>
        service.addLine(adminActor(), b.id, {
          accountId: TEST_COA_REVENUE_ID,
          debit: 0,
          credit: 100,
        }),
      );
      await withTestTenant(async () => service.post(adminActor(), b.id));
      return b.id;
    }

    it('voids a POSTED batch + stamps reason + voided_by/voided_at', async () => {
      const id = await seedPosted();
      const voided = await withTestTenant(async () =>
        service.void(adminActor(), id, { voidReason: 'Posted in error' }),
      );
      expect(voided.status).toBe('VOIDED');
      expect(voided.voidReason).toBe('Posted in error');
      expect(voided.voidedBy).toBe(TEST_ADMIN_EMPLOYEE_ID);
      expect(voided.voidedAt).toBeTruthy();
    });

    it('voiding a DRAFT batch → BadRequest', async () => {
      const b = await withTestTenant(async () => service.create(adminActor(), baseBatch()));
      await expect(
        withTestTenant(async () => service.void(adminActor(), b.id, { voidReason: 'x' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('voiding an already-VOIDED batch → BadRequest', async () => {
      const id = await seedPosted();
      await withTestTenant(async () => service.void(adminActor(), id, { voidReason: 'first' }));
      await expect(
        withTestTenant(async () => service.void(adminActor(), id, { voidReason: 'second' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('voiding a missing batch → NotFound', async () => {
      await expect(
        withTestTenant(async () => service.void(adminActor(), generateId(), { voidReason: 'x' })),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school void → NotFound', async () => {
      const id = await seedPosted();
      await expect(
        withTestTenantB(async () => service.void(adminActor(), id, { voidReason: 'x' })),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-admin → Forbidden', async () => {
      const id = await seedPosted();
      await expect(
        withTestTenant(async () => service.void(officerActor(), id, { voidReason: 'x' })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('cross-school isolation', () => {
    it('batch created in School B not visible from School A list', async () => {
      const b = await withTestTenantB(async () => service.create(adminActor(), baseBatch()));
      const listA = await withTestTenant(async () => service.list(adminActor()));
      expect(listA.find((r) => r.id === b.id)).toBeUndefined();
    });
  });
});
