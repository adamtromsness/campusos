import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { runWithTenantContext } from '../tenant/tenant.context';
import { PERMISSIONS_KEY } from '../auth/require-permission.decorator';
import { ItAdvancedController } from './it-advanced.controller';
import {
  DeviceUsageService,
  InventoryAuditService,
  LicenceRenewalService,
  RemoteActionService,
} from './remote-actions.service';
import {
  ConfigDocumentationService,
  MonitoringService,
  PhoneExtensionService,
} from './voip-monitoring.service';

/*
 * P2-20a — IT Advanced unit tests.
 *
 * Covers the structural keystones documented in the cycle plan:
 *   - RemoteActionService.create rejects justification < 20 chars
 *     and refuses non-IT-admin actors.
 *   - RemoteActionService.updateStatus on WIPE + COMPLETED issues the
 *     atomic tech_assets.status flip to AVAILABLE inside one tenant
 *     tx, and rejects terminal-state mutations.
 *   - LicenceRenewalService.renew updates both rows atomically and
 *     rejects backwards date.
 *   - MonitoringService.recordResult crosses the configured threshold
 *     to create a tech_monitoring_alerts row and emits
 *     tech.monitoring.alert via the producer; HEALTHY recovery
 *     resolves the active alert.
 *   - DeviceUsageService.record with flagged_activity=true emits
 *     tech.usage.flagged.
 *   - ItAdvancedController @RequirePermission metadata pins the
 *     gates documented in the plan.
 */

const SCHOOL = { schoolId: '019e0cf8-bbb8-7556-8c81-aaaaaaaaaaaa', subdomain: 'demo' } as never;
const ADMIN_ACTOR = {
  accountId: '019e0cf8-bbb8-7556-8c81-a0000000a001',
  personId: '019e0cf8-bbb8-7556-8c81-a0000000a002',
  employeeId: '019e0cf8-bbb8-7556-8c81-a0000000a003',
  personType: 'STAFF' as const,
  isSchoolAdmin: true,
} as never;
const TEACHER_ACTOR = {
  accountId: '019e0cf8-bbb8-7556-8c81-b0000000b001',
  personId: '019e0cf8-bbb8-7556-8c81-b0000000b002',
  employeeId: '019e0cf8-bbb8-7556-8c81-b0000000b003',
  personType: 'STAFF' as const,
  isSchoolAdmin: false,
} as never;

interface CapturedCall {
  sql: string;
  args: unknown[];
  fn: 'q' | 'e';
}

function makeFake(handler: (call: CapturedCall) => unknown) {
  const capture: CapturedCall[] = [];
  const client = {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      capture.push({ sql, args, fn: 'q' });
      return handler({ sql, args, fn: 'q' }) ?? [];
    },
    $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
      capture.push({ sql, args, fn: 'e' });
      return handler({ sql, args, fn: 'e' }) ?? 0;
    },
  };
  const tenantPrisma = {
    executeInTenantContext: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
    executeInTenantTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
  };
  return { capture, tenantPrisma };
}

function makePermCheck(returnTrue: boolean) {
  return {
    hasAnyPermissionInTenant: async () => returnTrue,
  };
}

function makeKafka() {
  const emitted: Array<{
    topic: string;
    key: string;
    sourceModule: string;
    payload: Record<string, unknown>;
  }> = [];
  const kafka = {
    emit: async (opts: {
      topic: string;
      key: string;
      sourceModule: string;
      payload: Record<string, unknown>;
    }) => {
      emitted.push({
        topic: opts.topic,
        key: opts.key,
        sourceModule: opts.sourceModule,
        payload: opts.payload,
      });
    },
  };
  return { kafka, emitted };
}

