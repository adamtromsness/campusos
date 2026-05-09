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
import { PermissionCheckService } from '../iam/permission-check.service';
import {
  CreateExpenseClaimDto,
  DecideExpenseClaimDto,
  ExpenseClaimDto,
  ExpenseStatus,
  MarkExpensePaidDto,
} from './dto/appraisals.dto';

interface ClaimRow {
  id: string;
  employee_id: string;
  employee_first: string | null;
  employee_last: string | null;
  school_id: string;
  claim_title: string;
  description: string | null;
  incurred_on: string;
  total_amount: string;
  receipt_s3_keys: string[];
  status: string;
  approved_by: string | null;
  approved_by_first: string | null;
  approved_by_last: string | null;
  approved_at: string | null;
  rejection_reason: string | null;
  paid_at: string | null;
  created_at: string;
}

const SELECT_CLAIM_BASE =
  'SELECT c.id::text AS id, c.employee_id::text AS employee_id, ipe.first_name AS employee_first, ' +
  '       ipe.last_name AS employee_last, c.school_id::text AS school_id, c.claim_title, ' +
  '       c.description, c.incurred_on::text AS incurred_on, c.total_amount::text AS total_amount, ' +
  '       c.receipt_s3_keys, c.status, c.approved_by::text AS approved_by, ' +
  '       ipa.first_name AS approved_by_first, ipa.last_name AS approved_by_last, ' +
  '       c.approved_at::text AS approved_at, c.rejection_reason, ' +
  '       c.paid_at::text AS paid_at, c.created_at::text AS created_at ' +
  'FROM hr_expense_claims c ' +
  'LEFT JOIN hr_employees emp ON emp.id = c.employee_id ' +
  'LEFT JOIN platform.iam_person ipe ON ipe.id = emp.person_id ' +
  'LEFT JOIN hr_employees app ON app.id = c.approved_by ' +
  'LEFT JOIN platform.iam_person ipa ON ipa.id = app.person_id ';

/**
 * Expense claims service — P2-4c PD reimbursement workflow.
 *
 * Self-service path: any employee with HR-012:read+write submits
 * own claim (service binds employee_id to actor.employeeId).
 *
 * Admin path: hr-012:write holders (Staff stand-in for finance
 * officer) approve / reject / mark paid. Multi-column decided_chk
 * lockstep at the schema layer enforces approver fields populated
 * on every terminal status, and rejection_reason populated on
 * REJECTED.
 */
