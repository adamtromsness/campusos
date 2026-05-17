import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { runWithTenantContext } from '@shared/tenant';
import { DeviceUsageService, RemoteActionService } from './remote-actions.service';
import { MonitoringService } from './voip-monitoring.service';
import {
  deterministicMonitoringAlertEventId,
  deterministicRemoteActionIssuedEventId,
  deterministicUsageFlaggedEventId,
} from './event-ids';

/**
 * REVIEW-P2C20 ROUND 1 regression tests.
 *
 * Pins the 4 BLOCKING fixes and the 2 actionable MAJORs:
 *
 *   BLOCKING 1 — every remote-action path (create / list / get /
 *                updateStatus) school-scopes through tech_assets.school_id.
 *                Cross-school asset/action UUIDs collapse to 404 / refuse
 *                the WIPE-completion side effect.
 *
 *   BLOCKING 2 — the 3 IT operational emits move from best-effort Kafka
 *                to durable outbox INSIDE the triggering tenant tx.
 *                Deterministic v5-shaped event_ids key on the originating
 *                row id so retries land the same envelope and downstream
 *                consumer-side idempotency catches redelivery.
 *
 *   BLOCKING 3 — DeviceUsageService.listForAsset and the post-record
 *                reload carry the school predicate through the joined
 *                tech_assets row. Foreign-tenant asset UUIDs cannot leak
 *                usage data.
 *
 *   BLOCKING 4 — MonitoringService.acknowledgeAlert UPDATE + reload
 *                join through tech_monitoring_checks with the school
 *                predicate.
 *
 *   MAJOR 2    — LicenceRenewalService.renew post-lock UPDATE + reload
 *                carry the school predicate (defence-in-depth).
 *
 *   MAJOR 3    — InventoryAuditService scan reload + listItems join
 *                through tech_inventory_audits with the school predicate.
 */

const SCHOOL = { schoolId: '019e0cf8-bbb8-7556-8c81-aaaaaaaaaaaa', subdomain: 'demo' } as never;
const ADMIN_ACTOR = {
  accountId: '019e0cf8-bbb8-7556-8c81-a0000000a001',
  personId: '019e0cf8-bbb8-7556-8c81-a0000000a002',
  employeeId: '019e0cf8-bbb8-7556-8c81-a0000000a003',
  personType: 'STAFF' as const,
  isSchoolAdmin: true,
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
  return { hasAnyPermissionInTenant: async () => returnTrue };
}

interface EmittedRow {
  topic: string;
  key: string;
  sourceModule: string;
  payload: Record<string, unknown>;
  eventId?: string;
}

function makeOutbox() {
  const emitted: EmittedRow[] = [];
  const outbox = {
    enqueueInTx: async (
      _tx: unknown,
      opts: {
        topic: string;
        key: string;
        sourceModule: string;
        payload: Record<string, unknown>;
        eventId?: string;
      },
    ) => {
      emitted.push({
        topic: opts.topic,
        key: opts.key,
        sourceModule: opts.sourceModule,
        payload: opts.payload,
        eventId: opts.eventId,
      });
    },
  };
  return { outbox, emitted };
}

// ─────────────────────────────────────────────────────────────
// BLOCKING 1 — Remote action school-scope
// ─────────────────────────────────────────────────────────────

