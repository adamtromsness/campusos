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
  ListPaymentsQueryDto,
  PayInvoiceDto,
  PaymentMethod,
  PaymentResponseDto,
  PaymentStatus,
} from './dto/payment.dto';

interface PaymentRow {
  id: string;
  school_id: string;
  invoice_id: string;
  invoice_title: string;
  family_account_id: string;
  family_account_number: string;
  amount: string;
  payment_method: string;
  stripe_payment_intent_id: string | null;
  status: string;
  paid_at: string | null;
  receipt_s3_key: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function rowToDto(r: PaymentRow): PaymentResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    invoiceId: r.invoice_id,
    invoiceTitle: r.invoice_title,
    familyAccountId: r.family_account_id,
    familyAccountNumber: r.family_account_number,
    amount: Number(r.amount),
    paymentMethod: r.payment_method as PaymentMethod,
    stripePaymentIntentId: r.stripe_payment_intent_id,
    status: r.status as PaymentStatus,
    paidAt: r.paid_at,
    receiptS3Key: r.receipt_s3_key,
    notes: r.notes,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

var SELECT_PAYMENT_BASE =
  'SELECT p.id, p.school_id, p.invoice_id, i.title AS invoice_title, ' +
  'p.family_account_id, fa.account_number AS family_account_number, ' +
  'p.amount::text, p.payment_method, p.stripe_payment_intent_id, p.status, p.paid_at, ' +
  'p.receipt_s3_key, p.notes, p.created_by, p.created_at, p.updated_at ' +
  'FROM pay_payments p ' +
  'JOIN pay_invoices i ON i.id = p.invoice_id ' +
  'JOIN pay_family_accounts fa ON fa.id = p.family_account_id ';

@Injectable()
export class PaymentService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
    private readonly ledger: LedgerService,
  ) {}

  async list(
    query: ListPaymentsQueryDto,
    actor: ResolvedActor,
  ): Promise<PaymentResponseDto[]> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      var sql = SELECT_PAYMENT_BASE + 'WHERE 1=1 ';
      var params: any[] = [];
      var idx = 1;
      if (!actor.isSchoolAdmin) {
        if (actor.personType !== 'GUARDIAN') return [] as PaymentRow[];
        sql += 'AND fa.account_holder_id = $' + idx + '::uuid ';
        params.push(actor.personId);
        idx++;
      }
      if (query.familyAccountId) {
        sql += 'AND p.family_account_id = $' + idx + '::uuid ';
        params.push(query.familyAccountId);
        idx++;
      }
      if (query.invoiceId) {
        sql += 'AND p.invoice_id = $' + idx + '::uuid ';
        params.push(query.invoiceId);
        idx++;
      }
      if (query.status) {
        sql += 'AND p.status = $' + idx + ' ';
        params.push(query.status);
        idx++;
      }
      sql += 'ORDER BY p.created_at DESC';
      return client.$queryRawUnsafe<PaymentRow[]>(sql, ...params);
    });
    return rows.map(rowToDto);
  }

  async getById(id: string, actor: ResolvedActor): Promise<PaymentResponseDto> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<PaymentRow[]>(
        SELECT_PAYMENT_BASE + 'WHERE p.id = $1::uuid',
        id,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Payment ' + id + ' not found');
    var row = rows[0]!;
    if (!actor.isSchoolAdmin) {
      var owns = await this.isAccountHolder(row.family_account_id, actor.personId);
      if (actor.personType !== 'GUARDIAN' || !owns) {
        throw new NotFoundException('Payment ' + id + ' not found');
      }
    }
    return rowToDto(row);
  }

  /**
   * Pay an invoice. Locks the invoice row FOR UPDATE inside the same tx
   * that writes the payment + PAYMENT ledger entry + invoice status
   * flip — concurrent payments serialise on the row lock and the
   * second attempt re-reads the new amount_paid before deciding the
   * status (PARTIAL vs PAID).
   *
   * Stripe is stubbed in Cycle 6 — CARD payments mark COMPLETED
   * immediately with a mock pi_dev_<uuid> intent id. Real Stripe
   * wiring (PaymentIntent confirmation, webhook handling, capture
   * timing) is Phase 3 ops work.
   *
   * Authorisation: parent (account holder) OR admin can pay. The
   * pay_family_accounts.payment_authorisation_policy column controls
   * whether non-account-holder authorised guardians can also pay; for
   * Cycle 6 we honour ACCOUNT_HOLDER_ONLY only — ANY_AUTHORISED is
   * treated like ACCOUNT_HOLDER_ONLY since the future
   * sis_student_guardians.portal_access linkage isn't wired into the
   * payment auth check yet.
   */
  async pay(
    invoiceId: string,
    body: PayInvoiceDto,
    actor: ResolvedActor,
  ): Promise<PaymentResponseDto> {
    if (body.amount <= 0) {
      throw new BadRequestException('amount must be > 0');
    }
    var schoolId = getCurrentTenant().schoolId;
    var paymentMethod = body.paymentMethod ?? 'CARD';
    if (!actor.isSchoolAdmin && paymentMethod !== 'CARD' && paymentMethod !== 'BANK_TRANSFER') {
      throw new ForbiddenException(
        'Self-service parent payments accept CARD or BANK_TRANSFER only',
      );
    }

    var snapshot = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      var rows = (await tx.$queryRawUnsafe(
        'SELECT i.id, i.family_account_id, i.total_amount::text, i.status, ' +
          "(COALESCE((SELECT SUM(amount) FROM pay_payments p WHERE p.invoice_id = i.id AND p.status = 'COMPLETED'), 0))::text AS amount_paid, " +
          'fa.account_holder_id, fa.status AS account_status ' +
          'FROM pay_invoices i ' +
          'JOIN pay_family_accounts fa ON fa.id = i.family_account_id ' +
          'WHERE i.id = $1::uuid FOR UPDATE OF i',
        invoiceId,
      )) as Array<{
        id: string;
        family_account_id: string;
        total_amount: string;
        status: string;
        amount_paid: string;
        account_holder_id: string;
        account_status: string;
      }>;
      if (rows.length === 0) {
        throw new NotFoundException('Invoice ' + invoiceId + ' not found');
      }
      var inv = rows[0]!;
      if (!actor.isSchoolAdmin && inv.account_holder_id !== actor.personId) {
        throw new ForbiddenException('Only the account holder can pay this invoice');
      }
      if (inv.account_status !== 'ACTIVE') {
        throw new BadRequestException(
          'Family account is in status ' + inv.account_status + '; cannot collect payments',
        );
      }
      if (inv.status === 'DRAFT') {
        throw new BadRequestException('Invoice has not been sent yet');
      }
      if (inv.status === 'CANCELLED') {
        throw new BadRequestException('Invoice is CANCELLED');
      }
      if (inv.status === 'PAID') {
        throw new BadRequestException('Invoice is already PAID');
      }
      var totalAmount = Number(inv.total_amount);
      var alreadyPaid = Number(inv.amount_paid);
      var balanceDue = Number((totalAmount - alreadyPaid).toFixed(2));
      if (body.amount > balanceDue + 0.001) {
        throw new BadRequestException(
          'Payment amount $' +
            body.amount.toFixed(2) +
            ' exceeds outstanding balance $' +
            balanceDue.toFixed(2),
        );
      }

      var paymentId = generateId();
      var stripeIntentId =
        paymentMethod === 'CARD' ? 'pi_dev_' + paymentId.replace(/-/g, '').substring(0, 24) : null;
      // Stripe is stubbed — in dev mode every CARD payment completes
      // immediately. Real Stripe wiring will create a PENDING row,
      // confirm via webhook, and only then flip to COMPLETED.
      await tx.$executeRawUnsafe(
        'INSERT INTO pay_payments (id, school_id, invoice_id, family_account_id, amount, payment_method, stripe_payment_intent_id, status, paid_at, notes, created_by) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::numeric, $6, $7, 'COMPLETED', now(), $8, $9::uuid)",
        paymentId,
        schoolId,
        invoiceId,
        inv.family_account_id,
        body.amount.toFixed(2),
        paymentMethod,
        stripeIntentId,
        body.notes ?? null,
        actor.accountId,
      );
      await this.ledger.recordEntry(tx, {
        familyAccountId: inv.family_account_id,
        entryType: 'PAYMENT',
        amount: -body.amount,
        referenceId: paymentId,
        description: 'PAYMENT: invoice payment via ' + paymentMethod,
        createdBy: actor.accountId,
      });

      var newPaid = Number((alreadyPaid + body.amount).toFixed(2));
      var newStatus = newPaid >= totalAmount - 0.001 ? 'PAID' : 'PARTIAL';
      await tx.$executeRawUnsafe(
        'UPDATE pay_invoices SET status = $1, updated_at = now() WHERE id = $2::uuid',
        newStatus,
        invoiceId,
      );

      return {
        paymentId: paymentId,
        familyAccountId: inv.family_account_id,
        invoiceStatus: newStatus,
        totalAmount: totalAmount,
        newPaid: newPaid,
      };
    });

    var dto = await this.getById(snapshot.paymentId, actor);
    void this.kafka.emit({
      topic: 'pay.payment.received',
      key: snapshot.paymentId,
      sourceModule: 'payments',
      payload: {
        paymentId: snapshot.paymentId,
        invoiceId: invoiceId,
        familyAccountId: snapshot.familyAccountId,
        amount: dto.amount,
        paymentMethod: dto.paymentMethod,
        invoiceStatus: snapshot.invoiceStatus,
        totalAmount: snapshot.totalAmount,
        amountPaid: snapshot.newPaid,
        paidAt: dto.paidAt,
      },
    });
    return dto;
  }

  private async isAccountHolder(
    familyAccountId: string,
    personId: string,
  ): Promise<boolean> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ holder: string }>>(
        'SELECT account_holder_id::text AS holder FROM pay_family_accounts WHERE id = $1::uuid',
        familyAccountId,
      );
    });
    return rows.length > 0 && rows[0]!.holder === personId;
  }
}
