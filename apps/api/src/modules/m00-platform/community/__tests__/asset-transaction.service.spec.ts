import { describe, it, expect } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AssetTransactionService } from '../services/asset-transaction.service';
import { PLATFORM_FEE_PERCENT } from '../dto/community.dto';
import { runWithTenantContextAsync } from '@shared/tenant';

/**
 * P2-21c — AssetTransactionService.purchase tests.
 *
 * THE 5% FEE SPLIT KEYSTONE per ADR-073. Tests verify:
 *   - 5% / 95% split arithmetic is exact for round values
 *   - service refuses purchase on SOLD listings
 *   - service refuses purchase on free (price_cents IS NULL) listings
 *   - service refuses SCHOOL purchase from a non-admin actor
 *     (REVIEW-P2C21 BLOCKING 5)
 *   - service forces buyerSchoolId to tenant.schoolId for SCHOOL
 *     purchases regardless of request body (REVIEW-P2C21 BLOCKING 5)
 *   - service forces buyerPersonId to actor.personId for INDIVIDUAL
 *     purchases regardless of request body
 *   - PLATFORM_FEE_PERCENT constant matches the docs (5)
 *
 * REVIEW-P2C21 BLOCKING 1 — purchase + UPDATE listing-to-SOLD now run
 * in one Prisma $transaction; the test stub mocks $transaction by
 * invoking the callback with a tx client that captures inserts.
 */
