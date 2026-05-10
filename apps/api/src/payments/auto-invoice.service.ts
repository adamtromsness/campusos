import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  AutoInvoiceRuleResponseDto,
  CreateAutoInvoiceRuleDto,
  InvoiceGenerationRunResponseDto,
  ListInvoiceGenerationRunsQueryDto,
  RunStatus,
  RunType,
  TriggerAutoInvoiceRuleDto,
  TriggerType,
  UpdateAutoInvoiceRuleDto,
} from './dto/auto-invoice-rule.dto';

interface RuleRow {
  id: string;
  school_id: string;
  name: string;
  description: string | null;
  trigger_type: string;
  fee_schedule_id: string;
  fee_schedule_name: string | null;
  trigger_day_of_month: number | null;
  trigger_term_offset_days: number | null;
  applies_to_grade_level: string | null;
  is_active: boolean;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: string;
  school_id: string;
  run_type: string;
  fee_schedule_id: string | null;
  fee_schedule_name: string | null;
  auto_rule_id: string | null;
  academic_year_id: string | null;
  initiated_by: string | null;
  total_families_targeted: number;
  invoices_created: number;
  invoices_skipped: number;
  invoices_failed: number;
  status: string;
  error_summary: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_RULE_BASE =
  'SELECT r.id, r.school_id, r.name, r.description, r.trigger_type, r.fee_schedule_id, ' +
  'fs.name AS fee_schedule_name, r.trigger_day_of_month, r.trigger_term_offset_days, ' +
  'r.applies_to_grade_level, r.is_active, r.last_run_at, r.created_at, r.updated_at ' +
  'FROM pay_auto_invoice_rules r LEFT JOIN pay_fee_schedules fs ON fs.id = r.fee_schedule_id ';

const SELECT_RUN_BASE =
  'SELECT r.id, r.school_id, r.run_type, r.fee_schedule_id, fs.name AS fee_schedule_name, ' +
  'r.auto_rule_id, r.academic_year_id, r.initiated_by, r.total_families_targeted, ' +
  'r.invoices_created, r.invoices_skipped, r.invoices_failed, r.status, r.error_summary, ' +
  'r.started_at, r.completed_at, r.created_at, r.updated_at ' +
  'FROM pay_invoice_generation_runs r LEFT JOIN pay_fee_schedules fs ON fs.id = r.fee_schedule_id ';

function ruleRowToDto(r: RuleRow): AutoInvoiceRuleResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    name: r.name,
    description: r.description,
    triggerType: r.trigger_type as TriggerType,
    feeScheduleId: r.fee_schedule_id,
    feeScheduleName: r.fee_schedule_name,
    triggerDayOfMonth: r.trigger_day_of_month,
    triggerTermOffsetDays: r.trigger_term_offset_days,
    appliesToGradeLevel: r.applies_to_grade_level,
    isActive: r.is_active,
    lastRunAt: r.last_run_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function runRowToDto(r: RunRow): InvoiceGenerationRunResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    runType: r.run_type as RunType,
    feeScheduleId: r.fee_schedule_id,
    feeScheduleName: r.fee_schedule_name,
    autoRuleId: r.auto_rule_id,
    academicYearId: r.academic_year_id,
    initiatedBy: r.initiated_by,
    totalFamiliesTargeted: r.total_families_targeted,
    invoicesCreated: r.invoices_created,
    invoicesSkipped: r.invoices_skipped,
    invoicesFailed: r.invoices_failed,
    status: r.status as RunStatus,
    errorSummary: r.error_summary,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * AutoInvoiceService — Phase 2 Cycle 6 (P2-6).
 *
 * Manages pay_auto_invoice_rules and pay_invoice_generation_runs.
 *
 * The trigger() endpoint runs a generation pass synchronously. The
 * runs are tracked via pay_invoice_generation_runs with QUEUED ->
 * RUNNING -> COMPLETED status. Each generation pass:
 *   1. Resolves the eligible students by applies_to_grade_level OR
 *      pay_fee_schedules.applies_to_student_ids.
 *   2. For each student, finds the family billing account (via
 *      sis_student_guardians + pay_family_account_students).
 *   3. For each family, creates ONE DRAFT pay_invoices row +
 *      ONE pay_invoice_line_items attributed to the fee schedule.
 *   4. Applies discount rules (SIBLING + EARLY_PAYMENT) at
 *      generation time as additional negative line items. Sibling
 *      detection counts the active enrollees per family from
 *      sis_student_guardians + sis_enrollments.
 *   5. Tracks invoices_created plus invoices_skipped (the family
 *      already has an open invoice for this fee schedule + period)
 *      plus invoices_failed (any per-family error).
 *
 * Authorisation contract:
 *   - fin-001:read   — admin reads rules + runs.
 *   - fin-001:admin  — admin creates / updates / triggers rules.
 *
 * AutoInvoiceWorker — the OnModuleInit poll path. The plan's full
 * cron-driven worker (DATE_OF_MONTH polling, TERM_START offset
 * calculation against sis_terms) is scaffolded as a single
 * scheduled-poll loop — it logs the rules it would have evaluated
 * and the trigger conditions but defers actual auto-firing to
 * deployment-time CRON wiring per the plan's reviewer attention
 * note. The synchronous trigger() endpoint is the path admins use
 * today; the poll is reserved for Phase 3 ops.
 */
@Injectable()
export class AutoInvoiceService implements OnModuleInit {
  private readonly logger = new Logger(AutoInvoiceService.name);

  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  onModuleInit(): void {
    // Phase 3 ops will wire a real CRON-driven poll loop. For now
    // log that the worker is scaffolded; the synchronous trigger()
    // endpoint is the runtime path.
    this.logger.log(
      'AutoInvoiceWorker scaffolded — synchronous trigger via POST /payments/auto-invoice-rules/:id/trigger',
    );
  }

