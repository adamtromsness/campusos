import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { PostingService } from '@modules/m83-finance/posting.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHOOL_ID,
} from '../helpers/tenant-context';
import {
  adminActor,
  officerActor,
  teacherActor,
  studentActor,
  parentActor,
  TEST_ADMIN_EMPLOYEE_ID,
} from '../helpers/actor';
import { resetFinanceTables } from '../helpers/reset';
import {
  TEST_FUND_ID,
  TEST_COA_CASH_ID,
  TEST_COA_AR_ID,
  TEST_COA_REVENUE_ID,
  TEST_PERIOD_ID,
  TEST_COA_SUPPLIES_ID,
} from '../fixtures/finance';
import type { CreateJournalBatchDto } from '@modules/m83-finance/dto/finance.dto';

/**
 * Wave 1 — DB-backed integration tests for the m83-finance posting
 * surface (PostingService) + the IMMUTABLE trigger contract on
 * fin_gl_entries (migration 177).
 *
 * Replaces apps/api/src/modules/m83-finance/posting.service.spec.ts.
 *
 * Key contracts under test:
 *   - Balanced double-entry: SUM(debit) = SUM(credit) per batch (ADR-058/059)
 *   - Period gating: posts to CLOSED/LOCKED periods are rejected
 *   - Auth: STAFF or admin to post; admin to void; employee actor required
 *   - Cross-school: every read/write is scoped by tenant.schoolId
 *   - Idempotency: source_event_id deduplicates createAndPost emits
 *   - Budget actuals: a POSTED batch bumps fin_budget_lines.actual_amount;
 *     a VOIDED batch reverses it (floor 0)
 *   - IMMUTABLE: fin_gl_entries rows cannot be UPDATEd or DELETEd
 *     post-insert — DB-level trigger raises SQLSTATE 23001
 */
