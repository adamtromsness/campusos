import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { OutboxService } from '../kafka/outbox.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { LedgerService } from './ledger.service';
import {
  ListReversalsQueryDto,
  PaymentReversalResponseDto,
  ReversalType,
  ReversePaymentDto,
} from './dto/billing-ops.dto';

/**
 * REVIEW-P2-6 BLOCKING 3 — deterministic event_id for the durable
 * outbox so a redelivered envelope carries the same id as the original
 * publish. Cycle 26 GLConsumer dedupes on event_id.
 */
export function deterministicReversalEventId(reversalId: string): string {
  const hash = createHash('sha1')
    .update(reversalId + ':pay.payment.reversed:v1')
    .digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return (
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-' +
    hex.slice(12, 16) +
    '-' +
    hex.slice(16, 20) +
    '-' +
    hex.slice(20, 32)
  );
}

interface ReversalRow {
  id: string;
  school_id: string;
  payment_id: string;
  family_account_id: string;
  invoice_id: string;
  reversal_type: string;
  reversal_reason: string;
  bank_reference: string | null;
  reversed_amount: string;
  ledger_entry_id: string | null;
  reversed_by: string;
  reversed_at: string;
}

const SELECT_BASE =
  'SELECT id, school_id, payment_id, family_account_id, invoice_id, reversal_type, ' +
  'reversal_reason, bank_reference, reversed_amount::text, ledger_entry_id, reversed_by, reversed_at ' +
  'FROM pay_payment_reversals ';

function rowToDto(r: ReversalRow): PaymentReversalResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    paymentId: r.payment_id,
    familyAccountId: r.family_account_id,
    invoiceId: r.invoice_id,
    reversalType: r.reversal_type as ReversalType,
    reversalReason: r.reversal_reason,
    bankReference: r.bank_reference,
    reversedAmount: Number(r.reversed_amount),
    ledgerEntryId: r.ledger_entry_id,
    reversedBy: r.reversed_by,
    reversedAt: r.reversed_at,
  };
}

/**
 * ReversalService — Phase 2 Cycle 6 (P2-6).
 *
 * IMMUTABLE per ADR-010. Service exposes ONLY list / get / reverse.
 * UNIQUE(payment_id) on the schema enforces one reversal per payment.
 *
 * reverse() runs inside one tenant tx that:
 *   1. Locks the parent invoice FOR UPDATE first (consistent lock
 *      ordering with PaymentService.pay + RefundService.issue).
 *   2. Locks the payment row FOR UPDATE.
 *   3. Validates payment is COMPLETED + has not already been
 *      reversed (UNIQUE check).
 *   4. INSERTs the pay_payment_reversals row.
 *   5. Writes a CHARGE pay_ledger_entries row to nullify the
 *      original PAYMENT credit (positive amount restores balance
 *      owed).
 *   6. Flips pay_payments.status to FAILED.
 *   7. Recomputes pay_invoices.status — if the invoice was PAID it
 *      flips to OVERDUE (or PARTIAL if other partial payments
 *      remain) so the family sees the bill restored.
 *
 * Then emits pay.payment.reversed AFTER tx commits.
 */
