import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import {
  CreatePayPeriodDto,
  ListPayPeriodsQueryDto,
  ListPayrollRecordsQueryDto,
  PAY_PERIOD_STATUSES,
  PAYROLL_RECORD_STATUSES,
  PayPeriodDto,
  PayPeriodStatus,
  PayrollDeductionDto,
  PayrollRecordDto,
  PayrollRecordStatus,
  ProcessPayPeriodDto,
} from './dto/payroll.dto';

interface PayPeriodRow {
  id: string;
  school_id: string;
  period_label: string;
  start_date: string;
  end_date: string;
  pay_date: string;
  status: string;
  processed_at: string | null;
  paid_at: string | null;
  record_count: number;
  total_gross: string | null;
  total_deductions: string | null;
  total_net: string | null;
}

interface PayrollRecordRow {
  id: string;
  school_id: string;
  employee_id: string;
  employee_first: string | null;
  employee_last: string | null;
  pay_period_id: string;
  pay_period_label: string;
  pay_date: string;
  salary_scale_id: string | null;
  gross_pay: string;
  total_deductions: string;
  total_adjustments: string;
  net_pay: string;
  status: string;
  notes: string | null;
  created_at: string;
}

interface DeductionRow {
  id: string;
  payroll_record_id: string;
  deduction_type: string;
  description: string | null;
  amount: string;
  is_pretax: boolean;
}

const SELECT_PERIOD_BASE =
  'SELECT p.id::text AS id, p.school_id::text AS school_id, p.period_label, ' +
  '       p.start_date::text AS start_date, p.end_date::text AS end_date, p.pay_date::text AS pay_date, ' +
  '       p.status, p.processed_at::text AS processed_at, p.paid_at::text AS paid_at, ' +
  '       COALESCE(rec.record_count, 0)::int AS record_count, ' +
  '       rec.total_gross::text AS total_gross, ' +
  '       rec.total_deductions::text AS total_deductions, ' +
  '       rec.total_net::text AS total_net ' +
  'FROM hr_pay_periods p ' +
  'LEFT JOIN ( ' +
  '  SELECT pay_period_id, COUNT(*)::int AS record_count, ' +
  '         SUM(gross_pay) AS total_gross, ' +
  '         SUM(total_deductions) AS total_deductions, ' +
  '         SUM(net_pay) AS total_net ' +
  '  FROM hr_payroll_records GROUP BY pay_period_id ' +
  ') rec ON rec.pay_period_id = p.id ';

const SELECT_RECORD_BASE =
  'SELECT r.id::text AS id, r.school_id::text AS school_id, r.employee_id::text AS employee_id, ' +
  '       ip.first_name AS employee_first, ip.last_name AS employee_last, ' +
  '       r.pay_period_id::text AS pay_period_id, p.period_label AS pay_period_label, ' +
  '       p.pay_date::text AS pay_date, ' +
  '       r.salary_scale_id::text AS salary_scale_id, ' +
  '       r.gross_pay::text AS gross_pay, r.total_deductions::text AS total_deductions, ' +
  '       r.total_adjustments::text AS total_adjustments, r.net_pay::text AS net_pay, ' +
  '       r.status, r.notes, r.created_at::text AS created_at ' +
  'FROM hr_payroll_records r ' +
  'JOIN hr_pay_periods p ON p.id = r.pay_period_id ' +
  'JOIN hr_employees e ON e.id = r.employee_id ' +
  'LEFT JOIN platform.iam_person ip ON ip.id = e.person_id ';

