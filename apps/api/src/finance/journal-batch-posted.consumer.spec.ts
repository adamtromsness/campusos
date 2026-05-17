import { describe, it, expect } from 'vitest';
import { JournalBatchPostedConsumer } from './journal-batch-posted.consumer';

/**
 * P2-H4 test coverage uplift — journal-batch-posted.consumer.ts (231 LOC,
 * critical-path Tier 1 Financial ≥95%).
 *
 * REVIEW-P2C29 Round 1 BLOCKING 5 fix established the module boundary:
 * commerce JournalBatchService emits fin.journal_batch.posted; Finance owns
 * GL writes and this consumer materialises fin_gl_entries via
 * PostingService.createAndPost(). Idempotency is dual-layered:
 *   - processWithIdempotency claims event_id at consumer-group level
 *   - posting.createAndPost's UNIQUE on source_event_id catches Kafka
 *     redelivery and returns the existing batch
 *
 * Failure modes (per the consumer's docstring): empty lines → warn + drop,
 * lines > MAX_BATCH_LINES → throw, no CFO → throw, no fallback fund →
 * throw. The thrown errors propagate through processWithIdempotency which
 * leaves the event unclaimed; retry/DLQ takes over.
 */

const SCHOOL_ID = '019e03f8-cf0b-7444-92d2-85e2c67b549a';

interface SqlCapture {
  sql: string;
  args: unknown[];
}

function makeTenantPrisma(opts: {
  employees?: Array<{ employee_id: string; person_id: string; account_id: string | null }>;
  fundsByAccount?: Array<{ id: string; fund_id: string | null }>;
  fallbackFundIds?: string[];
}) {
  const captures: SqlCapture[] = [];
  const client = {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      captures.push({ sql, args });
      if (sql.includes('FROM hr_employees')) return opts.employees ?? [];
      if (sql.includes('FROM fin_chart_of_accounts')) return opts.fundsByAccount ?? [];
      if (sql.includes('FROM fin_funds')) return (opts.fallbackFundIds ?? []).map((id) => ({ id }));
      return [];
    },
    $executeRawUnsafe: async () => 0,
  };
  return {
    tenantPrisma: {
      executeInTenantContext: async <T>(fn: (c: unknown) => Promise<T>) => fn(client),
      executeInTenantTransaction: async <T>(fn: (c: unknown) => Promise<T>) => fn(client),
    },
    captures,
  };
}

interface PostingCalls {
  createAndPost: Array<{ actor: Record<string, unknown>; input: Record<string, unknown> }>;
}

function makePosting() {
  const calls: PostingCalls = { createAndPost: [] };
  return {
    posting: {
      createAndPost: async (actor: Record<string, unknown>, input: Record<string, unknown>) => {
        calls.createAndPost.push({ actor, input });
        return { id: 'batch-1' };
      },
    },
    calls,
  };
}

const SAMPLE_EMPLOYEE = {
  employee_id: 'emp-1',
  person_id: 'person-1',
  account_id: 'acct-1',
};

const SAMPLE_EVENT = {
  eventId: '019e03f8-aaaa-bbbb-cccc-000000000001',
  tenant: { schoolId: SCHOOL_ID, subdomain: 'demo' },
  payload: {
    batchId: '019e03f8-batchid-aaaaaaaaaaaaaaaaaaa',
    schoolId: SCHOOL_ID,
    batchName: 'Q3 Adjustments',
    entryCount: 2,
    totalDebits: 1000,
    totalCredits: 1000,
    postedBy: 'person-poster',
    sourceRefId: 'src-ref-1',
    lines: [
      {
        accountId: 'acct-cash',
        debit: 1000,
        credit: 0,
        description: 'Cash leg',
        lineOrder: 1,
      },
      {
        accountId: 'acct-revenue',
        debit: 0,
        credit: 1000,
        description: 'Revenue leg',
        lineOrder: 2,
      },
    ],
  },
};

