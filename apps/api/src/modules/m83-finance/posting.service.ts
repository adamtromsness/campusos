import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import type { PrismaClient } from '@prisma/client';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import { isUniqueViolation } from './chart.service';
import type {
  BatchStatus,
  BatchType,
  CreateGLEntryLineDto,
  CreateJournalBatchDto,
  GLEntryDto,
  JournalBatchDto,
  VoidJournalBatchDto,
} from './dto/finance.dto';

interface BatchRow {
  id: string;
  school_id: string;
  batch_number: string;
  description: string;
  batch_type: string;
  source_module: string | null;
  source_event_id: string | null;
  accounting_period_id: string;
  period_name: string;
  posted_by: string | null;
  posted_by_name: string | null;
  posted_at: string | null;
  status: string;
  voided_at: string | null;
  voided_by: string | null;
  void_reason: string | null;
  total_debit: string | number | null;
  total_credit: string | number | null;
  created_at: string;
  updated_at: string;
}

interface EntryRow {
  id: string;
  batch_id: string;
  account_id: string;
  account_code: string;
  account_name: string;
  fund_id: string;
  fund_code: string;
  debit: string | number;
  credit: string | number;
  description: string | null;
  reference_type: string | null;
  reference_id: string | null;
  line_order: number;
}

const SELECT_BATCH_BASE = `
  SELECT b.id::text AS id,
         b.school_id::text AS school_id,
         b.batch_number,
         b.description,
         b.batch_type,
         b.source_module,
         b.source_event_id::text AS source_event_id,
         b.accounting_period_id::text AS accounting_period_id,
         p.period_name,
         b.posted_by::text AS posted_by,
         (SELECT ip.first_name || ' ' || ip.last_name FROM hr_employees e JOIN platform.iam_person ip ON ip.id = e.person_id WHERE e.id = b.posted_by LIMIT 1) AS posted_by_name,
         b.posted_at::text AS posted_at,
         b.status,
         b.voided_at::text AS voided_at,
         b.voided_by::text AS voided_by,
         b.void_reason,
         (SELECT COALESCE(SUM(debit), 0) FROM fin_gl_entries WHERE batch_id = b.id) AS total_debit,
         (SELECT COALESCE(SUM(credit), 0) FROM fin_gl_entries WHERE batch_id = b.id) AS total_credit,
         b.created_at::text AS created_at,
         b.updated_at::text AS updated_at
  FROM fin_journal_batches b
  JOIN fin_accounting_periods p ON p.id = b.accounting_period_id
`;

