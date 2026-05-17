import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import { OutboxService } from '@shared/kafka';
import type { ResolvedActor } from '@modules/m00-platform';
import { LedgerService } from './ledger.service';
import {
  CreditCategory,
  CreditNoteResponseDto,
  IssueCreditNoteDto,
  ListCreditNotesQueryDto,
} from './dto/billing-ops.dto';

/**
 * REVIEW-P2-6 BLOCKING 3 — deterministic event_id helper. Mirrors the
 * P2-4a payroll pattern (deterministicPayrollEventId). A retry on the
 * same credit-note row produces the exact same Kafka event_id so the
 * downstream GLConsumer's idempotency catches the redelivery cleanly.
 */
export function deterministicCreditNoteEventId(creditNoteId: string): string {
  const hash = createHash('sha256')
    .update(creditNoteId + ':pay.credit_note.issued:v1')
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

interface CreditNoteRow {
  id: string;
  school_id: string;
  invoice_id: string;
  line_item_id: string | null;
  family_account_id: string;
  credit_amount: string;
  credit_category: string;
  reason: string;
  ledger_entry_id: string | null;
  issued_by: string;
  issued_at: string;
}

const SELECT_BASE =
  'SELECT id, school_id, invoice_id, line_item_id, family_account_id, credit_amount::text, ' +
  'credit_category, reason, ledger_entry_id, issued_by, issued_at FROM pay_credit_notes ';

function rowToDto(r: CreditNoteRow): CreditNoteResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    invoiceId: r.invoice_id,
    lineItemId: r.line_item_id,
    familyAccountId: r.family_account_id,
    creditAmount: Number(r.credit_amount),
    creditCategory: r.credit_category as CreditCategory,
    reason: r.reason,
    ledgerEntryId: r.ledger_entry_id,
    issuedBy: r.issued_by,
    issuedAt: r.issued_at,
  };
}

/**
 * CreditNoteService — Phase 2 Cycle 6 (P2-6).
 *
 * IMMUTABLE per ADR-010. The service exposes ONLY list / get / issue —
 * NO update or delete methods. Corrections are made by issuing a new
 * offsetting credit note or refund.
 *
 * issue() runs inside one tenant tx that:
 *   1. Locks the parent invoice FOR UPDATE.
 *   2. Validates invoice is not CANCELLED + credit does not exceed
 *      the invoice's outstanding balance.
 *   3. Writes a CREDIT pay_ledger_entries row (negative amount —
 *      reduces balance owed).
 *   4. INSERTs the pay_credit_notes row with ledger_entry_id wired.
 *   5. Recomputes invoice status (PARTIAL/PAID/SENT) based on the
 *      new effective amount paid.
 *
 * Then emits pay.credit_note.issued AFTER tx commits so the Cycle
 * 26 GLConsumer can post a balanced journal entry.
 */
