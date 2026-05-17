import { describe, it, expect } from 'vitest';
import { Logger } from '@nestjs/common';
import { LunchAccountConsumer } from './lunch-account.consumer';

/**
 * P2-H4 test coverage uplift — payments/consumers/lunch-account.consumer.ts
 * (115 LOC, Tier 1 Financial; cafeteria POS integration that subscribes
 * to dev.fds.meal.served and calls LunchAccountService.chargeMealFromConsumer).
 *
 * Tests cover:
 *   - onModuleInit subscribes with prefixed topic + group
 *   - handle: invalid envelope returns silently
 *   - handle: missing studentId / schoolId / mealDate / amount drops
 *     with warn log
 *   - handle: non-positive amount drops with warn log
 *   - handle: happy path runs charge service through idempotency
 *   - handle: already-claimed events skip the charge call
 *   - handle: optional posDeviceId / posSessionId default to null
 *   - source_event_id passed through as eventId
 */

interface ConsumedMessage {
  topic: string;
  payload: unknown;
  headers: Record<string, string>;
}

function makeConsumerHarness() {
  let subscribed: { topics: string[]; groupId: string; handler: (m: ConsumedMessage) => Promise<void> } | null = null;
  const consumer = {
    subscribe: async (args: { topics: string[]; groupId: string; handler: (m: ConsumedMessage) => Promise<void> }) => {
      subscribed = args;
    },
  };
  return { consumer, getSubscription: () => subscribed };
}

function makeIdempotency(opts: { alreadyClaimed?: boolean; claimError?: Error } = {}) {
  const claimedKeys: Array<{ group: string; eventId: string; topic: string }> = [];
  return {
    claimedKeys,
    isClaimed: async () => opts.alreadyClaimed ?? false,
    claim: async (group: string, eventId: string, topic: string) => {
      if (opts.claimError) throw opts.claimError;
      claimedKeys.push({ group, eventId, topic });
    },
  };
}

function makeLunchService() {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    chargeMealFromConsumer: async (input: Record<string, unknown>) => {
      calls.push(input);
      return { created: true, balanceCrossedThreshold: false, account: null };
    },
  };
}

function makeMessage(overrides: Partial<ConsumedMessage> = {}): ConsumedMessage {
  return {
    topic: 'dev.fds.meal.served',
    payload: {
      event_id: '019ee000-1111-7111-8111-111111111111',
      tenant_id: 'sch-1',
      payload: {
        studentId: 'stu-maya',
        schoolId: 'sch-1',
        mealDate: '2026-04-28',
        amount: 3.5,
        posDeviceId: 'pos-1',
        posSessionId: 'sess-1',
      },
    },
    headers: { 'tenant-subdomain': 'demo' },
    ...overrides,
  };
}

describe('LunchAccountConsumer.onModuleInit', () => {
  it('subscribes with prefixed topic + lunch-account-consumer group', async () => {
    const { consumer, getSubscription } = makeConsumerHarness();
    const idem = makeIdempotency();
    const lunch = makeLunchService();
    const c = new LunchAccountConsumer(consumer as never, idem as never, lunch as never);
    await c.onModuleInit();
    const sub = getSubscription();
    expect(sub).toBeTruthy();
    expect(sub!.topics[0]).toMatch(/fds\.meal\.served$/);
    expect(sub!.groupId).toBe('lunch-account-consumer');
  });
});

