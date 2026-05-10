import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { AllocatePaymentDto, PaymentAllocationResponseDto } from './dto/billing-ops.dto';

interface AllocationRow {
  id: string;
  school_id: string;
  payment_id: string;
  invoice_id: string;
  invoice_title: string | null;
  allocated_amount: string;
  allocated_by: string | null;
  allocated_at: string;
}

const SELECT_BASE =
  'SELECT a.id, a.school_id, a.payment_id, a.invoice_id, i.title AS invoice_title, ' +
  'a.allocated_amount::text, a.allocated_by, a.allocated_at ' +
  'FROM pay_payment_allocations a LEFT JOIN pay_invoices i ON i.id = a.invoice_id ';

function rowToDto(r: AllocationRow): PaymentAllocationResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    paymentId: r.payment_id,
    invoiceId: r.invoice_id,
    invoiceTitle: r.invoice_title,
    allocatedAmount: Number(r.allocated_amount),
    allocatedBy: r.allocated_by,
    allocatedAt: r.allocated_at,
  };
}

/**
 * PaymentAllocationService — Phase 2 Cycle 6 (P2-6).
 *
 * Distributes a single payment across one or more invoices. Common
 * scenario: a parent pays $500 toward a $300 invoice and a $200
 * invoice in one transaction. The allocation rows track the split.
 *
 * allocate() runs inside one tenant tx that:
 *   1. Locks the payment row FOR UPDATE.
 *   2. Validates SUM(allocated_amount) equals payment.amount.
 *   3. Validates each invoice belongs to the same family account.
 *   4. INSERTs allocation rows. UNIQUE(payment_id, invoice_id)
 *      catches duplicates.
 *
 * Authorisation: admin only (this is operational tooling).
 */
@Injectable()
export class PaymentAllocationService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async listForPayment(
    paymentId: string,
    actor: ResolvedActor,
  ): Promise<PaymentAllocationResponseDto[]> {
    if (!actor.isSchoolAdmin)
      throw new ForbiddenException('Only admins can list payment allocations');
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<AllocationRow[]>(
        SELECT_BASE + 'WHERE a.payment_id = $1::uuid ORDER BY a.allocated_at',
        paymentId,
      ),
    )) as AllocationRow[];
    return rows.map(rowToDto);
  }

  async allocate(
    paymentId: string,
    body: AllocatePaymentDto,
    actor: ResolvedActor,
  ): Promise<PaymentAllocationResponseDto[]> {
    if (!actor.isSchoolAdmin) throw new ForbiddenException('Only admins can allocate payments');
    const total = body.allocations.reduce((sum, a) => sum + a.allocatedAmount, 0);
    const schoolId = getCurrentTenant().schoolId;
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const paymentRows = (await tx.$queryRawUnsafe(
        'SELECT id, school_id, family_account_id, amount::text, status FROM pay_payments WHERE id = $1::uuid FOR UPDATE',
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
      if (payment.school_id !== schoolId)
        throw new ForbiddenException('Payment does not belong to this school');
      const paymentAmount = Number(payment.amount);
      if (Math.abs(total - paymentAmount) > 0.001) {
        throw new BadRequestException(
          'Allocation total $' +
            total.toFixed(2) +
            ' must equal payment amount $' +
            paymentAmount.toFixed(2),
        );
      }

      // Drop any existing allocations for this payment to make the
      // operation idempotent.
      await tx.$executeRawUnsafe(
        'DELETE FROM pay_payment_allocations WHERE payment_id = $1::uuid',
        paymentId,
      );

      for (const a of body.allocations) {
        if (a.allocatedAmount <= 0) {
          throw new BadRequestException('allocatedAmount must be > 0 for invoice ' + a.invoiceId);
        }
        const invoiceRows = (await tx.$queryRawUnsafe(
          'SELECT id, family_account_id FROM pay_invoices WHERE id = $1::uuid',
          a.invoiceId,
        )) as Array<{ id: string; family_account_id: string }>;
        if (invoiceRows.length === 0)
          throw new BadRequestException('Invoice ' + a.invoiceId + ' not found');
        if (invoiceRows[0]!.family_account_id !== payment.family_account_id) {
          throw new BadRequestException(
            'Invoice ' + a.invoiceId + ' does not belong to the same family account as the payment',
          );
        }
        try {
          await tx.$executeRawUnsafe(
            'INSERT INTO pay_payment_allocations (id, school_id, payment_id, invoice_id, allocated_amount, allocated_by) ' +
              'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::numeric, $6::uuid)',
            generateId(),
            schoolId,
            paymentId,
            a.invoiceId,
            a.allocatedAmount.toFixed(2),
            actor.accountId,
          );
        } catch (err) {
          if (err instanceof Error && /pay_payment_alloc_pay_inv_uq|23505/.test(err.message)) {
            throw new BadRequestException(
              'Duplicate allocation for payment + invoice pair (' +
                paymentId +
                ', ' +
                a.invoiceId +
                ')',
            );
          }
          throw err;
        }
      }
    });
    return this.listForPayment(paymentId, actor);
  }
}