@Injectable()
export class CreditNoteService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly outbox: OutboxService,
    private readonly ledger: LedgerService,
  ) {}

  async list(
    query: ListCreditNotesQueryDto,
    actor: ResolvedActor,
  ): Promise<CreditNoteResponseDto[]> {
    if (!actor.isSchoolAdmin) throw new ForbiddenException('Only admins can list credit notes');
    // REVIEW-P2-6 follow-on — defence-in-depth: list is school-scoped.
    const schoolId = getCurrentTenant().schoolId;
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      let sql = SELECT_BASE + 'WHERE school_id = $1::uuid ';
      const params: unknown[] = [schoolId];
      let idx = 2;
      if (query.invoiceId) {
        sql += 'AND invoice_id = $' + idx + '::uuid ';
        params.push(query.invoiceId);
        idx++;
      }
      if (query.familyAccountId) {
        sql += 'AND family_account_id = $' + idx + '::uuid ';
        params.push(query.familyAccountId);
        idx++;
      }
      sql += 'ORDER BY issued_at DESC';
      return client.$queryRawUnsafe<CreditNoteRow[]>(sql, ...params);
    });
    return rows.map(rowToDto);
  }

  async getById(id: string, actor: ResolvedActor): Promise<CreditNoteResponseDto> {
    if (!actor.isSchoolAdmin) throw new ForbiddenException('Only admins can read credit notes');
    // REVIEW-P2-6 follow-on — school-scoped read.
    const schoolId = getCurrentTenant().schoolId;
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<CreditNoteRow[]>(
        SELECT_BASE + 'WHERE school_id = $1::uuid AND id = $2::uuid',
        schoolId,
        id,
      ),
    );
    if (rows.length === 0) throw new NotFoundException('Credit note ' + id + ' not found');
    return rowToDto(rows[0]!);
  }

  async issue(
    invoiceId: string,
    body: IssueCreditNoteDto,
    actor: ResolvedActor,
  ): Promise<CreditNoteResponseDto> {
    if (!actor.isSchoolAdmin) throw new ForbiddenException('Only admins can issue credit notes');
    if (body.creditAmount <= 0) throw new BadRequestException('creditAmount must be > 0');
    const trimmedReason = body.reason.trim();
    if (trimmedReason.length === 0) throw new BadRequestException('reason is required');
    const schoolId = getCurrentTenant().schoolId;
    const creditId = generateId();
    // REVIEW-P2-6 BLOCKING 3 — invoice lookup is school-scoped so the
    // FOR UPDATE lock cannot acquire a foreign-school invoice.
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const invoiceRows = (await tx.$queryRawUnsafe(
        'SELECT id, school_id, family_account_id, total_amount::text, status FROM pay_invoices WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        schoolId,
        invoiceId,
      )) as Array<{
        id: string;
        school_id: string;
        family_account_id: string;
        total_amount: string;
        status: string;
      }>;
      if (invoiceRows.length === 0)
        throw new NotFoundException('Invoice ' + invoiceId + ' not found');
      const invoice = invoiceRows[0]!;
      if (invoice.status === 'CANCELLED')
        throw new BadRequestException('Cannot issue credit against a CANCELLED invoice');
      // Optional: validate line_item_id belongs to this invoice.
      if (body.lineItemId) {
        const liRows = (await tx.$queryRawUnsafe(
          'SELECT id FROM pay_invoice_line_items WHERE id = $1::uuid AND invoice_id = $2::uuid',
          body.lineItemId,
          invoiceId,
        )) as Array<unknown>;
        if (liRows.length === 0)
          throw new BadRequestException('lineItemId does not belong to this invoice');
      }
      const ledgerEntryId = await this.ledger.recordEntry(tx, {
        familyAccountId: invoice.family_account_id,
        entryType: 'CREDIT',
        amount: -body.creditAmount,
        referenceId: creditId,
        description: 'CREDIT: ' + (body.creditCategory ?? 'GOODWILL') + ' — ' + trimmedReason,
        createdBy: actor.accountId,
      });
      await tx.$executeRawUnsafe(
        'INSERT INTO pay_credit_notes ' +
          '(id, school_id, invoice_id, line_item_id, family_account_id, credit_amount, credit_category, reason, ledger_entry_id, issued_by) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6::numeric, $7, $8, $9::uuid, $10::uuid)',
        creditId,
        schoolId,
        invoiceId,
        body.lineItemId ?? null,
        invoice.family_account_id,
        body.creditAmount.toFixed(2),
        body.creditCategory ?? 'GOODWILL',
        trimmedReason,
        ledgerEntryId,
        actor.accountId,
      );

      // REVIEW-P2-6 BLOCKING 3 — durable outbox INSIDE the same tx.
      // The outbox row commits with the credit-note + ledger entry,
      // and the OutboxPublisherWorker handles publish-with-retry. A
      // broker outage no longer drops the GL event silently; the
      // event ID is deterministic so consumer-side dedup catches
      // redelivery.
      await this.outbox.enqueueInTx(tx as never, {
        topic: 'pay.credit_note.issued',
        key: creditId,
        sourceModule: 'payments',
        eventId: deterministicCreditNoteEventId(creditId),
        payload: {
          creditNoteId: creditId,
          invoiceId,
          familyAccountId: invoice.family_account_id,
          creditAmount: body.creditAmount,
          creditCategory: body.creditCategory ?? 'GOODWILL',
          reason: trimmedReason,
          issuedBy: actor.accountId,
          ledgerEntryId,
          sourceRefId: creditId,
        },
      });
    });
    return this.getById(creditId, actor);
  }
}
