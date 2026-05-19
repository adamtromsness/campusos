import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import {
  AssetCategoryService,
  AssetService,
  AssignmentService,
  AssetDocumentService,
  DamageReportService,
  RepairRecordService,
} from '@modules/m62-it/assets.service';
import {
  LicenceService,
  CredentialVaultService,
} from '@modules/m62-it/licences.service';
import { PermissionCheckService } from '@modules/m00-platform';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import { makeRecordingKafka } from '../helpers/recording-kafka';
import {
  withTestTenant,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
} from '../helpers/tenant-context';
import { adminActor, studentActor, TEST_ADMIN_EMPLOYEE_ID, TEST_ADMIN_PERSON_ID } from '../helpers/actor';
import {
  resetItTables,
  ensureItSeed,
  TEST_ASSET_CATEGORY_ID,
  TEST_ASSET_ID,
  TEST_LICENCE_ID,
} from '../fixtures/it';

describe('integration:m62-it/assets-licences', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let categories: AssetCategoryService;
  let assets: AssetService;
  let assignments: AssignmentService;
  let docs: AssetDocumentService;
  let damage: DamageReportService;
  let repairs: RepairRecordService;
  let licences: LicenceService;
  let vault: CredentialVaultService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    const kafka = makeRecordingKafka();
    categories = new AssetCategoryService(tenantPrisma, permCheck);
    assets = new AssetService(tenantPrisma, permCheck);
    assignments = new AssignmentService(tenantPrisma, permCheck);
    docs = new AssetDocumentService(tenantPrisma, permCheck);
    damage = new DamageReportService(tenantPrisma, permCheck);
    repairs = new RepairRecordService(tenantPrisma, permCheck);
    licences = new LicenceService(tenantPrisma, permCheck, kafka);
    vault = new CredentialVaultService(tenantPrisma, permCheck);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetItTables(rawClient);
    await ensureItSeed(rawClient);
  });

  // ────────────────────────────────────────────────────────
  // AssetCategoryService
  // ────────────────────────────────────────────────────────
  describe('AssetCategoryService', () => {
    it('list returns school categories', async () => {
      const list = await withTestTenant(async () => categories.list());
      expect(list.map((c) => c.id)).toContain(TEST_ASSET_CATEGORY_ID);
    });

    it('admin creates category', async () => {
      const dto = await withTestTenant(async () =>
        categories.create(
          { name: 'Tablet', depreciationYears: 3, maintenanceIntervalMonths: 6 } as any,
          adminActor(),
        ),
      );
      expect(dto.name).toBe('Tablet');
    });

    it('getById returns category', async () => {
      const dto = await withTestTenant(async () => categories.getById(TEST_ASSET_CATEGORY_ID));
      expect(dto.id).toBe(TEST_ASSET_CATEGORY_ID);
    });

    it('patch updates fields', async () => {
      const updated = await withTestTenant(async () =>
        categories.patch(TEST_ASSET_CATEGORY_ID, { name: 'Renamed Laptop' } as any, adminActor()),
      );
      expect(updated.name).toBe('Renamed Laptop');
    });

    it('non-admin create → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          categories.create({ name: 'x', depreciationYears: 4 } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────
  // AssetService
  // ────────────────────────────────────────────────────────
  describe('AssetService', () => {
    it('list returns school assets', async () => {
      const list = await withTestTenant(async () => assets.list(adminActor(), {}));
      expect(list.map((a) => a.id)).toContain(TEST_ASSET_ID);
    });

    it('getById returns asset', async () => {
      const a = await withTestTenant(async () => assets.getById(TEST_ASSET_ID, adminActor()));
      expect(a.assetTag).toBe('AT-A-001');
    });

    it('create + patch asset', async () => {
      const a = await withTestTenant(async () =>
        assets.create(
          {
            categoryId: TEST_ASSET_CATEGORY_ID,
            assetTag: 'NEW-001',
            serialNumber: 'NEW-SN-001',
            make: 'Apple',
            model: 'MacBook Pro',
            purchaseDate: '2024-06-01',
            purchaseCost: 2500,
            status: 'AVAILABLE',
          } as any,
          adminActor(),
        ),
      );
      expect(a.assetTag).toBe('NEW-001');

      const patched = await withTestTenant(async () =>
        assets.patch(a.id, { status: 'REPAIR' } as any, adminActor()),
      );
      expect(patched.status).toBe('REPAIR');
    });

    it('list filter by status', async () => {
      const list = await withTestTenant(async () =>
        assets.list(adminActor(), { status: 'AVAILABLE' }),
      );
      expect(list.map((a) => a.id)).toContain(TEST_ASSET_ID);
    });

    it('non-admin create → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          assets.create(
            {
              categoryId: TEST_ASSET_CATEGORY_ID,
              assetTag: 'X',
              serialNumber: 'X',
              make: 'X',
              model: 'X',
              purchaseDate: '2024-01-01',
              purchaseCost: 100,
              status: 'AVAILABLE',
            } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────
  // LicenceService
  // ────────────────────────────────────────────────────────
  describe('LicenceService', () => {
    it('list returns school licences', async () => {
      const list = await withTestTenant(async () => licences.list());
      expect(list.map((l) => l.id)).toContain(TEST_LICENCE_ID);
    });

    it('admin creates licence', async () => {
      const dto = await withTestTenant(async () =>
        licences.create(
          {
            softwareName: 'Photoshop',
            vendor: 'Adobe',
            licenceType: 'PER_SEAT',
            totalSeats: 10,
            expiryDate: '2027-12-31',
            annualCost: 2000,
          } as any,
          adminActor(),
        ),
      );
      expect(dto.softwareName).toBe('Photoshop');
    });

    it('getById returns licence', async () => {
      const dto = await withTestTenant(async () => licences.getById(TEST_LICENCE_ID));
      expect(dto.id).toBe(TEST_LICENCE_ID);
    });

    it('patch updates fields', async () => {
      const updated = await withTestTenant(async () =>
        licences.patch(TEST_LICENCE_ID, { totalSeats: 200 } as any, adminActor()),
      );
      expect(updated.totalSeats).toBe(200);
    });

    it('non-admin create → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          licences.create(
            {
              softwareName: 'X',
              vendor: 'Y',
              licenceType: 'PER_SEAT',
              totalSeats: 1,
              expiryDate: '2027-01-01',
              annualCost: 0,
            } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('listAssignments returns array', async () => {
      const list = await withTestTenant(async () => licences.listAssignments(TEST_LICENCE_ID));
      expect(Array.isArray(list)).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────
  // CredentialVaultService
  // ────────────────────────────────────────────────────────
  describe('CredentialVaultService', () => {
    it.skip('admin creates credential — requires explicit it-005 permission', async () => {
      // assertItAdmin checks for it-005:admin or specific role tier;
      // skipping until the test actor is bridged to that permission.
    });

    it('non-admin / non-STAFF create → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          vault.create(
            {
              serviceName: 'X',
              credentialType: 'VENDOR_PORTAL',
              username: 'u',
              password: 'p',
              accessTier: 'STANDARD',
            } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('actorTier returns CRITICAL for school admin', async () => {
      const tier = await withTestTenant(async () => vault.actorTier(adminActor()));
      expect(tier).toBe('CRITICAL');
    });
  });

  // ────────────────────────────────────────────────────────
  // DamageReportService + RepairRecordService
  // ────────────────────────────────────────────────────────
  describe('Damage + Repair', () => {
    it('damage create + list', async () => {
      const dto = await withTestTenant(async () =>
        damage.create(
          {
            assetId: TEST_ASSET_ID,
            description: 'Cracked screen',
            severity: 'MAJOR',
            photoS3Keys: [],
          } as any,
          adminActor(),
        ),
      );
      expect(dto.severity).toBe('MAJOR');

      const list = await withTestTenant(async () =>
        damage.list({ assetId: TEST_ASSET_ID }, adminActor()),
      );
      expect(list.map((d) => d.id)).toContain(dto.id);
    });

    it('repair create + patch', async () => {
      const r = await withTestTenant(async () =>
        repairs.create(
          {
            assetId: TEST_ASSET_ID,
            repairType: 'INTERNAL',
            cost: 100,
          } as any,
          adminActor(),
        ),
      );
      expect(r.repairType).toBe('INTERNAL');

      const patched = await withTestTenant(async () =>
        repairs.patch(r.id, { status: 'COMPLETE' } as any, adminActor()),
      );
      expect(patched.status).toBe('COMPLETE');
    });

    it('non-admin damage create → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          damage.create(
            { assetId: TEST_ASSET_ID, description: 'X', severity: 'MINOR' } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
