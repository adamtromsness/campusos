import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { runWithTenantContext } from '@shared/tenant/tenant.context';
import { PERMISSIONS_KEY } from '@shared/auth/require-permission.decorator';
import { FinancialAidService } from './financial-aid.service';
import { DiscountRuleService } from './discount-rule.service';
import { AutoInvoiceService } from './auto-invoice.service';
import { LunchAccountService } from './lunch-account.service';
import { CreditNoteService } from './credit-note.service';
import { ReversalService } from './reversal.service';
import { PaymentAllocationService } from './payment-allocation.service';
import { LateFeeService } from './late-fee.service';
import { SavedPaymentMethodService } from './saved-payment-method.service';
import { FinancialAidController } from './financial-aid.controller';
import { BillingConfigController } from './billing-config.controller';
import { LunchAccountController } from './lunch-account.controller';
import { BillingOpsController } from './billing-ops.controller';

const SCHOOL = { schoolId: '019eaaaa-0000-7556-8c81-aaaaaaaaaaaa', subdomain: 'demo' } as never;

const ADMIN_ACTOR = {
  accountId: '019eaaaa-0000-7556-8c81-a0000000a001',
  personId: '019eaaaa-0000-7556-8c81-a0000000a002',
  employeeId: '019eaaaa-0000-7556-8c81-a0000000a003',
  personType: 'STAFF' as const,
  isSchoolAdmin: true,
} as never;

const PARENT_ACTOR = {
  accountId: '019eaaaa-0000-7556-8c81-b0000000b001',
  personId: '019eaaaa-0000-7556-8c81-b0000000b002',
  employeeId: null,
  personType: 'GUARDIAN' as const,
  isSchoolAdmin: false,
} as never;

const STUDENT_ACTOR = {
  accountId: '019eaaaa-0000-7556-8c81-c0000000c001',
  personId: '019eaaaa-0000-7556-8c81-c0000000c002',
  employeeId: null,
  personType: 'STUDENT' as const,
  isSchoolAdmin: false,
} as never;

const TEACHER_ACTOR = {
  accountId: '019eaaaa-0000-7556-8c81-d0000000d001',
  personId: '019eaaaa-0000-7556-8c81-d0000000d002',
  employeeId: '019eaaaa-0000-7556-8c81-d0000000d003',
  personType: 'STAFF' as const,
  isSchoolAdmin: false,
} as never;

interface CapturedCall {
  sql: string;
  args: unknown[];
  fn: 'q' | 'e';
}

function makeFake(handler: (call: CapturedCall) => unknown) {
  const capture: CapturedCall[] = [];
  const client = {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      const call: CapturedCall = { sql, args, fn: 'q' };
      capture.push(call);
      return handler(call) ?? [];
    },
    $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
      const call: CapturedCall = { sql, args, fn: 'e' };
      capture.push(call);
      return handler(call) ?? 0;
    },
  };
  const tenantPrisma = {
    executeInTenantContext: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
    executeInTenantTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
  };
  return { capture, client, tenantPrisma };
}

function makeKafka() {
  const emitted: Array<{
    topic: string;
    sourceModule: string;
    key: string;
    payload: Record<string, unknown>;
  }> = [];
  const kafka = {
    emit: vi.fn((opts: any) => {
      emitted.push({
        topic: opts.topic,
        sourceModule: opts.sourceModule,
        key: opts.key,
        payload: opts.payload,
      });
      return Promise.resolve();
    }),
  };
  return { kafka, emitted };
}

// REVIEW-P2-6 BLOCKING 3 + 4 — durable outbox stub. Asserts the
// enqueue-inside-tx contract: every call captures topic/payload/eventId
// so tests can verify the durable pattern.
function makeOutbox() {
  const enqueued: Array<{
    topic: string;
    sourceModule: string;
    key: string;
    payload: Record<string, unknown>;
    eventId?: string;
  }> = [];
  const outbox = {
    enqueueInTx: vi.fn(async (_tx: unknown, opts: any) => {
      enqueued.push({
        topic: opts.topic,
        sourceModule: opts.sourceModule,
        key: opts.key,
        payload: opts.payload,
        eventId: opts.eventId,
      });
      return 'outbox-' + Math.random().toString(36).slice(2, 10);
    }),
  };
  return { outbox, enqueued };
}

function makeRedis() {
  return {
    invalidateLedgerBalance: vi.fn(),
    getLedgerBalance: vi.fn().mockResolvedValue(null),
    setLedgerBalance: vi.fn(),
  };
}

function makeLedger(captureCallback?: (entry: any) => void) {
  return {
    recordEntry: vi.fn(async (_tx: unknown, args: any) => {
      if (captureCallback) captureCallback(args);
      return 'ledger-entry-' + Math.random().toString(36).slice(2, 10);
    }),
  };
}

