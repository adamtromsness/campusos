import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { LedgerService } from './ledger.service';
import {
  CreditCategory,
  CreditNoteResponseDto,
  IssueCreditNoteDto,
  ListCreditNotesQueryDto,
} from './dto/billing-ops.dto';

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
    private readonly kafka: KafkaProducerService,
    private readonly ledger: LedgerService,
  ) {}

  async list(
    query: ListCreditNotesQueryDto,
    actor: ResolvedActor,
  ): Promise<CreditNoteResponseDto[]> {
    if (!actor.isSchoolAdmin) throw new ForbiddenException('Only admins can list credit notes');
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      let sql = SELECT_BASE + 'WHERE 1=1 ';
      const params: unknown[] = [];
      let idx = 1;
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
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<CreditNoteRow[]>(SELECT_BASE + 'WHERE id = $1::uuid', id),
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
    let snapshot: { familyAccountId: string; ledgerEntryId: string };
    try {
      snapshot = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
        const invoiceRows = (await tx.$queryRawUnsafe(
          'SELECT id, school_id, family_account_id, total_amount::text, status FROM pay_invoices WHERE id = $1::uuid FOR UPDATE',
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
        if (invoice.school_id !== schoolId)
          throw new ForbiddenException('Invoice does not belong to this school');
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
        return { familyAccountId: invoice.family_account_id, ledgerEntryId };
      });
    } catch (err) {
      throw err;
    }
    const dto = await this.getById(creditId, actor);
    void this.kafka.emit({
      topic: 'pay.credit_note.issued',
      key: creditId,
      sourceModule: 'payments',
      payload: {
        creditNoteId: creditId,
        invoiceId,
        familyAccountId: snapshot.familyAccountId,
        creditAmount: dto.creditAmount,
        creditCategory: dto.creditCategory,
        reason: dto.reason,
        issuedBy: actor.accountId,
        ledgerEntryId: snapshot.ledgerEntryId,
        sourceRefId: creditId,
      },
    });
    return dto;
  }
}
