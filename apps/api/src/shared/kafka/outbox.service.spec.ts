import { describe, it, expect, beforeEach } from 'vitest';
import { OutboxService } from './outbox.service';
import { runWithTenantContext } from '@shared/tenant/tenant.context';

const TEST_TENANT = {
  schoolId: '019dff45-1234-7000-8000-000000000001',
  schemaName: 'tenant_demo',
  organisationId: null,
  subdomain: 'demo',
  isFrozen: false,
  planTier: 'STANDARD',
  homeRegion: 'us-east-1',
};

describe('OutboxService', () => {
  let svc: OutboxService;
  let executeRawCalls: Array<{ sql: string; args: unknown[] }>;
  let mockTx: { $executeRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown> };

  beforeEach(() => {
    svc = new OutboxService();
    executeRawCalls = [];
    mockTx = {
      $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
        executeRawCalls.push({ sql, args });
        return 1;
      },
    };
  });

  it('writes a single platform_outbox row with the wire-shape envelope', async () => {
    let id = '';
    await new Promise<void>((resolve) => {
      runWithTenantContext({ tenant: TEST_TENANT }, async () => {
        id = await svc.enqueueInTx(mockTx, {
          topic: 'dpo.breach.discovered',
          key: 'breach-id',
          payload: { foo: 'bar' },
          sourceModule: 'governance',
        });
        resolve();
      });
    });

    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(executeRawCalls).toHaveLength(1);
    expect(executeRawCalls[0]!.sql).toContain('INSERT INTO platform.platform_outbox');

    // Args order: id, topic, envelope JSON, message_key, tenant_id, source_module.
    const args = executeRawCalls[0]!.args;
    expect(args[1]).toBe('dpo.breach.discovered');
    expect(args[3]).toBe('breach-id');
    expect(args[4]).toBe('019dff45-1234-7000-8000-000000000001');
    expect(args[5]).toBe('governance');

    const envelopeJson = JSON.parse(args[2] as string);
    expect(envelopeJson.event_type).toBe('dpo.breach.discovered');
    expect(envelopeJson.source_module).toBe('governance');
    expect(envelopeJson.tenant_id).toBe('019dff45-1234-7000-8000-000000000001');
    expect(envelopeJson.payload).toEqual({ foo: 'bar' });
    // tenant_subdomain stashed for the worker.
    expect(envelopeJson.tenant_subdomain).toBe('demo');
  });

  it('honours explicit tenantId and tenantSubdomain (worker-originated path with no request context)', async () => {
    await svc.enqueueInTx(mockTx, {
      topic: 'svc.wellbeing.alert.created',
      key: 'response-id',
      payload: {},
      sourceModule: 'wellbeing',
      tenantId: '019dff45-1234-7000-8000-000000000099',
      tenantSubdomain: 'other-school',
    });

    const args = executeRawCalls[0]!.args;
    expect(args[4]).toBe('019dff45-1234-7000-8000-000000000099');
    const envelopeJson = JSON.parse(args[2] as string);
    expect(envelopeJson.tenant_subdomain).toBe('other-school');
    expect(envelopeJson.tenant_id).toBe('019dff45-1234-7000-8000-000000000099');
  });

  it('passes through correlationId when provided', async () => {
    await new Promise<void>((resolve) => {
      runWithTenantContext({ tenant: TEST_TENANT }, async () => {
        await svc.enqueueInTx(mockTx, {
          topic: 'msg.emergency.issued',
          key: 'alert-id',
          payload: {},
          sourceModule: 'communications',
          correlationId: 'request-corr-1',
        });
        resolve();
      });
    });
    const envelopeJson = JSON.parse(executeRawCalls[0]!.args[2] as string);
    expect(envelopeJson.correlation_id).toBe('request-corr-1');
  });
});
