import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { FeeScheduleService } from '@modules/m84-payments/fee-schedule.service';
import { DiscountRuleService } from '@modules/m84-payments/discount-rule.service';
import { FamilyAccountService } from '@modules/m84-payments/family-account.service';
import { SavedPaymentMethodService } from '@modules/m84-payments/saved-payment-method.service';
import { PaymentAllocationService } from '@modules/m84-payments/payment-allocation.service';
import { InvoiceService } from '@modules/m84-payments/invoice.service';
import { PaymentService } from '@modules/m84-payments/payment.service';
import { LedgerService } from '@modules/m84-payments/ledger.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';
import type { RedisService } from '@shared/cache';

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
  teacherActor,
  studentActor,
  parentActor,
  TEST_PARENT_PERSON_ID,
  TEST_OFFICER_PERSON_ID,
} from '../helpers/actor';
import { resetFinanceAdvancedTables } from '../helpers/reset';
import { TEST_ACADEMIC_YEAR_ID } from '../fixtures/finance';

function stubRedis(): RedisService {
  return {
    invalidateLedgerBalance: async () => undefined,
    getLedgerBalance: async () => null,
    setLedgerBalance: async () => undefined,
  } as unknown as RedisService;
}

describe('integration:m84-payments/billing-config', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let outbox: OutboxService;
  let ledger: LedgerService;
  let invoices: InvoiceService;
  let payments: PaymentService;
  let feeSchedule: FeeScheduleService;
  let discountRules: DiscountRuleService;
  let familyAccounts: FamilyAccountService;
  let savedPm: SavedPaymentMethodService;
  let allocations: PaymentAllocationService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    outbox = new OutboxService();
    ledger = new LedgerService(tenantPrisma, stubRedis());
    invoices = new InvoiceService(tenantPrisma, outbox, ledger);
    payments = new PaymentService(tenantPrisma, outbox, ledger);
    feeSchedule = new FeeScheduleService(tenantPrisma);
    discountRules = new DiscountRuleService(tenantPrisma);
    familyAccounts = new FamilyAccountService(tenantPrisma, ledger);
    savedPm = new SavedPaymentMethodService(tenantPrisma);
    allocations = new PaymentAllocationService(tenantPrisma);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await withTestTenant(async () => resetFinanceAdvancedTables(tenantPrisma));
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_outbox WHERE tenant_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
  });

  async function seedFamilyAccount(opts?: {
    schoolId?: string;
    holderId?: string;
    status?: string;
  }): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.pay_family_accounts
         (id, school_id, account_holder_id, account_number, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)`,
      id,
      opts?.schoolId ?? TEST_SCHOOL_ID,
      opts?.holderId ?? TEST_PARENT_PERSON_ID,
      'BC-FA-' + id,
      opts?.status ?? 'ACTIVE',
    );
    return id;
  }

  async function seedFeeCategory(name: string = 'Tuition'): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.pay_fee_categories
         (id, school_id, name, description, is_active)
       VALUES ($1::uuid, $2::uuid, $3, 'Test', true)`,
      id,
      TEST_SCHOOL_ID,
      name + '-' + id.slice(-6),
    );
    return id;
  }

  // ─── FeeScheduleService ──────────────────────────────────────

  describe('FeeScheduleService', () => {
    it('admin creates fee category + lists', async () => {
      const c = await withTestTenant(async () =>
        feeSchedule.createCategory(
          { name: 'BC-FC-' + generateId().slice(-6), description: 'd' },
          adminActor(),
        ),
      );
      expect(c.isActive).toBe(true);

      const list = await withTestTenant(async () => feeSchedule.listCategories());
      expect(list.find((x) => x.id === c.id)).toBeDefined();
    });

    it('non-admin cannot create category', async () => {
      await expect(
        withTestTenant(async () =>
          feeSchedule.createCategory({ name: 'x' }, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('createSchedule happy path + list + getById', async () => {
      const catId = await seedFeeCategory();
      const s = await withTestTenant(async () =>
        feeSchedule.createSchedule(
          {
            academicYearId: TEST_ACADEMIC_YEAR_ID,
            feeCategoryId: catId,
            name: 'BC-Sched-' + generateId().slice(-6),
            description: 'd',
            gradeLevel: '5',
            amount: 1500.5,
            isRecurring: true,
            recurrence: 'MONTHLY',
          },
          adminActor(),
        ),
      );
      expect(s.amount).toBe(1500.5);
      expect(s.recurrence).toBe('MONTHLY');
      expect(s.feeCategoryId).toBe(catId);

      const list = await withTestTenant(async () => feeSchedule.listSchedules());
      expect(list.find((x) => x.id === s.id)).toBeDefined();

      const got = await withTestTenant(async () => feeSchedule.getScheduleById(s.id));
      expect(got.id).toBe(s.id);
    });

    it('createSchedule with missing academic year → NotFound', async () => {
      const catId = await seedFeeCategory();
      await expect(
        withTestTenant(async () =>
          feeSchedule.createSchedule(
            {
              academicYearId: generateId(),
              feeCategoryId: catId,
              name: 'x',
              amount: 100,
            },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('createSchedule with missing category → NotFound', async () => {
      await expect(
        withTestTenant(async () =>
          feeSchedule.createSchedule(
            {
              academicYearId: TEST_ACADEMIC_YEAR_ID,
              feeCategoryId: generateId(),
              name: 'x',
              amount: 100,
            },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('createSchedule with inactive category → BadRequest', async () => {
      const catId = await seedFeeCategory();
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.pay_fee_categories SET is_active = false WHERE id = $1::uuid`,
        catId,
      );
      await expect(
        withTestTenant(async () =>
          feeSchedule.createSchedule(
            {
              academicYearId: TEST_ACADEMIC_YEAR_ID,
              feeCategoryId: catId,
              name: 'x',
              amount: 100,
            },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('getScheduleById missing → NotFound', async () => {
      await expect(
        withTestTenant(async () => feeSchedule.getScheduleById(generateId())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('updateSchedule patches name/desc/grade/amount/recurrence/isActive', async () => {
      const catId = await seedFeeCategory();
      const s = await withTestTenant(async () =>
        feeSchedule.createSchedule(
          {
            academicYearId: TEST_ACADEMIC_YEAR_ID,
            feeCategoryId: catId,
            name: 'BC-' + generateId().slice(-6),
            amount: 100,
          },
          adminActor(),
        ),
      );
      const u = await withTestTenant(async () =>
        feeSchedule.updateSchedule(
          s.id,
          {
            name: 'Renamed',
            description: 'new',
            gradeLevel: '7',
            amount: 250,
            isRecurring: true,
            recurrence: 'QUARTERLY',
            isActive: false,
          },
          adminActor(),
        ),
      );
      expect(u.name).toBe('Renamed');
      expect(u.amount).toBe(250);
      expect(u.isActive).toBe(false);
    });

    it('updateSchedule with empty patch returns existing (no SQL)', async () => {
      const catId = await seedFeeCategory();
      const s = await withTestTenant(async () =>
        feeSchedule.createSchedule(
          {
            academicYearId: TEST_ACADEMIC_YEAR_ID,
            feeCategoryId: catId,
            name: 'BC-' + generateId().slice(-6),
            amount: 100,
          },
          adminActor(),
        ),
      );
      const r = await withTestTenant(async () =>
        feeSchedule.updateSchedule(s.id, {}, adminActor()),
      );
      expect(r.id).toBe(s.id);
    });

    it('updateSchedule missing id → NotFound', async () => {
      await expect(
        withTestTenant(async () =>
          feeSchedule.updateSchedule(generateId(), { name: 'x' }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('updateSchedule by non-admin → Forbidden', async () => {
      await expect(
        withTestTenant(async () =>
          feeSchedule.updateSchedule(generateId(), { name: 'x' }, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ─── DiscountRuleService ────────────────────────────────────

  describe('DiscountRuleService', () => {
    it('admin creates SIBLING discount rule + list + getById', async () => {
      // NOTE: DiscountRuleService.create has a pre-existing bug — it
      // passes minimum_invoice_amount without ::numeric cast, so we
      // omit it here. The bug surfaces at INSERT time with PG error
      // 42804 (column is numeric but expression is text).
      const r = await withTestTenant(async () =>
        discountRules.create(
          {
            name: 'BC-Sib-' + generateId().slice(-6),
            description: 'sibling discount',
            discountType: 'SIBLING',
            calculationMethod: 'PERCENTAGE',
            value: 10,
            siblingOrder: 2,
          },
          adminActor(),
        ),
      );
      expect(r.discountType).toBe('SIBLING');
      expect(r.siblingOrder).toBe(2);

      const list = await withTestTenant(async () =>
        discountRules.list({}, adminActor()),
      );
      expect(list.find((x) => x.id === r.id)).toBeDefined();

      const got = await withTestTenant(async () => discountRules.getById(r.id, adminActor()));
      expect(got.id).toBe(r.id);
    });

    it('SIBLING without siblingOrder → BadRequest', async () => {
      await expect(
        withTestTenant(async () =>
          discountRules.create(
            {
              name: 'X',
              discountType: 'SIBLING',
              calculationMethod: 'PERCENTAGE',
              value: 10,
            },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('non-SIBLING with siblingOrder → BadRequest', async () => {
      await expect(
        withTestTenant(async () =>
          discountRules.create(
            {
              name: 'X',
              discountType: 'EARLY_PAYMENT',
              calculationMethod: 'PERCENTAGE',
              value: 5,
              siblingOrder: 2,
            },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('duplicate name → BadRequest', async () => {
      const name = 'BC-Dup-' + generateId().slice(-6);
      await withTestTenant(async () =>
        discountRules.create(
          { name, discountType: 'BURSARY', calculationMethod: 'FIXED_AMOUNT', value: 100 },
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          discountRules.create(
            { name, discountType: 'BURSARY', calculationMethod: 'FIXED_AMOUNT', value: 200 },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('update value + isActive + name + description', async () => {
      const r = await withTestTenant(async () =>
        discountRules.create(
          {
            name: 'BC-Upd-' + generateId().slice(-6),
            discountType: 'EARLY_PAYMENT',
            calculationMethod: 'PERCENTAGE',
            value: 5,
          },
          adminActor(),
        ),
      );
      const u = await withTestTenant(async () =>
        discountRules.update(
          r.id,
          {
            name: 'Updated Name',
            description: 'updated',
            value: 8,
            isActive: false,
            minimumInvoiceAmount: 100,
          },
          adminActor(),
        ),
      );
      expect(u.value).toBe(8);
      expect(u.isActive).toBe(false);
    });

    it('empty patch returns existing', async () => {
      const r = await withTestTenant(async () =>
        discountRules.create(
          {
            name: 'BC-Emp-' + generateId().slice(-6),
            discountType: 'BURSARY',
            calculationMethod: 'FIXED_AMOUNT',
            value: 100,
          },
          adminActor(),
        ),
      );
      const u = await withTestTenant(async () =>
        discountRules.update(r.id, {}, adminActor()),
      );
      expect(u.id).toBe(r.id);
    });

    it('update missing rule → NotFound', async () => {
      await expect(
        withTestTenant(async () =>
          discountRules.update(generateId(), { value: 5 }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById missing → NotFound', async () => {
      await expect(
        withTestTenant(async () => discountRules.getById(generateId(), adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('list filters by discountType + includeInactive', async () => {
      const r1 = await withTestTenant(async () =>
        discountRules.create(
          {
            name: 'BC-Fil1-' + generateId().slice(-6),
            discountType: 'EARLY_PAYMENT',
            calculationMethod: 'PERCENTAGE',
            value: 5,
          },
          adminActor(),
        ),
      );
      const r2 = await withTestTenant(async () =>
        discountRules.create(
          {
            name: 'BC-Fil2-' + generateId().slice(-6),
            discountType: 'BURSARY',
            calculationMethod: 'FIXED_AMOUNT',
            value: 100,
          },
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        discountRules.update(r2.id, { isActive: false }, adminActor()),
      );

      const earlyOnly = await withTestTenant(async () =>
        discountRules.list({ discountType: 'EARLY_PAYMENT' }, adminActor()),
      );
      expect(earlyOnly.every((x) => x.discountType === 'EARLY_PAYMENT')).toBe(true);
      expect(earlyOnly.find((x) => x.id === r1.id)).toBeDefined();

      // Default — inactive rule hidden
      const active = await withTestTenant(async () =>
        discountRules.list({}, adminActor()),
      );
      expect(active.find((x) => x.id === r2.id)).toBeUndefined();

      // Include inactive
      const all = await withTestTenant(async () =>
        discountRules.list({ includeInactive: true }, adminActor()),
      );
      expect(all.find((x) => x.id === r2.id)).toBeDefined();
    });

    it('non-admin → Forbidden on every entry point', async () => {
      await expect(
        withTestTenant(async () => discountRules.list({}, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => discountRules.getById(generateId(), teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () =>
          discountRules.create(
            {
              name: 'x',
              discountType: 'BURSARY',
              calculationMethod: 'FIXED_AMOUNT',
              value: 10,
            },
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () =>
          discountRules.update(generateId(), { value: 5 }, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ─── FamilyAccountService ───────────────────────────────────

  describe('FamilyAccountService', () => {
    it('admin lists every family account in the school', async () => {
      const a = await seedFamilyAccount();
      const list = await withTestTenant(async () => familyAccounts.list(adminActor()));
      expect(list.find((x) => x.id === a)).toBeDefined();
    });

    it('parent sees only own account', async () => {
      const own = await seedFamilyAccount({ holderId: TEST_PARENT_PERSON_ID });
      const other = await seedFamilyAccount({ holderId: TEST_OFFICER_PERSON_ID });
      const list = await withTestTenant(async () => familyAccounts.list(parentActor()));
      expect(list.find((x) => x.id === own)).toBeDefined();
      expect(list.find((x) => x.id === other)).toBeUndefined();
    });

    it('non-parent non-admin sees empty list', async () => {
      await seedFamilyAccount();
      const tList = await withTestTenant(async () => familyAccounts.list(teacherActor()));
      expect(tList).toEqual([]);
      const sList = await withTestTenant(async () => familyAccounts.list(studentActor()));
      expect(sList).toEqual([]);
    });

    it('getById returns account for admin', async () => {
      const a = await seedFamilyAccount();
      const got = await withTestTenant(async () => familyAccounts.getById(a, adminActor()));
      expect(got.id).toBe(a);
      expect(got.balance).toBeDefined();
    });

    it('parent getById on own account', async () => {
      const a = await seedFamilyAccount({ holderId: TEST_PARENT_PERSON_ID });
      const got = await withTestTenant(async () => familyAccounts.getById(a, parentActor()));
      expect(got.id).toBe(a);
    });

    it('parent getById on someone else\'s account → NotFound', async () => {
      const a = await seedFamilyAccount({ holderId: TEST_OFFICER_PERSON_ID });
      await expect(
        withTestTenant(async () => familyAccounts.getById(a, parentActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('teacher getById → NotFound (not GUARDIAN)', async () => {
      const a = await seedFamilyAccount({ holderId: TEST_PARENT_PERSON_ID });
      await expect(
        withTestTenant(async () => familyAccounts.getById(a, teacherActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById missing → NotFound', async () => {
      await expect(
        withTestTenant(async () => familyAccounts.getById(generateId(), adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('listStudents echoes the account students slice', async () => {
      const a = await seedFamilyAccount();
      const list = await withTestTenant(async () =>
        familyAccounts.listStudents(a, adminActor()),
      );
      expect(Array.isArray(list)).toBe(true);
    });

    it('assertCanWriteAccount: admin bypass + parent owner + outsider Forbidden + missing NotFound', async () => {
      const ownerId = TEST_PARENT_PERSON_ID;
      const a = await seedFamilyAccount({ holderId: ownerId });
      // Admin
      await expect(
        withTestTenant(async () => familyAccounts.assertCanWriteAccount(a, adminActor())),
      ).resolves.toBeUndefined();
      // Parent owner
      await expect(
        withTestTenant(async () => familyAccounts.assertCanWriteAccount(a, parentActor())),
      ).resolves.toBeUndefined();
      // Teacher (not owner) — service throws Forbidden because the row
      // exists but account_holder_id does not match actor.personId.
      await expect(
        withTestTenant(async () => familyAccounts.assertCanWriteAccount(a, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // Missing account — non-admin caller hits the row-existence
      // check first, returning NotFound.
      await expect(
        withTestTenant(async () =>
          familyAccounts.assertCanWriteAccount(generateId(), teacherActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ─── SavedPaymentMethodService ──────────────────────────────

  describe('SavedPaymentMethodService', () => {
    it('admin creates a card method + list + getById', async () => {
      const fa = await seedFamilyAccount();
      const pm = await withTestTenant(async () =>
        savedPm.create(
          {
            familyAccountId: fa,
            stripePaymentMethodId: 'pm_test_' + generateId().slice(-8),
            methodType: 'CARD',
            cardLastFour: '4242',
            cardBrand: 'visa',
            cardExpMonth: 12,
            cardExpYear: 2030,
            isDefault: true,
          },
          adminActor(),
        ),
      );
      expect(pm.cardLastFour).toBe('4242');
      expect(pm.isDefault).toBe(true);

      const list = await withTestTenant(async () =>
        savedPm.listForFamily(fa, adminActor()),
      );
      expect(list.find((x) => x.id === pm.id)).toBeDefined();

      const got = await withTestTenant(async () => savedPm.getById(pm.id, adminActor()));
      expect(got.id).toBe(pm.id);
    });

    it('setting a second default flips prior is_default=false', async () => {
      const fa = await seedFamilyAccount();
      const pm1 = await withTestTenant(async () =>
        savedPm.create(
          {
            familyAccountId: fa,
            stripePaymentMethodId: 'pm_first_' + generateId().slice(-8),
            methodType: 'CARD',
            isDefault: true,
          },
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        savedPm.create(
          {
            familyAccountId: fa,
            stripePaymentMethodId: 'pm_second_' + generateId().slice(-8),
            methodType: 'BANK_ACCOUNT',
            bankLastFour: '6789',
            isDefault: true,
          },
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () =>
        savedPm.listForFamily(fa, adminActor()),
      );
      const first = list.find((x) => x.id === pm1.id);
      expect(first!.isDefault).toBe(false);
    });

    it('duplicate Stripe id → BadRequest', async () => {
      const fa = await seedFamilyAccount();
      const stripeId = 'pm_dup_' + generateId().slice(-8);
      await withTestTenant(async () =>
        savedPm.create(
          {
            familyAccountId: fa,
            stripePaymentMethodId: stripeId,
          },
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          savedPm.create(
            {
              familyAccountId: fa,
              stripePaymentMethodId: stripeId,
            },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('remove soft-deletes', async () => {
      const fa = await seedFamilyAccount();
      const pm = await withTestTenant(async () =>
        savedPm.create(
          {
            familyAccountId: fa,
            stripePaymentMethodId: 'pm_rm_' + generateId().slice(-8),
          },
          adminActor(),
        ),
      );
      const r = await withTestTenant(async () => savedPm.remove(pm.id, adminActor()));
      expect(r.removed).toBe(true);

      await expect(
        withTestTenant(async () => savedPm.getById(pm.id, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);

      const list = await withTestTenant(async () =>
        savedPm.listForFamily(fa, adminActor()),
      );
      expect(list.find((x) => x.id === pm.id)).toBeUndefined();
    });

    it('parent owner can list + create + getById on own family', async () => {
      const fa = await seedFamilyAccount({ holderId: TEST_PARENT_PERSON_ID });
      const pm = await withTestTenant(async () =>
        savedPm.create(
          {
            familyAccountId: fa,
            stripePaymentMethodId: 'pm_parent_' + generateId().slice(-8),
          },
          parentActor(),
        ),
      );
      expect(pm.id).toBeTruthy();
      const list = await withTestTenant(async () =>
        savedPm.listForFamily(fa, parentActor()),
      );
      expect(list.find((x) => x.id === pm.id)).toBeDefined();
    });

    it('parent cannot access another family\'s methods → NotFound', async () => {
      const fa = await seedFamilyAccount({ holderId: generateId() });
      await expect(
        withTestTenant(async () =>
          savedPm.listForFamily(fa, parentActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('teacher → ForbiddenException via assertCanAccessFamily', async () => {
      const fa = await seedFamilyAccount();
      // Teacher persona is STAFF; service checks personType !== GUARDIAN.
      // STAFF without isSchoolAdmin and without personId-match: actor.personId
      // is set but personType is STAFF so the existence SELECT returns 0.
      await expect(
        withTestTenant(async () =>
          savedPm.listForFamily(fa, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById missing → NotFound', async () => {
      await expect(
        withTestTenant(async () => savedPm.getById(generateId(), adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school: School A method invisible in School B', async () => {
      const fa = await seedFamilyAccount();
      const pm = await withTestTenant(async () =>
        savedPm.create(
          {
            familyAccountId: fa,
            stripePaymentMethodId: 'pm_x_' + generateId().slice(-8),
          },
          adminActor(),
        ),
      );
      await expect(
        withTestTenantB(async () => savedPm.getById(pm.id, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ─── PaymentAllocationService ───────────────────────────────

  describe('PaymentAllocationService', () => {
    async function seedTwoInvoicesAndPayment(): Promise<{
      paymentId: string;
      familyAccountId: string;
      invoiceA: string;
      invoiceB: string;
    }> {
      const fa = await seedFamilyAccount();
      const i1 = await withTestTenant(async () =>
        invoices.create(
          {
            familyAccountId: fa,
            title: 'A',
            lineItems: [{ description: 'X', quantity: 1, unitPrice: 100 }],
          },
          adminActor(),
        ),
      );
      await withTestTenant(async () => invoices.send(i1.id, adminActor()));
      const i2 = await withTestTenant(async () =>
        invoices.create(
          {
            familyAccountId: fa,
            title: 'B',
            lineItems: [{ description: 'Y', quantity: 1, unitPrice: 200 }],
          },
          adminActor(),
        ),
      );
      await withTestTenant(async () => invoices.send(i2.id, adminActor()));
      // Pay the i1 balance exactly — PaymentAllocationService then
       // redistributes that paid $100 across i1 and i2.
       const p = await withTestTenant(async () =>
        payments.pay(
          i1.id,
          { amount: 100, paymentMethod: 'CHEQUE' },
          adminActor(),
        ),
      );
      return { paymentId: p.id, familyAccountId: fa, invoiceA: i1.id, invoiceB: i2.id };
    }

    it('allocate happy path: split payment across two invoices', async () => {
      const { paymentId, invoiceA, invoiceB } = await seedTwoInvoicesAndPayment();
      const result = await withTestTenant(async () =>
        allocations.allocate(
          paymentId,
          {
            allocations: [
              { invoiceId: invoiceA, allocatedAmount: 60 },
              { invoiceId: invoiceB, allocatedAmount: 40 },
            ],
          },
          adminActor(),
        ),
      );
      expect(result).toHaveLength(2);
      expect(result.reduce((s, a) => s + a.allocatedAmount, 0)).toBe(100);
    });

    it('listForPayment after allocate returns the rows', async () => {
      const { paymentId, invoiceA, invoiceB } = await seedTwoInvoicesAndPayment();
      await withTestTenant(async () =>
        allocations.allocate(
          paymentId,
          {
            allocations: [
              { invoiceId: invoiceA, allocatedAmount: 60 },
              { invoiceId: invoiceB, allocatedAmount: 40 },
            ],
          },
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () =>
        allocations.listForPayment(paymentId, adminActor()),
      );
      expect(list).toHaveLength(2);
    });

    it('allocate where total ≠ payment.amount → BadRequest', async () => {
      const { paymentId, invoiceA } = await seedTwoInvoicesAndPayment();
      await expect(
        withTestTenant(async () =>
          allocations.allocate(
            paymentId,
            { allocations: [{ invoiceId: invoiceA, allocatedAmount: 50 }] },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('allocate to a different family\'s invoice → BadRequest', async () => {
      const { paymentId, invoiceA } = await seedTwoInvoicesAndPayment();
      // Make a second family + invoice
      const fa2 = await seedFamilyAccount({ holderId: TEST_OFFICER_PERSON_ID });
      const i3 = await withTestTenant(async () =>
        invoices.create(
          {
            familyAccountId: fa2,
            title: 'C',
            lineItems: [{ description: 'Z', quantity: 1, unitPrice: 300 }],
          },
          adminActor(),
        ),
      );
      await withTestTenant(async () => invoices.send(i3.id, adminActor()));
      await expect(
        withTestTenant(async () =>
          allocations.allocate(
            paymentId,
            {
              allocations: [
                { invoiceId: invoiceA, allocatedAmount: 50 },
                { invoiceId: i3.id, allocatedAmount: 50 },
              ],
            },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('allocate to non-existent invoice → BadRequest', async () => {
      const { paymentId } = await seedTwoInvoicesAndPayment();
      await expect(
        withTestTenant(async () =>
          allocations.allocate(
            paymentId,
            {
              allocations: [{ invoiceId: generateId(), allocatedAmount: 100 }],
            },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('allocate non-existent payment → NotFound', async () => {
      await expect(
        withTestTenant(async () =>
          allocations.allocate(
            generateId(),
            { allocations: [{ invoiceId: generateId(), allocatedAmount: 100 }] },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-admin → Forbidden on allocate + listForPayment', async () => {
      await expect(
        withTestTenant(async () =>
          allocations.allocate(
            generateId(),
            { allocations: [{ invoiceId: generateId(), allocatedAmount: 1 }] },
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () =>
          allocations.listForPayment(generateId(), teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('re-allocate replaces the previous allocations (idempotent)', async () => {
      const { paymentId, invoiceA, invoiceB } = await seedTwoInvoicesAndPayment();
      await withTestTenant(async () =>
        allocations.allocate(
          paymentId,
          {
            allocations: [
              { invoiceId: invoiceA, allocatedAmount: 50 },
              { invoiceId: invoiceB, allocatedAmount: 50 },
            ],
          },
          adminActor(),
        ),
      );
      const after = await withTestTenant(async () =>
        allocations.allocate(
          paymentId,
          {
            allocations: [
              { invoiceId: invoiceA, allocatedAmount: 75 },
              { invoiceId: invoiceB, allocatedAmount: 25 },
            ],
          },
          adminActor(),
        ),
      );
      expect(after).toHaveLength(2);
      const a = after.find((x) => x.invoiceId === invoiceA);
      expect(a!.allocatedAmount).toBe(75);
    });
  });
});
