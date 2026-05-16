import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { getCurrentTenant } from '../tenant/tenant.context';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { assertAcademicYearInCurrentSchool, assertActivityInCurrentSchool } from './access';
import {
  ClubBudgetResponseDto,
  ClubBudgetTransactionResponseDto,
  CreateClubBudgetDto,
  RecordBudgetTransactionDto,
  UpdateClubBudgetDto,
} from './dto/clubs-meetings-advanced.dto';

interface BudgetRow {
  id: string;
  activity_id: string;
  activity_name: string | null;
  academic_year_id: string;
  academic_year_name: string | null;
  allocated_amount: string;
  spent_amount: string;
  approved_by: string | null;
  approved_by_name: string | null;
  approved_at: Date | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

interface TxRow {
  id: string;
  budget_id: string;
  transaction_type: string;
  amount: string;
  description: string;
  receipt_s3_key: string | null;
  recorded_by: string;
  recorded_by_name: string | null;
  created_at: Date;
}

const SELECT_BUDGET =
  'SELECT b.id::text AS id, b.activity_id::text AS activity_id, a.name AS activity_name, ' +
  'b.academic_year_id::text AS academic_year_id, y.name AS academic_year_name, ' +
  'b.allocated_amount::text AS allocated_amount, b.spent_amount::text AS spent_amount, ' +
  'b.approved_by::text AS approved_by, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM hr_employees e " +
  '  JOIN platform.iam_person ip ON ip.id = e.person_id ' +
  '  WHERE e.id = b.approved_by) AS approved_by_name, ' +
  'b.approved_at, b.notes, b.created_at, b.updated_at ' +
  'FROM ext_club_budgets b ' +
  'JOIN ext_activities a ON a.id = b.activity_id ' +
  'JOIN sis_academic_years y ON y.id = b.academic_year_id ';

const SELECT_TX =
  'SELECT t.id::text AS id, t.budget_id::text AS budget_id, ' +
  't.transaction_type, t.amount::text AS amount, t.description, ' +
  't.receipt_s3_key, t.recorded_by::text AS recorded_by, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM hr_employees e " +
  '  JOIN platform.iam_person ip ON ip.id = e.person_id ' +
  '  WHERE e.id = t.recorded_by) AS recorded_by_name, ' +
  't.created_at ' +
  'FROM ext_budget_transactions t ';

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  return (
    e?.code === '23505' || e?.meta?.code === '23505' || /unique constraint/i.test(e?.message ?? '')
  );
}

/**
 * ClubBudgetService — P2-28b Step 4.
 *
 * Per-(activity, academic_year) budget head + per-budget transaction
 * ledger. The keystone is the atomic spent_amount adjustment inside
 * the same tenant tx as the ext_budget_transactions INSERT — the two
 * writes commit together or not at all. remaining_amount is computed
 * at read time as allocated_amount - spent_amount.
 *
 * Authorisation: CLB-001:read for reads; CLB-001:admin for writes
 * (school admin OR clb-001:admin via the controller gate); the
 * service layer additionally refuses STUDENT and GUARDIAN actors so
 * the surface is staff-only.
 */
