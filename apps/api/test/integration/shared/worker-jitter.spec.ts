import { describe, it, expect } from 'vitest';
import {
  jitterDelayMs,
  jitterWeekday,
  jitterMonthDayOffset,
} from '@shared/observability/worker-jitter';

/**
 * Wave 8 — worker-jitter pure helpers.
 *
 * No DB/network — all sha256-deterministic. Asserts:
 *   - determinism (same input → same output) so ops can predict tenant
 *     fire times across restarts.
 *   - bounds (always in [0, windowMs) / [0, 7) / [0, maxDay))
 *   - zero / single-bucket edge cases.
 */
describe('integration:shared/worker-jitter', () => {
  describe('jitterDelayMs', () => {
    it('is deterministic for a given tenantId + window', () => {
      const tenant = '019ec0fa-aaaa-7777-8888-300000000001';
      const a = jitterDelayMs(tenant, 2 * 60 * 60 * 1000);
      const b = jitterDelayMs(tenant, 2 * 60 * 60 * 1000);
      expect(a).toBe(b);
    });

    it('produces different offsets for different tenantIds (overwhelmingly likely)', () => {
      const t1 = jitterDelayMs('019ec0fa-aaaa-7777-8888-300000000001', 1_000_000);
      const t2 = jitterDelayMs('019ec0fa-aaaa-7777-8888-300000000002', 1_000_000);
      expect(t1).not.toBe(t2);
    });

    it('always returns a value in [0, windowMs)', () => {
      const window = 60 * 60 * 1000;
      for (let i = 0; i < 50; i++) {
        const v = jitterDelayMs('tenant-' + i, window);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(window);
      }
    });

    it('returns 0 for windowMs <= 0', () => {
      expect(jitterDelayMs('tenant-x', 0)).toBe(0);
      expect(jitterDelayMs('tenant-x', -1000)).toBe(0);
    });
  });

  describe('jitterWeekday', () => {
    it('is deterministic + in [0, 6]', () => {
      const t = 'tenant-weekday';
      const a = jitterWeekday(t);
      const b = jitterWeekday(t);
      expect(a).toBe(b);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(7);
    });

    it('covers the full weekday range across a population of tenants', () => {
      const seen = new Set<number>();
      for (let i = 0; i < 200; i++) {
        seen.add(jitterWeekday('tenant-' + i));
      }
      // sha256 is uniform enough that 200 tenants cover every weekday.
      expect(seen.size).toBe(7);
    });
  });

  describe('jitterMonthDayOffset', () => {
    it('is deterministic + in [0, maxDay)', () => {
      const t = 'tenant-monthly';
      const a = jitterMonthDayOffset(t, 5);
      const b = jitterMonthDayOffset(t, 5);
      expect(a).toBe(b);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(5);
    });

    it('returns 0 when maxDay <= 1', () => {
      expect(jitterMonthDayOffset('tenant', 0)).toBe(0);
      expect(jitterMonthDayOffset('tenant', 1)).toBe(0);
    });

    it('honours custom maxDay', () => {
      for (let i = 0; i < 100; i++) {
        const v = jitterMonthDayOffset('tenant-' + i, 10);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(10);
      }
    });
  });
});