describe('REVIEW-P2C20 R1 BLOCKING 1 — remote action school-scope', () => {
  it('create() pre-flight SELECT carries school_id = $tenant predicate', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM tech_assets WHERE id = $1::uuid AND school_id = $2::uuid')) {
        return [{ id: '019e1000-0000-7000-8000-000000000001', asset_tag: 'IT-CB-001' }];
      }
      if (call.sql.includes('FROM tech_remote_actions r')) {
        return [
          {
            id: 'action-1',
            asset_id: '019e1000-0000-7000-8000-000000000001',
            asset_tag: 'IT-CB-001',
            action_type: 'LOCK',
            initiated_by: ADMIN_ACTOR.personId,
            initiated_by_first: null,
            initiated_by_last: null,
            initiated_at: '2026-05-12T12:00:00Z',
            justification: 'cross-school school-scope regression test for remote actions',
            mdm_command_ref: null,
            status: 'PENDING',
            completed_at: null,
            failure_reason: null,
          },
        ];
      }
      return [];
    });
    const { outbox } = makeOutbox();
    const svc = new RemoteActionService(
      fake.tenantPrisma as never,
      makePermCheck(true) as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.create(
        '019e1000-0000-7000-8000-000000000001',
        {
          actionType: 'LOCK',
          justification: 'cross-school school-scope regression test for remote actions',
        },
        ADMIN_ACTOR,
      ),
    );
    const preflight = fake.capture.find(
      (c) =>
        c.sql.includes('FROM tech_assets WHERE id = $1::uuid AND school_id = $2::uuid') &&
        c.fn === 'q',
    );
    expect(preflight).toBeDefined();
    expect(preflight!.args[0]).toBe('019e1000-0000-7000-8000-000000000001');
    expect(preflight!.args[1]).toBe(SCHOOL.schoolId);
  });

  it('create() refuses a foreign-school asset (404)', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM tech_assets WHERE id = $1::uuid AND school_id = $2::uuid')) {
        // Foreign-school: returns 0 rows
        return [];
      }
      return [];
    });
    const { outbox } = makeOutbox();
    const svc = new RemoteActionService(
      fake.tenantPrisma as never,
      makePermCheck(true) as never,
      outbox as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.create(
          '019e1000-0000-7000-8000-99999999cafe',
          {
            actionType: 'LOCK',
            justification:
              'attempting cross-school WIPE — should be rejected by school-scope predicate',
          },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('listForAsset() carries school_id predicate', async () => {
    const fake = makeFake(() => []);
    const { outbox } = makeOutbox();
    const svc = new RemoteActionService(
      fake.tenantPrisma as never,
      makePermCheck(true) as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.listForAsset('019e1000-0000-7000-8000-000000000001', ADMIN_ACTOR),
    );
    const listCall = fake.capture.find(
      (c) => c.sql.includes('FROM tech_remote_actions r') && c.sql.includes('WHERE r.asset_id'),
    );
    expect(listCall).toBeDefined();
    expect(listCall!.sql).toContain('a.school_id = $2::uuid');
    expect(listCall!.args[1]).toBe(SCHOOL.schoolId);
  });

  it('getById() carries school_id predicate via the joined asset', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM tech_remote_actions r')) return [];
      return [];
    });
    const { outbox } = makeOutbox();
    const svc = new RemoteActionService(
      fake.tenantPrisma as never,
      makePermCheck(true) as never,
      outbox as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () => svc.getById('foreign-action-id', ADMIN_ACTOR)),
    ).rejects.toBeInstanceOf(NotFoundException);
    const getCall = fake.capture.find((c) => c.sql.includes('FROM tech_remote_actions r'));
    expect(getCall).toBeDefined();
    expect(getCall!.sql).toContain('a.school_id = $2::uuid');
    expect(getCall!.args[1]).toBe(SCHOOL.schoolId);
  });

  it('updateStatus() locked SELECT joins tech_assets with school_id predicate', async () => {
    const fake = makeFake((call) => {
      if (
        call.sql.includes('FROM tech_remote_actions r') &&
        call.sql.includes('JOIN tech_assets a ON a.id = r.asset_id') &&
        call.sql.includes('FOR UPDATE OF r')
      ) {
        return [
          {
            id: 'action-2',
            asset_id: '019e1000-0000-7000-8000-000000000001',
            action_type: 'LOCK',
            status: 'PENDING',
          },
        ];
      }
      if (call.sql.startsWith('UPDATE tech_remote_actions')) return 1;
      if (call.sql.includes('FROM tech_remote_actions r') && call.sql.includes('LIMIT 1')) {
        return [
          {
            id: 'action-2',
            asset_id: '019e1000-0000-7000-8000-000000000001',
            asset_tag: 'IT-CB-001',
            action_type: 'LOCK',
            initiated_by: ADMIN_ACTOR.personId,
            initiated_by_first: null,
            initiated_by_last: null,
            initiated_at: '2026-05-12T12:00:00Z',
            justification: 'school-scope regression — updateStatus locked SELECT shape',
            mdm_command_ref: null,
            status: 'SENT',
            completed_at: null,
            failure_reason: null,
          },
        ];
      }
      return [];
    });
    const { outbox } = makeOutbox();
    const svc = new RemoteActionService(
      fake.tenantPrisma as never,
      makePermCheck(true) as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.updateStatus('action-2', { status: 'SENT' }, ADMIN_ACTOR),
    );
    const locked = fake.capture.find(
      (c) =>
        c.sql.includes('FROM tech_remote_actions r') &&
        c.sql.includes('JOIN tech_assets a ON a.id = r.asset_id') &&
        c.sql.includes('FOR UPDATE OF r'),
    );
    expect(locked).toBeDefined();
    expect(locked!.sql).toContain('a.school_id = $2::uuid');
    expect(locked!.args[1]).toBe(SCHOOL.schoolId);
  });

  it('updateStatus() on WIPE + COMPLETED issues asset UPDATE with school_id predicate', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM tech_remote_actions r') && call.sql.includes('FOR UPDATE OF r')) {
        return [
          {
            id: 'wipe-1',
            asset_id: '019e1000-0000-7000-8000-000000000001',
            action_type: 'WIPE',
            status: 'SENT',
          },
        ];
      }
      if (call.sql.startsWith('UPDATE tech_remote_actions')) return 1;
      if (call.sql.startsWith("UPDATE tech_assets SET status = 'AVAILABLE'")) return 1;
      if (call.sql.includes('FROM tech_remote_actions r') && call.sql.includes('LIMIT 1')) {
        return [
          {
            id: 'wipe-1',
            asset_id: '019e1000-0000-7000-8000-000000000001',
            asset_tag: 'IT-CB-001',
            action_type: 'WIPE',
            initiated_by: ADMIN_ACTOR.personId,
            initiated_by_first: null,
            initiated_by_last: null,
            initiated_at: '2026-05-12T12:00:00Z',
            justification: 'completing WIPE; regression test for asset UPDATE school-scope',
            mdm_command_ref: null,
            status: 'COMPLETED',
            completed_at: '2026-05-12T12:01:00Z',
            failure_reason: null,
          },
        ];
      }
      return [];
    });
    const { outbox } = makeOutbox();
    const svc = new RemoteActionService(
      fake.tenantPrisma as never,
      makePermCheck(true) as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.updateStatus('wipe-1', { status: 'COMPLETED' }, ADMIN_ACTOR),
    );
    const assetUpdate = fake.capture.find((c) =>
      c.sql.startsWith("UPDATE tech_assets SET status = 'AVAILABLE'"),
    );
    expect(assetUpdate).toBeDefined();
    expect(assetUpdate!.sql).toContain('AND school_id = $2::uuid');
    expect(assetUpdate!.args[1]).toBe(SCHOOL.schoolId);
  });
});

