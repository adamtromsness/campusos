import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { VendorCatalogueService } from '@modules/m86-procurement/vendor-catalogue.service';
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
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';
import {
  TEST_SUPPLIER_A_ID,
  TEST_SUPPLIER_B_ID,
  TEST_SUPPLIER_B_SCHOOL_ID,
} from '../fixtures/finance';

/**
 * DB-backed integration tests for VendorCatalogueService — per-vendor
 * pre-negotiated pricing catalogue + item CRUD.
 *
 * Coverage:
 *   - Catalogue create/list/get/patch
 *   - Item add/patch with school-scoped JOIN authorisation
 *   - Vendor-in-school validation
 *   - UNIQUE (vendor, school, catalogue_name) and (catalogue, item_code)
 *   - effective_to >= effective_from validation
 *   - Cross-school isolation
 */
describe('integration:m86-procurement/vendor-catalogue', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let service: VendorCatalogueService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    service = new VendorCatalogueService(tenantPrisma, permCheck);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.prc_catalogue_items WHERE catalogue_id IN
         (SELECT id FROM ${TEST_SCHEMA}.prc_vendor_catalogues WHERE school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.prc_vendor_catalogues WHERE school_id IN ($1::uuid, $2::uuid)`,
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

  function baseCatalogue(overrides: Record<string, unknown> = {}) {
    return {
      vendorId: TEST_SUPPLIER_A_ID,
      catalogueName: 'Q1 2026 Pricing',
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-12-31',
      notes: 'Annual contract pricing.',
      ...overrides,
    };
  }

  function baseItem(overrides: Record<string, unknown> = {}) {
    return {
      itemCode: 'ITEM-001',
      description: 'Box of pens (12-pack)',
      unit: 'box',
      negotiatedPrice: 9.99,
      category: 'office_supplies',
      minOrderQty: 1,
      leadTimeDays: 5,
      ...overrides,
    };
  }

  describe('catalogue create', () => {
    it('admin creates a catalogue; isActive defaults to true', async () => {
      const c = await withTestTenant(async () => service.create(adminActor(), baseCatalogue()));
      expect(c.catalogueName).toBe('Q1 2026 Pricing');
      expect(c.isActive).toBe(true);
      expect(c.vendorId).toBe(TEST_SUPPLIER_A_ID);
    });

    it('officer with prc-002:write can create', async () => {
      await grantOfficer(['prc-002:write']);
      const c = await withTestTenant(async () => service.create(officerActor(), baseCatalogue()));
      expect(c.id).toBeTruthy();
    });

    it('officer without procurement perm → Forbidden', async () => {
      await expect(
        withTestTenant(async () => service.create(officerActor(), baseCatalogue())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('student → Forbidden (persona collapse)', async () => {
      await expect(
        withTestTenant(async () => service.create(studentActor(), baseCatalogue())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('parent → Forbidden', async () => {
      await expect(
        withTestTenant(async () => service.create(parentActor(), baseCatalogue())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('effectiveTo before effectiveFrom → BadRequest (caught before INSERT)', async () => {
      await expect(
        withTestTenant(async () =>
          service.create(
            adminActor(),
            baseCatalogue({ effectiveFrom: '2026-06-01', effectiveTo: '2026-01-01' }),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('effectiveTo null is allowed (open-ended catalogue)', async () => {
      const c = await withTestTenant(async () =>
        service.create(adminActor(), baseCatalogue({ effectiveTo: undefined })),
      );
      expect(c.effectiveTo).toBeNull();
    });

    it('vendor in another school → BadRequest', async () => {
      await expect(
        withTestTenant(async () =>
          service.create(adminActor(), baseCatalogue({ vendorId: TEST_SUPPLIER_B_SCHOOL_ID })),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('non-existent vendor → BadRequest', async () => {
      await expect(
        withTestTenant(async () =>
          service.create(adminActor(), baseCatalogue({ vendorId: generateId() })),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('duplicate (vendor, school, catalogue_name) → ConflictException', async () => {
      await withTestTenant(async () => service.create(adminActor(), baseCatalogue()));
      await expect(
        withTestTenant(async () => service.create(adminActor(), baseCatalogue())),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('same catalogue_name allowed for different vendor', async () => {
      await withTestTenant(async () => service.create(adminActor(), baseCatalogue()));
      const c = await withTestTenant(async () =>
        service.create(adminActor(), baseCatalogue({ vendorId: TEST_SUPPLIER_B_ID })),
      );
      expect(c.vendorId).toBe(TEST_SUPPLIER_B_ID);
    });
  });

  describe('catalogue list + getById', () => {
    it('list filters by vendorId', async () => {
      const a = await withTestTenant(async () => service.create(adminActor(), baseCatalogue()));
      const b = await withTestTenant(async () =>
        service.create(adminActor(), baseCatalogue({ vendorId: TEST_SUPPLIER_B_ID })),
      );
      const filtered = await withTestTenant(async () =>
        service.list(adminActor(), TEST_SUPPLIER_A_ID),
      );
      expect(filtered.find((c) => c.id === a.id)).toBeDefined();
      expect(filtered.find((c) => c.id === b.id)).toBeUndefined();
    });

    it('list returns all in current school by default', async () => {
      const a = await withTestTenant(async () => service.create(adminActor(), baseCatalogue()));
      const list = await withTestTenant(async () => service.list(adminActor()));
      expect(list.find((c) => c.id === a.id)).toBeDefined();
    });

    it('getById returns catalogue with empty items array initially', async () => {
      const c = await withTestTenant(async () => service.create(adminActor(), baseCatalogue()));
      const detail = await withTestTenant(async () => service.getById(adminActor(), c.id));
      expect(detail.id).toBe(c.id);
      expect(detail.items).toEqual([]);
    });

    it('cross-school getById → NotFound', async () => {
      const c = await withTestTenant(async () => service.create(adminActor(), baseCatalogue()));
      await expect(
        withTestTenantB(async () => service.getById(adminActor(), c.id)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById missing → NotFound', async () => {
      await expect(
        withTestTenant(async () => service.getById(adminActor(), generateId())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('list/getById as student → Forbidden', async () => {
      await expect(withTestTenant(async () => service.list(studentActor()))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('catalogue patch', () => {
    async function seed(): Promise<string> {
      const c = await withTestTenant(async () => service.create(adminActor(), baseCatalogue()));
      return c.id;
    }

    it('partial patch: catalogueName + notes', async () => {
      const id = await seed();
      const updated = await withTestTenant(async () =>
        service.patch(adminActor(), id, { catalogueName: 'Renamed', notes: 'updated' }),
      );
      expect(updated.catalogueName).toBe('Renamed');
      expect(updated.notes).toBe('updated');
    });

    it('patch isActive flips to false', async () => {
      const id = await seed();
      const updated = await withTestTenant(async () =>
        service.patch(adminActor(), id, { isActive: false }),
      );
      expect(updated.isActive).toBe(false);
    });

    it('patch effectiveFrom + effectiveTo together with valid range', async () => {
      const id = await seed();
      const updated = await withTestTenant(async () =>
        service.patch(adminActor(), id, {
          effectiveFrom: '2026-07-01',
          effectiveTo: '2027-06-30',
        }),
      );
      expect(updated.effectiveFrom).toBe('2026-07-01');
      expect(updated.effectiveTo).toBe('2027-06-30');
    });

    it('patch effectiveTo before effectiveFrom → BadRequest', async () => {
      const id = await seed();
      await expect(
        withTestTenant(async () =>
          service.patch(adminActor(), id, {
            effectiveFrom: '2026-12-01',
            effectiveTo: '2026-01-01',
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('patch rename to duplicate name → ConflictException', async () => {
      const id = await seed();
      const id2 = await withTestTenant(async () =>
        service
          .create(adminActor(), baseCatalogue({ catalogueName: 'Different' }))
          .then((c) => c.id),
      );
      await expect(
        withTestTenant(async () =>
          service.patch(adminActor(), id2, { catalogueName: 'Q1 2026 Pricing' }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('empty patch returns current row', async () => {
      const id = await seed();
      const updated = await withTestTenant(async () => service.patch(adminActor(), id, {}));
      expect(updated.id).toBe(id);
    });

    it('missing catalogue → NotFound', async () => {
      await expect(
        withTestTenant(async () => service.patch(adminActor(), generateId(), { notes: 'x' })),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school patch → NotFound', async () => {
      const id = await seed();
      await expect(
        withTestTenantB(async () => service.patch(adminActor(), id, { notes: 'x' })),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-admin patch → Forbidden', async () => {
      const id = await seed();
      await expect(
        withTestTenant(async () => service.patch(officerActor(), id, { notes: 'x' })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('catalogue items: addItem', () => {
    async function seedCatalogue(): Promise<string> {
      const c = await withTestTenant(async () => service.create(adminActor(), baseCatalogue()));
      return c.id;
    }

    it('admin adds an item with default minOrderQty=1', async () => {
      const cid = await seedCatalogue();
      const input = baseItem();
      delete (input as { minOrderQty?: number }).minOrderQty;
      const item = await withTestTenant(async () => service.addItem(adminActor(), cid, input));
      expect(item.minOrderQty).toBe(1);
      expect(item.negotiatedPrice).toBe(9.99);
      expect(item.isActive).toBe(true);
    });

    it('addItem to non-existent catalogue → NotFound', async () => {
      await expect(
        withTestTenant(async () => service.addItem(adminActor(), generateId(), baseItem())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('addItem to cross-school catalogue → NotFound', async () => {
      const cid = await seedCatalogue();
      await expect(
        withTestTenantB(async () => service.addItem(adminActor(), cid, baseItem())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('duplicate item_code in same catalogue → ConflictException', async () => {
      const cid = await seedCatalogue();
      await withTestTenant(async () => service.addItem(adminActor(), cid, baseItem()));
      await expect(
        withTestTenant(async () => service.addItem(adminActor(), cid, baseItem())),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('same item_code allowed in a different catalogue', async () => {
      const c1 = await seedCatalogue();
      const c2 = await withTestTenant(async () =>
        service.create(adminActor(), baseCatalogue({ catalogueName: 'Other' })).then((c) => c.id),
      );
      await withTestTenant(async () => service.addItem(adminActor(), c1, baseItem()));
      const i2 = await withTestTenant(async () => service.addItem(adminActor(), c2, baseItem()));
      expect(i2.id).toBeTruthy();
    });

    it('non-admin → Forbidden', async () => {
      const cid = await seedCatalogue();
      await expect(
        withTestTenant(async () => service.addItem(officerActor(), cid, baseItem())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('items appear in getById', async () => {
      const cid = await seedCatalogue();
      await withTestTenant(async () => service.addItem(adminActor(), cid, baseItem()));
      await withTestTenant(async () =>
        service.addItem(
          adminActor(),
          cid,
          baseItem({ itemCode: 'ITEM-002', description: 'Other' }),
        ),
      );
      const detail = await withTestTenant(async () => service.getById(adminActor(), cid));
      expect(detail.items).toHaveLength(2);
    });
  });

  describe('catalogue items: patchItem', () => {
    async function seedItem(): Promise<{ catalogueId: string; itemId: string }> {
      const c = await withTestTenant(async () => service.create(adminActor(), baseCatalogue()));
      const i = await withTestTenant(async () => service.addItem(adminActor(), c.id, baseItem()));
      return { catalogueId: c.id, itemId: i.id };
    }

    it('partial patchItem: description + price', async () => {
      const { itemId } = await seedItem();
      const updated = await withTestTenant(async () =>
        service.patchItem(adminActor(), itemId, {
          description: 'Updated pens',
          negotiatedPrice: 12.5,
        }),
      );
      expect(updated.description).toBe('Updated pens');
      expect(updated.negotiatedPrice).toBe(12.5);
    });

    it('patchItem: minOrderQty + leadTimeDays + isActive', async () => {
      const { itemId } = await seedItem();
      const updated = await withTestTenant(async () =>
        service.patchItem(adminActor(), itemId, {
          minOrderQty: 5,
          leadTimeDays: 10,
          isActive: false,
        }),
      );
      expect(updated.minOrderQty).toBe(5);
      expect(updated.leadTimeDays).toBe(10);
      expect(updated.isActive).toBe(false);
    });

    it('patchItem: unit + category', async () => {
      const { itemId } = await seedItem();
      const updated = await withTestTenant(async () =>
        service.patchItem(adminActor(), itemId, { unit: 'each', category: 'consumables' }),
      );
      expect(updated.unit).toBe('each');
      expect(updated.category).toBe('consumables');
    });

    it('empty patchItem returns current row', async () => {
      const { itemId } = await seedItem();
      const updated = await withTestTenant(async () => service.patchItem(adminActor(), itemId, {}));
      expect(updated.id).toBe(itemId);
    });

    it('patchItem cross-school → NotFound (school-scoped JOIN protects)', async () => {
      const { itemId } = await seedItem();
      await expect(
        withTestTenantB(async () => service.patchItem(adminActor(), itemId, { description: 'x' })),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('patchItem missing → NotFound', async () => {
      await expect(
        withTestTenant(async () =>
          service.patchItem(adminActor(), generateId(), { description: 'x' }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('patchItem as non-admin → Forbidden', async () => {
      const { itemId } = await seedItem();
      await expect(
        withTestTenant(async () => service.patchItem(officerActor(), itemId, { description: 'x' })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('cross-school isolation', () => {
    it('catalogue created in School B not visible from School A list', async () => {
      const b = await withTestTenantB(async () =>
        service.create(adminActor(), baseCatalogue({ vendorId: TEST_SUPPLIER_B_SCHOOL_ID })),
      );
      const listA = await withTestTenant(async () => service.list(adminActor()));
      expect(listA.find((c) => c.id === b.id)).toBeUndefined();
    });
  });
});
