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
  IssueRefundDto,
  ListRefundsQueryDto,
  RefundCategory,
  RefundResponseDto,
  RefundStatus,
} from './dto/refund.dto';

interface RefundRow {
  id: string;
  school_id: string;
  payment_id: string;
  family_account_id: string;
  amount: string;
  refund_category: string;
  reason: string;
  stripe_refund_id: string | null;
  status: string;
  authorised_by: string;
  authorised_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToDto(r: RefundRow): RefundResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    paymentId: r.payment_id,
    familyAccountId: r.family_account_id,
    amount: Number(r.amount),
    refundCategory: r.refund_category as RefundCategory,
    reason: r.reason,
    stripeRefundId: r.stripe_refund_id,
    status: r.status as RefundStatus,
    authorisedBy: r.authorised_by,
    authorisedAt: r.authorised_at,
    completedAt: r.completed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

var SELECT_REFUND_BASE =
  'SELECT id, school_id, payment_id, family_account_id, amount::text, refund_category, reason, ' +
  'stripe_refund_id, status, authorised_by, authorised_at, completed_at, created_at, updated_at ' +
  'FROM pay_refunds ';

@Injectable()
export class RefundService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
    private readonly ledger: LedgerService,
  ) {}

  async list(query: ListRefundsQueryDto, actor: ResolvedActor): Promise<RefundResponseDto[]> {
    if (!actor.isSchoolAdmin) {
      // Refunds are admin-only at the read tier — parents see their refund
      // back as a REFUND ledger entry, not as a separate refund row in the
      // parent UI.
      throw new ForbiddenException('Only admins can list refunds');
    }
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      var sql = SELECT_REFUND_BASE + 'WHERE 1=1 ';
      var params: any[] = [];
      var idx = 1;
      if (query.familyAccountId) {
        sql += 'AND family_account_id = $' + idx + '::uuid ';
        params.push(query.familyAccountId);
        idx++;
      }
      if (query.paymentId) {
        sql += 'AND payment_id = $' + idx + '::uuid ';
        params.push(query.paymentId);
        idx++;
      }
      if (query.status) {
        sql += 'AND status = $' + idx + ' ';
        params.push(query.status);
        idx++;
      }
      sql += 'ORDER BY created_at DESC';
      return client.$queryRawUnsafe<RefundRow[]>(sql, ...params);
    });
    return rows.map(rowToDto);
  }

  /**
   * Issue a refund against a completed payment. Admin-only. Locks the
   * payment row FOR UPDATE inside the same tx that:
   *   - inserts the pay_refunds row (authorised_by + authorised_at NOT
   *     NULL on creation under the schema CHECK),
   *   - writes the REFUND ledger entry (positive amount — restores
   *     balance owed back to the family),
   *   - in dev mode marks the refund COMPLETED immediately and flips
   *     the parent payment status to REFUNDED if the refund covers the
   *     full payment amount,
   *   - emits pay.refund.issued.
   *
   * Stripe is stubbed — Real refund processing creates a PENDING row
   * and a Stripe Refund object, then a webhook flips status COMPLETED.
   */
  async issue(
    paymentId: string,
    body: IssueRefundDto,
    actor: ResolvedActor,
  ): Promise<RefundResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can issue refunds');
    }
    if (body.amount <= 0) {
      throw new BadRequestException('amount must be > 0');
    }
    var schoolId = getCurrentTenant().schoolId;
    var refundId = generateId();
    var snapshot = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      var rows = (await tx.$queryRawUnsafe(
        'SELECT id, family_account_id, amount::text, status FROM pay_payments WHERE id = $1::uuid FOR UPDATE',
        paymentId,
      )) as Array<{
        id: string;
        family_account_id: string;
        amount: string;
        status: string;
      }>;
      if (rows.length === 0) {
        throw new NotFoundException('Payment ' + paymentId + ' not found');
      }
      var pay = rows[0]!;
      if (pay.status !== 'COMPLETED') {
        throw new BadRequestException(
          'Cannot refund payment in status ' +
            pay.status +
            '; only COMPLETED payments are refundable',
        );
      }
      var paymentAmount = Number(pay.amount);
      // Sum any prior refunds against this payment so partial refunds
      // can't accidentally over-refund.
      var priorRows = (await tx.$queryRawUnsafe(
        "SELECT COALESCE(SUM(amount), 0)::text AS prior FROM pay_refunds WHERE payment_id = $1::uuid AND status IN ('PENDING','COMPLETED')",
        paymentId,
      )) as Array<{ prior: string }>;
      var priorRefunded = Number(priorRows[0]?.prior ?? '0');
      var refundable = Number((paymentAmount - priorRefunded).toFixed(2));
      if (body.amount > refundable + 0.001) {
        throw new BadRequestException(
          'Refund amount $' +
            body.amount.toFixed(2) +
            ' exceeds remaining refundable $' +
            refundable.toFixed(2),
        );
      }

      // Stripe stubbed — emit a mock re_dev_<uuid> id and mark the
      // refund COMPLETED immediately so the ledger reflects the cash
      // flow.
      var stripeRefundId = 're_dev_' + refundId.replace(/-/g, '').substring(0, 24);
      await tx.$executeRawUnsafe(
        'INSERT INTO pay_refunds (id, school_id, payment_id, family_account_id, amount, refund_category, reason, stripe_refund_id, status, authorised_by, authorised_at, completed_at) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::numeric, $6, $7, $8, 'COMPLETED', $9::uuid, now(), now())",
        refundId,
        schoolId,
        paymentId,
        pay.family_account_id,
        body.amount.toFixed(2),
        body.refundCategory,
        body.reason,
        stripeRefundId,
        actor.accountId,
      );

      // REFUND ledger entry: positive amount restores balance owed.
      await this.ledger.recordEntry(tx, {
        familyAccountId: pay.family_account_id,
        entryType: 'REFUND',
        amount: body.amount,
        referenceId: refundId,
        description: 'REFUND: ' + body.refundCategory + ' — ' + body.reason,
        createdBy: actor.accountId,
      });

      // If the refund covers the full payment, flip the payment to
      // REFUNDED. Partial refunds leave the payment as COMPLETED — the
      // sum-of-refunds query is the source of truth for "remaining
      // refundable" on subsequent attempts.
      var newRefunded = Number((priorRefunded + body.amount).toFixed(2));
      if (newRefunded >= paymentAmount - 0.001) {
        await tx.$executeRawUnsafe(
          "UPDATE pay_payments SET status = 'REFUNDED', updated_at = now() WHERE id = $1::uuid",
          paymentId,
        );
      }

      return {
        familyAccountId: pay.family_account_id,
        paymentAmount: paymentAmount,
        refundedAfter: newRefunded,
      };
    });

    var dto = await this.getById(refundId);
    void this.kafka.emit({
      topic: 'pay.refund.issued',
      key: refundId,
      sourceModule: 'payments',
      payload: {
        refundId: refundId,
        paymentId: paymentId,
        familyAccountId: snapshot.familyAccountId,
        amount: dto.amount,
        refundCategory: dto.refundCategory,
        reason: dto.reason,
        status: dto.status,
        authorisedBy: actor.accountId,
        completedAt: dto.completedAt,
      },
    });
    return dto;
  }

  async getById(id: string): Promise<RefundResponseDto> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<RefundRow[]>(SELECT_REFUND_BASE + 'WHERE id = $1::uuid', id);
    });
    if (rows.length === 0) throw new NotFoundException('Refund ' + id + ' not found');
    return rowToDto(rows[0]!);
  }
}