function makeConsumer(opts: Parameters<typeof makeTenantPrisma>[0]) {
  const fake = makeTenantPrisma(opts);
  const posting = makePosting();
  const kafkaConsumer = { subscribe: async () => undefined };
  const idempotency = { isClaimed: async () => false, claim: async () => undefined };
  const consumer = new JournalBatchPostedConsumer(
    kafkaConsumer as never,
    idempotency as never,
    fake.tenantPrisma as never,
    posting.posting as never,
  );
  return { consumer, postingCalls: posting.calls, captures: fake.captures };
}

// Reach the private `process` method via prototype reflection so we can
// drive deterministic scenarios without standing up Kafka.
function processEvent(consumer: JournalBatchPostedConsumer, event: typeof SAMPLE_EVENT) {
  return (consumer as unknown as { process: (e: typeof SAMPLE_EVENT) => Promise<void> }).process(
    event,
  );
}

describe('JournalBatchPostedConsumer.process — happy path', () => {
  it('delegates to PostingService.createAndPost with the documented createAndPost shape', async () => {
    const { consumer, postingCalls } = makeConsumer({
      employees: [SAMPLE_EMPLOYEE],
      fundsByAccount: [
        { id: 'acct-cash', fund_id: 'fund-general' },
        { id: 'acct-revenue', fund_id: 'fund-general' },
      ],
      fallbackFundIds: ['fund-fallback'],
    });
    await processEvent(consumer, SAMPLE_EVENT);
    expect(postingCalls.createAndPost).toHaveLength(1);
    const { actor, input } = postingCalls.createAndPost[0];
    // Actor is the synthetic CFO: first ACTIVE employee, marked isSchoolAdmin.
    expect(actor.employeeId).toBe('emp-1');
    expect(actor.personType).toBe('STAFF');
    expect(actor.isSchoolAdmin).toBe(true);
    // Batch shape matches the consumer's contract.
    expect(input.sourceModule).toBe('commerce');
    expect(input.sourceEventId).toBe(SAMPLE_EVENT.eventId);
    expect(input.batchType).toBe('ADJUSTMENT');
    expect((input.batchNumber as string).startsWith('MAN-')).toBe(true);
    expect((input.batchNumber as string).length).toBe(12); // MAN- + 8 uppercase chars
    expect(input.description as string).toContain('Manual journal batch: Q3 Adjustments');
    expect(input.entries).toHaveLength(2);
    const firstLine = (input.entries as unknown as Array<Record<string, unknown>>)[0];
    expect(firstLine.accountId).toBe('acct-cash');
    expect(firstLine.fundId).toBe('fund-general'); // resolved per-account
    expect(firstLine.debit).toBe(1000);
    expect(firstLine.credit).toBe(0);
    expect(firstLine.description).toBe('Cash leg');
    expect(firstLine.referenceType).toBe('fin_journal_entry_batches');
    expect(firstLine.referenceId).toBe(SAMPLE_EVENT.payload.batchId);
  });

  it('falls back to the school fallback fund when account has no fund_id', async () => {
    const { consumer, postingCalls } = makeConsumer({
      employees: [SAMPLE_EMPLOYEE],
      fundsByAccount: [
        // acct-cash has no fund_id (null)
        { id: 'acct-cash', fund_id: null },
        { id: 'acct-revenue', fund_id: 'fund-general' },
      ],
      fallbackFundIds: ['fund-fallback'],
    });
    await processEvent(consumer, SAMPLE_EVENT);
    const entries = postingCalls.createAndPost[0].input.entries as unknown as Array<
      Record<string, unknown>
    >;
    expect(entries[0].fundId).toBe('fund-fallback'); // account had null fund_id → fallback
    expect(entries[1].fundId).toBe('fund-general'); // explicit per-account
  });

  it('converts string-typed debit/credit to Number (defensive)', async () => {
    const event = {
      ...SAMPLE_EVENT,
      payload: {
        ...SAMPLE_EVENT.payload,
        lines: [
          { accountId: 'a', debit: '500.00', credit: '0', description: null, lineOrder: 1 },
          { accountId: 'b', debit: 0, credit: '500.00', description: null, lineOrder: 2 },
        ],
      },
    };
    const { consumer, postingCalls } = makeConsumer({
      employees: [SAMPLE_EMPLOYEE],
      fundsByAccount: [
        { id: 'a', fund_id: 'f' },
        { id: 'b', fund_id: 'f' },
      ],
      fallbackFundIds: ['fund-fallback'],
    });
    await processEvent(consumer, event);
    const entries = postingCalls.createAndPost[0].input.entries as unknown as Array<
      Record<string, unknown>
    >;
    expect(entries[0].debit).toBe(500);
    expect(entries[1].credit).toBe(500);
  });

  it('uses account_id as the actor.accountId when the platform_users join hits', async () => {
    const { consumer, postingCalls } = makeConsumer({
      employees: [SAMPLE_EMPLOYEE],
      fundsByAccount: [
        { id: 'acct-cash', fund_id: 'f' },
        { id: 'acct-revenue', fund_id: 'f' },
      ],
      fallbackFundIds: ['fund-fallback'],
    });
    await processEvent(consumer, SAMPLE_EVENT);
    expect(postingCalls.createAndPost[0].actor.accountId).toBe('acct-1');
  });

  it('falls back to person_id when no platform_users row exists for the employee', async () => {
    const { consumer, postingCalls } = makeConsumer({
      employees: [{ ...SAMPLE_EMPLOYEE, account_id: null }],
      fundsByAccount: [
        { id: 'acct-cash', fund_id: 'f' },
        { id: 'acct-revenue', fund_id: 'f' },
      ],
      fallbackFundIds: ['fund-fallback'],
    });
    await processEvent(consumer, SAMPLE_EVENT);
    expect(postingCalls.createAndPost[0].actor.accountId).toBe('person-1');
  });
});

