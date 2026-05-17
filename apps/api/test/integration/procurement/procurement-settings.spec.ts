import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { ProcurementSettingsService } from '../../../src/procurement/distribution.service';
import { TenantPrismaService } from '../../../src/tenant/tenant-prisma.service';
import { withTestTenant, TEST_SCHOOL_ID } from '../helpers/tenant-context';
import { resetProcurementTables } from '../helpers/reset';

/**
 * Loop 2 trivial spec — proves the integration harness is wired.
 *
 * Exercises ProcurementSettingsService.get() against a real PrismaClient
 * against a real tenant_test schema. The service:
 *   - reads the current tenant from AsyncLocalStorage
 *   - SELECTs from prc_procurement_settings WHERE school_id = tenant
 *   - if no row, INSERTs a row with DB defaults and recurses
 *   - returns the typed DTO
 *
 * Loop 2 success criterion: this spec is green. No coverage assertion;
 * coverage targets land once the full procurement test suite exists.
 */
describe('integration:harness — ProcurementSettingsService.get', () => {
  let tenantPrisma: TenantPrismaService;
  let service: ProcurementSettingsService;
  let rawClient: PrismaClient;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    service = new ProcurementSettingsService(tenantPrisma);
    rawClient = new PrismaClient();
    await rawClient.$connect();
  });

  afterAll(async () => {
    // TenantPrismaService is NestJS-lifecycle-aware. The OnModuleDestroy
    // hook disconnects its internal Prisma client; we invoke it manually
    // since we're not running inside a Nest app.
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await withTestTenant(async () => {
      await resetProcurementTables(tenantPrisma);
    });
  });

  it('auto-creates default settings on first read for a school with no prior settings', async () => {
    const settings = await withTestTenant(async () => service.get());

    expect(settings.schoolId).toBe(TEST_SCHOOL_ID);
    expect(settings.poNumberPrefix).toBe('PO');
    expect(settings.poNumberNextSeq).toBe(1);
    expect(settings.defaultPaymentTerms).toBe('NET_30');
    expect(settings.autoPoThreshold).toBeNull();
    expect(settings.requireThreeQuotesAbove).toBeNull();
    expect(typeof settings.id).toBe('string');
    expect(settings.id.length).toBeGreaterThan(0);
  });

  it('actually wrote a row to prc_procurement_settings (DB-state assertion)', async () => {
    // First call auto-creates.
    await withTestTenant(async () => service.get());

    // Verify with a raw SQL count against the test schema.
    const rows = (await rawClient.$queryRawUnsafe(
      `SELECT id::text AS id, school_id::text AS school_id, po_number_prefix, po_number_next_seq, default_payment_terms
       FROM tenant_test.prc_procurement_settings WHERE school_id = $1::uuid`,
      TEST_SCHOOL_ID,
    )) as Array<{
      id: string;
      school_id: string;
      po_number_prefix: string;
      po_number_next_seq: number;
      default_payment_terms: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.school_id).toBe(TEST_SCHOOL_ID);
    expect(rows[0]!.po_number_prefix).toBe('PO');
    expect(Number(rows[0]!.po_number_next_seq)).toBe(1);
    expect(rows[0]!.default_payment_terms).toBe('NET_30');
  });

  it('returns the same row on a second call (idempotency — no duplicate INSERT)', async () => {
    const first = await withTestTenant(async () => service.get());
    const second = await withTestTenant(async () => service.get());
    expect(second.id).toBe(first.id);

    // And only one row exists in the table.
    const rows = (await rawClient.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM tenant_test.prc_procurement_settings WHERE school_id = $1::uuid`,
      TEST_SCHOOL_ID,
    )) as Array<{ n: number }>;
    expect(rows[0]!.n).toBe(1);
  });
});