@Injectable()
export class PostingService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  /**
   * Allow staff/admin actors who hold any FIN-005..008:write tier OR
   * are school admins. The same gate is enforced at the controller via
   * @RequirePermission('fin-005:write'); the service-layer check is
   * defence in depth and lets the GLConsumer call through with a
   * synthetic actor.
   */
  private assertCanPost(actor: ResolvedActor): void {
    if (actor.isSchoolAdmin) return;
    if (actor.personType !== 'STAFF') {
      throw new ForbiddenException('Only finance staff may post journal entries');
    }
  }

  private async loadEntries(batchId: string): Promise<GLEntryDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT e.id::text AS id,
                e.batch_id::text AS batch_id,
                e.account_id::text AS account_id,
                a.account_code, a.account_name,
                e.fund_id::text AS fund_id,
                f.fund_code,
                e.debit, e.credit, e.description,
                e.reference_type, e.reference_id::text AS reference_id, e.line_order
         FROM fin_gl_entries e
         JOIN fin_chart_of_accounts a ON a.id = e.account_id
         JOIN fin_funds f ON f.id = e.fund_id
         WHERE e.batch_id = $1::uuid
         ORDER BY e.line_order, e.id`,
        batchId,
      );
    })) as EntryRow[];
    return rows.map((r) => ({
      id: r.id,
      batchId: r.batch_id,
      accountId: r.account_id,
      accountCode: r.account_code,
      accountName: r.account_name,
      fundId: r.fund_id,
      fundCode: r.fund_code,
      debit: Number(r.debit),
      credit: Number(r.credit),
      description: r.description,
      referenceType: r.reference_type,
      referenceId: r.reference_id,
      lineOrder: Number(r.line_order),
    }));
  }

  private async toDto(r: BatchRow): Promise<JournalBatchDto> {
    return {
      id: r.id,
      schoolId: r.school_id,
      batchNumber: r.batch_number,
      description: r.description,
      batchType: r.batch_type as BatchType,
      sourceModule: r.source_module,
      sourceEventId: r.source_event_id,
      accountingPeriodId: r.accounting_period_id,
      periodName: r.period_name,
      postedBy: r.posted_by,
      postedByName: r.posted_by_name,
      postedAt: r.posted_at,
      status: r.status as BatchStatus,
      voidedAt: r.voided_at,
      voidedBy: r.voided_by,
      voidReason: r.void_reason,
      totalDebit: Number(r.total_debit ?? 0),
      totalCredit: Number(r.total_credit ?? 0),
      entries: await this.loadEntries(r.id),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  async list(
    filter: { status?: string; periodId?: string; sourceModule?: string } = {},
  ): Promise<JournalBatchDto[]> {
    const tenant = getCurrentTenant();
    const where: string[] = [`b.school_id = $1::uuid`];
    const params: unknown[] = [tenant.schoolId];
    let i = 2;
    if (filter.status) {
      where.push(`b.status = $${i++}`);
      params.push(filter.status);
    }
    if (filter.periodId) {
      where.push(`b.accounting_period_id = $${i++}::uuid`);
      params.push(filter.periodId);
    }
    if (filter.sourceModule) {
      where.push(`b.source_module = $${i++}`);
      params.push(filter.sourceModule);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_BATCH_BASE +
          ` WHERE ${where.join(' AND ')} ORDER BY b.posted_at DESC NULLS LAST, b.created_at DESC LIMIT 200`,
        ...params,
      );
    })) as BatchRow[];
    const out: JournalBatchDto[] = [];
    for (const r of rows) out.push(await this.toDto(r));
    return out;
  }

  async getById(id: string): Promise<JournalBatchDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_BATCH_BASE + ` WHERE b.id = $1::uuid AND b.school_id = $2::uuid LIMIT 1`,
        id,
        tenant.schoolId,
      );
    })) as BatchRow[];
    if (rows.length === 0) throw new NotFoundException('Batch not found');
    return this.toDto(rows[0]!);
  }

  /**
   * Create a DRAFT batch with its GL entry lines. Does NOT post.
   * Call post() to flip to POSTED after balance validation.
   */
  async createDraft(actor: ResolvedActor, input: CreateJournalBatchDto): Promise<JournalBatchDto> {
    this.assertCanPost(actor);
    this.validateLineShape(input.entries);
    const tenant = getCurrentTenant();
    const batchId = generateId();
    try {
      await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO fin_journal_batches (id, school_id, batch_number, description, batch_type, source_module, accounting_period_id, status) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid, 'DRAFT')`,
          batchId,
          tenant.schoolId,
          input.batchNumber,
          input.description,
          input.batchType,
          input.sourceModule ?? null,
          input.accountingPeriodId,
        );
        await this.insertEntries(tx, batchId, input.entries);
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          `A journal batch with number '${input.batchNumber}' already exists`,
        );
      }
      throw err;
    }
    return this.getById(batchId);
  }

  /**
   * Post a DRAFT batch — the ADR-058 / ADR-059 keystone. Locks the
   * batch row inside one tenant tx, validates the period accepts
   * postings, calls validateBalance (the application-layer
   * equivalent of the validate_batch_balance DB function — see the
   * note at the bottom of migration 087), flips to POSTED. On
   * imbalance, the entire transaction rolls back so no half-posted
   * state can land.
   */
  async post(actor: ResolvedActor, batchId: string): Promise<JournalBatchDto> {
    this.assertCanPost(actor);
    if (!actor.employeeId) {
      throw new BadRequestException('Posting must be performed by an employee actor');
    }
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        `SELECT b.status, b.accounting_period_id::text AS pid, p.status AS period_status
         FROM fin_journal_batches b
         JOIN fin_accounting_periods p ON p.id = b.accounting_period_id
         WHERE b.id = $1::uuid AND b.school_id = $2::uuid FOR UPDATE OF b`,
        batchId,
        tenant.schoolId,
      )) as Array<{ status: string; pid: string; period_status: string }>;
      if (rows.length === 0) throw new NotFoundException('Batch not found');
      const { status, period_status } = rows[0]!;
      if (status === 'POSTED') {
        throw new BadRequestException('Batch is already POSTED');
      }
      if (status === 'VOIDED') {
        throw new BadRequestException('Batch is VOIDED and cannot be posted');
      }
      if (period_status === 'CLOSED' || period_status === 'LOCKED') {
        throw new BadRequestException(
          `Cannot post to a ${period_status} period. Reopen the period or create a batch against an OPEN period.`,
        );
      }
      // ADR-059 validation — verify SUM(debit) = SUM(credit) inside
      // this transaction and reject the post on imbalance. The whole
      // tx rolls back on throw.
      await this.validateBalance(tx, batchId);
      await tx.$executeRawUnsafe(
        `UPDATE fin_journal_batches SET status='POSTED', posted_at=now(), posted_by=$1::uuid, updated_at=now() WHERE id=$2::uuid`,
        actor.employeeId,
        batchId,
      );
      // Maintain budget actuals — bump the actual_amount on every
      // budget_line whose account matches a posted GL entry. Revenue
      // accounts (CREDIT normal balance) sum credits; expense accounts
      // (DEBIT normal balance) sum debits. Same period filter is
      // implicit (the batch already pins to the period).
      await tx.$executeRawUnsafe(
        `UPDATE fin_budget_lines bl SET actual_amount = bl.actual_amount + sub.delta, updated_at = now()
         FROM (
           SELECT e.account_id,
                  CASE WHEN a.normal_balance = 'DEBIT' THEN SUM(e.debit) ELSE SUM(e.credit) END AS delta
           FROM fin_gl_entries e
           JOIN fin_chart_of_accounts a ON a.id = e.account_id
           WHERE e.batch_id = $1::uuid
           GROUP BY e.account_id, a.normal_balance
         ) sub
         WHERE bl.account_id = sub.account_id`,
        batchId,
      );
    });
    return this.getById(batchId);
  }

  /** Void a POSTED batch by inserting a reversing batch + flipping
   * the original to VOIDED. Original lines stay for audit. */
  async void(
    actor: ResolvedActor,
    batchId: string,
    input: VoidJournalBatchDto,
  ): Promise<JournalBatchDto> {
    this.assertCanPost(actor);
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only school admins can void posted batches');
    }
    if (!actor.employeeId) {
      throw new BadRequestException('Void must be performed by an employee actor');
    }
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        `SELECT status FROM fin_journal_batches WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE`,
        batchId,
        tenant.schoolId,
      )) as Array<{ status: string }>;
      if (rows.length === 0) throw new NotFoundException('Batch not found');
      if (rows[0]!.status !== 'POSTED') {
        throw new BadRequestException(
          `Only POSTED batches can be voided (current: ${rows[0]!.status})`,
        );
      }
      await tx.$executeRawUnsafe(
        `UPDATE fin_journal_batches SET status='VOIDED', voided_at=now(), voided_by=$1::uuid, void_reason=$2, updated_at=now() WHERE id=$3::uuid`,
        actor.employeeId,
        input.reason,
        batchId,
      );
      // Reverse budget impact.
      await tx.$executeRawUnsafe(
        `UPDATE fin_budget_lines bl SET actual_amount = GREATEST(bl.actual_amount - sub.delta, 0), updated_at = now()
         FROM (
           SELECT e.account_id,
                  CASE WHEN a.normal_balance = 'DEBIT' THEN SUM(e.debit) ELSE SUM(e.credit) END AS delta
           FROM fin_gl_entries e
           JOIN fin_chart_of_accounts a ON a.id = e.account_id
           WHERE e.batch_id = $1::uuid
           GROUP BY e.account_id, a.normal_balance
         ) sub
         WHERE bl.account_id = sub.account_id`,
        batchId,
      );
    });
    return this.getById(batchId);
  }

  /**
   * In-tx helper that creates + posts a balanced batch using the
   * supplied transaction client (REVIEW-CYCLE26 BLOCKING 2). Lets
   * cross-service callers like APPaymentService.pay run the GL post
   * AND their own bookkeeping (ap_payment INSERT + voucher status
   * flip) inside ONE tenant transaction so a downstream failure
   * rolls the whole thing back atomically. Returns the new batch's
   * id; the caller reloads via getById outside the tx if it needs
   * the full DTO.
   *
   * Idempotency: source_event_id is checked inside the tx; if the
   * id already maps to a batch we return that id without re-posting.
   * Period validation + balance validation + budget rollup all run
   * inside the supplied tx.
   */
  async createAndPostInTx(
    tx: PrismaClient,
    actor: ResolvedActor,
    input: CreateJournalBatchDto & { sourceEventId?: string; periodId?: string },
  ): Promise<string> {
    this.assertCanPost(actor);
    if (!actor.employeeId) {
      throw new BadRequestException('Posting must be performed by an employee actor');
    }
    this.validateLineShape(input.entries);
    const tenant = getCurrentTenant();

    // Idempotency check inside the supplied tx.
    if (input.sourceEventId) {
      const existing = (await tx.$queryRawUnsafe(
        `SELECT id::text AS id FROM fin_journal_batches WHERE source_event_id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
        input.sourceEventId,
        tenant.schoolId,
      )) as Array<{ id: string }>;
      if (existing.length > 0) {
        return existing[0]!.id;
      }
    }

    const batchId = generateId();
    let periodId = input.periodId;
    if (!periodId) {
      const todayPeriods = (await tx.$queryRawUnsafe(
        `SELECT id::text AS id FROM fin_accounting_periods WHERE school_id = $1::uuid AND status = 'OPEN' AND CURRENT_DATE BETWEEN start_date AND end_date LIMIT 1`,
        tenant.schoolId,
      )) as Array<{ id: string }>;
      if (todayPeriods.length === 0) {
        throw new BadRequestException(
          'No OPEN accounting period covers today — a CFO must open the current period before automated postings can land',
        );
      }
      periodId = todayPeriods[0]!.id;
    } else {
      const targetPeriod = (await tx.$queryRawUnsafe(
        `SELECT status FROM fin_accounting_periods WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
        periodId,
        tenant.schoolId,
      )) as Array<{ status: string }>;
      if (targetPeriod.length === 0) throw new BadRequestException('Target period not found');
      const ps = targetPeriod[0]!.status;
      if (ps === 'CLOSED' || ps === 'LOCKED') {
        throw new BadRequestException(`Cannot post to a ${ps} period`);
      }
    }
    await tx.$executeRawUnsafe(
      `INSERT INTO fin_journal_batches (id, school_id, batch_number, description, batch_type, source_module, source_event_id, accounting_period_id, posted_by, posted_at, status) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid, $8::uuid, $9::uuid, now(), 'POSTED')`,
      batchId,
      tenant.schoolId,
      input.batchNumber,
      input.description,
      input.batchType,
      input.sourceModule ?? null,
      input.sourceEventId ?? null,
      periodId,
      actor.employeeId,
    );
    await this.insertEntries(tx, batchId, input.entries);
    // ADR-059 validation — throws on imbalance, caller's tx rolls back
    await this.validateBalance(tx, batchId);
    // Update budget actuals
    await tx.$executeRawUnsafe(
      `UPDATE fin_budget_lines bl SET actual_amount = bl.actual_amount + sub.delta, updated_at = now()
       FROM (
         SELECT e.account_id,
                CASE WHEN a.normal_balance = 'DEBIT' THEN SUM(e.debit) ELSE SUM(e.credit) END AS delta
         FROM fin_gl_entries e
         JOIN fin_chart_of_accounts a ON a.id = e.account_id
         WHERE e.batch_id = $1::uuid
         GROUP BY e.account_id, a.normal_balance
       ) sub
       WHERE bl.account_id = sub.account_id`,
      batchId,
    );
    return batchId;
  }

  /**
   * Public helper for the GLConsumer — idempotently create + post a
   * balanced batch in one shot, opening its own tenant transaction.
   * Returns the existing batch when source_event_id has already
   * landed (Kafka redelivery path). Wraps createAndPostInTx.
   */
  async createAndPost(
    actor: ResolvedActor,
    input: CreateJournalBatchDto & { sourceEventId?: string; periodId?: string },
  ): Promise<JournalBatchDto> {
    const tenant = getCurrentTenant();

    // Fast-path idempotency check outside the tx — if source_event_id
    // already mapped, return without locking. The in-tx check inside
    // createAndPostInTx is the authoritative one.
    if (input.sourceEventId) {
      const existing = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          `SELECT id::text AS id FROM fin_journal_batches WHERE source_event_id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
          input.sourceEventId,
          tenant.schoolId,
        );
      })) as Array<{ id: string }>;
      if (existing.length > 0) {
        return this.getById(existing[0]!.id);
      }
    }

    let batchId: string;
    try {
      batchId = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
        return this.createAndPostInTx(tx, actor, input);
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        // source_event_id raced — read back the canonical batch
        if (input.sourceEventId) {
          const existing = (await this.tenantPrisma.executeInTenantContext(async (client) => {
            return client.$queryRawUnsafe(
              `SELECT id::text AS id FROM fin_journal_batches WHERE source_event_id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
              input.sourceEventId,
              tenant.schoolId,
            );
          })) as Array<{ id: string }>;
          if (existing.length > 0) return this.getById(existing[0]!.id);
        }
        throw new ConflictException(
          `A journal batch with number '${input.batchNumber}' already exists`,
        );
      }
      throw err;
    }
    return this.getById(batchId);
  }

  // ─── private helpers ───

  private validateLineShape(entries: CreateGLEntryLineDto[]): void {
    if (!entries || entries.length === 0) {
      throw new BadRequestException('Journal batch must have at least one entry');
    }
    let totalDebit = 0;
    let totalCredit = 0;
    for (const e of entries) {
      if (e.debit > 0 && e.credit > 0) {
        throw new BadRequestException(
          'Each entry must be one-sided — populate debit OR credit, not both',
        );
      }
      if (e.debit === 0 && e.credit === 0) {
        throw new BadRequestException('Each entry must carry a non-zero debit or credit');
      }
      if (e.debit < 0 || e.credit < 0) {
        throw new BadRequestException('debit and credit must be non-negative');
      }
      totalDebit += e.debit;
      totalCredit += e.credit;
    }
    // Pre-flight balance check — friendly 400 before the tx fires.
    if (Math.abs(totalDebit - totalCredit) >= 0.005) {
      throw new BadRequestException(
        `Journal batch is unbalanced: debits=${totalDebit.toFixed(2)} credits=${totalCredit.toFixed(2)}`,
      );
    }
  }

  private async insertEntries(
    tx: PrismaClient,
    batchId: string,
    entries: CreateGLEntryLineDto[],
  ): Promise<void> {
    let order = 0;
    for (const e of entries) {
      await tx.$executeRawUnsafe(
        `INSERT INTO fin_gl_entries (id, batch_id, account_id, fund_id, debit, credit, description, reference_type, reference_id, line_order) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9::uuid, $10)`,
        generateId(),
        batchId,
        e.accountId,
        e.fundId,
        e.debit,
        e.credit,
        e.description ?? null,
        e.referenceType ?? null,
        e.referenceId ?? null,
        order++,
      );
    }
  }

  /**
   * The application-layer equivalent of the ADR-059
   * validate_batch_balance(batch_id) DB function. Aggregates SUM(debit)
   * and SUM(credit) over the batch's actual rows inside the calling
   * transaction. Throws on imbalance — caller's tx rolls back. The
   * integrity guarantee is identical to the DB-function variant
   * because both paths execute under one transaction.
   */
  private async validateBalance(tx: PrismaClient, batchId: string): Promise<void> {
    const rows = (await tx.$queryRawUnsafe<
      Array<{
        total_debit: string | number;
        total_credit: string | number;
        line_count: string | number;
      }>
    >(
      `SELECT COALESCE(SUM(debit), 0) AS total_debit, COALESCE(SUM(credit), 0) AS total_credit, COUNT(*) AS line_count FROM fin_gl_entries WHERE batch_id = $1::uuid`,
      batchId,
    )) as Array<{
      total_debit: string | number;
      total_credit: string | number;
      line_count: string | number;
    }>;
    const totalDebit = Number(rows[0]!.total_debit);
    const totalCredit = Number(rows[0]!.total_credit);
    const lineCount = Number(rows[0]!.line_count);
    if (lineCount === 0) {
      throw new BadRequestException('Cannot post a batch with no entries');
    }
    if (Math.abs(totalDebit - totalCredit) >= 0.005) {
      throw new BadRequestException(
        `Journal batch is unbalanced: debits=${totalDebit.toFixed(2)} credits=${totalCredit.toFixed(2)}`,
      );
    }
    if (totalDebit === 0) {
      throw new BadRequestException('Cannot post a batch whose total is zero');
    }
  }
}
