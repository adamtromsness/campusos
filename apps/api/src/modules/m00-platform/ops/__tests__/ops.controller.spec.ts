import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { PERMISSIONS_KEY } from '@shared/auth';
import { PLATFORM_SCOPED_KEY } from '@shared/auth';
import { OpsController } from '../ops.controller';

/**
 * P2-21b — OpsController permission-metadata regression test.
 *
 * Pins the @RequirePermission code on every endpoint so a refactor
 * cannot silently downgrade a write to a read or open up a platform-
 * scoped surface to a non-Platform-Admin. Also asserts
 * @PlatformScoped() is set at the controller level so PermissionGuard
 * resolves permissions against the PLATFORM IAM scope only — schools
 * cannot reach these routes even if they hold ops-001:admin at SCHOOL
 * scope.
 */
describe('OpsController — permission gate distribution', () => {
  const proto = OpsController.prototype as unknown as Record<string, () => unknown>;
  function gateFor(methodName: string): string[] {
    return (Reflect.getMetadata(PERMISSIONS_KEY, proto[methodName]!) as string[]) ?? [];
  }

  it('controller is platform-scoped (no tenant header)', () => {
    const flag = Reflect.getMetadata(PLATFORM_SCOPED_KEY, OpsController);
    expect(flag).toBe(true);
  });

  it('employee endpoints gate on OPS-001 read/write', () => {
    expect(gateFor('listEmployees')).toEqual(['ops-001:read']);
    expect(gateFor('getEmployee')).toEqual(['ops-001:read']);
    expect(gateFor('createEmployee')).toEqual(['ops-001:write']);
    expect(gateFor('patchEmployee')).toEqual(['ops-001:write']);
    expect(gateFor('listEmployeePermissions')).toEqual(['ops-001:read']);
    expect(gateFor('grantPermission')).toEqual(['ops-001:write']);
    expect(gateFor('revokePermission')).toEqual(['ops-001:write']);
  });

  it('account-assignment endpoints gate on OPS-002 read/write', () => {
    expect(gateFor('listAssignmentsForAccount')).toEqual(['ops-002:read']);
    expect(gateFor('listAssignmentsForEmployee')).toEqual(['ops-002:read']);
    expect(gateFor('createAssignment')).toEqual(['ops-002:write']);
    expect(gateFor('removeAssignment')).toEqual(['ops-002:write']);
  });

  it('tenant-access endpoints gate on OPS-003 read/write', () => {
    expect(gateFor('listActiveTenantAccess')).toEqual(['ops-003:read']);
    expect(gateFor('listTenantAccessAuditLog')).toEqual(['ops-003:read']);
    expect(gateFor('getTenantAccess')).toEqual(['ops-003:read']);
    expect(gateFor('grantTenantAccess')).toEqual(['ops-003:write']);
    expect(gateFor('revokeTenantAccess')).toEqual(['ops-003:write']);
  });

  it('internal-ticket endpoints gate on OPS-004 read/write', () => {
    expect(gateFor('listTickets')).toEqual(['ops-004:read']);
    expect(gateFor('getTicket')).toEqual(['ops-004:read']);
    expect(gateFor('createTicket')).toEqual(['ops-004:write']);
    expect(gateFor('patchTicket')).toEqual(['ops-004:write']);
    expect(gateFor('listTicketComments')).toEqual(['ops-004:read']);
    expect(gateFor('addTicketComment')).toEqual(['ops-004:write']);
  });

  it('pricing endpoints gate on OPS-005 read/write', () => {
    expect(gateFor('listPricingBands')).toEqual(['ops-005:read']);
    expect(gateFor('getPricingBand')).toEqual(['ops-005:read']);
    expect(gateFor('createPricingBand')).toEqual(['ops-005:write']);
    expect(gateFor('updatePricingBand')).toEqual(['ops-005:write']);
    expect(gateFor('listPricingHistory')).toEqual(['ops-005:read']);
    expect(gateFor('listAllPricingHistory')).toEqual(['ops-005:read']);
    expect(gateFor('listSupportTiers')).toEqual(['ops-005:read']);
    expect(gateFor('createSupportTier')).toEqual(['ops-005:write']);
    expect(gateFor('patchSupportTier')).toEqual(['ops-005:write']);
  });

  it('catalogue endpoint is readable', () => {
    expect(gateFor('catalogue')).toEqual(['ops-001:read']);
  });
});
