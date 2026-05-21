import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { MetricsController } from '@shared/observability/metrics.controller';
import { MetricsService } from '@shared/observability/metrics.service';

/**
 * Wave 8 — MetricsController.
 *
 * Exercises:
 *   - render() returns the Prometheus exposition text + sets headers.
 *   - assertAuthorised passes when METRICS_BEARER_TOKEN is unset.
 *   - assertAuthorised rejects when token is required but absent/invalid.
 *   - assertAuthorised passes with a correct Bearer token.
 *   - constant-time compare survives equal-length wrong tokens.
 */
describe('integration:shared/metrics-controller', () => {
  let svc: MetricsService;
  let controller: MetricsController;

  beforeAll(() => {
    svc = new MetricsService();
    controller = new MetricsController(svc);
  });

  afterAll(() => {
    delete process.env.METRICS_BEARER_TOKEN;
  });

  function makeReq(authorization?: string) {
    return { headers: authorization ? { authorization } : {} } as any;
  }

  function makeRes() {
    const headers: Record<string, string> = {};
    let sent: string | undefined;
    return {
      setHeader(k: string, v: string) {
        headers[k.toLowerCase()] = v;
      },
      send(body: string) {
        sent = body;
      },
      get sent() {
        return sent;
      },
      get headers() {
        return headers;
      },
    } as any;
  }

  it('render writes the Prometheus text body + content-type when no auth required', async () => {
    delete process.env.METRICS_BEARER_TOKEN;
    const res = makeRes();
    await controller.render(makeReq(), res);
    expect(res.sent).toContain('# HELP');
    expect(res.headers['content-type']).toContain('text');
  });

  it('rejects with 401 when bearer is required but not supplied', async () => {
    process.env.METRICS_BEARER_TOKEN = 'super-secret';
    const res = makeRes();
    let caught: any;
    try {
      await controller.render(makeReq(), res);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnauthorizedException);
    expect(caught.message).toMatch(/Missing bearer token/);
  });

  it('rejects when token differs from the configured value', async () => {
    process.env.METRICS_BEARER_TOKEN = 'super-secret';
    const res = makeRes();
    let caught: any;
    try {
      await controller.render(makeReq('Bearer wrong-token-abc'), res);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnauthorizedException);
    expect(caught.message).toMatch(/Invalid bearer token/);
  });

  it('rejects when token is correct length but different (constant-time path)', async () => {
    process.env.METRICS_BEARER_TOKEN = 'aaaaa';
    const res = makeRes();
    let caught: any;
    try {
      await controller.render(makeReq('Bearer bbbbb'), res);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnauthorizedException);
  });

  it('accepts a correctly-supplied bearer token', async () => {
    process.env.METRICS_BEARER_TOKEN = 'correct-token';
    const res = makeRes();
    await controller.render(makeReq('Bearer correct-token'), res);
    expect(res.sent).toContain('# HELP');
  });
});
