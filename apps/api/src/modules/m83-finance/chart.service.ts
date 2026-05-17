import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import type {
  ChartAccountDto,
  CreateChartAccountDto,
  CreateFundDto,
  CreatePeriodDto,
  CreatePeriodSeriesDto,
  FundDto,
  PeriodDto,
  PeriodStatus,
  TrialBalanceLineDto,
  TrialBalanceResponseDto,
  UpdateChartAccountDto,
  UpdateFundDto,
  UpdatePeriodStatusDto,
} from './dto/finance.dto';

export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e?.code === 'P2002') return true;
  if (e?.code === 'P2010' && e?.meta?.code === '23505') return true;
  if (typeof e?.message === 'string' && e.message.includes('23505')) return true;
  return false;
}

interface FundRow {
  id: string;
  school_id: string;
  fund_code: string;
  fund_name: string;
  fund_type: string;
  description: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface AccountRow {
  id: string;
  school_id: string;
  account_code: string;
  account_name: string;
  account_type: string;
  normal_balance: string;
  parent_account_id: string | null;
  parent_account_code: string | null;
  fund_id: string | null;
  fund_code: string | null;
  description: string | null;
  is_system: boolean;
  is_active: boolean;
  running_balance: string | number | null;
  created_at: string;
  updated_at: string;
}

interface PeriodRow {
  id: string;
  school_id: string;
  fiscal_year: string;
  period_number: number;
  period_name: string;
  start_date: string;
  end_date: string;
  status: string;
  closed_at: string | null;
  closed_by: string | null;
  locked_at: string | null;
  locked_by: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_ACCOUNT_BASE = `
  SELECT a.id::text AS id,
         a.school_id::text AS school_id,
         a.account_code,
         a.account_name,
         a.account_type,
         a.normal_balance,
         a.parent_account_id::text AS parent_account_id,
         pa.account_code AS parent_account_code,
         a.fund_id::text AS fund_id,
         f.fund_code AS fund_code,
         a.description,
         a.is_system,
         a.is_active,
         (SELECT COALESCE(SUM(e.debit) - SUM(e.credit), 0)
            FROM fin_gl_entries e
            JOIN fin_journal_batches b ON b.id = e.batch_id
            WHERE e.account_id = a.id AND b.status = 'POSTED') AS running_balance,
         a.created_at::text AS created_at,
         a.updated_at::text AS updated_at
  FROM fin_chart_of_accounts a
  LEFT JOIN fin_chart_of_accounts pa ON pa.id = a.parent_account_id
  LEFT JOIN fin_funds f ON f.id = a.fund_id
`;

@Injectable()
export class FundService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private rowToDto(r: FundRow): FundDto {
    return {
      id: r.id,
      schoolId: r.school_id,
      fundCode: r.fund_code,
      fundName: r.fund_name,
      fundType: r.fund_type as FundDto['fundType'],
      description: r.description,
      isActive: r.is_active,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  async list(): Promise<FundDto[]> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id, fund_code, fund_name, fund_type, description, is_active, created_at::text AS created_at, updated_at::text AS updated_at FROM fin_funds WHERE school_id = $1::uuid ORDER BY fund_code`,
        tenant.schoolId,
      );
    })) as FundRow[];
    return rows.map((r) => this.rowToDto(r));
  }

  async getById(id: string): Promise<FundDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id, fund_code, fund_name, fund_type, description, is_active, created_at::text AS created_at, updated_at::text AS updated_at FROM fin_funds WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
        id,
        tenant.schoolId,
      );
    })) as FundRow[];
    if (rows.length === 0) throw new NotFoundException('Fund not found');
    return this.rowToDto(rows[0]!);
  }

  async create(actor: ResolvedActor, input: CreateFundDto): Promise<FundDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only school admins can create funds');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          `INSERT INTO fin_funds (id, school_id, fund_code, fund_name, fund_type, description) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)`,
          id,
          tenant.schoolId,
          input.fundCode,
          input.fundName,
          input.fundType,
          input.description ?? null,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(`A fund with code '${input.fundCode}' already exists`);
      }
      throw err;
    }
    return this.getById(id);
  }

  async patch(actor: ResolvedActor, id: string, input: UpdateFundDto): Promise<FundDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only school admins can update funds');
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    if (input.fundName !== undefined) {
      sets.push(`fund_name = $${i++}`);
      params.push(input.fundName);
    }
    if (input.description !== undefined) {
      sets.push(`description = $${i++}`);
      params.push(input.description);
    }
    if (input.isActive !== undefined) {
      sets.push(`is_active = $${i++}`);
      params.push(input.isActive);
    }
    if (sets.length === 0) return this.getById(id);
    sets.push(`updated_at = now()`);
    params.push(id);
    const tenant = getCurrentTenant();
    params.push(tenant.schoolId);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        `UPDATE fin_funds SET ${sets.join(', ')} WHERE id = $${i++}::uuid AND school_id = $${i}::uuid`,
        ...params,
      );
    });
    return this.getById(id);
  }
}

@Injectable()
export class ChartOfAccountsService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private rowToDto(r: AccountRow): ChartAccountDto {
    return {
      id: r.id,
      schoolId: r.school_id,
      accountCode: r.account_code,
      accountName: r.account_name,
      accountType: r.account_type as ChartAccountDto['accountType'],
      normalBalance: r.normal_balance as ChartAccountDto['normalBalance'],
      parentAccountId: r.parent_account_id,
      parentAccountCode: r.parent_account_code,
      fundId: r.fund_id,
      fundCode: r.fund_code,
      description: r.description,
      isSystem: r.is_system,
      isActive: r.is_active,
      runningBalance: Number(r.running_balance ?? 0),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  async list(includeInactive = false): Promise<ChartAccountDto[]> {
    const tenant = getCurrentTenant();
    const where = includeInactive ? '' : ' AND a.is_active = true';
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_ACCOUNT_BASE + ` WHERE a.school_id = $1::uuid${where} ORDER BY a.account_code`,
        tenant.schoolId,
      );
    })) as AccountRow[];
    return rows.map((r) => this.rowToDto(r));
  }

  async getById(id: string): Promise<ChartAccountDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_ACCOUNT_BASE + ` WHERE a.id = $1::uuid AND a.school_id = $2::uuid LIMIT 1`,
        id,
        tenant.schoolId,
      );
    })) as AccountRow[];
    if (rows.length === 0) throw new NotFoundException('Account not found');
    return this.rowToDto(rows[0]!);
  }

  async create(actor: ResolvedActor, input: CreateChartAccountDto): Promise<ChartAccountDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only school admins can create chart of accounts entries');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          `INSERT INTO fin_chart_of_accounts (id, school_id, account_code, account_name, account_type, normal_balance, parent_account_id, fund_id, description, is_system) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid, $8::uuid, $9, $10)`,
          id,
          tenant.schoolId,
          input.accountCode,
          input.accountName,
          input.accountType,
          input.normalBalance,
          input.parentAccountId ?? null,
          input.fundId ?? null,
          input.description ?? null,
          input.isSystem ?? false,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          `An account with code '${input.accountCode}' already exists in this school`,
        );
      }
      throw err;
    }
    return this.getById(id);
  }

  async patch(
    actor: ResolvedActor,
    id: string,
    input: UpdateChartAccountDto,
  ): Promise<ChartAccountDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only school admins can update chart of accounts entries');
    }
    const tenant = getCurrentTenant();
    // REVIEW-CYCLE26 MAJOR 7 — is_system accounts (Cash 1000, AR
    // 1100, AP 2000) are protected control accounts. Restrict edits
    // to description-only — name / parent / fund / isActive must
    // not change without an explicit migration path. The seed marks
    // the canonical accounts is_system=true; all other accounts
    // remain freely editable.
    const targetRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT is_system FROM fin_chart_of_accounts WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
        id,
        tenant.schoolId,
      );
    })) as Array<{ is_system: boolean }>;
    if (targetRows.length === 0) throw new NotFoundException('Account not found');
    if (targetRows[0]!.is_system) {
      const restricted: string[] = [];
      if (input.accountName !== undefined) restricted.push('accountName');
      if (input.isActive !== undefined) restricted.push('isActive');
      if (input.parentAccountId !== undefined) restricted.push('parentAccountId');
      if (input.fundId !== undefined) restricted.push('fundId');
      if (restricted.length > 0) {
        throw new BadRequestException(
          `System accounts (Cash, AR, AP) only accept description updates. The following fields are restricted: ${restricted.join(', ')}.`,
        );
      }
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    if (input.accountName !== undefined) {
      sets.push(`account_name = $${i++}`);
      params.push(input.accountName);
    }
    if (input.description !== undefined) {
      sets.push(`description = $${i++}`);
      params.push(input.description);
    }
    if (input.isActive !== undefined) {
      sets.push(`is_active = $${i++}`);
      params.push(input.isActive);
    }
    if (input.parentAccountId !== undefined) {
      sets.push(`parent_account_id = $${i++}::uuid`);
      params.push(input.parentAccountId);
    }
    if (input.fundId !== undefined) {
      sets.push(`fund_id = $${i++}::uuid`);
      params.push(input.fundId);
    }
    if (sets.length === 0) return this.getById(id);
    sets.push(`updated_at = now()`);
    params.push(id);
    params.push(tenant.schoolId);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        `UPDATE fin_chart_of_accounts SET ${sets.join(', ')} WHERE id = $${i++}::uuid AND school_id = $${i}::uuid`,
        ...params,
      );
    });
    return this.getById(id);
  }

  async trialBalance(periodId?: string): Promise<TrialBalanceResponseDto> {
    const tenant = getCurrentTenant();
    const periodFilter = periodId ? ` AND b.accounting_period_id = $2::uuid` : '';
    const params: unknown[] = [tenant.schoolId];
    if (periodId) params.push(periodId);
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT a.id::text AS account_id,
                a.account_code,
                a.account_name,
                a.account_type,
                a.normal_balance,
                COALESCE(posted.debit_total, 0) AS debit_total,
                COALESCE(posted.credit_total, 0) AS credit_total
           FROM fin_chart_of_accounts a
           LEFT JOIN (
             SELECT e.account_id,
                    SUM(e.debit) AS debit_total,
                    SUM(e.credit) AS credit_total
             FROM fin_gl_entries e
             JOIN fin_journal_batches b ON b.id = e.batch_id
             WHERE b.status = 'POSTED'${periodFilter}
             GROUP BY e.account_id
           ) posted ON posted.account_id = a.id
           WHERE a.school_id = $1::uuid
           ORDER BY a.account_code`,
        ...params,
      );
    })) as Array<{
      account_id: string;
      account_code: string;
      account_name: string;
      account_type: string;
      normal_balance: string;
      debit_total: string | number;
      credit_total: string | number;
    }>;

    const lines: TrialBalanceLineDto[] = [];
    let totalDebit = 0;
    let totalCredit = 0;
    for (const r of rows) {
      const dt = Number(r.debit_total);
      const ct = Number(r.credit_total);
      const balance = r.normal_balance === 'DEBIT' ? dt - ct : ct - dt; // signed by normal balance
      totalDebit += dt;
      totalCredit += ct;
      lines.push({
        accountId: r.account_id,
        accountCode: r.account_code,
        accountName: r.account_name,
        accountType: r.account_type as TrialBalanceLineDto['accountType'],
        normalBalance: r.normal_balance as TrialBalanceLineDto['normalBalance'],
        debitTotal: dt,
        creditTotal: ct,
        balance,
      });
    }
    return {
      lines,
      totalDebit: Math.round(totalDebit * 100) / 100,
      totalCredit: Math.round(totalCredit * 100) / 100,
      balanced: Math.abs(totalDebit - totalCredit) < 0.005,
    };
  }
}

