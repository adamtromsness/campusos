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
  CreateInvoiceDto,
  GenerateFromScheduleDto,
  GenerateFromScheduleResponseDto,
  InvoiceLineItemResponseDto,
  InvoiceResponseDto,
  InvoiceStatus,
  ListInvoicesQueryDto,
} from './dto/invoice.dto';

interface InvoiceRow {
  id: string;
  school_id: string;
  family_account_id: string;
  family_account_number: string;
  family_account_holder_first: string;
  family_account_holder_last: string;
  title: string;
  description: string | null;
  total_amount: string;
  amount_paid: string;
  due_date: string | null;
  status: string;
  sent_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface LineItemRow {
  id: string;
  invoice_id: string;
  fee_schedule_id: string | null;
  fee_schedule_name: string | null;
  description: string;
  quantity: string;
  unit_price: string;
  total: string;
  sort_order: number;
}

function lineItemRowToDto(r: LineItemRow): InvoiceLineItemResponseDto {
  return {
    id: r.id,
    invoiceId: r.invoice_id,
    feeScheduleId: r.fee_schedule_id,
    feeScheduleName: r.fee_schedule_name,
    description: r.description,
    quantity: Number(r.quantity),
    unitPrice: Number(r.unit_price),
    total: Number(r.total),
    sortOrder: Number(r.sort_order),
  };
}

function invoiceRowToDto(r: InvoiceRow, lineItems: LineItemRow[]): InvoiceResponseDto {
  var total = Number(r.total_amount);
  var paid = Number(r.amount_paid);
  return {
    id: r.id,
    schoolId: r.school_id,
    familyAccountId: r.family_account_id,
    familyAccountNumber: r.family_account_number,
    familyAccountHolderName: r.family_account_holder_first + ' ' + r.family_account_holder_last,
    title: r.title,
    description: r.description,
    totalAmount: total,
    amountPaid: paid,
    balanceDue: Number((total - paid).toFixed(2)),
    dueDate: r.due_date,
    status: r.status as InvoiceStatus,
    sentAt: r.sent_at,
    notes: r.notes,
    lineItems: lineItems.filter((l) => l.invoice_id === r.id).map(lineItemRowToDto),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// REVIEW-CYCLE6 fix 7: amount_paid nets out completed refunds so the
// balance-due reflects the post-refund state. Otherwise a partial
// refund leaves the invoice reading PAID with balance $0 even though
// the ledger has restored owed money. Full refunds flip the parent
// payment to REFUNDED (excluded from the COMPLETED-payment sum) and
// land a COMPLETED refund row, so we include both COMPLETED and
// REFUNDED payments in the inflow sum and subtract COMPLETED refunds
// to net the post-refund position. The formula remains derivable from
// the ledger — pay_invoices.amount_paid is not a denormalised column.
var INVOICE_AMOUNT_PAID_SQL =
  '(' +
  "COALESCE((SELECT SUM(p.amount) FROM pay_payments p WHERE p.invoice_id = i.id AND p.status IN ('COMPLETED','REFUNDED')), 0) " +
  "- COALESCE((SELECT SUM(r.amount) FROM pay_refunds r JOIN pay_payments p2 ON p2.id = r.payment_id WHERE p2.invoice_id = i.id AND r.status = 'COMPLETED'), 0) " +
  ')';

var SELECT_INVOICE_BASE =
  'SELECT i.id, i.school_id, i.family_account_id, fa.account_number AS family_account_number, ' +
  'ip.first_name AS family_account_holder_first, ip.last_name AS family_account_holder_last, ' +
  'i.title, i.description, i.total_amount::text, ' +
  INVOICE_AMOUNT_PAID_SQL +
  '::text AS amount_paid, ' +
  "TO_CHAR(i.due_date, 'YYYY-MM-DD') AS due_date, " +
  'i.status, i.sent_at, i.notes, i.created_at, i.updated_at ' +
  'FROM pay_invoices i ' +
  'JOIN pay_family_accounts fa ON fa.id = i.family_account_id ' +
  'JOIN platform.iam_person ip ON ip.id = fa.account_holder_id ';

@Injectable()
export class InvoiceService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
    private readonly ledger: LedgerService,
  ) {}

  async list(query: ListInvoicesQueryDto, actor: ResolvedActor): Promise<InvoiceResponseDto[]> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      var sql = SELECT_INVOICE_BASE + 'WHERE 1=1 ';
      var params: any[] = [];
      var idx = 1;
      if (!actor.isSchoolAdmin) {
        if (actor.personType !== 'GUARDIAN') return [] as InvoiceRow[];
        sql += 'AND fa.account_holder_id = $' + idx + '::uuid ';
        params.push(actor.personId);
        idx++;
      }
      if (query.familyAccountId) {
        sql += 'AND i.family_account_id = $' + idx + '::uuid ';
        params.push(query.familyAccountId);
        idx++;
      }
      if (query.status) {
        sql += 'AND i.status = $' + idx + ' ';
        params.push(query.status);
        idx++;
      }
      sql += 'ORDER BY i.created_at DESC';
      return client.$queryRawUnsafe<InvoiceRow[]>(sql, ...params);
    });
    if (rows.length === 0) return [];
    var lineItems = await this.loadLineItems(rows.map((r) => r.id));
    return rows.map((r) => invoiceRowToDto(r, lineItems));
  }

  async getById(id: string, actor: ResolvedActor): Promise<InvoiceResponseDto> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<InvoiceRow[]>(
        SELECT_INVOICE_BASE + 'WHERE i.id = $1::uuid',
        id,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Invoice ' + id + ' not found');
    var row = rows[0]!;
    if (!actor.isSchoolAdmin) {
      if (
        actor.personType !== 'GUARDIAN' ||
        !(await this.isAccountHolder(row.family_account_id, actor.personId))
      ) {
        throw new NotFoundException('Invoice ' + id + ' not found');
      }
    }
    var items = await this.loadLineItems([id]);
    return invoiceRowToDto(row, items);
  }

  /**
   * Admin-only — create a DRAFT invoice with line items. The total is
   * computed as SUM(quantity * unit_price) over the line items; per-line
   * `total` is denormalised onto the row to keep the invariant that
   * pay_invoices.total_amount = SUM(line_items.total).
   */
  async create(body: CreateInvoiceDto, actor: ResolvedActor): Promise<InvoiceResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can create invoices');
    }
    var schoolId = getCurrentTenant().schoolId;
    var invoiceId = generateId();
    var totalAmount = 0;
    for (var i = 0; i < body.lineItems.length; i++) {
      var li = body.lineItems[i]!;
      var lineTotal = Number(((li.quantity ?? 1) * li.unitPrice).toFixed(2));
      totalAmount = Number((totalAmount + lineTotal).toFixed(2));
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      var accountRows = (await tx.$queryRawUnsafe(
        'SELECT id, status FROM pay_family_accounts WHERE id = $1::uuid',
        body.familyAccountId,
      )) as Array<{ id: string; status: string }>;
      if (accountRows.length === 0) {
        throw new NotFoundException('Family account ' + body.familyAccountId + ' not found');
      }
      if (accountRows[0]!.status !== 'ACTIVE') {
        throw new BadRequestException(
          'Family account is in status ' + accountRows[0]!.status + '; cannot bill',
        );
      }
      await tx.$executeRawUnsafe(
        'INSERT INTO pay_invoices (id, school_id, family_account_id, title, description, total_amount, due_date, status) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::numeric, $7::date, 'DRAFT')",
        invoiceId,
        schoolId,
        body.familyAccountId,
        body.title,
        body.description ?? null,
        totalAmount.toFixed(2),
        body.dueDate ?? null,
      );
      for (var j = 0; j < body.lineItems.length; j++) {
        var line = body.lineItems[j]!;
        var quantity = line.quantity ?? 1;
        var lineTotalCalc = Number((quantity * line.unitPrice).toFixed(2));
        await tx.$executeRawUnsafe(
          'INSERT INTO pay_invoice_line_items (id, invoice_id, fee_schedule_id, description, quantity, unit_price, total, sort_order) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::numeric, $6::numeric, $7::numeric, $8::int)',
          generateId(),
          invoiceId,
          line.feeScheduleId ?? null,
          line.description,
          quantity.toFixed(2),
          line.unitPrice.toFixed(2),
          lineTotalCalc.toFixed(2),
          j,
        );
      }
    });
    return this.getById(invoiceId, actor);
  }

  /**
   * Admin sends a DRAFT invoice. Locks the row FOR UPDATE inside the
   * same tx that flips status DRAFT→SENT, populates sent_at (multi-
   * column sent_chk), and writes the CHARGE ledger entry for the full
   * total. Emits pay.invoice.created on success (after the tx commits).
   */
  async send(id: string, actor: ResolvedActor): Promise<InvoiceResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can send invoices');
    }
    var snapshot = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      var rows = (await tx.$queryRawUnsafe(
        'SELECT id, family_account_id, total_amount::text, status FROM pay_invoices WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{
        id: string;
        family_account_id: string;
        total_amount: string;
        status: string;
      }>;
      if (rows.length === 0) {
        throw new NotFoundException('Invoice ' + id + ' not found');
      }
      var inv = rows[0]!;
      if (inv.status !== 'DRAFT') {
        throw new BadRequestException(
          'Invoice is in status ' + inv.status + '; only DRAFT invoices can be sent',
        );
      }
      await tx.$executeRawUnsafe(
        "UPDATE pay_invoices SET status = 'SENT', sent_at = now(), updated_at = now() WHERE id = $1::uuid",
        id,
      );
      await this.ledger.recordEntry(tx, {
        familyAccountId: inv.family_account_id,
        entryType: 'CHARGE',
        amount: Number(inv.total_amount),
        referenceId: id,
        description: 'CHARGE: invoice sent',
        createdBy: actor.accountId,
      });
      return inv;
    });

    var dto = await this.getById(id, actor);
    void this.kafka.emit({
      topic: 'pay.invoice.created',
      key: id,
      sourceModule: 'payments',
      payload: {
        invoiceId: id,
        familyAccountId: snapshot.family_account_id,
        totalAmount: Number(snapshot.total_amount),
        title: dto.title,
        dueDate: dto.dueDate,
        sentAt: dto.sentAt,
      },
    });
    return dto;
  }

  /**
   * Admin cancels an invoice. Locks the row, flips status to CANCELLED.
   * If any payments are attached, the cancel still proceeds — the
   * payments stay valid (pay_payments.invoice_id is no-cascade); refunds
   * are a separate admin action.
   *
   * REVIEW-CYCLE6 fix 6: cancelling a SENT or PARTIAL invoice must write
   * a compensating ADJUSTMENT entry that nets out the outstanding
   * balance contribution from this invoice (CHARGE total minus completed
   * payments). Without it, the family balance stays inflated by the
   * uncollected portion, even though the invoice is no longer valid.
   * DRAFT invoices haven't written a CHARGE entry yet, so no adjustment
   * is needed for them.
   */
  async cancel(id: string, actor: ResolvedActor): Promise<InvoiceResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can cancel invoices');
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      var rows = (await tx.$queryRawUnsafe(
        'SELECT id, family_account_id, total_amount::text, status FROM pay_invoices WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{
        id: string;
        family_account_id: string;
        total_amount: string;
        status: string;
      }>;
      if (rows.length === 0) {
        throw new NotFoundException('Invoice ' + id + ' not found');
      }
      var inv = rows[0]!;
      if (inv.status === 'CANCELLED') {
        throw new BadRequestException('Invoice is already CANCELLED');
      }
      if (inv.status === 'PAID') {
        throw new BadRequestException('Invoice is PAID; issue a refund instead of cancelling');
      }
      await tx.$executeRawUnsafe(
        "UPDATE pay_invoices SET status = 'CANCELLED', updated_at = now() WHERE id = $1::uuid",
        id,
      );
      // Compensate the ledger for non-DRAFT invoices that already
      // landed a CHARGE entry. The outstanding balance to neutralise
      // is `total - SUM(completed payments)` — a partially-paid invoice
      // only needs to back out the unpaid remainder.
      if (inv.status !== 'DRAFT') {
        var paidRows = (await tx.$queryRawUnsafe(
          "SELECT COALESCE(SUM(amount), 0)::text AS paid FROM pay_payments WHERE invoice_id = $1::uuid AND status = 'COMPLETED'",
          id,
        )) as Array<{ paid: string }>;
        var totalAmount = Number(inv.total_amount);
        var completed = Number(paidRows[0]?.paid ?? '0');
        var outstanding = Number((totalAmount - completed).toFixed(2));
        if (outstanding > 0.001) {
          await this.ledger.recordEntry(tx, {
            familyAccountId: inv.family_account_id,
            entryType: 'ADJUSTMENT',
            amount: -outstanding,
            referenceId: id,
            description:
              'ADJUSTMENT: invoice cancelled — reversing outstanding $' + outstanding.toFixed(2),
            createdBy: actor.accountId,
          });
        }
      }
    });
    return this.getById(id, actor);
  }

  /**
   * Admin-only bulk: for every family account that's linked to a
   * student in the given fee schedule's grade level (or every account
   * if grade_level=NULL), creates a DRAFT invoice with one line item
   * per matching student. Skips families that already have a DRAFT or
   * SENT invoice with the same fee_schedule attribution to avoid
   * accidental double-billing.
   *
   * The plan's intent: admin clicks "generate from schedule" once at
   * the start of the year and every linked family ends up with a draft
   * tuition invoice they can then send + collect on.
   */
  async generateFromSchedule(
    body: GenerateFromScheduleDto,
    actor: ResolvedActor,
  ): Promise<GenerateFromScheduleResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can generate invoices');
    }
    var schoolId = getCurrentTenant().schoolId;

    var scheduleRows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<
        Array<{
          id: string;
          name: string;
          grade_level: string | null;
          amount: string;
          academic_year_id: string;
          is_active: boolean;
        }>
      >(
        'SELECT id, name, grade_level, amount::text, academic_year_id, is_active ' +
          'FROM pay_fee_schedules WHERE id = $1::uuid',
        body.feeScheduleId,
      );
    });
    if (scheduleRows.length === 0) {
      throw new NotFoundException('Fee schedule ' + body.feeScheduleId + ' not found');
    }
    var schedule = scheduleRows[0]!;
    if (!schedule.is_active) {
      throw new BadRequestException('Fee schedule is inactive; activate it before generating');
    }

    // Find all (family_account, student) pairs eligible for billing
    // under this schedule. NULL grade_level means all grades.
    var pairs = await this.tenantPrisma.executeInTenantContext(async (client) => {
      var sql =
        'SELECT fa.id AS family_account_id, fa.account_holder_id, ' +
        's.id AS student_id, ps.first_name, ps.last_name, s.grade_level ' +
        'FROM pay_family_accounts fa ' +
        'JOIN pay_family_account_students l ON l.family_account_id = fa.id ' +
        'JOIN sis_students s ON s.id = l.student_id ' +
        'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
        "WHERE fa.status = 'ACTIVE' ";
      var params: any[] = [];
      var idx = 1;
      if (schedule.grade_level) {
        sql += 'AND s.grade_level = $' + idx + ' ';
        params.push(schedule.grade_level);
        idx++;
      }
      sql += 'ORDER BY fa.id';
      return client.$queryRawUnsafe<
        Array<{
          family_account_id: string;
          account_holder_id: string;
          student_id: string;
          first_name: string;
          last_name: string;
          grade_level: string;
        }>
      >(sql, ...params);
    });

    var grouped: Record<string, typeof pairs> = {};
    for (var i = 0; i < pairs.length; i++) {
      var pp = pairs[i]!;
      if (!grouped[pp.family_account_id]) grouped[pp.family_account_id] = [];
      grouped[pp.family_account_id]!.push(pp);
    }

    // REVIEW-CYCLE6 fix 8: existence-check + INSERT happen in the SAME
    // transaction, gated by a per-(family, fee_schedule) advisory lock.
    // Two simultaneous bulk-generates targeting the same fee schedule
    // serialise on the lock; the second tx re-reads the existence row,
    // sees the first's invoice, and bumps `skipped`. Without the lock,
    // both reads could miss and both INSERT, creating duplicate DRAFT
    // invoices for the same family + schedule.
    var invoiceIds: string[] = [];
    var skipped = 0;
    var familyIds = Object.keys(grouped);
    for (var fi = 0; fi < familyIds.length; fi++) {
      var familyAccountId = familyIds[fi]!;
      var students = grouped[familyAccountId]!;
      var unitPrice = Number(schedule.amount);
      var totalAmount = Number((unitPrice * students.length).toFixed(2));
      var newInvoiceId = generateId();
      var inserted = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
        await tx.$executeRawUnsafe(
          "SELECT pg_advisory_xact_lock(hashtext('pay_invoices_generate:' || $1::text || ':' || $2::text))",
          familyAccountId,
          body.feeScheduleId,
        );
        var existingTx = (await tx.$queryRawUnsafe(
          'SELECT i.id FROM pay_invoices i ' +
            'JOIN pay_invoice_line_items li ON li.invoice_id = i.id ' +
            "WHERE i.family_account_id = $1::uuid AND li.fee_schedule_id = $2::uuid AND i.status <> 'CANCELLED' LIMIT 1",
          familyAccountId,
          body.feeScheduleId,
        )) as Array<{ id: string }>;
        if (existingTx.length > 0) {
          return false;
        }
        await tx.$executeRawUnsafe(
          'INSERT INTO pay_invoices (id, school_id, family_account_id, title, description, total_amount, due_date, status) ' +
            "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::numeric, $7::date, 'DRAFT')",
          newInvoiceId,
          schoolId,
          familyAccountId,
          body.title ?? schedule.name,
          'Auto-generated from fee schedule "' + schedule.name + '"',
          totalAmount.toFixed(2),
          body.dueDate ?? null,
        );
        for (var sj = 0; sj < students.length; sj++) {
          var st = students[sj]!;
          await tx.$executeRawUnsafe(
            'INSERT INTO pay_invoice_line_items (id, invoice_id, fee_schedule_id, description, quantity, unit_price, total, sort_order) ' +
              'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::numeric, $6::numeric, $7::numeric, $8::int)',
            generateId(),
            newInvoiceId,
            body.feeScheduleId,
            schedule.name + ' — ' + st.first_name + ' ' + st.last_name,
            '1.00',
            unitPrice.toFixed(2),
            unitPrice.toFixed(2),
            sj,
          );
        }
        return true;
      });
      if (inserted) {
        invoiceIds.push(newInvoiceId);
      } else {
        skipped++;
      }
    }

    return {
      feeScheduleId: body.feeScheduleId,
      created: invoiceIds.length,
      skipped: skipped,
      invoiceIds: invoiceIds,
    };
  }

  private async loadLineItems(invoiceIds: string[]): Promise<LineItemRow[]> {
    if (invoiceIds.length === 0) return [];
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      var placeholders = invoiceIds
        .map((_: string, i: number) => '$' + (i + 1) + '::uuid')
        .join(',');
      return client.$queryRawUnsafe<LineItemRow[]>(
        'SELECT li.id, li.invoice_id, li.fee_schedule_id, fs.name AS fee_schedule_name, ' +
          'li.description, li.quantity::text, li.unit_price::text, li.total::text, li.sort_order ' +
          'FROM pay_invoice_line_items li ' +
          'LEFT JOIN pay_fee_schedules fs ON fs.id = li.fee_schedule_id ' +
          'WHERE li.invoice_id IN (' +
          placeholders +
          ') ORDER BY li.invoice_id, li.sort_order',
        ...invoiceIds,
      );
    });
  }

  private async isAccountHolder(familyAccountId: string, personId: string): Promise<boolean> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ holder: string }>>(
        'SELECT account_holder_id::text AS holder FROM pay_family_accounts WHERE id = $1::uuid',
        familyAccountId,
      );
    });
    return rows.length > 0 && rows[0]!.holder === personId;
  }
}