describe('RemoteActionService — IMMUTABLE remote MDM actions', () => {
  it('create() rejects justification shorter than 20 trimmed chars', async () => {
    const fake = makeFake(() => [{ id: 'a1', asset_tag: 'IT-001' }]);
    const { kafka } = makeKafka();
    const svc = new RemoteActionService(
      fake.tenantPrisma as never,
      makePermCheck(true) as never,
      kafka as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.create(
          '019e1000-0000-7000-8000-000000000001',
          {
            actionType: 'LOCK',
            justification: 'too short',
          },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create() emits tech.remote_action.issued AFTER tx commits with full payload', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('SELECT id::text AS id, asset_tag')) {
        return [{ id: '019e1000-0000-7000-8000-000000000001', asset_tag: 'IT-CB-001' }];
      }
      if (call.sql.startsWith('INSERT INTO tech_remote_actions')) return 1;
      // The reload via SELECT_BASE
      if (call.sql.includes('FROM tech_remote_actions r')) {
        return [
          {
            id: '019e1111-1111-7000-8000-000000000001',
            asset_id: '019e1000-0000-7000-8000-000000000001',
            asset_tag: 'IT-CB-001',
            action_type: 'LOCK',
            initiated_by: ADMIN_ACTOR.personId,
            initiated_by_first: 'Sarah',
            initiated_by_last: 'Mitchell',
            initiated_at: '2026-05-12T12:00:00Z',
            justification: 'Student reported iPad lost at bus stop, locking now',
            mdm_command_ref: null,
            status: 'PENDING',
            completed_at: null,
            failure_reason: null,
          },
        ];
      }
      return [];
    });
    const { kafka, emitted } = makeKafka();
    const svc = new RemoteActionService(
      fake.tenantPrisma as never,
      makePermCheck(true) as never,
      kafka as never,
    );
    const result = await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.create(
        '019e1000-0000-7000-8000-000000000001',
        {
          actionType: 'LOCK',
          justification: 'Student reported iPad lost at bus stop, locking now',
        },
        ADMIN_ACTOR,
      ),
    );
    expect(result.status).toBe('PENDING');
    expect(result.actionType).toBe('LOCK');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.topic).toBe('tech.remote_action.issued');
    expect(emitted[0]!.sourceModule).toBe('it');
    expect(emitted[0]!.payload.assetTag).toBe('IT-CB-001');
    expect(emitted[0]!.payload.actionType).toBe('LOCK');
    expect(emitted[0]!.payload.schoolId).toBe(SCHOOL.schoolId);
  });

  it('updateStatus() on WIPE + COMPLETED issues UPDATE on tech_assets to AVAILABLE in the same tx', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM tech_remote_actions WHERE id = $1::uuid FOR UPDATE')) {
        return [
          {
            id: '019e1111-1111-7000-8000-000000000001',
            asset_id: '019e1000-0000-7000-8000-000000000001',
            action_type: 'WIPE',
            status: 'PENDING',
          },
        ];
      }
      if (call.sql.startsWith('UPDATE tech_remote_actions')) return 1;
      if (call.sql.startsWith("UPDATE tech_assets SET status = 'AVAILABLE'")) return 1;
      // post-reload
      if (call.sql.includes('FROM tech_remote_actions r')) {
        return [
          {
            id: '019e1111-1111-7000-8000-000000000001',
            asset_id: '019e1000-0000-7000-8000-000000000001',
            asset_tag: 'IT-CB-001',
            action_type: 'WIPE',
            initiated_by: ADMIN_ACTOR.personId,
            initiated_by_first: 'Sarah',
            initiated_by_last: 'Mitchell',
            initiated_at: '2026-05-12T12:00:00Z',
            justification: 'reset device for redeployment to new hire next week',
            mdm_command_ref: 'mdm-1',
            status: 'COMPLETED',
            completed_at: '2026-05-12T12:01:00Z',
            failure_reason: null,
          },
        ];
      }
      return [];
    });
    const { kafka } = makeKafka();
    const svc = new RemoteActionService(
      fake.tenantPrisma as never,
      makePermCheck(true) as never,
      kafka as never,
    );

    const result = await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.updateStatus(
        '019e1111-1111-7000-8000-000000000001',
        { status: 'COMPLETED' },
        ADMIN_ACTOR,
      ),
    );
    expect(result.status).toBe('COMPLETED');

    // The keystone — tech_assets UPDATE to AVAILABLE happened inside the tx
    const sawAvailableFlip = fake.capture.some((c) =>
      c.sql.startsWith("UPDATE tech_assets SET status = 'AVAILABLE'"),
    );
    expect(sawAvailableFlip).toBe(true);
  });

  it('updateStatus() refuses to mutate a terminal-state remote action', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM tech_remote_actions WHERE id = $1::uuid FOR UPDATE')) {
        return [
          {
            id: '019e1111-1111-7000-8000-000000000001',
            asset_id: '019e1000-0000-7000-8000-000000000001',
            action_type: 'LOCK',
            status: 'COMPLETED',
          },
        ];
      }
      return [];
    });
    const { kafka } = makeKafka();
    const svc = new RemoteActionService(
      fake.tenantPrisma as never,
      makePermCheck(true) as never,
      kafka as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.updateStatus(
          '019e1111-1111-7000-8000-000000000001',
          { status: 'FAILED', failureReason: 'mdm api timed out' },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create() refuses non-IT-admin caller', async () => {
    const fake = makeFake(() => []);
    const { kafka } = makeKafka();
    const svc = new RemoteActionService(
      fake.tenantPrisma as never,
      makePermCheck(false) as never,
      kafka as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.create(
          '019e1000-0000-7000-8000-000000000001',
          {
            actionType: 'LOCK',
            justification: 'this justification is long enough to pass the check',
          },
          TEACHER_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('LicenceRenewalService — atomic expiry update', () => {
  it('renew() rejects new expiry earlier than previous', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM tech_software_licences WHERE id = $1::uuid AND school_id')) {
        return [{ id: '019e2000-0000-7000-8000-000000000001', expiry_date: '2026-12-31' }];
      }
      return [];
    });
    const svc = new LicenceRenewalService(fake.tenantPrisma as never, makePermCheck(true) as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.renew(
          '019e2000-0000-7000-8000-000000000001',
          { newExpiryDate: '2026-06-30', renewalCost: 100 },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('renew() writes both INSERT renewal and UPDATE licence expiry_date inside one tenant tx', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM tech_software_licences WHERE id = $1::uuid AND school_id')) {
        return [{ id: '019e2000-0000-7000-8000-000000000001', expiry_date: '2026-12-31' }];
      }
      if (call.sql.startsWith('INSERT INTO tech_licence_renewals')) return 1;
      if (call.sql.startsWith('UPDATE tech_software_licences SET expiry_date')) return 1;
      if (call.sql.includes('FROM tech_licence_renewals r')) {
        return [
          {
            id: '019e2222-0000-7000-8000-000000000001',
            licence_id: '019e2000-0000-7000-8000-000000000001',
            software_name: 'Adobe',
            previous_expiry_date: '2026-12-31',
            new_expiry_date: '2027-12-31',
            renewal_cost: '500',
            renewed_by: ADMIN_ACTOR.personId,
            renewed_by_first: 'Sarah',
            renewed_by_last: 'Mitchell',
            renewed_at: '2026-05-12T12:00:00Z',
            notes: null,
          },
        ];
      }
      return [];
    });
    const svc = new LicenceRenewalService(fake.tenantPrisma as never, makePermCheck(true) as never);
    const result = await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.renew(
        '019e2000-0000-7000-8000-000000000001',
        { newExpiryDate: '2027-12-31', renewalCost: 500 },
        ADMIN_ACTOR,
      ),
    );
    expect(result.newExpiryDate).toBe('2027-12-31');
    const sawRenewalInsert = fake.capture.some((c) =>
      c.sql.startsWith('INSERT INTO tech_licence_renewals'),
    );
    const sawLicenceUpdate = fake.capture.some((c) =>
      c.sql.startsWith('UPDATE tech_software_licences SET expiry_date'),
    );
    expect(sawRenewalInsert).toBe(true);
    expect(sawLicenceUpdate).toBe(true);
  });
});