// =====================================================================
// FinancialAidService — fund decrement keystone
// =====================================================================
describe('FinancialAidService — fund-pool decrement keystone', () => {
  it('approve INSERTs award + decrements fund_remaining + stamps award_id atomically', async () => {
    let updatedFund: number | null = null;
    let stampedAwardId: string | null = null;
    const { capture, tenantPrisma } = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from pay_financial_aid_applications') && sql.includes('for update')) {
        return [
          {
            id: 'app-1',
            school_id: SCHOOL.schoolId,
            student_id: 'student-1',
            program_id: 'prog-1',
            academic_year_id: 'ay-1',
            status: 'SUBMITTED',
          },
        ];
      }
      if (sql.includes('from pay_financial_aid_programs') && sql.includes('for update')) {
        return [{ id: 'prog-1', fund_remaining: '5000.00', total_fund_amount: '10000.00' }];
      }
      if (sql.includes('insert into pay_financial_aid_awards')) {
        return 1;
      }
      if (sql.includes('update pay_financial_aid_programs') && sql.includes('fund_remaining')) {
        updatedFund = Number(c.args[0]);
        return 1;
      }
      if (sql.includes('update pay_financial_aid_applications') && sql.includes("'approved'")) {
        // 4th positional arg is awardId in the UPDATE
        stampedAwardId = c.args[3] as string;
        return 1;
      }
      // For getApplicationById final read
      if (sql.includes('select a.id') && sql.includes('pay_financial_aid_applications')) {
        return [
          {
            id: 'app-1',
            school_id: SCHOOL.schoolId,
            student_id: 'student-1',
            student_name: 'Maya Chen',
            program_id: 'prog-1',
            program_name: 'Need-Based Aid',
            guardian_id: 'g-1',
            guardian_name: 'David Chen',
            academic_year_id: 'ay-1',
            household_income_band: 'BAND_C',
            supporting_documents: [],
            application_statement: null,
            status: 'APPROVED',
            submitted_at: '2026-05-10',
            reviewed_by: ADMIN_ACTOR.accountId,
            reviewed_at: '2026-05-10',
            reviewer_notes: 'Approved',
            award_id: 'will-be-set',
            created_at: '2026-05-10',
            updated_at: '2026-05-10',
          },
        ];
      }
      return [];
    });

    const svc = new FinancialAidService(tenantPrisma as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await svc.reviewApplication(
        'app-1',
        { action: 'APPROVE', awardAmount: 1500, reviewerNotes: 'Approved' },
        ADMIN_ACTOR,
      );
    });

    // Fund decremented from 5000 to 3500
    expect(updatedFund).toBe(3500);
    // Award id stamped on application
    expect(stampedAwardId).toBeTruthy();
    // Programme was locked FOR UPDATE
    const lockCall = capture.find(
      (c) =>
        c.sql.toLowerCase().includes('from pay_financial_aid_programs') &&
        c.sql.toLowerCase().includes('for update'),
    );
    expect(lockCall).toBeDefined();
    // Application was locked FOR UPDATE
    const appLockCall = capture.find(
      (c) =>
        c.sql.toLowerCase().includes('from pay_financial_aid_applications') &&
        c.sql.toLowerCase().includes('for update'),
    );
    expect(appLockCall).toBeDefined();
  });

  it('approve REJECTS when awardAmount exceeds fund_remaining', async () => {
    const { tenantPrisma } = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from pay_financial_aid_applications') && sql.includes('for update')) {
        return [
          {
            id: 'app-1',
            school_id: SCHOOL.schoolId,
            student_id: 's',
            program_id: 'p',
            academic_year_id: 'ay',
            status: 'SUBMITTED',
          },
        ];
      }
      if (sql.includes('from pay_financial_aid_programs') && sql.includes('for update')) {
        return [{ id: 'p', fund_remaining: '500.00', total_fund_amount: '10000.00' }];
      }
      return [];
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.reviewApplication('app-1', { action: 'APPROVE', awardAmount: 5000 }, ADMIN_ACTOR),
      ).rejects.toThrow(/exceeds programme fund_remaining/);
    });
  });

  it('approve REJECTS when called by non-admin', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const svc = new FinancialAidService(tenantPrisma as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.reviewApplication('app-1', { action: 'APPROVE', awardAmount: 100 }, PARENT_ACTOR),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  it('approve REJECTS terminal-status applications', async () => {
    const { tenantPrisma } = makeFake((c) => {
      if (c.sql.toLowerCase().includes('for update')) {
        return [
          {
            id: 'app-1',
            school_id: SCHOOL.schoolId,
            student_id: 's',
            program_id: 'p',
            academic_year_id: 'ay',
            status: 'APPROVED',
          },
        ];
      }
      return [];
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.reviewApplication('app-1', { action: 'APPROVE', awardAmount: 100 }, ADMIN_ACTOR),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  it('approve REJECTS without awardAmount', async () => {
    const { tenantPrisma } = makeFake((c) => {
      if (c.sql.toLowerCase().includes('for update')) {
        return [
          {
            id: 'app-1',
            school_id: SCHOOL.schoolId,
            student_id: 's',
            program_id: 'p',
            academic_year_id: 'ay',
            status: 'SUBMITTED',
          },
        ];
      }
      return [];
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.reviewApplication('app-1', { action: 'APPROVE' }, ADMIN_ACTOR),
      ).rejects.toThrow(/awardAmount > 0 is required/);
    });
  });

  it('UNIQUE(student, program, academic_year) catch translates to friendly 400', async () => {
    const { tenantPrisma } = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('for update') && sql.includes('pay_financial_aid_applications')) {
        return [
          {
            id: 'app-1',
            school_id: SCHOOL.schoolId,
            student_id: 's',
            program_id: 'p',
            academic_year_id: 'ay',
            status: 'SUBMITTED',
          },
        ];
      }
      if (sql.includes('for update') && sql.includes('pay_financial_aid_programs')) {
        return [{ id: 'p', fund_remaining: '5000.00', total_fund_amount: '10000.00' }];
      }
      if (sql.includes('insert into pay_financial_aid_awards')) {
        const err: any = new Error('duplicate key value violates unique constraint');
        err.code = 'P2002';
        throw err;
      }
      return [];
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.reviewApplication('app-1', { action: 'APPROVE', awardAmount: 100 }, ADMIN_ACTOR),
      ).rejects.toThrow(/already has an award from this programme/);
    });
  });
});

