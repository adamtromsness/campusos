import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { SupplierService, GrantService } from '@modules/m83-finance/budgets.service';
import { FinanceValidationService } from '@modules/m83-finance/validation';
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
  teacherActor,
} from '../helpers/actor';
import { TEST_FUND_ID, TEST_FUND_B_ID, TEST_SUPPLIER_A_ID } from '../fixtures/finance';

/**
 * DB-backed integration tests for SupplierService + GrantService —
 * two of the smaller services in budgets.service.ts.
 */
describe('integration:m83-finance/suppliers-and-grants', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let validation: FinanceValidationService;
  let suppliers: SupplierService;
  let grants: GrantService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    validation = new FinanceValidationService(tenantPrisma);
    suppliers = new SupplierService(tenantPrisma);
    grants = new GrantService(tenantPrisma, validation);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.fin_supplier_contacts WHERE supplier_id IN
         (SELECT id FROM ${TEST_SCHEMA}.fin_suppliers
            WHERE school_id IN ($1::uuid, $2::uuid)
              AND supplier_code LIKE 'TEST-%')`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.fin_suppliers
        WHERE school_id IN ($1::uuid, $2::uuid)
          AND supplier_code LIKE 'TEST-%'`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.fin_grants WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
  });

  describe('SupplierService', () => {
    function baseSupplier(overrides: Record<string, unknown> = {}) {
      return {
        supplierCode: 'TEST-SUP-' + Math.random().toString(36).slice(2, 8),
        supplierName: 'Acme Office Supplies',
        supplierType: 'VENDOR' as const,
        taxId: '12-3456789',
        addressLine1: '123 Main St',
        city: 'Anytown',
        region: 'CA',
        postalCode: '90210',
        country: 'US',
        paymentTerms: 'NET_30',
        notes: 'Preferred vendor for office supplies',
        ...overrides,
      };
    }

    it('admin creates a supplier', async () => {
      const s = await withTestTenant(async () => suppliers.create(adminActor(), baseSupplier()));
      expect(s.supplierName).toBe('Acme Office Supplies');
      expect(s.supplierType).toBe('VENDOR');
      expect(s.isActive).toBe(true);
      expect(s.contacts).toEqual([]);
    });

    it('STAFF actor can create', async () => {
      const s = await withTestTenant(async () =>
        suppliers.create(officerActor(), baseSupplier()),
      );
      expect(s.id).toBeTruthy();
    });

    it('STAFF teacher can create (any STAFF persona allowed)', async () => {
      const s = await withTestTenant(async () =>
        suppliers.create(teacherActor(), baseSupplier()),
      );
      expect(s.id).toBeTruthy();
    });

    it('student → Forbidden', async () => {
      await expect(
        withTestTenant(async () => suppliers.create(studentActor(), baseSupplier())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('parent → Forbidden', async () => {
      await expect(
        withTestTenant(async () => suppliers.create(parentActor(), baseSupplier())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('default supplierType is VENDOR when omitted', async () => {
      const input = baseSupplier();
      delete (input as { supplierType?: string }).supplierType;
      const s = await withTestTenant(async () => suppliers.create(adminActor(), input));
      expect(s.supplierType).toBe('VENDOR');
    });

    it('duplicate supplier_code → ConflictException', async () => {
      const input = baseSupplier();
      await withTestTenant(async () => suppliers.create(adminActor(), input));
      await expect(
        withTestTenant(async () => suppliers.create(adminActor(), input)),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('list returns active suppliers (default), excluding inactive', async () => {
      const active = await withTestTenant(async () =>
        suppliers.create(adminActor(), baseSupplier()),
      );
      const inactive = await withTestTenant(async () =>
        suppliers.create(adminActor(), baseSupplier()),
      );
      // Deactivate one
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.fin_suppliers SET is_active = false WHERE id = $1::uuid`,
        inactive.id,
      );
      const list = await withTestTenant(async () => suppliers.list());
      expect(list.find((s) => s.id === active.id)).toBeDefined();
      expect(list.find((s) => s.id === inactive.id)).toBeUndefined();
    });

    it('list with includeInactive=true returns both', async () => {
      const a = await withTestTenant(async () =>
        suppliers.create(adminActor(), baseSupplier()),
      );
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.fin_suppliers SET is_active = false WHERE id = $1::uuid`,
        a.id,
      );
      const list = await withTestTenant(async () => suppliers.list(true));
      expect(list.find((s) => s.id === a.id)).toBeDefined();
    });

    it('getById returns supplier with contacts ordered (primary first)', async () => {
      const s = await withTestTenant(async () =>
        suppliers.create(adminActor(), baseSupplier()),
      );
      // Seed contacts directly
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.fin_supplier_contacts (id, supplier_id, contact_name, email, is_primary)
         VALUES ($1::uuid, $2::uuid, 'Alice', 'alice@x.com', false),
                ($3::uuid, $2::uuid, 'Bob', 'bob@x.com', true)`,
        generateId(),
        s.id,
        generateId(),
      );
      const detail = await withTestTenant(async () => suppliers.getById(s.id));
      expect(detail.contacts).toHaveLength(2);
      expect(detail.contacts[0]!.isPrimary).toBe(true);
      expect(detail.contacts[0]!.contactName).toBe('Bob');
    });

    it('getById missing → NotFound', async () => {
      await expect(
        withTestTenant(async () => suppliers.getById(generateId())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school getById → NotFound', async () => {
      const s = await withTestTenant(async () =>
        suppliers.create(adminActor(), baseSupplier()),
      );
      await expect(
        withTestTenantB(async () => suppliers.getById(s.id)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school list does not include other school suppliers', async () => {
      const a = await withTestTenant(async () =>
        suppliers.create(adminActor(), baseSupplier()),
      );
      const listB = await withTestTenantB(async () => suppliers.list(true));
      expect(listB.find((s) => s.id === a.id)).toBeUndefined();
    });
  });

  describe('GrantService', () => {
    function baseGrant(overrides: Record<string, unknown> = {}) {
      const today = new Date().toISOString().slice(0, 10);
      const oneYear = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      return {
        fundId: TEST_FUND_ID,
        grantName: 'Title I Funding 2026',
        grantor: 'US Department of Education',
        grantNumber: 'TITLE1-2026-001',
        awardAmount: 50000,
        startDate: today,
        endDate: oneYear,
        reportingDueDate: oneYear,
        notes: 'Annual federal grant.',
        ...overrides,
      };
    }

    it('admin creates a grant', async () => {
      const g = await withTestTenant(async () => grants.create(adminActor(), baseGrant()));
      expect(g.grantName).toBe('Title I Funding 2026');
      expect(g.awardAmount).toBe(50000);
      expect(g.drawnAmount).toBe(0);
      expect(g.remainingAmount).toBe(50000);
      expect(g.status).toBe('ACTIVE');
      expect(g.fundCode).toBe('GENERAL');
    });

    it('non-admin → Forbidden', async () => {
      await expect(
        withTestTenant(async () => grants.create(officerActor(), baseGrant())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => grants.create(teacherActor(), baseGrant())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => grants.create(studentActor(), baseGrant())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => grants.create(parentActor(), baseGrant())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('endDate before startDate → BadRequest', async () => {
      await expect(
        withTestTenant(async () =>
          grants.create(
            adminActor(),
            baseGrant({ startDate: '2026-12-01', endDate: '2026-01-01' }),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cross-school fund → BadRequest (assertActiveFund)', async () => {
      await expect(
        withTestTenant(async () =>
          grants.create(adminActor(), baseGrant({ fundId: TEST_FUND_B_ID })),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('fund omitted is allowed (fundId optional in service)', async () => {
      const input = baseGrant();
      delete (input as { fundId?: string }).fundId;
      const g = await withTestTenant(async () => grants.create(adminActor(), input));
      expect(g.fundId).toBeNull();
    });

    it('list returns grants ordered by start_date DESC', async () => {
      const recent = await withTestTenant(async () =>
        grants.create(
          adminActor(),
          baseGrant({ startDate: '2026-06-01', endDate: '2027-06-01' }),
        ),
      );
      const old = await withTestTenant(async () =>
        grants.create(
          adminActor(),
          baseGrant({ startDate: '2025-01-01', endDate: '2026-01-01' }),
        ),
      );
      const list = await withTestTenant(async () => grants.list());
      const recentIdx = list.findIndex((g) => g.id === recent.id);
      const oldIdx = list.findIndex((g) => g.id === old.id);
      expect(recentIdx).toBeLessThan(oldIdx);
    });

    it('getById missing → NotFound', async () => {
      await expect(
        withTestTenant(async () => grants.getById(generateId())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school getById → NotFound', async () => {
      const g = await withTestTenant(async () => grants.create(adminActor(), baseGrant()));
      await expect(
        withTestTenantB(async () => grants.getById(g.id)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    describe('patch', () => {
      async function seed(): Promise<string> {
        const g = await withTestTenant(async () => grants.create(adminActor(), baseGrant()));
        return g.id;
      }

      it('non-admin → Forbidden', async () => {
        const id = await seed();
        await expect(
          withTestTenant(async () => grants.patch(officerActor(), id, { grantName: 'x' })),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });

      it('partial: grantName update', async () => {
        const id = await seed();
        const updated = await withTestTenant(async () =>
          grants.patch(adminActor(), id, { grantName: 'Renamed Grant' }),
        );
        expect(updated.grantName).toBe('Renamed Grant');
      });

      it('partial: drawnAmount update; remaining is computed', async () => {
        const id = await seed();
        const updated = await withTestTenant(async () =>
          grants.patch(adminActor(), id, { drawnAmount: 15000 }),
        );
        expect(updated.drawnAmount).toBe(15000);
        expect(updated.remainingAmount).toBe(35000);
      });

      it('partial: status transition to CLOSED', async () => {
        const id = await seed();
        const updated = await withTestTenant(async () =>
          grants.patch(adminActor(), id, { status: 'CLOSED' }),
        );
        expect(updated.status).toBe('CLOSED');
      });

      it('partial: reportingDueDate + notes update', async () => {
        const id = await seed();
        const future = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10);
        const updated = await withTestTenant(async () =>
          grants.patch(adminActor(), id, {
            reportingDueDate: future,
            notes: 'Updated report date',
          }),
        );
        expect(updated.notes).toBe('Updated report date');
      });

      it('empty patch returns current row (no-op)', async () => {
        const id = await seed();
        const updated = await withTestTenant(async () => grants.patch(adminActor(), id, {}));
        expect(updated.id).toBe(id);
      });
    });

    it('cross-school: grant created in School B not visible from School A', async () => {
      const b = await withTestTenantB(async () =>
        grants.create(adminActor(), baseGrant({ fundId: TEST_FUND_B_ID })),
      );
      const listA = await withTestTenant(async () => grants.list());
      expect(listA.find((g) => g.id === b.id)).toBeUndefined();
    });
  });
});