describe('MonitoringService — consecutive-failure alerting', () => {
  it('recordResult() crosses threshold and creates DOWN alert + emits tech.monitoring.alert', async () => {
    const fake = makeFake((call) => {
      // Locked SELECT on the check row — prior consecutive_failures=1, threshold=2
      if (
        call.sql.includes(
          'SELECT id::text AS id, system_name, consecutive_failures, consecutive_failures_to_alert',
        )
      ) {
        return [
          {
            id: '019e3000-0000-7000-8000-000000000001',
            system_name: 'SIS API',
            consecutive_failures: 1,
            consecutive_failures_to_alert: 2,
            last_status: 'DEGRADED',
          },
        ];
      }
      if (call.sql.startsWith('UPDATE tech_monitoring_checks SET last_status')) return 1;
      if (call.sql.startsWith('INSERT INTO tech_monitoring_alerts')) return 1;
      // post-reload of check
      if (call.sql.includes('FROM tech_monitoring_checks c')) {
        return [
          {
            id: '019e3000-0000-7000-8000-000000000001',
            school_id: SCHOOL.schoolId,
            system_name: 'SIS API',
            check_url: 'https://sis.example.com/health',
            check_type: 'HTTP',
            interval_minutes: 5,
            expected_status_code: 200,
            timeout_seconds: 10,
            consecutive_failures_to_alert: 2,
            is_active: true,
            last_status: 'DOWN',
            last_checked_at: '2026-05-12T12:01:00Z',
            consecutive_failures: 2,
            active_alert_count: 1,
          },
        ];
      }
      return [];
    });
    const { kafka, emitted } = makeKafka();
    const svc = new MonitoringService(
      fake.tenantPrisma as never,
      makePermCheck(true) as never,
      kafka as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.recordResult(
        '019e3000-0000-7000-8000-000000000001',
        { status: 'DOWN', errorMessage: 'connection refused' },
        ADMIN_ACTOR,
      ),
    );
    const sawAlertInsert = fake.capture.some((c) =>
      c.sql.startsWith('INSERT INTO tech_monitoring_alerts'),
    );
    expect(sawAlertInsert).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.topic).toBe('tech.monitoring.alert');
    expect(emitted[0]!.sourceModule).toBe('it');
    expect(emitted[0]!.payload.alertType).toBe('DOWN');
    expect(emitted[0]!.payload.systemName).toBe('SIS API');
  });

  it('recordResult() HEALTHY after DOWN resolves active alerts and writes a RECOVERED row', async () => {
    let openAlertsReturnedOnce = false;
    const fake = makeFake((call) => {
      if (
        call.sql.includes(
          'SELECT id::text AS id, system_name, consecutive_failures, consecutive_failures_to_alert',
        )
      ) {
        return [
          {
            id: '019e3000-0000-7000-8000-000000000001',
            system_name: 'SIS API',
            consecutive_failures: 3,
            consecutive_failures_to_alert: 2,
            last_status: 'DOWN',
          },
        ];
      }
      if (call.sql.startsWith('UPDATE tech_monitoring_checks SET last_status')) return 1;
      if (
        call.sql.includes(
          'FROM tech_monitoring_alerts WHERE check_id = $1::uuid AND resolved_at IS NULL',
        )
      ) {
        if (!openAlertsReturnedOnce) {
          openAlertsReturnedOnce = true;
          return [{ id: '019eaaaa-0000-7000-8000-000000000001' }];
        }
        return [];
      }
      if (call.sql.startsWith('UPDATE tech_monitoring_alerts SET resolved_at = now()')) return 1;
      if (call.sql.startsWith('INSERT INTO tech_monitoring_alerts')) return 1;
      if (call.sql.includes('FROM tech_monitoring_checks c')) {
        return [
          {
            id: '019e3000-0000-7000-8000-000000000001',
            school_id: SCHOOL.schoolId,
            system_name: 'SIS API',
            check_url: 'https://sis.example.com/health',
            check_type: 'HTTP',
            interval_minutes: 5,
            expected_status_code: 200,
            timeout_seconds: 10,
            consecutive_failures_to_alert: 2,
            is_active: true,
            last_status: 'HEALTHY',
            last_checked_at: '2026-05-12T12:05:00Z',
            consecutive_failures: 0,
            active_alert_count: 0,
          },
        ];
      }
      return [];
    });
    const { kafka, emitted } = makeKafka();
    const svc = new MonitoringService(
      fake.tenantPrisma as never,
      makePermCheck(true) as never,
      kafka as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.recordResult(
        '019e3000-0000-7000-8000-000000000001',
        { status: 'HEALTHY', statusCode: 200, responseTimeMs: 120 },
        ADMIN_ACTOR,
      ),
    );
    const resolvedSql = fake.capture.find((c) =>
      c.sql.startsWith('UPDATE tech_monitoring_alerts SET resolved_at = now()'),
    );
    expect(resolvedSql).toBeDefined();
    expect(emitted.some((e) => e.payload.alertType === 'RECOVERED')).toBe(true);
  });
});