describe('JournalBatchPostedConsumer.process — failure modes (BLOCKING-class)', () => {
  it('drops the event with a warn when payload.lines is empty (no posting fired)', async () => {
    const event = { ...SAMPLE_EVENT, payload: { ...SAMPLE_EVENT.payload, lines: [] } };
    const { consumer, postingCalls } = makeConsumer({});
    await expect(processEvent(consumer, event)).resolves.toBeUndefined();
    expect(postingCalls.createAndPost).toHaveLength(0);
  });

  it('drops the event with a warn when payload.lines is not an array', async () => {
    const event = {
      ...SAMPLE_EVENT,
      payload: {
        ...SAMPLE_EVENT.payload,
        lines: null as unknown as typeof SAMPLE_EVENT.payload.lines,
      },
    };
    const { consumer, postingCalls } = makeConsumer({});
    await expect(processEvent(consumer, event)).resolves.toBeUndefined();
    expect(postingCalls.createAndPost).toHaveLength(0);
  });

  it('throws when payload.lines exceeds MAX_BATCH_LINES (CodeQL loop-bound guard)', async () => {
    const big = Array.from({ length: 1001 }, (_, i) => ({
      accountId: `acct-${i}`,
      debit: 1,
      credit: 0,
      description: null,
      lineOrder: i,
    }));
    const event = { ...SAMPLE_EVENT, payload: { ...SAMPLE_EVENT.payload, lines: big } };
    const { consumer, postingCalls } = makeConsumer({
      employees: [SAMPLE_EMPLOYEE],
      fallbackFundIds: ['fund-fallback'],
    });
    await expect(processEvent(consumer, event)).rejects.toThrow(/exceeds MAX_BATCH_LINES=1000/);
    expect(postingCalls.createAndPost).toHaveLength(0);
  });

  it('throws when no ACTIVE hr_employees row exists (no synthetic CFO available)', async () => {
    const { consumer, postingCalls } = makeConsumer({
      employees: [],
      fundsByAccount: [{ id: 'acct-cash', fund_id: 'f' }],
      fallbackFundIds: ['fund-fallback'],
    });
    await expect(processEvent(consumer, SAMPLE_EVENT)).rejects.toThrow(
      /no ACTIVE hr_employees row/,
    );
    expect(postingCalls.createAndPost).toHaveLength(0);
  });

  it('throws when no fallback fund is configured for the tenant', async () => {
    const { consumer, postingCalls } = makeConsumer({
      employees: [SAMPLE_EMPLOYEE],
      fundsByAccount: [{ id: 'acct-cash', fund_id: null }],
      fallbackFundIds: [], // No active fund
    });
    await expect(processEvent(consumer, SAMPLE_EVENT)).rejects.toThrow(/no active fund configured/);
  });
});

