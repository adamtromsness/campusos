import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

import {
  AssetService,
  AssignmentService,
  AssetDocumentService,
} from '@modules/m62-it/assets.service';
import { LicenceService } from '@modules/m62-it/licences.service';
import { PermissionCheckService } from '@modules/m00-platform';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import { makeRecordingKafka, RecordingKafkaProducer } from '../helpers/recording-kafka';
import {
  withTestTenant,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
} from '../helpers/tenant-context';
import { adminActor, TEST_ADMIN_ACCOUNT_ID, TEST_ADMIN_PERSON_ID } from '../helpers/actor';
import { resetItTables, ensureItSeed, TEST_ASSET_ID, TEST_LICENCE_ID } from '../fixtures/it';

describe('integration:m62-it/assignments-docs', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let assets: AssetService;
  let assignments: AssignmentService;
  let docs: AssetDocumentService;
  let licences: LicenceService;
  let kafka: ReturnType<typeof makeRecordingKafka>;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    kafka = makeRecordingKafka();
    assets = new AssetService(tenantPrisma, permCheck);
    assignments = new AssignmentService(tenantPrisma, permCheck);
    docs = new AssetDocumentService(tenantPrisma, permCheck);
    licences = new LicenceService(tenantPrisma, permCheck, kafka);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetItTables(rawClient);
    await ensureItSeed(rawClient);
    (kafka as unknown as RecordingKafkaProducer).reset();
  });

  // ─── AssignmentService ────────────────────────────────
  describe('AssignmentService', () => {
    it('assignAsset → listForAsset → returnAssignment lifecycle', async () => {
      const assignment = await withTestTenant(async () =>
        assignments.assignAsset(
          TEST_ASSET_ID,
          { assigneeId: TEST_ADMIN_ACCOUNT_ID, conditionAtAssign: 'GOOD' } as any,
          adminActor(),
        ),
      );
      expect(assignment.assetId).toBe(TEST_ASSET_ID);
      expect(assignment.conditionAtAssign).toBe('GOOD');

      const list = await withTestTenant(async () =>
        assignments.listForAsset(TEST_ASSET_ID, adminActor()),
      );
      expect(list.map((a) => a.id)).toContain(assignment.id);

      const returned = await withTestTenant(async () =>
        assignments.returnAssignment(
          assignment.id,
          { conditionAtReturn: 'FAIR' } as any,
          adminActor(),
        ),
      );
      expect(returned.returnedAt).not.toBeNull();
      expect(returned.conditionAtReturn).toBe('FAIR');

      // Asset row updates show in DB
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS c FROM ${TEST_SCHEMA}.tech_asset_assignments WHERE asset_id = $1::uuid AND returned_at IS NOT NULL`,
        TEST_ASSET_ID,
      )) as Array<{ c: number }>;
      expect(rows[0]!.c).toBe(1);
    });

    it('listForUser returns user assignments', async () => {
      await withTestTenant(async () =>
        assignments.assignAsset(
          TEST_ASSET_ID,
          { assigneeId: TEST_ADMIN_ACCOUNT_ID, conditionAtAssign: 'GOOD' } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () => assignments.listForUser(adminActor()));
      expect(list.length).toBeGreaterThan(0);
    });
  });

  // ─── AssetDocumentService ────────────────────────────
  describe('AssetDocumentService', () => {
    it('create + listForAsset', async () => {
      const doc = await withTestTenant(async () =>
        docs.create(
          TEST_ASSET_ID,
          {
            documentType: 'INVOICE',
            s3Key: 's3://bucket/key.pdf',
            fileName: 'invoice.pdf',
          } as any,
          adminActor(),
        ),
      );
      expect(doc.documentType).toBe('INVOICE');

      const list = await withTestTenant(async () =>
        docs.listForAsset(TEST_ASSET_ID, adminActor()),
      );
      expect(list.map((d) => d.id)).toContain(doc.id);
    });

    it('create with each document type', async () => {
      for (const t of ['WARRANTY', 'INSURANCE', 'MANUAL']) {
        await withTestTenant(async () =>
          docs.create(
            TEST_ASSET_ID,
            { documentType: t, s3Key: 's3://x', fileName: `${t}.pdf` } as any,
            adminActor(),
          ),
        );
      }
      const list = await withTestTenant(async () => docs.listForAsset(TEST_ASSET_ID, adminActor()));
      expect(list.length).toBe(3);
    });
  });

  // ─── LicenceService — assign/unassign + near-capacity emit ──
  describe('LicenceService — seats', () => {
    it('assignSeat increments used_seats; emits tech.licence.near_capacity at 80%', async () => {
      // Set total_seats to 1 so 1 assignment crosses 80% (admin is the only valid assignee)
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.tech_software_licences SET total_seats = 1 WHERE id = $1::uuid`,
        TEST_LICENCE_ID,
      );
      await withTestTenant(async () =>
        licences.assignSeat(
          TEST_LICENCE_ID,
          { assigneeId: TEST_ADMIN_ACCOUNT_ID } as any,
          adminActor(),
        ),
      );
      const calls = (kafka as unknown as RecordingKafkaProducer).callsForTopic(
        'tech.licence.near_capacity',
      );
      expect(calls.length).toBeGreaterThan(0);

      // Used seats updated
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT used_seats FROM ${TEST_SCHEMA}.tech_software_licences WHERE id = $1::uuid`,
        TEST_LICENCE_ID,
      )) as Array<{ used_seats: number }>;
      expect(Number(rows[0]!.used_seats)).toBe(1);
    });

    it('unassignSeat decrements used_seats', async () => {
      const assignment = await withTestTenant(async () =>
        licences.assignSeat(
          TEST_LICENCE_ID,
          { assigneeId: TEST_ADMIN_ACCOUNT_ID } as any,
          adminActor(),
        ),
      );

      await withTestTenant(async () => licences.unassignSeat(assignment.id, adminActor()));

      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT used_seats FROM ${TEST_SCHEMA}.tech_software_licences WHERE id = $1::uuid`,
        TEST_LICENCE_ID,
      )) as Array<{ used_seats: number }>;
      expect(Number(rows[0]!.used_seats)).toBe(0);
    });

    it('listAssignments returns assignment list', async () => {
      const a = await withTestTenant(async () =>
        licences.assignSeat(
          TEST_LICENCE_ID,
          { assigneeId: TEST_ADMIN_ACCOUNT_ID } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () => licences.listAssignments(TEST_LICENCE_ID));
      expect(list.map((x) => x.id)).toContain(a.id);
    });
  });
});