@Injectable()
export class ReversalService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly outbox: OutboxService,
    private readonly ledger: LedgerService,
  ) {}

  async list(
    query: ListReversalsQueryDto,
    actor: ResolvedActor,
  ): Promise<PaymentReversalResponseDto[]> {
    if (!actor.isSchoolAdmin)
      throw new ForbiddenException('Only admins can list payment reversals');
    // REVIEW-P2-6 follow-on — defence-in-depth school scoping.
    const schoolId = getCurrentTenant().schoolId;
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      let sql = SELECT_BASE + 'WHERE school_id = $1::uuid ';
      const params: unknown[] = [schoolId];
      let idx = 2;
      if (query.familyAccountId) {
        sql += 'AND family_account_id = $' + idx + '::uuid ';
        params.push(query.familyAccountId);
        idx++;
      }
      if (query.invoiceId) {
        sql += 'AND invoice_id = $' + idx + '::uuid ';
        params.push(query.invoiceId);
        idx++;
      }
      sql += 'ORDER BY reversed_at DESC';
      return client.$queryRawUnsafe<ReversalRow[]>(sql, ...params);
    });
    return rows.map(rowToDto);
  }

  async getById(id: string, actor: ResolvedActor): Promise<PaymentReversalResponseDto> {
    if (!actor.isSchoolAdmin)
      throw new ForbiddenException('Only admins can read payment reversals');
    // REVIEW-P2-6 follow-on — defence-in-depth school scoping.
    const schoolId = getCurrentTenant().schoolId;
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<ReversalRow[]>(
        SELECT_BASE + 'WHERE school_id = $1::uuid AND id = $2::uuid',
        schoolId,
        id,
      ),
    );
    if (rows.length === 0) throw new NotFoundException('Payment reversal ' + id + ' not found');
    return rowToDto(rows[0]!);
  }

  async reverse(
    paymentId: string,
    body: ReversePaymentDto,
    actor: ResolvedActor,
  ): Promise<PaymentReversalResponseDto> {
    if (!actor.isSchoolAdmin) throw new ForbiddenException('Only admins can reverse payments');
    const trimmedReason = body.reversalReason.trim();
    if (trimmedReason.length === 0) throw new BadRequestException('reversalReason is required');
    const schoolId = getCurrentTenant().schoolId;
    const reversalId = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // REVIEW-P2-6 BLOCKING 3 — payment lookup is school-scoped so a
      // cross-school payment UUID collapses to 404 BEFORE we lock the
      // parent invoice. Lock invoice FIRST then payment (consistent
      // ordering with PaymentService.pay + RefundService.issue).
      const paymentInvoiceRows = (await tx.$queryRawUnsafe(
        'SELECT invoice_id::text AS invoice_id FROM pay_payments WHERE school_id = $1::uuid AND id = $2::uuid',
        schoolId,
        paymentId,
      )) as Array<{ invoice_id: string }>;
      if (paymentInvoiceRows.length === 0)
        throw new NotFoundException('Payment ' + paymentId + ' not found');
      const invoiceId = paymentInvoiceRows[0]!.invoice_id;
      await tx.$queryRawUnsafe(
        'SELECT id FROM pay_invoices WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        schoolId,
        invoiceId,
      );

      const paymentRows = (await tx.$queryRawUnsafe(
        'SELECT id, school_id, family_account_id, amount::text, status FROM pay_payments WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        schoolId,
        paymentId,
      )) as Array<{
        id: string;
        school_id: string;
        family_account_id: string;
        amount: string;
        status: string;
      }>;
      if (paymentRows.length === 0)
        throw new NotFoundException('Payment ' + paymentId + ' not found');
      const payment = paymentRows[0]!;
      if (payment.status !== 'COMPLETED') {
        throw new BadRequestException(
          'Cannot reverse payment in status ' +
            payment.status +
            '; only COMPLETED payments can be reversed',
        );
      }
      const reversedAmount = Number(payment.amount);
      const ledgerEntryId = await this.ledger.recordEntry(tx, {
        familyAccountId: payment.family_account_id,
        entryType: 'CHARGE',
        amount: reversedAmount,
        referenceId: reversalId,
        description: 'REVERSAL: ' + body.reversalType + ' — ' + trimmedReason,
        createdBy: actor.accountId,
      });
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO pay_payment_reversals ' +
            '(id, school_id, payment_id, family_account_id, invoice_id, reversal_type, reversal_reason, bank_reference, reversed_amount, ledger_entry_id, reversed_by) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9::numeric, $10::uuid, $11::uuid)',
          reversalId,
          schoolId,
          paymentId,
          payment.family_account_id,
          invoiceId,
          body.reversalType,
          trimmedReason,
          body.bankReference ?? null,
          reversedAmount.toFixed(2),
          ledgerEntryId,
          actor.accountId,
        );
      } catch (err) {
        if (err instanceof Error && /pay_payment_reversals_payment_uq|23505/.test(err.message)) {
          throw new BadRequestException('Payment ' + paymentId + ' has already been reversed');
        }
        throw err;
      }
      // Flip payment to FAILED.
      await tx.$executeRawUnsafe(
        "UPDATE pay_payments SET status = 'FAILED', updated_at = now() WHERE id = $1::uuid",
        paymentId,
      );
      // Recompute invoice status from the refund-aware paid formula.
      const invoiceStatusRows = (await tx.$queryRawUnsafe(
        'SELECT id, total_amount::text, status, ' +
          "(COALESCE((SELECT SUM(p.amount) FROM pay_payments p WHERE p.invoice_id = pay_invoices.id AND p.status IN ('COMPLETED','REFUNDED')), 0) " +
          "- COALESCE((SELECT SUM(r.amount) FROM pay_refunds r JOIN pay_payments p2 ON p2.id = r.payment_id WHERE p2.invoice_id = pay_invoices.id AND r.status = 'COMPLETED'), 0))::text AS amount_paid " +
          'FROM pay_invoices WHERE id = $1::uuid',
        invoiceId,
      )) as Array<{ id: string; total_amount: string; status: string; amount_paid: string }>;
      if (invoiceStatusRows.length > 0) {
        const inv = invoiceStatusRows[0]!;
        if (inv.status !== 'DRAFT' && inv.status !== 'CANCELLED') {
          const totalAmount = Number(inv.total_amount);
          const netPaid = Number(inv.amount_paid);
          let nextStatus: string;
          if (netPaid >= totalAmount - 0.001) {
            nextStatus = 'PAID';
          } else if (netPaid > 0.001) {
            nextStatus = 'PARTIAL';
          } else {
            nextStatus = 'SENT';
          }
          if (nextStatus !== inv.status) {
            await tx.$executeRawUnsafe(
              'UPDATE pay_invoices SET status = $1, updated_at = now() WHERE id = $2::uuid',
              nextStatus,
              invoiceId,
            );
          }
        }
      }
      // REVIEW-P2-6 BLOCKING 3 — durable outbox INSIDE the same tx as
      // the reversal + ledger write. Cycle 26 GLConsumer dedupes on
      // event_id, so retries and Kafka redelivery are safe.
      await this.outbox.enqueueInTx(tx as never, {
        topic: 'pay.payment.reversed',
        key: reversalId,
        sourceModule: 'payments',
        eventId: deterministicReversalEventId(reversalId),
        payload: {
          reversalId,
          paymentId,
          invoiceId,
          familyAccountId: payment.family_account_id,
          reversalType: body.reversalType,
          reversalReason: trimmedReason,
          reversedAmount,
          reversedBy: actor.accountId,
          sourceRefId: reversalId,
        },
      });
    });
    return this.getById(reversalId, actor);
  }
}