describe('JournalBatchPostedConsumer — SQL shape', () => {
  it('hr_employees lookup filters by school_id AND employment_status=ACTIVE', async () => {
    const { consumer, captures } = makeConsumer({
      employees: [SAMPLE_EMPLOYEE],
      fundsByAccount: [
        { id: 'acct-cash', fund_id: 'f' },
        { id: 'acct-revenue', fund_id: 'f' },
      ],
      fallbackFundIds: ['fund-fallback'],
    });
    await processEvent(consumer, SAMPLE_EVENT);
    const hrCall = captures.find((c) => c.sql.includes('FROM hr_employees'));
    expect(hrCall).toBeDefined();
    expect(hrCall!.sql).toContain("e.employment_status = 'ACTIVE'");
    expect(hrCall!.sql).toContain('e.school_id = $1::uuid');
    expect(hrCall!.args[0]).toBe(SCHOOL_ID);
    expect(hrCall!.sql).toContain('ORDER BY e.created_at');
    expect(hrCall!.sql).toContain('LIMIT 1');
  });

  it('fin_chart_of_accounts lookup uses ANY($1::uuid[]) with the deduplicated account list', async () => {
    const event = {
      ...SAMPLE_EVENT,
      payload: {
        ...SAMPLE_EVENT.payload,
        lines: [
          { accountId: 'acct-cash', debit: 100, credit: 0, description: null, lineOrder: 1 },
          { accountId: 'acct-cash', debit: 0, credit: 100, description: null, lineOrder: 2 }, // dup
        ],
      },
    };
    const { consumer, captures } = makeConsumer({
      employees: [SAMPLE_EMPLOYEE],
      fundsByAccount: [{ id: 'acct-cash', fund_id: 'f' }],
      fallbackFundIds: ['fund-fallback'],
    });
    await processEvent(consumer, event);
    const accountsCall = captures.find((c) => c.sql.includes('FROM fin_chart_of_accounts'));
    expect(accountsCall).toBeDefined();
    expect(accountsCall!.sql).toContain('id = ANY($1::uuid[])');
    expect(accountsCall!.sql).toContain('is_active = true');
    expect(accountsCall!.args[0]).toEqual(['acct-cash']); // deduplicated
  });

  it('fallback fund lookup orders by fund_code + active filter', async () => {
    const { consumer, captures } = makeConsumer({
      employees: [SAMPLE_EMPLOYEE],
      fundsByAccount: [
        { id: 'acct-cash', fund_id: null },
        { id: 'acct-revenue', fund_id: null },
      ],
      fallbackFundIds: ['fund-fallback'],
    });
    await processEvent(consumer, SAMPLE_EVENT);
    const fundCall = captures.find((c) => c.sql.includes('FROM fin_funds'));
    expect(fundCall).toBeDefined();
    expect(fundCall!.sql).toContain('is_active = true');
    expect(fundCall!.sql).toContain('ORDER BY fund_code');
    expect(fundCall!.sql).toContain('LIMIT 1');
  });
});

describe('JournalBatchPostedConsumer.onModuleInit', () => {
  it('subscribes to dev.fin.journal_batch.posted under journal-batch-posted-consumer group', async () => {
    let captured: { topics: string[]; groupId: string } | undefined;
    const kafkaConsumer = {
      subscribe: async (args: { topics: string[]; groupId: string }) => {
        captured = { topics: args.topics, groupId: args.groupId };
      },
    };
    const fake = makeTenantPrisma({});
    const consumer = new JournalBatchPostedConsumer(
      kafkaConsumer as never,
      { isClaimed: async () => false, claim: async () => undefined } as never,
      fake.tenantPrisma as never,
      { createAndPost: async () => undefined } as never,
    );
    await consumer.onModuleInit();
    expect(captured).toBeDefined();
    expect(captured!.topics).toEqual(['dev.fin.journal_batch.posted']);
    expect(captured!.groupId).toBe('journal-batch-posted-consumer');
  });
});
