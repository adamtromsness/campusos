import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { PERMISSIONS_KEY } from '@shared/auth/require-permission.decorator';
import { PLATFORM_SCOPED_KEY } from '@shared/auth/platform-scoped.decorator';
import { CrmController } from '../crm.controller';

/**
 * P2-21a — CrmController permission-metadata regression test.
 *
 * Pins the @RequirePermission code on every endpoint so a refactor
 * cannot silently downgrade a write to a read or open up an admin
 * surface to a non-Platform-Admin. Also asserts @PlatformScoped()
 * is set at the controller level so PermissionGuard resolves
 * permissions against the PLATFORM IAM scope only.
 */
describe('CrmController — permission gate distribution', () => {
  const proto = CrmController.prototype as unknown as Record<string, () => unknown>;
  function gateFor(methodName: string): string[] {
    return (Reflect.getMetadata(PERMISSIONS_KEY, proto[methodName]!) as string[]) ?? [];
  }

  it('controller is platform-scoped (no tenant header)', () => {
    const flag = Reflect.getMetadata(PLATFORM_SCOPED_KEY, CrmController);
    expect(flag).toBe(true);
  });

  it('account endpoints gate on CRM-001 read/write', () => {
    expect(gateFor('listAccounts')).toEqual(['crm-001:read']);
    expect(gateFor('getAccount')).toEqual(['crm-001:read']);
    expect(gateFor('getTimeline')).toEqual(['crm-001:read']);
    expect(gateFor('createAccount')).toEqual(['crm-001:write']);
    expect(gateFor('patchAccount')).toEqual(['crm-001:write']);
    expect(gateFor('transitionStatus')).toEqual(['crm-001:write']);
  });

  it('subscription endpoints gate on CRM-003 read/write', () => {
    expect(gateFor('listSubscriptions')).toEqual(['crm-003:read']);
    expect(gateFor('createSubscription')).toEqual(['crm-003:write']);
    expect(gateFor('patchSubscription')).toEqual(['crm-003:write']);
    expect(gateFor('mrrSummary')).toEqual(['crm-003:read']);
  });

  it('contact endpoints gate on CRM-004 read/write', () => {
    expect(gateFor('listContacts')).toEqual(['crm-004:read']);
    expect(gateFor('createContact')).toEqual(['crm-004:write']);
    expect(gateFor('patchContact')).toEqual(['crm-004:write']);
    expect(gateFor('removeContact')).toEqual(['crm-004:write']);
  });

  it('interaction endpoints gate on CRM-006 read/write', () => {
    expect(gateFor('listInteractions')).toEqual(['crm-006:read']);
    expect(gateFor('createInteraction')).toEqual(['crm-006:write']);
  });

  it('onboarding endpoints gate on CRM-002 read/write', () => {
    expect(gateFor('getOnboarding')).toEqual(['crm-002:read']);
    expect(gateFor('initOnboarding')).toEqual(['crm-002:write']);
    expect(gateFor('patchOnboardingTask')).toEqual(['crm-002:write']);
  });

  it('health-score endpoints gate on CRM-005 read/write', () => {
    expect(gateFor('getAccountHealth')).toEqual(['crm-005:read']);
    expect(gateFor('atRisk')).toEqual(['crm-005:read']);
    expect(gateFor('recomputeHealth')).toEqual(['crm-005:write']);
    expect(gateFor('recordHealth')).toEqual(['crm-005:write']);
  });

  it('renewal endpoints gate on CRM-001 read/write', () => {
    expect(gateFor('listRenewals')).toEqual(['crm-001:read']);
    expect(gateFor('upcomingRenewals')).toEqual(['crm-001:read']);
    expect(gateFor('getRenewal')).toEqual(['crm-001:read']);
    expect(gateFor('createRenewal')).toEqual(['crm-001:write']);
    expect(gateFor('patchRenewal')).toEqual(['crm-001:write']);
  });

  it('catalogue endpoint is readable', () => {
    expect(gateFor('lifecycleCatalogue')).toEqual(['crm-001:read']);
  });
});
