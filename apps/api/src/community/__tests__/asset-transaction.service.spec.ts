import { describe, it, expect } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AssetTransactionService } from '../services/asset-transaction.service';
import { PLATFORM_FEE_PERCENT } from '../dto/community.dto';

/**
 * P2-21c — AssetTransactionService.purchase tests.
 *
 * THE 5% FEE SPLIT KEYSTONE per ADR-073. Tests verify:
 *   - 5% / 95% split arithmetic is exact for round values
 *   - service refuses purchase on SOLD listings
 *   - service refuses purchase on free (price_cents IS NULL) listings
 *   - service refuses SCHOOL purchase without buyerSchoolId
 *   - PLATFORM_FEE_PERCENT constant matches the docs (5)
 */
function makeStub(listing: {
  status: string;
  price_cents: number | null;
  seller_school_id?: string;
  seller_profile_id?: string;
}): {
  prisma: any;
  emits: Array<{ topic: string; payload: any; sourceModule: string }>;
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

  const emits: Array<{ topic: string; payload: any; sourceModule: string }> = [];
  return { prisma, emits, inserts };
}

function makeKafka(emits: Array<{ topic: string; payload: any; sourceModule: string }>): any {
  return {
    emit: async (o: { topic: string; payload: any; sourceModule: string }) => {
      emits.push(o);
    },
  };
}

const profilesStub: any = {
  addReputation: async () => undefined,
  getOrCreate: async () => ({ id: 'profile-1' }),
};

describe('P2-21c — AssetTransactionService.purchase (5% FEE SPLIT KEYSTONE)', () => {
  it('PLATFORM_FEE_PERCENT is 5', () => {
    expect(PLATFORM_FEE_PERCENT).toBe(5);
  });

  it('computes 5% / 95% split for round numbers', async () => {
    const stub = makeStub({ status: 'ACTIVE', price_cents: 10000 });
    const svc = new AssetTransactionService(stub.prisma, makeKafka(stub.emits), profilesStub);
    const dto = await svc.purchase(
      {
        accountId: 'a',
        personId: 'p',
        employeeId: null,
        personType: 'STAFF',
        isSchoolAdmin: false,
      },
      'l1',
      { buyerType: 'SCHOOL', buyerSchoolId: 's-1' },
    );
    expect(dto.totalPriceCents).toBe(10000);
    expect(dto.platformFeeCents).toBe(500);
    expect(dto.sellerReceivesCents).toBe(9500);
    expect(dto.platformFeeCents + dto.sellerReceivesCents).toBe(dto.totalPriceCents);
  });

  it('split sums to total when fee has rounding (sub-cent residue lands on seller)', async () => {
    const stub = makeStub({ status: 'ACTIVE', price_cents: 333 });
    const svc = new AssetTransactionService(stub.prisma, makeKafka(stub.emits), profilesStub);
    const dto = await svc.purchase(
      {
        accountId: 'a',
        personId: 'p',
        employeeId: null,
        personType: 'STAFF',
        isSchoolAdmin: false,
      },
      'l1',
      { buyerType: 'SCHOOL', buyerSchoolId: 's-1' },
    );
    // floor(333 * 5 / 100) = 16
    expect(dto.platformFeeCents).toBe(16);
    expect(dto.sellerReceivesCents).toBe(333 - 16);
    expect(dto.platformFeeCents + dto.sellerReceivesCents).toBe(333);
  });

  it('multiplies by quantity correctly', async () => {
    const stub = makeStub({ status: 'ACTIVE', price_cents: 1000 });
    const svc = new AssetTransactionService(stub.prisma, makeKafka(stub.emits), profilesStub);
    const dto = await svc.purchase(
      {
        accountId: 'a',
        personId: 'p',
        employeeId: null,
        personType: 'STAFF',
        isSchoolAdmin: false,
      },
      'l1',
      { buyerType: 'SCHOOL', buyerSchoolId: 's-1', quantity: 5 },
    );
    expect(dto.unitPriceCents).toBe(1000);
    expect(dto.quantity).toBe(5);
    expect(dto.totalPriceCents).toBe(5000);
    expect(dto.platformFeeCents).toBe(250);
    expect(dto.sellerReceivesCents).toBe(4750);
  });

  it('refuses purchase on a SOLD listing', async () => {
    const stub = makeStub({ status: 'SOLD', price_cents: 1000 });
    const svc = new AssetTransactionService(stub.prisma, makeKafka(stub.emits), profilesStub);
    await expect(
      svc.purchase(
        {
          accountId: 'a',
          personId: 'p',
          employeeId: null,
          personType: 'STAFF',
          isSchoolAdmin: false,
        },
        'l1',
        { buyerType: 'SCHOOL', buyerSchoolId: 's-1' },
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses purchase on a free listing (price_cents IS NULL)', async () => {
    const stub = makeStub({ status: 'ACTIVE', price_cents: null });
    const svc = new AssetTransactionService(stub.prisma, makeKafka(stub.emits), profilesStub);
    await expect(
      svc.purchase(
        {
          accountId: 'a',
          personId: 'p',
          employeeId: null,
          personType: 'STAFF',
          isSchoolAdmin: false,
        },
        'l1',
        { buyerType: 'SCHOOL', buyerSchoolId: 's-1' },
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses SCHOOL buyer without buyerSchoolId', async () => {
    const stub = makeStub({ status: 'ACTIVE', price_cents: 1000 });
    const svc = new AssetTransactionService(stub.prisma, makeKafka(stub.emits), profilesStub);
    await expect(
      svc.purchase(
        {
          accountId: 'a',
          personId: 'p',
          employeeId: null,
          personType: 'STAFF',
          isSchoolAdmin: false,
        },
        'l1',
        { buyerType: 'SCHOOL' },
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('defaults buyerPersonId to caller for INDIVIDUAL purchases', async () => {
    const stub = makeStub({ status: 'ACTIVE', price_cents: 1000 });
    const svc = new AssetTransactionService(stub.prisma, makeKafka(stub.emits), profilesStub);
    const dto = await svc.purchase(
      {
        accountId: 'a',
        personId: 'p-default',
        employeeId: null,
        personType: 'GUARDIAN',
        isSchoolAdmin: false,
      },
      'l1',
      { buyerType: 'INDIVIDUAL' },
    );
    expect(dto.buyerType).toBe('INDIVIDUAL');
    expect(dto.buyerPersonId).toBe('p-default');
  });

  it('insert includes the fee_split_chk-satisfying values', async () => {
    const stub = makeStub({ status: 'ACTIVE', price_cents: 1000 });
    const svc = new AssetTransactionService(stub.prisma, makeKafka(stub.emits), profilesStub);
    await svc.purchase(
      {
        accountId: 'a',
        personId: 'p',
        employeeId: null,
        personType: 'STAFF',
        isSchoolAdmin: false,
      },
      'l1',
      { buyerType: 'SCHOOL', buyerSchoolId: 's-1' },
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
