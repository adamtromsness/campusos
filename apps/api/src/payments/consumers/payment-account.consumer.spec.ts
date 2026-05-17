import { describe, it, expect } from 'vitest';
import { PaymentAccountWorker } from './payment-account.consumer';

/**
 * P2-H4 test coverage uplift — payments/consumers/payment-account.consumer.ts
 * (263 LOC, Tier 1 Financial; keystone consumer closing the
 * enrolment→payments event loop. Subscribes to enr.student.enrolled
 * under payment-account-worker group + UPSERTs pay_family_accounts +
 * links sis_students when row exists).
 *
 * Tests cover:
 *   - onModuleInit subscribes with prefixed topic + correct group
 *   - drop on missing applicationId / schoolId
 *   - drop with WARN when guardianPersonId is null (admin-submitted)
 *   - drop on missing event_id / tenant_id
 *   - happy path NEW family account: advisory lock + INSERT with
 *     auto-allocated FA-#### number from MAX+1 + link to sis_students
 *   - happy path EXISTING family account: reuses + skips advisory lock
 *   - sis_students missing → family account created, link skipped
 *   - duplicate UNIQUE on link (23505) swallowed gracefully
 *   - non-23505 link error rethrows unchanged
 *   - already-claimed events skip the work
 *   - account number defaults to 1001 when no existing accounts
 *   - account number increments correctly from existing FA-####
 */

interface ConsumedMessage {
  topic: string;
  payload: unknown;
  headers: Record<string, string>;
}

interface FakeTenantOpts {
  rowsForExisting?: Array<{ id: string }>;
  rowsForStudent?: Array<{ id: string }>;
  rowsForMaxNum?: Array<{ max_num: number }>;
  insertLinkFail?: { code?: string; message?: string };
}

function makeFakeTenant(opts: FakeTenantOpts = {}) {
  const calls: Array<{ sql: string; args: unknown[]; fn: 'q' | 'e' }> = [];
  const client = {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      calls.push({ sql, args, fn: 'q' });
      const s = sql.toLowerCase();
      if (s.includes('select id from pay_family_accounts where school_id =')) {
        return opts.rowsForExisting ?? [];
      }
      if (s.includes('from sis_students s')) {
        return opts.rowsForStudent ?? [];
      }
      if (s.includes('select coalesce(max(')) {
        return opts.rowsForMaxNum ?? [{ max_num: 1000 }];
      }
      return [];
    },
    $executeRawUnsafe: async (sql: string, ..._args: unknown[]) => {
      calls.push({ sql, args: _args, fn: 'e' });
      const s = sql.toLowerCase();
      if (s.startsWith('insert into pay_family_account_students') && opts.insertLinkFail) {
        const err = new Error(opts.insertLinkFail.message ?? 'fail') as Error & { code?: string };
        if (opts.insertLinkFail.code) err.code = opts.insertLinkFail.code;
        throw err;
      }
      return 1;
    },
  };
  const tenantPrisma = {
    executeInTenantTransaction: async <T>(fn: (c: unknown) => Promise<T>) => fn(client),
  };
  return { tenantPrisma, calls };
}

function makeConsumerHarness() {
  let subscribed: { topics: string[]; groupId: string; handler: (m: ConsumedMessage) => Promise<void> } | null = null;
  return {
    consumer: {
      subscribe: async (args: { topics: string[]; groupId: string; handler: (m: ConsumedMessage) => Promise<void> }) => {
        subscribed = args;
      },
    },
    getSubscription: () => subscribed,
  };
}

function makeIdempotency(opts: { alreadyClaimed?: boolean } = {}) {
  const claimedKeys: Array<{ group: string; eventId: string; topic: string }> = [];
  return {
    claimedKeys,
    isClaimed: async () => opts.alreadyClaimed ?? false,
    claim: async (group: string, eventId: string, topic: string) => {
      claimedKeys.push({ group, eventId, topic });
    },
  };
}

