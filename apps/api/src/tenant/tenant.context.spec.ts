import { describe, it, expect } from 'vitest';
import {
  runWithTenantContext,
  getCurrentTenant,
  getRequestContext,
  TenantInfo,
  RequestContext,
} from './tenant.context';

describe('TenantContext', function () {
  var testTenant: TenantInfo = {
    schoolId: 'school-123',
    schemaName: 'tenant_demo',
    organisationId: 'org-456',
    subdomain: 'demo',
    isFrozen: false,
    planTier: 'MEDIUM',
  };

  it('should return undefined outside a context', function () {
    var ctx = getRequestContext();
    expect(ctx).toBeUndefined();
  });

  it('should throw when getCurrentTenant called outside context', function () {
    expect(function () {
      getCurrentTenant();
    }).toThrow('No tenant context');
  });

  it('should provide tenant within context', function () {
    var context: RequestContext = { tenant: testTenant };

    runWithTenantContext(context, function () {
      var tenant = getCurrentTenant();
      expect(tenant.schoolId).toBe('school-123');
      expect(tenant.schemaName).toBe('tenant_demo');
      expect(tenant.subdomain).toBe('demo');
      expect(tenant.isFrozen).toBe(false);
    });
  });

  it('should isolate contexts between calls', function () {
    var context1: RequestContext = {
      tenant: { ...testTenant, subdomain: 'school-a' },
    };
    var context2: RequestContext = {
      tenant: { ...testTenant, subdomain: 'school-b' },
    };

    runWithTenantContext(context1, function () {
      expect(getCurrentTenant().subdomain).toBe('school-a');
    });

    runWithTenantContext(context2, function () {
      expect(getCurrentTenant().subdomain).toBe('school-b');
    });
  });

  it('should detect frozen tenant', function () {
    var frozenContext: RequestContext = {
      tenant: { ...testTenant, isFrozen: true },
    };

    runWithTenantContext(frozenContext, function () {
      expect(getCurrentTenant().isFrozen).toBe(true);
    });
  });
});