@Injectable()
export class ClubBudgetService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private assertStaff(actor: ResolvedActor): void {
    if (actor.isSchoolAdmin) return;
    if (actor.personType === 'STUDENT' || actor.personType === 'GUARDIAN') {
      throw new ForbiddenException('Club budget management is staff-only');
    }
    if (!actor.employeeId) {
      throw new ForbiddenException('Staff actor must have an hr_employees row');
    }
  }

  async list(actor: ResolvedActor, activityId?: string): Promise<ClubBudgetResponseDto[]> {
    this.assertStaff(actor);
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      if (activityId) {
        return client.$queryRawUnsafe(
          SELECT_BUDGET +
            'WHERE a.school_id = $1::uuid AND b.activity_id = $2::uuid ORDER BY y.start_date DESC',
          tenant.schoolId,
          activityId,
        );
      }
      return client.$queryRawUnsafe(
        SELECT_BUDGET + 'WHERE a.school_id = $1::uuid ORDER BY y.start_date DESC, a.name ASC',
        tenant.schoolId,
      );
    })) as BudgetRow[];
    return rows.map((r) => this.rowToDto(r));
  }

  async getById(id: string, actor: ResolvedActor): Promise<ClubBudgetResponseDto> {
    this.assertStaff(actor);
    return this.loadOrFail(id);
  }

  private async loadOrFail(id: string): Promise<ClubBudgetResponseDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_BUDGET + 'WHERE b.id = $1::uuid AND a.school_id = $2::uuid',
        id,
        tenant.schoolId,
      );
    })) as BudgetRow[];
    if (rows.length === 0) throw new NotFoundException('Budget not found');
    return this.rowToDto(rows[0]!);
  }

  async create(input: CreateClubBudgetDto, actor: ResolvedActor): Promise<ClubBudgetResponseDto> {
    this.assertStaff(actor);
    if (!actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      throw new ForbiddenException('Only admins or staff can create budgets');
    }
    // REVIEW-P2C28 Round 1 BLOCKING 4 — validate activity and academic
    // year belong to the current school before INSERT.
    await assertActivityInCurrentSchool(this.tenantPrisma, input.activityId);
    await assertAcademicYearInCurrentSchool(this.tenantPrisma, input.academicYearId);
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO ext_club_budgets (id, activity_id, academic_year_id, allocated_amount, spent_amount, approved_by, approved_at, notes) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 0, $5::uuid, now(), $6)',
          id,
          input.activityId,
          input.academicYearId,
          input.allocatedAmount ?? 0,
          actor.employeeId,
          input.notes ?? null,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException(
          'A budget already exists for this (activity, academic year). PATCH the existing budget instead.',
        );
      }
      throw err;
    }
    return this.loadOrFail(id);
  }

  async patch(
    id: string,
    input: UpdateClubBudgetDto,
    actor: ResolvedActor,
  ): Promise<ClubBudgetResponseDto> {
    this.assertStaff(actor);
    // REVIEW-P2C28 Round 1 BLOCKING 4 — load through school-scoped
    // SELECT before patching; cross-school UUIDs collapse to 404.
    await this.loadOrFail(id);
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.allocatedAmount !== undefined) {
      params.push(input.allocatedAmount);
      sets.push('allocated_amount = $' + params.length);
    }
    if (input.notes !== undefined) {
      params.push(input.notes);
      sets.push('notes = $' + params.length);
    }
    if (sets.length === 0) return this.loadOrFail(id);
    sets.push('updated_at = now()');
    const tenant = getCurrentTenant();
    params.push(id);
    const idIdx = params.length;
    params.push(tenant.schoolId);
    const schoolIdx = params.length;
    const result = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$executeRawUnsafe(
        'UPDATE ext_club_budgets b SET ' +
          sets.join(', ') +
          ' FROM ext_activities a WHERE b.activity_id = a.id ' +
          ' AND b.id = $' +
          idIdx +
          '::uuid AND a.school_id = $' +
          schoolIdx +
          '::uuid',
        ...params,
      );
    })) as number;
    if (result === 0) throw new NotFoundException('Budget not found');
    return this.loadOrFail(id);
  }

  /**
   * Keystone — atomic spent_amount adjustment inside the same tenant
   * tx as the ext_budget_transactions INSERT. EXPENSE bumps spent up,
   * REFUND bumps spent down, ALLOCATION bumps allocated_amount,
   * ADJUSTMENT carries the rationale in description. Refuses negative
   * resulting spent (REFUND larger than current spent).
   */
  async recordTransaction(
    budgetId: string,
    input: RecordBudgetTransactionDto,
    actor: ResolvedActor,
  ): Promise<ClubBudgetTransactionResponseDto> {
    this.assertStaff(actor);
    const tenant = getCurrentTenant();
    let txId = '';
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // REVIEW-P2C28 Round 1 BLOCKING 4 — lock through ext_activities
      // so cross-school budget UUIDs collapse to 404 before the
      // UPDATE on spent_amount fires.
      const rows = (await tx.$queryRawUnsafe(
        'SELECT b.id::text AS id, b.allocated_amount::text AS allocated_amount, ' +
          'b.spent_amount::text AS spent_amount ' +
          'FROM ext_club_budgets b JOIN ext_activities a ON a.id = b.activity_id ' +
          'WHERE b.id = $1::uuid AND a.school_id = $2::uuid FOR UPDATE OF b',
        budgetId,
        tenant.schoolId,
      )) as Array<{ id: string; allocated_amount: string; spent_amount: string }>;
      if (rows.length === 0) throw new NotFoundException('Budget not found');
      const current = rows[0]!;
      const currentSpent = Number(current.spent_amount);
      const currentAlloc = Number(current.allocated_amount);

      if (input.transactionType === 'EXPENSE') {
        const newSpent = currentSpent + Number(input.amount);
        if (newSpent > currentAlloc + 0.001) {
          throw new BadRequestException(
            'EXPENSE would exceed allocated. allocated=' +
              currentAlloc +
              ' spent=' +
              currentSpent +
              ' attempted=' +
              input.amount,
          );
        }
        await tx.$executeRawUnsafe(
          'UPDATE ext_club_budgets SET spent_amount = spent_amount + $1, updated_at = now() WHERE id = $2::uuid',
          input.amount,
          budgetId,
        );
      } else if (input.transactionType === 'REFUND') {
        const newSpent = currentSpent - Number(input.amount);
        if (newSpent < -0.001) {
          throw new BadRequestException(
            'REFUND would drive spent_amount negative. spent=' +
              currentSpent +
              ' attempted=' +
              input.amount,
          );
        }
        await tx.$executeRawUnsafe(
          'UPDATE ext_club_budgets SET spent_amount = spent_amount - $1, updated_at = now() WHERE id = $2::uuid',
          input.amount,
          budgetId,
        );
      } else if (input.transactionType === 'ALLOCATION') {
        await tx.$executeRawUnsafe(
          'UPDATE ext_club_budgets SET allocated_amount = allocated_amount + $1, updated_at = now() WHERE id = $2::uuid',
          input.amount,
          budgetId,
        );
      }
      // ADJUSTMENT records the rationale in description without mutating allocated or spent

      txId = generateId();
      await tx.$executeRawUnsafe(
        'INSERT INTO ext_budget_transactions (id, budget_id, transaction_type, amount, description, receipt_s3_key, recorded_by) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid)',
        txId,
        budgetId,
        input.transactionType,
        input.amount,
        input.description,
        input.receiptS3Key ?? null,
        actor.employeeId,
      );
    });
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_TX + 'WHERE t.id = $1::uuid', txId);
    })) as TxRow[];
    return this.txRowToDto(rows[0]!);
  }

  async listTransactions(
    budgetId: string,
    actor: ResolvedActor,
  ): Promise<ClubBudgetTransactionResponseDto[]> {
    this.assertStaff(actor);
    // REVIEW-P2C28 BLOCKING 4 — validate parent budget belongs to
    // current school before listing transactions.
    await this.loadOrFail(budgetId);
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_TX + 'WHERE t.budget_id = $1::uuid ORDER BY t.created_at DESC',
        budgetId,
      );
    })) as TxRow[];
    return rows.map((r) => this.txRowToDto(r));
  }

  private rowToDto(r: BudgetRow): ClubBudgetResponseDto {
    const allocated = Number(r.allocated_amount);
    const spent = Number(r.spent_amount);
    return {
      id: r.id,
      activityId: r.activity_id,
      activityName: r.activity_name,
      academicYearId: r.academic_year_id,
      academicYearName: r.academic_year_name,
      allocatedAmount: allocated,
      spentAmount: spent,
      remainingAmount: Math.round((allocated - spent) * 100) / 100,
      approvedBy: r.approved_by,
      approvedByName: r.approved_by_name,
      approvedAt: r.approved_at ? r.approved_at.toISOString() : null,
      notes: r.notes,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    };
  }

  private txRowToDto(r: TxRow): ClubBudgetTransactionResponseDto {
    return {
      id: r.id,
      budgetId: r.budget_id,
      transactionType: r.transaction_type as 'ALLOCATION' | 'EXPENSE' | 'REFUND' | 'ADJUSTMENT',
      amount: Number(r.amount),
      description: r.description,
      receiptS3Key: r.receipt_s3_key,
      recordedBy: r.recorded_by,
      recordedByName: r.recorded_by_name,
      createdAt: r.created_at.toISOString(),
    };
  }
}
