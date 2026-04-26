import { describe, it, expect } from 'vitest';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  const controller = new HealthController();

  it('should return healthy status', () => {
    const result = controller.getHealth();
    expect(result.status).toBe('healthy');
    expect(result.version).toBe('0.1.0');
    expect(result.uptime).toBeGreaterThanOrEqual(0);
  });

  it('should include dependency checks', () => {
    const result = controller.getHealth();
    expect(result.checks).toHaveProperty('database');
    expect(result.checks).toHaveProperty('redis');
    expect(result.checks).toHaveProperty('kafka');
  });
});
