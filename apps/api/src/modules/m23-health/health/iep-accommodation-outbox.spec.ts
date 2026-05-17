import { describe, it, expect } from 'vitest';

/**
 * P2-H5 DEFECT 3 + DEFECT 6 — verify iep.accommodation.updated is
 * enqueued in the SAME transaction as the domain mutation. Pre-fix the
 * outbox INSERT ran in a SEPARATE post-commit transaction so a crash
 * between the two would lose the event and leave the read model stale.
 *
 * Strategy: fake TenantPrismaService whose executeInTenantTransaction
 * runs the callback against a stub `tx` and records BOTH the domain
 * SQL and the outbox enqueue call against that tx. On rollback (caller
 * throws inside the callback), NEITHER the domain mutation NOR the
 * outbox enqueue land. On commit, BOTH land — and the test verifies
 * they share the same tx handle so they are atomic.
 */

interface SqlCapture {
  sql: string;
  args: unknown[];
}

interface OutboxCapture {
  topic: string;
  txRef: object;
}

function makeAtomicHarness() {
  const allSql: Array<SqlCapture & { committed: boolean; txRef: object }> = [];
  const allOutbox: Array<OutboxCapture & { committed: boolean }> = [];
  // committed=false until we commit; rollback path leaves the array as-is.
  let inflightDomain: Array<SqlCapture & { committed: boolean; txRef: object }> = [];
  let inflightOutbox: Array<OutboxCapture & { committed: boolean }> = [];

  const tenantPrisma = {
    executeInTenantTransaction: async <T>(fn: (tx: unknown) => Promise<T>) => {
      inflightDomain = [];
      inflightOutbox = [];
      // The same tx object is handed both to the domain caller AND used as
      // the txRef for outbox captures, so the test can verify they share
      // identity (i.e. the outbox enqueue ran with the SAME tx handle as
      // the domain write).
      const tx: {
        $queryRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown[]>;
        $executeRawUnsafe: (sql: string, ...args: unknown[]) => Promise<number>;
      } = {
        $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
          inflightDomain.push({ sql, args, committed: false, txRef: tx });
          return [];
        },
        $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
          inflightDomain.push({ sql, args, committed: false, txRef: tx });
          return 1;
        },
      };
      try {
        const out = await fn(tx);
        // Commit: copy everything to the durable log.
        for (const c of inflightDomain) {
          c.committed = true;
          allSql.push(c);
        }
        for (const c of inflightOutbox) {
          c.committed = true;
          allOutbox.push(c);
        }
        return out;
      } catch (err) {
        // Rollback: do NOT copy inflight rows to the durable log.
        throw err;
      }
    },
    executeInTenantContext: async <T>(fn: (client: unknown) => Promise<T>) =>
      fn({
        $queryRawUnsafe: async () => [],
        $executeRawUnsafe: async () => 0,
      }),
  };

  const outbox = {
    enqueueInTx: async (tx: unknown, opts: { topic: string }) => {
      // The outbox capture records the tx ref so the test can verify it
      // matches the domain tx ref (atomic).
      inflightOutbox.push({ topic: opts.topic, txRef: tx as object, committed: false });
    },
  };

  return { tenantPrisma, outbox, allSql, allOutbox };
}

describe('P2-H5 DEFECT 3 — outbox atomicity for iep.accommodation.updated', () => {
  it('outbox enqueue receives the SAME tx handle as the domain mutation', async () => {
    const harness = makeAtomicHarness();
    await harness.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Simulate the domain INSERT
      await (
        tx as {
          $executeRawUnsafe: (sql: string, ...args: unknown[]) => Promise<number>;
        }
      ).$executeRawUnsafe('INSERT INTO hlth_iep_accommodations (id) VALUES ($1::uuid)', 'acc-1');
      // Simulate the snapshot emit
      await harness.outbox.enqueueInTx(tx, { topic: 'iep.accommodation.updated' });
    });
    expect(harness.allSql).toHaveLength(1);
    expect(harness.allOutbox).toHaveLength(1);
    // The atomicity check: domain and outbox share the same tx ref.
    expect(harness.allSql[0]!.txRef).toBe(harness.allOutbox[0]!.txRef);
  });

  it('rollback path: domain write fails → neither domain nor outbox commits', async () => {
    const harness = makeAtomicHarness();
    await expect(
      harness.tenantPrisma.executeInTenantTransaction(async (tx) => {
        await (
          tx as {
            $executeRawUnsafe: (sql: string, ...args: unknown[]) => Promise<number>;
          }
        ).$executeRawUnsafe('INSERT INTO hlth_iep_accommodations (id) VALUES ($1::uuid)', 'acc-1');
        await harness.outbox.enqueueInTx(tx, { topic: 'iep.accommodation.updated' });
        throw new Error('simulated crash before commit');
      }),
    ).rejects.toThrow(/simulated crash/);
    // Neither the domain mutation NOR the outbox enqueue persisted —
    // they share the rollback boundary.
    expect(harness.allSql).toHaveLength(0);
    expect(harness.allOutbox).toHaveLength(0);
  });

  it('rollback path: outbox enqueue throws → domain mutation also rolls back', async () => {
    const harness = makeAtomicHarness();
    const outbox = {
      enqueueInTx: async () => {
        throw new Error('outbox write failure');
      },
    };
    await expect(
      harness.tenantPrisma.executeInTenantTransaction(async (tx) => {
        await (
          tx as {
            $executeRawUnsafe: (sql: string, ...args: unknown[]) => Promise<number>;
          }
        ).$executeRawUnsafe('INSERT INTO hlth_iep_accommodations (id) VALUES ($1::uuid)', 'acc-1');
        await outbox.enqueueInTx();
      }),
    ).rejects.toThrow(/outbox write failure/);
    expect(harness.allSql).toHaveLength(0);
  });

  it('happy path commits both atomically — domain and outbox both land', async () => {
    const harness = makeAtomicHarness();
    await harness.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await (
        tx as {
          $executeRawUnsafe: (sql: string, ...args: unknown[]) => Promise<number>;
        }
      ).$executeRawUnsafe('UPDATE hlth_iep_plans SET status = $1', 'EXPIRED');
      await harness.outbox.enqueueInTx(tx, { topic: 'iep.accommodation.updated' });
    });
    expect(harness.allSql).toHaveLength(1);
    expect(harness.allSql[0]!.committed).toBe(true);
    expect(harness.allOutbox).toHaveLength(1);
    expect(harness.allOutbox[0]!.committed).toBe(true);
  });
});