function makeMessage(overrides: Partial<{ payload: Record<string, unknown>; topic: string }> = {}): ConsumedMessage {
  return {
    topic: 'dev.enr.student.enrolled',
    payload: {
      event_id: '019ee000-2222-7222-8222-222222222222',
      tenant_id: 'sch-1',
      payload: {
        applicationId: 'app-1',
        offerId: 'offer-1',
        schoolId: 'sch-1',
        enrollmentPeriodId: 'period-1',
        studentFirstName: 'Maya',
        studentLastName: 'Chen',
        studentDateOfBirth: '2011-03-15',
        gradeLevel: '9',
        admissionType: 'NEW_STUDENT',
        guardianPersonId: 'pers-david',
        guardianEmail: 'parent@demo.campusos.dev',
        enrolledAt: '2026-04-28T10:00:00Z',
        ...overrides.payload,
      },
    },
    headers: { 'tenant-subdomain': 'demo' },
    topic: overrides.topic ?? 'dev.enr.student.enrolled',
  };
}

describe('PaymentAccountWorker.onModuleInit', () => {
  it('subscribes with prefixed topic + payment-account-worker group', async () => {
    const { consumer, getSubscription } = makeConsumerHarness();
    const idem = makeIdempotency();
    const { tenantPrisma } = makeFakeTenant();
    const w = new PaymentAccountWorker(consumer as never, idem as never, tenantPrisma as never);
    await w.onModuleInit();
    const sub = getSubscription();
    expect(sub).toBeTruthy();
    expect(sub!.topics[0]).toMatch(/enr\.student\.enrolled$/);
    expect(sub!.groupId).toBe('payment-account-worker');
  });
});