describe('DeviceUsageService — flagged_activity emit', () => {
  it('record() with flagged_activity=true emits tech.usage.flagged AFTER tx commits', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM tech_assets WHERE id = $1::uuid AND school_id')) {
        return [{ id: '019e4000-0000-7000-8000-000000000001', asset_tag: 'IT-CB-002' }];
      }
      if (call.sql.startsWith('DELETE FROM tech_device_usage_summaries')) return 0;
      if (call.sql.startsWith('INSERT INTO tech_device_usage_summaries')) return 1;
      if (call.sql.includes('FROM tech_device_usage_summaries u')) {
        return [
          {
            id: '019e4444-0000-7000-8000-000000000001',
            asset_id: '019e4000-0000-7000-8000-000000000001',
            asset_tag: 'IT-CB-002',
            summary_date: '2026-05-12',
            screen_time_minutes: 120,
            apps_used: ['Safari', 'Unknown'],
            flagged_activity: true,
            summary_source: 'MDM',
          },
        ];
      }
      return [];
    });
    const { kafka, emitted } = makeKafka();
    const svc = new DeviceUsageService(
      fake.tenantPrisma as never,
      makePermCheck(true) as never,
      kafka as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.record(
        '019e4000-0000-7000-8000-000000000001',
        {
          summaryDate: '2026-05-12',
          screenTimeMinutes: 120,
          appsUsed: ['Safari', 'Unknown'],
          flaggedActivity: true,
        },
        ADMIN_ACTOR,
      ),
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.topic).toBe('tech.usage.flagged');
    expect(emitted[0]!.payload.assetTag).toBe('IT-CB-002');
    expect(emitted[0]!.payload.summaryDate).toBe('2026-05-12');
  });

  it('record() with flagged_activity=false does NOT emit', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM tech_assets WHERE id = $1::uuid AND school_id')) {
        return [{ id: '019e4000-0000-7000-8000-000000000001', asset_tag: 'IT-CB-002' }];
      }
      if (call.sql.includes('FROM tech_device_usage_summaries u')) {
        return [
          {
            id: '019e4444-0000-7000-8000-000000000001',
            asset_id: '019e4000-0000-7000-8000-000000000001',
            asset_tag: 'IT-CB-002',
            summary_date: '2026-05-12',
            screen_time_minutes: 60,
            apps_used: [],
            flagged_activity: false,
            summary_source: null,
          },
        ];
      }
      return [];
    });
    const { kafka, emitted } = makeKafka();
    const svc = new DeviceUsageService(
      fake.tenantPrisma as never,
      makePermCheck(true) as never,
      kafka as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.record(
        '019e4000-0000-7000-8000-000000000001',
        { summaryDate: '2026-05-12', screenTimeMinutes: 60, flaggedActivity: false },
        ADMIN_ACTOR,
      ),
    );
    expect(emitted).toHaveLength(0);
  });
});

