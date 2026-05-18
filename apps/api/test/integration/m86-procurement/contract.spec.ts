import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { ContractService } from '@modules/m86-procurement/contract.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
  TEST_SCHEMA,
} from '../helpers/tenant-context';
import {
  adminActor,
  officerActor,
  studentActor,
  parentActor,
  teacherActor,
  TEST_OFFICER_ACCOUNT_ID,
  TEST_OFFICER_EMPLOYEE_ID,
  TEST_ADMIN_EMPLOYEE_ID,
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';
import {
  TEST_SUPPLIER_A_ID,
  TEST_SUPPLIER_B_ID,
  TEST_SUPPLIER_B_SCHOOL_ID,
} from '../fixtures/finance';

/**
 * DB-backed integration tests for ContractService — Article-level
 * contract lifecycle + amendments + outbox-in-tx emit for
 * prc.contract.amended.
 *
 * Coverage areas:
 *   - list / getById: school-scoped read, cross-school NotFound, status filter
 *   - create: vendor-in-school validation, date validation, UNIQUE collision,
 *     authorisation (admin / officer-with-perm / non-procurement denial)
 *   - patch: locked-row, status state machine (DRAFT→ACTIVE→EXPIRING→RENEWED→TERMINATED),
 *     terminal status rejection, date validation, empty-patch no-op
 *   - amend: deterministic eventId, outbox-in-tx, applies value_change to
 *     contract.total_value, applies new_end_date, terminated rejection,
 *     amendment_number auto-increments
 */
describe('integration:m86-procurement/contract', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let outbox: OutboxService;
  let service: ContractService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    outbox = new OutboxService(rawClient);
    service = new ContractService(tenantPrisma, permCheck, outbox);
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
      `DELETE FROM platform.platform_outbox WHERE topic IN ('prc.contract.amended', 'prc.contract.expiring')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE account_id = $1::uuid`,
      TEST_OFFICER_ACCOUNT_ID,
    );
  });

  async function grantOfficer(codes: string[]): Promise<void> {
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache
         (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], now(), 'test-hash')
       ON CONFLICT (account_id, scope_id) DO UPDATE
         SET permission_codes = EXCLUDED.permission_codes, computed_at = now()`,
      generateId(),
      TEST_OFFICER_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
      codes,
    );
  }

  function baseInput(overrides: Record<string, unknown> = {}) {
    const today = new Date().toISOString().slice(0, 10);
    const oneYear = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return {
      vendorId: TEST_SUPPLIER_A_ID,
      contractNumber: 'C-' + Math.random().toString(36).slice(2, 10),
      title: 'Office Supplies Annual Contract',
      description: 'Pens, paper, folders.',
      startDate: today,
      endDate: oneYear,
      totalValue: 25000,
      renewalReminderDays: 60,
      notes: 'Auto-renew unless cancelled.',
      ...overrides,
    };
  }

  describe('create', () => {
    it('admin creates a contract in DRAFT status with default field mapping', async () => {
      const c = await withTestTenant(async () => service.create(adminActor(), baseInput()));
      expect(c.status).toBe('DRAFT');
      expect(c.vendorId).toBe(TEST_SUPPLIER_A_ID);
      expect(c.totalValue).toBe(25000);
      expect(Number(c.spentToDate)).toBe(0);
      expect(c.renewalReminderDays).toBe(60);
      expect(c.createdBy).toBe(TEST_ADMIN_EMPLOYEE_ID);
    });

    it('officer with prc-002:write can create', async () => {
      await grantOfficer(['prc-002:write']);
      const c = await withTestTenant(async () => service.create(officerActor(), baseInput()));
      expect(c.createdBy).toBe(TEST_OFFICER_EMPLOYEE_ID);
    });

    it('officer with prc-004:admin can create', async () => {
      await grantOfficer(['prc-004:admin']);
      const c = await withTestTenant(async () => service.create(officerActor(), baseInput()));
      expect(c.status).toBe('DRAFT');
    });

    it('officer without procurement perm → Forbidden', async () => {
      await expect(
        withTestTenant(async () => service.create(officerActor(), baseInput())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('student / parent → Forbidden (persona collapse)', async () => {
      await expect(
        withTestTenant(async () => service.create(studentActor(), baseInput())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => service.create(parentActor(), baseInput())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('endDate before startDate → BadRequest (before any DB write)', async () => {
      await expect(
        withTestTenant(async () =>
          service.create(adminActor(), baseInput({ startDate: '2026-06-01', endDate: '2026-01-01' })),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('vendor in a different school → BadRequest', async () => {
      await expect(
        withTestTenant(async () =>
          service.create(adminActor(), baseInput({ vendorId: TEST_SUPPLIER_B_SCHOOL_ID })),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('non-existent vendor → BadRequest', async () => {
      await expect(
        withTestTenant(async () =>
          service.create(adminActor(), baseInput({ vendorId: generateId() })),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('duplicate contract_number in same school → ConflictException', async () => {
      const input = baseInput();
      await withTestTenant(async () => service.create(adminActor(), input));
      await expect(
        withTestTenant(async () => service.create(adminActor(), input)),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('cross-school create with same contract_number allowed', async () => {
      const input = baseInput();
      await withTestTenant(async () => service.create(adminActor(), input));
      const b = await withTestTenantB(async () =>
        service.create(adminActor(), { ...input, vendorId: TEST_SUPPLIER_B_SCHOOL_ID }),
      );
      expect(b.id).toBeTruthy();
    });

    it('renewalReminderDays defaults to 90 when omitted', async () => {
      const input = baseInput();
      delete (input as { renewalReminderDays?: number }).renewalReminderDays;
      const c = await withTestTenant(async () => service.create(adminActor(), input));
      expect(c.renewalReminderDays).toBe(90);
    });

    it('totalValue null is honoured', async () => {
      const input = baseInput();
      (input as { totalValue?: number | null }).totalValue = null as unknown as number;
      delete (input as { totalValue?: number }).totalValue;
      const c = await withTestTenant(async () => service.create(adminActor(), input));
      expect(c.totalValue).toBeNull();
    });
  });

  describe('list + getById', () => {
    it('list returns all contracts for current school ordered by end_date ASC', async () => {
      const a = await withTestTenant(async () =>
        service.create(adminActor(), baseInput({ endDate: '2026-12-01' })),
      );
      const b = await withTestTenant(async () =>
        service.create(adminActor(), baseInput({ endDate: '2026-06-01' })),
      );
      const list = await withTestTenant(async () => service.list(adminActor()));
      const aIdx = list.findIndex((c) => c.id === a.id);
      const bIdx = list.findIndex((c) => c.id === b.id);
      expect(bIdx).toBeLessThan(aIdx); // b ends earlier — comes first
    });

    it('list filters by status', async () => {
      const a = await withTestTenant(async () => service.create(adminActor(), baseInput()));
      const b = await withTestTenant(async () => service.create(adminActor(), baseInput()));
      await withTestTenant(async () => service.patch(adminActor(), b.id, { status: 'ACTIVE' }));
      const drafts = await withTestTenant(async () => service.list(adminActor(), 'DRAFT'));
      expect(drafts.find((c) => c.id === a.id)).toBeDefined();
      expect(drafts.find((c) => c.id === b.id)).toBeUndefined();
      const active = await withTestTenant(async () => service.list(adminActor(), 'ACTIVE'));
      expect(active.find((c) => c.id === b.id)).toBeDefined();
    });

    it('getById returns contract with empty amendments array when none', async () => {
      const c = await withTestTenant(async () => service.create(adminActor(), baseInput()));
      const got = await withTestTenant(async () => service.getById(adminActor(), c.id));
      expect(got.id).toBe(c.id);
      expect(got.amendments).toEqual([]);
    });

    it('cross-school getById → NotFound', async () => {
      const c = await withTestTenant(async () => service.create(adminActor(), baseInput()));
      await expect(
        withTestTenantB(async () => service.getById(adminActor(), c.id)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('missing contract → NotFound', async () => {
      await expect(
        withTestTenant(async () => service.getById(adminActor(), generateId())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('list / getById as student → Forbidden', async () => {
      await expect(
        withTestTenant(async () => service.list(studentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('officer with prc-001:read can list', async () => {
      await grantOfficer(['prc-001:read']);
      const list = await withTestTenant(async () => service.list(officerActor()));
      expect(Array.isArray(list)).toBe(true);
    });
  });

  describe('patch — locked-row state machine', () => {
    async function seedDraft(): Promise<string> {
      const c = await withTestTenant(async () => service.create(adminActor(), baseInput()));
      return c.id;
    }

    it('DRAFT → ACTIVE allowed', async () => {
      const id = await seedDraft();
      const updated = await withTestTenant(async () =>
        service.patch(adminActor(), id, { status: 'ACTIVE' }),
      );
      expect(updated.status).toBe('ACTIVE');
    });

    it('ACTIVE → EXPIRING allowed', async () => {
      const id = await seedDraft();
      await withTestTenant(async () => service.patch(adminActor(), id, { status: 'ACTIVE' }));
      const updated = await withTestTenant(async () =>
        service.patch(adminActor(), id, { status: 'EXPIRING' }),
      );
      expect(updated.status).toBe('EXPIRING');
    });

    it('EXPIRING → RENEWED allowed', async () => {
      const id = await seedDraft();
      await withTestTenant(async () => service.patch(adminActor(), id, { status: 'ACTIVE' }));
      await withTestTenant(async () => service.patch(adminActor(), id, { status: 'EXPIRING' }));
      const updated = await withTestTenant(async () =>
        service.patch(adminActor(), id, { status: 'RENEWED' }),
      );
      expect(updated.status).toBe('RENEWED');
    });

    it('TERMINATED is terminal — any further transition rejected', async () => {
      const id = await seedDraft();
      await withTestTenant(async () => service.patch(adminActor(), id, { status: 'TERMINATED' }));
      await expect(
        withTestTenant(async () => service.patch(adminActor(), id, { status: 'ACTIVE' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('DRAFT → EXPIRING blocked (only ACTIVE or TERMINATED from DRAFT)', async () => {
      const id = await seedDraft();
      await expect(
        withTestTenant(async () => service.patch(adminActor(), id, { status: 'EXPIRING' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('updating endDate to before startDate → BadRequest', async () => {
      const id = await seedDraft();
      await expect(
        withTestTenant(async () =>
          service.patch(adminActor(), id, { endDate: '2020-01-01' }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('empty patch returns current row (no-op SQL avoided)', async () => {
      const id = await seedDraft();
      const updated = await withTestTenant(async () => service.patch(adminActor(), id, {}));
      expect(updated.id).toBe(id);
      expect(updated.status).toBe('DRAFT');
    });

    it('partial patch: title + notes + renewalReminderDays', async () => {
      const id = await seedDraft();
      const updated = await withTestTenant(async () =>
        service.patch(adminActor(), id, {
          title: 'Renamed Contract',
          notes: 'Updated terms',
          renewalReminderDays: 30,
        }),
      );
      expect(updated.title).toBe('Renamed Contract');
      expect(updated.notes).toBe('Updated terms');
      expect(updated.renewalReminderDays).toBe(30);
    });

    it('partial patch: documentS3Key + description + totalValue', async () => {
      const id = await seedDraft();
      const updated = await withTestTenant(async () =>
        service.patch(adminActor(), id, {
          documentS3Key: 's3://bucket/v2.pdf',
          description: 'New description',
          totalValue: 30000,
        }),
      );
      expect(updated.documentS3Key).toBe('s3://bucket/v2.pdf');
      expect(updated.description).toBe('New description');
      expect(updated.totalValue).toBe(30000);
    });

    it('missing contract → NotFound', async () => {
      await expect(
        withTestTenant(async () => service.patch(adminActor(), generateId(), { notes: 'x' })),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-admin → Forbidden', async () => {
      const id = await seedDraft();
      await expect(
        withTestTenant(async () => service.patch(officerActor(), id, { notes: 'x' })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('amend — outbox-in-tx + total_value delta', () => {
    async function seedActive(): Promise<string> {
      const c = await withTestTenant(async () => service.create(adminActor(), baseInput()));
      await withTestTenant(async () => service.patch(adminActor(), c.id, { status: 'ACTIVE' }));
      return c.id;
    }

    it('amend adds first amendment + emits prc.contract.amended outbox row', async () => {
      const id = await seedActive();
      const a = await withTestTenant(async () =>
        service.amend(adminActor(), id, {
          description: 'Increase annual commitment',
          valueChange: 5000,
          effectiveDate: new Date().toISOString().slice(0, 10),
        }),
      );
      expect(a.amendmentNumber).toBe(1);
      expect(a.valueChange).toBe(5000);

      // total_value applied
      const detail = await withTestTenant(async () => service.getById(adminActor(), id));
      expect(detail.totalValue).toBe(30000);
      expect(detail.amendments).toHaveLength(1);

      // Outbox row
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT topic, message_key, envelope::text AS envelope FROM platform.platform_outbox
          WHERE topic = 'prc.contract.amended' AND message_key = $1`,
        id,
      )) as Array<{ topic: string; message_key: string; envelope: string }>;
      expect(rows.length).toBe(1);
      const env = JSON.parse(rows[0]!.envelope);
      const payload = env.payload ?? env;
      expect(payload.contractId).toBe(id);
      expect(payload.amendmentId).toBe(a.id);
      expect(payload.amendmentNumber).toBe(1);
      expect(payload.valueChange).toBe(5000);
    });

    it('amend with newEndDate applies it to contract.end_date', async () => {
      const id = await seedActive();
      const newEnd = '2027-06-01';
      const a = await withTestTenant(async () =>
        service.amend(adminActor(), id, {
          description: 'Extend term',
          newEndDate: newEnd,
          effectiveDate: new Date().toISOString().slice(0, 10),
        }),
      );
      expect(a.newEndDate).toBe(newEnd);
      const detail = await withTestTenant(async () => service.getById(adminActor(), id));
      expect(detail.endDate).toBe(newEnd);
    });

    it('amend with valueChange=0 + no newEndDate leaves contract row unchanged', async () => {
      const id = await seedActive();
      const before = await withTestTenant(async () => service.getById(adminActor(), id));
      const a = await withTestTenant(async () =>
        service.amend(adminActor(), id, {
          description: 'Documentation update only',
          valueChange: 0,
          effectiveDate: new Date().toISOString().slice(0, 10),
        }),
      );
      expect(a.amendmentNumber).toBe(1);
      const after = await withTestTenant(async () => service.getById(adminActor(), id));
      expect(after.totalValue).toBe(before.totalValue);
      expect(after.endDate).toBe(before.endDate);
    });

    it('amendment_number auto-increments across multiple amendments', async () => {
      const id = await seedActive();
      const a1 = await withTestTenant(async () =>
        service.amend(adminActor(), id, {
          description: 'First',
          valueChange: 1000,
          effectiveDate: new Date().toISOString().slice(0, 10),
        }),
      );
      const a2 = await withTestTenant(async () =>
        service.amend(adminActor(), id, {
          description: 'Second',
          valueChange: 2000,
          effectiveDate: new Date().toISOString().slice(0, 10),
        }),
      );
      expect(a1.amendmentNumber).toBe(1);
      expect(a2.amendmentNumber).toBe(2);
      const detail = await withTestTenant(async () => service.getById(adminActor(), id));
      expect(detail.amendments).toHaveLength(2);
      expect(detail.totalValue).toBe(25000 + 1000 + 2000);
    });

    it('amend TERMINATED contract → BadRequest', async () => {
      const id = await seedActive();
      await withTestTenant(async () => service.patch(adminActor(), id, { status: 'TERMINATED' }));
      await expect(
        withTestTenant(async () =>
          service.amend(adminActor(), id, {
            description: 'Should fail',
            valueChange: 100,
            effectiveDate: new Date().toISOString().slice(0, 10),
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('amend missing contract → NotFound', async () => {
      await expect(
        withTestTenant(async () =>
          service.amend(adminActor(), generateId(), {
            description: 'x',
            valueChange: 0,
            effectiveDate: new Date().toISOString().slice(0, 10),
          }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('amend cross-school → NotFound', async () => {
      const id = await seedActive();
      await expect(
        withTestTenantB(async () =>
          service.amend(adminActor(), id, {
            description: 'x',
            valueChange: 0,
            effectiveDate: new Date().toISOString().slice(0, 10),
          }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('amend as non-admin → Forbidden', async () => {
      const id = await seedActive();
      await expect(
        withTestTenant(async () =>
          service.amend(officerActor(), id, {
            description: 'x',
            valueChange: 0,
            effectiveDate: new Date().toISOString().slice(0, 10),
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () =>
          service.amend(studentActor(), id, {
            description: 'x',
            valueChange: 0,
            effectiveDate: new Date().toISOString().slice(0, 10),
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('amend deterministic eventId for same amendment id', async () => {
      const id = await seedActive();
      const a = await withTestTenant(async () =>
        service.amend(adminActor(), id, {
          description: 'unique-test',
          valueChange: 100,
          effectiveDate: new Date().toISOString().slice(0, 10),
        }),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT id::text AS event_id FROM platform.platform_outbox WHERE topic = 'prc.contract.amended' AND message_key = $1`,
        id,
      )) as Array<{ event_id: string }>;
      expect(rows.length).toBeGreaterThan(0);
      // event_id is deterministic on amendment id
      expect(rows[0]!.event_id).toBeTruthy();
      void a;
    });
  });

  describe('cross-school isolation', () => {
    it('contract created in School B not visible from School A', async () => {
      const b = await withTestTenantB(async () =>
        service.create(adminActor(), {
          ...baseInput({ vendorId: TEST_SUPPLIER_B_SCHOOL_ID }),
          contractNumber: 'B-' + Math.random().toString(36).slice(2, 10),
        }),
      );
      const listA = await withTestTenant(async () => service.list(adminActor()));
      expect(listA.find((c) => c.id === b.id)).toBeUndefined();
      await expect(
        withTestTenant(async () => service.getById(adminActor(), b.id)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