@Injectable()
export class ExpenseClaimService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  async list(
    args: { status?: ExpenseStatus; mine?: boolean },
    actor: ResolvedActor,
  ): Promise<ExpenseClaimDto[]> {
    const tenant = getCurrentTenant();
    const isAdmin = await this.isAdmin(actor);
    const params: unknown[] = [tenant.schoolId];
    let where = 'WHERE c.school_id = $1::uuid';
    if (args.status) {
      params.push(args.status);
      where += ` AND c.status = $${params.length}`;
    }
    // Non-admin: implicit own-only filter. Admin can pass mine=true
    // to see own list; otherwise sees all.
    if (!isAdmin) {
      if (!actor.employeeId) return [];
      params.push(actor.employeeId);
      where += ` AND c.employee_id = $${params.length}::uuid`;
    } else if (args.mine && actor.employeeId) {
      params.push(actor.employeeId);
      where += ` AND c.employee_id = $${params.length}::uuid`;
    }
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_CLAIM_BASE + where + ' ORDER BY c.created_at DESC',
        ...params,
      )) as ClaimRow[];
      return rows.map((r) => this.rowToDto(r));
    });
  }

  async create(input: CreateExpenseClaimDto, actor: ResolvedActor): Promise<ExpenseClaimDto> {
    if (!actor.employeeId) {
      throw new ForbiddenException(
        'Only employees with an hr_employees row can submit expense claims.',
      );
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO hr_expense_claims ' +
          '(id, employee_id, school_id, claim_title, description, incurred_on, ' +
          ' total_amount, receipt_s3_keys) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::date, $7::numeric, $8)',
        id,
        actor.employeeId,
        tenant.schoolId,
        input.claimTitle,
        input.description ?? null,
        input.incurredOn,
        input.totalAmount,
        input.receiptS3Keys ?? [],
      );
      const rows = (await tx.$queryRawUnsafe(
        SELECT_CLAIM_BASE + 'WHERE c.id = $1::uuid LIMIT 1',
        id,
      )) as ClaimRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  async decide(
    id: string,
    input: DecideExpenseClaimDto,
    actor: ResolvedActor,
  ): Promise<ExpenseClaimDto> {
    await this.assertAdmin(actor);
    if (!actor.employeeId) {
      throw new ForbiddenException(
        'Only employees with an hr_employees row can approve expense claims.',
      );
    }
    if (input.decision === 'REJECTED') {
      if (!input.rejectionReason || input.rejectionReason.trim() === '') {
        throw new BadRequestException('rejectionReason is required when REJECTED.');
      }
    }
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id, status FROM hr_expense_claims ' +
          'WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        id,
      )) as Array<{ id: string; status: string }>;
      if (lock.length === 0) throw new NotFoundException('Expense claim not found');
      const cur = lock[0]!.status as ExpenseStatus;
      if (cur !== 'SUBMITTED') {
        throw new BadRequestException(
          `Only SUBMITTED claims can be decided (current status: ${cur}).`,
        );
      }
      await tx.$executeRawUnsafe(
        'UPDATE hr_expense_claims SET status = $1, approved_by = $2::uuid, approved_at = now(), ' +
          'rejection_reason = $3, updated_at = now() WHERE id = $4::uuid',
        input.decision,
        actor.employeeId,
        input.decision === 'REJECTED' ? (input.rejectionReason ?? null) : null,
        id,
      );
      const rows = (await tx.$queryRawUnsafe(
        SELECT_CLAIM_BASE + 'WHERE c.id = $1::uuid LIMIT 1',
        id,
      )) as ClaimRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  async markPaid(
    id: string,
    input: MarkExpensePaidDto,
    actor: ResolvedActor,
  ): Promise<ExpenseClaimDto> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id, status FROM hr_expense_claims ' +
          'WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        id,
      )) as Array<{ id: string; status: string }>;
      if (lock.length === 0) throw new NotFoundException('Expense claim not found');
      const cur = lock[0]!.status as ExpenseStatus;
      if (cur !== 'APPROVED') {
        throw new BadRequestException(
          `Only APPROVED claims can be marked paid (current status: ${cur}).`,
        );
      }
      const paidAt = input.paidAt ?? new Date().toISOString();
      await tx.$executeRawUnsafe(
        "UPDATE hr_expense_claims SET status = 'PAID', paid_at = $1::timestamptz, updated_at = now() " +
          'WHERE id = $2::uuid',
        paidAt,
        id,
      );
      const rows = (await tx.$queryRawUnsafe(
        SELECT_CLAIM_BASE + 'WHERE c.id = $1::uuid LIMIT 1',
        id,
      )) as ClaimRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  private async assertAdmin(actor: ResolvedActor): Promise<void> {
    if (await this.isAdmin(actor)) return;
    throw new ForbiddenException('Approving expense claims requires hr-012:write or school admin.');
  }

  private async isAdmin(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'hr-012:admin',
      // hr-012:write is held by both teachers (self-submit) and
      // staff (approve), so admin authority comes from
      // isSchoolAdmin OR hr-012:admin specifically. The catalogue
      // grants hr-012:admin only via everyFunction.
    ]);
  }

  private rowToDto(r: ClaimRow): ExpenseClaimDto {
    return {
      id: r.id,
      employeeId: r.employee_id,
      employeeName:
        r.employee_first || r.employee_last
          ? [r.employee_first, r.employee_last].filter(Boolean).join(' ')
          : null,
      schoolId: r.school_id,
      claimTitle: r.claim_title,
      description: r.description,
      incurredOn: r.incurred_on,
      totalAmount: Number(r.total_amount),
      receiptS3Keys: r.receipt_s3_keys ?? [],
      status: r.status as ExpenseStatus,
      approvedBy: r.approved_by,
      approvedByName:
        r.approved_by_first || r.approved_by_last
          ? [r.approved_by_first, r.approved_by_last].filter(Boolean).join(' ')
          : null,
      approvedAt: r.approved_at,
      rejectionReason: r.rejection_reason,
      paidAt: r.paid_at,
      createdAt: r.created_at,
    };
  }
}