describe('ItAdvancedController — @RequirePermission metadata pins documented gates', () => {
  function permsOf(method: string): string[] {
    const proto = ItAdvancedController.prototype as unknown as Record<string, unknown>;
    const meta = Reflect.getMetadata(PERMISSIONS_KEY, proto[method] as object);
    return (meta as string[] | undefined) ?? [];
  }
  it('Remote-action endpoints gate on it-002', () => {
    expect(permsOf('listRemoteActions')).toEqual(['it-002:read']);
    expect(permsOf('createRemoteAction')).toEqual(['it-002:write']);
    expect(permsOf('updateRemoteActionStatus')).toEqual(['it-002:write']);
  });
  it('Inventory audit endpoints gate on it-002', () => {
    expect(permsOf('listAudits')).toEqual(['it-002:read']);
    expect(permsOf('createAudit')).toEqual(['it-002:write']);
    expect(permsOf('scanAuditItem')).toEqual(['it-002:write']);
    expect(permsOf('completeAudit')).toEqual(['it-002:write']);
    expect(permsOf('auditReport')).toEqual(['it-002:read']);
  });
  it('Licence renewal endpoints gate on it-004', () => {
    expect(permsOf('listRenewals')).toEqual(['it-004:read']);
    expect(permsOf('renewLicence')).toEqual(['it-004:write']);
  });
  it('Phone extension endpoints gate on it-007', () => {
    expect(permsOf('listExtensions')).toEqual(['it-007:read']);
    expect(permsOf('createExtension')).toEqual(['it-007:write']);
    expect(permsOf('assignExtension')).toEqual(['it-007:write']);
    expect(permsOf('unassignExtension')).toEqual(['it-007:write']);
  });
  it('Monitoring endpoints gate on it-006', () => {
    expect(permsOf('listMonitoringChecks')).toEqual(['it-006:read']);
    expect(permsOf('createMonitoringCheck')).toEqual(['it-006:write']);
    expect(permsOf('recordCheckResult')).toEqual(['it-006:write']);
    expect(permsOf('acknowledgeAlert')).toEqual(['it-006:write']);
  });
  it('Documentation endpoints gate on it-009', () => {
    expect(permsOf('listDocs')).toEqual(['it-009:read']);
    expect(permsOf('createDoc')).toEqual(['it-009:write']);
    expect(permsOf('patchDoc')).toEqual(['it-009:write']);
  });
  it('Infrastructure extension endpoints gate on it-007', () => {
    expect(permsOf('warrantyExpiring')).toEqual(['it-007:read']);
    expect(permsOf('markInfrastructureChecked')).toEqual(['it-007:write']);
    expect(permsOf('patchInfrastructure')).toEqual(['it-007:write']);
  });
});

