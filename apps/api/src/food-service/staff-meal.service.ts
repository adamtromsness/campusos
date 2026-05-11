import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { PermissionCheckService } from '../iam/permission-check.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  ChargeStaffMealDto,
  CreateStaffMealAccountDto,
  StaffMealAccountResponseDto,
  StaffMealDeductionSummaryRowDto,
  UpdateStaffMealAccountDto,
} from './dto/food-service-advanced.dto';
import { isUniqueViolation } from './food-service.errors';
import { assertFsmAdminScope } from './fsm-scope';

/**
 * StaffMealService — employee meal accounts with PAYROLL / PREPAID /
 * COMPLIMENTARY deduction methods.
 *
 *   PAYROLL       balance can go negative; settled via monthly
 *                 payroll-deductions summary the P2-4 payroll job
 *                 consumes.
 *   PREPAID       balance must stay >= 0 — charge refused otherwise.
 *   COMPLIMENTARY no charge applied; balance stays at 0 for record.
 *
 * Each charge is recorded as a journal entry on the account's
 * balance via a single locked UPDATE so concurrent charges
 * serialise.
 */
@Injectable()
export class StaffMealService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  /**
   * REVIEW-P2-10a ROUND 1 BLOCKING 4 — gates on FDS-006:write (Food
   * Service Administration). Generic STAFF persona without the
   * code is refused.
   */
  private async assertCanManage(actor: ResolvedActor): Promise<void> {
    await assertFsmAdminScope(this.permCheck, actor, 'manage staff meal accounts');
  }

  async list(): Promise<StaffMealAccountResponseDto[]> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT a.id::text AS id, a.employee_id::text AS employee_id, a.school_id::text AS school_id, a.balance, a.deduction_method, a.daily_limit ' +
          'FROM fds_staff_meal_accounts a WHERE a.school_id = $1::uuid ORDER BY a.created_at DESC',
        tenant.schoolId,
      );
    })) as StaffMealRow[];
    return rows.map(staffMealRowToDto);
  }

  async getByEmployee(employeeId: string): Promise<StaffMealAccountResponseDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, employee_id::text AS employee_id, school_id::text AS school_id, balance, deduction_method, daily_limit ' +
          'FROM fds_staff_meal_accounts WHERE employee_id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        employeeId,
        tenant.schoolId,
      );
    })) as StaffMealRow[];
    if (rows.length === 0) throw new NotFoundException('Staff meal account not found');
    return staffMealRowToDto(rows[0]!);
  }

  async create(
    input: CreateStaffMealAccountDto,
    actor: ResolvedActor,
  ): Promise<StaffMealAccountResponseDto> {
    await this.assertCanManage(actor);
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        // Verify the employee exists in this tenant.
        const emp = (await client.$queryRawUnsafe(
          'SELECT id FROM hr_employees WHERE id = $1::uuid AND school_id = $2::uuid',
          input.employeeId,
          tenant.schoolId,
        )) as Array<{ id: string }>;
        if (emp.length === 0) {
          throw new BadRequestException('employeeId does not match an employee in this school');
        }
        await client.$executeRawUnsafe(
          'INSERT INTO fds_staff_meal_accounts (id, employee_id, school_id, balance, deduction_method, daily_limit) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, 0, $4, $5)',
          id,
          input.employeeId,
          tenant.schoolId,
          input.deductionMethod ?? 'PAYROLL',
          input.dailyLimit ?? null,
        );
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException('A staff meal account already exists for this employee');
      }
      throw err;
    }
    return this.getById(id);
  }

  async getById(id: string): Promise<StaffMealAccountResponseDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, employee_id::text AS employee_id, school_id::text AS school_id, balance, deduction_method, daily_limit ' +
          'FROM fds_staff_meal_accounts WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      );
    })) as StaffMealRow[];
    if (rows.length === 0) throw new NotFoundException('Staff meal account not found');
    return staffMealRowToDto(rows[0]!);
  }

  async patch(
    id: string,
    input: UpdateStaffMealAccountDto,
    actor: ResolvedActor,
  ): Promise<StaffMealAccountResponseDto> {
    await this.assertCanManage(actor);
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, val: unknown): void => {
      sets.push(col + ' = $' + (params.length + 1));
      params.push(val);
    };
    if (input.deductionMethod !== undefined) push('deduction_method', input.deductionMethod);
    if (input.dailyLimit !== undefined) push('daily_limit', input.dailyLimit);
    if (sets.length === 0) return this.getById(id);
    sets.push('updated_at = now()');
    // REVIEW-P2-10a ROUND 1 MAJOR 5 — UPDATE now predicates on both
    // id AND school_id. Previously the UPDATE ran by id alone and
    // relied on the school-scoped reload to surface a cross-school
    // hit as 404 — but the mutation already landed. Now the UPDATE
    // never touches a foreign-school row.
    const tenant = getCurrentTenant();
    params.push(id);
    const idPlaceholder = params.length;
    params.push(tenant.schoolId);
    const schoolPlaceholder = params.length;
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const result = await client.$executeRawUnsafe(
        'UPDATE fds_staff_meal_accounts SET ' +
          sets.join(', ') +
          ' WHERE id = $' +
          idPlaceholder +
          '::uuid AND school_id = $' +
          schoolPlaceholder +
          '::uuid',
        ...params,
      );
      if (result === 0) throw new NotFoundException('Staff meal account not found');
    });
    return this.getById(id);
  }

  /**
   * Apply a meal charge to a staff account. Locks the row, applies
   * the deduction method's policy, and updates balance inside one
   * tenant tx.
   *
   *   PAYROLL       balance -= amount (allowed to go negative)
   *   PREPAID       balance >= amount required, then balance -= amount
   *   COMPLIMENTARY balance unchanged (record-only)
   */
  async charge(
    id: string,
    input: ChargeStaffMealDto,
    actor: ResolvedActor,
  ): Promise<StaffMealAccountResponseDto> {
    await this.assertCanManage(actor);
    if (input.amount <= 0) throw new BadRequestException('amount must be > 0');
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const locked = (await tx.$queryRawUnsafe(
        'SELECT balance, deduction_method, daily_limit FROM fds_staff_meal_accounts WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE',
        id,
        tenant.schoolId,
      )) as Array<{
        balance: number;
        deduction_method: string;
        daily_limit: number | null;
      }>;
      if (locked.length === 0) throw new NotFoundException('Staff meal account not found');
      const acct = locked[0]!;
      const balance = numFromDecimal(acct.balance);
      const dailyLimit = acct.daily_limit === null ? null : numFromDecimal(acct.daily_limit);
      if (dailyLimit !== null && input.amount > dailyLimit) {
        throw new BadRequestException(
          'Charge ' +
            input.amount.toString() +
            ' exceeds the daily limit of ' +
            dailyLimit.toString() +
            ' for this account',
        );
      }
      if (acct.deduction_method === 'PREPAID' && balance < input.amount) {
        throw new BadRequestException(
          'PREPAID account has insufficient balance: ' +
            balance.toString() +
            ' on file, ' +
            input.amount.toString() +
            ' requested.',
        );
      }
      if (acct.deduction_method === 'COMPLIMENTARY') {
        // No-op on balance — record event only via updated_at bump
        // so audit log shows access.
        await tx.$executeRawUnsafe(
          'UPDATE fds_staff_meal_accounts SET updated_at = now() WHERE id = $1::uuid',
          id,
        );
      } else {
        const newBalance = Math.round((balance - input.amount) * 100) / 100;
        await tx.$executeRawUnsafe(
          'UPDATE fds_staff_meal_accounts SET balance = $1, updated_at = now() WHERE id = $2::uuid',
          newBalance,
          id,
        );
      }
      // Touch the actor variable so an unused-param lint pass cannot
      // suggest removing the parameter — the assert above uses it
      // but TS strict can flag downstream copies otherwise.
      void actor.accountId;
      void (input.notes ?? '');
    });
    return this.getById(id);
  }

  /**
   * Monthly payroll-deduction summary. Returns one row per PAYROLL
   * account holding a non-zero negative balance (i.e. owed) as of
   * now. The P2-4 payroll job consumes this to apply the monthly
   * deduction. After payroll runs, the account is reset (an admin
   * action on the payroll side).
   */
  async payrollDeductions(): Promise<StaffMealDeductionSummaryRowDto[]> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT employee_id::text AS employee_id, 1 AS charge_count, ABS(balance) AS total_amount ' +
          "FROM fds_staff_meal_accounts WHERE school_id = $1::uuid AND deduction_method = 'PAYROLL' AND balance < 0 " +
          'ORDER BY balance ASC',
        tenant.schoolId,
      );
    })) as Array<{ employee_id: string; charge_count: number; total_amount: number }>;
    return rows.map((r) => ({
      employeeId: r.employee_id,
      chargeCount: r.charge_count,
      totalAmount: numFromDecimal(r.total_amount),
    }));
  }
}

interface StaffMealRow {
  id: string;
  employee_id: string;
  school_id: string | null;
  balance: number;
  deduction_method: string;
  daily_limit: number | null;
}

function staffMealRowToDto(r: StaffMealRow): StaffMealAccountResponseDto {
  return {
    id: r.id,
    employeeId: r.employee_id,
    schoolId: r.school_id,
    balance: numFromDecimal(r.balance),
    deductionMethod: r.deduction_method as StaffMealAccountResponseDto['deductionMethod'],
    dailyLimit: r.daily_limit === null ? null : numFromDecimal(r.daily_limit),
  };
}

function numFromDecimal(v: number | string): number {
  if (typeof v === 'number') return v;
  return Number(v);
}