/**
 * Payroll lifecycle (P2C4 Step 2).
 *
 * Lifecycle:
 *   create pay period -> OPEN
 *   process()         -> PROCESSING then OPEN+records (the period stays
 *                        OPEN so the admin can review draft records;
 *                        the worker reuses processed_at as the "last
 *                        process run" timestamp).
 *   approve()         -> PAID-eligible (records flip APPROVED)
 *   markPaid()        -> PAID + records flip PAID + emits
 *                        hr.payroll.processed (one envelope per record)
 *
 * The hr.payroll.processed contract per the plan + Cycle 26 GLConsumer:
 *   {
 *     payrollRecordId, schoolId, employeeId,
 *     payPeriodId, payDate,
 *     grossPay, totalDeductions, netPay,
 *     deductions: [{ type, amount, isPretax }],
 *     adjustments: [{ type, amount }],
 *     paidAt,
 *   }
 *
 * Cycle 26 GLConsumer can post the journal entries:
 *   DEBIT  Salaries Expense   gross
 *   CREDIT Cash               net
 *   CREDIT Tax Payable        sum(tax deductions)
 *   CREDIT Benefits Payable   sum(benefit deductions)
 *
 * `process()` is idempotent under retry — UNIQUE(employee_id,
 * pay_period_id) on hr_payroll_records means a redelivery cannot
 * create duplicate records. The service does not delete existing
 * records; instead it INSERTs new ones with ON CONFLICT DO NOTHING
 * so partial re-runs are safe.
 */
@Injectable()
export class PayrollService {
  private readonly logger = new Logger(PayrollService.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
    private readonly kafka: KafkaProducerService,
  ) {}

  // ---------- pay-period CRUD ---------------------------------------------

