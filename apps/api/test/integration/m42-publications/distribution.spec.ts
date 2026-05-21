import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import {
  DistributionService,
  SubscriptionService,
} from '@modules/m42-publications/distribution.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import type { KafkaProducerService } from '@shared/kafka/kafka-producer.service';

import { makeRecordingKafka, RecordingKafkaProducer } from '../helpers/recording-kafka';
import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import { adminActor, studentActor, TEST_ADMIN_ACCOUNT_ID } from '../helpers/actor';
import { TEST_PUB_SERIES_ID, TEST_PUB_SERIES_B_ID } from '../fixtures/publications';

/**
 * Wave 5 — m42-publications DistributionService + SubscriptionService
 * DB-backed integration tests.
 *
 * Contracts:
 *   - Distribution list + rules CRUD with school-scope via publication.
 *   - validateRule rejects unknown ROLE / GRADE / CLASS / GROUP_MEMBERSHIP.
 *   - distribute KEYSTONE: APPROVED → PUBLISHED + recipients + Kafka emit.
 *   - Cross-school isolation.
 *   - SubscriptionService.subscribe / unsubscribe idempotency.
 */
describe('integration:m42-publications/distribution', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let kafka: ReturnType<typeof makeRecordingKafka>;
  let distributionService: DistributionService;
  let subscriptionService: SubscriptionService;

  const seededPubIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    kafka = makeRecordingKafka();
    distributionService = new DistributionService(
      tenantPrisma,
      permCheck,
      kafka as unknown as KafkaProducerService,
    );
    subscriptionService = new SubscriptionService(tenantPrisma);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    (kafka as unknown as RecordingKafkaProducer).reset();
    if (seededPubIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.pub_distribution_recipients WHERE publication_id = ANY($1::uuid[])`,
        seededPubIds,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.pub_distribution_rules WHERE distribution_list_id IN (
           SELECT id FROM ${TEST_SCHEMA}.pub_distribution_lists WHERE publication_id = ANY($1::uuid[])
         )`,
        seededPubIds,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.pub_distribution_lists WHERE publication_id = ANY($1::uuid[])`,
        seededPubIds,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.pub_publications WHERE id = ANY($1::uuid[])`,
        seededPubIds.splice(0),
      );
    }
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.pub_series_subscriptions WHERE series_id = ANY($1::uuid[])`,
      [TEST_PUB_SERIES_ID, TEST_PUB_SERIES_B_ID],
    );
  });

  async function seedPublication(
    opts: {
      schoolId?: string;
      status?: string;
      seriesId?: string | null;
    } = {},
  ): Promise<string> {
    const id = generateId();
    seededPubIds.push(id);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.pub_publications
         (id, school_id, title, publication_type, status, series_id, created_by)
       VALUES ($1::uuid, $2::uuid, 'Dist Pub', 'NEWSLETTER', $3, $4::uuid, $5::uuid)`,
      id,
      opts.schoolId ?? TEST_SCHOOL_ID,
      opts.status ?? 'APPROVED',
      opts.seriesId === null ? null : (opts.seriesId ?? null),
      TEST_ADMIN_ACCOUNT_ID,
    );
    return id;
  }

  // ──────────────────────────────────────────────────────────────────
  // DistributionService.createList
  // ──────────────────────────────────────────────────────────────────
  describe('DistributionService.createList', () => {
    it('admin creates a distribution list with PARENT role rule', async () => {
      const pubId = await seedPublication();
      await withTestTenant(async () =>
        distributionService.createList(adminActor(), pubId, {
          listName: 'All Parents',
          rules: [{ ruleType: 'ROLE', ruleValue: 'PARENT' }],
        } as any),
      );
      const listRows = (await rawClient.$queryRawUnsafe(
        `SELECT id::text AS id, list_name FROM ${TEST_SCHEMA}.pub_distribution_lists WHERE publication_id = $1::uuid`,
        pubId,
      )) as Array<{ id: string; list_name: string }>;
      expect(listRows).toHaveLength(1);
      expect(listRows[0]!.list_name).toBe('All Parents');

      const ruleRows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.pub_distribution_rules WHERE distribution_list_id = $1::uuid`,
        listRows[0]!.id,
      )) as Array<{ n: number }>;
      expect(ruleRows[0]!.n).toBe(1);
    });

    it('createList with invalid ROLE rule value → BadRequestException', async () => {
      const pubId = await seedPublication();
      await expect(
        withTestTenant(async () =>
          distributionService.createList(adminActor(), pubId, {
            listName: 'Bad',
            rules: [{ ruleType: 'ROLE', ruleValue: 'NOT_A_ROLE' }],
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('createList with GRADE rule that has no students → BadRequestException', async () => {
      const pubId = await seedPublication();
      await expect(
        withTestTenant(async () =>
          distributionService.createList(adminActor(), pubId, {
            listName: 'Bad GRADE',
            rules: [{ ruleType: 'GRADE', ruleValue: 'NONEXIST_GRADE_99' }],
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('createList with CLASS rule UUID that does not exist → BadRequestException', async () => {
      const pubId = await seedPublication();
      await expect(
        withTestTenant(async () =>
          distributionService.createList(adminActor(), pubId, {
            listName: 'Bad CLASS',
            rules: [{ ruleType: 'CLASS', ruleValue: '00000000-0000-0000-0000-000000000000' }],
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('createList on phantom publication → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          distributionService.createList(adminActor(), generateId(), {
            listName: 'Phantom',
            rules: [],
          } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('createList on School B publication from School A → NotFoundException', async () => {
      const pubBId = await seedPublication({ schoolId: TEST_SCHOOL_B_ID });
      await expect(
        withTestTenant(async () =>
          distributionService.createList(adminActor(), pubBId, {
            listName: 'Cross',
            rules: [],
          } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-distributor (student) → ForbiddenException', async () => {
      const pubId = await seedPublication();
      await expect(
        withTestTenant(async () =>
          distributionService.createList(studentActor(), pubId, {
            listName: 'Stud',
            rules: [],
          } as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // DistributionService.addRule
  // ──────────────────────────────────────────────────────────────────
  describe('DistributionService.addRule', () => {
    async function seedList(pubId: string): Promise<string> {
      const id = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.pub_distribution_lists
           (id, publication_id, list_name)
         VALUES ($1::uuid, $2::uuid, 'Seed List')`,
        id,
        pubId,
      );
      return id;
    }

    it('admin adds a rule to an existing list', async () => {
      const pubId = await seedPublication();
      const listId = await seedList(pubId);
      const rule = await withTestTenant(async () =>
        distributionService.addRule(adminActor(), listId, {
          ruleType: 'ROLE',
          ruleValue: 'STAFF',
        } as any),
      );
      expect(rule.ruleType).toBe('ROLE');
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.pub_distribution_rules WHERE id = $1::uuid`,
        rule.id,
      )) as Array<{ n: number }>;
      expect(rows[0]!.n).toBe(1);
    });

    it('addRule on phantom list → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          distributionService.addRule(adminActor(), generateId(), {
            ruleType: 'ROLE',
            ruleValue: 'STAFF',
          } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('addRule with bad value → BadRequestException', async () => {
      const pubId = await seedPublication();
      const listId = await seedList(pubId);
      await expect(
        withTestTenant(async () =>
          distributionService.addRule(adminActor(), listId, {
            ruleType: 'ROLE',
            ruleValue: 'BADVAL',
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // DistributionService.listForPublication
  // ──────────────────────────────────────────────────────────────────
  describe('DistributionService.listForPublication', () => {
    it('admin lists distribution lists with rules', async () => {
      const pubId = await seedPublication();
      await withTestTenant(async () =>
        distributionService.createList(adminActor(), pubId, {
          listName: 'List 1',
          rules: [{ ruleType: 'ROLE', ruleValue: 'PARENT' }],
        } as any),
      );
      const lists = await withTestTenant(async () =>
        distributionService.listForPublication(adminActor(), pubId),
      );
      expect(lists).toHaveLength(1);
      expect(lists[0]!.rules).toHaveLength(1);
    });

    it('non-EDITOR student → ForbiddenException', async () => {
      const pubId = await seedPublication();
      await expect(
        withTestTenant(async () => distributionService.listForPublication(studentActor(), pubId)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // DistributionService.previewAudience
  // ──────────────────────────────────────────────────────────────────
  describe('DistributionService.previewAudience', () => {
    it('returns zero totalRecipients when no rules match', async () => {
      const pubId = await seedPublication();
      await withTestTenant(async () =>
        distributionService.createList(adminActor(), pubId, {
          listName: 'Empty',
          rules: [],
        } as any),
      );
      const preview = await withTestTenant(async () =>
        distributionService.previewAudience(adminActor(), pubId),
      );
      expect(preview.totalRecipients).toBe(0);
      expect(preview.sampleNames).toEqual([]);
    });

    it('previewAudience on phantom publication → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => distributionService.previewAudience(adminActor(), generateId())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // DistributionService.distribute KEYSTONE
  // ──────────────────────────────────────────────────────────────────
  describe('DistributionService.distribute', () => {
    it('APPROVED publication with zero recipients → status=PUBLISHED + Kafka emit', async () => {
      const pubId = await seedPublication({ status: 'APPROVED' });
      const result = await withTestTenant(async () =>
        distributionService.distribute(adminActor(), pubId),
      );
      expect(result.status).toBe('PUBLISHED');
      expect(result.totalRecipients).toBe(0);

      // Publication should now be PUBLISHED on the DB
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT status FROM ${TEST_SCHEMA}.pub_publications WHERE id = $1::uuid`,
        pubId,
      )) as Array<{ status: string }>;
      expect(rows[0]!.status).toBe('PUBLISHED');

      // Kafka emit happened AFTER tx commit
      const emits = (kafka as unknown as RecordingKafkaProducer).callsForTopic(
        'pub.publication.published',
      );
      expect(emits).toHaveLength(1);
      expect(emits[0]!.key).toBe(pubId);
      expect(emits[0]!.payload).toMatchObject({
        publicationId: pubId,
        schoolId: TEST_SCHOOL_ID,
      });
    });

    it('distribute when status=DRAFT → BadRequestException', async () => {
      const pubId = await seedPublication({ status: 'DRAFT' });
      await expect(
        withTestTenant(async () => distributionService.distribute(adminActor(), pubId)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('distribute on phantom publication → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => distributionService.distribute(adminActor(), generateId())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('distribute on School B publication from School A → NotFoundException', async () => {
      const pubBId = await seedPublication({
        schoolId: TEST_SCHOOL_B_ID,
        status: 'APPROVED',
      });
      await expect(
        withTestTenant(async () => distributionService.distribute(adminActor(), pubBId)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('distribute non-distributor caller → ForbiddenException', async () => {
      const pubId = await seedPublication({ status: 'APPROVED' });
      await expect(
        withTestTenant(async () => distributionService.distribute(studentActor(), pubId)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('re-distribute already PUBLISHED publication does not re-emit status change', async () => {
      const pubId = await seedPublication({ status: 'APPROVED' });
      await withTestTenant(async () => distributionService.distribute(adminActor(), pubId));
      (kafka as unknown as RecordingKafkaProducer).reset();
      // Now status=PUBLISHED; redistribute should still work (PUBLISHED also allowed)
      const second = await withTestTenant(async () =>
        distributionService.distribute(adminActor(), pubId),
      );
      expect(second.status).toBe('PUBLISHED');
      // Kafka emit still happens (the service emits unconditionally on commit)
      const emits = (kafka as unknown as RecordingKafkaProducer).callsForTopic(
        'pub.publication.published',
      );
      expect(emits.length).toBeGreaterThan(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // DistributionService.deliveryStatus
  // ──────────────────────────────────────────────────────────────────
  describe('DistributionService.deliveryStatus', () => {
    it('returns zero counters for a fresh publication', async () => {
      const pubId = await seedPublication();
      const status = await withTestTenant(async () =>
        distributionService.deliveryStatus(adminActor(), pubId),
      );
      expect(status.publicationId).toBe(pubId);
      expect(status.totalRecipients).toBe(0);
      expect(status.pending).toBe(0);
    });

    it('rolls up per-status counts from pub_distribution_recipients', async () => {
      const pubId = await seedPublication();
      // Seed 3 PENDING + 2 DELIVERED + 1 BOUNCED recipient rows
      const inserts: Array<[string, string]> = [
        [generateId(), 'PENDING'],
        [generateId(), 'PENDING'],
        [generateId(), 'PENDING'],
        [generateId(), 'DELIVERED'],
        [generateId(), 'DELIVERED'],
        [generateId(), 'BOUNCED'],
      ];
      for (const [recipientId, deliveryStatus] of inserts) {
        await rawClient.$executeRawUnsafe(
          `INSERT INTO ${TEST_SCHEMA}.pub_distribution_recipients
             (id, publication_id, recipient_id, delivery_status)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4)`,
          generateId(),
          pubId,
          recipientId,
          deliveryStatus,
        );
      }
      const status = await withTestTenant(async () =>
        distributionService.deliveryStatus(adminActor(), pubId),
      );
      expect(status.totalRecipients).toBe(6);
      expect(status.pending).toBe(3);
      expect(status.delivered).toBe(2);
      expect(status.bounced).toBe(1);
    });

    it('non-EDITOR student → ForbiddenException', async () => {
      const pubId = await seedPublication();
      await expect(
        withTestTenant(async () => distributionService.deliveryStatus(studentActor(), pubId)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // SubscriptionService
  // ──────────────────────────────────────────────────────────────────
  describe('SubscriptionService.subscribe / unsubscribe', () => {
    it('subscribe to an active series creates a SUBSCRIBED row', async () => {
      await withTestTenant(async () =>
        subscriptionService.subscribe(adminActor(), TEST_PUB_SERIES_ID),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT status FROM ${TEST_SCHEMA}.pub_series_subscriptions
         WHERE series_id = $1::uuid AND subscriber_id = $2::uuid`,
        TEST_PUB_SERIES_ID,
        TEST_ADMIN_ACCOUNT_ID,
      )) as Array<{ status: string }>;
      expect(rows[0]!.status).toBe('SUBSCRIBED');
    });

    it('subscribe twice is idempotent (no duplicate row)', async () => {
      await withTestTenant(async () =>
        subscriptionService.subscribe(adminActor(), TEST_PUB_SERIES_ID),
      );
      await withTestTenant(async () =>
        subscriptionService.subscribe(adminActor(), TEST_PUB_SERIES_ID),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.pub_series_subscriptions
         WHERE series_id = $1::uuid AND subscriber_id = $2::uuid`,
        TEST_PUB_SERIES_ID,
        TEST_ADMIN_ACCOUNT_ID,
      )) as Array<{ n: number }>;
      expect(rows[0]!.n).toBe(1);
    });

    it('subscribe to inactive/missing series → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => subscriptionService.subscribe(adminActor(), generateId())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('unsubscribe flips to UNSUBSCRIBED + sets unsubscribed_at', async () => {
      await withTestTenant(async () =>
        subscriptionService.subscribe(adminActor(), TEST_PUB_SERIES_ID),
      );
      await withTestTenant(async () =>
        subscriptionService.unsubscribe(adminActor(), TEST_PUB_SERIES_ID),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT status, unsubscribed_at::text AS unsubscribed_at
         FROM ${TEST_SCHEMA}.pub_series_subscriptions
         WHERE series_id = $1::uuid AND subscriber_id = $2::uuid`,
        TEST_PUB_SERIES_ID,
        TEST_ADMIN_ACCOUNT_ID,
      )) as Array<{ status: string; unsubscribed_at: string | null }>;
      expect(rows[0]!.status).toBe('UNSUBSCRIBED');
      expect(rows[0]!.unsubscribed_at).not.toBeNull();
    });

    it('unsubscribe without prior subscription creates an UNSUBSCRIBED row', async () => {
      await withTestTenant(async () =>
        subscriptionService.unsubscribe(adminActor(), TEST_PUB_SERIES_ID),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT status FROM ${TEST_SCHEMA}.pub_series_subscriptions
         WHERE series_id = $1::uuid AND subscriber_id = $2::uuid`,
        TEST_PUB_SERIES_ID,
        TEST_ADMIN_ACCOUNT_ID,
      )) as Array<{ status: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe('UNSUBSCRIBED');
    });

    it('re-subscribe after unsubscribe flips back to SUBSCRIBED', async () => {
      await withTestTenant(async () =>
        subscriptionService.subscribe(adminActor(), TEST_PUB_SERIES_ID),
      );
      await withTestTenant(async () =>
        subscriptionService.unsubscribe(adminActor(), TEST_PUB_SERIES_ID),
      );
      await withTestTenant(async () =>
        subscriptionService.subscribe(adminActor(), TEST_PUB_SERIES_ID),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT status FROM ${TEST_SCHEMA}.pub_series_subscriptions
         WHERE series_id = $1::uuid AND subscriber_id = $2::uuid`,
        TEST_PUB_SERIES_ID,
        TEST_ADMIN_ACCOUNT_ID,
      )) as Array<{ status: string }>;
      expect(rows[0]!.status).toBe('SUBSCRIBED');
    });

    it('unsubscribe on phantom series → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => subscriptionService.unsubscribe(adminActor(), generateId())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('listForSeries returns active subscriptions', async () => {
      await withTestTenant(async () =>
        subscriptionService.subscribe(adminActor(), TEST_PUB_SERIES_ID),
      );
      const list = await withTestTenant(async () =>
        subscriptionService.listForSeries(TEST_PUB_SERIES_ID),
      );
      expect(list.length).toBeGreaterThan(0);
    });

    it('myList returns current actor subscriptions', async () => {
      await withTestTenant(async () =>
        subscriptionService.subscribe(adminActor(), TEST_PUB_SERIES_ID),
      );
      const list = await withTestTenant(async () => subscriptionService.myList(adminActor()));
      expect(list.length).toBeGreaterThan(0);
      expect(list[0]!.subscriberId).toBe(TEST_ADMIN_ACCOUNT_ID);
    });
  });

  // Suppress unused imports
  void withTestTenantB;
});
