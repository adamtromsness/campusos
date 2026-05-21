import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HttpException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { TenantResolverMiddleware } from '@shared/tenant/tenant-resolver.middleware';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import { TEST_SCHOOL_ID, TEST_SUBDOMAIN, TEST_SCHEMA } from '../helpers/tenant-context';

/**
 * Wave 8 — TenantResolverMiddleware integration coverage.
 *
 * The middleware runs FIRST in the chain and sets the tenant context
 * via runWithTenantContext. Exercises:
 *   - X-Tenant-Subdomain header → resolves to the test school.
 *   - hostname subdomain → resolves when no header.
 *   - Missing subdomain → 400 Bad Request.
 *   - Unknown subdomain → 400.
 *   - Exempt paths bypass tenant resolution.
 */

function makeReq(opts: {
  headers?: Record<string, string | undefined>;
  hostname?: string;
  path?: string;
  originalUrl?: string;
}) {
  const headers = opts.headers ?? {};
  return {
    headers,
    hostname: opts.hostname ?? 'localhost',
    path: opts.path ?? '/api/v1/students',
    originalUrl: opts.originalUrl ?? opts.path ?? '/api/v1/students',
    url: opts.originalUrl ?? opts.path ?? '/api/v1/students',
  } as any;
}

describe('integration:shared/tenant-resolver-middleware', () => {
  let raw: PrismaClient;
  let middleware: TenantResolverMiddleware;

  beforeAll(async () => {
    raw = new PrismaClient();
    await raw.$connect();
    middleware = new TenantResolverMiddleware(raw);
  });

  afterAll(async () => {
    await raw.$disconnect();
  });

  it('resolves the tenant from X-Tenant-Subdomain header', async () => {
    const req = makeReq({ headers: { 'x-tenant-subdomain': TEST_SUBDOMAIN } });
    const res = {} as any;
    let captured: any;
    await new Promise<void>((resolve, reject) => {
      middleware
        .use(req, res, () => {
          try {
            captured = getCurrentTenant();
            resolve();
          } catch (e) {
            reject(e);
          }
        })
        .catch(reject);
    });
    expect(captured.schoolId).toBe(TEST_SCHOOL_ID);
    expect(captured.schemaName).toBe(TEST_SCHEMA);
    expect(captured.subdomain).toBe(TEST_SUBDOMAIN);
  });

  it('resolves the tenant from hostname subdomain (non-localhost)', async () => {
    const req = makeReq({
      hostname: TEST_SUBDOMAIN + '.campusos.com',
      headers: {},
    });
    const res = {} as any;
    let captured: any;
    await new Promise<void>((resolve, reject) => {
      middleware
        .use(req, res, () => {
          try {
            captured = getCurrentTenant();
            resolve();
          } catch (e) {
            reject(e);
          }
        })
        .catch(reject);
    });
    expect(captured.schoolId).toBe(TEST_SCHOOL_ID);
  });

  it('throws 400 when there is no subdomain or header', async () => {
    const req = makeReq({ headers: {}, hostname: 'localhost' });
    const res = {} as any;
    let captured: any;
    try {
      await middleware.use(req, res, () => undefined);
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(HttpException);
    expect((captured as HttpException).getStatus()).toBe(400);
    expect((captured as HttpException).message).toMatch(/Tenant resolution failed/);
  });

  it('throws 400 when the subdomain is unknown', async () => {
    const req = makeReq({ headers: { 'x-tenant-subdomain': 'does-not-exist' } });
    const res = {} as any;
    let captured: any;
    try {
      await middleware.use(req, res, () => undefined);
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(HttpException);
    expect((captured as HttpException).getStatus()).toBe(400);
    expect((captured as HttpException).message).toMatch(/Unknown or inactive tenant/);
  });

  it('exempts /api/v1/health from tenant resolution', async () => {
    const req = makeReq({ headers: {}, hostname: 'localhost', path: '/api/v1/health' });
    const res = {} as any;
    let nextCalled = false;
    await middleware.use(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });

  it('exempts /metrics from tenant resolution', async () => {
    const req = makeReq({ headers: {}, hostname: 'localhost', path: '/metrics' });
    const res = {} as any;
    let nextCalled = false;
    await middleware.use(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });

  it('exempts /api/v1/admin/dlq from tenant resolution', async () => {
    const req = makeReq({
      headers: {},
      hostname: 'localhost',
      path: '/api/v1/admin/dlq/123',
    });
    const res = {} as any;
    let nextCalled = false;
    await middleware.use(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });

  it('exempts /api/v1/auth/login from tenant resolution', async () => {
    const req = makeReq({
      headers: {},
      hostname: 'localhost',
      path: '/api/v1/auth/login',
    });
    const res = {} as any;
    let nextCalled = false;
    await middleware.use(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });

  it('ignores hostname subdomain when on localhost / 127.0.0.1', async () => {
    // localhost / 127.0.0.1 are treated as dev — the middleware requires
    // an explicit header even though "localhost" technically has parts.
    const req = makeReq({ headers: {}, hostname: '127.0.0.1' });
    const res = {} as any;
    let captured: any;
    try {
      await middleware.use(req, res, () => undefined);
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(HttpException);
    expect((captured as HttpException).getStatus()).toBe(400);
  });
});
