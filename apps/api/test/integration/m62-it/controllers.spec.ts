import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

import { ItController } from '@modules/m62-it/it.controller';
import { ItAdvancedController } from '@modules/m62-it/it-advanced.controller';
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
import {
  MdmService,
  InfrastructureService,
  ProcurementService,
  DeviceSelectionService,
} from '@modules/m62-it/mdm.service';
import {
  RemoteActionService,
  InventoryAuditService,
  LicenceRenewalService,
  DeviceUsageService,
} from '@modules/m62-it/remote-actions.service';
import {
  PhoneExtensionService,
  ConfigDocumentationService,
  MonitoringService,
  InfrastructureExtensionService,
} from '@modules/m62-it/voip-monitoring.service';
import {
  type ActorContextService,
  type ResolvedActor,
  PermissionCheckService,
} from '@modules/m00-platform';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import { makeRecordingKafka } from '../helpers/recording-kafka';
import { withTestTenant } from '../helpers/tenant-context';
import {
  adminActor,
  TEST_ADMIN_ACCOUNT_ID,
  TEST_ADMIN_PERSON_ID,
  TEST_ADMIN_EMPLOYEE_ID,
} from '../helpers/actor';
import {
  resetItTables,
  ensureItSeed,
  TEST_ASSET_CATEGORY_ID,
  TEST_ASSET_ID,
  TEST_LICENCE_ID,
} from '../fixtures/it';

class StubActorContext {
  async resolveActor(): Promise<ResolvedActor> {
    return adminActor();
  }
}