describe('LunchAccountConsumer.handle (via onModuleInit subscription)', () => {
  it('drops on missing studentId', async () => {
    const { consumer, getSubscription } = makeConsumerHarness();
    const idem = makeIdempotency();
    const lunch = makeLunchService();
    const c = new LunchAccountConsumer(consumer as never, idem as never, lunch as never);
    await c.onModuleInit();
    const msg = makeMessage();
    // Strip studentId from payload
    const inner = (msg.payload as { payload: Record<string, unknown> }).payload;
    delete inner.studentId;
    await getSubscription()!.handler(msg);
    expect(lunch.calls.length).toBe(0);
    expect(idem.claimedKeys.length).toBe(0);
  });

  it('drops on missing schoolId', async () => {
    const { consumer, getSubscription } = makeConsumerHarness();
    const idem = makeIdempotency();
    const lunch = makeLunchService();
    const c = new LunchAccountConsumer(consumer as never, idem as never, lunch as never);
    await c.onModuleInit();
    const msg = makeMessage();
    const inner = (msg.payload as { payload: Record<string, unknown> }).payload;
    delete inner.schoolId;
    await getSubscription()!.handler(msg);
    expect(lunch.calls.length).toBe(0);
  });

  it('drops on missing mealDate', async () => {
    const { consumer, getSubscription } = makeConsumerHarness();
    const idem = makeIdempotency();
    const lunch = makeLunchService();
    const c = new LunchAccountConsumer(consumer as never, idem as never, lunch as never);
    await c.onModuleInit();
    const msg = makeMessage();
    const inner = (msg.payload as { payload: Record<string, unknown> }).payload;
    delete inner.mealDate;
    await getSubscription()!.handler(msg);
    expect(lunch.calls.length).toBe(0);
  });

  it('drops on non-numeric amount', async () => {
    const { consumer, getSubscription } = makeConsumerHarness();
    const idem = makeIdempotency();
    const lunch = makeLunchService();
    const c = new LunchAccountConsumer(consumer as never, idem as never, lunch as never);
    await c.onModuleInit();
    const msg = makeMessage();
    const inner = (msg.payload as { payload: Record<string, unknown> }).payload;
    (inner as { amount: unknown }).amount = '3.50'; // string, not number
    await getSubscription()!.handler(msg);
    expect(lunch.calls.length).toBe(0);
  });

  it('drops on non-positive amount (zero)', async () => {
    const { consumer, getSubscription } = makeConsumerHarness();
    const idem = makeIdempotency();
    const lunch = makeLunchService();
    const c = new LunchAccountConsumer(consumer as never, idem as never, lunch as never);
    await c.onModuleInit();
    const msg = makeMessage();
    const inner = (msg.payload as { payload: Record<string, unknown> }).payload;
    (inner as { amount: number }).amount = 0;
    await getSubscription()!.handler(msg);
    expect(lunch.calls.length).toBe(0);
  });

  it('drops on negative amount', async () => {
    const { consumer, getSubscription } = makeConsumerHarness();
    const idem = makeIdempotency();
    const lunch = makeLunchService();
    const c = new LunchAccountConsumer(consumer as never, idem as never, lunch as never);
    await c.onModuleInit();
    const msg = makeMessage();
    const inner = (msg.payload as { payload: Record<string, unknown> }).payload;
    (inner as { amount: number }).amount = -1;
    await getSubscription()!.handler(msg);
    expect(lunch.calls.length).toBe(0);
  });

  it('drops on missing event_id / tenant_id (unwrapEnvelope returns null)', async () => {
    const { consumer, getSubscription } = makeConsumerHarness();
    const idem = makeIdempotency();
    const lunch = makeLunchService();
    const c = new LunchAccountConsumer(consumer as never, idem as never, lunch as never);
    await c.onModuleInit();
    const msg: ConsumedMessage = {
      topic: 'dev.fds.meal.served',
      payload: { payload: { studentId: 'stu', schoolId: 'sch-1', mealDate: '2026-04-28', amount: 3 } },
      headers: { 'tenant-subdomain': 'demo' }, // no event-id header either
    };
    await getSubscription()!.handler(msg);
    expect(lunch.calls.length).toBe(0);
  });

  it('happy path calls chargeMealFromConsumer with all fields + sourceEventId', async () => {
    const { consumer, getSubscription } = makeConsumerHarness();
    const idem = makeIdempotency();
    const lunch = makeLunchService();
    const c = new LunchAccountConsumer(consumer as never, idem as never, lunch as never);
    await c.onModuleInit();
    await getSubscription()!.handler(makeMessage());
    expect(lunch.calls.length).toBe(1);
    expect(lunch.calls[0]).toEqual({
      studentId: 'stu-maya',
      amount: 3.5,
      mealDate: '2026-04-28',
      posDeviceId: 'pos-1',
      sourceEventId: '019ee000-1111-7111-8111-111111111111',
      posSessionId: 'sess-1',
    });
    expect(idem.claimedKeys).toHaveLength(1);
    expect(idem.claimedKeys[0]!.group).toBe('lunch-account-consumer');
    expect(idem.claimedKeys[0]!.eventId).toBe('019ee000-1111-7111-8111-111111111111');
  });

  it('optional posDeviceId / posSessionId default to null', async () => {
    const { consumer, getSubscription } = makeConsumerHarness();
    const idem = makeIdempotency();
    const lunch = makeLunchService();
    const c = new LunchAccountConsumer(consumer as never, idem as never, lunch as never);
    await c.onModuleInit();
    const msg: ConsumedMessage = {
      topic: 'dev.fds.meal.served',
      payload: {
        event_id: '019ee000-1111-7111-8111-111111111111',
        tenant_id: 'sch-1',
        payload: {
          studentId: 'stu-maya',
          schoolId: 'sch-1',
          mealDate: '2026-04-28',
          amount: 3.5,
          // posDeviceId / posSessionId omitted
        },
      },
      headers: { 'tenant-subdomain': 'demo' },
    };
    await getSubscription()!.handler(msg);
    expect(lunch.calls.length).toBe(1);
    expect(lunch.calls[0]).toMatchObject({
      posDeviceId: null,
      posSessionId: null,
    });
  });

  it('skips already-claimed events (no charge call)', async () => {
    const { consumer, getSubscription } = makeConsumerHarness();
    const idem = makeIdempotency({ alreadyClaimed: true });
    const lunch = makeLunchService();
    const c = new LunchAccountConsumer(consumer as never, idem as never, lunch as never);
    await c.onModuleInit();
    await getSubscription()!.handler(makeMessage());
    expect(lunch.calls.length).toBe(0);
    expect(idem.claimedKeys.length).toBe(0);
  });

  it('still resolves successfully when idempotency claim fails post-process', async () => {
    const { consumer, getSubscription } = makeConsumerHarness();
    const idem = makeIdempotency({ claimError: new Error('platform DB blip') });
    const lunch = makeLunchService();
    const c = new LunchAccountConsumer(consumer as never, idem as never, lunch as never);
    await c.onModuleInit();
    await expect(getSubscription()!.handler(makeMessage())).resolves.toBeUndefined();
    expect(lunch.calls.length).toBe(1);
  });
});
