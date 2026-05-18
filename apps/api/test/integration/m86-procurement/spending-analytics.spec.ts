import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import {
  SpendingAnalyticsService,
  ProcurementAnalyticsWorker,
} from '@modules/m86-procurement/spending-analytics.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

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
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';
import { TEST_SUPPLIER_A_ID, TEST_SUPPLIER_B_ID } from '../fixtures/finance';

/**
 * DB-backed integration tests for SpendingAnalyticsService + the
 * ProcurementAnalyticsWorker monthly materialisation.
 *
 * Coverage:
 *   - list filters: fromPeriod, toPeriod, vendorId, category, department
 *   - cross-school isolation
 *   - persona authorisation (admin + reader perm)
 *   - worker.tickForSchool: aggregates issued POs by vendor in the
 *     prior calendar month, UPSERTs prc_spending_analytics
 *   - worker upsert idempotency (re-run produces same row count)
 */
describe('integration:m86-procurement/spending-analytics', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let service: SpendingAnalyticsService;
  let worker: ProcurementAnalyticsWorker;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    service = new SpendingAnalyticsService(tenantPrisma, permCheck);
    worker = new ProcurementAnalyticsWorker(tenantPrisma);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.prc_spending_analytics WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.prc_purchase_order_lines WHERE purchase_order_id IN
         (SELECT id FROM ${TEST_SCHEMA}.prc_purchase_orders WHERE school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.prc_purchase_orders WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
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

  async function seedAnalytics(
    school: string,
    period: string,
    vendorId: string | null,
    category: string | null,
    department: string | null,
    totalSpend: number,
    poCount: number,
  ): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.prc_spending_analytics
         (id, school_id, period, vendor_id, category, department, total_spend, po_count, avg_lead_time_days)
       VALUES ($1::uuid, $2::uuid, $3::date, $4::uuid, $5, $6, $7::numeric, $8, NULL)`,
      id,
      school,
      period,
      vendorId,
      category,
      department,
      totalSpend,
      poCount,
    );
    return id;
  }

  describe('list', () => {
    it('admin reads spending analytics for current school', async () => {
      await seedAnalytics(TEST_SCHOOL_ID, '2026-01-01', TEST_SUPPLIER_A_ID, 'supplies', null, 1500, 3);
      const list = await withTestTenant(async () => service.list(adminActor(), {}));
      expect(list.length).toBeGreaterThanOrEqual(1);
      expect(list[0]!.totalSpend).toBe(1500);
      expect(list[0]!.poCount).toBe(3);
    });

    it('officer with prc-001:read can read', async () => {
      await grantOfficer(['prc-001:read']);
      await seedAnalytics(TEST_SCHOOL_ID, '2026-01-01', TEST_SUPPLIER_A_ID, null, null, 1000, 2);
      const list = await withTestTenant(async () => service.list(officerActor(), {}));
      expect(list.length).toBeGreaterThanOrEqual(1);
    });

    it('non-procurement persona → Forbidden', async () => {
      await expect(
        withTestTenant(async () => service.list(studentActor(), {})),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => service.list(parentActor(), {})),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => service.list(officerActor(), {})),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('filter by fromPeriod includes only matching periods', async () => {
      await seedAnalytics(TEST_SCHOOL_ID, '2026-01-01', TEST_SUPPLIER_A_ID, null, null, 100, 1);
      await seedAnalytics(TEST_SCHOOL_ID, '2026-06-01', TEST_SUPPLIER_A_ID, null, null, 200, 2);
      await seedAnalytics(TEST_SCHOOL_ID, '2026-12-01', TEST_SUPPLIER_A_ID, null, null, 300, 3);
      const list = await withTestTenant(async () =>
        service.list(adminActor(), { fromPeriod: '2026-06-01' }),
      );
      const periods = list.map((r) => r.period);
      expect(periods.some((p) => p.startsWith('2026-01'))).toBe(false);
      expect(periods.some((p) => p.startsWith('2026-06'))).toBe(true);
      expect(periods.some((p) => p.startsWith('2026-12'))).toBe(true);
    });

    it('filter by toPeriod excludes later rows', async () => {
      await seedAnalytics(TEST_SCHOOL_ID, '2026-01-01', TEST_SUPPLIER_A_ID, null, null, 100, 1);
      await seedAnalytics(TEST_SCHOOL_ID, '2026-12-01', TEST_SUPPLIER_A_ID, null, null, 300, 3);
      const list = await withTestTenant(async () =>
        service.list(adminActor(), { toPeriod: '2026-06-30' }),
      );
      expect(list.some((r) => r.period.startsWith('2026-12'))).toBe(false);
    });

    it('filter by vendorId narrows to that vendor', async () => {
      await seedAnalytics(TEST_SCHOOL_ID, '2026-01-01', TEST_SUPPLIER_A_ID, null, null, 100, 1);
      await seedAnalytics(TEST_SCHOOL_ID, '2026-01-01', TEST_SUPPLIER_B_ID, null, null, 200, 2);
      const list = await withTestTenant(async () =>
        service.list(adminActor(), { vendorId: TEST_SUPPLIER_A_ID }),
      );
      expect(list.every((r) => r.vendorId === TEST_SUPPLIER_A_ID)).toBe(true);
    });

    it('filter by category', async () => {
      await seedAnalytics(TEST_SCHOOL_ID, '2026-01-01', TEST_SUPPLIER_A_ID, 'supplies', null, 100, 1);
      await seedAnalytics(TEST_SCHOOL_ID, '2026-01-01', TEST_SUPPLIER_A_ID, 'services', null, 200, 2);
      const list = await withTestTenant(async () =>
        service.list(adminActor(), { category: 'supplies' }),
      );
      expect(list.every((r) => r.category === 'supplies')).toBe(true);
    });

    it('filter by department', async () => {
      await seedAnalytics(TEST_SCHOOL_ID, '2026-01-01', TEST_SUPPLIER_A_ID, null, 'science', 100, 1);
      await seedAnalytics(TEST_SCHOOL_ID, '2026-01-01', TEST_SUPPLIER_A_ID, null, 'arts', 200, 2);
      const list = await withTestTenant(async () =>
        service.list(adminActor(), { department: 'science' }),
      );
      expect(list.every((r) => r.department === 'science')).toBe(true);
    });

    it('combined filters: vendor + category + period range', async () => {
      await seedAnalytics(TEST_SCHOOL_ID, '2026-01-01', TEST_SUPPLIER_A_ID, 'supplies', null, 100, 1);
      await seedAnalytics(TEST_SCHOOL_ID, '2026-06-01', TEST_SUPPLIER_A_ID, 'supplies', null, 200, 2);
      await seedAnalytics(TEST_SCHOOL_ID, '2026-06-01', TEST_SUPPLIER_B_ID, 'supplies', null, 300, 3);
      const list = await withTestTenant(async () =>
        service.list(adminActor(), {
          vendorId: TEST_SUPPLIER_A_ID,
          category: 'supplies',
          fromPeriod: '2026-05-01',
        }),
      );
      expect(list).toHaveLength(1);
      expect(list[0]!.period.startsWith('2026-06')).toBe(true);
    });

    it('list orders by period DESC, total_spend DESC NULLS LAST', async () => {
      await seedAnalytics(TEST_SCHOOL_ID, '2026-01-01', TEST_SUPPLIER_A_ID, null, null, 200, 1);
      await seedAnalytics(TEST_SCHOOL_ID, '2026-06-01', TEST_SUPPLIER_A_ID, null, null, 100, 1);
      const list = await withTestTenant(async () => service.list(adminActor(), {}));
      // 2026-06 row (newer period) ranks before 2026-01
      const idx = (p: string) => list.findIndex((r) => r.period.startsWith(p));
      expect(idx('2026-06')).toBeLessThan(idx('2026-01'));
    });

    it('cross-school isolation', async () => {
      await seedAnalytics(TEST_SCHOOL_B_ID, '2026-01-01', TEST_SUPPLIER_A_ID, null, null, 999, 1);
      const list = await withTestTenant(async () => service.list(adminActor(), {}));
      expect(list.find((r) => r.totalSpend === 999)).toBeUndefined();
    });
  });

  describe('ProcurementAnalyticsWorker.tickForSchool', () => {
    function priorMonthPeriod(): { period: string; isoStart: string; isoEnd: string } {
      const target = new Date();
      target.setUTCDate(1);
      target.setUTCHours(0, 0, 0, 0);
      target.setUTCMonth(target.getUTCMonth() - 1);
      const period = target.toISOString().slice(0, 10);
      const next = new Date(target);
      next.setUTCMonth(next.getUTCMonth() + 1);
      return {
        period,
        isoStart: target.toISOString(),
        isoEnd: next.toISOString(),
      };
    }

    async function seedIssuedPO(opts: {
      vendorId: string;
      total: number;
      issuedAt: string;
      school?: string;
    }): Promise<string> {
      const id = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.prc_purchase_orders
           (id, school_id, po_number, vendor_id, status, total_amount,
            delivery_address, issued_by, issued_at, payment_terms, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4::uuid, 'ISSUED', $5::numeric,
                 '123 Test St', $6::uuid, $7::timestamptz, 'NET_30', now(), now())`,
        id,
        opts.school ?? TEST_SCHOOL_ID,
        'PO-' + id,
        opts.vendorId,
        opts.total,
        TEST_ADMIN_EMPLOYEE_ID,
        opts.issuedAt,
      );
      return id;
    }

    it('aggregates POs issued in prior month into one row per vendor', async () => {
      const { period, isoStart, isoEnd } = priorMonthPeriod();
      const midMonth = new Date(
        new Date(isoStart).getTime() + 15 * 24 * 60 * 60 * 1000,
      ).toISOString();
      await seedIssuedPO({ vendorId: TEST_SUPPLIER_A_ID, total: 500, issuedAt: midMonth });
      await seedIssuedPO({ vendorId: TEST_SUPPLIER_A_ID, total: 250, issuedAt: midMonth });
      await seedIssuedPO({ vendorId: TEST_SUPPLIER_B_ID, total: 1000, issuedAt: midMonth });

      const count = await worker.tickForSchool(TEST_SCHEMA, TEST_SCHOOL_ID);
      expect(count).toBe(2);

      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT vendor_id::text AS vendor_id, total_spend, po_count
           FROM ${TEST_SCHEMA}.prc_spending_analytics
          WHERE school_id = $1::uuid AND period = $2::date
          ORDER BY total_spend DESC`,
        TEST_SCHOOL_ID,
        period,
      )) as Array<{ vendor_id: string; total_spend: string; po_count: number }>;
      expect(rows).toHaveLength(2);
      expect(rows[0]!.vendor_id).toBe(TEST_SUPPLIER_B_ID);
      expect(Number(rows[0]!.total_spend)).toBe(1000);
      expect(Number(rows[0]!.po_count)).toBe(1);
      const a = rows.find((r) => r.vendor_id === TEST_SUPPLIER_A_ID)!;
      expect(Number(a.total_spend)).toBe(750);
      expect(Number(a.po_count)).toBe(2);

      void isoEnd;
    });

    it('idempotent: re-run produces same row count (UPSERT)', async () => {
      const { isoStart } = priorMonthPeriod();
      const midMonth = new Date(
        new Date(isoStart).getTime() + 10 * 24 * 60 * 60 * 1000,
      ).toISOString();
      await seedIssuedPO({ vendorId: TEST_SUPPLIER_A_ID, total: 500, issuedAt: midMonth });

      await worker.tickForSchool(TEST_SCHEMA, TEST_SCHOOL_ID);
      await worker.tickForSchool(TEST_SCHEMA, TEST_SCHOOL_ID);

      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.prc_spending_analytics WHERE school_id = $1::uuid`,
        TEST_SCHOOL_ID,
      )) as Array<{ n: number }>;
      expect(rows[0]!.n).toBe(1);
    });

    it('ignores POs without issued_at (DRAFT etc.)', async () => {
      const id = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.prc_purchase_orders
           (id, school_id, po_number, vendor_id, status, total_amount,
            delivery_address, issued_by, payment_terms, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4::uuid, 'DRAFT', 100::numeric,
                 '123 Test St', $5::uuid, 'NET_30', now(), now())`,
        id,
        TEST_SCHOOL_ID,
        'PO-DRAFT-' + id.slice(0, 6),
        TEST_SUPPLIER_A_ID,
        TEST_ADMIN_EMPLOYEE_ID,
      );
      const count = await worker.tickForSchool(TEST_SCHEMA, TEST_SCHOOL_ID);
      expect(count).toBe(0);
    });

    it('ignores POs from outside prior calendar month', async () => {
      // PO issued today (current month) — should NOT be counted (worker
      // aggregates prior month only).
      await seedIssuedPO({
        vendorId: TEST_SUPPLIER_A_ID,
        total: 500,
        issuedAt: new Date().toISOString(),
      });
      const count = await worker.tickForSchool(TEST_SCHEMA, TEST_SCHOOL_ID);
      expect(count).toBe(0);
    });

    it('school scoping — only aggregates POs from the supplied school_id', async () => {
      const { isoStart } = priorMonthPeriod();
      const midMonth = new Date(
        new Date(isoStart).getTime() + 10 * 24 * 60 * 60 * 1000,
      ).toISOString();
      await seedIssuedPO({
        vendorId: TEST_SUPPLIER_A_ID,
        total: 999,
        issuedAt: midMonth,
        school: TEST_SCHOOL_B_ID,
      });
      const count = await worker.tickForSchool(TEST_SCHEMA, TEST_SCHOOL_ID);
      expect(count).toBe(0);
    });
  });

  describe('worker.runOnce — multi-tenant sweep', () => {
    it('returns tenantsScanned + rowsUpserted aggregated across active schools', async () => {
      // No POs seeded → 0 rows upserted but tenants are still scanned
      const result = await worker.runOnce();
      expect(result.tenantsScanned).toBeGreaterThanOrEqual(2);
      expect(result.rowsUpserted).toBeGreaterThanOrEqual(0);
    });
  });
});
