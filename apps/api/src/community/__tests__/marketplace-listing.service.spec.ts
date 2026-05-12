import { describe, it, expect } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { MarketplaceListingService } from '../services/marketplace-listing.service';

/**
 * P2-21c — MarketplaceListingService.assertCanCreateListing tests.
 *
 * The parent gate keystone (ADR-073). Parents and students hold
 * MKT-001:read for browsing but the SERVICE LAYER refuses listing
 * creation regardless of permission tier.
 */
function buildService(): MarketplaceListingService {
  const prisma: any = {};
  const kafka: any = { emit: async () => {} };
  const profiles: any = {};
  return new MarketplaceListingService(prisma, kafka, profiles);
}

describe('P2-21c — MarketplaceListingService.assertCanCreateListing (PARENT GATE KEYSTONE)', () => {
  const service = buildService();

  it('allows STAFF actors to create listings', () => {
    expect(() =>
      service.assertCanCreateListing({
        accountId: 'a',
        personId: 'p',
        employeeId: 'e',
        personType: 'STAFF',
        isSchoolAdmin: false,
      }),
    ).not.toThrow();
  });

  it('allows school admin actors to create listings (regardless of personType)', () => {
    expect(() =>
      service.assertCanCreateListing({
        accountId: 'a',
        personId: 'p',
        employeeId: null,
        personType: 'GUARDIAN',
        isSchoolAdmin: true,
      }),
    ).not.toThrow();
  });

  it('refuses GUARDIAN actors with a friendly 403 — ADR-073', () => {
    expect(() =>
      service.assertCanCreateListing({
        accountId: 'a',
        personId: 'p',
        employeeId: null,
        personType: 'GUARDIAN',
        isSchoolAdmin: false,
      }),
    ).toThrow(ForbiddenException);
  });

  it('refuses STUDENT actors', () => {
    expect(() =>
      service.assertCanCreateListing({
        accountId: 'a',
        personId: 'p',
        employeeId: null,
        personType: 'STUDENT',
        isSchoolAdmin: false,
      }),
    ).toThrow(ForbiddenException);
  });

  it('refuses null personType (defence-in-depth)', () => {
    expect(() =>
      service.assertCanCreateListing({
        accountId: 'a',
        personId: 'p',
        employeeId: null,
        personType: null,
        isSchoolAdmin: false,
      }),
    ).toThrow(ForbiddenException);
  });

  it('uses the canonical ADR-073 redirect message on parent refusal', () => {
    try {
      service.assertCanCreateListing({
        accountId: 'a',
        personId: 'p',
        employeeId: null,
        personType: 'GUARDIAN',
        isSchoolAdmin: false,
      });
      expect.fail('expected ForbiddenException');
    } catch (e) {
      expect((e as Error).message).toContain('Only school staff can create marketplace listings');
      expect((e as Error).message).toContain('Parents and students may browse and purchase');
      expect((e as Error).message).toContain('ADR-073');
    }
  });
});
