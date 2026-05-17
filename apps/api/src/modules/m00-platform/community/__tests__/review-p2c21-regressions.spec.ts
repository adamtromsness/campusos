import { describe, it, expect } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { MarketplaceListingService } from '../services/marketplace-listing.service';
import { AssetTransactionService } from '../services/asset-transaction.service';
import { WatchListService } from '../services/watch-list.service';
import { CommunityProfileService } from '../services/community-profile.service';
import { OutboxService } from '@shared/kafka';
import { deterministicAccountLifecycleEventId } from '@modules/m00-platform/crm/event-ids';
import { deterministicTenantAccessGrantedEventId } from '@modules/m00-platform/ops/event-ids';
import {
  deterministicListingPublishedEventId,
  deterministicTransactionCompletedEventId,
} from '../event-ids';
import { runWithTenantContextAsync } from '@shared/tenant';

/**
 * REVIEW-P2C21 ROUND 1 — pinned regression tests for the seven
 * BLOCKING findings + MAJOR 1.
 *
 * The 7 BLOCKINGs (and MAJOR 1) are each pinned in a separate
 * describe block so a future regression on any one fix surfaces
 * immediately. The fee-split arithmetic + parent-gate keystone
 * regressions live in their own spec files
 * (asset-transaction.service.spec.ts and
 * marketplace-listing.service.spec.ts respectively); this file
 * pins the access-control and event-durability fixes specifically.
 */

function withTenant<T>(schoolId: string, fn: () => Promise<T>): Promise<T> {
  return runWithTenantContextAsync(
    {
      tenant: {
        schoolId,
        schemaName: 'tenant_' + schoolId,
        organisationId: null,
        subdomain: 'test',
        isFrozen: false,
        planTier: 'standard',
        homeRegion: 'us-east-1',
      },
    },
    fn,
  );
}

function v5UuidRegex(): RegExp {
  // First 16 bytes of sha256 reshaped to UUID v5-style: 5xxxxxxx in
  // position 13, [8-b] in position 17.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
}

// ── BLOCKING 1 — Deterministic event ids ──────────────────────────

describe('REVIEW-P2C21 BLOCKING 1 — deterministic event ids', () => {
  it('deterministicAccountLifecycleEventId stable per (accountId, status)', () => {
    const a = deterministicAccountLifecycleEventId('acct-1', 'ACTIVE');
    const b = deterministicAccountLifecycleEventId('acct-1', 'ACTIVE');
    expect(a).toBe(b);
    expect(a).toMatch(v5UuidRegex());
  });

  it('deterministicAccountLifecycleEventId differs per target status', () => {
    const a = deterministicAccountLifecycleEventId('acct-1', 'ACTIVE');
    const b = deterministicAccountLifecycleEventId('acct-1', 'CHURNED');
    expect(a).not.toBe(b);
  });

  it('deterministicTenantAccessGrantedEventId stable per grantId + v5-shape', () => {
    const a = deterministicTenantAccessGrantedEventId('grant-1');
    const b = deterministicTenantAccessGrantedEventId('grant-1');
    expect(a).toBe(b);
    expect(a).toMatch(v5UuidRegex());
  });

  it('deterministicListingPublishedEventId stable per listingId + v5-shape', () => {
    const a = deterministicListingPublishedEventId('listing-1');
    const b = deterministicListingPublishedEventId('listing-1');
    expect(a).toBe(b);
    expect(a).toMatch(v5UuidRegex());
  });

  it('deterministicTransactionCompletedEventId stable per transactionId + v5-shape', () => {
    const a = deterministicTransactionCompletedEventId('txn-1');
    const b = deterministicTransactionCompletedEventId('txn-1');
    expect(a).toBe(b);
    expect(a).toMatch(v5UuidRegex());
  });

  it('the 4 event-id helpers produce topic-distinct ids for the same row', () => {
    // Same input string but different topic suffixes — the ids must
    // not collide.
    const a = deterministicAccountLifecycleEventId('x', 'ACTIVE');
    const b = deterministicTenantAccessGrantedEventId('x');
    const c = deterministicListingPublishedEventId('x');
    const d = deterministicTransactionCompletedEventId('x');
    expect(new Set([a, b, c, d]).size).toBe(4);
  });
});

// ── BLOCKING 2 — Marketplace patch school-scope admin override ──

