import { describe, it, expect } from 'vitest';
import { CircuitBreaker, CircuitBreakerOpenError } from './circuit-breaker';

describe('CircuitBreaker', () => {
  it('starts CLOSED', () => {
    const cb = new CircuitBreaker('test');
    expect(cb.getState()).toBe('CLOSED');
  });

  it('opens after failureThreshold consecutive failures', async () => {
    const cb = new CircuitBreaker('test', { failureThreshold: 3, openDurationMs: 100 });
    const fail = async () => {
      throw new Error('boom');
    };

    // 3 failures should open the circuit.
    for (let i = 0; i < 3; i++) {
      try {
        await cb.execute(fail);
      } catch {
        // expected
      }
    }
    expect(cb.getState()).toBe('OPEN');
  });

  it('throws CircuitBreakerOpenError fast while OPEN', async () => {
    const cb = new CircuitBreaker('redis', { failureThreshold: 1, openDurationMs: 60_000 });
    try {
      await cb.execute(async () => {
        throw new Error('boom');
      });
    } catch {
      // expected
    }
    expect(cb.getState()).toBe('OPEN');

    let captured: unknown = null;
    try {
      await cb.execute(async () => 'should-not-run');
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(CircuitBreakerOpenError);
    expect((captured as CircuitBreakerOpenError).dependency).toBe('redis');
  });

  it('transitions OPEN → HALF_OPEN after openDurationMs', async () => {
    const cb = new CircuitBreaker('test', { failureThreshold: 1, openDurationMs: 50 });
    try {
      await cb.execute(async () => {
        throw new Error('boom');
      });
    } catch {
      // expected
    }
    expect(cb.getState()).toBe('OPEN');

    await new Promise((r) => setTimeout(r, 60));

    // Next execute attempt enters HALF_OPEN. A success closes the circuit.
    await cb.execute(async () => 'recovered');
    expect(cb.getState()).toBe('CLOSED');
  });

  it('HALF_OPEN failure re-opens the circuit', async () => {
    const cb = new CircuitBreaker('test', { failureThreshold: 1, openDurationMs: 30 });
    try {
      await cb.execute(async () => {
        throw new Error('boom');
      });
    } catch {
      // expected
    }
    await new Promise((r) => setTimeout(r, 40));
    try {
      await cb.execute(async () => {
        throw new Error('still-broken');
      });
    } catch {
      // expected
    }
    expect(cb.getState()).toBe('OPEN');
  });

  it('onStateChange listener fires on every transition', async () => {
    const cb = new CircuitBreaker('test', { failureThreshold: 1, openDurationMs: 30 });
    const transitions: string[] = [];
    cb.onStateChange((dep, state) => {
      transitions.push(`${dep}:${state}`);
    });
    try {
      await cb.execute(async () => {
        throw new Error('boom');
      });
    } catch {
      // expected
    }
    await new Promise((r) => setTimeout(r, 40));
    await cb.execute(async () => 'ok');

    // Expected: CLOSED → OPEN → HALF_OPEN → CLOSED.
    expect(transitions).toEqual(['test:OPEN', 'test:HALF_OPEN', 'test:CLOSED']);
  });
});