describe('integration:m62-it/controllers', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let itCtl: ItController;
  let advCtl: ItAdvancedController;
  let req: any;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    const outbox = new OutboxService();
    const kafka = makeRecordingKafka();
    const stubCtx = new StubActorContext() as unknown as ActorContextService;

    const categories = new AssetCategoryService(tenantPrisma, permCheck);
    const assetsSvc = new AssetService(tenantPrisma, permCheck);
    const assignments = new AssignmentService(tenantPrisma, permCheck);
    const docs = new AssetDocumentService(tenantPrisma, permCheck);
    const damages = new DamageReportService(tenantPrisma, permCheck);
    const repairs = new RepairRecordService(tenantPrisma, permCheck);
    const licences = new LicenceService(tenantPrisma, permCheck, kafka);
    const vault = new CredentialVaultService(tenantPrisma, permCheck);
    const mdmSvc = new MdmService(tenantPrisma, permCheck);
    const infraSvc = new InfrastructureService(tenantPrisma, permCheck);
    const procSvc = new ProcurementService(tenantPrisma, permCheck);
    const selSvc = new DeviceSelectionService(tenantPrisma, permCheck);
    const remoteSvc = new RemoteActionService(tenantPrisma, permCheck, outbox);
    const inventSvc = new InventoryAuditService(tenantPrisma, permCheck);
    const renSvc = new LicenceRenewalService(tenantPrisma, permCheck);
    const usageSvc = new DeviceUsageService(tenantPrisma, permCheck, outbox);
    const extSvc = new PhoneExtensionService(tenantPrisma, permCheck);
    const docsSvc = new ConfigDocumentationService(tenantPrisma, permCheck);
    const monSvc = new MonitoringService(tenantPrisma, permCheck, outbox);
    const infraExtSvc = new InfrastructureExtensionService(tenantPrisma, permCheck);

    itCtl = new ItController(
      categories,
      assetsSvc,
      assignments,
      docs,
      damages,
      repairs,
      licences,
      vault,
      mdmSvc,
      infraSvc,
      procSvc,
      selSvc,
      stubCtx,
    );
    advCtl = new ItAdvancedController(
      remoteSvc,
      inventSvc,
      renSvc,
      usageSvc,
      extSvc,
      docsSvc,
      monSvc,
      infraExtSvc,
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
    await resetItTables(rawClient);
    await ensureItSeed(rawClient);
  });

  // ─── ItController — Asset endpoints ────────────────
  describe('ItController', () => {
    it('asset category endpoints', async () => {
      const list = await withTestTenant(async () => itCtl.listCategories());
      expect(list.length).toBeGreaterThan(0);
      const created = await withTestTenant(async () =>
        itCtl.createCategory({ name: 'Test Cat', depreciationYears: 3 } as any, req),
      );
      expect(created.name).toBe('Test Cat');
      const patched = await withTestTenant(async () =>
        itCtl.patchCategory(created.id, { name: 'Renamed Cat' } as any, req),
      );
      expect(patched.name).toBe('Renamed Cat');
    });

    it('asset endpoints', async () => {
      const list = await withTestTenant(async () => itCtl.listAssets(req));
      expect(list.length).toBeGreaterThan(0);
      const asset = await withTestTenant(async () => itCtl.getAsset(TEST_ASSET_ID, req));
      expect(asset.id).toBe(TEST_ASSET_ID);

      const created = await withTestTenant(async () =>
        itCtl.createAsset(
          {
            categoryId: TEST_ASSET_CATEGORY_ID,
            assetTag: 'TEST-001',
            serialNumber: 'TEST-SN-001',
            make: 'Dell',
            model: 'XPS',
            purchaseDate: '2024-06-01',
            purchaseCost: 1500,
            status: 'AVAILABLE',
          } as any,
          req,
        ),
      );
      expect(created.assetTag).toBe('TEST-001');

      const patched = await withTestTenant(async () =>
        itCtl.patchAsset(created.id, { status: 'REPAIR' } as any, req),
      );
      expect(patched.status).toBe('REPAIR');
    });

    it('licence endpoints', async () => {
      const list = await withTestTenant(async () => itCtl.listLicences());
      expect(list.map((l: any) => l.id)).toContain(TEST_LICENCE_ID);
      const lic = await withTestTenant(async () => itCtl.getLicence(TEST_LICENCE_ID));
      expect(lic.id).toBe(TEST_LICENCE_ID);

      const created = await withTestTenant(async () =>
        itCtl.createLicence(
          {
            softwareName: 'Slack',
            vendor: 'Salesforce',
            licenceType: 'PER_SEAT',
            totalSeats: 50,
            expiryDate: '2027-12-31',
            annualCost: 5000,
          } as any,
          req,
        ),
      );
      expect(created.softwareName).toBe('Slack');

      const patched = await withTestTenant(async () =>
        itCtl.patchLicence(TEST_LICENCE_ID, { totalSeats: 150 } as any, req),
      );
      expect(patched.totalSeats).toBe(150);
    });

    it('damage + repair endpoints', async () => {
      const dmg = await withTestTenant(async () =>
        itCtl.createDamage(
          { assetId: TEST_ASSET_ID, description: 'Test damage', severity: 'MINOR', photoS3Keys: [] } as any,
          req,
        ),
      );
      expect(dmg.severity).toBe('MINOR');
      const dmgList = await withTestTenant(async () => itCtl.listDamage(req));
      expect(dmgList.map((d: any) => d.id)).toContain(dmg.id);

      const rep = await withTestTenant(async () =>
        itCtl.createRepair(
          { assetId: TEST_ASSET_ID, repairType: 'INTERNAL', cost: 50 } as any,
          req,
        ),
      );
      expect(rep.repairType).toBe('INTERNAL');
    });

    it('infrastructure endpoints', async () => {
      const created = await withTestTenant(async () =>
        itCtl.createInfrastructure(
          { itemName: 'Test Switch', itemType: 'SWITCH', location: 'Server Room' } as any,
          req,
        ),
      );
      expect(created.itemName).toBe('Test Switch');
      const list = await withTestTenant(async () => itCtl.listInfrastructure());
      expect(list.map((i: any) => i.id)).toContain(created.id);
      const fetched = await withTestTenant(async () => itCtl.getInfrastructure(created.id));
      expect(fetched.id).toBe(created.id);
      const patched = await withTestTenant(async () =>
        itCtl.patchInfrastructure(created.id, { status: 'MAINTENANCE' } as any, req),
      );
      expect(patched.status).toBe('MAINTENANCE');
    });

    it('procurement endpoints', async () => {
      const created = await withTestTenant(async () =>
        itCtl.createProcurement(
          {
            orderTitle: 'Test Order',
            orderedBy: TEST_ADMIN_EMPLOYEE_ID,
            orderDate: '2026-01-15',
            totalCost: 1000,
          } as any,
          req,
        ),
      );
      const list = await withTestTenant(async () => itCtl.listProcurement());
      expect(list.map((p: any) => p.id)).toContain(created.id);
      const fetched = await withTestTenant(async () => itCtl.getProcurement(created.id));
      expect(fetched.id).toBe(created.id);
      const patched = await withTestTenant(async () =>
        itCtl.patchProcurement(created.id, { status: 'SUBMITTED' } as any, req),
      );
      expect(patched.status).toBe('SUBMITTED');
    });

    it('device selection endpoints', async () => {
      const opt = await withTestTenant(async () =>
        itCtl.createDeviceOption(
          { optionName: 'Test Option', deviceType: 'LAPTOP', operatingSystem: 'macOS' } as any,
          req,
        ),
      );
      const optList = await withTestTenant(async () => itCtl.listDeviceOptions());
      expect(optList.map((o: any) => o.id)).toContain(opt.id);
      const optPatched = await withTestTenant(async () =>
        itCtl.patchDeviceOption(opt.id, { specifications: 'M3 / 32GB' } as any, req),
      );
      expect(optPatched.id).toBe(opt.id);

      const sel = await withTestTenant(async () =>
        itCtl.createSelection(
          {
            personId: TEST_ADMIN_PERSON_ID,
            optionId: opt.id,
            selectionContext: 'ENROLMENT',
          } as any,
          req,
        ),
      );
      const selList = await withTestTenant(async () => itCtl.listSelections(req));
      expect(selList.map((s: any) => s.id)).toContain(sel.id);
    });

    it('mdm endpoints (alerts only)', async () => {
      const a = await withTestTenant(async () =>
        itCtl.createMdmAlert(
          { assetId: TEST_ASSET_ID, alertType: 'STALE_CHECKIN', alertDetail: 'Old' } as any,
          req,
        ),
      );
      const alerts = await withTestTenant(async () => itCtl.listMdmAlerts());
      expect(alerts.map((x: any) => x.id)).toContain(a.id);
      const resolved = await withTestTenant(async () =>
        itCtl.resolveMdmAlert(a.id, { resolutionNotes: 'Done' } as any, req),
      );
      expect(resolved.isResolved).toBe(true);
    });
  });

  // ─── ItAdvancedController endpoints ────────────────
  describe('ItAdvancedController', () => {
    it('remote action endpoints', async () => {
      const r = await withTestTenant(async () =>
        advCtl.createRemoteAction(
          TEST_ASSET_ID,
          { actionType: 'LOCK', justification: 'Test reason for remote lock action' } as any,
          req,
        ),
      );
      const list = await withTestTenant(async () => advCtl.listRemoteActions(TEST_ASSET_ID, req));
      expect(list.map((x: any) => x.id)).toContain(r.id);
      const updated = await withTestTenant(async () =>
        advCtl.updateRemoteActionStatus(r.id, { status: 'SENT' } as any, req),
      );
      expect(updated.status).toBe('SENT');
    });

    it('inventory audit endpoints', async () => {
      const audit = await withTestTenant(async () =>
        advCtl.createAudit(
          { auditName: 'Q2', building: 'Main', auditDate: '2026-06-15' } as any,
          req,
        ),
      );
      const list = await withTestTenant(async () => advCtl.listAudits(req));
      expect(list.map((a: any) => a.id)).toContain(audit.id);
      const fetched = await withTestTenant(async () => advCtl.getAudit(audit.id, req));
      expect(fetched.id).toBe(audit.id);
      await withTestTenant(async () =>
        advCtl.scanAuditItem(
          audit.id,
          { assetTag: 'AT-A-001', found: true, conditionObserved: 'GOOD' } as any,
          req,
        ),
      );
      const items = await withTestTenant(async () => advCtl.listAuditItems(audit.id, req));
      expect(items.length).toBe(1);
      await withTestTenant(async () => advCtl.completeAudit(audit.id, req));
      const report = await withTestTenant(async () => advCtl.auditReport(audit.id, req));
      expect(report).toBeTruthy();
    });

    it('licence renewal endpoints', async () => {
      const r = await withTestTenant(async () =>
        advCtl.renewLicence(
          TEST_LICENCE_ID,
          {
            previousExpiryDate: '2027-12-31',
            newExpiryDate: '2028-12-31',
            renewalCost: 12000,
          } as any,
          req,
        ),
      );
      const list = await withTestTenant(async () =>
        advCtl.listRenewals(TEST_LICENCE_ID, req),
      );
      expect(list.map((x: any) => x.id)).toContain(r.id);
    });

    it('device usage endpoints', async () => {
      await withTestTenant(async () =>
        advCtl.recordUsage(
          TEST_ASSET_ID,
          {
            summaryDate: '2026-03-01',
            screenTimeMinutes: 300,
            appsUsed: ['Chrome'],
            flaggedActivity: false,
            summarySource: 'MDM_SYNC',
          } as any,
          req,
        ),
      );
      const list = await withTestTenant(async () => advCtl.listUsage(TEST_ASSET_ID, req));
      expect(list.length).toBe(1);
      const flagged = await withTestTenant(async () => advCtl.listFlaggedUsage(req));
      expect(Array.isArray(flagged)).toBe(true);
    });

    it('phone extension endpoints', async () => {
      const ext = await withTestTenant(async () =>
        advCtl.createExtension(
          {
            extensionNumber: '300',
            displayName: 'Office',
            extensionType: 'DESK',
          } as any,
          req,
        ),
      );
      const list = await withTestTenant(async () => advCtl.listExtensions(req));
      expect(list.map((e: any) => e.id)).toContain(ext.id);
      const fetched = await withTestTenant(async () => advCtl.getExtension(ext.id, req));
      expect(fetched.id).toBe(ext.id);
      const patched = await withTestTenant(async () =>
        advCtl.patchExtension(ext.id, { displayName: 'Renamed' } as any, req),
      );
      expect(patched.displayName).toBe('Renamed');
      await withTestTenant(async () =>
        advCtl.assignExtension(ext.id, { assignedTo: TEST_ADMIN_EMPLOYEE_ID } as any, req),
      );
      await withTestTenant(async () => advCtl.unassignExtension(ext.id, req));
    });

    it('config doc endpoints', async () => {
      const doc = await withTestTenant(async () =>
        advCtl.createDoc(
          {
            title: 'Config 1',
            category: 'NETWORK_TOPOLOGY',
            contentMarkdown: '# Network',
            version: 1,
          } as any,
          req,
        ),
      );
      const list = await withTestTenant(async () => advCtl.listDocs(req));
      expect(list.map((d: any) => d.id)).toContain(doc.id);
      const fetched = await withTestTenant(async () => advCtl.getDoc(doc.id, req));
      expect(fetched.id).toBe(doc.id);
      const patched = await withTestTenant(async () =>
        advCtl.patchDoc(doc.id, { contentMarkdown: '# Network v2' } as any, req),
      );
      expect(patched.contentMarkdown).toContain('v2');
    });

    it('monitoring endpoints', async () => {
      const c = await withTestTenant(async () =>
        advCtl.createMonitoringCheck(
          {
            systemName: 'Demo',
            checkUrl: 'https://demo.test/health',
            checkType: 'HTTP',
            intervalMinutes: 5,
            expectedStatusCode: 200,
            timeoutSeconds: 10,
            consecutiveFailuresToAlert: 3,
          } as any,
          req,
        ),
      );
      const list = await withTestTenant(async () => advCtl.listMonitoringChecks(req));
      expect(list.map((x: any) => x.id)).toContain(c.id);
      const fetched = await withTestTenant(async () => advCtl.getMonitoringCheck(c.id, req));
      expect(fetched.id).toBe(c.id);
      const patched = await withTestTenant(async () =>
        advCtl.patchMonitoringCheck(c.id, { intervalMinutes: 10 } as any, req),
      );
      expect(patched.intervalMinutes).toBe(10);
      await withTestTenant(async () =>
        advCtl.recordCheckResult(c.id, { status: 'HEALTHY', responseTimeMs: 50 } as any, req),
      );
      const alerts = await withTestTenant(async () => advCtl.listMonitoringAlerts(req));
      expect(Array.isArray(alerts)).toBe(true);
    });

    it('infrastructure extension endpoints', async () => {
      const item = await withTestTenant(async () =>
        itCtl.createInfrastructure(
          { itemName: 'Test UPS', itemType: 'UPS', location: 'Room A', warrantyExpiry: '2027-01-01' } as any,
          req,
        ),
      );
      const exp = await withTestTenant(async () => advCtl.warrantyExpiring(req, 730));
      expect(Array.isArray(exp)).toBe(true);
      await withTestTenant(async () => advCtl.markInfrastructureChecked(item.id, req));
      await withTestTenant(async () =>
        advCtl.patchInfrastructure(item.id, { notes: 'OK' } as any, req),
      );
    });
  });
});