describe('integration:m83-finance/gl-posting', () => {
  let tenantPrisma: TenantPrismaService;
  let posting: PostingService;
  let rawClient: PrismaClient;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    posting = new PostingService(tenantPrisma);
    rawClient = new PrismaClient();
    await rawClient.$connect();
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await withTestTenant(async () => {
      await resetFinanceTables(tenantPrisma);
    });
  });

  // Convenience: a balanced 2-line DR Cash / CR Revenue batch input
  function balancedInput(overrides?: Partial<CreateJournalBatchDto>): CreateJournalBatchDto {
    return {
      batchNumber: 'JB-TEST-' + generateId().slice(0, 8),
      description: 'Test posting',
      batchType: 'MANUAL',
      accountingPeriodId: TEST_PERIOD_ID,
      entries: [
        { accountId: TEST_COA_CASH_ID, fundId: TEST_FUND_ID, debit: 100, credit: 0 },
        { accountId: TEST_COA_REVENUE_ID, fundId: TEST_FUND_ID, debit: 0, credit: 100 },
      ],
      ...overrides,
    };
  }

  // ────────────────────────────────────────────────────────────────────
  // createDraft
  // ────────────────────────────────────────────────────────────────────
  describe('createDraft', () => {
    it('happy path: creates DRAFT batch with entries; totals computed', async () => {
      const draft = await withTestTenant(async () =>
        posting.createDraft(adminActor(), balancedInput()),
      );
      expect(draft.status).toBe('DRAFT');
      expect(draft.postedAt).toBeNull();
      expect(draft.postedBy).toBeNull();
      expect(draft.totalDebit).toBe(100);
      expect(draft.totalCredit).toBe(100);
      expect(draft.entries).toHaveLength(2);

      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT status FROM tenant_test.fin_journal_batches WHERE id = $1::uuid`,
        draft.id,
      )) as Array<{ status: string }>;
      expect(rows[0]!.status).toBe('DRAFT');
    });

    it('createDraft persists each entry to fin_gl_entries in line_order', async () => {
      const draft = await withTestTenant(async () =>
        posting.createDraft(adminActor(), balancedInput()),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT account_id::text AS account_id, debit, credit, line_order FROM tenant_test.fin_gl_entries WHERE batch_id = $1::uuid ORDER BY line_order`,
        draft.id,
      )) as Array<{ account_id: string; debit: string; credit: string; line_order: number }>;
      expect(rows).toHaveLength(2);
      expect(rows[0]!.account_id).toBe(TEST_COA_CASH_ID);
      expect(Number(rows[0]!.debit)).toBe(100);
      expect(Number(rows[0]!.line_order)).toBe(0);
      expect(rows[1]!.account_id).toBe(TEST_COA_REVENUE_ID);
      expect(Number(rows[1]!.credit)).toBe(100);
      expect(Number(rows[1]!.line_order)).toBe(1);
    });

    it.each([
      ['student', studentActor],
      ['parent', parentActor],
    ])('non-STAFF non-admin %s → ForbiddenException', async (_label, actor) => {
      await expect(
        withTestTenant(async () => posting.createDraft(actor(), balancedInput())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('non-admin STAFF (officer) is allowed (defence-in-depth gate)', async () => {
      const draft = await withTestTenant(async () =>
        posting.createDraft(officerActor(), balancedInput()),
      );
      expect(draft.status).toBe('DRAFT');
    });

    it('non-admin STAFF (teacher) is allowed (the controller @RequirePermission catches finance gate)', async () => {
      const draft = await withTestTenant(async () =>
        posting.createDraft(teacherActor(), balancedInput()),
      );
      expect(draft.status).toBe('DRAFT');
    });

    it('rejects entries with both debit AND credit set', async () => {
      await expect(
        withTestTenant(async () =>
          posting.createDraft(
            adminActor(),
            balancedInput({
              entries: [
                { accountId: TEST_COA_CASH_ID, fundId: TEST_FUND_ID, debit: 100, credit: 100 },
              ],
            }),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects entries with zero on BOTH sides', async () => {
      await expect(
        withTestTenant(async () =>
          posting.createDraft(
            adminActor(),
            balancedInput({
              entries: [{ accountId: TEST_COA_CASH_ID, fundId: TEST_FUND_ID, debit: 0, credit: 0 }],
            }),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an empty entry list', async () => {
      await expect(
        withTestTenant(async () => posting.createDraft(adminActor(), balancedInput({ entries: [] }))),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects unbalanced entries (debit ≠ credit)', async () => {
      await expect(
        withTestTenant(async () =>
          posting.createDraft(
            adminActor(),
            balancedInput({
              entries: [
                { accountId: TEST_COA_CASH_ID, fundId: TEST_FUND_ID, debit: 100, credit: 0 },
                { accountId: TEST_COA_REVENUE_ID, fundId: TEST_FUND_ID, debit: 0, credit: 50 },
              ],
            }),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects negative debit or credit', async () => {
      await expect(
        withTestTenant(async () =>
          posting.createDraft(
            adminActor(),
            balancedInput({
              entries: [
                { accountId: TEST_COA_CASH_ID, fundId: TEST_FUND_ID, debit: -10, credit: 0 },
              ],
            }),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects duplicate batch_number for the same school (ConflictException)', async () => {
      const first = balancedInput({ batchNumber: 'JB-UNIQUE-001' });
      await withTestTenant(async () => posting.createDraft(adminActor(), first));
      await expect(
        withTestTenant(async () =>
          posting.createDraft(adminActor(), balancedInput({ batchNumber: 'JB-UNIQUE-001' })),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // post
  // ────────────────────────────────────────────────────────────────────
  describe('post', () => {
    it('happy path: flips DRAFT to POSTED, stamps posted_at + posted_by', async () => {
      const draft = await withTestTenant(async () =>
        posting.createDraft(adminActor(), balancedInput()),
      );
      await withTestTenant(async () => posting.post(adminActor(), draft.id));

      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT status, posted_at IS NOT NULL AS posted_at_set, posted_by::text AS posted_by
           FROM tenant_test.fin_journal_batches WHERE id = $1::uuid`,
        draft.id,
      )) as Array<{ status: string; posted_at_set: boolean; posted_by: string }>;
      expect(rows[0]!.status).toBe('POSTED');
      expect(rows[0]!.posted_at_set).toBe(true);
      expect(rows[0]!.posted_by).toBe(TEST_ADMIN_EMPLOYEE_ID);
    });

    it('post bumps fin_budget_lines.actual_amount for matching expense accounts', async () => {
      // The fixture budget line points at Office Supplies (5000). Post a
      // DR Supplies 250 / CR Cash 250 batch.
      const draft = await withTestTenant(async () =>
        posting.createDraft(
          adminActor(),
          balancedInput({
            entries: [
              { accountId: TEST_COA_SUPPLIES_ID, fundId: TEST_FUND_ID, debit: 250, credit: 0 },
              { accountId: TEST_COA_CASH_ID, fundId: TEST_FUND_ID, debit: 0, credit: 250 },
            ],
          }),
        ),
      );
      await withTestTenant(async () => posting.post(adminActor(), draft.id));

      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT actual_amount FROM tenant_test.fin_budget_lines WHERE account_id = $1::uuid AND budget_id IN (SELECT id FROM tenant_test.fin_budgets WHERE school_id = $2::uuid)`,
        TEST_COA_SUPPLIES_ID,
        TEST_SCHOOL_ID,
      )) as Array<{ actual_amount: string }>;
      expect(Number(rows[0]!.actual_amount)).toBe(250);
    });

    it('rejects re-posting an already POSTED batch', async () => {
      const draft = await withTestTenant(async () =>
        posting.createDraft(adminActor(), balancedInput()),
      );
      await withTestTenant(async () => posting.post(adminActor(), draft.id));
      await expect(
        withTestTenant(async () => posting.post(adminActor(), draft.id)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects posting a non-existent batch (NotFoundException)', async () => {
      await expect(
        withTestTenant(async () =>
          posting.post(adminActor(), '00000000-0000-0000-0000-000000000000'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school: cannot post a batch owned by School B as a School A actor', async () => {
      // Seed a DRAFT batch as School B
      const draftB = await withTestTenantB(async () =>
        posting.createDraft(
          adminActor(),
          balancedInput({ batchNumber: 'JB-SCHOOL-B', accountingPeriodId: TEST_PERIOD_ID }),
        ),
      );
      // Note: balancedInput uses School A's TEST_PERIOD_ID. Validation
      // here would fail in real usage because the period belongs to
      // School A; for the cross-school post test the relevant assertion
      // is that a School A actor sees NotFoundException, not the period
      // resolution. So we use a batch we just confirmed exists in DB
      // (under school B's school_id even though it joins School A's
      // period — the FK does not cross-check school_id).
      await expect(
        withTestTenant(async () => posting.post(adminActor(), draftB.id)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects posting to a CLOSED period', async () => {
      const draft = await withTestTenant(async () =>
        posting.createDraft(adminActor(), balancedInput()),
      );
      // Manually close the period
      await rawClient.$executeRawUnsafe(
        `UPDATE tenant_test.fin_accounting_periods SET status='CLOSED', closed_at=now(), closed_by=$1::uuid WHERE id=$2::uuid`,
        TEST_ADMIN_EMPLOYEE_ID,
        TEST_PERIOD_ID,
      );
      await expect(
        withTestTenant(async () => posting.post(adminActor(), draft.id)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects posting to a LOCKED period', async () => {
      const draft = await withTestTenant(async () =>
        posting.createDraft(adminActor(), balancedInput()),
      );
      await rawClient.$executeRawUnsafe(
        `UPDATE tenant_test.fin_accounting_periods SET status='LOCKED', closed_at=now(), locked_at=now(), closed_by=$1::uuid, locked_by=$1::uuid WHERE id=$2::uuid`,
        TEST_ADMIN_EMPLOYEE_ID,
        TEST_PERIOD_ID,
      );
      await expect(
        withTestTenant(async () => posting.post(adminActor(), draft.id)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects posting an UNBALANCED batch that bypassed pre-flight (manual SQL injection)', async () => {
      // The createDraft pre-flight catches unbalanced lines at the
      // service layer. Simulate an underlying tx race by injecting an
      // unbalanced batch directly via SQL, then call post().
      const batchId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO tenant_test.fin_journal_batches (id, school_id, batch_number, description, batch_type, accounting_period_id, status) VALUES ($1::uuid, $2::uuid, $3, 'imbalanced', 'MANUAL', $4::uuid, 'DRAFT')`,
        batchId,
        TEST_SCHOOL_ID,
        'JB-IMBAL-' + batchId.slice(0, 8),
        TEST_PERIOD_ID,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO tenant_test.fin_gl_entries (id, batch_id, account_id, fund_id, debit, credit, line_order) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 100, 0, 0), ($5::uuid, $2::uuid, $6::uuid, $4::uuid, 0, 50, 1)`,
        generateId(),
        batchId,
        TEST_COA_CASH_ID,
        TEST_FUND_ID,
        generateId(),
        TEST_COA_REVENUE_ID,
      );
      await expect(
        withTestTenant(async () => posting.post(adminActor(), batchId)),
      ).rejects.toBeInstanceOf(BadRequestException);

      // Verify the batch is still DRAFT (the post tx rolled back)
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT status FROM tenant_test.fin_journal_batches WHERE id = $1::uuid`,
        batchId,
      )) as Array<{ status: string }>;
      expect(rows[0]!.status).toBe('DRAFT');
    });

    it('rejects posting a batch with no entries', async () => {
      const batchId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO tenant_test.fin_journal_batches (id, school_id, batch_number, description, batch_type, accounting_period_id, status) VALUES ($1::uuid, $2::uuid, $3, 'empty', 'MANUAL', $4::uuid, 'DRAFT')`,
        batchId,
        TEST_SCHOOL_ID,
        'JB-EMPTY-' + batchId.slice(0, 8),
        TEST_PERIOD_ID,
      );
      await expect(
        withTestTenant(async () => posting.post(adminActor(), batchId)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects post by an actor without employeeId', async () => {
      const draft = await withTestTenant(async () =>
        posting.createDraft(adminActor(), balancedInput()),
      );
      const platformAdmin = { ...adminActor(), employeeId: null };
      await expect(
        withTestTenant(async () => posting.post(platformAdmin, draft.id)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it.each([
      ['student', studentActor],
      ['parent', parentActor],
    ])('rejects post by %s (ForbiddenException)', async (_label, actor) => {
      const draft = await withTestTenant(async () =>
        posting.createDraft(adminActor(), balancedInput()),
      );
      await expect(
        withTestTenant(async () => posting.post(actor(), draft.id)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // void
  // ────────────────────────────────────────────────────────────────────
  describe('void', () => {
    async function createAndPostBatch(): Promise<string> {
      const draft = await withTestTenant(async () =>
        posting.createDraft(adminActor(), balancedInput()),
      );
      await withTestTenant(async () => posting.post(adminActor(), draft.id));
      return draft.id;
    }

    it('happy path: flips POSTED to VOIDED, stamps voided_at + voided_by + reason', async () => {
      const id = await createAndPostBatch();
      await withTestTenant(async () => posting.void(adminActor(), id, { reason: 'duplicate' }));

      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT status, voided_at IS NOT NULL AS voided_at_set, voided_by::text AS voided_by, void_reason FROM tenant_test.fin_journal_batches WHERE id = $1::uuid`,
        id,
      )) as Array<{
        status: string;
        voided_at_set: boolean;
        voided_by: string;
        void_reason: string;
      }>;
      expect(rows[0]!.status).toBe('VOIDED');
      expect(rows[0]!.voided_at_set).toBe(true);
      expect(rows[0]!.voided_by).toBe(TEST_ADMIN_EMPLOYEE_ID);
      expect(rows[0]!.void_reason).toBe('duplicate');
    });

    it('voiding a posted batch reverses budget actuals (clamped to 0)', async () => {
      const draft = await withTestTenant(async () =>
        posting.createDraft(
          adminActor(),
          balancedInput({
            entries: [
              { accountId: TEST_COA_SUPPLIES_ID, fundId: TEST_FUND_ID, debit: 200, credit: 0 },
              { accountId: TEST_COA_CASH_ID, fundId: TEST_FUND_ID, debit: 0, credit: 200 },
            ],
          }),
        ),
      );
      await withTestTenant(async () => posting.post(adminActor(), draft.id));

      // Sanity: actual_amount is now 200
      const before = (await rawClient.$queryRawUnsafe(
        `SELECT actual_amount FROM tenant_test.fin_budget_lines WHERE account_id = $1::uuid AND budget_id IN (SELECT id FROM tenant_test.fin_budgets WHERE school_id = $2::uuid)`,
        TEST_COA_SUPPLIES_ID,
        TEST_SCHOOL_ID,
      )) as Array<{ actual_amount: string }>;
      expect(Number(before[0]!.actual_amount)).toBe(200);

      await withTestTenant(async () =>
        posting.void(adminActor(), draft.id, { reason: 'reversal' }),
      );

      const after = (await rawClient.$queryRawUnsafe(
        `SELECT actual_amount FROM tenant_test.fin_budget_lines WHERE account_id = $1::uuid AND budget_id IN (SELECT id FROM tenant_test.fin_budgets WHERE school_id = $2::uuid)`,
        TEST_COA_SUPPLIES_ID,
        TEST_SCHOOL_ID,
      )) as Array<{ actual_amount: string }>;
      expect(Number(after[0]!.actual_amount)).toBe(0);
    });

    it('rejects voiding a DRAFT batch', async () => {
      const draft = await withTestTenant(async () =>
        posting.createDraft(adminActor(), balancedInput()),
      );
      await expect(
        withTestTenant(async () => posting.void(adminActor(), draft.id, { reason: 'x' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects voiding an already-VOIDED batch', async () => {
      const id = await createAndPostBatch();
      await withTestTenant(async () => posting.void(adminActor(), id, { reason: 'first void' }));
      await expect(
        withTestTenant(async () => posting.void(adminActor(), id, { reason: 'second void' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects voiding a non-existent batch', async () => {
      await expect(
        withTestTenant(async () =>
          posting.void(adminActor(), '00000000-0000-0000-0000-000000000000', { reason: 'x' }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects void by a non-admin STAFF actor (admin-only contract)', async () => {
      const id = await createAndPostBatch();
      await expect(
        withTestTenant(async () => posting.void(officerActor(), id, { reason: 'x' })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it.each([
      ['student', studentActor],
      ['parent', parentActor],
    ])('rejects void by %s', async (_label, actor) => {
      const id = await createAndPostBatch();
      await expect(
        withTestTenant(async () => posting.void(actor(), id, { reason: 'x' })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects void by an admin actor without employeeId', async () => {
      const id = await createAndPostBatch();
      const platformAdmin = { ...adminActor(), employeeId: null };
      await expect(
        withTestTenant(async () => posting.void(platformAdmin, id, { reason: 'x' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // list + getById
  // ────────────────────────────────────────────────────────────────────
  describe('list + getById', () => {
    it('list returns batches scoped to the calling school only', async () => {
      // School A: one DRAFT
      const aDraft = await withTestTenant(async () =>
        posting.createDraft(adminActor(), balancedInput({ batchNumber: 'JB-A-001' })),
      );
      // School B: one DRAFT — same batchNumber is OK because it's a different school
      await withTestTenantB(async () =>
        posting.createDraft(adminActor(), balancedInput({ batchNumber: 'JB-A-001' })),
      );

      const aList = await withTestTenant(async () => posting.list());
      expect(aList.find((b) => b.id === aDraft.id)).toBeDefined();
      // Confirm the same-numbered School B batch is invisible to School A
      const aListByNumber = aList.filter((b) => b.batchNumber === 'JB-A-001');
      expect(aListByNumber).toHaveLength(1);
      expect(aListByNumber[0]!.schoolId).toBe(TEST_SCHOOL_ID);
    });

    it('list filters by status', async () => {
      const draft = await withTestTenant(async () =>
        posting.createDraft(adminActor(), balancedInput()),
      );
      await withTestTenant(async () => posting.post(adminActor(), draft.id));
      // Create another DRAFT
      const onlyDraft = await withTestTenant(async () =>
        posting.createDraft(adminActor(), balancedInput({ batchNumber: 'JB-DRAFT-001' })),
      );

      const posted = await withTestTenant(async () => posting.list({ status: 'POSTED' }));
      expect(posted.find((b) => b.id === draft.id)).toBeDefined();
      expect(posted.find((b) => b.id === onlyDraft.id)).toBeUndefined();
    });

    it('list filters by periodId', async () => {
      const draft = await withTestTenant(async () =>
        posting.createDraft(adminActor(), balancedInput()),
      );
      const matched = await withTestTenant(async () =>
        posting.list({ periodId: TEST_PERIOD_ID }),
      );
      expect(matched.find((b) => b.id === draft.id)).toBeDefined();
      const unmatched = await withTestTenant(async () =>
        posting.list({ periodId: '00000000-0000-0000-0000-000000000000' }),
      );
      expect(unmatched.find((b) => b.id === draft.id)).toBeUndefined();
    });

    it('getById returns full batch DTO with entries', async () => {
      const draft = await withTestTenant(async () =>
        posting.createDraft(adminActor(), balancedInput()),
      );
      const fetched = await withTestTenant(async () => posting.getById(draft.id));
      expect(fetched.id).toBe(draft.id);
      expect(fetched.entries).toHaveLength(2);
    });

    it('getById for a missing batch → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          posting.getById('00000000-0000-0000-0000-000000000000'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById for a School B batch as a School A actor → NotFoundException', async () => {
      const bDraft = await withTestTenantB(async () =>
        posting.createDraft(adminActor(), balancedInput({ batchNumber: 'JB-B-CROSS' })),
      );
      await expect(
        withTestTenant(async () => posting.getById(bDraft.id)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // createAndPost (GLConsumer path)
  // ────────────────────────────────────────────────────────────────────
  describe('createAndPost', () => {
    it('happy path: creates and posts in one shot, returns POSTED batch', async () => {
      const result = await withTestTenant(async () =>
        posting.createAndPost(adminActor(), {
          ...balancedInput(),
          sourceEventId: generateId(),
        }),
      );
      expect(result.status).toBe('POSTED');
      expect(result.postedBy).toBe(TEST_ADMIN_EMPLOYEE_ID);
    });

    it('idempotent on source_event_id: same event id returns same batch id', async () => {
      const eventId = generateId();
      const first = await withTestTenant(async () =>
        posting.createAndPost(adminActor(), { ...balancedInput(), sourceEventId: eventId }),
      );
      const second = await withTestTenant(async () =>
        posting.createAndPost(adminActor(), {
          ...balancedInput({ batchNumber: 'JB-OTHER-NUM' }),
          sourceEventId: eventId,
        }),
      );
      expect(second.id).toBe(first.id);

      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM tenant_test.fin_journal_batches WHERE source_event_id = $1::uuid`,
        eventId,
      )) as Array<{ n: number }>;
      expect(rows[0]!.n).toBe(1);
    });

    it('rejects when no OPEN period covers today and no explicit periodId', async () => {
      // Move the fixture period out of OPEN
      await rawClient.$executeRawUnsafe(
        `UPDATE tenant_test.fin_accounting_periods SET status='CLOSED', closed_at=now() WHERE id=$1::uuid`,
        TEST_PERIOD_ID,
      );
      await expect(
        withTestTenant(async () =>
          posting.createAndPost(adminActor(), {
            ...balancedInput(),
            // omit periodId → auto-detect
            accountingPeriodId: TEST_PERIOD_ID, // ignored — createAndPost looks up via periodId field
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects explicit periodId pointing at a CLOSED period', async () => {
      await rawClient.$executeRawUnsafe(
        `UPDATE tenant_test.fin_accounting_periods SET status='CLOSED', closed_at=now() WHERE id=$1::uuid`,
        TEST_PERIOD_ID,
      );
      await expect(
        withTestTenant(async () =>
          posting.createAndPost(adminActor(), {
            ...balancedInput(),
            periodId: TEST_PERIOD_ID,
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects explicit periodId that does not exist for the school', async () => {
      await expect(
        withTestTenant(async () =>
          posting.createAndPost(adminActor(), {
            ...balancedInput(),
            periodId: '00000000-0000-0000-0000-000000000000',
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // IMMUTABLE TRIGGER CONTRACT — the headline Wave 1 deliverable
  // ────────────────────────────────────────────────────────────────────
  describe('IMMUTABLE trigger contract — fin_gl_entries', () => {
    async function postedBatchWithCashEntry(): Promise<{ batchId: string; entryId: string }> {
      const draft = await withTestTenant(async () =>
        posting.createDraft(adminActor(), balancedInput()),
      );
      await withTestTenant(async () => posting.post(adminActor(), draft.id));
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT id::text AS id FROM tenant_test.fin_gl_entries WHERE batch_id = $1::uuid AND account_id = $2::uuid LIMIT 1`,
        draft.id,
        TEST_COA_CASH_ID,
      )) as Array<{ id: string }>;
      return { batchId: draft.id, entryId: rows[0]!.id };
    }

    it('UPDATE on fin_gl_entries.debit → SQLSTATE 23001 (prevent_mutation trigger)', async () => {
      const { entryId } = await postedBatchWithCashEntry();
      let caught: { code?: string; message?: string; meta?: { code?: string } } | undefined;
      try {
        await rawClient.$executeRawUnsafe(
          `UPDATE tenant_test.fin_gl_entries SET debit = 999 WHERE id = $1::uuid`,
          entryId,
        );
      } catch (err) {
        caught = err as { code?: string; message?: string; meta?: { code?: string } };
      }
      expect(caught).toBeDefined();
      // Prisma surfaces the underlying Postgres SQLSTATE either in
      // caught.meta.code (P2010 wrapper) or in caught.message.
      const sqlstate = caught?.meta?.code ?? '';
      const message = caught?.message ?? '';
      expect(sqlstate === '23001' || message.includes('23001') || message.toLowerCase().includes('immutable')).toBe(
        true,
      );
    });

    it('UPDATE on fin_gl_entries.account_id → SQLSTATE 23001', async () => {
      const { entryId } = await postedBatchWithCashEntry();
      let caught: { code?: string; message?: string; meta?: { code?: string } } | undefined;
      try {
        await rawClient.$executeRawUnsafe(
          `UPDATE tenant_test.fin_gl_entries SET account_id = $1::uuid WHERE id = $2::uuid`,
          TEST_COA_AR_ID,
          entryId,
        );
      } catch (err) {
        caught = err as { code?: string; message?: string; meta?: { code?: string } };
      }
      expect(caught).toBeDefined();
      const sqlstate = caught?.meta?.code ?? '';
      const message = caught?.message ?? '';
      expect(sqlstate === '23001' || message.includes('23001')).toBe(true);
    });

    it('DELETE on fin_gl_entries → SQLSTATE 23001', async () => {
      const { entryId } = await postedBatchWithCashEntry();
      let caught: { code?: string; message?: string; meta?: { code?: string } } | undefined;
      try {
        await rawClient.$executeRawUnsafe(
          `DELETE FROM tenant_test.fin_gl_entries WHERE id = $1::uuid`,
          entryId,
        );
      } catch (err) {
        caught = err as { code?: string; message?: string; meta?: { code?: string } };
      }
      expect(caught).toBeDefined();
      const sqlstate = caught?.meta?.code ?? '';
      const message = caught?.message ?? '';
      expect(sqlstate === '23001' || message.includes('23001')).toBe(true);
    });

    it('TRUNCATE on fin_gl_entries succeeds — table-level operation bypasses BEFORE ROW triggers', async () => {
      // This is the inverse of the contract above and documents why
      // resetFinanceTables can use TRUNCATE without raising 23001.
      // The fixture period's reset helper relies on it.
      const { entryId } = await postedBatchWithCashEntry();
      // Verify the row is there
      const before = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM tenant_test.fin_gl_entries WHERE id = $1::uuid`,
        entryId,
      )) as Array<{ n: number }>;
      expect(before[0]!.n).toBe(1);

      await rawClient.$executeRawUnsafe(`TRUNCATE tenant_test.fin_gl_entries CASCADE`);

      const after = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM tenant_test.fin_gl_entries WHERE id = $1::uuid`,
        entryId,
      )) as Array<{ n: number }>;
      expect(after[0]!.n).toBe(0);
    });
  });
});
