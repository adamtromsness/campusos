import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

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
import { PermissionCheckService } from '@modules/m00-platform';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import { makeRecordingKafka } from '../helpers/recording-kafka';
import { withTestTenant, TEST_SCHEMA, TEST_SCHOOL_ID } from '../helpers/tenant-context';
import { adminActor, TEST_ADMIN_EMPLOYEE_ID, TEST_ADMIN_PERSON_ID } from '../helpers/actor';
import { resetItTables, ensureItSeed, TEST_ASSET_ID, TEST_LICENCE_ID } from '../fixtures/it';

describe('integration:m62-it/advanced', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let mdm: MdmService;
  let infra: InfrastructureService;
  let proc: ProcurementService;
  let devSel: DeviceSelectionService;
  let remote: RemoteActionService;
  let inventory: InventoryAuditService;
  let renewals: LicenceRenewalService;
  let usage: DeviceUsageService;
  let phone: PhoneExtensionService;
  let docs: ConfigDocumentationService;
  let monitor: MonitoringService;
  let infraExt: InfrastructureExtensionService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    const outbox = new OutboxService();
    const kafka = makeRecordingKafka();
    mdm = new MdmService(tenantPrisma, permCheck);
    infra = new InfrastructureService(tenantPrisma, permCheck);
    proc = new ProcurementService(tenantPrisma, permCheck);
    devSel = new DeviceSelectionService(tenantPrisma, permCheck);
    remote = new RemoteActionService(tenantPrisma, permCheck, outbox);
    inventory = new InventoryAuditService(tenantPrisma, permCheck);
    renewals = new LicenceRenewalService(tenantPrisma, permCheck);
    usage = new DeviceUsageService(tenantPrisma, permCheck, outbox);
    phone = new PhoneExtensionService(tenantPrisma, permCheck);
    docs = new ConfigDocumentationService(tenantPrisma, permCheck);
    monitor = new MonitoringService(tenantPrisma, permCheck, outbox);
    infraExt = new InfrastructureExtensionService(tenantPrisma, permCheck);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetItTables(rawClient);
    await ensureItSeed(rawClient);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_outbox WHERE topic LIKE 'tech.%'`,
    );
  });

  // ─── MdmService ────────────────────────────────────────
  describe('MdmService', () => {
    it('createSync + listSyncs', async () => {
      const sync = await withTestTenant(async () =>
        mdm.createSync(
          {
            assetId: TEST_ASSET_ID,
            mdmProvider: 'JAMF',
            deviceName: 'Asset-A1',
            osVersion: '14.0',
            isCompliant: true,
            complianceDetails: { policy: 'enrolled' },
          } as any,
          adminActor(),
        ),
      );
      expect(sync.mdmProvider).toBe('JAMF');
      const list = await withTestTenant(async () => mdm.listSyncs({ assetId: TEST_ASSET_ID }));
      expect(list.map((s) => s.id)).toContain(sync.id);
    });

    it('createAlert + listAlerts + resolveAlert', async () => {
      const a = await withTestTenant(async () =>
        mdm.createAlert(
          {
            assetId: TEST_ASSET_ID,
            alertType: 'STALE_CHECKIN',
            alertDetail: 'No checkin in 14 days',
          } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () => mdm.listAlerts({}));
      expect(list.map((x) => x.id)).toContain(a.id);

      const resolved = await withTestTenant(async () =>
        mdm.resolveAlert(a.id, { resolutionNotes: 'Re-enrolled device' } as any, adminActor()),
      );
      expect(resolved.isResolved).toBe(true);
    });
  });

  // ─── InfrastructureService ────────────────────────────
  describe('InfrastructureService', () => {
    it('create + list + getById + patch', async () => {
      const dto = await withTestTenant(async () =>
        infra.create(
          {
            itemName: 'Core Switch A',
            itemType: 'SWITCH',
            location: 'Server Room',
            ipAddress: '10.0.0.1',
            macAddress: '00:11:22:33:44:55',
            make: 'Cisco',
            model: 'C9300',
            serialNumber: 'SW-001',
            purchaseDate: '2024-01-01',
          } as any,
          adminActor(),
        ),
      );
      expect(dto.itemName).toBe('Core Switch A');

      const list = await withTestTenant(async () => infra.list({}));
      expect(list.map((i) => i.id)).toContain(dto.id);

      const fetched = await withTestTenant(async () => infra.getById(dto.id));
      expect(fetched.id).toBe(dto.id);

      const patched = await withTestTenant(async () =>
        infra.patch(dto.id, { status: 'MAINTENANCE' } as any, adminActor()),
      );
      expect(patched.status).toBe('MAINTENANCE');
    });

    it('list filter by itemType', async () => {
      await withTestTenant(async () =>
        infra.create(
          { itemName: 'AP-1', itemType: 'ACCESS_POINT', location: 'Building 2' } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () => infra.list({ itemType: 'ACCESS_POINT' }));
      expect(list.every((i) => i.itemType === 'ACCESS_POINT')).toBe(true);
    });
  });

  // ─── ProcurementService ──────────────────────────────
  describe('ProcurementService', () => {
    it('create + list + getById + patch + markDelivered', async () => {
      const dto = await withTestTenant(async () =>
        proc.create(
          {
            orderTitle: 'Q1 Laptops',
            orderedBy: TEST_ADMIN_EMPLOYEE_ID,
            orderDate: '2026-01-15',
            totalCost: 50000,
          } as any,
          adminActor(),
        ),
      );
      expect(dto.orderTitle).toBe('Q1 Laptops');

      const list = await withTestTenant(async () => proc.list({}));
      expect(list.map((p) => p.id)).toContain(dto.id);

      const fetched = await withTestTenant(async () => proc.getById(dto.id));
      expect(fetched.id).toBe(dto.id);

      const submitted = await withTestTenant(async () =>
        proc.patch(dto.id, { status: 'SUBMITTED' } as any, adminActor()),
      );
      expect(submitted.status).toBe('SUBMITTED');

      // Transition to ORDERED before delivery
      await withTestTenant(async () =>
        proc.patch(dto.id, { status: 'APPROVED' } as any, adminActor()),
      );
      await withTestTenant(async () =>
        proc.patch(dto.id, { status: 'ORDERED' } as any, adminActor()),
      );

      const delivered = await withTestTenant(async () =>
        proc.markDelivered(dto.id, { deliveredAt: '2026-02-01T00:00:00Z' } as any, adminActor()),
      );
      expect(delivered.status).toBe('DELIVERED');
    });

    it('list filter by status', async () => {
      await withTestTenant(async () =>
        proc.create(
          { orderTitle: 'X', orderedBy: TEST_ADMIN_EMPLOYEE_ID, orderDate: '2026-01-01' } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () => proc.list({ status: 'DRAFT' }));
      expect(list.every((p) => p.status === 'DRAFT')).toBe(true);
    });
  });

  // ─── DeviceSelectionService ──────────────────────────
  describe('DeviceSelectionService', () => {
    async function makeOption() {
      return withTestTenant(async () =>
        devSel.createOption(
          {
            optionName: 'MacBook Pro 14"',
            deviceType: 'LAPTOP',
            operatingSystem: 'macOS',
            specifications: 'M3 / 16GB / 512GB',
            costDifference: 200,
          } as any,
          adminActor(),
        ),
      );
    }

    it('createOption + listOptions + patchOption', async () => {
      const opt = await makeOption();
      const list = await withTestTenant(async () => devSel.listOptions(false));
      expect(list.map((x) => x.id)).toContain(opt.id);

      const patched = await withTestTenant(async () =>
        devSel.patchOption(opt.id, { costDifference: 300 } as any, adminActor()),
      );
      expect(Number(patched.costDifference)).toBe(300);
    });

    it('createSelection + listSelections + approveSelection', async () => {
      const opt = await makeOption();
      const sel = await withTestTenant(async () =>
        devSel.createSelection(
          {
            personId: TEST_ADMIN_PERSON_ID,
            optionId: opt.id,
            selectionContext: 'NEW_HIRE',
          } as any,
          adminActor(),
        ),
      );
      expect(sel.optionId).toBe(opt.id);

      const list = await withTestTenant(async () => devSel.listSelections({}, adminActor()));
      expect(list.map((x) => x.id)).toContain(sel.id);

      const approved = await withTestTenant(async () =>
        devSel.approveSelection(sel.id, { assetId: TEST_ASSET_ID } as any, adminActor()),
      );
      // Service flips to PROVISIONED when assetId is supplied during approval.
      expect(['APPROVED', 'PROVISIONING', 'PROVISIONED']).toContain(approved.status);
    });

    it('rejectSelection flips status', async () => {
      const opt = await makeOption();
      const sel = await withTestTenant(async () =>
        devSel.createSelection(
          {
            personId: TEST_ADMIN_PERSON_ID,
            optionId: opt.id,
            selectionContext: 'REFRESH',
          } as any,
          adminActor(),
        ),
      );
      const rejected = await withTestTenant(async () =>
        devSel.rejectSelection(sel.id, adminActor()),
      );
      expect(rejected.status).toBe('CANCELLED');
    });
  });

  // ─── RemoteActionService ────────────────────────────
  describe('RemoteActionService', () => {
    it('create + listForAsset + getById + updateStatus → emits tech.remote_action.issued', async () => {
      const action = await withTestTenant(async () =>
        remote.create(
          TEST_ASSET_ID,
          {
            actionType: 'LOCK',
            justification: 'Suspected device theft per security policy',
          } as any,
          adminActor(),
        ),
      );
      expect(action.actionType).toBe('LOCK');

      const outbox = (await rawClient.$queryRawUnsafe(
        `SELECT topic FROM platform.platform_outbox WHERE topic = 'tech.remote_action.issued'`,
      )) as Array<{ topic: string }>;
      expect(outbox.length).toBeGreaterThan(0);

      const list = await withTestTenant(async () => remote.listForAsset(TEST_ASSET_ID, adminActor()));
      expect(list.map((x) => x.id)).toContain(action.id);

      const fetched = await withTestTenant(async () => remote.getById(action.id, adminActor()));
      expect(fetched.id).toBe(action.id);

      const sent = await withTestTenant(async () =>
        remote.updateStatus(action.id, { status: 'SENT', mdmCommandRef: 'cmd-001' } as any, adminActor()),
      );
      expect(sent.status).toBe('SENT');
    });
  });

  // ─── InventoryAuditService ──────────────────────────
  describe('InventoryAuditService', () => {
    it('create + list + getById + listItems + scan + complete + report', async () => {
      const audit = await withTestTenant(async () =>
        inventory.create(
          { auditName: 'Q1 Audit', building: 'Main', auditDate: '2026-03-15' } as any,
          adminActor(),
        ),
      );

      const list = await withTestTenant(async () => inventory.list(adminActor()));
      expect(list.map((a) => a.id)).toContain(audit.id);

      const fetched = await withTestTenant(async () => inventory.getById(audit.id, adminActor()));
      expect(fetched.id).toBe(audit.id);

      // Scan an asset
      await withTestTenant(async () =>
        inventory.scan(
          audit.id,
          {
            assetTag: 'AT-A-001',
            found: true,
            conditionObserved: 'GOOD',
            locationObserved: 'Room 101',
          } as any,
          adminActor(),
        ),
      );

      const items = await withTestTenant(async () => inventory.listItems(audit.id, adminActor()));
      expect(items.length).toBe(1);

      const completed = await withTestTenant(async () => inventory.complete(audit.id, adminActor()));
      expect(completed.status).toBe('COMPLETED');

      const report = await withTestTenant(async () => inventory.report(audit.id, adminActor()));
      expect(report).toBeTruthy();
    });
  });

  // ─── LicenceRenewalService ──────────────────────────
  describe('LicenceRenewalService', () => {
    it('renew + listForLicence', async () => {
      const r = await withTestTenant(async () =>
        renewals.renew(
          TEST_LICENCE_ID,
          {
            previousExpiryDate: '2027-12-31',
            newExpiryDate: '2028-12-31',
            renewalCost: 12000,
          } as any,
          adminActor(),
        ),
      );
      expect(r.newExpiryDate).toContain('2028-12-31');

      const list = await withTestTenant(async () => renewals.listForLicence(TEST_LICENCE_ID, adminActor()));
      expect(list.map((x) => x.id)).toContain(r.id);
    });
  });

  // ─── DeviceUsageService ────────────────────────────
  describe('DeviceUsageService', () => {
    it('record + listForAsset; flagged usage → tech.usage.flagged emit', async () => {
      const r1 = await withTestTenant(async () =>
        usage.record(
          TEST_ASSET_ID,
          {
            summaryDate: '2026-03-01',
            screenTimeMinutes: 480,
            appsUsed: ['Chrome', 'Word'],
            flaggedActivity: false,
            summarySource: 'MDM_SYNC',
          } as any,
          adminActor(),
        ),
      );
      expect(r1.screenTimeMinutes).toBe(480);

      const r2 = await withTestTenant(async () =>
        usage.record(
          TEST_ASSET_ID,
          {
            summaryDate: '2026-03-02',
            screenTimeMinutes: 600,
            appsUsed: ['Suspicious App'],
            flaggedActivity: true,
            summarySource: 'MDM_SYNC',
          } as any,
          adminActor(),
        ),
      );
      expect(r2.flaggedActivity).toBe(true);

      const list = await withTestTenant(async () => usage.listForAsset(TEST_ASSET_ID, adminActor()));
      expect(list.length).toBe(2);

      const flagged = await withTestTenant(async () => usage.listFlagged(adminActor()));
      expect(flagged.length).toBeGreaterThan(0);
    });
  });

  // ─── PhoneExtensionService ────────────────────────
  describe('PhoneExtensionService', () => {
    it('create + list + getById + patch + assign + unassign', async () => {
      const ext = await withTestTenant(async () =>
        phone.create(
          {
            extensionNumber: '101',
            displayName: 'Main Office',
            location: 'Building 1',
            department: 'Admin',
            extensionType: 'OFFICE',
          } as any,
          adminActor(),
        ),
      );
      expect(ext.extensionNumber).toBe('101');

      const list = await withTestTenant(async () => phone.list(adminActor()));
      expect(list.map((x) => x.id)).toContain(ext.id);

      const fetched = await withTestTenant(async () => phone.getById(ext.id, adminActor()));
      expect(fetched.id).toBe(ext.id);

      const patched = await withTestTenant(async () =>
        phone.patch(ext.id, { displayName: 'Renamed Office' } as any, adminActor()),
      );
      expect(patched.displayName).toBe('Renamed Office');

      const assigned = await withTestTenant(async () =>
        phone.assign(ext.id, { assignedTo: TEST_ADMIN_EMPLOYEE_ID } as any, adminActor()),
      );
      expect(assigned.assignedTo).toBe(TEST_ADMIN_EMPLOYEE_ID);

      const unassigned = await withTestTenant(async () => phone.unassign(ext.id, adminActor()));
      expect(unassigned.assignedTo).toBeNull();
    });

    it('list with search filter', async () => {
      await withTestTenant(async () =>
        phone.create(
          {
            extensionNumber: '202',
            displayName: 'Cafeteria',
            location: 'Building 2',
            department: 'Food Service',
            extensionType: 'COMMON_AREA',
          } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () =>
        phone.list(adminActor(), { search: 'Cafeteria' }),
      );
      expect(list.length).toBeGreaterThan(0);
    });
  });

  // ─── ConfigDocumentationService ───────────────────
  describe('ConfigDocumentationService', () => {
    it('create + list + getById + patch', async () => {
      const doc = await withTestTenant(async () =>
        docs.create(
          {
            title: 'WiFi Setup',
            category: 'WIFI',
            contentMarkdown: '# WiFi\nSetup instructions...',
            version: 1,
          } as any,
          adminActor(),
        ),
      );
      expect(doc.title).toBe('WiFi Setup');

      const list = await withTestTenant(async () => docs.list(adminActor()));
      expect(list.map((d) => d.id)).toContain(doc.id);

      const fetched = await withTestTenant(async () => docs.getById(doc.id, adminActor()));
      expect(fetched.id).toBe(doc.id);

      const patched = await withTestTenant(async () =>
        docs.patch(doc.id, { contentMarkdown: '# WiFi v2' } as any, adminActor()),
      );
      expect(patched.contentMarkdown).toContain('v2');
    });

    it('list filter by category', async () => {
      await withTestTenant(async () =>
        docs.create(
          {
            title: 'Backup',
            category: 'BACKUP',
            contentMarkdown: 'backup docs',
            version: 1,
          } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () => docs.list(adminActor(), 'BACKUP'));
      expect(list.every((d) => d.category === 'BACKUP')).toBe(true);
    });
  });

  // ─── MonitoringService ────────────────────────────
  describe('MonitoringService', () => {
    async function makeCheck() {
      return withTestTenant(async () =>
        monitor.createCheck(
          {
            systemName: 'API Health',
            checkUrl: 'https://example.com/health',
            checkType: 'HTTP',
            intervalMinutes: 5,
            expectedStatusCode: 200,
            timeoutSeconds: 10,
            consecutiveFailuresToAlert: 3,
          } as any,
          adminActor(),
        ),
      );
    }

    it('createCheck + listChecks + getCheckById + patchCheck', async () => {
      const c = await makeCheck();
      const list = await withTestTenant(async () => monitor.listChecks(adminActor()));
      expect(list.map((x) => x.id)).toContain(c.id);

      const fetched = await withTestTenant(async () => monitor.getCheckById(c.id, adminActor()));
      expect(fetched.id).toBe(c.id);

      const patched = await withTestTenant(async () =>
        monitor.patchCheck(c.id, { intervalMinutes: 10 } as any, adminActor()),
      );
      expect(patched.intervalMinutes).toBe(10);
    });

    it('recordResult DOWN creates alert + emits outbox event', async () => {
      const c = await makeCheck();
      // Record multiple DOWN results to cross the threshold
      for (let i = 0; i < 3; i++) {
        await withTestTenant(async () =>
          monitor.recordResult(
            c.id,
            { status: 'DOWN', responseTimeMs: null, errorMessage: 'connection refused' } as any,
            adminActor(),
          ),
        );
      }

      const alerts = await withTestTenant(async () => monitor.listAlerts(adminActor(), true));
      expect(alerts.length).toBeGreaterThan(0);

      const outbox = (await rawClient.$queryRawUnsafe(
        `SELECT topic FROM platform.platform_outbox WHERE topic = 'tech.monitoring.alert'`,
      )) as Array<{ topic: string }>;
      expect(outbox.length).toBeGreaterThan(0);

      // Acknowledge alert
      const ack = await withTestTenant(async () =>
        monitor.acknowledgeAlert(alerts[0]!.id, { notes: 'Investigating' } as any, adminActor()),
      );
      expect(ack.acknowledgedAt).not.toBeNull();
    });

    it('listAlerts activeOnly=false returns all', async () => {
      const list = await withTestTenant(async () => monitor.listAlerts(adminActor(), false));
      expect(Array.isArray(list)).toBe(true);
    });
  });

  // ─── InfrastructureExtensionService ───────────────
  describe('InfrastructureExtensionService', () => {
    it('warrantyExpiring returns rows; markChecked + patch', async () => {
      const item = await withTestTenant(async () =>
        infra.create(
          {
            itemName: 'Aging UPS',
            itemType: 'UPS',
            location: 'Server Room',
            warrantyExpiry: '2026-08-01',
          } as any,
          adminActor(),
        ),
      );
      const exp = await withTestTenant(async () => infraExt.warrantyExpiring(adminActor(), 365));
      expect(Array.isArray(exp)).toBe(true);

      const marked = await withTestTenant(async () => infraExt.markChecked(item.id, adminActor()));
      expect(marked.id).toBe(item.id);

      const patched = await withTestTenant(async () =>
        infraExt.patch(item.id, { notes: 'Checked OK' } as any, adminActor()),
      );
      expect(patched.id).toBe(item.id);
    });
  });
});