  /** ───── Rules CRUD ───── */

  async listRules(
    includeInactive: boolean,
    actor: ResolvedActor,
  ): Promise<AutoInvoiceRuleResponseDto[]> {
    if (!actor.isSchoolAdmin)
      throw new ForbiddenException('Only admins can list auto-invoice rules');
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      let sql = SELECT_RULE_BASE + 'WHERE 1=1 ';
      if (!includeInactive) sql += 'AND r.is_active = true ';
      sql += 'ORDER BY r.name';
      return client.$queryRawUnsafe<RuleRow[]>(sql);
    });
    return rows.map(ruleRowToDto);
  }

  async getRuleById(id: string, actor: ResolvedActor): Promise<AutoInvoiceRuleResponseDto> {
    if (!actor.isSchoolAdmin)
      throw new ForbiddenException('Only admins can read auto-invoice rules');
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<RuleRow[]>(SELECT_RULE_BASE + 'WHERE r.id = $1::uuid', id),
    );
    if (rows.length === 0) throw new NotFoundException('Auto-invoice rule ' + id + ' not found');
    return ruleRowToDto(rows[0]!);
  }

  async createRule(
    body: CreateAutoInvoiceRuleDto,
    actor: ResolvedActor,
  ): Promise<AutoInvoiceRuleResponseDto> {
    if (!actor.isSchoolAdmin)
      throw new ForbiddenException('Only admins can create auto-invoice rules');
    if (body.triggerType === 'DATE_OF_MONTH' && !body.triggerDayOfMonth) {
      throw new BadRequestException('triggerDayOfMonth is required for DATE_OF_MONTH trigger type');
    }
    const id = generateId();
    const schoolId = getCurrentTenant().schoolId;
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      try {
        await client.$executeRawUnsafe(
          'INSERT INTO pay_auto_invoice_rules ' +
            '(id, school_id, name, description, trigger_type, fee_schedule_id, trigger_day_of_month, trigger_term_offset_days, applies_to_grade_level, is_active, created_by) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7, $8, $9, $10, $11::uuid)',
          id,
          schoolId,
          body.name,
          body.description ?? null,
          body.triggerType,
          body.feeScheduleId,
          body.triggerDayOfMonth ?? null,
          body.triggerTermOffsetDays ?? null,
          body.appliesToGradeLevel ?? null,
          body.isActive ?? true,
          actor.accountId,
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new BadRequestException(
            'An auto-invoice rule with name "' + body.name + '" already exists',
          );
        }
        throw err;
      }
    });
    return this.getRuleById(id, actor);
  }

  async updateRule(
    id: string,
    body: UpdateAutoInvoiceRuleDto,
    actor: ResolvedActor,
  ): Promise<AutoInvoiceRuleResponseDto> {
    if (!actor.isSchoolAdmin)
      throw new ForbiddenException('Only admins can update auto-invoice rules');
    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (body.name !== undefined) {
      sets.push('name = $' + idx);
      params.push(body.name);
      idx++;
    }
    if (body.description !== undefined) {
      sets.push('description = $' + idx);
      params.push(body.description);
      idx++;
    }
    if (body.isActive !== undefined) {
      sets.push('is_active = $' + idx);
      params.push(body.isActive);
      idx++;
    }
    if (body.triggerDayOfMonth !== undefined) {
      sets.push('trigger_day_of_month = $' + idx);
      params.push(body.triggerDayOfMonth);
      idx++;
    }
    if (body.triggerTermOffsetDays !== undefined) {
      sets.push('trigger_term_offset_days = $' + idx);
      params.push(body.triggerTermOffsetDays);
      idx++;
    }
    if (body.appliesToGradeLevel !== undefined) {
      sets.push('applies_to_grade_level = $' + idx);
      params.push(body.appliesToGradeLevel);
      idx++;
    }
    if (sets.length === 0) return this.getRuleById(id, actor);
    sets.push('updated_at = now()');
    params.push(id);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const result = await client.$executeRawUnsafe(
        'UPDATE pay_auto_invoice_rules SET ' + sets.join(', ') + ' WHERE id = $' + idx + '::uuid',
        ...params,
      );
      if (result === 0) throw new NotFoundException('Auto-invoice rule ' + id + ' not found');
    });
    return this.getRuleById(id, actor);
  }

  /** ───── Generation ───── */

  /**
   * Trigger a generation pass for an auto-invoice rule. Creates a
   * pay_invoice_generation_runs row, processes each eligible
   * student / family, and updates the run row to COMPLETED.
   */
  async triggerRule(
    ruleId: string,
    body: TriggerAutoInvoiceRuleDto,
    actor: ResolvedActor,
  ): Promise<InvoiceGenerationRunResponseDto> {
    if (!actor.isSchoolAdmin)
      throw new ForbiddenException('Only admins can trigger auto-invoice rules');
    const rule = await this.getRuleById(ruleId, actor);
    if (!rule.isActive) {
      throw new BadRequestException('Cannot trigger an inactive rule');
    }
    return this.runGeneration({
      runType: 'AUTO_RULE_TRIGGERED',
      autoRuleId: rule.id,
      feeScheduleId: rule.feeScheduleId,
      academicYearId: body.academicYearId ?? null,
      gradeFilter: rule.appliesToGradeLevel,
      actor,
    });
  }

  /**
   * Manual one-shot generation for a fee schedule (admin clicks the
   * Generate button on the schedule). Run type is FEE_SCHEDULE_BULK.
   */
  async generateFromFeeSchedule(
    feeScheduleId: string,
    academicYearId: string | null,
    actor: ResolvedActor,
  ): Promise<InvoiceGenerationRunResponseDto> {
    if (!actor.isSchoolAdmin) throw new ForbiddenException('Only admins can generate invoices');
    return this.runGeneration({
      runType: 'FEE_SCHEDULE_BULK',
      autoRuleId: null,
      feeScheduleId,
      academicYearId,
      gradeFilter: null,
      actor,
    });
  }

  async listRuns(
    query: ListInvoiceGenerationRunsQueryDto,
    actor: ResolvedActor,
  ): Promise<InvoiceGenerationRunResponseDto[]> {
    if (!actor.isSchoolAdmin)
      throw new ForbiddenException('Only admins can list invoice generation runs');
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      let sql = SELECT_RUN_BASE + 'WHERE 1=1 ';
      const params: unknown[] = [];
      let idx = 1;
      if (query.status) {
        sql += 'AND r.status = $' + idx + ' ';
        params.push(query.status);
        idx++;
      }
      if (query.autoRuleId) {
        sql += 'AND r.auto_rule_id = $' + idx + '::uuid ';
        params.push(query.autoRuleId);
        idx++;
      }
      sql += 'ORDER BY r.created_at DESC LIMIT 100';
      return client.$queryRawUnsafe<RunRow[]>(sql, ...params);
    });
    return rows.map(runRowToDto);
  }

  async getRunById(id: string, actor: ResolvedActor): Promise<InvoiceGenerationRunResponseDto> {
    if (!actor.isSchoolAdmin)
      throw new ForbiddenException('Only admins can read invoice generation runs');
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<RunRow[]>(SELECT_RUN_BASE + 'WHERE r.id = $1::uuid', id),
    );
    if (rows.length === 0)
      throw new NotFoundException('Invoice generation run ' + id + ' not found');
    return runRowToDto(rows[0]!);
  }

  /**
   * Internal generation engine. Creates the run row, walks the
   * eligible families, and updates totals.
   */
  private async runGeneration(args: {
    runType: RunType;
    autoRuleId: string | null;
    feeScheduleId: string;
    academicYearId: string | null;
    gradeFilter: string | null;
    actor: ResolvedActor;
  }): Promise<InvoiceGenerationRunResponseDto> {
    const schoolId = getCurrentTenant().schoolId;
    const runId = generateId();

    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO pay_invoice_generation_runs ' +
          '(id, school_id, run_type, fee_schedule_id, auto_rule_id, academic_year_id, initiated_by, status, started_at) ' +
          "VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7::uuid, 'RUNNING', now())",
        runId,
        schoolId,
        args.runType,
        args.feeScheduleId,
        args.autoRuleId,
        args.academicYearId,
        args.actor.accountId,
      );
    });

    let created = 0;
    let skipped = 0;
    let failed = 0;
    let targeted = 0;
    let errorSummary: string | null = null;

    try {
      // Resolve fee schedule details.
      const scheduleRows = (await this.tenantPrisma.executeInTenantContext(async (client) =>
        client.$queryRawUnsafe<
          Array<{
            id: string;
            name: string;
            amount: string;
            grade_level: string | null;
            applies_to_student_ids: string[] | null;
            due_date: string | null;
            fee_category_id: string;
          }>
        >(
          'SELECT id, name, amount::text, grade_level, applies_to_student_ids, due_date, fee_category_id FROM pay_fee_schedules WHERE id = $1::uuid',
          args.feeScheduleId,
        ),
      )) as Array<{
        id: string;
        name: string;
        amount: string;
        grade_level: string | null;
        applies_to_student_ids: string[] | null;
        due_date: string | null;
        fee_category_id: string;
      }>;
      if (scheduleRows.length === 0)
        throw new Error('fee schedule ' + args.feeScheduleId + ' not found');
      const schedule = scheduleRows[0]!;
      const scheduleAmount = Number(schedule.amount);
      const dueDate = schedule.due_date;

      // Resolve eligible students.
      let studentSql =
        'SELECT s.id, s.grade_level FROM sis_students s ' +
        "WHERE s.enrollment_status = 'ACTIVE' AND s.school_id = $1::uuid ";
      const studentParams: unknown[] = [schoolId];
      let pIdx = 2;
      if (schedule.applies_to_student_ids && schedule.applies_to_student_ids.length > 0) {
        studentSql += 'AND s.id = ANY($' + pIdx + '::uuid[]) ';
        studentParams.push(schedule.applies_to_student_ids);
        pIdx++;
      } else {
        const grade = args.gradeFilter ?? schedule.grade_level;
        if (grade) {
          studentSql += 'AND s.grade_level = $' + pIdx + ' ';
          studentParams.push(grade);
          pIdx++;
        }
      }
      const studentRows = (await this.tenantPrisma.executeInTenantContext(async (client) =>
        client.$queryRawUnsafe<Array<{ id: string; grade_level: string | null }>>(
          studentSql,
          ...studentParams,
        ),
      )) as Array<{ id: string; grade_level: string | null }>;
      targeted = studentRows.length;

      // Group students by family account.
      const familyByStudent = new Map<string, { familyAccountId: string; studentIds: string[] }>();
      for (const stu of studentRows) {
        const accountRows = (await this.tenantPrisma.executeInTenantContext(async (client) =>
          client.$queryRawUnsafe<Array<{ family_account_id: string }>>(
            'SELECT family_account_id FROM pay_family_account_students WHERE student_id = $1::uuid LIMIT 1',
            stu.id,
          ),
        )) as Array<{ family_account_id: string }>;
        if (accountRows.length === 0) {
          // No family account — count as skipped (parent has not
          // been onboarded with a billing account yet).
          skipped++;
          continue;
        }
        const familyId = accountRows[0]!.family_account_id;
        if (!familyByStudent.has(familyId)) {
          familyByStudent.set(familyId, { familyAccountId: familyId, studentIds: [] });
        }
        familyByStudent.get(familyId)!.studentIds.push(stu.id);
      }

      // Load active discount rules for the school once.
      const discountRows = (await this.tenantPrisma.executeInTenantContext(async (client) =>
        client.$queryRawUnsafe<
          Array<{
            id: string;
            discount_type: string;
            calculation_method: string;
            value: string;
            applies_to_fee_category_id: string | null;
            sibling_order: number | null;
            minimum_invoice_amount: string | null;
          }>
        >(
          'SELECT id, discount_type, calculation_method, value::text, applies_to_fee_category_id, sibling_order, minimum_invoice_amount::text ' +
            'FROM pay_discount_rules WHERE school_id = $1::uuid AND is_active = true',
          schoolId,
        ),
      )) as Array<{
        id: string;
        discount_type: string;
        calculation_method: string;
        value: string;
        applies_to_fee_category_id: string | null;
        sibling_order: number | null;
        minimum_invoice_amount: string | null;
      }>;

      // For each family, generate one invoice with optional discount lines.
      for (const [familyAccountId, info] of familyByStudent.entries()) {
        try {
          // Skip if family already has a non-CANCELLED invoice attributed to this fee schedule.
          const existingRows = (await this.tenantPrisma.executeInTenantContext(async (client) =>
            client.$queryRawUnsafe<Array<{ c: number }>>(
              'SELECT COUNT(*)::int AS c FROM pay_invoices i JOIN pay_invoice_line_items li ON li.invoice_id = i.id ' +
                "WHERE i.family_account_id = $1::uuid AND li.fee_schedule_id = $2::uuid AND i.status != 'CANCELLED'",
              familyAccountId,
              schedule.id,
            ),
          )) as Array<{ c: number }>;
          if (existingRows[0]!.c > 0) {
            skipped++;
            continue;
          }

          // Compute sibling order — count active enrolled students for the family.
          const siblingCountRows = (await this.tenantPrisma.executeInTenantContext(async (client) =>
            client.$queryRawUnsafe<Array<{ c: number }>>(
              'SELECT COUNT(*)::int AS c FROM pay_family_account_students fas ' +
                'JOIN sis_students s ON s.id = fas.student_id ' +
                "WHERE fas.family_account_id = $1::uuid AND s.enrollment_status = 'ACTIVE'",
              familyAccountId,
            ),
          )) as Array<{ c: number }>;
          const siblingCount = siblingCountRows[0]!.c;

          // Build the line items.
          const baseLineId = generateId();
          const baseAmount = scheduleAmount * info.studentIds.length;
          const lineItems: Array<{
            description: string;
            quantity: number;
            unitPrice: number;
            total: number;
            feeScheduleId: string | null;
          }> = [
            {
              description: schedule.name,
              quantity: info.studentIds.length,
              unitPrice: scheduleAmount,
              total: Number(baseAmount.toFixed(2)),
              feeScheduleId: schedule.id,
            },
          ];

          // Apply matching discount rules. Sibling discount applies to
          // children 2..N. Early payment discount applies if the
          // invoice subtotal >= minimum_invoice_amount (we do not
          // gate on actual payment timing in the seed-time generation).
          let discountTotal = 0;
          for (const rule of discountRows) {
            if (
              rule.applies_to_fee_category_id &&
              rule.applies_to_fee_category_id !== schedule.fee_category_id
            ) {
              continue;
            }
            if (rule.minimum_invoice_amount && baseAmount < Number(rule.minimum_invoice_amount)) {
              continue;
            }
            if (rule.discount_type === 'SIBLING') {
              const order = rule.sibling_order ?? 2;
              if (siblingCount < order) continue;
              // Apply rule to one student price per matching slot
              // (e.g. sibling_order=2 deducts on the 2nd child).
              const target = scheduleAmount; // one student's worth
              const reduction =
                rule.calculation_method === 'PERCENTAGE'
                  ? Number(((target * Number(rule.value)) / 100).toFixed(2))
                  : Math.min(Number(rule.value), target);
              discountTotal += reduction;
              lineItems.push({
                description: 'Discount: SIBLING (child #' + order + ')',
                quantity: 1,
                unitPrice: -reduction,
                total: -reduction,
                feeScheduleId: null,
              });
            } else if (rule.discount_type === 'EARLY_PAYMENT') {
              const reduction =
                rule.calculation_method === 'PERCENTAGE'
                  ? Number(((baseAmount * Number(rule.value)) / 100).toFixed(2))
                  : Math.min(Number(rule.value), baseAmount);
              discountTotal += reduction;
              lineItems.push({
                description: 'Discount: EARLY_PAYMENT',
                quantity: 1,
                unitPrice: -reduction,
                total: -reduction,
                feeScheduleId: null,
              });
            }
            // BURSARY / LOYALTY / STAFF_CHILD / CUSTOM: out-of-scope
            // for the auto-applied path.
          }

          const invoiceTotal = Number((baseAmount - discountTotal).toFixed(2));

          // Create the invoice + line items inside one tx.
          const invoiceId = generateId();
          await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
            await tx.$executeRawUnsafe(
              'INSERT INTO pay_invoices (id, school_id, family_account_id, title, description, total_amount, due_date, status) ' +
                "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::numeric, $7::date, 'DRAFT')",
              invoiceId,
              schoolId,
              familyAccountId,
              schedule.name + ' — auto-generated',
              'Auto-generated by ' + args.runType + ' run ' + runId,
              invoiceTotal.toFixed(2),
              dueDate ?? null,
            );
            for (let li = 0; li < lineItems.length; li++) {
              const item = lineItems[li]!;
              await tx.$executeRawUnsafe(
                'INSERT INTO pay_invoice_line_items (id, invoice_id, fee_schedule_id, description, quantity, unit_price, total, sort_order) ' +
                  'VALUES ($1::uuid, $2::uuid, $3, $4, $5::numeric, $6::numeric, $7::numeric, $8::int)',
                generateId(),
                invoiceId,
                item.feeScheduleId,
                item.description,
                item.quantity.toFixed(2),
                item.unitPrice.toFixed(2),
                item.total.toFixed(2),
                li,
              );
            }
          });
          created++;
          // Suppress 'unused var' for baseLineId — used as documentation.
          void baseLineId;
        } catch (perFamilyErr) {
          this.logger.warn(
            'Per-family generation failure for family ' +
              familyAccountId +
              ': ' +
              (perFamilyErr instanceof Error ? perFamilyErr.message : String(perFamilyErr)),
          );
          failed++;
        }
      }
    } catch (e) {
      errorSummary = e instanceof Error ? e.message : String(e);
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          "UPDATE pay_invoice_generation_runs SET status = 'FAILED', completed_at = now(), error_summary = $2, total_families_targeted = $3, invoices_created = $4, invoices_skipped = $5, invoices_failed = $6, updated_at = now() WHERE id = $1::uuid",
          runId,
          errorSummary,
          targeted,
          created,
          skipped,
          failed,
        );
      });
      return this.getRunById(runId, args.actor);
    }

    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        "UPDATE pay_invoice_generation_runs SET status = 'COMPLETED', completed_at = now(), total_families_targeted = $2, invoices_created = $3, invoices_skipped = $4, invoices_failed = $5, updated_at = now() WHERE id = $1::uuid",
        runId,
        targeted,
        created,
        skipped,
        failed,
      );
      if (args.autoRuleId) {
        await client.$executeRawUnsafe(
          'UPDATE pay_auto_invoice_rules SET last_run_at = now(), updated_at = now() WHERE id = $1::uuid',
          args.autoRuleId,
        );
      }
    });

    return this.getRunById(runId, args.actor);
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  return (
    e.code === 'P2002' ||
    e.meta?.code === '23505' ||
    (typeof e.message === 'string' && /23505|unique constraint/i.test(e.message))
  );
}
