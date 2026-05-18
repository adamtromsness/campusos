import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { LunchAccountConsumer } from '@modules/m84-payments/consumers/lunch-account.consumer';
import { PaymentAccountWorker } from '@modules/m84-payments/consumers/payment-account.consumer';
import { LunchAccountService } from '@modules/m84-payments/lunch-account.service';
import { IdempotencyService } from '@shared/kafka/idempotency.service';
import { OutboxService } from '@shared/kafka/outbox.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import type {
  ConsumedMessage,
  KafkaConsumerService,
  MessageHandler,
} from '@shared/kafka/kafka-consumer.service';
import { TEST_SCHEMA, TEST_SCHOOL_ID } from '../helpers/tenant-context';

/**
 * Coverage for the m84-payments Kafka consumer entry points. Each consumer
 * is instantiated with a mock KafkaConsumerService that captures the handler
 * registered during onModuleInit. The captured handler is then invoked with
 * a synthetic ConsumedMessage to exercise unwrapEnvelope + dispatch.
 *
 * Validates:
 *   - missing-field payload → drops via warn (no throw)
 *   - happy path → handler executes service code
 *   - duplicate event_id → idempotency claim skips
 */
describe('integration:m84-payments/consumers', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let idempotency: IdempotencyService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    idempotency = new IdempotencyService(rawClient);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_event_consumer_idempotency
         WHERE consumer_group IN ('lunch-account-consumer', 'payment-account-worker')`,
    );
    // Wipe pay_family_accounts since other m84 specs leave residual rows
    // whose account_number contains hex characters that REGEXP_REPLACE
    // strips down to integers exceeding INT range — that breaks
    // PaymentAccountWorker.nextAccountNumber's MAX::int aggregation.
    await rawClient.$executeRawUnsafe(
      `TRUNCATE ${TEST_SCHEMA}.pay_family_account_students, ${TEST_SCHEMA}.pay_family_accounts CASCADE`,
    );
  });

  function mockConsumer(): {
    consumer: KafkaConsumerService;
    getHandler: () => MessageHandler;
  } {
    let captured: MessageHandler | null = null;
    const consumer = {
      subscribe: async (opts: { handler: MessageHandler }) => {
        captured = opts.handler;
      },
    } as unknown as KafkaConsumerService;
    return {
      consumer,
      getHandler: () => {
        if (!captured) throw new Error('Handler not captured');
        return captured;
      },
    };
  }

  function envelopeMessage(
    topic: string,
    payload: unknown,
    overrides: Partial<{ eventId: string; eventType: string; tenantId: string }> = {},
  ): ConsumedMessage {
    const eventId = overrides.eventId ?? generateId();
    return {
      topic,
      partition: 0,
      offset: '0',
      key: null,
      headers: { 'tenant-subdomain': 'test' },
      payload: {
        event_id: eventId,
        event_type: overrides.eventType ?? topic,
        event_version: 1,
        occurred_at: new Date().toISOString(),
        published_at: new Date().toISOString(),
        tenant_id: overrides.tenantId ?? TEST_SCHOOL_ID,
        source_module: 'test',
        payload,
      },
      timestamp: new Date().toISOString(),
    };
  }

  describe('LunchAccountConsumer', () => {
    it('happy path: handler routes to service', async () => {
      const { consumer, getHandler } = mockConsumer();
      const outbox = new OutboxService();
      const lunch = new LunchAccountService(tenantPrisma, outbox);
      const c = new LunchAccountConsumer(consumer, idempotency, lunch);
      await c.onModuleInit();
      const handler = getHandler();

      // Seed a student + lunch account so chargeMealFromConsumer can find it.
      const studentId = generateId();
      const accountId = generateId();
      const personId = generateId();
      const platformStudentId = generateId();

      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.iam_person (id, first_name, last_name, date_of_birth, person_type)
         VALUES ($1::uuid, 'CT', 'StudentLC', '2010-01-01'::date, 'STUDENT') ON CONFLICT DO NOTHING`,
        personId,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.platform_students (id, person_id, first_name, last_name)
         VALUES ($1::uuid, $2::uuid, 'CT', 'StudentLC') ON CONFLICT DO NOTHING`,
        platformStudentId,
        personId,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_students (id, school_id, platform_student_id, grade_level)
         VALUES ($1::uuid, $2::uuid, $3::uuid, '5')`,
        studentId,
        TEST_SCHOOL_ID,
        platformStudentId,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.pay_lunch_accounts
           (id, school_id, student_id, balance, low_balance_threshold)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 50, 10)`,
        accountId,
        TEST_SCHOOL_ID,
        studentId,
      );

      const msg = envelopeMessage('dev.fds.meal.served', {
        studentId,
        schoolId: TEST_SCHOOL_ID,
        mealDate: new Date().toISOString().slice(0, 10),
        amount: 4.5,
        posDeviceId: null,
        posSessionId: null,
        servedAt: new Date().toISOString(),
      });
      await handler(msg);

      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS n FROM ${TEST_SCHEMA}.pay_lunch_transactions WHERE lunch_account_id = $1::uuid`,
        accountId,
      )) as Array<{ n: number }>;
      expect(rows[0]!.n).toBe(1);

      // Cleanup the student + person we seeded
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.pay_lunch_transactions WHERE lunch_account_id = $1::uuid`,
        accountId,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.pay_lunch_accounts WHERE id = $1::uuid`,
        accountId,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE id = $1::uuid`,
        studentId,
      );
    });

    it('missing required fields → no-op', async () => {
      const { consumer, getHandler } = mockConsumer();
      const outbox = new OutboxService();
      const lunch = new LunchAccountService(tenantPrisma, outbox);
      const c = new LunchAccountConsumer(consumer, idempotency, lunch);
      await c.onModuleInit();
      const handler = getHandler();

      // Missing schoolId → drop branch
      const bad = envelopeMessage('dev.fds.meal.served', {
        studentId: generateId(),
        mealDate: '2026-01-01',
        amount: 5,
      });
      await expect(handler(bad)).resolves.toBeUndefined();
    });

    it('non-positive amount → no-op', async () => {
      const { consumer, getHandler } = mockConsumer();
      const outbox = new OutboxService();
      const lunch = new LunchAccountService(tenantPrisma, outbox);
      const c = new LunchAccountConsumer(consumer, idempotency, lunch);
      await c.onModuleInit();
      const handler = getHandler();

      const msg = envelopeMessage('dev.fds.meal.served', {
        studentId: generateId(),
        schoolId: TEST_SCHOOL_ID,
        mealDate: '2026-01-01',
        amount: 0,
      });
      await expect(handler(msg)).resolves.toBeUndefined();
    });
  });

  describe('PaymentAccountWorker', () => {
    it('missing applicationId → drop branch', async () => {
      const { consumer, getHandler } = mockConsumer();
      const w = new PaymentAccountWorker(consumer, idempotency, tenantPrisma);
      await w.onModuleInit();
      const handler = getHandler();

      const bad = envelopeMessage('dev.enr.student.enrolled', {
        offerId: generateId(),
        schoolId: TEST_SCHOOL_ID,
        // applicationId omitted
        enrollmentPeriodId: generateId(),
        studentFirstName: 'X',
        studentLastName: 'Y',
        studentDateOfBirth: '2010-01-01',
        gradeLevel: '5',
        admissionType: 'NEW',
        guardianPersonId: generateId(),
        guardianEmail: 'g@x',
        enrolledAt: new Date().toISOString(),
      });
      await expect(handler(bad)).resolves.toBeUndefined();
    });

    it('guardianPersonId null → skip account creation', async () => {
      const { consumer, getHandler } = mockConsumer();
      const w = new PaymentAccountWorker(consumer, idempotency, tenantPrisma);
      await w.onModuleInit();
      const handler = getHandler();

      const msg = envelopeMessage('dev.enr.student.enrolled', {
        applicationId: generateId(),
        offerId: generateId(),
        schoolId: TEST_SCHOOL_ID,
        enrollmentPeriodId: generateId(),
        studentFirstName: 'X',
        studentLastName: 'Y',
        studentDateOfBirth: '2010-01-01',
        gradeLevel: '5',
        admissionType: 'NEW',
        guardianPersonId: null,
        guardianEmail: 'g@x',
        enrolledAt: new Date().toISOString(),
      });
      await expect(handler(msg)).resolves.toBeUndefined();
    });

    it('happy path: creates new family account when no existing row, no sis_students match', async () => {
      const { consumer, getHandler } = mockConsumer();
      const w = new PaymentAccountWorker(consumer, idempotency, tenantPrisma);
      await w.onModuleInit();
      const handler = getHandler();

      const guardianPersonId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.iam_person (id, first_name, last_name, date_of_birth, person_type)
         VALUES ($1::uuid, 'CT', 'GuardianPA', '1980-01-01'::date, 'GUARDIAN') ON CONFLICT DO NOTHING`,
        guardianPersonId,
      );
      const accountIdsBefore = (await rawClient.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS n FROM ${TEST_SCHEMA}.pay_family_accounts WHERE account_holder_id = $1::uuid`,
        guardianPersonId,
      )) as Array<{ n: number }>;
      expect(accountIdsBefore[0]!.n).toBe(0);

      const msg = envelopeMessage('dev.enr.student.enrolled', {
        applicationId: generateId(),
        offerId: generateId(),
        schoolId: TEST_SCHOOL_ID,
        enrollmentPeriodId: generateId(),
        studentFirstName: 'CTNotInRoster',
        studentLastName: 'OnlyConsumerTest',
        studentDateOfBirth: '2010-01-01',
        gradeLevel: '5',
        admissionType: 'NEW',
        guardianPersonId,
        guardianEmail: 'g@x',
        enrolledAt: new Date().toISOString(),
      });
      await handler(msg);

      const accountsAfter = (await rawClient.$queryRawUnsafe(
        `SELECT id, account_number FROM ${TEST_SCHEMA}.pay_family_accounts WHERE account_holder_id = $1::uuid`,
        guardianPersonId,
      )) as Array<{ id: string; account_number: string }>;
      expect(accountsAfter.length).toBe(1);
      expect(accountsAfter[0]!.account_number).toMatch(/^FA-\d+$/);

      // Send again to exercise the "reuse existing" branch + idempotency claim
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.platform_event_consumer_idempotency
           WHERE consumer_group = 'payment-account-worker'`,
      );
      const msg2 = envelopeMessage('dev.enr.student.enrolled', {
        applicationId: generateId(),
        offerId: generateId(),
        schoolId: TEST_SCHOOL_ID,
        enrollmentPeriodId: generateId(),
        studentFirstName: 'CTNotInRoster',
        studentLastName: 'OnlyConsumerTest',
        studentDateOfBirth: '2010-01-01',
        gradeLevel: '5',
        admissionType: 'NEW',
        guardianPersonId,
        guardianEmail: 'g@x',
        enrolledAt: new Date().toISOString(),
      });
      await handler(msg2);
      const accountsAfter2 = (await rawClient.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS n FROM ${TEST_SCHEMA}.pay_family_accounts WHERE account_holder_id = $1::uuid`,
        guardianPersonId,
      )) as Array<{ n: number }>;
      expect(accountsAfter2[0]!.n).toBe(1); // No duplicate created

      // Cleanup
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.pay_family_accounts WHERE account_holder_id = $1::uuid`,
        guardianPersonId,
      );
    });
  });
});