describe('FinancialAidService — application row-scope', () => {
  it('parent listApplications scopes via sis_guardians.person_id', async () => {
    const { capture, tenantPrisma } = makeFake(() => []);
    const svc = new FinancialAidService(tenantPrisma as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await svc.listApplications({}, PARENT_ACTOR);
    });
    const listCall = capture.find((c) =>
      c.sql.toLowerCase().includes('pay_financial_aid_applications'),
    );
    expect(listCall?.sql).toContain('sis_guardians');
    expect(listCall?.sql).toContain('sis_student_guardians');
  });

  it('parent createApplication REJECTS for student they are NOT linked to', async () => {
    // REVIEW-P2-6 BLOCKING 2 — student/year exist in current school, but
    // the parent isn't on the student's guardian list. Should 403.
    const { tenantPrisma } = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from pay_financial_aid_programs') && sql.includes('is_active')) {
        return [{ id: 'p', is_active: true }];
      }
      if (sql.includes('from sis_students') && sql.includes('school_id')) {
        return [{ id: 'student-in-school' }];
      }
      if (sql.includes('from sis_academic_years')) {
        return [{ id: 'ay' }];
      }
      if (sql.includes('from sis_guardians g')) {
        return []; // not linked
      }
      return [];
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.createApplication(
          { studentId: 'student-in-school', programId: 'p', academicYearId: 'ay' },
          PARENT_ACTOR,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // REVIEW-P2-6 BLOCKING 2 regression: cross-school student lands a
  // friendly 400 BEFORE any guardian check fires.
  it('createApplication REJECTS cross-school student with 400', async () => {
    const { tenantPrisma } = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from pay_financial_aid_programs') && sql.includes('is_active')) {
        return [{ id: 'p', is_active: true }];
      }
      if (sql.includes('from sis_students') && sql.includes('school_id')) {
        return []; // student NOT in current school
      }
      return [];
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.createApplication(
          { studentId: 'foreign-student', programId: 'p', academicYearId: 'ay' },
          PARENT_ACTOR,
        ),
      ).rejects.toThrow(/does not match a student in this school/);
    });
  });

  // REVIEW-P2-6 BLOCKING 2 regression: cross-school academic year lands 400.
  it('createApplication REJECTS cross-school academicYearId with 400', async () => {
    const { tenantPrisma } = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from pay_financial_aid_programs') && sql.includes('is_active')) {
        return [{ id: 'p', is_active: true }];
      }
      if (sql.includes('from sis_students') && sql.includes('school_id')) {
        return [{ id: 's' }];
      }
      if (sql.includes('from sis_academic_years')) {
        return []; // year NOT in current school
      }
      return [];
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.createApplication(
          { studentId: 's', programId: 'p', academicYearId: 'foreign-year' },
          PARENT_ACTOR,
        ),
      ).rejects.toThrow(/does not match an academic year in this school/);
    });
  });
});

// =====================================================================
// CreditNoteService — IMMUTABLE invariants
// =====================================================================
describe('CreditNoteService — IMMUTABLE invariants', () => {
  it('issue writes a CREDIT ledger entry + emits pay.credit_note.issued', async () => {
    const ledgerEntries: any[] = [];
    const { tenantPrisma } = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from pay_invoices') && sql.includes('for update')) {
        return [
          {
            id: 'inv-1',
            school_id: SCHOOL.schoolId,
            family_account_id: 'fa-1',
            total_amount: '500.00',
            status: 'SENT',
          },
        ];
      }
      if (sql.includes('select id, school_id, invoice_id, line_item_id, family_account_id')) {
        return [
          {
            id: 'cn-1',
            school_id: SCHOOL.schoolId,
            invoice_id: 'inv-1',
            line_item_id: null,
            family_account_id: 'fa-1',
            credit_amount: '25.00',
            credit_category: 'GOODWILL',
            reason: 'Test',
            ledger_entry_id: 'le-1',
            issued_by: ADMIN_ACTOR.accountId,
            issued_at: '2026-05-10',
          },
        ];
      }
      return [];
    });
    const ledger = makeLedger((entry) => ledgerEntries.push(entry));
    const { outbox, enqueued } = makeOutbox();
    const svc = new CreditNoteService(tenantPrisma as never, outbox as never, ledger as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await svc.issue(
        'inv-1',
        { creditAmount: 25, reason: 'Test', creditCategory: 'GOODWILL' },
        ADMIN_ACTOR,
      );
    });
    expect(ledgerEntries).toHaveLength(1);
    expect(ledgerEntries[0]!.entryType).toBe('CREDIT');
    expect(ledgerEntries[0]!.amount).toBe(-25);
    // REVIEW-P2-6 BLOCKING 3 — durable outbox INSIDE the tenant tx.
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.topic).toBe('pay.credit_note.issued');
    expect(enqueued[0]!.sourceModule).toBe('payments');
    expect(enqueued[0]!.payload.creditAmount).toBe(25);
    // Deterministic event_id is a v5-shaped UUID.
    expect(enqueued[0]!.eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('issue REJECTS on CANCELLED invoice', async () => {
    const { tenantPrisma } = makeFake((c) => {
      if (c.sql.toLowerCase().includes('for update')) {
        return [
          {
            id: 'inv-1',
            school_id: SCHOOL.schoolId,
            family_account_id: 'fa-1',
            total_amount: '0',
            status: 'CANCELLED',
          },
        ];
      }
      return [];
    });
    const svc = new CreditNoteService(
      tenantPrisma as never,
      makeOutbox().outbox as never,
      makeLedger() as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.issue('inv-1', { creditAmount: 25, reason: 'X' }, ADMIN_ACTOR),
      ).rejects.toThrow(/CANCELLED/);
    });
  });

  it('issue REJECTS empty reason', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const svc = new CreditNoteService(
      tenantPrisma as never,
      makeOutbox().outbox as never,
      makeLedger() as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.issue('inv-1', { creditAmount: 25, reason: '   ' }, ADMIN_ACTOR),
      ).rejects.toThrow(/reason is required/);
    });
  });

  it('issue REJECTS non-admin caller', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const svc = new CreditNoteService(
      tenantPrisma as never,
      makeOutbox().outbox as never,
      makeLedger() as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.issue('inv-1', { creditAmount: 25, reason: 'X' }, PARENT_ACTOR),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  it('Service exports NO update or delete method', () => {
    const svc = new CreditNoteService({} as never, {} as never, {} as never);
    const proto = Object.getPrototypeOf(svc);
    const methods = Object.getOwnPropertyNames(proto);
    expect(methods).not.toContain('update');
    expect(methods).not.toContain('delete');
    expect(methods).not.toContain('patch');
    expect(methods).not.toContain('remove');
  });
});