describe('PhoneExtensionService — IT admin write gate + read scope', () => {
  it('create() refuses non-IT-admin', async () => {
    const fake = makeFake(() => []);
    const svc = new PhoneExtensionService(
      fake.tenantPrisma as never,
      makePermCheck(false) as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.create({ extensionNumber: '1010', extensionType: 'DESK' }, TEACHER_ACTOR),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('ConfigDocumentationService — versioned update', () => {
  it('patch() increments version inside locked tenant tx', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM tech_config_documentation WHERE id = $1::uuid AND school_id')) {
        return [{ id: '019e6000-0000-7000-8000-000000000001' }];
      }
      if (call.sql.startsWith('UPDATE tech_config_documentation SET')) return 1;
      if (call.sql.includes('FROM tech_config_documentation d')) {
        return [
          {
            id: '019e6000-0000-7000-8000-000000000001',
            school_id: SCHOOL.schoolId,
            title: 'WiFi',
            category: 'WIFI',
            content_markdown: '# WiFi v2',
            version: 2,
            diagram_s3_key: null,
            last_updated_by: ADMIN_ACTOR.personId,
            last_updated_first: 'Sarah',
            last_updated_last: 'Mitchell',
            last_updated_at: '2026-05-12T12:00:00Z',
          },
        ];
      }
      return [];
    });
    const svc = new ConfigDocumentationService(
      fake.tenantPrisma as never,
      makePermCheck(true) as never,
    );
    const result = await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.patch(
        '019e6000-0000-7000-8000-000000000001',
        { contentMarkdown: '# WiFi v2' },
        ADMIN_ACTOR,
      ),
    );
    expect(result.version).toBe(2);
    const sawVersionIncrement = fake.capture.some(
      (c) =>
        c.sql.startsWith('UPDATE tech_config_documentation SET') &&
        c.sql.includes('version = version + 1'),
    );
    expect(sawVersionIncrement).toBe(true);
  });
});