@Injectable()
export class PeriodService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private rowToDto(r: PeriodRow): PeriodDto {
    return {
      id: r.id,
      schoolId: r.school_id,
      fiscalYear: r.fiscal_year,
      periodNumber: Number(r.period_number),
      periodName: r.period_name,
      startDate: r.start_date,
      endDate: r.end_date,
      status: r.status as PeriodStatus,
      closedAt: r.closed_at,
      closedBy: r.closed_by,
      lockedAt: r.locked_at,
      lockedBy: r.locked_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private async load(id: string): Promise<PeriodRow | null> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id, fiscal_year, period_number, period_name, start_date::text AS start_date, end_date::text AS end_date, status, closed_at::text AS closed_at, closed_by::text AS closed_by, locked_at::text AS locked_at, locked_by::text AS locked_by, created_at::text AS created_at, updated_at::text AS updated_at FROM fin_accounting_periods WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
        id,
        tenant.schoolId,
      );
    })) as PeriodRow[];
    return rows[0] ?? null;
  }

  async list(fiscalYear?: string): Promise<PeriodDto[]> {
    const tenant = getCurrentTenant();
    const yearFilter = fiscalYear ? ` AND fiscal_year = $2` : '';
    const params: unknown[] = [tenant.schoolId];
    if (fiscalYear) params.push(fiscalYear);
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id, fiscal_year, period_number, period_name, start_date::text AS start_date, end_date::text AS end_date, status, closed_at::text AS closed_at, closed_by::text AS closed_by, locked_at::text AS locked_at, locked_by::text AS locked_by, created_at::text AS created_at, updated_at::text AS updated_at FROM fin_accounting_periods WHERE school_id = $1::uuid${yearFilter} ORDER BY fiscal_year DESC, period_number`,
        ...params,
      );
    })) as PeriodRow[];
    return rows.map((r) => this.rowToDto(r));
  }

  async getById(id: string): Promise<PeriodDto> {
    const r = await this.load(id);
    if (!r) throw new NotFoundException('Period not found');
    return this.rowToDto(r);
  }

  async create(actor: ResolvedActor, input: CreatePeriodDto): Promise<PeriodDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only school admins can create accounting periods');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    if (input.endDate < input.startDate) {
      throw new BadRequestException('endDate must be on or after startDate');
    }
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          `INSERT INTO fin_accounting_periods (id, school_id, fiscal_year, period_number, period_name, start_date, end_date) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::date, $7::date)`,
          id,
          tenant.schoolId,
          input.fiscalYear,
          input.periodNumber,
          input.periodName,
          input.startDate,
          input.endDate,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          `Period ${input.periodNumber} for ${input.fiscalYear} already exists`,
        );
      }
      throw err;
    }
    return this.getById(id);
  }

  async createSeries(actor: ResolvedActor, input: CreatePeriodSeriesDto): Promise<PeriodDto[]> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only school admins can bulk-create accounting periods');
    }
    const tenant = getCurrentTenant();
    const start = new Date(input.yearStart);
    if (Number.isNaN(start.getTime())) {
      throw new BadRequestException('yearStart must be a valid ISO date');
    }
    const created: string[] = [];
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      for (let n = 1; n <= 12; n++) {
        const periodStart = new Date(start);
        periodStart.setUTCMonth(periodStart.getUTCMonth() + (n - 1));
        const periodEnd = new Date(periodStart);
        periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);
        periodEnd.setUTCDate(periodEnd.getUTCDate() - 1);
        const monthName = periodStart.toLocaleString('en', { month: 'long', year: 'numeric' });
        const id = generateId();
        try {
          await tx.$executeRawUnsafe(
            `INSERT INTO fin_accounting_periods (id, school_id, fiscal_year, period_number, period_name, start_date, end_date) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::date, $7::date)`,
            id,
            tenant.schoolId,
            input.fiscalYear,
            n,
            monthName,
            periodStart.toISOString().slice(0, 10),
            periodEnd.toISOString().slice(0, 10),
          );
          created.push(id);
        } catch (err) {
          if (isUniqueViolation(err)) {
            // Skip silently — caller may be re-running
            continue;
          }
          throw err;
        }
      }
    });
    return Promise.all(created.map((id) => this.getById(id)));
  }

  async patchStatus(
    actor: ResolvedActor,
    id: string,
    input: UpdatePeriodStatusDto,
  ): Promise<PeriodDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only school admins can change period status');
    }
    const tenant = getCurrentTenant();
    if (!actor.employeeId) {
      throw new BadRequestException('Period status changes must be performed by an employee actor');
    }
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        `SELECT status FROM fin_accounting_periods WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE`,
        id,
        tenant.schoolId,
      )) as Array<{ status: string }>;
      if (rows.length === 0) throw new NotFoundException('Period not found');
      const current = rows[0]!.status as PeriodStatus;
      const target = input.status;

      // The LOCKED status is permanent — refuse any transition out of it.
      if (current === 'LOCKED') {
        throw new BadRequestException(
          'LOCKED periods are permanent and cannot transition to any other status. This is a financial integrity invariant.',
        );
      }

      const allowed: Record<PeriodStatus, PeriodStatus[]> = {
        FUTURE: ['OPEN'],
        OPEN: ['CLOSED', 'FUTURE'],
        CLOSED: ['OPEN', 'LOCKED'],
        LOCKED: [], // unreachable above
      };
      if (current === target) return this.getById(id);
      if (!allowed[current].includes(target)) {
        throw new BadRequestException(`Cannot transition period from ${current} to ${target}`);
      }

      // Stamp closed_at / locked_at at the moment of transition.
      if (target === 'CLOSED') {
        await tx.$executeRawUnsafe(
          `UPDATE fin_accounting_periods SET status='CLOSED', closed_at=now(), closed_by=$1::uuid, updated_at=now() WHERE id=$2::uuid AND school_id=$3::uuid`,
          actor.employeeId,
          id,
          tenant.schoolId,
        );
      } else if (target === 'LOCKED') {
        await tx.$executeRawUnsafe(
          `UPDATE fin_accounting_periods SET status='LOCKED', locked_at=now(), locked_by=$1::uuid, closed_at=COALESCE(closed_at, now()), closed_by=COALESCE(closed_by, $1::uuid), updated_at=now() WHERE id=$2::uuid AND school_id=$3::uuid`,
          actor.employeeId,
          id,
          tenant.schoolId,
        );
      } else if (target === 'OPEN') {
        await tx.$executeRawUnsafe(
          `UPDATE fin_accounting_periods SET status='OPEN', closed_at=NULL, closed_by=NULL, updated_at=now() WHERE id=$1::uuid AND school_id=$2::uuid`,
          id,
          tenant.schoolId,
        );
      } else {
        await tx.$executeRawUnsafe(
          `UPDATE fin_accounting_periods SET status=$1, updated_at=now() WHERE id=$2::uuid AND school_id=$3::uuid`,
          target,
          id,
          tenant.schoolId,
        );
      }
      return this.getById(id);
    });
  }
}