// =====================================================================
// ReversalService — IMMUTABLE + lock order
// =====================================================================
describe('ReversalService — IMMUTABLE + consistent lock ordering', () => {
  it('reverse locks invoice FIRST then payment FOR UPDATE', async () => {
    const lockOrder: string[] = [];
    const { tenantPrisma } = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      // REVIEW-P2-6 BLOCKING 3 — payment lookup is now school-scoped.
      if (sql.includes('select invoice_id::text as invoice_id from pay_payments')) {
        return [{ invoice_id: 'inv-1' }];
      }
      if (sql.includes('from pay_invoices') && sql.includes('for update')) {
        lockOrder.push('invoice');
        return [];
      }
      if (
        sql.includes('from pay_payments') &&
        sql.includes('for update') &&
        sql.includes('status')
      ) {
        lockOrder.push('payment');
        return [
          {
            id: 'pay-1',
            school_id: SCHOOL.schoolId,
            family_account_id: 'fa-1',
            amount: '1000.00',
            status: 'COMPLETED',
          },
        ];
      }
      // re-read for invoice status recompute
      if (sql.includes('coalesce') && sql.includes('amount_paid')) {
        return [{ id: 'inv-1', total_amount: '1000.00', status: 'PAID', amount_paid: '1000.00' }];
      }
      // reload for getById
      if (sql.includes('select id, school_id, payment_id')) {
        return [
          {
            id: 'rev-1',
            school_id: SCHOOL.schoolId,
            payment_id: 'pay-1',
            family_account_id: 'fa-1',
            invoice_id: 'inv-1',
            reversal_type: 'BOUNCED_CHEQUE',
            reversal_reason: 'Test',
            bank_reference: null,
            reversed_amount: '1000.00',
            ledger_entry_id: 'le-1',
            reversed_by: ADMIN_ACTOR.accountId,
            reversed_at: '2026-05-10',
          },
        ];
      }
      return [];
    });
    const ledger = makeLedger();
    const { outbox, enqueued } = makeOutbox();
    const svc = new ReversalService(tenantPrisma as never, outbox as never, ledger as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await svc.reverse(
        'pay-1',
        { reversalType: 'BOUNCED_CHEQUE', reversalReason: 'Test' },
        ADMIN_ACTOR,
      );
    });
    expect(lockOrder).toEqual(['invoice', 'payment']);
    // REVIEW-P2-6 BLOCKING 3 — durable outbox INSIDE the tenant tx.
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.topic).toBe('pay.payment.reversed');
    expect(enqueued[0]!.eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('UNIQUE(payment_id) catch translates to friendly 400', async () => {
    const { tenantPrisma } = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select invoice_id::text')) return [{ invoice_id: 'inv-1' }];
      if (sql.includes('from pay_invoices') && sql.includes('for update')) return [];
      if (sql.includes('from pay_payments') && sql.includes('for update')) {
        return [
          {
            id: 'pay-1',
            school_id: SCHOOL.schoolId,
            family_account_id: 'fa-1',
            amount: '100.00',
            status: 'COMPLETED',
          },
        ];
      }
      if (sql.includes('insert into pay_payment_reversals')) {
        throw new Error(
          'duplicate key value violates unique constraint "pay_payment_reversals_payment_uq"',
        );
      }
      return [];
    });
    const svc = new ReversalService(
      tenantPrisma as never,
      makeOutbox().outbox as never,
      makeLedger() as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.reverse('pay-1', { reversalType: 'CHARGEBACK', reversalReason: 'X' }, ADMIN_ACTOR),
      ).rejects.toThrow(/already been reversed/);
    });
  });

  it('REJECTS non-COMPLETED payments', async () => {
    const { tenantPrisma } = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select invoice_id::text')) return [{ invoice_id: 'inv-1' }];
      if (sql.includes('for update')) {
        return [
          {
            id: 'pay-1',
            school_id: SCHOOL.schoolId,
            family_account_id: 'fa-1',
            amount: '100.00',
            status: 'PENDING',
          },
        ];
      }
      return [];
    });
    const svc = new ReversalService(
      tenantPrisma as never,
      makeOutbox().outbox as never,
      makeLedger() as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.reverse('pay-1', { reversalType: 'BOUNCED_CHEQUE', reversalReason: 'X' }, ADMIN_ACTOR),
      ).rejects.toThrow(/only COMPLETED payments can be reversed/);
    });
  });

  it('Service exports NO update or delete method', () => {
    const svc = new ReversalService({} as never, {} as never, {} as never);
    const proto = Object.getPrototypeOf(svc);
    const methods = Object.getOwnPropertyNames(proto);
    expect(methods).not.toContain('update');
    expect(methods).not.toContain('delete');
    expect(methods).not.toContain('patch');
  });
});