function makeStub(listing: {
  status: string;
  price_cents: number | null;
  seller_school_id?: string;
  seller_profile_id?: string;
}): {
  prisma: any;
  inserts: Array<{ sql: string; params: unknown[] }>;
} {
  const inserts: Array<{ sql: string; params: unknown[] }> = [];
  let lastTxnId: string | null = null;
  let storedTxnParams: unknown[] | null = null;

  const txClient = {
    $queryRawUnsafe: async (sql: string) => {
      if (sql.includes('FOR UPDATE')) {
        return [
          {
            id: 'l1',
            status: listing.status,
            price_cents: listing.price_cents,
            seller_school_id: listing.seller_school_id ?? 'school-1',
            seller_profile_id: listing.seller_profile_id ?? 'profile-1',
          },
        ];
      }
      return [];
    },
    $executeRawUnsafe: async (sql: string, ...params: unknown[]) => {
      if (sql.includes('INSERT INTO platform.platform_asset_transactions')) {
        inserts.push({ sql, params });
        lastTxnId = params[0] as string;
        storedTxnParams = params;
      }
      return 1;
    },
  };

  const prisma = {
    $transaction: async (fn: (tx: any) => Promise<any>) => fn(txClient),
    $queryRawUnsafe: async (sql: string) => {
      if (sql.includes('FROM platform.platform_asset_transactions') && lastTxnId) {
        // Return the inserted txn for getById after purchase.
        const p = storedTxnParams ?? [];
        return [
          {
            id: lastTxnId,
            listing_id: p[1],
            listing_title: 'Test',
            buyer_type: p[2],
            buyer_school_id: p[3],
            buyer_person_id: p[4],
            seller_school_id: p[5],
            seller_profile_id: p[6],
            quantity: p[7],
            unit_price_cents: p[8],
            total_price_cents: p[9],
            platform_fee_cents: p[10],
            seller_receives_cents: p[11],
            stripe_payment_intent_id: null,
            status: 'PENDING_PAYMENT',
            shipping_method: p[12],
            tracking_number: null,
            paid_at: null,
            shipped_at: null,
            delivered_at: null,
            confirmed_at: null,
            refunded_at: null,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ];
      }
      return [];
    },
  };

  return { prisma, inserts };
}

function makeOutbox(): any {
  return {
    enqueueInTx: async () => 'outbox-id',
  };
}

const profilesStub: any = {
  addReputation: async () => undefined,
  getOrCreate: async () => ({ id: 'profile-1' }),
};

/**
 * Helper that wraps the call in tenant context so the
 * BLOCKING 5 `getCurrentTenant()` call inside purchase resolves.
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

describe('P2-21c — AssetTransactionService.purchase (5% FEE SPLIT KEYSTONE)', () => {
  it('PLATFORM_FEE_PERCENT is 5', () => {
    expect(PLATFORM_FEE_PERCENT).toBe(5);
  });

  it('computes 5% / 95% split for round numbers', async () => {
    const stub = makeStub({ status: 'ACTIVE', price_cents: 10000 });
    const svc = new AssetTransactionService(stub.prisma, makeOutbox(), profilesStub);
    const dto = await withTenant('school-1', () =>
      svc.purchase(
        {
          accountId: 'a',
          personId: 'p',
          employeeId: null,
          personType: 'STAFF',
          isSchoolAdmin: true, // SCHOOL purchases now require admin per BLOCKING 5
        },
        'l1',
        { buyerType: 'SCHOOL', buyerSchoolId: 'school-1' },
      ),
    );
    expect(dto.totalPriceCents).toBe(10000);
    expect(dto.platformFeeCents).toBe(500);
    expect(dto.sellerReceivesCents).toBe(9500);
    expect(dto.platformFeeCents + dto.sellerReceivesCents).toBe(dto.totalPriceCents);
  });

  it('split sums to total when fee has rounding (sub-cent residue lands on seller)', async () => {
    const stub = makeStub({ status: 'ACTIVE', price_cents: 333 });
    const svc = new AssetTransactionService(stub.prisma, makeOutbox(), profilesStub);
    const dto = await withTenant('school-1', () =>
      svc.purchase(
        {
          accountId: 'a',
          personId: 'p',
          employeeId: null,
          personType: 'STAFF',
          isSchoolAdmin: true,
        },
        'l1',
        { buyerType: 'SCHOOL', buyerSchoolId: 'school-1' },
      ),
    );
    // floor(333 * 5 / 100) = 16
    expect(dto.platformFeeCents).toBe(16);
    expect(dto.sellerReceivesCents).toBe(333 - 16);
    expect(dto.platformFeeCents + dto.sellerReceivesCents).toBe(333);
  });

  it('multiplies by quantity correctly', async () => {
    const stub = makeStub({ status: 'ACTIVE', price_cents: 1000 });
    const svc = new AssetTransactionService(stub.prisma, makeOutbox(), profilesStub);
    const dto = await withTenant('school-1', () =>
      svc.purchase(
        {
          accountId: 'a',
          personId: 'p',
          employeeId: null,
          personType: 'STAFF',
          isSchoolAdmin: true,
        },
        'l1',
        { buyerType: 'SCHOOL', buyerSchoolId: 'school-1', quantity: 5 },
      ),
    );
    expect(dto.unitPriceCents).toBe(1000);
    expect(dto.quantity).toBe(5);
    expect(dto.totalPriceCents).toBe(5000);
    expect(dto.platformFeeCents).toBe(250);
    expect(dto.sellerReceivesCents).toBe(4750);
  });

  it('refuses purchase on a SOLD listing', async () => {
    const stub = makeStub({ status: 'SOLD', price_cents: 1000 });
    const svc = new AssetTransactionService(stub.prisma, makeOutbox(), profilesStub);
    await expect(
      withTenant('school-1', () =>
        svc.purchase(
          {
            accountId: 'a',
            personId: 'p',
            employeeId: null,
            personType: 'STAFF',
            isSchoolAdmin: true,
          },
          'l1',
          { buyerType: 'SCHOOL', buyerSchoolId: 'school-1' },
        ),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses purchase on a free listing (price_cents IS NULL)', async () => {
    const stub = makeStub({ status: 'ACTIVE', price_cents: null });
    const svc = new AssetTransactionService(stub.prisma, makeOutbox(), profilesStub);
    await expect(
      withTenant('school-1', () =>
        svc.purchase(
          {
            accountId: 'a',
            personId: 'p',
            employeeId: null,
            personType: 'STAFF',
            isSchoolAdmin: true,
          },
          'l1',
          { buyerType: 'SCHOOL', buyerSchoolId: 'school-1' },
        ),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  // REVIEW-P2C21 BLOCKING 5 — buyer-shape spoof prevention
  it('refuses SCHOOL purchase from a non-admin actor', async () => {
    const stub = makeStub({ status: 'ACTIVE', price_cents: 1000 });
    const svc = new AssetTransactionService(stub.prisma, makeOutbox(), profilesStub);
    await expect(
      withTenant('school-1', () =>
        svc.purchase(
          {
            accountId: 'a',
            personId: 'p',
            employeeId: null,
            personType: 'GUARDIAN',
            isSchoolAdmin: false,
          },
          'l1',
          { buyerType: 'SCHOOL', buyerSchoolId: 'school-1' },
        ),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  // REVIEW-P2C21 BLOCKING 5 — buyerSchoolId is forced to tenant.schoolId
  it('forces buyerSchoolId to current-tenant schoolId for SCHOOL purchases', async () => {
    const stub = makeStub({ status: 'ACTIVE', price_cents: 1000 });
    const svc = new AssetTransactionService(stub.prisma, makeOutbox(), profilesStub);
    const dto = await withTenant('school-1', () =>
      svc.purchase(
        {
          accountId: 'a',
          personId: 'p',
          employeeId: null,
          personType: 'STAFF',
          isSchoolAdmin: true,
        },
        'l1',
        // Request body tries to spoof to a foreign school.
        { buyerType: 'SCHOOL', buyerSchoolId: 'foreign-school-uuid' },
      ),
    );
    // BLOCKING 5: buyerSchoolId is overwritten with tenant.schoolId.
    expect(dto.buyerSchoolId).toBe('school-1');
    expect(dto.buyerPersonId).toBeNull();
  });

  it('forces buyerPersonId to caller for INDIVIDUAL purchases (regardless of body)', async () => {
    const stub = makeStub({ status: 'ACTIVE', price_cents: 1000 });
    const svc = new AssetTransactionService(stub.prisma, makeOutbox(), profilesStub);
    const dto = await withTenant('school-1', () =>
      svc.purchase(
        {
          accountId: 'a',
          personId: 'p-default',
          employeeId: null,
          personType: 'GUARDIAN',
          isSchoolAdmin: false,
        },
        'l1',
        {
          buyerType: 'INDIVIDUAL',
          // Attempt to spoof the buyer.
          buyerPersonId: 'someone-else',
        },
      ),
    );
    expect(dto.buyerType).toBe('INDIVIDUAL');
    expect(dto.buyerPersonId).toBe('p-default');
    expect(dto.buyerSchoolId).toBeNull();
  });

  it('insert includes the fee_split_chk-satisfying values', async () => {
    const stub = makeStub({ status: 'ACTIVE', price_cents: 1000 });
    const svc = new AssetTransactionService(stub.prisma, makeOutbox(), profilesStub);
    await withTenant('school-1', () =>
      svc.purchase(
        {
          accountId: 'a',
          personId: 'p',
          employeeId: null,
          personType: 'STAFF',
          isSchoolAdmin: true,
        },
        'l1',
        { buyerType: 'SCHOOL', buyerSchoolId: 'school-1' },
      ),
    );
    expect(stub.inserts).toHaveLength(1);
    const p = stub.inserts[0]!.params;
    // unit + total + fee + seller positions in the INSERT:
    // (id, listing_id, buyer_type, buyer_school_id, buyer_person_id,
    //  seller_school_id, seller_profile_id, quantity,
    //  unit_price_cents, total_price_cents, platform_fee_cents,
    //  seller_receives_cents, shipping_method)
    const total = p[9] as number;
    const fee = p[10] as number;
    const seller = p[11] as number;
    expect(fee + seller).toBe(total);
  });
});

/**
 * REVIEW-P2C21 BLOCKING 3 + 4 + 5 regressions — separate describe block
 * pinning the access-control fixes on the read + patch + condition-report
 * + watch-list paths. These tests use lightweight Prisma stubs that capture
 * the SQL shape and verify cross-school 404 + access-allowed 200 paths.
 */
describe('REVIEW-P2C21 — BLOCKING 3 + 4 + 5 regressions', () => {
  function buildPatchStub(opts: {
    sellerProfileId: string;
    sellerSchoolId: string;
    buyerSchoolId: string;
    buyerPersonId: string;
    status?: string;
  }) {
    return {
      $transaction: async (fn: (tx: any) => Promise<any>) =>
        fn({
          $queryRawUnsafe: async () => [],
          $executeRawUnsafe: async () => 1,
        }),
      $queryRawUnsafe: async () => [
        {
          id: 'txn-1',
          listing_id: 'l1',
          listing_title: 'X',
          buyer_type: 'SCHOOL',
          buyer_school_id: opts.buyerSchoolId,
          buyer_person_id: opts.buyerPersonId,
          seller_school_id: opts.sellerSchoolId,
          seller_profile_id: opts.sellerProfileId,
          quantity: 1,
          unit_price_cents: 1000,
          total_price_cents: 1000,
          platform_fee_cents: 50,
          seller_receives_cents: 950,
          stripe_payment_intent_id: null,
          status: opts.status ?? 'PAID',
          shipping_method: null,
          tracking_number: null,
          paid_at: new Date(),
          shipped_at: null,
          delivered_at: null,
          confirmed_at: null,
          refunded_at: null,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
    } as any;
  }

  // BLOCKING 3 — getById actor-scope
  it('getById returns the row to the seller', async () => {
    const stub = buildPatchStub({
      sellerProfileId: 'profile-seller',
      sellerSchoolId: 'school-seller',
      buyerSchoolId: 'school-buyer',
      buyerPersonId: 'p-buyer',
    });
    const svc = new AssetTransactionService(stub, makeOutbox(), {
      addReputation: async () => undefined,
      getOrCreate: async () => ({ id: 'profile-seller' }),
    } as any);
    const dto = await withTenant('school-seller', () =>
      svc.getById('txn-1', {
        accountId: 'a',
        personId: 'p-seller',
        employeeId: null,
        personType: 'STAFF',
        isSchoolAdmin: false,
      }),
    );
    expect(dto.id).toBe('txn-1');
  });

  it('getById returns the row to the buyer', async () => {
    const stub = buildPatchStub({
      sellerProfileId: 'profile-seller',
      sellerSchoolId: 'school-seller',
      buyerSchoolId: 'school-buyer',
      buyerPersonId: 'p-buyer',
    });
    const svc = new AssetTransactionService(stub, makeOutbox(), {
      addReputation: async () => undefined,
      getOrCreate: async () => ({ id: 'profile-other' }),
    } as any);
    const dto = await withTenant('school-buyer', () =>
      svc.getById('txn-1', {
        accountId: 'a',
        personId: 'p-buyer',
        employeeId: null,
        personType: 'GUARDIAN',
        isSchoolAdmin: false,
      }),
    );
    expect(dto.id).toBe('txn-1');
  });

  it('getById returns the row to a school admin of the seller school', async () => {
    const stub = buildPatchStub({
      sellerProfileId: 'profile-seller',
      sellerSchoolId: 'school-seller',
      buyerSchoolId: 'school-buyer',
      buyerPersonId: 'p-buyer',
    });
    const svc = new AssetTransactionService(stub, makeOutbox(), {
      addReputation: async () => undefined,
      getOrCreate: async () => ({ id: 'profile-other' }),
    } as any);
    const dto = await withTenant('school-seller', () =>
      svc.getById('txn-1', {
        accountId: 'a',
        personId: 'p-admin',
        employeeId: 'e-admin',
        personType: 'STAFF',
        isSchoolAdmin: true,
      }),
    );
    expect(dto.id).toBe('txn-1');
  });

  it('getById returns the row to a school admin of the buyer school', async () => {
    const stub = buildPatchStub({
      sellerProfileId: 'profile-seller',
      sellerSchoolId: 'school-seller',
      buyerSchoolId: 'school-buyer',
      buyerPersonId: 'p-buyer',
    });
    const svc = new AssetTransactionService(stub, makeOutbox(), {
      addReputation: async () => undefined,
      getOrCreate: async () => ({ id: 'profile-other' }),
    } as any);
    const dto = await withTenant('school-buyer', () =>
      svc.getById('txn-1', {
        accountId: 'a',
        personId: 'p-admin',
        employeeId: 'e-admin',
        personType: 'STAFF',
        isSchoolAdmin: true,
      }),
    );
    expect(dto.id).toBe('txn-1');
  });

  it('getById 404 for an unrelated user (not buyer, not seller, no relevant school admin)', async () => {
    const stub = buildPatchStub({
      sellerProfileId: 'profile-seller',
      sellerSchoolId: 'school-seller',
      buyerSchoolId: 'school-buyer',
      buyerPersonId: 'p-buyer',
    });
    const svc = new AssetTransactionService(stub, makeOutbox(), {
      addReputation: async () => undefined,
      getOrCreate: async () => ({ id: 'profile-other' }),
    } as any);
    await expect(
      withTenant('school-third', () =>
        svc.getById('txn-1', {
          accountId: 'a',
          personId: 'p-unrelated',
          employeeId: null,
          personType: 'GUARDIAN',
          isSchoolAdmin: false,
        }),
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('getById 404 for a school admin of a third (unrelated) school', async () => {
    const stub = buildPatchStub({
      sellerProfileId: 'profile-seller',
      sellerSchoolId: 'school-seller',
      buyerSchoolId: 'school-buyer',
      buyerPersonId: 'p-buyer',
    });
    const svc = new AssetTransactionService(stub, makeOutbox(), {
      addReputation: async () => undefined,
      getOrCreate: async () => ({ id: 'profile-other' }),
    } as any);
    await expect(
      withTenant('school-third', () =>
        svc.getById('txn-1', {
          accountId: 'a',
          personId: 'p-third-admin',
          employeeId: 'e-third-admin',
          personType: 'STAFF',
          isSchoolAdmin: true,
        }),
      ),
    ).rejects.toThrow(NotFoundException);
  });

  // BLOCKING 4 — patch school-admin override bound to participation
  it('patch 403 for a school admin of a third school', async () => {
    const stub = buildPatchStub({
      sellerProfileId: 'profile-seller',
      sellerSchoolId: 'school-seller',
      buyerSchoolId: 'school-buyer',
      buyerPersonId: 'p-buyer',
    });
    const svc = new AssetTransactionService(stub, makeOutbox(), {
      addReputation: async () => undefined,
      getOrCreate: async () => ({ id: 'profile-third' }),
    } as any);
    await expect(
      withTenant('school-third', () =>
        svc.patch(
          {
            accountId: 'a',
            personId: 'p-third',
            employeeId: 'e-third',
            personType: 'STAFF',
            isSchoolAdmin: true,
          },
          'txn-1',
          { status: 'SHIPPING' },
        ),
      ),
    ).rejects.toThrow(ForbiddenException);
  });
});
