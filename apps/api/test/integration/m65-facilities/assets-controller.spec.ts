import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

import { FacilitiesAssetsController } from '@modules/m65-facilities/facilities-assets.controller';
import { FireDrillService } from '@modules/m65-facilities/fire-drill.service';
import { AssetService } from '@modules/m65-facilities/asset.service';
import { EnergyService } from '@modules/m65-facilities/energy.service';
import { SpaceUtilisationService } from '@modules/m65-facilities/space-utilisation.service';
import { SustainabilityService } from '@modules/m65-facilities/sustainability.service';
import {
  type ActorContextService,
  type ResolvedActor,
  PermissionCheckService,
} from '@modules/m00-platform';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import { withTestTenant } from '../helpers/tenant-context';
import { adminActor, TEST_ADMIN_ACCOUNT_ID, TEST_ADMIN_PERSON_ID } from '../helpers/actor';
import {
  resetFacilitiesTables,
  ensureFacilitiesSeed,
  TEST_BUILDING_ID,
  TEST_SPACE_ID,
  TEST_ASSET_CATEGORY_ID,
} from '../fixtures/facilities';

class StubActorContext {
  async resolveActor(): Promise<ResolvedActor> {
    return adminActor();
  }
}

describe('integration:m65-facilities/assets-controller', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let ctl: FacilitiesAssetsController;
  let req: any;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    const outbox = new OutboxService();
    const stubCtx = new StubActorContext() as unknown as ActorContextService;

    const drills = new FireDrillService(tenantPrisma, outbox, permCheck);
    const assets = new AssetService(tenantPrisma, permCheck);
    const energy = new EnergyService(tenantPrisma, permCheck);
    const utilisation = new SpaceUtilisationService(tenantPrisma, permCheck);
    const sustainability = new SustainabilityService(tenantPrisma, permCheck);

    ctl = new FacilitiesAssetsController(
      drills,
      assets,
      energy,
      utilisation,
      sustainability,
      stubCtx,
    );

    req = {
      user: {
        sub: TEST_ADMIN_ACCOUNT_ID,
        accountId: TEST_ADMIN_ACCOUNT_ID,
        personId: TEST_ADMIN_PERSON_ID,
        email: 'admin@test',
        displayName: 'Admin',
        sessionId: 'sess',
      },
    };
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetFacilitiesTables(rawClient);
    await ensureFacilitiesSeed(rawClient);
  });

  it('fire drill endpoints — create + list + get + compliance', async () => {
    const drill = await withTestTenant(async () =>
      ctl.createDrill(
        {
          buildingId: TEST_BUILDING_ID,
          drillDate: '2026-10-15',
          drillTime: '10:00',
          durationSeconds: 600,
          totalOccupants: 250,
          evacuationTimeSeconds: 220,
          targetEvacuationSeconds: 300,
        } as any,
        req,
      ),
    );
    expect(drill.buildingId).toBe(TEST_BUILDING_ID);

    const list = await withTestTenant(async () => ctl.listDrills(TEST_BUILDING_ID));
    expect(list.map((x: any) => x.id)).toContain(drill.id);

    const fetched = await withTestTenant(async () => ctl.getDrill(drill.id));
    expect(fetched.id).toBe(drill.id);

    const comp = await withTestTenant(async () => ctl.drillCompliance());
    expect(Array.isArray(comp)).toBe(true);
  });

  it('asset endpoints — categories + assets + maintenance + decommission', async () => {
    const cats = await withTestTenant(async () => ctl.listAssetCategories());
    expect(cats.map((c: any) => c.id)).toContain(TEST_ASSET_CATEGORY_ID);
    const newCat = await withTestTenant(async () =>
      ctl.createAssetCategory({ name: 'Lighting' } as any, req),
    );
    await withTestTenant(async () =>
      ctl.patchAssetCategory(newCat.id, { name: 'LED Lighting' } as any, req),
    );

    const asset = await withTestTenant(async () =>
      ctl.createAsset(
        {
          categoryId: TEST_ASSET_CATEGORY_ID,
          buildingId: TEST_BUILDING_ID,
          spaceId: TEST_SPACE_ID,
          assetTag: 'CTRL-A-1',
          name: 'Ctrl Asset',
          installDate: '2024-01-01',
          expectedLifespanYears: 10,
          replacementPriority: 'LOW',
        } as any,
        req,
      ),
    );
    const assetList = await withTestTenant(async () => ctl.listAssets());
    expect(assetList.map((x: any) => x.id)).toContain(asset.id);

    const fetched = await withTestTenant(async () => ctl.getAsset(asset.id));
    expect(fetched.id).toBe(asset.id);

    await withTestTenant(async () => ctl.patchAsset(asset.id, { name: 'Renamed' } as any, req));

    const overdue = await withTestTenant(async () => ctl.maintenanceOverdue());
    expect(Array.isArray(overdue)).toBe(true);
    const planning = await withTestTenant(async () => ctl.replacementPlanning());
    expect(Array.isArray(planning)).toBe(true);

    // Decommission flow
    await withTestTenant(async () =>
      ctl.decommissionAsset(asset.id, { reason: 'end of life' } as any, req),
    );

    const maint = await withTestTenant(async () => ctl.listMaintenance(asset.id));
    expect(Array.isArray(maint)).toBe(true);
  });

  it('energy endpoints — meters + reading + targets + trend + summary', async () => {
    const meter = await withTestTenant(async () =>
      ctl.createMeter(
        {
          buildingId: TEST_BUILDING_ID,
          meterName: 'AC Meter',
          utilityType: 'ELECTRICITY',
          unit: 'kWh',
        } as any,
        req,
      ),
    );
    const list = await withTestTenant(async () => ctl.listMeters());
    expect(list.map((m: any) => m.id)).toContain(meter.id);

    await withTestTenant(async () =>
      ctl.patchMeter(meter.id, { meterName: 'AC Meter Renamed' } as any, req),
    );

    await withTestTenant(async () =>
      ctl.recordReading(
        { meterId: meter.id, readingDate: '2026-09-15', readingValue: 2000 } as any,
        req,
      ),
    );

    const trend = await withTestTenant(async () =>
      ctl.energyTrend(meter.id, '2026-01-01', '2026-12-31'),
    );
    expect(trend).toBeTruthy();

    const summary = await withTestTenant(async () => ctl.energySummary());
    expect(Array.isArray(summary)).toBe(true);

    const targets = await withTestTenant(async () => ctl.listTargets());
    expect(Array.isArray(targets)).toBe(true);
    const t = await withTestTenant(async () =>
      ctl.createTarget(
        {
          utilityType: 'WATER',
          targetPeriod: 'ANNUAL',
          targetValue: 1000,
          academicYear: '2026-2027',
        } as any,
        req,
      ),
    );
    expect(t.utilityType).toBe('WATER');
  });
});
