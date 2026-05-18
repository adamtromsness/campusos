import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { ContractExpiryWorker } from '@modules/m86-procurement/contract-expiry.worker';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka';

import {
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
  TEST_SCHEMA,
  TEST_SUBDOMAIN,
} from '../helpers/tenant-context';
import { TEST_ADMIN_EMPLOYEE_ID } from '../helpers/actor';
import { TEST_SUPPLIER_A_ID, TEST_SUPPLIER_B_SCHOOL_ID } from '../fixtures/finance';

/**
 * DB-backed integration tests for ContractExpiryWorker — periodic sweep
 * that flips ACTIVE → EXPIRING when (end_date - reminder_days) <= now()
 * and emits prc.contract.expiring via outbox-in-tx (deterministic
 * event_id keyed on contractId so duplicate ticks are no-ops).
 *
 * Coverage:
 *   - tickForSchool: flips eligible ACTIVE rows; emits one outbox row each
 *   - leaves non-eligible contracts (within reminder window) untouched
 *   - leaves DRAFT/TERMINATED/EXPIRING/RENEWED contracts untouched
 *   - second run is a no-op (no row to flip after first sweep)
 *   - school scoping
 *   - runOnce iterates active schools
 *   - emit envelope shape (topic, payload.contractId/contractNumber/etc.)
 */