describe('REVIEW-P2C21 BLOCKING 2 — MarketplaceListingService.patch school-admin scope', () => {
  function buildStub(sellerSchoolId: string) {
    return {
      $transaction: async (fn: (tx: any) => Promise<any>) =>
        fn({
          $queryRawUnsafe: async () => [],
          $executeRawUnsafe: async () => 1,
        }),
      $queryRawUnsafe: async () => [
        {
          id: 'listing-1',
          listing_type: 'BOOK',
          title: 'X',
          description: 'X',
          seller_school_id: sellerSchoolId,
          seller_profile_id: 'profile-A',
          seller_display_name: 'Seller',
          price_cents: 100,
          condition: null,
          category: null,
          tags: [],
          photo_s3_keys: [],
          status: 'ACTIVE',
          published_at: new Date(),
          created_at: new Date(),
          updated_at: new Date(),
          avg_rating: null,
          rating_count: 0,
          rank: 0,
        },
      ],
      $executeRawUnsafe: async () => 1,
    } as any;
  }

  const profiles: any = {
    getOrCreate: async () => ({ id: 'profile-other' }),
  };

  it('school admin from a DIFFERENT school cannot patch a listing', async () => {
    const stub = buildStub('school-seller');
    const svc = new MarketplaceListingService(stub, new OutboxService(), profiles);
    await expect(
      withTenant('school-other', () =>
        svc.patch(
          {
            accountId: 'a',
            personId: 'p',
            employeeId: 'e',
            personType: 'STAFF',
            isSchoolAdmin: true,
          },
          'listing-1',
          { title: 'evil' },
        ),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('school admin of the SELLER school CAN patch the listing', async () => {
    const stub = buildStub('school-seller');
    const svc = new MarketplaceListingService(stub, new OutboxService(), profiles);
    const dto = await withTenant('school-seller', () =>
      svc.patch(
        {
          accountId: 'a',
          personId: 'p',
          employeeId: 'e',
          personType: 'STAFF',
          isSchoolAdmin: true,
        },
        'listing-1',
        { title: 'new title' },
      ),
    );
    // The stub returns the same row (no actual mutation in the mock).
    expect(dto).toBeTruthy();
  });
});

// ── BLOCKING 6 — Watch list school-scope on get/fulfill/delete ──

describe('REVIEW-P2C21 BLOCKING 6 — WatchListService school-scope', () => {
  it('loadOrFail SQL filters on school_id (cross-school 404)', async () => {
    let lastSql = '';
    let lastParams: unknown[] = [];
    const stub: any = {
      $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
        lastSql = sql;
        lastParams = params;
        return [];
      },
      $executeRawUnsafe: async () => 1,
    };
    const svc = new WatchListService(stub);
    await expect(svc.getById('watch-1', 'school-A')).rejects.toThrow(NotFoundException);
    expect(lastSql).toContain('WHERE id = $1::uuid AND school_id = $2::uuid');
    expect(lastParams).toEqual(['watch-1', 'school-A']);
  });

  it('fulfill UPDATE SQL carries school_id predicate', async () => {
    const captured: { sql?: string; params?: unknown[] } = {};
    const stub: any = {
      $queryRawUnsafe: async () => [
        {
          id: 'watch-1',
          school_id: 'school-A',
          target_listing_type: 'BOOK',
          search_keywords: null,
          max_price_cents: null,
          condition_min: null,
          status: 'ACTIVE',
          created_by: 'p',
          fulfilled_at: null,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
      $executeRawUnsafe: async (sql: string, ...params: unknown[]) => {
        if (sql.includes('UPDATE platform.platform_marketplace_watch_lists')) {
          captured.sql = sql;
          captured.params = params;
        }
        return 1;
      },
    };
    const svc = new WatchListService(stub);
    await svc.fulfill('watch-1', 'school-A');
    expect(captured.sql).toContain('AND school_id = $2::uuid');
    expect(captured.params).toEqual(['watch-1', 'school-A']);
  });

  it('remove DELETE SQL carries school_id predicate', async () => {
    const captured: { sql?: string; params?: unknown[] } = {};
    const stub: any = {
      $queryRawUnsafe: async () => [
        {
          id: 'watch-1',
          school_id: 'school-A',
          target_listing_type: 'BOOK',
          search_keywords: null,
          max_price_cents: null,
          condition_min: null,
          status: 'ACTIVE',
          created_by: 'p',
          fulfilled_at: null,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
      $executeRawUnsafe: async (sql: string, ...params: unknown[]) => {
        if (sql.includes('DELETE FROM platform.platform_marketplace_watch_lists')) {
          captured.sql = sql;
          captured.params = params;
        }
        return 1;
      },
    };
    const svc = new WatchListService(stub);
    await svc.remove('watch-1', 'school-A');
    expect(captured.sql).toContain('AND school_id = $2::uuid');
    expect(captured.params).toEqual(['watch-1', 'school-A']);
  });
});

// ── BLOCKING 7 — Profile is_public enforcement ────────────────────

describe('REVIEW-P2C21 BLOCKING 7 — CommunityProfileService.getById respects is_public', () => {
  function buildStub(personId: string, isPublic: boolean) {
    return {
      $queryRawUnsafe: async () => [
        {
          id: 'profile-1',
          person_id: personId,
          display_name: 'Subject',
          bio: null,
          school_name: null,
          role_label: null,
          avatar_s3_key: null,
          reputation_points: 0,
          is_public: isPublic,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
      $executeRawUnsafe: async () => 1,
    } as any;
  }

  it('owner can always read their own private profile', async () => {
    const stub = buildStub('p-owner', false);
    const svc = new CommunityProfileService(stub);
    const dto = await svc.getById('profile-1', { personId: 'p-owner' });
    expect(dto.id).toBe('profile-1');
  });

  it("non-owner gets 404 on a private profile (collapsed don't-leak-existence)", async () => {
    const stub = buildStub('p-owner', false);
    const svc = new CommunityProfileService(stub);
    await expect(svc.getById('profile-1', { personId: 'p-stranger' })).rejects.toThrow(
      NotFoundException,
    );
  });

  it('non-owner can read a public profile', async () => {
    const stub = buildStub('p-owner', true);
    const svc = new CommunityProfileService(stub);
    const dto = await svc.getById('profile-1', { personId: 'p-stranger' });
    expect(dto.id).toBe('profile-1');
    expect(dto.isPublic).toBe(true);
  });

  it('actorless overload still works for internal callers', async () => {
    const stub = buildStub('p-owner', false);
    const svc = new CommunityProfileService(stub);
    const dto = await svc.getById('profile-1');
    expect(dto.id).toBe('profile-1');
  });
});
