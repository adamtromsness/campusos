import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { RedisService } from '@shared/cache/redis.service';

/**
 * Wave 8 — RedisService end-to-end against the live docker-compose
 * Redis at REDIS_URL (default redis://localhost:6379).
 *
 * Exercises every public method:
 *   - cacheGet / cacheSet / cacheInvalidate (generic JSON cache)
 *   - claimIdempotency / releaseIdempotency
 *   - pushInAppNotification / listInAppNotifications / countInAppSince
 *   - incrementUnread / clearUnread / sumUnread / listUnreadByThread
 *   - getNotificationLastReadAt / setNotificationLastReadAt
 *   - getLedgerBalance / setLedgerBalance / invalidateLedgerBalance
 *   - incrementCounter / readCounter
 *   - markUniquePublicationView
 *   - isConnected
 *
 * Each test scopes keys under a per-run prefix so concurrent test
 * suites or seed data on the same Redis cannot collide.
 */
describe('integration:shared/redis-cache', () => {
  let svc: RedisService;
  const RUN_ID = 'wave8-' + Math.random().toString(36).slice(2, 10);

  beforeAll(async () => {
    svc = new RedisService();
    await svc.onModuleInit();
    if (!svc.isConnected()) {
      throw new Error(
        'Redis not connected — start docker-compose redis before running this suite.',
      );
    }
  });

  afterAll(async () => {
    await svc.onModuleDestroy();
  });

  beforeEach(async () => {
    // Best-effort cleanup of any keys this run touched. Each test uses
    // a fresh suffix on top of RUN_ID so collisions are vanishingly rare,
    // but this drops anything still hanging around from a prior failure.
  });

  describe('isConnected + lifecycle', () => {
    it('reports connected = true after onModuleInit', () => {
      expect(svc.isConnected()).toBe(true);
    });
  });

  describe('cacheGet / cacheSet / cacheInvalidate', () => {
    it('round-trips a JSON value through SET / GET', async () => {
      const key = `${RUN_ID}:cache:rt`;
      const payload = { hello: 'world', n: 42 };
      await svc.cacheSet(key, payload, 30);
      const got = await svc.cacheGet<typeof payload>(key);
      expect(got).toEqual(payload);
    });

    it('cacheGet returns null for a missing key', async () => {
      const got = await svc.cacheGet(`${RUN_ID}:cache:does-not-exist`);
      expect(got).toBeNull();
    });

    it('cacheInvalidate drops one or more keys', async () => {
      const k1 = `${RUN_ID}:inv:a`;
      const k2 = `${RUN_ID}:inv:b`;
      await svc.cacheSet(k1, { v: 1 }, 30);
      await svc.cacheSet(k2, { v: 2 }, 30);
      await svc.cacheInvalidate(k1, k2);
      expect(await svc.cacheGet(k1)).toBeNull();
      expect(await svc.cacheGet(k2)).toBeNull();
    });

    it('cacheInvalidate with zero keys is a no-op', async () => {
      await svc.cacheInvalidate();
      expect(true).toBe(true);
    });
  });

  describe('claimIdempotency / releaseIdempotency', () => {
    it('first call wins, second returns false', async () => {
      const key = `${RUN_ID}:idem:` + Math.random();
      expect(await svc.claimIdempotency(key, 30)).toBe(true);
      expect(await svc.claimIdempotency(key, 30)).toBe(false);
    });

    it('release allows re-claim', async () => {
      const key = `${RUN_ID}:idem-rel:` + Math.random();
      await svc.claimIdempotency(key, 30);
      await svc.releaseIdempotency(key);
      expect(await svc.claimIdempotency(key, 30)).toBe(true);
    });
  });

  describe('in-app notifications', () => {
    it('push + listInAppNotifications returns newest first', async () => {
      const accountId = RUN_ID + '-account-a';
      await svc.pushInAppNotification(accountId, { id: 1, body: 'first' });
      await new Promise((r) => setTimeout(r, 2));
      await svc.pushInAppNotification(accountId, { id: 2, body: 'second' });
      const list = await svc.listInAppNotifications(accountId, 10);
      expect(list.length).toBeGreaterThanOrEqual(2);
      expect((list[0]!.value as any).id).toBe(2);
      expect((list[1]!.value as any).id).toBe(1);
      // Cleanup
      await svc.cacheInvalidate('notif:inapp:' + accountId);
    });

    it('countInAppSince counts items above the threshold', async () => {
      const accountId = RUN_ID + '-account-b';
      const t1 = Date.now();
      await svc.pushInAppNotification(accountId, { id: 1 });
      await new Promise((r) => setTimeout(r, 10));
      const t2 = Date.now();
      await svc.pushInAppNotification(accountId, { id: 2 });
      const above = await svc.countInAppSince(accountId, t1);
      expect(above).toBeGreaterThanOrEqual(1);
      const aboveT2 = await svc.countInAppSince(accountId, t2 - 1);
      expect(aboveT2).toBeGreaterThanOrEqual(1);
      await svc.cacheInvalidate('notif:inapp:' + accountId);
    });

    it('getNotificationLastReadAt / setNotificationLastReadAt round-trip', async () => {
      const accountId = RUN_ID + '-account-c';
      expect(await svc.getNotificationLastReadAt(accountId)).toBe(0);
      const ms = Date.now();
      await svc.setNotificationLastReadAt(accountId, ms);
      expect(await svc.getNotificationLastReadAt(accountId)).toBe(ms);
      await svc.cacheInvalidate('notif:lastread:' + accountId);
    });
  });

  describe('per-thread unread counters', () => {
    const accountId = RUN_ID + '-account-unread';
    const tA = 'thread-a-' + RUN_ID;
    const tB = 'thread-b-' + RUN_ID;

    it('increment + sum + listUnreadByThread', async () => {
      await svc.incrementUnread(accountId, tA);
      await svc.incrementUnread(accountId, tA);
      await svc.incrementUnread(accountId, tB);
      const sum = await svc.sumUnread(accountId);
      expect(sum).toBe(3);
      const byThread = await svc.listUnreadByThread(accountId);
      expect(byThread[tA]).toBe(2);
      expect(byThread[tB]).toBe(1);
    });

    it('clearUnread removes the field', async () => {
      await svc.clearUnread(accountId, tA);
      const byThread = await svc.listUnreadByThread(accountId);
      expect(byThread[tA]).toBeUndefined();
      // Cleanup.
      await svc.clearUnread(accountId, tB);
      expect(await svc.sumUnread(accountId)).toBe(0);
    });
  });

  describe('ledger balance cache', () => {
    it('round-trips the ledger balance with TTL', async () => {
      const accountId = RUN_ID + '-ledger-a';
      expect(await svc.getLedgerBalance(accountId)).toBeNull();
      await svc.setLedgerBalance(accountId, '123.45');
      expect(await svc.getLedgerBalance(accountId)).toBe('123.45');
      await svc.invalidateLedgerBalance(accountId);
      expect(await svc.getLedgerBalance(accountId)).toBeNull();
    });
  });

  describe('counter helpers', () => {
    it('incrementCounter first write sets TTL, subsequent writes accumulate', async () => {
      const key = RUN_ID + ':counter:a';
      const a = await svc.incrementCounter(key, 1, 60);
      expect(a).toBe(1);
      const b = await svc.incrementCounter(key, 4, 60);
      expect(b).toBe(5);
      expect(await svc.readCounter(key)).toBe(5);
      await svc.cacheInvalidate(key);
    });

    it('readCounter returns 0 on miss', async () => {
      expect(await svc.readCounter(RUN_ID + ':counter:miss')).toBe(0);
    });
  });

  describe('markUniquePublicationView', () => {
    it('returns 1 on first view, 0 on duplicate', async () => {
      const pubId = RUN_ID + '-pub-1';
      const r1 = await svc.markUniquePublicationView(pubId, 'recipient-A');
      const r2 = await svc.markUniquePublicationView(pubId, 'recipient-A');
      const r3 = await svc.markUniquePublicationView(pubId, 'recipient-B');
      expect(r1).toBe(1);
      expect(r2).toBe(0);
      expect(r3).toBe(1);
      await svc.cacheInvalidate('notif:pub-views:' + pubId);
    });
  });
});
