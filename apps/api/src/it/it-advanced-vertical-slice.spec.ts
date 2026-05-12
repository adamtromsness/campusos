import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { runWithTenantContext } from '../tenant/tenant.context';
import {
  DeviceUsageService,
  InventoryAuditService,
  LicenceRenewalService,
  RemoteActionService,
} from './remote-actions.service';
import { ConfigDocumentationService, MonitoringService } from './voip-monitoring.service';

/**
 * P2-20b Step 7 — Vertical Slice Integration Tests.
 *
 * Covers the 7 scenarios documented in `docs/campusos-p2c20-it-advanced.html` Step 7:
 *
 *   1. Remote action IMMUTABLE — issue LOCK with justification, attempt
 *      mutation/delete (no methods exposed), justification < 20 chars
 *      rejected.
 *   2. WIPE auto-reset — issue WIPE, mark COMPLETED, verify
 *      tech_assets.status UPDATE to AVAILABLE inside one tx.
 *   3. Inventory audit lifecycle — start (45 expected), scan 42 found,
 *      scan 1 unknown (unrecorded), complete, verify totals.
 *   4. Licence renewal — expires 2026-12-31, renew to 2027-12-31 at
 *      $500, verify licence expiry updated + renewal history.
 *   5. Monitoring alert state machine — record 2 consecutive DOWN
 *      results, verify alert created + tech.monitoring.alert emitted;
 *      record HEALTHY, verify alert resolved + RECOVERED row written.
 *   6. Config documentation versioning — create v1, update → v2.
 *   7. Visibility — IT admin / IT staff / Teacher gates verified.
 *
 * The P2-20a spec already pins individual unit behaviour. This spec
 * pins the end-to-end flow that the CAT script walks live.
 */

const SCHOOL = { schoolId: '019e0cf8-bbb8-7556-8c81-aaaaaaaaaaaa', subdomain: 'demo' } as never;
const ADMIN_ACTOR = {
  accountId: '019e0cf8-bbb8-7556-8c81-a0000000a001',
  personId: '019e0cf8-bbb8-7556-8c81-a0000000a002',
  employeeId: '019e0cf8-bbb8-7556-8c81-a0000000a003',
  personType: 'STAFF' as const,
  isSchoolAdmin: true,
} as never;
const STAFF_ACTOR = {
  accountId: '019e0cf8-bbb8-7556-8c81-c0000000c001',
  personId: '019e0cf8-bbb8-7556-8c81-c0000000c002',
  employeeId: '019e0cf8-bbb8-7556-8c81-c0000000c003',
  personType: 'STAFF' as const,
  isSchoolAdmin: false,
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

function makePermCheck(answers: { admin?: boolean; staff?: boolean }) {
  return {
    hasAnyPermissionInTenant: async (accountId: string) => {
      if (accountId === ADMIN_ACTOR.accountId) return answers.admin ?? true;
      if (accountId === STAFF_ACTOR.accountId) return answers.staff ?? true;
      return false;
    },
  };
}

function makeKafka() {
  const emitted: Array<{
    topic: string;
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
        sourceModule: opts.sourceModule,
        payload: opts.payload,
      });
    },
  };
  return { kafka, emitted };
}