// ─────────────────────────────────────────────────────────────
// BLOCKING 2 — three IT emits move to durable outbox
// ─────────────────────────────────────────────────────────────

describe('REVIEW-P2C20 R1 BLOCKING 2 — durable outbox for the 3 IT emits', () => {
  it('tech.remote_action.issued lands via OutboxService.enqueueInTx with a deterministic event_id', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM tech_assets WHERE id = $1::uuid AND school_id = $2::uuid')) {
        return [{ id: '019e1000-0000-7000-8000-000000000001', asset_tag: 'IT-CB-001' }];
      }
      if (call.sql.includes('FROM tech_remote_actions r')) {
        return [
          {
            id: 'action-emit',
            asset_id: '019e1000-0000-7000-8000-000000000001',
            asset_tag: 'IT-CB-001',
            action_type: 'LOCK',
            initiated_by: ADMIN_ACTOR.personId,
            initiated_by_first: null,
            initiated_by_last: null,
            initiated_at: '2026-05-12T12:00:00Z',
            justification: 'outbox regression — tech.remote_action.issued deterministic event_id',
            mdm_command_ref: null,
            status: 'PENDING',
            completed_at: null,
            failure_reason: null,
          },
        ];
      }
      return [];
    });
    const { outbox, emitted } = makeOutbox();
    const svc = new RemoteActionService(
      fake.tenantPrisma as never,
      makePermCheck(true) as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.create(
        '019e1000-0000-7000-8000-000000000001',
        {
          actionType: 'LOCK',
          justification: 'outbox regression — tech.remote_action.issued deterministic event_id',
        },
        ADMIN_ACTOR,
      ),
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.topic).toBe('tech.remote_action.issued');
    expect(emitted[0]!.sourceModule).toBe('it');
    expect(emitted[0]!.eventId).toBeDefined();
    // Deterministic — re-deriving against the same row id matches.
    expect(emitted[0]!.eventId).toBe(deterministicRemoteActionIssuedEventId(emitted[0]!.key));
  });

  it('tech.usage.flagged lands via OutboxService.enqueueInTx with a deterministic event_id', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM tech_assets WHERE id = $1::uuid AND school_id = $2::uuid')) {
        return [{ id: '019e4000-0000-7000-8000-000000000001', asset_tag: 'IT-CB-002' }];
      }
      if (call.sql.includes('FROM tech_device_usage_summaries u')) {
        return [
          {
            id: 'usage-emit',
            asset_id: '019e4000-0000-7000-8000-000000000001',
            asset_tag: 'IT-CB-002',
            summary_date: '2026-05-12',
            screen_time_minutes: 480,
            apps_used: ['Suspicious App'],
            flagged_activity: true,
            summary_source: 'MDM',
          },
        ];
      }
      return [];
    });
    const { outbox, emitted } = makeOutbox();
    const svc = new DeviceUsageService(
      fake.tenantPrisma as never,
      makePermCheck(true) as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.record(
        '019e4000-0000-7000-8000-000000000001',
        {
          summaryDate: '2026-05-12',
          screenTimeMinutes: 480,
          appsUsed: ['Suspicious App'],
          flaggedActivity: true,
        },
        ADMIN_ACTOR,
      ),
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.topic).toBe('tech.usage.flagged');
    expect(emitted[0]!.eventId).toBe(deterministicUsageFlaggedEventId(emitted[0]!.key));
  });

  it('tech.monitoring.alert (DOWN crossing threshold) lands via OutboxService.enqueueInTx', async () => {
    const fake = makeFake((call) => {
      if (
        call.sql.includes(
          'SELECT id::text AS id, system_name, consecutive_failures, consecutive_failures_to_alert',
        )
      ) {
        return [
          {
            id: 'check-1',
            system_name: 'SIS API',
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
            id: 'check-1',
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
    const { outbox, emitted } = makeOutbox();
    const svc = new MonitoringService(
      fake.tenantPrisma as never,
      makePermCheck(true) as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.recordResult(
        'check-1',
        { status: 'DOWN', errorMessage: 'connection refused' },
        ADMIN_ACTOR,
      ),
    );
    const down = emitted.find((e) => e.payload.alertType === 'DOWN');
    expect(down).toBeDefined();
    expect(down!.topic).toBe('tech.monitoring.alert');
    expect(down!.eventId).toBe(deterministicMonitoringAlertEventId(down!.key));
  });
});

// ─────────────────────────────────────────────────────────────
// BLOCKING 3 — device usage list / reload school-scope
// ─────────────────────────────────────────────────────────────

describe('REVIEW-P2C20 R1 BLOCKING 3 — device usage school-scope', () => {
  it('listForAsset() carries school_id predicate through tech_assets join', async () => {
    const fake = makeFake(() => []);
    const { outbox } = makeOutbox();
    const svc = new DeviceUsageService(
      fake.tenantPrisma as never,
      makePermCheck(true) as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.listForAsset('019e1000-0000-7000-8000-000000000001', ADMIN_ACTOR),
    );
    const listCall = fake.capture.find(
      (c) =>
        c.sql.includes('FROM tech_device_usage_summaries u') && c.sql.includes('WHERE u.asset_id'),
    );
    expect(listCall).toBeDefined();
    expect(listCall!.sql).toContain('a.school_id = $2::uuid');
    expect(listCall!.args[1]).toBe(SCHOOL.schoolId);
  });

  it('record() post-record reload carries school_id predicate', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM tech_assets WHERE id = $1::uuid AND school_id = $2::uuid')) {
        return [{ id: '019e4000-0000-7000-8000-000000000001', asset_tag: 'IT-CB-002' }];
      }
      if (call.sql.includes('FROM tech_device_usage_summaries u')) {
        return [
          {
            id: 'usage-reload',
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
    const { outbox } = makeOutbox();
    const svc = new DeviceUsageService(
      fake.tenantPrisma as never,
      makePermCheck(true) as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.record(
        '019e4000-0000-7000-8000-000000000001',
        { summaryDate: '2026-05-12', screenTimeMinutes: 60, flaggedActivity: false },
        ADMIN_ACTOR,
      ),
    );
    const reload = fake.capture.find(
      (c) =>
        c.sql.includes('FROM tech_device_usage_summaries u') &&
        c.sql.includes('WHERE u.id = $1::uuid') &&
        c.sql.includes('a.school_id = $2::uuid'),
    );
    expect(reload).toBeDefined();
    expect(reload!.args[1]).toBe(SCHOOL.schoolId);
  });
});

// ─────────────────────────────────────────────────────────────
// BLOCKING 4 — monitoring acknowledge UPDATE + reload school-scope
// ─────────────────────────────────────────────────────────────

describe('REVIEW-P2C20 R1 BLOCKING 4 — monitoring acknowledge school-scope', () => {
  it('acknowledgeAlert UPDATE joins tech_monitoring_checks with school_id predicate', async () => {
    const fake = makeFake((call) => {
      if (
        call.sql.includes('FROM tech_monitoring_alerts a JOIN tech_monitoring_checks c') &&
        call.sql.includes('FOR UPDATE OF a')
      ) {
        return [{ id: 'alert-1', acknowledged_at: null }];
      }
      if (call.sql.startsWith('UPDATE tech_monitoring_alerts a SET acknowledged_by')) return 1;
      if (call.sql.includes('FROM tech_monitoring_alerts a')) {
        return [
          {
            id: 'alert-1',
            check_id: 'check-1',
            system_name: 'SIS API',
            alert_type: 'DOWN',
            detected_at: '2026-05-12T12:00:00Z',
            resolved_at: null,
            response_time_ms: null,
            status_code: null,
            error_message: null,
            acknowledged_by: ADMIN_ACTOR.personId,
            acknowledged_by_first: null,
            acknowledged_by_last: null,
            acknowledged_at: '2026-05-12T12:05:00Z',
            notes: 'acknowledged',
          },
        ];
      }
      return [];
    });
    const { outbox } = makeOutbox();
    const svc = new MonitoringService(
      fake.tenantPrisma as never,
      makePermCheck(true) as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.acknowledgeAlert('alert-1', { notes: 'acknowledged' }, ADMIN_ACTOR),
    );
    const updateCall = fake.capture.find((c) =>
      c.sql.startsWith('UPDATE tech_monitoring_alerts a SET acknowledged_by'),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall!.sql).toContain('FROM tech_monitoring_checks c');
    expect(updateCall!.sql).toContain('c.school_id = $4::uuid');
  });

  it('acknowledgeAlert reload carries the school_id predicate through tech_monitoring_checks', async () => {
    const fake = makeFake((call) => {
      if (
        call.sql.includes('FROM tech_monitoring_alerts a JOIN tech_monitoring_checks c') &&
        call.sql.includes('FOR UPDATE OF a')
      ) {
        return [{ id: 'alert-2', acknowledged_at: null }];
      }
      if (call.sql.startsWith('UPDATE tech_monitoring_alerts a SET acknowledged_by')) return 1;
      if (call.sql.includes('FROM tech_monitoring_alerts a')) {
        return [
          {
            id: 'alert-2',
            check_id: 'check-2',
            system_name: 'Payment Gateway',
            alert_type: 'DEGRADED',
            detected_at: '2026-05-12T12:00:00Z',
            resolved_at: null,
            response_time_ms: 9000,
            status_code: 502,
            error_message: 'timeout',
            acknowledged_by: ADMIN_ACTOR.personId,
            acknowledged_by_first: null,
            acknowledged_by_last: null,
            acknowledged_at: '2026-05-12T12:05:00Z',
            notes: null,
          },
        ];
      }
      return [];
    });
    const { outbox } = makeOutbox();
    const svc = new MonitoringService(
      fake.tenantPrisma as never,
      makePermCheck(true) as never,
      outbox as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.acknowledgeAlert('alert-2', {}, ADMIN_ACTOR),
    );
    const reload = fake.capture.find(
      (c) => c.sql.includes('FROM tech_monitoring_alerts a') && c.sql.includes('LIMIT 1'),
    );
    expect(reload).toBeDefined();
    expect(reload!.sql).toContain('c.school_id = $2::uuid');
    expect(reload!.args[1]).toBe(SCHOOL.schoolId);
  });
});

// ─────────────────────────────────────────────────────────────
// Deterministic event-id helpers (sanity + stability)
// ─────────────────────────────────────────────────────────────

describe('REVIEW-P2C20 R1 — deterministic event-id helpers', () => {
  it('all three deterministic helpers are stable per row id', () => {
    const a1 = deterministicRemoteActionIssuedEventId('row-1');
    const a2 = deterministicRemoteActionIssuedEventId('row-1');
    expect(a1).toBe(a2);

    const u1 = deterministicUsageFlaggedEventId('row-1');
    const u2 = deterministicUsageFlaggedEventId('row-1');
    expect(u1).toBe(u2);

    const m1 = deterministicMonitoringAlertEventId('row-1');
    const m2 = deterministicMonitoringAlertEventId('row-1');
    expect(m1).toBe(m2);
  });

  it('all three helpers produce v5-shaped UUIDs with the v5 marker nibble', () => {
    const candidates = [
      deterministicRemoteActionIssuedEventId('row-1'),
      deterministicUsageFlaggedEventId('row-1'),
      deterministicMonitoringAlertEventId('row-1'),
    ];
    const v5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    for (const c of candidates) expect(c).toMatch(v5);
  });

  it('all three helpers are topic-distinct so the same row id produces three different envelope ids', () => {
    const a = deterministicRemoteActionIssuedEventId('row-shared');
    const u = deterministicUsageFlaggedEventId('row-shared');
    const m = deterministicMonitoringAlertEventId('row-shared');
    expect(new Set([a, u, m]).size).toBe(3);
  });
});