describe('InventoryAuditService — lifecycle + computed totals', () => {
  it('scan() rejects scans against a COMPLETED audit', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM tech_inventory_audits WHERE id = $1::uuid AND school_id')) {
        return [{ id: '019e7000-0000-7000-8000-000000000001', status: 'COMPLETED' }];
      }
      return [];
    });
    const svc = new InventoryAuditService(fake.tenantPrisma as never, makePermCheck(true) as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.scan(
          '019e7000-0000-7000-8000-000000000001',
          { assetTag: 'TAG-A', found: true, conditionObserved: 'GOOD' },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('complete() computes totals and stamps COMPLETED inside one tx', async () => {
    let getByIdCallCount = 0;
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM tech_inventory_audits WHERE id = $1::uuid AND school_id')) {
        return [
          {
            id: '019e7000-0000-7000-8000-000000000001',
            status: 'IN_PROGRESS',
            total_assets_expected: 10,
          },
        ];
      }
      if (call.sql.startsWith('SELECT ') && call.sql.includes('FILTER (WHERE found = true')) {
        return [{ found_known: 7, unrecorded: 1 }];
      }
      if (call.sql.includes('FROM tech_inventory_audits au')) {
        getByIdCallCount++;
        return [
          {
            id: '019e7000-0000-7000-8000-000000000001',
            school_id: SCHOOL.schoolId,
            audit_name: 'Building A',
            building: 'Building A',
            conducted_by: ADMIN_ACTOR.personId,
            conducted_by_first: 'Sarah',
            conducted_by_last: 'Mitchell',
            audit_date: '2026-05-12',
            total_assets_expected: 10,
            total_assets_found: 7,
            total_assets_missing: 3,
            total_assets_unrecorded: 1,
            audit_notes: null,
            status: 'COMPLETED',
            completed_at: '2026-05-12T12:00:00Z',
          },
        ];
      }
      if (call.sql.startsWith('UPDATE tech_inventory_audits SET')) return 1;
      return [];
    });
    const svc = new InventoryAuditService(fake.tenantPrisma as never, makePermCheck(true) as never);
    const result = await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.complete('019e7000-0000-7000-8000-000000000001', ADMIN_ACTOR),
    );
    expect(result.status).toBe('COMPLETED');
    expect(result.totalAssetsFound).toBe(7);
    expect(result.totalAssetsMissing).toBe(3);
    expect(result.totalAssetsUnrecorded).toBe(1);
    expect(getByIdCallCount).toBeGreaterThan(0);
    const sawUpdate = fake.capture.some((c) =>
      c.sql.startsWith('UPDATE tech_inventory_audits SET total_assets_found'),
    );
    expect(sawUpdate).toBe(true);
  });
});

describe('RemoteActionService class invariants — no UPDATE/DELETE method exposed', () => {
  it('does not declare update() or delete() methods on the prototype (IMMUTABLE contract)', () => {
    const proto = RemoteActionService.prototype as unknown as Record<string, unknown>;
    expect(typeof proto.update).toBe('undefined');
    expect(typeof proto.delete).toBe('undefined');
    expect(typeof proto.remove).toBe('undefined');
    // updateStatus is the only allowed mutation (lifecycle transition)
    expect(typeof proto.updateStatus).toBe('function');
    // create + getById + listForAsset are the read+create surface
    expect(typeof proto.create).toBe('function');
    expect(typeof proto.getById).toBe('function');
    expect(typeof proto.listForAsset).toBe('function');
  });
});
