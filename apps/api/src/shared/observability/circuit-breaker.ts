import { Logger } from '@nestjs/common';

/**
 * Cycle 31 Step 7 — Circuit Breaker.
 *
 * A minimal three-state circuit breaker for protecting external
 * dependencies (PostgreSQL, Redis, AI Gateway, push provider,
 * Stripe, etc.) from cascading failure.
 *
 *   CLOSED    — normal; requests pass through
 *   OPEN      — dependency failing; fail fast (no retry, no wait)
 *   HALF_OPEN — probe state; let one request through; if it succeeds
 *               close the circuit, otherwise re-open
 *
 * Usage:
 *   const breaker = new CircuitBreaker('redis', {
 *     failureThreshold: 5,
 *     openDurationMs: 30_000,
 *   });
 *
 *   await breaker.execute(async () => {
 *     return await redis.get(key);
 *   });
 *
 * Plug a CircuitBreakerOpenError handler in the caller to fall back
 * (e.g. SAFETY_CRITICAL workers fall back to local cache when the
 * Redis breaker opens).
 *
 * The breaker reports its current state to Prometheus via the
 * MetricsService.circuitBreakerState gauge (0=closed, 1=open,
 * 2=half-open). The cycle-31 Step 8 alerting rule fires PAGE on a
 * 1-minute sustained OPEN on any breaker tagged dependency=critical.
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  openDurationMs?: number;
  halfOpenAttempts?: number;
}

export class CircuitBreakerOpenError extends Error {
  constructor(public readonly dependency: string) {
    super(`Circuit breaker for ${dependency} is OPEN`);
    this.name = 'CircuitBreakerOpenError';
  }
}

export type StateChangeListener = (dependency: string, state: CircuitState) => void;

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private nextAttemptAt = 0;
  private halfOpenInFlight = 0;
  private readonly logger: Logger;
  private readonly failureThreshold: number;
  private readonly openDurationMs: number;
  private readonly halfOpenAttempts: number;
  private readonly listeners: StateChangeListener[] = [];

  constructor(
    private readonly dependency: string,
    options: CircuitBreakerOptions = {},
  ) {
    this.logger = new Logger(`CircuitBreaker:${dependency}`);
    this.failureThreshold = options.failureThreshold ?? 5;
    this.openDurationMs = options.openDurationMs ?? 30_000;
    this.halfOpenAttempts = options.halfOpenAttempts ?? 1;
  }

  onStateChange(listener: StateChangeListener): void {
    this.listeners.push(listener);
  }

  getState(): CircuitState {
    return this.state;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      if (Date.now() < this.nextAttemptAt) {
        throw new CircuitBreakerOpenError(this.dependency);
      }
      this.transition('HALF_OPEN');
    }
    if (this.state === 'HALF_OPEN' && this.halfOpenInFlight >= this.halfOpenAttempts) {
      throw new CircuitBreakerOpenError(this.dependency);
    }
    if (this.state === 'HALF_OPEN') this.halfOpenInFlight++;

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure();
      throw err;
    } finally {
      if (this.state === 'HALF_OPEN') this.halfOpenInFlight--;
    }
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.state !== 'CLOSED') {
      this.transition('CLOSED');
    }
  }

  private recordFailure(): void {
    this.consecutiveFailures++;
    if (this.state === 'HALF_OPEN') {
      this.transition('OPEN');
      this.nextAttemptAt = Date.now() + this.openDurationMs;
      return;
    }
    if (this.state === 'CLOSED' && this.consecutiveFailures >= this.failureThreshold) {
      this.transition('OPEN');
      this.nextAttemptAt = Date.now() + this.openDurationMs;
    }
  }

  private transition(next: CircuitState): void {
    if (this.state === next) return;
    this.logger.warn(`state ${this.state} → ${next}`);
    this.state = next;
    for (const listener of this.listeners) {
      try {
        listener(this.dependency, next);
      } catch {
        // Listeners must not break the circuit; swallow.
      }
    }
  }
}
