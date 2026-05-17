import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { OutboxService } from '@shared/kafka/outbox.service';
import { assertFinanceAdmin, assertFinanceReader } from './access';
import { deterministicJournalBatchPostedEventId } from './event-ids';
import type {
  AddJournalEntryLineDto,
  CreateJournalBatchDto,
  JournalBatchDetailDto,
  JournalBatchDto,
  JournalBatchStatus,
  JournalEntryLineDto,
  VoidJournalBatchDto,
} from './dto/commerce.dto';

interface BatchRow {
  id: string;
  school_id: string;
  batch_name: string;
  description: string | null;
  entry_count: number;
  total_debits: string | number;
  total_credits: string | number;
  is_balanced: boolean;
  status: string;
  created_by: string;
  posted_by: string | null;
  posted_at: string | null;
  voided_by: string | null;
  voided_at: string | null;
  void_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface LineRow {
  id: string;
  batch_id: string;
  account_id: string;
  debit: string | number;
  credit: string | number;
  description: string | null;
  line_order: number;
}

/**
 * P2-29a — JournalBatchService.
 *
 * Admin manual GL adjustment batch — distinct from Cycle 26
 * fin_journal_batches which is the AUTO posting path from pay.*
 * events. Service flow:
 *
 *   create()  — INSERT a DRAFT batch with totals=0 + entry_count=0.
 *   addLine() — INSERT a fin_journal_entry_lines row inside one tx
 *               that also recomputes the parent batch's
 *               total_debits, total_credits, entry_count, and
 *               is_balanced flag from a fresh aggregate over all
 *               surviving lines. The schema CHECK(debit = 0 OR
 *               credit = 0) plus CHECK(debit > 0 OR credit > 0)
 *               guarantee a line is single-sided + non-empty.
 *   removeLine() — same recompute path.
 *   post()    — KEYSTONE. Locks the batch FOR UPDATE, validates
 *               is_balanced=true (total_debits = total_credits AND
 *               entry_count > 0). Rejects unbalanced batches at the
 *               service layer with the entire tx rolling back.
 *               Mirrors the Cycle 26 PostingService.post contract
 *               that proxies into validate_batch_balance. On
 *               success, copies each line into Cycle 26 fin_gl_entries
 *               + flips the batch to POSTED + stamps posted_by +
 *               posted_at atomically. Emits
 *               fin.journal_batch.posted via the durable outbox
 *               in the same tx so downstream readers see the
 *               write durably.
 *   void()    — POSTED-only transition flips status to VOIDED.
 */
@Injectable()
export class JournalBatchService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
    private readonly outbox: OutboxService,
  ) {}

  private toDto(row: BatchRow): JournalBatchDto {
    return {
      id: row.id,
      schoolId: row.school_id,
      batchName: row.batch_name,
      description: row.description,
      entryCount: Number(row.entry_count),
      totalDebits: Number(row.total_debits),
      totalCredits: Number(row.total_credits),
      isBalanced: row.is_balanced,
      status: row.status as JournalBatchStatus,
      createdBy: row.created_by,
      postedBy: row.posted_by,
      postedAt: row.posted_at,
      voidedBy: row.voided_by,
      voidedAt: row.voided_at,
      voidReason: row.void_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private lineToDto(row: LineRow): JournalEntryLineDto {
    return {
      id: row.id,
      batchId: row.batch_id,
      accountId: row.account_id,
      debit: Number(row.debit),
      credit: Number(row.credit),
      description: row.description,
      lineOrder: Number(row.line_order),
    };
  }

  async list(actor: ResolvedActor, status?: JournalBatchStatus): Promise<JournalBatchDto[]> {
    await assertFinanceReader(actor, this.permCheck, 'Journal batch list');
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const args: unknown[] = [tenant.schoolId];
      let where = '';
      if (status) {
        args.push(status);
        where = ` AND status = $${args.length}`;
      }
      const rows = (await client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id, batch_name, description,
                entry_count, total_debits, total_credits, is_balanced, status,
                created_by::text AS created_by,
                posted_by::text AS posted_by, posted_at::text AS posted_at,
                voided_by::text AS voided_by, voided_at::text AS voided_at,
                void_reason, created_at::text AS created_at,
                updated_at::text AS updated_at
           FROM fin_journal_entry_batches
          WHERE school_id = $1::uuid${where}
          ORDER BY created_at DESC`,
        ...args,
      )) as BatchRow[];
      return rows.map((r) => this.toDto(r));
    });
  }

  async getById(actor: ResolvedActor, id: string): Promise<JournalBatchDetailDto> {
    await assertFinanceReader(actor, this.permCheck, 'Journal batch read');
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id, batch_name, description,
                entry_count, total_debits, total_credits, is_balanced, status,
                created_by::text AS created_by,
                posted_by::text AS posted_by, posted_at::text AS posted_at,
                voided_by::text AS voided_by, voided_at::text AS voided_at,
                void_reason, created_at::text AS created_at,
                updated_at::text AS updated_at
           FROM fin_journal_entry_batches
          WHERE school_id = $1::uuid AND id = $2::uuid`,
        tenant.schoolId,
        id,
      )) as BatchRow[];
      if (rows.length === 0) throw new NotFoundException('Journal batch not found');
      const lines = (await client.$queryRawUnsafe(
        `SELECT id::text AS id, batch_id::text AS batch_id,
                account_id::text AS account_id, debit, credit, description, line_order
           FROM fin_journal_entry_lines
          WHERE batch_id = $1::uuid
          ORDER BY line_order, id`,
        id,
      )) as LineRow[];
      return {
        ...this.toDto(rows[0]!),
        lines: lines.map((l) => this.lineToDto(l)),
      };
    });
  }

  async create(actor: ResolvedActor, input: CreateJournalBatchDto): Promise<JournalBatchDto> {
    await assertFinanceAdmin(actor, this.permCheck, 'Create journal batch');
    const tenant = getCurrentTenant();
    if (!actor.employeeId) {
      throw new BadRequestException('Caller does not have an employee record in this school');
    }
    const id = generateId();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        `INSERT INTO fin_journal_entry_batches
           (id, school_id, batch_name, description, created_by)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid)
         RETURNING id::text AS id, school_id::text AS school_id, batch_name, description,
                   entry_count, total_debits, total_credits, is_balanced, status,
                   created_by::text AS created_by,
                   posted_by::text AS posted_by, posted_at::text AS posted_at,
                   voided_by::text AS voided_by, voided_at::text AS voided_at,
                   void_reason, created_at::text AS created_at,
                   updated_at::text AS updated_at`,
        id,
        tenant.schoolId,
        input.batchName,
        input.description ?? null,
        actor.employeeId,
      )) as BatchRow[];
      return this.toDto(rows[0]!);
    });
  }

  async addLine(
    actor: ResolvedActor,
    batchId: string,
    input: AddJournalEntryLineDto,
  ): Promise<JournalEntryLineDto> {
    await assertFinanceAdmin(actor, this.permCheck, 'Add journal batch line');
    const tenant = getCurrentTenant();
    // Service-layer pre-check for the single-side rule so the caller
    // gets a friendly 400 before hitting the schema CHECK.
    if (input.debit < 0 || input.credit < 0) {
      throw new BadRequestException('debit and credit must be non-negative');
    }
    if (input.debit > 0 && input.credit > 0) {
      throw new BadRequestException(
        'Journal entry lines are single-sided — set either debit or credit, not both',
      );
    }
    if (input.debit === 0 && input.credit === 0) {
      throw new BadRequestException('Journal entry lines must carry a non-zero debit or credit');
    }
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const batch = (await tx.$queryRawUnsafe(
        `SELECT id::text AS id, status FROM fin_journal_entry_batches
          WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE`,
        tenant.schoolId,
        batchId,
      )) as Array<{ id: string; status: string }>;
      if (batch.length === 0) throw new NotFoundException('Journal batch not found');
      if (batch[0]!.status !== 'DRAFT') {
        throw new BadRequestException(
          `Cannot modify a ${batch[0]!.status} journal batch — only DRAFT batches are editable`,
        );
      }

      // Validate the supplied account belongs to current school.
      const account = (await tx.$queryRawUnsafe(
        `SELECT 1 AS ok FROM fin_chart_of_accounts
          WHERE id = $1::uuid AND school_id = $2::uuid AND is_active = true LIMIT 1`,
        input.accountId,
        tenant.schoolId,
      )) as Array<{ ok: number }>;
      if (account.length === 0) {
        throw new BadRequestException(
          'accountId does not match an active chart-of-accounts row in this school',
        );
      }

      const id = generateId();
      const rows = (await tx.$queryRawUnsafe(
        `INSERT INTO fin_journal_entry_lines
           (id, batch_id, account_id, debit, credit, description, line_order)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::numeric, $5::numeric, $6, $7)
         RETURNING id::text AS id, batch_id::text AS batch_id,
                   account_id::text AS account_id, debit, credit, description, line_order`,
        id,
        batchId,
        input.accountId,
        input.debit,
        input.credit,
        input.description ?? null,
        input.lineOrder ?? 0,
      )) as LineRow[];

      await this.recomputeTotals(tx, batchId);

      return this.lineToDto(rows[0]!);
    });
  }

  async removeLine(
    actor: ResolvedActor,
    batchId: string,
    lineId: string,
  ): Promise<JournalBatchDetailDto> {
    await assertFinanceAdmin(actor, this.permCheck, 'Remove journal batch line');
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const batch = (await tx.$queryRawUnsafe(
        `SELECT id::text AS id, status FROM fin_journal_entry_batches
          WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE`,
        tenant.schoolId,
        batchId,
      )) as Array<{ id: string; status: string }>;
      if (batch.length === 0) throw new NotFoundException('Journal batch not found');
      if (batch[0]!.status !== 'DRAFT') {
        throw new BadRequestException(
          `Cannot modify a ${batch[0]!.status} journal batch — only DRAFT batches are editable`,
        );
      }
      const deleted = (await tx.$executeRawUnsafe(
        `DELETE FROM fin_journal_entry_lines WHERE id = $1::uuid AND batch_id = $2::uuid`,
        lineId,
        batchId,
      )) as number;
      if (deleted === 0) throw new NotFoundException('Journal entry line not found');
      await this.recomputeTotals(tx, batchId);
      return this.getById(actor, batchId);
    });
  }

  /**
   * KEYSTONE — POST the batch.
   *
   * Locks the batch + its lines, validates the schema-side balance
   * invariant (total_debits = total_credits, entry_count > 0) at the
   * service layer first so the caller gets a friendly 400, then
   * copies each line into Cycle 26 fin_gl_entries so the manual
   * batch flows through the same downstream readers as the AUTO
   * posting path. Emits fin.journal_batch.posted via the durable
   * outbox in the same tx.
   */
  async post(actor: ResolvedActor, batchId: string): Promise<JournalBatchDto> {
    await assertFinanceAdmin(actor, this.permCheck, 'Post journal batch');
    const tenant = getCurrentTenant();
    if (!actor.employeeId) {
      throw new BadRequestException('Caller does not have an employee record in this school');
    }
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const batchRows = (await tx.$queryRawUnsafe(
        `SELECT id::text AS id, status, entry_count, total_debits, total_credits, is_balanced
           FROM fin_journal_entry_batches
          WHERE school_id = $1::uuid AND id = $2::uuid
          FOR UPDATE`,
        tenant.schoolId,
        batchId,
      )) as Array<{
        id: string;
        status: string;
        entry_count: number;
        total_debits: string | number;
        total_credits: string | number;
        is_balanced: boolean;
      }>;
      if (batchRows.length === 0) throw new NotFoundException('Journal batch not found');
      const batch = batchRows[0]!;
      if (batch.status !== 'DRAFT') {
        throw new BadRequestException(
          `Journal batch is ${batch.status} — only DRAFT batches can be posted`,
        );
      }
      if (Number(batch.entry_count) === 0) {
        throw new BadRequestException(
          'Cannot post an empty journal batch — add at least one line first',
        );
      }
      const totalDebits = Number(batch.total_debits);
      const totalCredits = Number(batch.total_credits);
      // Tolerance match for NUMERIC(14,2) — strict cent equality.
      if (Math.abs(totalDebits - totalCredits) > 0.005 || !batch.is_balanced) {
        throw new BadRequestException(
          `Journal batch is unbalanced — total_debits=${totalDebits.toFixed(2)} but total_credits=${totalCredits.toFixed(2)}`,
        );
      }

      // Defence-in-depth — re-aggregate lines fresh under the lock
      // so a malicious client cannot pre-tamper the materialised
      // totals between addLine and post.
      const fresh = (await tx.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS n,
                COALESCE(SUM(debit), 0)::text AS d,
                COALESCE(SUM(credit), 0)::text AS c
           FROM fin_journal_entry_lines WHERE batch_id = $1::uuid`,
        batchId,
      )) as Array<{ n: number; d: string; c: string }>;
      const freshD = Number(fresh[0]!.d);
      const freshC = Number(fresh[0]!.c);
      const freshN = Number(fresh[0]!.n);
      if (freshN === 0) {
        throw new BadRequestException('Journal batch is empty — cannot post a batch with no lines');
      }
      if (Math.abs(freshD - freshC) > 0.005) {
        throw new BadRequestException(
          `Journal batch is unbalanced — aggregated debits=${freshD.toFixed(2)}, credits=${freshC.toFixed(2)}`,
        );
      }

      // REVIEW-P2C29 Round 1 BLOCKING 5 fix — module boundary.
      //
      // Previously this service wrote directly into Cycle 26
      // fin_gl_entries (the Finance/GL surface). The reviewer
      // correctly flagged that the GL module should own GL writes;
      // commerce/finance-extensions owns the manual batch + lines,
      // emits fin.journal_batch.posted durably, and the
      // JournalBatchPostedConsumer in apps/api/src/finance/
      // materialises fin_gl_entries via PostingService.createAndPost
      // (which already supports source_event_id UNIQUE for redelivery
      // idempotency).
      //
      // The post() path now:
      //   1. Validates the batch is DRAFT + balanced + non-empty.
      //   2. Re-aggregates fresh under FOR UPDATE lock.
      //   3. Flips status to POSTED + stamps posted_by + posted_at.
      //   4. Emits fin.journal_batch.posted via durable outbox with
      //      the line shape the consumer needs to create GL entries.
      //
      // The Finance consumer is the ONLY writer to fin_gl_entries
      // for this event. Module boundary is preserved.

      // Read the lines fresh inside the same tx so the emit payload
      // carries the exact data the consumer needs without a second
      // tenant context round trip on the consumer side.
      const lines = (await tx.$queryRawUnsafe(
        `SELECT id::text AS id, account_id::text AS account_id,
                debit, credit, description, line_order
           FROM fin_journal_entry_lines WHERE batch_id = $1::uuid ORDER BY line_order, id`,
        batchId,
      )) as Array<{
        id: string;
        account_id: string;
        debit: string | number;
        credit: string | number;
        description: string | null;
        line_order: number;
      }>;

      // Flip status to POSTED — schema-side posted_chk lockstep
      // requires posted_by + posted_at populated together.
      const updated = (await tx.$queryRawUnsafe(
        `UPDATE fin_journal_entry_batches
            SET status = 'POSTED', posted_by = $1::uuid, posted_at = now(),
                updated_at = now()
          WHERE school_id = $2::uuid AND id = $3::uuid
          RETURNING id::text AS id, school_id::text AS school_id, batch_name, description,
                    entry_count, total_debits, total_credits, is_balanced, status,
                    created_by::text AS created_by,
                    posted_by::text AS posted_by, posted_at::text AS posted_at,
                    voided_by::text AS voided_by, voided_at::text AS voided_at,
                    void_reason, created_at::text AS created_at,
                    updated_at::text AS updated_at`,
        actor.employeeId,
        tenant.schoolId,
        batchId,
      )) as BatchRow[];

      await this.outbox.enqueueInTx(tx, {
        topic: 'fin.journal_batch.posted',
        payload: {
          batchId,
          schoolId: tenant.schoolId,
          batchName: updated[0]!.batch_name,
          entryCount: Number(updated[0]!.entry_count),
          totalDebits: Number(updated[0]!.total_debits),
          totalCredits: Number(updated[0]!.total_credits),
          postedBy: actor.employeeId,
          // The consumer needs each line's account + debit/credit
          // to materialise the GL entries. Send them in the payload.
          lines: lines.map((ln) => ({
            accountId: ln.account_id,
            debit: Number(ln.debit),
            credit: Number(ln.credit),
            description: ln.description,
            lineOrder: ln.line_order,
          })),
          sourceRefId: batchId,
        },
        sourceModule: 'commerce',
        eventId: deterministicJournalBatchPostedEventId(batchId),
        tenantId: tenant.schoolId,
        tenantSubdomain: tenant.subdomain,
        key: batchId,
      });

      return this.toDto(updated[0]!);
    });
  }

  async void(
    actor: ResolvedActor,
    batchId: string,
    input: VoidJournalBatchDto,
  ): Promise<JournalBatchDto> {
    await assertFinanceAdmin(actor, this.permCheck, 'Void journal batch');
    const tenant = getCurrentTenant();
    if (!actor.employeeId) {
      throw new BadRequestException('Caller does not have an employee record in this school');
    }
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const existing = (await tx.$queryRawUnsafe(
        `SELECT id::text AS id, status FROM fin_journal_entry_batches
          WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE`,
        tenant.schoolId,
        batchId,
      )) as Array<{ id: string; status: string }>;
      if (existing.length === 0) throw new NotFoundException('Journal batch not found');
      if (existing[0]!.status !== 'POSTED') {
        throw new BadRequestException(
          `Journal batch is ${existing[0]!.status} — only POSTED batches can be voided`,
        );
      }
      const rows = (await tx.$queryRawUnsafe(
        `UPDATE fin_journal_entry_batches
            SET status = 'VOIDED', voided_by = $1::uuid, voided_at = now(),
                void_reason = $2, updated_at = now()
          WHERE school_id = $3::uuid AND id = $4::uuid
          RETURNING id::text AS id, school_id::text AS school_id, batch_name, description,
                    entry_count, total_debits, total_credits, is_balanced, status,
                    created_by::text AS created_by,
                    posted_by::text AS posted_by, posted_at::text AS posted_at,
                    voided_by::text AS voided_by, voided_at::text AS voided_at,
                    void_reason, created_at::text AS created_at,
                    updated_at::text AS updated_at`,
        actor.employeeId,
        input.voidReason,
        tenant.schoolId,
        batchId,
      )) as BatchRow[];
      return this.toDto(rows[0]!);
    });
  }

  /**
   * Recompute total_debits / total_credits / entry_count / is_balanced
   * on the parent batch from a fresh aggregate over its lines.
   * Called by addLine + removeLine inside the active tx.
   */
  private async recomputeTotals(
    tx: Parameters<TenantPrismaService['executeInTenantTransaction']>[0] extends (
      arg: infer T,
    ) => unknown
      ? T
      : never,
    batchId: string,
  ): Promise<void> {
    await tx.$executeRawUnsafe(
      `UPDATE fin_journal_entry_batches
          SET entry_count = agg.n,
              total_debits = agg.d,
              total_credits = agg.c,
              is_balanced = (agg.n > 0 AND agg.d = agg.c),
              updated_at = now()
         FROM (
           SELECT COUNT(*)::int AS n,
                  COALESCE(SUM(debit), 0)::numeric AS d,
                  COALESCE(SUM(credit), 0)::numeric AS c
             FROM fin_journal_entry_lines WHERE batch_id = $1::uuid
         ) agg
        WHERE id = $1::uuid`,
      batchId,
    );
  }
}
