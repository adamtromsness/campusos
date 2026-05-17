import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { ProcurementSettingsService } from '@modules/m86-procurement/distribution.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { withTestTenant, TEST_SCHOOL_ID } from '../helpers/tenant-context';
import { resetProcurementTables } from '../helpers/reset';
import { adminActor, officerActor, teacherActor } from '../helpers/actor';

/**
 * Integration tests for ProcurementSettingsService.
 *
 * Loop 2 trivial spec — auto-create defaults + idempotency. Loop 3 adds:
 *   - update() admin-only authorisation
 *   - poNumberPrefix validation (blank / too long / bad chars)
 *   - cross-field rule (requireThreeQuotesAbove >= autoPoThreshold) — both
 *     directions on partial updates
 *   - happy-path partial update
 */
describe('integration:ProcurementSettingsService', () => {
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
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await withTestTenant(async () => {
      await resetProcurementTables(tenantPrisma);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // get — auto-create + idempotency (Loop 2)
  // ──────────────────────────────────────────────────────────────
  describe('get', () => {
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
      await withTestTenant(async () => service.get());

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

      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM tenant_test.prc_procurement_settings WHERE school_id = $1::uuid`,
        TEST_SCHOOL_ID,
      )) as Array<{ n: number }>;
      expect(rows[0]!.n).toBe(1);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // update — admin-only + validations
  // ──────────────────────────────────────────────────────────────
  describe('update', () => {
    it('happy path: admin updates poNumberPrefix and defaultPaymentTerms', async () => {
      await withTestTenant(async () => service.get()); // materialise defaults

      const updated = await withTestTenant(async () =>
        service.update(adminActor(), {
          poNumberPrefix: 'TEST-PO',
          defaultPaymentTerms: 'NET_45',
        }),
      );
      expect(updated.poNumberPrefix).toBe('TEST-PO');
      expect(updated.defaultPaymentTerms).toBe('NET_45');

      // Persisted to DB
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT po_number_prefix, default_payment_terms
         FROM tenant_test.prc_procurement_settings WHERE school_id = $1::uuid`,
        TEST_SCHOOL_ID,
      )) as Array<{ po_number_prefix: string; default_payment_terms: string }>;
      expect(rows[0]!.po_number_prefix).toBe('TEST-PO');
      expect(rows[0]!.default_payment_terms).toBe('NET_45');
    });

    it('non-admin (officer with STAFF + non-isSchoolAdmin) → ForbiddenException', async () => {
      await withTestTenant(async () => service.get());
      await expect(
        withTestTenant(async () => service.update(officerActor(), { poNumberPrefix: 'X' })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('non-admin (teacher) → ForbiddenException', async () => {
      await withTestTenant(async () => service.get());
      await expect(
        withTestTenant(async () => service.update(teacherActor(), { poNumberPrefix: 'X' })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects blank poNumberPrefix', async () => {
      await withTestTenant(async () => service.get());
      await expect(
        withTestTenant(async () => service.update(adminActor(), { poNumberPrefix: '   ' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects poNumberPrefix with bad characters', async () => {
      await withTestTenant(async () => service.get());
      await expect(
        withTestTenant(async () => service.update(adminActor(), { poNumberPrefix: 'BAD PREFIX!' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects poNumberPrefix > 20 characters', async () => {
      await withTestTenant(async () => service.get());
      await expect(
        withTestTenant(async () =>
          service.update(adminActor(), { poNumberPrefix: 'A'.repeat(21) }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('trims poNumberPrefix whitespace before persisting', async () => {
      await withTestTenant(async () => service.get());
      const updated = await withTestTenant(async () =>
        service.update(adminActor(), { poNumberPrefix: '  TRIMMED  ' }),
      );
      expect(updated.poNumberPrefix).toBe('TRIMMED');
    });

    it('rejects requireThreeQuotesAbove below autoPoThreshold (cross-field)', async () => {
      await withTestTenant(async () => service.get());
      await expect(
        withTestTenant(async () =>
          service.update(adminActor(), {
            autoPoThreshold: 500,
            requireThreeQuotesAbove: 100,
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts cross-field rule when requireThreeQuotesAbove >= autoPoThreshold', async () => {
      await withTestTenant(async () => service.get());
      const updated = await withTestTenant(async () =>
        service.update(adminActor(), {
          autoPoThreshold: 500,
          requireThreeQuotesAbove: 5000,
        }),
      );
      expect(updated.autoPoThreshold).toBe(500);
      expect(updated.requireThreeQuotesAbove).toBe(5000);
    });

    it('cross-field rule resolves partial PATCH against the current row', async () => {
      await withTestTenant(async () => service.get());
      // First, set both to a passing state
      await withTestTenant(async () =>
        service.update(adminActor(), { autoPoThreshold: 500, requireThreeQuotesAbove: 5000 }),
      );
      // Now try to bump only autoPoThreshold so the existing requireThreeQuotesAbove
      // would fall below — must be rejected.
      await expect(
        withTestTenant(async () => service.update(adminActor(), { autoPoThreshold: 6000 })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('no-op update (empty input) still returns the settings row', async () => {
      await withTestTenant(async () => service.get());
      const result = await withTestTenant(async () => service.update(adminActor(), {}));
      expect(result.schoolId).toBe(TEST_SCHOOL_ID);
      expect(result.poNumberPrefix).toBe('PO');
    });
  });
});
