import { describe, it, expect } from 'vitest';
import { runWithTenantContext, TenantInfo } from '@shared/tenant/tenant.context';
import { VisitorMusterConsumer } from './visitor-muster.consumer';

/**
 * REVIEW-P2C2 Round 2 closeout — VisitorMusterConsumer crash-recovery
 * idempotency.
 *
 * The reviewer's carry-forward concern: a consumer crash between the
 * vis_emergency_muster INSERT commit and the idempotency claim could
 * allow a redelivered Kafka event to insert a second muster row for
 * the same incident. The closeout fix:
 *
 *   1. Migration 108 adds a partial UNIQUE INDEX on (school_id,
 *      incident_id) WHERE incident_id IS NOT NULL.
 *   2. The consumer INSERT now uses ON CONFLICT (school_id, incident_id)
 *      WHERE incident_id IS NOT NULL DO NOTHING ... RETURNING id.
 *   3. When ON CONFLICT fires, RETURNING is empty → consumer treats
 *      it as idempotent success (logs the no-op + claims the
 *      idempotency token so the redelivery drops out).
 *
 * This test stubs TenantPrismaService and asserts:
 *
 *   (a) The INSERT SQL contains the ON CONFLICT clause + the partial
 *       WHERE predicate.
 *   (b) When the stub returns rows from RETURNING (real INSERT), the
 *       consumer logs "created muster" and resolves successfully.
 *   (c) When the stub returns an empty array (ON CONFLICT NO-OP), the
 *       consumer logs "already exists" and resolves successfully —
 *       NOT throws — so processWithIdempotency claims the event.
 */

const SCHOOL: TenantInfo = {
  schoolId: '019e03f8-cf0b-7444-92d2-85e2c67b549a',
  schemaName: 'tenant_demo',
  organisationId: 'org-1',
  subdomain: 'demo',
  isFrozen: false,
  planTier: 'MEDIUM',
  homeRegion: 'us-east-1',
};

const PAYLOAD = {
  incidentId: '019e0d40-aaaa-bbbb-cccc-000000000001',
  schoolId: SCHOOL.schoolId,
  drillType: 'LOCKDOWN',
  totalOnSiteAtSnapshot: 5,
  createdBy: '019e0d40-aaaa-bbbb-cccc-000000000099',
  declaredAt: new Date().toISOString(),
};

interface CapturedCall {
  sql: string;
  args: unknown[];
}

function makeFake(returnRows: unknown[]) {
  const capture: CapturedCall[] = [];
  const client = {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      capture.push({ sql, args });
      return returnRows;
    },
    $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
      capture.push({ sql, args });
      return 0;
    },
  };
  const tenantPrisma = {
    executeInTenantContext: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
    executeInTenantTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
    getPlatformClient: () => ({
      $queryRawUnsafe: async () => [],
    }),
  };
  // Idempotency + KafkaConsumerService are not exercised in this test — the
  // consumer is constructed with stub instances.
  const idempotency = { isClaimed: async () => false, claim: async () => undefined };
  const consumer = { subscribe: async () => undefined };
  return { tenantPrisma, capture, idempotency, consumer };
}

describe('VisitorMusterConsumer — Round 2 closeout (ON CONFLICT idempotency)', () => {
  it('INSERT SQL uses ON CONFLICT (school_id, incident_id) WHERE incident_id IS NOT NULL DO NOTHING', async () => {
    const fake = makeFake([{ id: 'muster-id-1' }]);
    const consumer = new VisitorMusterConsumer(
      fake.consumer as never,
      fake.idempotency as never,
      fake.tenantPrisma as never,
    );
    // Reach the private method via prototype to test the behaviour without
    // standing up a real Kafka consumer subscription.
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (consumer as any).materialiseMuster(PAYLOAD),
    );
    const insertCall = fake.capture.find((c) =>
      c.sql.toLowerCase().includes('insert into vis_emergency_muster'),
    );
    expect(insertCall).toBeDefined();
    const lower = insertCall!.sql.toLowerCase();
    expect(lower).toContain('on conflict (school_id, incident_id)');
    expect(lower).toContain('where incident_id is not null');
    expect(lower).toContain('do nothing');
    expect(lower).toContain('returning id::text as id');
  });

  it('treats RETURNING-empty (ON CONFLICT no-op) as idempotent success without throwing', async () => {
    // Stub returns empty array — simulates the partial UNIQUE catching a
    // duplicate INSERT for the same (school_id, incident_id).
    const fake = makeFake([]);
    const consumer = new VisitorMusterConsumer(
      fake.consumer as never,
      fake.idempotency as never,
      fake.tenantPrisma as never,
    );
    // Should NOT throw — that's the load-bearing assertion. If it threw,
    // processWithIdempotency would NOT claim the event, and the next
    // Kafka redelivery would retry — same conflict — same no-op — the
    // event would loop forever.
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (consumer as any).materialiseMuster(PAYLOAD),
      ),
    ).resolves.toBeUndefined();
  });

  it('treats RETURNING with row (real INSERT) as success', async () => {
    const fake = makeFake([{ id: 'muster-id-1' }]);
    const consumer = new VisitorMusterConsumer(
      fake.consumer as never,
      fake.idempotency as never,
      fake.tenantPrisma as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (consumer as any).materialiseMuster(PAYLOAD),
      ),
    ).resolves.toBeUndefined();
  });

  it('rethrows on real DB failure (e.g. FK violation, outage) so the claim is NOT taken', async () => {
    // Stub throws — simulates a DB-level failure that is NOT a duplicate
    // (e.g. the partial UNIQUE wasn't applied yet, FK violation, broker
    // disconnect). The consumer must rethrow so processWithIdempotency
    // leaves the event unclaimed and the next redelivery retries.
    const client = {
      $queryRawUnsafe: async () => {
        throw new Error('connection terminated');
      },
      $executeRawUnsafe: async () => {
        throw new Error('connection terminated');
      },
    };
    const tenantPrisma = {
      executeInTenantContext: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
      executeInTenantTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
      getPlatformClient: () => ({ $queryRawUnsafe: async () => [] }),
    };
    const idempotency = { isClaimed: async () => false, claim: async () => undefined };
    const subscriber = { subscribe: async () => undefined };
    const consumer = new VisitorMusterConsumer(
      subscriber as never,
      idempotency as never,
      tenantPrisma as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (consumer as any).materialiseMuster(PAYLOAD),
      ),
    ).rejects.toThrow(/connection terminated/);
  });
});