describe('P2-20b vertical slice — Scenario 1: Remote action IMMUTABLE', () => {
  it('issuing a LOCK with justification creates a PENDING row + emits envelope', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('SELECT id::text AS id, asset_tag FROM tech_assets')) {
        return [{ id: '019e1000-0000-7000-8000-000000000001', asset_tag: 'IT-IP-005' }];
      }
      if (call.sql.startsWith('INSERT INTO tech_remote_actions')) return 1;
      if (call.sql.includes('FROM tech_remote_actions r')) {
        return [
          {
            id: '019e1111-1111-7000-8000-000000000001',
            asset_id: '019e1000-0000-7000-8000-000000000001',
            asset_tag: 'IT-IP-005',
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
      makePermCheck({ admin: true }) as never,
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
    expect(emitted[0]?.topic).toBe('tech.remote_action.issued');
    expect(emitted[0]?.payload.actionType).toBe('LOCK');
  });

  it('rejects justification < 20 trimmed chars', async () => {
    const fake = makeFake(() => []);
    const { kafka } = makeKafka();
    const svc = new RemoteActionService(
      fake.tenantPrisma as never,
      makePermCheck({ admin: true }) as never,
      kafka as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.create(
          '019e1000-0000-7000-8000-000000000001',
          { actionType: 'LOCK', justification: '  short  ' },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('no UPDATE / DELETE / REMOVE methods are exposed on the service prototype', () => {
    const proto = RemoteActionService.prototype as unknown as Record<string, unknown>;
    expect(typeof proto.update).toBe('undefined');
    expect(typeof proto.delete).toBe('undefined');
    expect(typeof proto.remove).toBe('undefined');
    expect(typeof proto.patch).toBe('undefined');
  });
});

describe('P2-20b vertical slice — Scenario 2: WIPE auto-reset to AVAILABLE', () => {
  it('marking a WIPE COMPLETED flips parent tech_assets.status atomically', async () => {
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
      if (call.sql.includes('FROM tech_remote_actions r')) {
        return [
          {
            id: '019e1111-1111-7000-8000-000000000001',
            asset_id: '019e1000-0000-7000-8000-000000000001',
            asset_tag: 'IT-CB-005',
            action_type: 'WIPE',
            initiated_by: ADMIN_ACTOR.personId,
            initiated_by_first: 'Sarah',
            initiated_by_last: 'Mitchell',
            initiated_at: '2026-05-12T12:00:00Z',
            justification: 'Decommissioning device for redeployment to incoming hire',
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
      makePermCheck({ admin: true }) as never,
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
    const sawAvailableFlip = fake.capture.some((c) =>
      c.sql.startsWith("UPDATE tech_assets SET status = 'AVAILABLE'"),
    );
    expect(sawAvailableFlip).toBe(true);
  });

  it('non-WIPE COMPLETED does NOT flip tech_assets.status', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM tech_remote_actions WHERE id = $1::uuid FOR UPDATE')) {
        return [
          {
            id: '019e1111-1111-7000-8000-000000000002',
            asset_id: '019e1000-0000-7000-8000-000000000001',
            action_type: 'LOCK',
            status: 'PENDING',
          },
        ];
      }
      if (call.sql.startsWith('UPDATE tech_remote_actions')) return 1;
      if (call.sql.includes('FROM tech_remote_actions r')) {
        return [
          {
            id: '019e1111-1111-7000-8000-000000000002',
            asset_id: '019e1000-0000-7000-8000-000000000001',
            asset_tag: 'IT-CB-005',
            action_type: 'LOCK',
            initiated_by: ADMIN_ACTOR.personId,
            initiated_by_first: 'Sarah',
            initiated_by_last: 'Mitchell',
            initiated_at: '2026-05-12T12:00:00Z',
            justification: 'lost device, locking until parent recovers it from bus station',
            mdm_command_ref: null,
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
      makePermCheck({ admin: true }) as never,
      kafka as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.updateStatus(
        '019e1111-1111-7000-8000-000000000002',
        { status: 'COMPLETED' },
        ADMIN_ACTOR,
      ),
    );
    const sawAvailableFlip = fake.capture.some((c) =>
      c.sql.startsWith("UPDATE tech_assets SET status = 'AVAILABLE'"),
    );
    expect(sawAvailableFlip).toBe(false);
  });
});

describe('P2-20b vertical slice — Scenario 3: Inventory audit lifecycle', () => {
  it('start → scan found 7 + 1 unknown → complete → totals (found=7, missing=2, unrecorded=1)', async () => {
    let scanCount = 0;
    const fake = makeFake((call) => {
      // create() — count expected assets in scope
      if (call.sql.includes('SELECT COUNT(*)::int AS count FROM tech_assets')) {
        return [{ count: 10 }];
      }
      if (call.sql.startsWith('INSERT INTO tech_inventory_audits')) return 1;
      // scan() locks the audit row first
      if (call.sql.includes('FROM tech_inventory_audits WHERE id = $1::uuid AND school_id')) {
        return [
          {
            id: '019e7000-0000-7000-8000-000000000001',
            status: 'IN_PROGRESS',
            total_assets_expected: 10,
          },
        ];
      }
      // scan() asset lookup by tag — return found for IT-001..IT-007, miss for IT-9999
      if (
        call.sql.includes('FROM tech_assets WHERE school_id') &&
        call.sql.includes('AND asset_tag')
      ) {
        const tag = call.args[1] as string;
        if (tag.startsWith('IT-9999')) return [];
        return [{ id: '019e1000-0000-7000-8000-' + String(scanCount).padStart(12, '0') }];
      }
      if (call.sql.startsWith('INSERT INTO tech_inventory_audit_items')) return 1;
      // scan() reload — fetch the freshly inserted audit item row
      if (
        call.sql.includes('FROM tech_inventory_audit_items WHERE id = $1::uuid LIMIT 1') ||
        (call.sql.includes('FROM tech_inventory_audit_items') &&
          call.sql.includes('WHERE id = $1::uuid'))
      ) {
        scanCount += 1;
        const assetId =
          scanCount === 8 ? null : '019e1000-0000-7000-8000-' + String(scanCount).padStart(12, '0');
        const tag = scanCount === 8 ? 'IT-9999' : `IT-${String(scanCount).padStart(3, '0')}`;
        return [
          {
            id: `019eaaa0-0000-7000-8000-${String(scanCount).padStart(12, '0')}`,
            audit_id: '019e7000-0000-7000-8000-000000000001',
            asset_id: assetId,
            asset_tag: tag,
            found: true,
            condition_observed: scanCount === 8 ? null : 'GOOD',
            location_observed: null,
            discrepancy_notes: null,
            scanned_at: '2026-05-12T12:00:00Z',
          },
        ];
      }
      // getById() / reload after complete
      if (call.sql.includes('FROM tech_inventory_audits au')) {
        return [
          {
            id: '019e7000-0000-7000-8000-000000000001',
            school_id: SCHOOL.schoolId,
            audit_name: 'Building A Annual',
            building: 'Building A',
            conducted_by: ADMIN_ACTOR.personId,
            conducted_by_first: 'Sarah',
            conducted_by_last: 'Mitchell',
            audit_date: '2026-05-12',
            total_assets_expected: 10,
            total_assets_found: 7,
            total_assets_missing: 2,
            total_assets_unrecorded: 1,
            audit_notes: null,
            status: 'COMPLETED',
            completed_at: '2026-05-12T12:00:00Z',
          },
        ];
      }
      // complete() aggregate counts
      if (call.sql.startsWith('SELECT ') && call.sql.includes('FILTER (WHERE found = true')) {
        return [{ found_known: 7, unrecorded: 1 }];
      }
      if (call.sql.startsWith('UPDATE tech_inventory_audits SET')) return 1;
      return [];
    });
    const svc = new InventoryAuditService(
      fake.tenantPrisma as never,
      makePermCheck({ admin: true }) as never,
    );
    const audit = await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.create({ auditName: 'Building A Annual', building: 'Building A' }, ADMIN_ACTOR),
    );
    expect(audit.totalAssetsExpected).toBe(10);

    // Scan 7 found
    for (let i = 1; i <= 7; i++) {
      await runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.scan(
          audit.id,
          { assetTag: `IT-${String(i).padStart(3, '0')}`, found: true, conditionObserved: 'GOOD' },
          ADMIN_ACTOR,
        ),
      );
    }
    // Scan 1 unknown
    const unknownResult = await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.scan(audit.id, { assetTag: 'IT-9999', found: true }, ADMIN_ACTOR),
    );
    expect(unknownResult.assetId).toBeNull();

    // Complete
    const completed = await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.complete(audit.id, ADMIN_ACTOR),
    );
    expect(completed.status).toBe('COMPLETED');
    expect(completed.totalAssetsFound).toBe(7);
    expect(completed.totalAssetsMissing).toBe(2);
    expect(completed.totalAssetsUnrecorded).toBe(1);
  });
});

describe('P2-20b vertical slice — Scenario 4: Licence renewal updates expiry', () => {
  it('renew from 2026-12-31 → 2027-12-31 at $500 writes both rows in one tx', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM tech_software_licences WHERE id = $1::uuid AND school_id')) {
        return [
          {
            id: '019e2000-0000-7000-8000-000000000001',
            expiry_date: '2026-12-31',
            software_name: 'Photoshop',
          },
        ];
      }
      if (call.sql.startsWith('INSERT INTO tech_licence_renewals')) return 1;
      if (call.sql.startsWith('UPDATE tech_software_licences SET expiry_date')) return 1;
      if (call.sql.includes('FROM tech_licence_renewals r')) {
        return [
          {
            id: '019e2222-0000-7000-8000-000000000001',
            licence_id: '019e2000-0000-7000-8000-000000000001',
            software_name: 'Photoshop',
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
    const svc = new LicenceRenewalService(
      fake.tenantPrisma as never,
      makePermCheck({ admin: true }) as never,
    );
    const result = await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.renew(
        '019e2000-0000-7000-8000-000000000001',
        { newExpiryDate: '2027-12-31', renewalCost: 500 },
        ADMIN_ACTOR,
      ),
    );
    expect(result.newExpiryDate).toBe('2027-12-31');
    expect(result.previousExpiryDate).toBe('2026-12-31');
    const sawLicenceUpdate = fake.capture.some((c) =>
      c.sql.startsWith('UPDATE tech_software_licences SET expiry_date'),
    );
    expect(sawLicenceUpdate).toBe(true);
  });
});

describe('P2-20b vertical slice — Scenario 5: Monitoring alert state machine', () => {
  it('crossing the threshold creates DOWN alert + emits tech.monitoring.alert with full payload', async () => {
    const fake = makeFake((call) => {
      if (
        call.sql.includes(
          'SELECT id::text AS id, system_name, consecutive_failures, consecutive_failures_to_alert',
        )
      ) {
        return [
          {
            id: '019e3000-0000-7000-8000-000000000001',
            system_name: 'Payment Gateway',
            consecutive_failures: 1,
            consecutive_failures_to_alert: 2,
            last_status: 'DEGRADED',
          },
        ];
      }
      if (call.sql.startsWith('UPDATE tech_monitoring_checks SET last_status')) return 1;
      if (call.sql.startsWith('INSERT INTO tech_monitoring_alerts')) return 1;
      if (call.sql.includes('FROM tech_monitoring_checks c')) {
        return [
          {
            id: '019e3000-0000-7000-8000-000000000001',
            school_id: SCHOOL.schoolId,
            system_name: 'Payment Gateway',
            check_url: 'https://stripe.example.com/health',
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
      makePermCheck({ admin: true }) as never,
      kafka as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.recordResult(
        '019e3000-0000-7000-8000-000000000001',
        { status: 'DOWN', errorMessage: 'connection refused' },
        ADMIN_ACTOR,
      ),
    );
    expect(emitted.length).toBeGreaterThanOrEqual(1);
    const downEmit = emitted.find((e) => e.payload.alertType === 'DOWN');
    expect(downEmit).toBeDefined();
    expect(downEmit?.topic).toBe('tech.monitoring.alert');
    expect(downEmit?.sourceModule).toBe('it');
    expect(downEmit?.payload.systemName).toBe('Payment Gateway');
  });

  it('HEALTHY after DOWN resolves the active alert and emits a RECOVERED row', async () => {
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
            system_name: 'Payment Gateway',
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
            system_name: 'Payment Gateway',
            check_url: 'https://stripe.example.com/health',
            check_type: 'HTTP',
            interval_minutes: 5,
            expected_status_code: 200,
            timeout_seconds: 10,
            consecutive_failures_to_alert: 2,
            is_active: true,
            last_status: 'HEALTHY',
            last_checked_at: '2026-05-12T12:06:00Z',
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
      makePermCheck({ admin: true }) as never,
      kafka as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.recordResult(
        '019e3000-0000-7000-8000-000000000001',
        { status: 'HEALTHY', statusCode: 200, responseTimeMs: 80 },
        ADMIN_ACTOR,
      ),
    );
    const resolveSql = fake.capture.find((c) =>
      c.sql.startsWith('UPDATE tech_monitoring_alerts SET resolved_at = now()'),
    );
    expect(resolveSql).toBeDefined();
    expect(emitted.some((e) => e.payload.alertType === 'RECOVERED')).toBe(true);
  });
});

describe('P2-20b vertical slice — Scenario 6: Config documentation versioning', () => {
  it('updating a doc increments version + uses locked-row UPDATE pattern', async () => {
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
            title: 'Network Topology',
            category: 'NETWORK_TOPOLOGY',
            content_markdown: '# v2 content',
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
      makePermCheck({ admin: true }) as never,
    );
    const result = await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.patch(
        '019e6000-0000-7000-8000-000000000001',
        { contentMarkdown: '# v2 content' },
        ADMIN_ACTOR,
      ),
    );
    expect(result.version).toBe(2);
    const sawIncrement = fake.capture.some(
      (c) =>
        c.sql.startsWith('UPDATE tech_config_documentation SET') &&
        c.sql.includes('version = version + 1'),
    );
    expect(sawIncrement).toBe(true);
  });
});

describe('P2-20b vertical slice — Scenario 7: Visibility (IT admin / staff / teacher)', () => {
  it('Teacher (no IT-002 perms) cannot issue a remote action', async () => {
    const fake = makeFake(() => []);
    const { kafka } = makeKafka();
    const svc = new RemoteActionService(
      fake.tenantPrisma as never,
      makePermCheck({ admin: false }) as never,
      kafka as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.create(
          '019e1000-0000-7000-8000-000000000001',
          {
            actionType: 'LOCK',
            justification: 'student reported device lost, locking it until recovered',
          },
          TEACHER_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('Teacher (no IT-002:write) cannot conduct an inventory audit', async () => {
    const fake = makeFake(() => []);
    const svc = new InventoryAuditService(
      fake.tenantPrisma as never,
      makePermCheck({ admin: false, staff: false }) as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.create({ auditName: 'Sneak audit' }, TEACHER_ACTOR),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('Admin can read documentation (IT-009:read) — perms gate passes', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM tech_config_documentation d')) {
        return [
          {
            id: '019e6000-0000-7000-8000-000000000001',
            school_id: SCHOOL.schoolId,
            title: 'Backup',
            category: 'BACKUP',
            content_markdown: '...',
            version: 3,
            diagram_s3_key: null,
            last_updated_by: ADMIN_ACTOR.personId,
            last_updated_first: null,
            last_updated_last: null,
            last_updated_at: '2026-05-12T12:00:00Z',
          },
        ];
      }
      return [];
    });
    const svc = new ConfigDocumentationService(
      fake.tenantPrisma as never,
      makePermCheck({ admin: true }) as never,
    );
    const result = await runWithTenantContext({ tenant: SCHOOL }, () => svc.list(ADMIN_ACTOR));
    expect(result.length).toBe(1);
    expect(result[0]?.version).toBe(3);
  });

  it('DeviceUsage flagged-list refuses non-IT-admin caller (Step 8 dashboard gate)', async () => {
    const fake = makeFake(() => []);
    const { kafka } = makeKafka();
    const svc = new DeviceUsageService(
      fake.tenantPrisma as never,
      makePermCheck({ admin: false }) as never,
      kafka as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () => svc.listFlagged(TEACHER_ACTOR)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('P2-20b vertical slice — Concurrent remote actions (CI parity check)', () => {
  it('two concurrent attempts both go through their own tx (no shared mutable state)', async () => {
    // The IMMUTABLE invariant + per-statement tx isolation means concurrent
    // issues against the same asset just create two rows. The schema cannot
    // enforce a "one PENDING per asset" rule because each row is a distinct
    // audit entry. This test pins that we do not silently drop the second
    // request and that both INSERTs land.
    let insertCount = 0;
    const fake = makeFake((call) => {
      if (call.sql.includes('SELECT id::text AS id, asset_tag FROM tech_assets')) {
        return [{ id: '019e1000-0000-7000-8000-000000000099', asset_tag: 'IT-CB-099' }];
      }
      if (call.sql.startsWith('INSERT INTO tech_remote_actions')) {
        insertCount++;
        return 1;
      }
      if (call.sql.includes('FROM tech_remote_actions r')) {
        return [
          {
            id: 'concurrent',
            asset_id: '019e1000-0000-7000-8000-000000000099',
            asset_tag: 'IT-CB-099',
            action_type: 'LOCATE',
            initiated_by: ADMIN_ACTOR.personId,
            initiated_by_first: null,
            initiated_by_last: null,
            initiated_at: '2026-05-12T12:00:00Z',
            justification: 'concurrent locate attempt for audit trail testing',
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
      makePermCheck({ admin: true }) as never,
      kafka as never,
    );

    await Promise.all([
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.create(
          '019e1000-0000-7000-8000-000000000099',
          {
            actionType: 'LOCATE',
            justification: 'concurrent locate attempt #1 — audit trail testing',
          },
          ADMIN_ACTOR,
        ),
      ),
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.create(
          '019e1000-0000-7000-8000-000000000099',
          {
            actionType: 'LOCATE',
            justification: 'concurrent locate attempt #2 — audit trail testing',
          },
          ADMIN_ACTOR,
        ),
      ),
    ]);

    expect(insertCount).toBe(2);
    expect(emitted.length).toBe(2);
  });
});

describe('P2-20b vertical slice — Asset not found rejected before INSERT', () => {
  it('issuing a remote action against a missing asset 404s without writing the audit row', async () => {
    let insertAttempted = false;
    const fake = makeFake((call) => {
      if (call.sql.includes('SELECT id::text AS id, asset_tag FROM tech_assets')) {
        return [];
      }
      if (call.sql.startsWith('INSERT INTO tech_remote_actions')) {
        insertAttempted = true;
        return 1;
      }
      return [];
    });
    const { kafka } = makeKafka();
    const svc = new RemoteActionService(
      fake.tenantPrisma as never,
      makePermCheck({ admin: true }) as never,
      kafka as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.create(
          '019e1000-0000-7000-8000-000000000404',
          {
            actionType: 'LOCK',
            justification: 'this asset does not exist in the calling tenant catalogue',
          },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(insertAttempted).toBe(false);
  });
});