// =====================================================================
// LunchAccountService — IMMUTABLE transfer + chargeMealFromConsumer
// =====================================================================
describe('LunchAccountService — IMMUTABLE transfer + dedup', () => {
  it('transfer locks BOTH source AND destination accounts', async () => {
    const lockedAccounts: string[] = [];
    const { tenantPrisma } = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from pay_lunch_accounts where id') && sql.includes('for update')) {
        const id = c.args[0] as string;
        lockedAccounts.push(id);
        return [{ id, balance: '100.00' }];
      }
      return [];
    });
    const svc = new LunchAccountService(tenantPrisma as never, makeOutbox().outbox as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      try {
        await svc.transfer(
          {
            fromAccountId: 'src',
            toAccountId: 'dst',
            transferType: 'SIBLING_TRANSFER',
            amount: 5,
            reason: 'X',
          },
          ADMIN_ACTOR,
        );
      } catch {
        /* ignore transfer-row INSERT failure for this test */
      }
    });
    expect(lockedAccounts).toEqual(['src', 'dst']);
  });

  it('transfer REJECTS REFUND_TO_FAMILY without refundId', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const svc = new LunchAccountService(tenantPrisma as never, makeOutbox().outbox as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.transfer(
          {
            fromAccountId: 'src',
            transferType: 'REFUND_TO_FAMILY',
            amount: 5,
            reason: 'X',
          },
          ADMIN_ACTOR,
        ),
      ).rejects.toThrow(/refundId is required/);
    });
  });

  it('transfer REJECTS SIBLING_TRANSFER with same source and destination', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const svc = new LunchAccountService(tenantPrisma as never, makeOutbox().outbox as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.transfer(
          {
            fromAccountId: 'same',
            toAccountId: 'same',
            transferType: 'SIBLING_TRANSFER',
            amount: 5,
            reason: 'X',
          },
          ADMIN_ACTOR,
        ),
      ).rejects.toThrow(/different from fromAccountId/);
    });
  });

  it('transfer REJECTS amount > source balance', async () => {
    const { tenantPrisma } = makeFake((c) => {
      if (c.sql.toLowerCase().includes('for update')) {
        return [{ id: 'src', balance: '5.00' }];
      }
      return [];
    });
    const svc = new LunchAccountService(tenantPrisma as never, makeOutbox().outbox as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.transfer(
          {
            fromAccountId: 'src',
            toAccountId: 'dst',
            transferType: 'SIBLING_TRANSFER',
            amount: 100,
            reason: 'X',
          },
          ADMIN_ACTOR,
        ),
      ).rejects.toThrow(/exceeds source balance/);
    });
  });

  it('chargeMealFromConsumer dedups via partial UNIQUE INDEX (source_event_id)', async () => {
    let txCount = 0;
    const { tenantPrisma } = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from pay_lunch_accounts') && sql.includes('for update')) {
        return [
          {
            id: 'la-1',
            balance: '36.50',
            low_balance_threshold: '10.00',
            last_low_balance_alert_at: null,
          },
        ];
      }
      if (sql.includes('insert into pay_lunch_transactions')) {
        txCount++;
        if (txCount === 2) {
          throw new Error(
            'duplicate key value violates unique constraint "pay_lunch_tx_event_dedup_uq"',
          );
        }
      }
      return [];
    });
    const svc = new LunchAccountService(tenantPrisma as never, makeOutbox().outbox as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      const r1 = await svc.chargeMealFromConsumer({
        studentId: 'stu-1',
        amount: 4.5,
        mealDate: '2026-05-10',
        posDeviceId: null,
        posSessionId: null,
        sourceEventId: 'evt-1',
      });
      expect(r1.created).toBe(true);
      const r2 = await svc.chargeMealFromConsumer({
        studentId: 'stu-1',
        amount: 4.5,
        mealDate: '2026-05-10',
        posDeviceId: null,
        posSessionId: null,
        sourceEventId: 'evt-1',
      });
      expect(r2.created).toBe(false); // dedup hit
    });
  });

  it('chargeMealFromConsumer enqueues pay.lunch.low_balance via durable outbox INSIDE the throttle-stamp tx', async () => {
    let stampedAt: string | null = null;
    const { tenantPrisma } = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from pay_lunch_accounts') && sql.includes('for update')) {
        return [
          {
            id: 'la-1',
            balance: '12.00', // above $10 threshold
            low_balance_threshold: '10.00',
            last_low_balance_alert_at: null,
          },
        ];
      }
      // REVIEW-P2-6 BLOCKING 4 — throttle stamp now uses RETURNING.
      if (
        sql.includes('update pay_lunch_accounts') &&
        sql.includes('last_low_balance_alert_at = now()') &&
        sql.includes('returning')
      ) {
        stampedAt = '2026-05-10T12:00:00Z';
        return [{ alerted_at: stampedAt }];
      }
      // Student-name JOIN inside the tx so we can build the payload
      // without leaving the tenant tx.
      if (sql.includes('from sis_students s') && sql.includes('join platform.platform_students')) {
        return [{ student_id: 'stu-1', student_name: 'Maya' }];
      }
      // Reload after the tx for the return DTO.
      if (sql.includes('select a.id') && sql.includes('pay_lunch_accounts')) {
        return [
          {
            id: 'la-1',
            school_id: SCHOOL.schoolId,
            student_id: 'stu-1',
            student_name: 'Maya',
            balance: '7.50',
            low_balance_threshold: '10.00',
            auto_replenish_enabled: false,
            auto_replenish_amount: null,
            last_low_balance_alert_at: '2026-05-10',
            created_at: '2026-05-10',
            updated_at: '2026-05-10',
          },
        ];
      }
      return [];
    });
    const { outbox, enqueued } = makeOutbox();
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await svc.chargeMealFromConsumer({
        studentId: 'stu-1',
        amount: 4.5,
        mealDate: '2026-05-10',
        posDeviceId: null,
        posSessionId: null,
        sourceEventId: 'evt-cross',
      });
    });
    // REVIEW-P2-6 BLOCKING 4 — throttle stamp + outbox enqueue commit
    // atomically. Verify both happened in one tx.
    expect(stampedAt).toBe('2026-05-10T12:00:00Z');
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.topic).toBe('pay.lunch.low_balance');
    expect(enqueued[0]!.payload.balance).toBe(7.5);
    expect(enqueued[0]!.payload.threshold).toBe(10);
    expect(enqueued[0]!.payload.studentName).toBe('Maya');
    // Deterministic event_id derived from (accountId, alertedAt) so a
    // redelivered fds.meal.served event carries the same id.
    expect(enqueued[0]!.eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("parent CANNOT view another family's lunch account (404 don't-leak)", async () => {
    const { tenantPrisma } = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from sis_student_guardians')) return []; // not linked
      if (sql.includes('from pay_lunch_accounts')) {
        return [
          {
            id: 'la-1',
            school_id: SCHOOL.schoolId,
            student_id: 'other',
            student_name: 'Other',
            balance: '0',
            low_balance_threshold: '10.00',
            auto_replenish_enabled: false,
            auto_replenish_amount: null,
            last_low_balance_alert_at: null,
            created_at: '2026-05-10',
            updated_at: '2026-05-10',
          },
        ];
      }
      return [];
    });
    const svc = new LunchAccountService(tenantPrisma as never, makeOutbox().outbox as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(svc.getForStudent('other', PARENT_ACTOR)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});

// =====================================================================
// PaymentAllocationService — SUM = payment.amount validation
// =====================================================================
describe('PaymentAllocationService — SUM validation', () => {
  it('REJECTS allocation total != payment.amount', async () => {
    const { tenantPrisma } = makeFake((c) => {
      if (c.sql.toLowerCase().includes('for update')) {
        return [
          {
            id: 'pay-1',
            school_id: SCHOOL.schoolId,
            family_account_id: 'fa-1',
            amount: '500.00',
            status: 'COMPLETED',
          },
        ];
      }
      return [];
    });
    const svc = new PaymentAllocationService(tenantPrisma as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.allocate(
          'pay-1',
          { allocations: [{ invoiceId: 'inv-1', allocatedAmount: 300 }] },
          ADMIN_ACTOR,
        ),
      ).rejects.toThrow(/must equal payment amount/);
    });
  });

  it('REJECTS allocations across families', async () => {
    const { tenantPrisma } = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('for update') && sql.includes('pay_payments')) {
        return [
          {
            id: 'pay-1',
            school_id: SCHOOL.schoolId,
            family_account_id: 'fa-1',
            amount: '500.00',
            status: 'COMPLETED',
          },
        ];
      }
      if (sql.includes('from pay_invoices')) {
        return [{ id: 'inv-x', family_account_id: 'fa-OTHER' }];
      }
      return [];
    });
    const svc = new PaymentAllocationService(tenantPrisma as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.allocate(
          'pay-1',
          { allocations: [{ invoiceId: 'inv-x', allocatedAmount: 500 }] },
          ADMIN_ACTOR,
        ),
      ).rejects.toThrow(/does not belong to the same family account/);
    });
  });

  it('Accepts SUM = payment.amount', async () => {
    const { tenantPrisma } = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('for update') && sql.includes('pay_payments')) {
        return [
          {
            id: 'pay-1',
            school_id: SCHOOL.schoolId,
            family_account_id: 'fa-1',
            amount: '500.00',
            status: 'COMPLETED',
          },
        ];
      }
      // REVIEW-P2-6 MAJOR 2 — invoice lookup is now school-scoped.
      if (sql.includes('from pay_invoices') && sql.includes('school_id')) {
        return [{ id: 'inv-1', family_account_id: 'fa-1' }];
      }
      // listForPayment final read
      if (sql.includes('from pay_payment_allocations')) {
        return [];
      }
      return [];
    });
    const svc = new PaymentAllocationService(tenantPrisma as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await svc.allocate(
        'pay-1',
        { allocations: [{ invoiceId: 'inv-1', allocatedAmount: 500 }] },
        ADMIN_ACTOR,
      );
    });
  });

  it('REJECTS non-admin caller', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const svc = new PaymentAllocationService(tenantPrisma as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.allocate(
          'pay-1',
          { allocations: [{ invoiceId: 'inv-1', allocatedAmount: 100 }] },
          PARENT_ACTOR,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});

// =====================================================================
// LateFeeService
// =====================================================================
describe('LateFeeService', () => {
  it('upsert REJECTS FIXED without feeAmount', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const svc = new LateFeeService(tenantPrisma as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(svc.upsertPolicy({ feeType: 'FIXED' }, ADMIN_ACTOR)).rejects.toThrow(
        /feeAmount is required/,
      );
    });
  });

  it('upsert REJECTS PERCENTAGE_MONTHLY without feePercentage', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const svc = new LateFeeService(tenantPrisma as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.upsertPolicy({ feeType: 'PERCENTAGE_MONTHLY' }, ADMIN_ACTOR),
      ).rejects.toThrow(/feePercentage is required/);
    });
  });

  it('runScan no-ops when policy is inactive', async () => {
    const { tenantPrisma } = makeFake((c) => {
      if (c.sql.includes('FROM pay_late_payment_policies')) {
        return [{ id: 'p-1', is_active: false, grace_period_days: 7, fee_type: 'FIXED' }];
      }
      return [];
    });
    const svc = new LateFeeService(tenantPrisma as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      const res = await svc.runScan(ADMIN_ACTOR);
      expect(res.lateFeesApplied).toBe(0);
    });
  });

  it('runScan + getPolicy REJECT non-admin', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const svc = new LateFeeService(tenantPrisma as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(svc.runScan(PARENT_ACTOR)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(svc.getPolicy(PARENT_ACTOR)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});

// =====================================================================
// DiscountRuleService
// =====================================================================
describe('DiscountRuleService', () => {
  it('REJECTS SIBLING discount without siblingOrder', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const svc = new DiscountRuleService(tenantPrisma as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.create(
          {
            name: 'X',
            discountType: 'SIBLING',
            calculationMethod: 'PERCENTAGE',
            value: 10,
          },
          ADMIN_ACTOR,
        ),
      ).rejects.toThrow(/siblingOrder is required/);
    });
  });

  it('REJECTS non-SIBLING discount with siblingOrder', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const svc = new DiscountRuleService(tenantPrisma as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.create(
          {
            name: 'X',
            discountType: 'EARLY_PAYMENT',
            calculationMethod: 'PERCENTAGE',
            value: 5,
            siblingOrder: 2,
          },
          ADMIN_ACTOR,
        ),
      ).rejects.toThrow(/only valid for SIBLING/);
    });
  });

  it('REJECTS non-admin', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const svc = new DiscountRuleService(tenantPrisma as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(svc.list({}, PARENT_ACTOR)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});

// =====================================================================
// AutoInvoiceService
// =====================================================================
describe('AutoInvoiceService', () => {
  it('createRule REJECTS DATE_OF_MONTH without triggerDayOfMonth', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.createRule(
          {
            name: 'X',
            triggerType: 'DATE_OF_MONTH',
            feeScheduleId: 'fs-1',
          },
          ADMIN_ACTOR,
        ),
      ).rejects.toThrow(/triggerDayOfMonth is required/);
    });
  });

  it('triggerRule REJECTS inactive rule', async () => {
    const { tenantPrisma } = makeFake((c) => {
      if (c.sql.includes('FROM pay_auto_invoice_rules')) {
        return [
          {
            id: 'r-1',
            school_id: SCHOOL.schoolId,
            name: 'X',
            description: null,
            trigger_type: 'TERM_START',
            fee_schedule_id: 'fs-1',
            fee_schedule_name: 'X',
            trigger_day_of_month: null,
            trigger_term_offset_days: -7,
            applies_to_grade_level: null,
            is_active: false, // inactive
            last_run_at: null,
            created_at: '2026-05-10',
            updated_at: '2026-05-10',
          },
        ];
      }
      return [];
    });
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(svc.triggerRule('r-1', {}, ADMIN_ACTOR)).rejects.toThrow(
        /Cannot trigger an inactive rule/,
      );
    });
  });

  it('REJECTS non-admin', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(svc.listRules(false, PARENT_ACTOR)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(svc.listRuns({}, PARENT_ACTOR)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});

// =====================================================================
// SavedPaymentMethodService
// =====================================================================
describe('SavedPaymentMethodService', () => {
  it("parent listForFamily REJECTS family they're not the holder of", async () => {
    const { tenantPrisma } = makeFake((c) => {
      if (c.sql.includes('FROM pay_family_accounts')) return [];
      return [];
    });
    const svc = new SavedPaymentMethodService(tenantPrisma as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(svc.listForFamily('fa-stranger', PARENT_ACTOR)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  it('UNIQUE catch on stripe_payment_method_id maps to friendly 400', async () => {
    const { tenantPrisma } = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from pay_family_accounts')) return [{}]; // pretend allowed
      if (sql.includes('insert into pay_saved_payment_methods')) {
        throw new Error(
          'duplicate key value violates unique constraint "pay_saved_pm_stripe_id_uq"',
        );
      }
      return [];
    });
    const svc = new SavedPaymentMethodService(tenantPrisma as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.create({ familyAccountId: 'fa-1', stripePaymentMethodId: 'pm_dup' }, ADMIN_ACTOR),
      ).rejects.toThrow(/already saved for this school/);
    });
  });
});

// =====================================================================
// Controller permission metadata regression
// =====================================================================
describe('Controller permission metadata', () => {
  function permFor(controllerCls: any, methodName: string): string[] | undefined {
    const proto = controllerCls.prototype;
    return Reflect.getMetadata(PERMISSIONS_KEY, proto[methodName]!);
  }

  it('FinancialAidController gates programmes admin + applications appropriately', () => {
    expect(permFor(FinancialAidController, 'listPrograms')).toEqual(['fin-002:read']);
    expect(permFor(FinancialAidController, 'createProgram')).toEqual(['fin-002:admin']);
    expect(permFor(FinancialAidController, 'updateProgram')).toEqual(['fin-002:admin']);
    expect(permFor(FinancialAidController, 'reviewApplication')).toEqual(['fin-002:admin']);
    expect(permFor(FinancialAidController, 'createApplication')).toEqual(['fin-002:write']);
    expect(permFor(FinancialAidController, 'submitApplication')).toEqual(['fin-002:write']);
    expect(permFor(FinancialAidController, 'withdrawApplication')).toEqual(['fin-002:write']);
    expect(permFor(FinancialAidController, 'listApplications')).toEqual(['fin-002:read']);
  });

  it('BillingConfigController gates auto-invoice + discount rules admin + reads', () => {
    expect(permFor(BillingConfigController, 'createDiscountRule')).toEqual(['fin-001:admin']);
    expect(permFor(BillingConfigController, 'updateDiscountRule')).toEqual(['fin-001:admin']);
    expect(permFor(BillingConfigController, 'createAutoRule')).toEqual(['fin-001:admin']);
    expect(permFor(BillingConfigController, 'triggerAutoRule')).toEqual(['fin-001:admin']);
    expect(permFor(BillingConfigController, 'generateFromFeeSchedule')).toEqual(['fin-001:admin']);
    expect(permFor(BillingConfigController, 'listGenerationRuns')).toEqual(['fin-001:read']);
  });

  it('LunchAccountController gates per-surface', () => {
    expect(permFor(LunchAccountController, 'listLowBalance')).toEqual(['fin-001:admin']);
    expect(permFor(LunchAccountController, 'transfer')).toEqual(['fin-001:admin']);
    expect(permFor(LunchAccountController, 'getForStudent')).toEqual(['fin-001:read']);
    expect(permFor(LunchAccountController, 'deposit')).toEqual(['fin-001:write']);
    expect(permFor(LunchAccountController, 'updateSettings')).toEqual(['fin-001:admin']);
  });

  it('BillingOpsController gates IMMUTABLE writes admin-only', () => {
    expect(permFor(BillingOpsController, 'listCreditNotes')).toEqual(['fin-001:admin']);
    expect(permFor(BillingOpsController, 'issueCreditNote')).toEqual(['fin-001:admin']);
    expect(permFor(BillingOpsController, 'listReversals')).toEqual(['fin-001:admin']);
    expect(permFor(BillingOpsController, 'reversePayment')).toEqual(['fin-001:admin']);
    expect(permFor(BillingOpsController, 'allocate')).toEqual(['fin-001:admin']);
    expect(permFor(BillingOpsController, 'upsertLatePaymentPolicy')).toEqual(['fin-001:admin']);
    expect(permFor(BillingOpsController, 'runLateFeesScan')).toEqual(['fin-001:admin']);
    expect(permFor(BillingOpsController, 'createSavedPaymentMethod')).toEqual(['fin-001:write']);
    expect(permFor(BillingOpsController, 'removeSavedPaymentMethod')).toEqual(['fin-001:write']);
    expect(permFor(BillingOpsController, 'listSavedPaymentMethods')).toEqual(['fin-001:read']);
  });
});

// =====================================================================
// REVIEW-P2-6 BLOCKING REGRESSION TESTS (Round 2 verdict conditions)
//
// Each test below pins the exact contract the reviewer demanded so a
// future refactor cannot regress the four BLOCKING fixes silently.
// =====================================================================
describe('REVIEW-P2-6 BLOCKING regressions', () => {
  // -------------------------------------------------------------------
  // BLOCKING 1 — financial-aid reads + writes are school-scoped.
  // A foreign-school programme/application/award UUID must collapse
  // to 404 and never leak across the connection pool.
  // -------------------------------------------------------------------
  it('BLOCKING 1 — getProgramById carries school predicate (cross-school 404)', async () => {
    const sqlSeen: string[] = [];
    const { tenantPrisma } = makeFake((c) => {
      sqlSeen.push(c.sql.toLowerCase());
      return [];
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(svc.getProgramById('cross-school-id')).rejects.toBeInstanceOf(NotFoundException);
    });
    // Every programme lookup must include the school predicate.
    expect(
      sqlSeen.some((s) => s.includes('pay_financial_aid_programs') && s.includes('school_id')),
    ).toBe(true);
  });

  it('BLOCKING 1 — listApplications carries school predicate', async () => {
    const sqlSeen: string[] = [];
    const { tenantPrisma } = makeFake((c) => {
      sqlSeen.push(c.sql.toLowerCase());
      return [];
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await svc.listApplications({}, ADMIN_ACTOR);
    });
    expect(
      sqlSeen.some((s) => s.includes('pay_financial_aid_applications') && s.includes('school_id')),
    ).toBe(true);
  });

  // -------------------------------------------------------------------
  // BLOCKING 2 — createApplication validates student/guardian/year
  // against current school. Cycle 6 already covers the cross-school
  // student + academic-year cases via dedicated tests; here we pin the
  // SQL shape so a future refactor cannot drop the school predicate.
  // -------------------------------------------------------------------
  it('BLOCKING 2 — createApplication validates student against current school', async () => {
    const sqlSeen: string[] = [];
    const { tenantPrisma } = makeFake((c) => {
      sqlSeen.push(c.sql.toLowerCase());
      // Programme exists + active so the next gate (student lookup)
      // is the one that fires.
      if (c.sql.includes('pay_financial_aid_programs')) {
        return [{ id: 'prog-1', is_active: true }];
      }
      // Cross-school student returns no rows → 400 with the canonical
      // "studentId does not match a student in this school" message.
      return [];
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.createApplication(
          {
            programId: 'prog-1',
            studentId: 'stu-1',
            academicYearId: 'ay-1',
            adjustedGrossIncome: 50000,
            householdSize: 4,
          },
          ADMIN_ACTOR,
        ),
      ).rejects.toBeDefined();
    });
    // Student validation MUST query sis_students with school_id.
    expect(sqlSeen.some((s) => s.includes('sis_students') && s.includes('school_id'))).toBe(true);
  });

  // -------------------------------------------------------------------
  // BLOCKING 3 — pay.credit_note.issued + pay.payment.reversed go
  // through the durable outbox INSIDE the same tenant tx as the
  // financial mutation. Pinned via the deterministic event_id helpers
  // (which are exported precisely for this reason).
  // -------------------------------------------------------------------
  it('BLOCKING 3 — deterministicCreditNoteEventId is stable + v5-shaped', async () => {
    const { deterministicCreditNoteEventId } = await import('./credit-note.service');
    const a = deterministicCreditNoteEventId('019d1234-aaaa-7000-8000-000000000001');
    const b = deterministicCreditNoteEventId('019d1234-aaaa-7000-8000-000000000001');
    const c = deterministicCreditNoteEventId('019d5678-bbbb-7000-8000-000000000002');
    expect(a).toBe(b); // deterministic — retries get the same id
    expect(a).not.toBe(c); // distinct inputs → distinct ids
    // v5 marker (version nibble 5, variant nibble 8/9/a/b)
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('BLOCKING 3 — deterministicReversalEventId is stable + v5-shaped', async () => {
    const { deterministicReversalEventId } = await import('./reversal.service');
    const a = deterministicReversalEventId('rev-1');
    const b = deterministicReversalEventId('rev-1');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  // -------------------------------------------------------------------
  // BLOCKING 4 — pay.lunch.low_balance is durable. The throttle stamp
  // and the outbox enqueue commit together so a Kafka outage cannot
  // suppress the alert. Pinned via the deterministic event_id helper
  // which is keyed on (accountId, alertedAt) for redelivery dedup.
  // -------------------------------------------------------------------
  it('BLOCKING 4 — deterministicLowBalanceEventId is stable + v5-shaped', async () => {
    const { deterministicLowBalanceEventId } = await import('./lunch-account.service');
    const a = deterministicLowBalanceEventId('la-1', '2026-05-10T12:00:00Z');
    const b = deterministicLowBalanceEventId('la-1', '2026-05-10T12:00:00Z');
    const c = deterministicLowBalanceEventId('la-1', '2026-05-11T12:00:00Z');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  // -------------------------------------------------------------------
  // ROUND 2 closeout — auto-invoice generation school-scoping. The
  // Round 2 reviewer flagged that runGeneration(), listRuns,
  // getRunById, family-account lookup, and the duplicate-invoice
  // check were unscoped. These tests pin the new SQL shapes.
  // -------------------------------------------------------------------
  it('Round 2 closeout — listRuns + getRunById carry school predicate', async () => {
    const sqlSeen: string[] = [];
    const { tenantPrisma } = makeFake((c) => {
      sqlSeen.push(c.sql.toLowerCase());
      return [];
    });
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await svc.listRuns({}, ADMIN_ACTOR);
    });
    expect(
      sqlSeen.some(
        (s) => s.includes('from pay_invoice_generation_runs') && s.includes('school_id'),
      ),
    ).toBe(true);
    sqlSeen.length = 0;
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(svc.getRunById('cross-school-run', ADMIN_ACTOR)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
    expect(
      sqlSeen.some(
        (s) =>
          s.includes('pay_invoice_generation_runs') &&
          s.includes('school_id') &&
          s.includes('id ='),
      ),
    ).toBe(true);
  });

  it('Round 2 closeout — runGeneration fee-schedule lookup is school-scoped', async () => {
    const sqlSeen: string[] = [];
    const { tenantPrisma } = makeFake((c) => {
      sqlSeen.push(c.sql.toLowerCase());
      // Fail fast: return empty schedule rows so generation aborts
      // immediately after the school-scoped fee-schedule lookup.
      return [];
    });
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      // generation aborts (schedule lookup empty) → run flips FAILED
      // → the wrapping getRunById can't find the row. We don't care
      // about the wrapping read — we care about the SQL the engine
      // executed before aborting.
      await expect(
        svc.generateFromFeeSchedule('cross-school-fee', null, ADMIN_ACTOR),
      ).rejects.toBeDefined();
    });
    // The fee-schedule lookup MUST carry school_id.
    expect(
      sqlSeen.some((s) => s.includes('from pay_fee_schedules') && s.includes('school_id')),
    ).toBe(true);
  });
});

// Avoid unused-import lint noise.
void STUDENT_ACTOR;
void TEACHER_ACTOR;
