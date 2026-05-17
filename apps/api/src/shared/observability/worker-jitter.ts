import { createHash } from 'crypto';

/**
 * P2-H4 Step 5 Advisory ADV-03 — per-tenant worker jitter.
 *
 * Workers that run on a per-tenant schedule (nightly batches, weekly
 * recomputes, monthly invoice generation) historically all fire at
 * the same scheduled instant. With N tenants on a single Postgres
 * cluster that produces an N-way thundering herd against the same
 * connection pool.
 *
 * `jitterDelayMs(tenantId, windowMs)` returns a deterministic delay
 * for a given tenant inside a configurable window. The hash is stable
 * across worker restarts so a tenant always fires at the same offset
 * inside its window — predictable for ops + reproducible across
 * cluster restarts.
 *
 * Recommended windows:
 *   - Nightly workers: 2-hour window (`2 * 60 * 60 * 1000`)
 *   - Weekly workers: 7-day window applied as `dayOffset(tenantId)`
 *     instead — pick the weekday rather than a sub-day jitter
 *   - Monthly workers: 5-day window from the 1st of month
 *
 * Usage from inside a worker tick loop:
 *
 *   for (const tenant of schools) {
 *     const delay = jitterDelayMs(tenant.id, 2 * 60 * 60 * 1000);
 *     setTimeout(() => this.runForTenant(tenant), delay);
 *   }
 *
 * For workers that already iterate sequentially without a fixed start
 * time (e.g. NotificationDeliveryWorker's 10-second poll), the jitter
 * is unnecessary because the workload itself is staggered naturally.
 */
export function jitterDelayMs(tenantId: string, windowMs: number): number {
  if (windowMs <= 0) return 0;
  const hash = createHash('sha256').update(tenantId).digest();
  // Use the first 6 bytes (48 bits) — plenty for the windows we care
  // about and avoids 64-bit overflow on the modulo.
  const slice = hash.readUIntBE(0, 6);
  return slice % windowMs;
}

/**
 * Pick a deterministic weekday (0=Sun, 6=Sat) for a tenant. Use this
 * for weekly batches so each tenant fires the same weekday every week.
 */
export function jitterWeekday(tenantId: string): number {
  const hash = createHash('sha256').update(tenantId).digest();
  return hash.readUInt8(0) % 7;
}

/**
 * Pick a deterministic day-of-month offset in [0, maxDay - 1] for
 * monthly batches. Default `maxDay = 5` spreads across the first 5
 * days of the month.
 */
export function jitterMonthDayOffset(tenantId: string, maxDay: number = 5): number {
  if (maxDay <= 1) return 0;
  const hash = createHash('sha256').update(tenantId).digest();
  return hash.readUInt8(1) % maxDay;
}
