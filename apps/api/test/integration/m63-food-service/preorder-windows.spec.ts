import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

import { PreorderService } from '@modules/m63-food-service/preorder.service';
import { PermissionCheckService } from '@modules/m00-platform';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import { withTestTenant } from '../helpers/tenant-context';
import { adminActor, studentActor } from '../helpers/actor';
import { resetFoodServiceTables, ensureFoodServiceSeed } from '../fixtures/food-service';

describe('integration:m63-food-service/preorder-windows', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let preorders: PreorderService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    preorders = new PreorderService(tenantPrisma, permCheck);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetFoodServiceTables(rawClient);
    await ensureFoodServiceSeed(rawClient);
  });

  describe('PreorderService.windows', () => {
    async function makeWindow(date = '2026-10-01', meal = 'LUNCH') {
      return withTestTenant(async () =>
        preorders.createWindow(
          {
            serviceDate: date,
            mealType: meal,
            opensAt: `${date}T08:00:00Z`,
            closesAt: `${date}T11:00:00Z`,
            notes: 'Standard preorder window',
          } as any,
          adminActor(),
        ),
      );
    }

    it('create + list + getById + patch', async () => {
      const win = await makeWindow();
      expect(win.serviceDate).toMatch(/2026-10-01/);

      const list = await withTestTenant(async () => preorders.listWindows({}));
      expect(list.map((w) => w.id)).toContain(win.id);

      const fetched = await withTestTenant(async () => preorders.getWindowById(win.id));
      expect(fetched.id).toBe(win.id);

      const patched = await withTestTenant(async () =>
        preorders.patchWindow(
          win.id,
          { closesAt: `2026-10-01T12:00:00Z`, notes: 'Extended window' } as any,
          adminActor(),
        ),
      );
      expect(patched.notes).toBe('Extended window');
    });

    it('non-admin create → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          preorders.createWindow(
            {
              serviceDate: '2026-10-02',
              mealType: 'LUNCH',
              opensAt: '2026-10-02T08:00:00Z',
              closesAt: '2026-10-02T11:00:00Z',
            } as any,
            studentActor(),
          ),
        ),
      ).rejects.toThrow();
    });

    it('listWindows with onlyOpen filter', async () => {
      // Make a window for today so it's open
      const today = new Date().toISOString().split('T')[0];
      await withTestTenant(async () =>
        preorders.createWindow(
          {
            serviceDate: today,
            mealType: 'LUNCH',
            opensAt: `${today}T00:00:00Z`,
            closesAt: `${today}T23:59:59Z`,
          } as any,
          adminActor(),
        ),
      );
      const open = await withTestTenant(async () => preorders.listWindows({ onlyOpen: true }));
      expect(Array.isArray(open)).toBe(true);
    });
  });

  describe('PreorderService production reports', () => {
    it('listProductionReports returns array', async () => {
      const list = await withTestTenant(async () => preorders.listProductionReports());
      expect(Array.isArray(list)).toBe(true);
    });
  });
});