describe('PaymentAccountWorker.handle (via onModuleInit subscription)', () => {
  it('drops on missing applicationId', async () => {
    const { consumer, getSubscription } = makeConsumerHarness();
    const idem = makeIdempotency();
    const { tenantPrisma, calls } = makeFakeTenant();
    const w = new PaymentAccountWorker(consumer as never, idem as never, tenantPrisma as never);
    await w.onModuleInit();
    const msg = makeMessage();
    const inner = (msg.payload as { payload: Record<string, unknown> }).payload;
    delete inner.applicationId;
    await getSubscription()!.handler(msg);
    expect(calls.length).toBe(0);
    expect(idem.claimedKeys.length).toBe(0);
  });

  it('drops on missing schoolId', async () => {
    const { consumer, getSubscription } = makeConsumerHarness();
    const idem = makeIdempotency();
    const { tenantPrisma, calls } = makeFakeTenant();
    const w = new PaymentAccountWorker(consumer as never, idem as never, tenantPrisma as never);
    await w.onModuleInit();
    const msg = makeMessage();
    const inner = (msg.payload as { payload: Record<string, unknown> }).payload;
    delete inner.schoolId;
    await getSubscription()!.handler(msg);
    expect(calls.length).toBe(0);
  });

  it('drops on guardianPersonId=null (admin-submitted application path)', async () => {
    const { consumer, getSubscription } = makeConsumerHarness();
    const idem = makeIdempotency();
    const { tenantPrisma, calls } = makeFakeTenant();
    const w = new PaymentAccountWorker(consumer as never, idem as never, tenantPrisma as never);
    await w.onModuleInit();
    const msg = makeMessage();
    const inner = (msg.payload as { payload: Record<string, unknown> }).payload;
    inner.guardianPersonId = null;
    await getSubscription()!.handler(msg);
    expect(calls.length).toBe(0);
    expect(idem.claimedKeys.length).toBe(0);
  });

  it('drops on missing event_id / tenant_id', async () => {
    const { consumer, getSubscription } = makeConsumerHarness();
    const idem = makeIdempotency();
    const { tenantPrisma, calls } = makeFakeTenant();
    const w = new PaymentAccountWorker(consumer as never, idem as never, tenantPrisma as never);
    await w.onModuleInit();
    const msg: ConsumedMessage = {
      topic: 'dev.enr.student.enrolled',
      payload: { payload: { applicationId: 'app-1', schoolId: 'sch-1', guardianPersonId: 'p' } },
      headers: { 'tenant-subdomain': 'demo' }, // no event-id / tenant-id
    };
    await getSubscription()!.handler(msg);
    expect(calls.length).toBe(0);
  });

  it('NEW account happy path: advisory lock + INSERT with FA-1001 + link student', async () => {
    const { consumer, getSubscription } = makeConsumerHarness();
    const idem = makeIdempotency();
    const { tenantPrisma, calls } = makeFakeTenant({
      rowsForExisting: [],
      rowsForStudent: [{ id: 'stu-maya' }],
      rowsForMaxNum: [{ max_num: 1000 }],
    });
    const w = new PaymentAccountWorker(consumer as never, idem as never, tenantPrisma as never);
    await w.onModuleInit();
    await getSubscription()!.handler(makeMessage());
    // Verify the sequence: existing-check → advisory lock → MAX lookup → INSERT family → student lookup → INSERT link
    const lockCall = calls.find((c) => c.sql.toLowerCase().includes('pg_advisory_xact_lock'));
    expect(lockCall).toBeTruthy();
    expect(lockCall!.args[0]).toBe('sch-1');
    const familyInsert = calls.find((c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_family_accounts'));
    expect(familyInsert).toBeTruthy();
    expect(familyInsert!.args).toContain('FA-1001'); // 1000 + 1
    const linkInsert = calls.find((c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_family_account_students'));
    expect(linkInsert).toBeTruthy();
    expect(linkInsert!.args[2]).toBe('stu-maya');
    // Idempotency claim after success
    expect(idem.claimedKeys.length).toBe(1);
    expect(idem.claimedKeys[0]!.group).toBe('payment-account-worker');
  });

  it('EXISTING account: skips advisory lock + INSERT, reuses id, still links student', async () => {
    const { consumer, getSubscription } = makeConsumerHarness();
    const idem = makeIdempotency();
    const { tenantPrisma, calls } = makeFakeTenant({
      rowsForExisting: [{ id: 'fa-1' }],
      rowsForStudent: [{ id: 'stu-maya' }],
    });
    const w = new PaymentAccountWorker(consumer as never, idem as never, tenantPrisma as never);
    await w.onModuleInit();
    await getSubscription()!.handler(makeMessage());
    const lockCall = calls.find((c) => c.sql.toLowerCase().includes('pg_advisory_xact_lock'));
    expect(lockCall).toBeUndefined();
    const familyInsert = calls.find((c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_family_accounts'));
    expect(familyInsert).toBeUndefined();
    const linkInsert = calls.find((c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_family_account_students'));
    expect(linkInsert).toBeTruthy();
    expect(linkInsert!.args[1]).toBe('fa-1');
  });

  it('sis_students missing → family account created, link skipped (no link insert)', async () => {
    const { consumer, getSubscription } = makeConsumerHarness();
    const idem = makeIdempotency();
    const { tenantPrisma, calls } = makeFakeTenant({
      rowsForExisting: [],
      rowsForStudent: [], // student not yet materialised
      rowsForMaxNum: [{ max_num: 1000 }],
    });
    const w = new PaymentAccountWorker(consumer as never, idem as never, tenantPrisma as never);
    await w.onModuleInit();
    await getSubscription()!.handler(makeMessage());
    const familyInsert = calls.find((c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_family_accounts'));
    expect(familyInsert).toBeTruthy();
    const linkInsert = calls.find((c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_family_account_students'));
    expect(linkInsert).toBeUndefined();
  });

  it('duplicate UNIQUE on link (23505 code) is swallowed', async () => {
    const { consumer, getSubscription } = makeConsumerHarness();
    const idem = makeIdempotency();
    const { tenantPrisma } = makeFakeTenant({
      rowsForExisting: [{ id: 'fa-1' }],
      rowsForStudent: [{ id: 'stu-maya' }],
      insertLinkFail: { code: '23505', message: 'duplicate key' },
    });
    const w = new PaymentAccountWorker(consumer as never, idem as never, tenantPrisma as never);
    await w.onModuleInit();
    await expect(getSubscription()!.handler(makeMessage())).resolves.toBeUndefined();
  });

  it('duplicate UNIQUE on link (message fragment) is swallowed', async () => {
    const { consumer, getSubscription } = makeConsumerHarness();
    const idem = makeIdempotency();
    const { tenantPrisma } = makeFakeTenant({
      rowsForExisting: [{ id: 'fa-1' }],
      rowsForStudent: [{ id: 'stu-maya' }],
      insertLinkFail: { message: 'duplicate key violates fa_students_uq' },
    });
    const w = new PaymentAccountWorker(consumer as never, idem as never, tenantPrisma as never);
    await w.onModuleInit();
    await expect(getSubscription()!.handler(makeMessage())).resolves.toBeUndefined();
  });

  it('non-23505 link insert error rethrows unchanged (event stays unclaimed for retry)', async () => {
    const { consumer, getSubscription } = makeConsumerHarness();
    const idem = makeIdempotency();
    const { tenantPrisma } = makeFakeTenant({
      rowsForExisting: [{ id: 'fa-1' }],
      rowsForStudent: [{ id: 'stu-maya' }],
      insertLinkFail: { message: 'connection refused' },
    });
    const w = new PaymentAccountWorker(consumer as never, idem as never, tenantPrisma as never);
    await w.onModuleInit();
    await expect(getSubscription()!.handler(makeMessage())).rejects.toThrow(/connection refused/);
    // Claim should NOT have fired (rethrow short-circuits claim-after-success)
    expect(idem.claimedKeys.length).toBe(0);
  });

  it('already-claimed events skip the entire workflow', async () => {
    const { consumer, getSubscription } = makeConsumerHarness();
    const idem = makeIdempotency({ alreadyClaimed: true });
    const { tenantPrisma, calls } = makeFakeTenant();
    const w = new PaymentAccountWorker(consumer as never, idem as never, tenantPrisma as never);
    await w.onModuleInit();
    await getSubscription()!.handler(makeMessage());
    expect(calls.length).toBe(0); // no DB work at all
    expect(idem.claimedKeys.length).toBe(0); // no re-claim
  });

  it('account number defaults to 1001 when no existing accounts (MAX returns 1000 sentinel)', async () => {
    const { consumer, getSubscription } = makeConsumerHarness();
    const idem = makeIdempotency();
    const { tenantPrisma, calls } = makeFakeTenant({
      rowsForExisting: [],
      rowsForStudent: [{ id: 'stu-maya' }],
      rowsForMaxNum: [{ max_num: 1000 }],
    });
    const w = new PaymentAccountWorker(consumer as never, idem as never, tenantPrisma as never);
    await w.onModuleInit();
    await getSubscription()!.handler(makeMessage());
    const familyInsert = calls.find((c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_family_accounts'));
    expect(familyInsert!.args).toContain('FA-1001');
  });

  it('account number increments from existing MAX', async () => {
    const { consumer, getSubscription } = makeConsumerHarness();
    const idem = makeIdempotency();
    const { tenantPrisma, calls } = makeFakeTenant({
      rowsForExisting: [],
      rowsForStudent: [{ id: 'stu-maya' }],
      rowsForMaxNum: [{ max_num: 1042 }],
    });
    const w = new PaymentAccountWorker(consumer as never, idem as never, tenantPrisma as never);
    await w.onModuleInit();
    await getSubscription()!.handler(makeMessage());
    const familyInsert = calls.find((c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_family_accounts'));
    expect(familyInsert!.args).toContain('FA-1043');
  });

  it('account number defaults to FA-1001 when MAX returns no row (defensive ?? path)', async () => {
    const { consumer, getSubscription } = makeConsumerHarness();
    const idem = makeIdempotency();
    const { tenantPrisma, calls } = makeFakeTenant({
      rowsForExisting: [],
      rowsForStudent: [{ id: 'stu-maya' }],
      rowsForMaxNum: [], // empty MAX result triggers the ?? 1000 fallback
    });
    const w = new PaymentAccountWorker(consumer as never, idem as never, tenantPrisma as never);
    await w.onModuleInit();
    await getSubscription()!.handler(makeMessage());
    const familyInsert = calls.find((c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_family_accounts'));
    expect(familyInsert!.args).toContain('FA-1001');
  });
});
