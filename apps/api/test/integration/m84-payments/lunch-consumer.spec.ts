import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { LunchAccountService } from '@modules/m84-payments/lunch-account.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import {
  withTestTenant,
  TEST_SCHOOL_ID,
  TEST_SCHEMA,
} from '../helpers/tenant-context';
import { resetFinanceAdvancedTables } from '../helpers/reset';

/**
 * Drives LunchAccountService.chargeMealFromConsumer — the consumer
 * entry point fired by fds.meal.served events. Exercises:
 *   - Happy path: MEAL_CHARGE row inserted + balance decremented
 *   - Idempotent redelivery: duplicate source_event_id → no-op
 *   - Missing student → logs + returns no-op
 *   - Low-balance threshold crossed → pay.lunch.low_balance outbox
 *     row enqueued in-tx + last_low_balance_alert_at stamped
 *   - 24h alert throttle: a second meal in the same window does not
 *     re-emit
 */
describe('integration:m84-payments/lunch-consumer', () => {
  let tenantPrisma: TenantPrismaService;
  let outbox: OutboxService;
  let service: LunchAccountService;
  let rawClient: PrismaClient;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    outbox = new OutboxService();
    service = new LunchAccountService(tenantPrisma, outbox);
    rawClient = new PrismaClient();
    await rawClient.$connect();
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  const createdPersonIds: string[] = [];
  const createdPlatformStudentIds: string[] = [];

  beforeEach(async () => {
    await withTestTenant(async () => resetFinanceAdvancedTables(tenantPrisma));
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'LC-%'`,
    );
    if (createdPlatformStudentIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.platform_students WHERE id = ANY($1::uuid[])`,
        createdPlatformStudentIds.splice(0),
      );
    }
    if (createdPersonIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.iam_person WHERE id = ANY($1::uuid[])`,
        createdPersonIds.splice(0),
      );
    }
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_outbox WHERE topic = 'pay.lunch.low_balance' AND tenant_id = $1::uuid`,
      TEST_SCHOOL_ID,
    );
  });

  async function seedStudentWithLunchAccount(opts?: {
    balance?: number;
    threshold?: number;
  }): Promise<{ studentId: string; accountId: string }> {
    const personId = generateId();
    const platformStudentId = generateId();
    const studentId = generateId();
    const accountId = generateId();
    createdPersonIds.push(personId);
    createdPlatformStudentIds.push(platformStudentId);
    const suffix = generateId().slice(-8);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
       VALUES ($1::uuid, 'LC-Stu', $2, 'STUDENT', true)`,
      personId,
      'S-' + suffix,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
       VALUES ($1::uuid, $2::uuid, 'LC-Stu', $3, true)`,
      platformStudentId,
      personId,
      'S-' + suffix,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_students
         (id, school_id, platform_student_id, student_number, grade_level)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '5')`,
      studentId,
      TEST_SCHOOL_ID,
      platformStudentId,
      'LC-' + suffix,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.pay_lunch_accounts
         (id, school_id, student_id, balance, low_balance_threshold)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::numeric, $5::numeric)`,
      accountId,
      TEST_SCHOOL_ID,
      studentId,
      (opts?.balance ?? 100).toFixed(2),
      (opts?.threshold ?? 10).toFixed(2),
    );
    return { studentId, accountId };
  }

  async function readBalance(accountId: string): Promise<number> {
    const rows = (await rawClient.$queryRawUnsafe(
      `SELECT balance::text AS balance FROM ${TEST_SCHEMA}.pay_lunch_accounts WHERE id = $1::uuid`,
      accountId,
    )) as Array<{ balance: string }>;
    return Number(rows[0]!.balance);
  }

  async function countTransactions(accountId: string): Promise<number> {
    const rows = (await rawClient.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS c FROM ${TEST_SCHEMA}.pay_lunch_transactions WHERE lunch_account_id = $1::uuid`,
      accountId,
    )) as Array<{ c: number }>;
    return rows[0]!.c;
  }

  async function countLowBalanceOutbox(): Promise<number> {
    const rows = (await rawClient.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS c FROM platform.platform_outbox
         WHERE topic = 'pay.lunch.low_balance' AND tenant_id = $1::uuid`,
      TEST_SCHOOL_ID,
    )) as Array<{ c: number }>;
    return rows[0]!.c;
  }

  it('happy path: MEAL_CHARGE inserted, balance decremented, no low-balance emit when above threshold', async () => {
    const { studentId, accountId } = await seedStudentWithLunchAccount({
      balance: 50,
      threshold: 10,
    });
    const r = await withTestTenant(async () =>
      service.chargeMealFromConsumer({
        studentId,
        amount: 5,
        mealDate: '2026-05-15',
        posDeviceId: null,
        sourceEventId: generateId(),
        posSessionId: null,
      }),
    );
    expect(r.created).toBe(true);
    expect(r.balanceCrossedThreshold).toBe(false);
    expect(await readBalance(accountId)).toBe(45);
    expect(await countTransactions(accountId)).toBe(1);
    expect(await countLowBalanceOutbox()).toBe(0);
  });

  it('idempotent: duplicate source_event_id → no-op', async () => {
    const { studentId, accountId } = await seedStudentWithLunchAccount({ balance: 100 });
    const eventId = generateId();
    await withTestTenant(async () =>
      service.chargeMealFromConsumer({
        studentId,
        amount: 5,
        mealDate: '2026-05-15',
        posDeviceId: null,
        sourceEventId: eventId,
        posSessionId: null,
      }),
    );
    const r2 = await withTestTenant(async () =>
      service.chargeMealFromConsumer({
        studentId,
        amount: 5,
        mealDate: '2026-05-15',
        posDeviceId: null,
        sourceEventId: eventId,
        posSessionId: null,
      }),
    );
    expect(r2.created).toBe(false);
    // Balance only changed once.
    expect(await readBalance(accountId)).toBe(95);
    expect(await countTransactions(accountId)).toBe(1);
  });

  it('missing student → returns no-op without error', async () => {
    const r = await withTestTenant(async () =>
      service.chargeMealFromConsumer({
        studentId: generateId(),
        amount: 5,
        mealDate: '2026-05-15',
        posDeviceId: null,
        sourceEventId: generateId(),
        posSessionId: null,
      }),
    );
    expect(r.created).toBe(false);
    expect(r.balanceCrossedThreshold).toBe(false);
    expect(r.account).toBeNull();
  });

  it('crossing threshold emits pay.lunch.low_balance + stamps alert timestamp', async () => {
    const { studentId, accountId } = await seedStudentWithLunchAccount({
      balance: 15,
      threshold: 10,
    });
    // Charge enough to push below threshold.
    const r = await withTestTenant(async () =>
      service.chargeMealFromConsumer({
        studentId,
        amount: 7,
        mealDate: '2026-05-15',
        posDeviceId: null,
        sourceEventId: generateId(),
        posSessionId: null,
      }),
    );
    expect(r.created).toBe(true);
    expect(r.balanceCrossedThreshold).toBe(true);
    expect(await readBalance(accountId)).toBe(8);
    expect(await countLowBalanceOutbox()).toBe(1);

    // last_low_balance_alert_at stamped
    const acct = (await rawClient.$queryRawUnsafe(
      `SELECT last_low_balance_alert_at::text AS ts FROM ${TEST_SCHEMA}.pay_lunch_accounts WHERE id = $1::uuid`,
      accountId,
    )) as Array<{ ts: string | null }>;
    expect(acct[0]!.ts).not.toBeNull();
  });

  it('throttle: second meal within 24h does not re-emit', async () => {
    const { studentId } = await seedStudentWithLunchAccount({
      balance: 15,
      threshold: 10,
    });
    await withTestTenant(async () =>
      service.chargeMealFromConsumer({
        studentId,
        amount: 7,
        mealDate: '2026-05-15',
        posDeviceId: null,
        sourceEventId: generateId(),
        posSessionId: null,
      }),
    );
    expect(await countLowBalanceOutbox()).toBe(1);
    await withTestTenant(async () =>
      service.chargeMealFromConsumer({
        studentId,
        amount: 1,
        mealDate: '2026-05-15',
        posDeviceId: null,
        sourceEventId: generateId(),
        posSessionId: null,
      }),
    );
    // Already below threshold and within 24h → no second outbox row.
    expect(await countLowBalanceOutbox()).toBe(1);
  });
});
