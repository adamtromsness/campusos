import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

import { AllergyAlertConsumer } from '@modules/m63-food-service/allergy-alert.consumer';
import { AllergenAlertService } from '@modules/m63-food-service/dietary-eligibility.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { IdempotencyService } from '@shared/kafka/idempotency.service';
import { KafkaConsumerService } from '@shared/kafka/kafka-consumer.service';

import {
  withTestTenant,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SUBDOMAIN,
} from '../helpers/tenant-context';
import { adminActor, TEST_STUDENT_PERSON_ID } from '../helpers/actor';
import {
  resetFoodServiceTables,
  ensureFoodServiceSeed,
} from '../fixtures/food-service';

const TEST_FDS_PLATFORM_STUDENT_ID = '019e0cf8-aaaa-7777-8888-000000063300';
const TEST_FDS_SIS_STUDENT_ID = '019e0cf8-aaaa-7777-8888-000000063301';

class StubKafkaConsumer {
  async subscribe(): Promise<void> {
    // no-op; tests drive handle() directly
  }
}

describe('integration:m63-food-service/allergy-alert-consumer', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let consumer: AllergyAlertConsumer;
  let idempotency: IdempotencyService;
  let alerts: AllergenAlertService;
  let resolvedStudentId: string;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    idempotency = new IdempotencyService(tenantPrisma);
    alerts = new AllergenAlertService(tenantPrisma);
    consumer = new AllergyAlertConsumer(
      new StubKafkaConsumer() as unknown as KafkaConsumerService,
      idempotency,
      alerts,
    );
  });

  afterAll(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE platform_student_id IN (
         SELECT id FROM platform.platform_students WHERE person_id = $1::uuid AND id = $2::uuid
       )`,
      TEST_STUDENT_PERSON_ID,
      TEST_FDS_PLATFORM_STUDENT_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_students WHERE id = $1::uuid`,
      TEST_FDS_PLATFORM_STUDENT_ID,
    );
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetFoodServiceTables(rawClient);
    await ensureFoodServiceSeed(rawClient);

    // Seed a sis_students row so the upsert FK target exists
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name)
       VALUES ($1::uuid, $2::uuid, 'Allergy', 'Test')
       ON CONFLICT (person_id) DO UPDATE SET id = EXCLUDED.id`,
      TEST_FDS_PLATFORM_STUDENT_ID,
      TEST_STUDENT_PERSON_ID,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_students (id, school_id, platform_student_id, grade_level, enrollment_status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, '5', 'ENROLLED')
       ON CONFLICT (platform_student_id) DO NOTHING`,
      TEST_FDS_SIS_STUDENT_ID,
      TEST_SCHOOL_ID,
      TEST_FDS_PLATFORM_STUDENT_ID,
    );
    const ssRows = (await rawClient.$queryRawUnsafe(
      `SELECT id::text AS id FROM ${TEST_SCHEMA}.sis_students WHERE platform_student_id = $1::uuid`,
      TEST_FDS_PLATFORM_STUDENT_ID,
    )) as Array<{ id: string }>;
    resolvedStudentId = ssRows[0]!.id;

    // Clear allergen alerts + idempotency between runs
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.fds_student_allergen_alerts WHERE school_id = $1::uuid`,
      TEST_SCHOOL_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_event_consumer_idempotency
         WHERE consumer_group = 'allergy-alert-consumer'`,
    );
  });

  function buildEnvelope(payload: Record<string, unknown>, eventId: string): any {
    return {
      topic: 'hlth.allergy_alert.changed',
      partition: 0,
      offset: '1',
      key: null,
      headers: {
        'tenant-id': TEST_SCHOOL_ID,
        'tenant-subdomain': TEST_SUBDOMAIN,
      },
      payload: {
        event_id: eventId,
        event_type: 'hlth.allergy_alert.changed',
        event_version: 1,
        tenant_id: TEST_SCHOOL_ID,
        source_module: 'health',
        occurred_at: new Date().toISOString(),
        published_at: new Date().toISOString(),
        payload,
      },
      timestamp: new Date().toISOString(),
    };
  }

  it('materialises an alert from a valid envelope; idempotent on retry', async () => {
    const sourceAlertId = '019e0cf8-aaaa-7777-8888-000000063310';
    const eventId = '019e0cf8-aaaa-7777-8888-000000063311';
    const msg = buildEnvelope(
      {
        sourceAlertId,
        studentId: resolvedStudentId,
        allergenCode: 'PEANUT',
        allergenDisplayName: 'Peanut',
        severity: 'CRITICAL',
        isActive: true,
      },
      eventId,
    );

    await (consumer as any).handle(msg);

    const rows = (await rawClient.$queryRawUnsafe(
      `SELECT allergen_code, severity, is_active
         FROM ${TEST_SCHEMA}.fds_student_allergen_alerts
         WHERE source_health_alert_id = $1::uuid`,
      sourceAlertId,
    )) as Array<{ allergen_code: string; severity: string; is_active: boolean }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.allergen_code).toBe('PEANUT');
    expect(rows[0]!.severity).toBe('CRITICAL');
    expect(rows[0]!.is_active).toBe(true);

    // Re-deliver — idempotent
    await (consumer as any).handle(msg);
    const count = (await rawClient.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM ${TEST_SCHEMA}.fds_student_allergen_alerts
         WHERE source_health_alert_id = $1::uuid`,
      sourceAlertId,
    )) as Array<{ c: number }>;
    expect(count[0]!.c).toBe(1);

    // Idempotency row claimed
    const claimed = (await rawClient.$queryRawUnsafe(
      `SELECT 1 FROM platform.platform_event_consumer_idempotency
         WHERE consumer_group = 'allergy-alert-consumer' AND event_id = $1`,
      eventId,
    )) as unknown[];
    expect(claimed.length).toBe(1);
  });

  it('upserts on conflict — second event with same sourceAlertId updates severity', async () => {
    const sourceAlertId = '019e0cf8-aaaa-7777-8888-000000063320';

    await (consumer as any).handle(
      buildEnvelope(
        {
          sourceAlertId,
          studentId: resolvedStudentId,
          allergenCode: 'TREENUTS',
          allergenDisplayName: 'Tree Nuts',
          severity: 'WARNING',
          isActive: true,
        },
        '019e0cf8-aaaa-7777-8888-000000063321',
      ),
    );

    await (consumer as any).handle(
      buildEnvelope(
        {
          sourceAlertId,
          studentId: resolvedStudentId,
          allergenCode: 'TREENUTS',
          allergenDisplayName: 'Tree Nuts',
          severity: 'CRITICAL',
          isActive: true,
        },
        '019e0cf8-aaaa-7777-8888-000000063322',
      ),
    );

    const rows = (await rawClient.$queryRawUnsafe(
      `SELECT severity FROM ${TEST_SCHEMA}.fds_student_allergen_alerts
         WHERE source_health_alert_id = $1::uuid`,
      sourceAlertId,
    )) as Array<{ severity: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.severity).toBe('CRITICAL');
  });

  it('throws MalformedAllergyAlertPayloadError on malformed payload (missing fields)', async () => {
    const eventId = '019e0cf8-aaaa-7777-8888-000000063330';
    const msg = buildEnvelope(
      {
        // missing sourceAlertId, studentId, etc.
        allergenCode: 'EGG',
      },
      eventId,
    );

    let caught: Error | null = null;
    try {
      await (consumer as any).handle(msg);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.name).toBe('MalformedAllergyAlertPayloadError');

    // No alert was written
    const rows = (await rawClient.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM ${TEST_SCHEMA}.fds_student_allergen_alerts
         WHERE school_id = $1::uuid`,
      TEST_SCHOOL_ID,
    )) as Array<{ c: number }>;
    expect(rows[0]!.c).toBe(0);

    // Idempotency NOT claimed — failure should retry
    const claimed = (await rawClient.$queryRawUnsafe(
      `SELECT 1 FROM platform.platform_event_consumer_idempotency
         WHERE consumer_group = 'allergy-alert-consumer' AND event_id = $1`,
      eventId,
    )) as unknown[];
    expect(claimed.length).toBe(0);
  });

  it('deactivates an alert when isActive=false', async () => {
    const sourceAlertId = '019e0cf8-aaaa-7777-8888-000000063340';

    // First event: active
    await (consumer as any).handle(
      buildEnvelope(
        {
          sourceAlertId,
          studentId: resolvedStudentId,
          allergenCode: 'MILK',
          allergenDisplayName: 'Milk',
          severity: 'INFO',
          isActive: true,
        },
        '019e0cf8-aaaa-7777-8888-000000063341',
      ),
    );

    // Second event: deactivated
    await (consumer as any).handle(
      buildEnvelope(
        {
          sourceAlertId,
          studentId: resolvedStudentId,
          allergenCode: 'MILK',
          allergenDisplayName: 'Milk',
          severity: 'INFO',
          isActive: false,
        },
        '019e0cf8-aaaa-7777-8888-000000063342',
      ),
    );

    const rows = (await rawClient.$queryRawUnsafe(
      `SELECT is_active FROM ${TEST_SCHEMA}.fds_student_allergen_alerts
         WHERE source_health_alert_id = $1::uuid`,
      sourceAlertId,
    )) as Array<{ is_active: boolean }>;
    expect(rows[0]!.is_active).toBe(false);
  });

  it('AllergenAlertService.listAll + listForStudent return materialised rows', async () => {
    // Seed an alert via the consumer
    await (consumer as any).handle(
      buildEnvelope(
        {
          sourceAlertId: '019e0cf8-aaaa-7777-8888-000000063350',
          studentId: resolvedStudentId,
          allergenCode: 'EGG',
          allergenDisplayName: 'Egg',
          severity: 'WARNING',
          isActive: true,
        },
        '019e0cf8-aaaa-7777-8888-000000063351',
      ),
    );

    const all = await withTestTenant(async () => alerts.listAll(adminActor()));
    expect(all.length).toBeGreaterThan(0);
    expect(all[0]!.allergenCode).toBeDefined();
    expect(all[0]!.severity).toBeDefined();

    const forStudent = await withTestTenant(async () =>
      alerts.listForStudent(resolvedStudentId, adminActor()),
    );
    expect(forStudent.map((a) => a.allergenCode)).toContain('EGG');
  });
});