describe('integration:m86-procurement/contract-expiry-worker', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let outbox: OutboxService;
  let worker: ContractExpiryWorker;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    outbox = new OutboxService(rawClient);
    worker = new ContractExpiryWorker(tenantPrisma, outbox);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.prc_contract_amendments WHERE contract_id IN
         (SELECT id FROM ${TEST_SCHEMA}.prc_contracts WHERE school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.prc_contracts WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_outbox WHERE topic = 'prc.contract.expiring'`,
    );
  });

  async function seedContract(opts: {
    status: 'DRAFT' | 'ACTIVE' | 'EXPIRING' | 'RENEWED' | 'TERMINATED';
    daysUntilEnd: number;
    reminderDays: number;
    school?: string;
    vendorId?: string;
    contractNumber?: string;
  }): Promise<string> {
    const id = generateId();
    const school = opts.school ?? TEST_SCHOOL_ID;
    const vendor =
      opts.vendorId ?? (school === TEST_SCHOOL_B_ID ? TEST_SUPPLIER_B_SCHOOL_ID : TEST_SUPPLIER_A_ID);
    const startDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const endDate = new Date(Date.now() + opts.daysUntilEnd * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.prc_contracts
         (id, school_id, vendor_id, contract_number, title, start_date, end_date,
          total_value, status, renewal_reminder_days, created_by)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'Test Contract',
               $5::date, $6::date, 10000::numeric, $7, $8, $9::uuid)`,
      id,
      school,
      vendor,
      opts.contractNumber ?? 'C-' + id,
      startDate,
      endDate,
      opts.status,
      opts.reminderDays,
      TEST_ADMIN_EMPLOYEE_ID,
    );
    return id;
  }

  describe('tickForSchool', () => {
    it('flips ACTIVE contract within reminder window to EXPIRING + emits one outbox row', async () => {
      const id = await seedContract({ status: 'ACTIVE', daysUntilEnd: 30, reminderDays: 60 });
      const count = await worker.tickForSchool(TEST_SCHEMA, TEST_SCHOOL_ID, TEST_SUBDOMAIN);
      expect(count).toBe(1);

      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT status FROM ${TEST_SCHEMA}.prc_contracts WHERE id = $1::uuid`,
        id,
      )) as Array<{ status: string }>;
      expect(rows[0]!.status).toBe('EXPIRING');

      const outboxRows = (await rawClient.$queryRawUnsafe(
        `SELECT topic, message_key, envelope::text AS envelope FROM platform.platform_outbox
          WHERE topic = 'prc.contract.expiring' AND message_key = $1`,
        id,
      )) as Array<{ topic: string; message_key: string; envelope: string }>;
      expect(outboxRows.length).toBe(1);
      const env = JSON.parse(outboxRows[0]!.envelope);
      const payload = env.payload ?? env;
      expect(payload.contractId).toBe(id);
      expect(payload.totalValue).toBe(10000);
    });

    it('leaves ACTIVE contract outside reminder window untouched', async () => {
      const id = await seedContract({ status: 'ACTIVE', daysUntilEnd: 100, reminderDays: 30 });
      const count = await worker.tickForSchool(TEST_SCHEMA, TEST_SCHOOL_ID, TEST_SUBDOMAIN);
      expect(count).toBe(0);
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT status FROM ${TEST_SCHEMA}.prc_contracts WHERE id = $1::uuid`,
        id,
      )) as Array<{ status: string }>;
      expect(rows[0]!.status).toBe('ACTIVE');
    });

    it('does not touch DRAFT contracts', async () => {
      const id = await seedContract({ status: 'DRAFT', daysUntilEnd: 10, reminderDays: 60 });
      const count = await worker.tickForSchool(TEST_SCHEMA, TEST_SCHOOL_ID, TEST_SUBDOMAIN);
      expect(count).toBe(0);
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT status FROM ${TEST_SCHEMA}.prc_contracts WHERE id = $1::uuid`,
        id,
      )) as Array<{ status: string }>;
      expect(rows[0]!.status).toBe('DRAFT');
    });

    it('does not touch already-EXPIRING contracts (idempotent — emit fires once per contract)', async () => {
      const id = await seedContract({ status: 'EXPIRING', daysUntilEnd: 10, reminderDays: 60 });
      const count = await worker.tickForSchool(TEST_SCHEMA, TEST_SCHOOL_ID, TEST_SUBDOMAIN);
      expect(count).toBe(0);
      void id;
    });

    it('does not touch TERMINATED contracts', async () => {
      await seedContract({ status: 'TERMINATED', daysUntilEnd: 10, reminderDays: 60 });
      const count = await worker.tickForSchool(TEST_SCHEMA, TEST_SCHOOL_ID, TEST_SUBDOMAIN);
      expect(count).toBe(0);
    });

    it('does not touch RENEWED contracts', async () => {
      await seedContract({ status: 'RENEWED', daysUntilEnd: 10, reminderDays: 60 });
      const count = await worker.tickForSchool(TEST_SCHEMA, TEST_SCHOOL_ID, TEST_SUBDOMAIN);
      expect(count).toBe(0);
    });

    it('flips multiple eligible contracts in one tick', async () => {
      await seedContract({ status: 'ACTIVE', daysUntilEnd: 10, reminderDays: 60, contractNumber: 'A' + generateId() });
      await seedContract({ status: 'ACTIVE', daysUntilEnd: 20, reminderDays: 60, contractNumber: 'B' + generateId() });
      await seedContract({ status: 'ACTIVE', daysUntilEnd: 100, reminderDays: 10, contractNumber: 'C' + generateId() }); // outside window
      const count = await worker.tickForSchool(TEST_SCHEMA, TEST_SCHOOL_ID, TEST_SUBDOMAIN);
      expect(count).toBe(2);
    });

    it('second run is a no-op after first flips contracts to EXPIRING', async () => {
      await seedContract({ status: 'ACTIVE', daysUntilEnd: 10, reminderDays: 60 });
      const first = await worker.tickForSchool(TEST_SCHEMA, TEST_SCHOOL_ID, TEST_SUBDOMAIN);
      expect(first).toBe(1);
      const second = await worker.tickForSchool(TEST_SCHEMA, TEST_SCHOOL_ID, TEST_SUBDOMAIN);
      expect(second).toBe(0);
    });

    it('school scoping — only flips contracts for the supplied schoolId', async () => {
      const aId = await seedContract({
        status: 'ACTIVE',
        daysUntilEnd: 10,
        reminderDays: 60,
        school: TEST_SCHOOL_ID,
      });
      const bId = await seedContract({
        status: 'ACTIVE',
        daysUntilEnd: 10,
        reminderDays: 60,
        school: TEST_SCHOOL_B_ID,
      });
      const count = await worker.tickForSchool(TEST_SCHEMA, TEST_SCHOOL_ID, TEST_SUBDOMAIN);
      expect(count).toBe(1);
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT id::text AS id, status FROM ${TEST_SCHEMA}.prc_contracts WHERE id IN ($1::uuid, $2::uuid)`,
        aId,
        bId,
      )) as Array<{ id: string; status: string }>;
      const a = rows.find((r) => r.id === aId)!;
      const b = rows.find((r) => r.id === bId)!;
      expect(a.status).toBe('EXPIRING');
      expect(b.status).toBe('ACTIVE');
    });

    it('emit envelope payload carries contract metadata', async () => {
      const id = await seedContract({
        status: 'ACTIVE',
        daysUntilEnd: 30,
        reminderDays: 60,
        contractNumber: 'TEST-METADATA-' + generateId(),
      });
      await worker.tickForSchool(TEST_SCHEMA, TEST_SCHOOL_ID, TEST_SUBDOMAIN);
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT envelope::text AS envelope FROM platform.platform_outbox WHERE message_key = $1`,
        id,
      )) as Array<{ envelope: string }>;
      const env = JSON.parse(rows[0]!.envelope);
      const payload = env.payload ?? env;
      expect(payload.contractId).toBe(id);
      expect(payload.schoolId).toBe(TEST_SCHOOL_ID);
      expect(payload.vendorId).toBe(TEST_SUPPLIER_A_ID);
      expect(payload.title).toBe('Test Contract');
      expect(payload.renewalReminderDays).toBe(60);
    });

    it('no eligible contracts → zero outbox rows', async () => {
      await seedContract({ status: 'ACTIVE', daysUntilEnd: 200, reminderDays: 30 });
      await worker.tickForSchool(TEST_SCHEMA, TEST_SCHOOL_ID, TEST_SUBDOMAIN);
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM platform.platform_outbox WHERE topic = 'prc.contract.expiring'`,
      )) as Array<{ n: number }>;
      expect(rows[0]!.n).toBe(0);
    });
  });

  describe('runOnce — multi-tenant sweep', () => {
    it('iterates active schools and returns aggregated metrics', async () => {
      await seedContract({ status: 'ACTIVE', daysUntilEnd: 10, reminderDays: 60 });
      const result = await worker.runOnce();
      expect(result.tenantsScanned).toBeGreaterThanOrEqual(2);
      // School A row should flip; School B has no eligible contract here
      // (both schools share the same tenant_test schema so the worker
      // touches them both in this harness).
      expect(result.rowsFlipped).toBeGreaterThanOrEqual(1);
    });

    it('runOnce with no eligible contracts returns rowsFlipped=0', async () => {
      const result = await worker.runOnce();
      expect(result.rowsFlipped).toBe(0);
    });
  });
});