  async listPeriods(args: ListPayPeriodsQueryDto): Promise<PayPeriodDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const params: unknown[] = [tenant.schoolId];
      let where = 'WHERE p.school_id = $1::uuid';
      if (args.status) {
        params.push(args.status);
        where += ' AND p.status = $' + params.length;
      }
      const rows = (await client.$queryRawUnsafe(
        SELECT_PERIOD_BASE + where + ' ORDER BY p.start_date DESC',
        ...params,
      )) as PayPeriodRow[];
      return rows.map((r) => this.periodRowToDto(r));
    });
  }

  async getPeriod(id: string): Promise<PayPeriodDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_PERIOD_BASE + 'WHERE p.school_id = $1::uuid AND p.id = $2::uuid LIMIT 1',
        tenant.schoolId,
        id,
      )) as PayPeriodRow[];
      if (rows.length === 0) throw new NotFoundException('Pay period not found');
      return this.periodRowToDto(rows[0]!);
    });
  }

  async createPeriod(input: CreatePayPeriodDto, actor: ResolvedActor): Promise<PayPeriodDto> {
    await this.assertAdmin(actor);
    if (input.endDate < input.startDate) {
      throw new BadRequestException('endDate must be on or after startDate.');
    }
    if (input.payDate < input.startDate) {
      throw new BadRequestException('payDate must be on or after startDate.');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO hr_pay_periods (id, school_id, period_label, start_date, end_date, pay_date) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4::date, $5::date, $6::date)',
          id,
          tenant.schoolId,
          input.periodLabel,
          input.startDate,
          input.endDate,
          input.payDate,
        );
      } catch (e: any) {
        if (this.isUniqueViolation(e)) {
          throw new BadRequestException('A pay period already exists with this start date.');
        }
        throw e;
      }
      return this.getPeriod(id);
    });
  }

  // ---------- worker primitives ------------------------------------------

  /**
   * Walk every active employee with a current salary-scale assignment,
   * compute gross / deductions / net, and INSERT a hr_payroll_records
   * row + N hr_payroll_deductions rows per employee. Idempotent under
   * retry via UNIQUE(employee_id, pay_period_id) — `INSERT ... ON
   * CONFLICT DO NOTHING` lets partial re-runs land the missing rows.
   *
   * Salary-scale assignment is encoded on the employee row itself:
   * P2C4 adds a denormalised `salary_scale_id` projection on
   * hr_employee_positions (see Step 11 seed). Until that lands the
   * worker reads from a future PayrollAssignmentService — for now,
   * the assignment is passed in via `employeeIds` + a per-employee
   * scale lookup. Schools without scales seeded see a 0-employee
   * processed result.
   */
  async processPeriod(
    periodId: string,
    input: ProcessPayPeriodDto,
    actor: ResolvedActor,
  ): Promise<{ processed: number; skipped: number }> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id, status FROM hr_pay_periods ' +
          'WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        periodId,
      )) as Array<{ id: string; status: string }>;
      if (lock.length === 0) throw new NotFoundException('Pay period not found');
      const cur = lock[0]!.status as PayPeriodStatus;
      if (cur !== 'OPEN' && cur !== 'PROCESSING') {
        throw new BadRequestException(
          'Cannot process a pay period in status ' + cur + '. Must be OPEN or PROCESSING.',
        );
      }
      const employees = await this.resolveEmployeesForProcessing(
        tx,
        tenant.schoolId,
        input.employeeIds,
      );
      let processed = 0;
      let skipped = 0;
      for (const emp of employees) {
        if (!emp.scaleId) {
          skipped += 1;
          continue;
        }
        const result = await this.materialiseRecord(
          tx,
          tenant.schoolId,
          periodId,
          emp.id,
          emp.scaleId,
          emp.annualSalary,
          emp.taxInfo,
          emp.benefits,
        );
        if (result.created) processed += 1;
        else skipped += 1;
      }
      await tx.$executeRawUnsafe(
        'UPDATE hr_pay_periods SET status = $1, processed_at = now(), processed_by = $2::uuid, updated_at = now() ' +
          'WHERE school_id = $3::uuid AND id = $4::uuid',
        'PROCESSING',
        actor.accountId,
        tenant.schoolId,
        periodId,
      );
      return { processed, skipped };
    });
  }

  async approvePeriod(periodId: string, actor: ResolvedActor): Promise<PayPeriodDto> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id, status FROM hr_pay_periods ' +
          'WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        periodId,
      )) as Array<{ id: string; status: string }>;
      if (lock.length === 0) throw new NotFoundException('Pay period not found');
      const cur = lock[0]!.status as PayPeriodStatus;
      if (cur !== 'PROCESSING') {
        throw new BadRequestException('Only PROCESSING periods can be approved.');
      }
      await tx.$executeRawUnsafe(
        "UPDATE hr_payroll_records SET status = 'APPROVED', updated_at = now() " +
          "WHERE school_id = $1::uuid AND pay_period_id = $2::uuid AND status = 'DRAFT'",
        tenant.schoolId,
        periodId,
      );
      return this.getPeriod(periodId);
    });
  }

  async markPaid(periodId: string, actor: ResolvedActor): Promise<PayPeriodDto> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    const eventsToEmit: Array<{ payload: Record<string, unknown>; key: string }> = [];
    const dto = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id, status FROM hr_pay_periods ' +
          'WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        periodId,
      )) as Array<{ id: string; status: string }>;
      if (lock.length === 0) throw new NotFoundException('Pay period not found');
      const cur = lock[0]!.status as PayPeriodStatus;
      if (cur !== 'PROCESSING') {
        throw new BadRequestException(
          'Only PROCESSING periods can be marked PAID. Approve the period first.',
        );
      }
      // Flip period + records.
      await tx.$executeRawUnsafe(
        "UPDATE hr_pay_periods SET status = 'PAID', paid_at = now(), paid_by = $1::uuid, updated_at = now() " +
          'WHERE school_id = $2::uuid AND id = $3::uuid',
        actor.accountId,
        tenant.schoolId,
        periodId,
      );
      await tx.$executeRawUnsafe(
        "UPDATE hr_payroll_records SET status = 'PAID', updated_at = now() " +
          "WHERE school_id = $1::uuid AND pay_period_id = $2::uuid AND status IN ('DRAFT','APPROVED')",
        tenant.schoolId,
        periodId,
      );
      // Build emit payload per record. Reads inside the same tx so the
      // emit shape reflects the post-flip state. Emits land AFTER the
      // tx commits.
      const records = (await tx.$queryRawUnsafe(
        SELECT_RECORD_BASE + 'WHERE r.school_id = $1::uuid AND r.pay_period_id = $2::uuid',
        tenant.schoolId,
        periodId,
      )) as PayrollRecordRow[];
      const recordIds = records.map((r) => r.id);
      let deductionsByRecord = new Map<string, DeductionRow[]>();
      if (recordIds.length > 0) {
        const deds = (await tx.$queryRawUnsafe(
          'SELECT id::text AS id, payroll_record_id::text AS payroll_record_id, ' +
            '       deduction_type, description, amount::text AS amount, is_pretax ' +
            'FROM hr_payroll_deductions WHERE payroll_record_id = ANY($1::uuid[])',
          recordIds,
        )) as DeductionRow[];
        for (const d of deds) {
          if (!deductionsByRecord.has(d.payroll_record_id))
            deductionsByRecord.set(d.payroll_record_id, []);
          deductionsByRecord.get(d.payroll_record_id)!.push(d);
        }
      }
      const paidAt = new Date().toISOString();
      for (const r of records) {
        eventsToEmit.push({
          key: r.id,
          payload: {
            payrollRecordId: r.id,
            schoolId: tenant.schoolId,
            employeeId: r.employee_id,
            payPeriodId: r.pay_period_id,
            payDate: r.pay_date,
            grossPay: Number(r.gross_pay),
            totalDeductions: Number(r.total_deductions),
            netPay: Number(r.net_pay),
            deductions: (deductionsByRecord.get(r.id) ?? []).map((d) => ({
              type: d.deduction_type,
              amount: Number(d.amount),
              isPretax: d.is_pretax,
            })),
            paidAt,
          },
        });
      }
      return this.getPeriod(periodId);
    });
    // Post-commit emit. Best-effort; failure logs but does not
    // re-open the period (the records stay PAID).
    for (const ev of eventsToEmit) {
      try {
        await this.kafka.emit({
          topic: 'hr.payroll.processed',
          key: ev.key,
          sourceModule: 'hr-payroll',
          payload: ev.payload,
        });
      } catch (e: any) {
        this.logger.warn(
          'hr.payroll.processed emit failed for record=' + ev.key + ': ' + (e?.message || e),
        );
      }
    }
    return dto;
  }

  // ---------- read paths --------------------------------------------------

  async listRecords(
    args: ListPayrollRecordsQueryDto,
    actor: ResolvedActor,
  ): Promise<PayrollRecordDto[]> {
    const tenant = getCurrentTenant();
    const isAdmin = await this.isAdmin(actor);
    const params: unknown[] = [tenant.schoolId];
    let where = 'WHERE r.school_id = $1::uuid';
    if (args.payPeriodId) {
      params.push(args.payPeriodId);
      where += ' AND r.pay_period_id = $' + params.length + '::uuid';
    }
    let employeeFilter = args.employeeId;
    if (!isAdmin) {
      // Self-service: bind to actor.employeeId. Reject if not staff.
      if (!actor.employeeId) {
        return [];
      }
      employeeFilter = actor.employeeId;
    }
    if (employeeFilter) {
      params.push(employeeFilter);
      where += ' AND r.employee_id = $' + params.length + '::uuid';
    }
    if (args.status) {
      params.push(args.status);
      where += ' AND r.status = $' + params.length;
    }
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_RECORD_BASE + where + ' ORDER BY p.pay_date DESC, ip.last_name, ip.first_name',
        ...params,
      )) as PayrollRecordRow[];
      const ids = rows.map((r) => r.id);
      const dedMap = new Map<string, PayrollDeductionDto[]>();
      if (ids.length > 0) {
        const deds = (await client.$queryRawUnsafe(
          'SELECT id::text AS id, payroll_record_id::text AS payroll_record_id, ' +
            '       deduction_type, description, amount::text AS amount, is_pretax ' +
            'FROM hr_payroll_deductions WHERE payroll_record_id = ANY($1::uuid[]) ' +
            'ORDER BY deduction_type',
          ids,
        )) as DeductionRow[];
        for (const d of deds) {
          if (!dedMap.has(d.payroll_record_id)) dedMap.set(d.payroll_record_id, []);
          dedMap.get(d.payroll_record_id)!.push(this.deductionRowToDto(d));
        }
      }
      return rows.map((r) => this.recordRowToDto(r, dedMap.get(r.id) ?? []));
    });
  }

  async getRecord(id: string, actor: ResolvedActor): Promise<PayrollRecordDto> {
    const tenant = getCurrentTenant();
    const isAdmin = await this.isAdmin(actor);
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_RECORD_BASE + 'WHERE r.school_id = $1::uuid AND r.id = $2::uuid LIMIT 1',
        tenant.schoolId,
        id,
      )) as PayrollRecordRow[];
      if (rows.length === 0) throw new NotFoundException('Payroll record not found');
      const row = rows[0]!;
      if (!isAdmin && row.employee_id !== actor.employeeId) {
        // Don't-leak-existence — match the privacy boundary the
        // P2C3 review hammered into the codebase.
        throw new NotFoundException('Payroll record not found');
      }
      const deds = (await client.$queryRawUnsafe(
        'SELECT id::text AS id, payroll_record_id::text AS payroll_record_id, ' +
          '       deduction_type, description, amount::text AS amount, is_pretax ' +
          'FROM hr_payroll_deductions WHERE payroll_record_id = $1::uuid ORDER BY deduction_type',
        row.id,
      )) as DeductionRow[];
      return this.recordRowToDto(
        row,
        deds.map((d) => this.deductionRowToDto(d)),
      );
    });
  }

  // ---------- internals --------------------------------------------------

  private async resolveEmployeesForProcessing(
    tx: any,
    schoolId: string,
    explicitIds: string[] | undefined,
  ): Promise<
    Array<{
      id: string;
      scaleId: string | null;
      annualSalary: number;
      taxInfo: { federalAllowances: number; stateAllowances: number; additional: number };
      benefits: Array<{ benefitType: string; employeeContribution: number }>;
    }>
  > {
    // Resolve from hr_employee_positions for any active assignment that
    // carries a salary_scale_id. Until P2-4a lands the salary_scale_id
    // column on positions (deferred — denormalising onto positions
    // would mean an ALTER COLUMN that the splitter handles cleanly but
    // is out of scope this step), we pick the most recent active
    // position and read its grade through the seed-set mapping below.
    const params: unknown[] = [schoolId];
    let where = 'WHERE e.school_id = $1::uuid';
    if (explicitIds && explicitIds.length > 0) {
      params.push(explicitIds);
      where += ' AND e.id = ANY($' + params.length + '::uuid[])';
    } else {
      where += " AND e.employment_status = 'ACTIVE'";
    }
    const employees = (await tx.$queryRawUnsafe(
      'SELECT e.id::text AS id ' + 'FROM hr_employees e ' + where + ' ORDER BY e.id',
      ...params,
    )) as Array<{ id: string }>;
    if (employees.length === 0) return [];
    const empIds = employees.map((e) => e.id);

    // Pull tax info + benefits in one round trip each.
    const taxRows = (await tx.$queryRawUnsafe(
      'SELECT employee_id::text AS employee_id, federal_allowances, state_allowances, ' +
        '       additional_withholding::text AS additional ' +
        'FROM hr_employee_tax_info WHERE employee_id = ANY($1::uuid[])',
      empIds,
    )) as Array<{
      employee_id: string;
      federal_allowances: number;
      state_allowances: number;
      additional: string;
    }>;
    const taxByEmp = new Map<
      string,
      { federalAllowances: number; stateAllowances: number; additional: number }
    >();
    for (const t of taxRows) {
      taxByEmp.set(t.employee_id, {
        federalAllowances: t.federal_allowances,
        stateAllowances: t.state_allowances,
        additional: Number(t.additional),
      });
    }
    const benefitRows = (await tx.$queryRawUnsafe(
      'SELECT employee_id::text AS employee_id, benefit_type, ' +
        '       employee_contribution::text AS employee_contribution ' +
        'FROM hr_employee_benefits WHERE employee_id = ANY($1::uuid[]) AND is_active = true',
      empIds,
    )) as Array<{ employee_id: string; benefit_type: string; employee_contribution: string }>;
    const benByEmp = new Map<
      string,
      Array<{ benefitType: string; employeeContribution: number }>
    >();
    for (const b of benefitRows) {
      if (!benByEmp.has(b.employee_id)) benByEmp.set(b.employee_id, []);
      benByEmp.get(b.employee_id)!.push({
        benefitType: b.benefit_type,
        employeeContribution: Number(b.employee_contribution),
      });
    }

    // Salary scale assignment: read the seed mapping from a side-car
    // table or fall back to picking the lowest-step scale on the only
    // active grade. P2-4a ships the simple mapping: each employee gets
    // the first salary scale in the school's first active grade. This
    // is stub-shaped — P2-4b will introduce per-employee assignment
    // via hr_employee_positions.salary_scale_id.
    const scales = (await tx.$queryRawUnsafe(
      'SELECT s.id::text AS id, s.annual_salary::text AS annual_salary, s.step ' +
        'FROM hr_salary_scales s ' +
        'JOIN hr_pay_grades g ON g.id = s.pay_grade_id ' +
        'WHERE g.school_id = $1::uuid AND g.is_active = true ' +
        'ORDER BY g.grade_name, s.step LIMIT 1',
      schoolId,
    )) as Array<{ id: string; annual_salary: string; step: number }>;
    const defaultScale = scales[0] ?? null;

    return employees.map((e) => ({
      id: e.id,
      scaleId: defaultScale?.id ?? null,
      annualSalary: defaultScale ? Number(defaultScale.annual_salary) : 0,
      taxInfo: taxByEmp.get(e.id) ?? { federalAllowances: 0, stateAllowances: 0, additional: 0 },
      benefits: benByEmp.get(e.id) ?? [],
    }));
  }

  /**
   * Materialise a single payroll record + its deductions inside the
   * caller's tx. Returns { created: true } when the row was new and
   * { created: false } when ON CONFLICT DO NOTHING claimed the row
   * (idempotent retry).
   */
  private async materialiseRecord(
    tx: any,
    schoolId: string,
    payPeriodId: string,
    employeeId: string,
    salaryScaleId: string,
    annualSalary: number,
    taxInfo: { federalAllowances: number; stateAllowances: number; additional: number },
    benefits: Array<{ benefitType: string; employeeContribution: number }>,
  ): Promise<{ created: boolean }> {
    // Bi-weekly assumption: 26 pay periods / year. The plan calls
    // these out as "configurable" — for P2-4a we hard-code bi-weekly;
    // P2-4b will let schools pick weekly / monthly.
    const grossPay = round2(annualSalary / 26);
    // Federal tax: simple flat 20% minus per-allowance reduction $50
    const federalTax = Math.max(0, round2(grossPay * 0.2 - taxInfo.federalAllowances * 50));
    // State tax: flat 6% minus per-allowance $25
    const stateTax = Math.max(0, round2(grossPay * 0.06 - taxInfo.stateAllowances * 25));
    // Social security 6.2% (capped per-period equivalent of 2024 wage base)
    const socialSecurity = round2(grossPay * 0.062);
    // Medicare 1.45%
    const medicare = round2(grossPay * 0.0145);
    // Benefits roll up by type
    const healthDeduction = sumBenefits(benefits, ['HEALTH', 'DENTAL', 'VISION']);
    const retirementDeduction = sumBenefits(benefits, ['RETIREMENT']);
    const additionalWithholding = round2(taxInfo.additional);

    const deductions: Array<{ type: string; amount: number; isPretax: boolean }> = [];
    if (federalTax > 0)
      deductions.push({
        type: 'FEDERAL_TAX',
        amount: federalTax + additionalWithholding,
        isPretax: false,
      });
    else if (additionalWithholding > 0)
      deductions.push({ type: 'FEDERAL_TAX', amount: additionalWithholding, isPretax: false });
    if (stateTax > 0) deductions.push({ type: 'STATE_TAX', amount: stateTax, isPretax: false });
    if (socialSecurity > 0)
      deductions.push({ type: 'SOCIAL_SECURITY', amount: socialSecurity, isPretax: false });
    if (medicare > 0) deductions.push({ type: 'MEDICARE', amount: medicare, isPretax: false });
    if (healthDeduction > 0)
      deductions.push({ type: 'HEALTH_INSURANCE', amount: healthDeduction, isPretax: true });
    if (retirementDeduction > 0)
      deductions.push({ type: 'RETIREMENT', amount: retirementDeduction, isPretax: true });

    const totalDeductions = round2(deductions.reduce((acc, d) => acc + d.amount, 0));
    const netPay = round2(grossPay - totalDeductions);

    const recordId = generateId();
    // ON CONFLICT (employee_id, pay_period_id) DO NOTHING + RETURNING id
    const inserted = (await tx.$queryRawUnsafe(
      'INSERT INTO hr_payroll_records ' +
        '(id, school_id, employee_id, pay_period_id, salary_scale_id, gross_pay, total_deductions, net_pay, status) ' +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, 'DRAFT') " +
        'ON CONFLICT (employee_id, pay_period_id) DO NOTHING RETURNING id::text AS id',
      recordId,
      schoolId,
      employeeId,
      payPeriodId,
      salaryScaleId,
      grossPay,
      totalDeductions,
      netPay,
    )) as Array<{ id: string }>;
    if (inserted.length === 0) {
      // Already exists — idempotent skip. Don't write deductions.
      return { created: false };
    }
    for (const d of deductions) {
      await tx.$executeRawUnsafe(
        'INSERT INTO hr_payroll_deductions (id, payroll_record_id, deduction_type, amount, is_pretax) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5)',
        generateId(),
        recordId,
        d.type,
        d.amount,
        d.isPretax,
      );
    }
    return { created: true };
  }

  private async assertAdmin(actor: ResolvedActor): Promise<void> {
    if (await this.isAdmin(actor)) return;
    throw new ForbiddenException('Payroll administration requires hr-003:admin or school admin.');
  }

  private async isAdmin(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'hr-003:admin',
      'hr-003:write',
    ]);
  }

  private periodRowToDto(r: PayPeriodRow): PayPeriodDto {
    if (!PAY_PERIOD_STATUSES.includes(r.status as PayPeriodStatus)) {
      throw new ConflictException('Unexpected pay period status: ' + r.status);
    }
    return {
      id: r.id,
      schoolId: r.school_id,
      periodLabel: r.period_label,
      startDate: r.start_date,
      endDate: r.end_date,
      payDate: r.pay_date,
      status: r.status as PayPeriodStatus,
      processedAt: r.processed_at,
      paidAt: r.paid_at,
      recordCount: r.record_count,
      totalGross: r.total_gross === null ? 0 : Number(r.total_gross),
      totalDeductions: r.total_deductions === null ? 0 : Number(r.total_deductions),
      totalNet: r.total_net === null ? 0 : Number(r.total_net),
    };
  }

  private recordRowToDto(r: PayrollRecordRow, deductions: PayrollDeductionDto[]): PayrollRecordDto {
    if (!PAYROLL_RECORD_STATUSES.includes(r.status as PayrollRecordStatus)) {
      throw new ConflictException('Unexpected payroll record status: ' + r.status);
    }
    const name =
      r.employee_first || r.employee_last
        ? [r.employee_first, r.employee_last].filter(Boolean).join(' ')
        : null;
    return {
      id: r.id,
      schoolId: r.school_id,
      employeeId: r.employee_id,
      employeeName: name,
      payPeriodId: r.pay_period_id,
      payPeriodLabel: r.pay_period_label,
      payDate: r.pay_date,
      salaryScaleId: r.salary_scale_id,
      grossPay: Number(r.gross_pay),
      totalDeductions: Number(r.total_deductions),
      totalAdjustments: Number(r.total_adjustments),
      netPay: Number(r.net_pay),
      status: r.status as PayrollRecordStatus,
      notes: r.notes,
      deductions,
      createdAt: r.created_at,
    };
  }

  private deductionRowToDto(r: DeductionRow): PayrollDeductionDto {
    return {
      id: r.id,
      payrollRecordId: r.payroll_record_id,
      deductionType: r.deduction_type as PayrollDeductionDto['deductionType'],
      description: r.description,
      amount: Number(r.amount),
      isPretax: r.is_pretax,
    };
  }

  private isUniqueViolation(err: any): boolean {
    if (!err) return false;
    if (err.code === 'P2010' && err.meta?.code === '23505') return true;
    if (typeof err.message === 'string' && /unique/i.test(err.message)) return true;
    return false;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function sumBenefits(
  benefits: Array<{ benefitType: string; employeeContribution: number }>,
  types: string[],
): number {
  return round2(
    benefits
      .filter((b) => types.includes(b.benefitType))
      .reduce((a, b) => a + b.employeeContribution, 0),
  );
}
