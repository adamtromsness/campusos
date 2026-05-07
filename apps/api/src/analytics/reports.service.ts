import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { PermissionCheckService } from '../iam/permission-check.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { DashboardService } from './dashboard.service';
import type {
  CreateReportDefinitionDto,
  CreateScheduledReportDto,
  ReportDefinitionDto,
  ReportRunDto,
  RunReportDto,
  ScheduledReportDto,
  UpdateReportDefinitionDto,
  UpdateScheduledReportDto,
} from './dto/analytics.dto';

/**
 * ReportDefinitionService — admin-only CRUD on rpt_report_definitions.
 * template_config JSONB carries the renderer instructions
 * (data_source, filters, columns, grouping).
 */
@Injectable()
export class ReportDefinitionService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  private async assertWriter(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'rpt-004:write',
    ]);
    if (!ok) {
      throw new ForbiddenException('Report engine writes require the rpt-004:write permission.');
    }
  }

  async list(actor: ResolvedActor): Promise<ReportDefinitionDto[]> {
    if (actor.isSchoolAdmin) {
      // Admin path; otherwise the @RequirePermission('rpt-004:read') gate
      // is the actual access guard at the controller.
    }
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text, school_id::text AS school_id, name, description, report_type,
                template_config, is_state_report, is_active, created_by::text AS created_by,
                created_at::text AS created_at, updated_at::text AS updated_at
         FROM rpt_report_definitions
         WHERE school_id = $1::uuid AND is_active = true
         ORDER BY name`,
        tenant.schoolId,
      );
    })) as Array<{
      id: string;
      school_id: string;
      name: string;
      description: string | null;
      report_type: string;
      template_config: Record<string, unknown>;
      is_state_report: boolean;
      is_active: boolean;
      created_by: string | null;
      created_at: string;
      updated_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      schoolId: r.school_id,
      name: r.name,
      description: r.description,
      reportType: r.report_type,
      templateConfig: r.template_config ?? {},
      isStateReport: r.is_state_report,
      isActive: r.is_active,
      createdBy: r.created_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  async getById(id: string): Promise<ReportDefinitionDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text, school_id::text AS school_id, name, description, report_type,
                template_config, is_state_report, is_active, created_by::text AS created_by,
                created_at::text AS created_at, updated_at::text AS updated_at
         FROM rpt_report_definitions
         WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
        id,
        tenant.schoolId,
      );
    })) as Array<{
      id: string;
      school_id: string;
      name: string;
      description: string | null;
      report_type: string;
      template_config: Record<string, unknown>;
      is_state_report: boolean;
      is_active: boolean;
      created_by: string | null;
      created_at: string;
      updated_at: string;
    }>;
    if (rows.length === 0) throw new NotFoundException('Report definition not found');
    const r = rows[0]!;
    return {
      id: r.id,
      schoolId: r.school_id,
      name: r.name,
      description: r.description,
      reportType: r.report_type,
      templateConfig: r.template_config ?? {},
      isStateReport: r.is_state_report,
      isActive: r.is_active,
      createdBy: r.created_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  /**
   * REVIEW-CYCLE29 MAJOR 7 — kept in sync with ALLOWED_DATA_SOURCES on
   * ReportRunService. Validates that template_config.data_source resolves
   * to a known rpt_* read model BEFORE the definition lands so a
   * malformed report cannot be saved and only fail at run time.
   */
  static readonly ALLOWED_DATA_SOURCES: readonly string[] = [
    'rpt_daily_attendance_summary',
    'rpt_student_academic_summary',
    'rpt_class_performance_summary',
    'rpt_staff_summary',
    'rpt_school_summary',
    'rpt_district_summary',
    'rpt_district_school_comparison',
    'rpt_wellbeing_trends',
    'rpt_fin_aged_debtors',
  ];

  private validateTemplateConfig(input: unknown): void {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new BadRequestException('templateConfig must be an object.');
    }
    const ds = (input as Record<string, unknown>).data_source;
    if (typeof ds !== 'string' || ds.length === 0) {
      throw new BadRequestException(
        `templateConfig.data_source is required (string). Allowed values: ${ReportDefinitionService.ALLOWED_DATA_SOURCES.join(', ')}`,
      );
    }
    if (!ReportDefinitionService.ALLOWED_DATA_SOURCES.includes(ds)) {
      throw new BadRequestException(
        `templateConfig.data_source "${ds}" is not allowed. Allowed values: ${ReportDefinitionService.ALLOWED_DATA_SOURCES.join(', ')}`,
      );
    }
  }

  async create(
    actor: ResolvedActor,
    input: CreateReportDefinitionDto,
  ): Promise<ReportDefinitionDto> {
    await this.assertWriter(actor);
    // REVIEW-CYCLE29 MAJOR 7 — validate template_config at create time
    this.validateTemplateConfig(input.templateConfig);
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          `INSERT INTO rpt_report_definitions (id, school_id, name, description, report_type, template_config, is_active, created_by)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7, $8::uuid)`,
          id,
          tenant.schoolId,
          input.name,
          input.description ?? null,
          input.reportType,
          JSON.stringify(input.templateConfig),
          input.isActive ?? true,
          actor.accountId,
        );
      });
    } catch (err: unknown) {
      const e = err as { meta?: { code?: string }; code?: string };
      if (e.meta?.code === '23505' || e.code === 'P2002') {
        throw new BadRequestException(
          `A report definition named "${input.name}" already exists in this school.`,
        );
      }
      throw err;
    }
    return this.getById(id);
  }

  async update(
    actor: ResolvedActor,
    id: string,
    input: UpdateReportDefinitionDto,
  ): Promise<ReportDefinitionDto> {
    await this.assertWriter(actor);
    const tenant = getCurrentTenant();
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    if (input.name !== undefined) {
      sets.push(`name = $${i++}`);
      params.push(input.name);
    }
    if (input.description !== undefined) {
      sets.push(`description = $${i++}`);
      params.push(input.description);
    }
    if (input.reportType !== undefined) {
      sets.push(`report_type = $${i++}`);
      params.push(input.reportType);
    }
    if (input.templateConfig !== undefined) {
      // REVIEW-CYCLE29 MAJOR 7 — validate template_config at update too
      this.validateTemplateConfig(input.templateConfig);
      sets.push(`template_config = $${i++}::jsonb`);
      params.push(JSON.stringify(input.templateConfig));
    }
    if (input.isActive !== undefined) {
      sets.push(`is_active = $${i++}`);
      params.push(input.isActive);
    }
    if (sets.length === 0) return this.getById(id);
    sets.push(`updated_at = now()`);
    const updated = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$executeRawUnsafe(
        `UPDATE rpt_report_definitions SET ${sets.join(', ')} WHERE id = $${i}::uuid AND school_id = $${i + 1}::uuid`,
        ...params,
        id,
        tenant.schoolId,
      );
    })) as number;
    if (updated === 0) throw new NotFoundException('Report definition not found');
    return this.getById(id);
  }
}

/**
 * ReportRunService — on-demand report generation. POST /reports/:id/run
 * creates a rpt_report_runs row in PENDING, queries the rpt_* table per
 * the template_config, writes a CSV stub to the output_s3_key, flips
 * the run to COMPLETE with row_count.
 *
 * For Cycle 29 the actual S3 upload is stubbed — output_s3_key is
 * recorded so a future S3 worker (Phase 2) can backfill.
 */
@Injectable()
export class ReportRunService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly definitions: ReportDefinitionService,
  ) {}

  async listForDefinition(definitionId: string): Promise<ReportRunDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT r.id::text, r.report_definition_id::text AS report_definition_id,
                d.name AS report_name,
                r.run_by::text AS run_by,
                (SELECT first_name || ' ' || last_name FROM platform.iam_person ip
                  JOIN platform.platform_users pu ON pu.person_id = ip.id
                  WHERE pu.id = r.run_by) AS run_by_name,
                r.status, r.output_format, r.output_s3_key, r.row_count,
                r.error_message, r.started_at::text AS started_at,
                r.generated_at::text AS generated_at
         FROM rpt_report_runs r
         JOIN rpt_report_definitions d ON d.id = r.report_definition_id
         WHERE r.report_definition_id = $1::uuid
         ORDER BY r.started_at DESC LIMIT 50`,
        definitionId,
      );
    })) as Array<{
      id: string;
      report_definition_id: string;
      report_name: string | null;
      run_by: string | null;
      run_by_name: string | null;
      status: string;
      output_format: string;
      output_s3_key: string | null;
      row_count: number | null;
      error_message: string | null;
      started_at: string;
      generated_at: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      reportDefinitionId: r.report_definition_id,
      reportName: r.report_name,
      runBy: r.run_by,
      runByName: r.run_by_name,
      status: r.status as ReportRunDto['status'],
      outputFormat: r.output_format as ReportRunDto['outputFormat'],
      outputS3Key: r.output_s3_key,
      rowCount: r.row_count === null ? null : Number(r.row_count),
      errorMessage: r.error_message,
      startedAt: r.started_at,
      generatedAt: r.generated_at,
    }));
  }

  async run(
    actor: ResolvedActor,
    definitionId: string,
    input: RunReportDto = {},
  ): Promise<ReportRunDto> {
    const def = await this.definitions.getById(definitionId);
    if (!def.isActive) throw new BadRequestException('Report definition is inactive');

    const tenant = getCurrentTenant();
    const runId = generateId();
    const outputFormat = input.outputFormat ?? 'CSV';
    const s3Key = `s3://campusos-reports/tenant_${tenant.schoolId.slice(0, 8)}/${def.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${new Date().toISOString().slice(0, 10)}-${runId.slice(0, 8)}.${outputFormat.toLowerCase()}`;

    // Insert PENDING row up front so a failure leaves an audit trail.
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        `INSERT INTO rpt_report_runs (id, report_definition_id, run_by, status, output_format, started_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'PENDING', $4, now())`,
        runId,
        definitionId,
        actor.accountId,
        outputFormat,
      );
    });

    try {
      // Resolve data source from template_config.data_source. The
      // allowlist lives on ReportDefinitionService so create-time
      // validation (REVIEW-CYCLE29 MAJOR 7) and run-time defence-in-depth
      // share the same source of truth.
      const allowedSources = ReportDefinitionService.ALLOWED_DATA_SOURCES;
      const source =
        typeof def.templateConfig.data_source === 'string'
          ? (def.templateConfig.data_source as string)
          : null;
      if (!source || !allowedSources.includes(source)) {
        throw new BadRequestException(
          `Report template_config.data_source must be one of: ${allowedSources.join(', ')}.`,
        );
      }

      const countRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          `SELECT count(*)::int AS n FROM ${source} WHERE school_id IS NULL OR school_id = $1::uuid`,
          tenant.schoolId,
        );
      })) as Array<{ n: number }>;
      const rowCount = Number(countRows[0]!.n);

      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          `UPDATE rpt_report_runs SET status = 'COMPLETE', row_count = $1, output_s3_key = $2, generated_at = now() WHERE id = $3::uuid`,
          rowCount,
          s3Key,
          runId,
        );
      });
    } catch (err: unknown) {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          `UPDATE rpt_report_runs SET status = 'FAILED', error_message = $1, generated_at = now() WHERE id = $2::uuid`,
          (err as Error).message,
          runId,
        );
      });
      throw err;
    }

    const out = (await this.listForDefinition(definitionId)).find((r) => r.id === runId);
    if (!out) throw new NotFoundException('Run not found after completion');
    return out;
  }
}

/**
 * ScheduledReportWorker — first cron-driven worker in CampusOS.
 *
 * Polls rpt_scheduled_reports WHERE next_run_at <= now() AND
 * is_active=true. For each row: looks up the matching report definition
 * by template_name OR report_params.definition_id, runs the report via
 * ReportRunService, updates last_run_at + last_run_status, computes
 * next_run_at from schedule_cron (timezone aware via cron-parser).
 *
 * Cycle 29 ships the trigger surface (POST /scheduled-reports/:id/run-now
 * + a tickRunDue helper). The actual cron polling loop is started by the
 * NestJS module via setInterval (5 minute tick) — production deployment
 * uses a dedicated worker container per ADR-049.
 */
@Injectable()
export class ScheduledReportWorker {
  private readonly logger = new Logger(ScheduledReportWorker.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
    private readonly runs: ReportRunService,
    private readonly dashboards: DashboardService,
  ) {}

  private async assertWriter(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'rpt-004:write',
    ]);
    if (!ok) {
      throw new ForbiddenException('Scheduled-report writes require the rpt-004:write permission.');
    }
  }

  async list(): Promise<ScheduledReportDto[]> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text, school_id::text AS school_id, report_name, template_name, report_params,
                schedule_cron, timezone, delivery_channel, recipient_ids, output_format, is_active,
                last_run_at::text AS last_run_at, last_run_status,
                next_run_at::text AS next_run_at, created_by::text AS created_by,
                created_at::text AS created_at, updated_at::text AS updated_at
         FROM rpt_scheduled_reports
         WHERE school_id = $1::uuid
         ORDER BY next_run_at NULLS LAST, report_name`,
        tenant.schoolId,
      );
    })) as Array<{
      id: string;
      school_id: string;
      report_name: string;
      template_name: string;
      report_params: Record<string, unknown>;
      schedule_cron: string;
      timezone: string;
      delivery_channel: string;
      recipient_ids: string[];
      output_format: string;
      is_active: boolean;
      last_run_at: string | null;
      last_run_status: string | null;
      next_run_at: string | null;
      created_by: string | null;
      created_at: string;
      updated_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      schoolId: r.school_id,
      reportName: r.report_name,
      templateName: r.template_name,
      reportParams: r.report_params ?? {},
      scheduleCron: r.schedule_cron,
      timezone: r.timezone,
      deliveryChannel: r.delivery_channel as ScheduledReportDto['deliveryChannel'],
      recipientIds: r.recipient_ids ?? [],
      outputFormat: r.output_format as ScheduledReportDto['outputFormat'],
      isActive: r.is_active,
      lastRunAt: r.last_run_at,
      lastRunStatus: r.last_run_status as ScheduledReportDto['lastRunStatus'],
      nextRunAt: r.next_run_at,
      createdBy: r.created_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  async create(actor: ResolvedActor, input: CreateScheduledReportDto): Promise<ScheduledReportDto> {
    await this.assertWriter(actor);
    // REVIEW-CYCLE29 BLOCKING 3 — recipients must project into this tenant
    const recipients = input.recipientIds ?? [];
    await this.dashboards.assertAccountsInCurrentTenant(recipients, 'recipientIds');
    // REVIEW-CYCLE29 BLOCKING 4 — pass timezone into next-run computation
    const timezone = input.timezone ?? 'UTC';
    this.assertValidTimezone(timezone);
    const tenant = getCurrentTenant();
    const id = generateId();
    const nextRun = this.computeNextRun(input.scheduleCron, timezone);
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          `INSERT INTO rpt_scheduled_reports (id, school_id, report_name, template_name, report_params, schedule_cron, timezone, delivery_channel, recipient_ids, output_format, is_active, next_run_at, created_by)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6, $7, $8, $9::uuid[], $10, $11, $12::timestamptz, $13::uuid)`,
          id,
          tenant.schoolId,
          input.reportName,
          input.templateName,
          JSON.stringify(input.reportParams ?? {}),
          input.scheduleCron,
          timezone,
          input.deliveryChannel ?? 'EMAIL',
          recipients,
          input.outputFormat ?? 'CSV',
          input.isActive ?? true,
          nextRun.toISOString(),
          actor.accountId,
        );
      });
    } catch (err: unknown) {
      const e = err as { meta?: { code?: string }; code?: string };
      if (e.meta?.code === '23505' || e.code === 'P2002') {
        throw new BadRequestException(
          `A scheduled report named "${input.reportName}" already exists in this school.`,
        );
      }
      throw err;
    }
    const list = await this.list();
    const found = list.find((r) => r.id === id);
    if (!found) throw new NotFoundException('Scheduled report not found after create');
    return found;
  }

  async update(
    actor: ResolvedActor,
    id: string,
    input: UpdateScheduledReportDto,
  ): Promise<ScheduledReportDto> {
    await this.assertWriter(actor);
    const tenant = getCurrentTenant();

    // REVIEW-CYCLE29 BLOCKING 4 — re-compute next_run_at against the
    // effective timezone (existing OR the supplied one). Load the
    // current row first so we can resolve the post-patch shape.
    const existingRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT schedule_cron, timezone FROM rpt_scheduled_reports WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
        id,
        tenant.schoolId,
      );
    })) as Array<{ schedule_cron: string; timezone: string }>;
    if (existingRows.length === 0) throw new NotFoundException('Scheduled report not found');
    const existing = existingRows[0]!;

    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    if (input.reportName !== undefined) {
      sets.push(`report_name = $${i++}`);
      params.push(input.reportName);
    }
    if (input.templateName !== undefined) {
      sets.push(`template_name = $${i++}`);
      params.push(input.templateName);
    }
    if (input.reportParams !== undefined) {
      sets.push(`report_params = $${i++}::jsonb`);
      params.push(JSON.stringify(input.reportParams));
    }

    // Compute next_run_at if EITHER scheduleCron or timezone changed.
    if (input.scheduleCron !== undefined || input.timezone !== undefined) {
      const effectiveCron = input.scheduleCron ?? existing.schedule_cron;
      const effectiveTimezone = input.timezone ?? existing.timezone;
      this.assertValidTimezone(effectiveTimezone);
      if (input.scheduleCron !== undefined) {
        sets.push(`schedule_cron = $${i++}`);
        params.push(input.scheduleCron);
      }
      if (input.timezone !== undefined) {
        sets.push(`timezone = $${i++}`);
        params.push(input.timezone);
      }
      sets.push(`next_run_at = $${i++}::timestamptz`);
      params.push(this.computeNextRun(effectiveCron, effectiveTimezone).toISOString());
    }

    if (input.deliveryChannel !== undefined) {
      sets.push(`delivery_channel = $${i++}`);
      params.push(input.deliveryChannel);
    }
    if (input.recipientIds !== undefined) {
      // REVIEW-CYCLE29 BLOCKING 3 — validate recipients in current tenant
      await this.dashboards.assertAccountsInCurrentTenant(input.recipientIds, 'recipientIds');
      sets.push(`recipient_ids = $${i++}::uuid[]`);
      params.push(input.recipientIds);
    }
    if (input.outputFormat !== undefined) {
      sets.push(`output_format = $${i++}`);
      params.push(input.outputFormat);
    }
    if (input.isActive !== undefined) {
      sets.push(`is_active = $${i++}`);
      params.push(input.isActive);
    }
    if (sets.length === 0) {
      const list = await this.list();
      const found = list.find((r) => r.id === id);
      if (!found) throw new NotFoundException('Scheduled report not found');
      return found;
    }
    sets.push(`updated_at = now()`);
    const updated = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$executeRawUnsafe(
        `UPDATE rpt_scheduled_reports SET ${sets.join(', ')} WHERE id = $${i}::uuid AND school_id = $${i + 1}::uuid`,
        ...params,
        id,
        tenant.schoolId,
      );
    })) as number;
    if (updated === 0) throw new NotFoundException('Scheduled report not found');
    const list = await this.list();
    const found = list.find((r) => r.id === id);
    if (!found) throw new NotFoundException('Scheduled report not found after update');
    return found;
  }

  /**
   * Trigger a scheduled report immediately. Updates last_run_at +
   * last_run_status + computes next_run_at. Used by the admin "Run now"
   * button + the future cron tick worker.
   */
  async runNow(actor: ResolvedActor, id: string): Promise<ScheduledReportDto> {
    await this.assertWriter(actor);
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT report_name, template_name, schedule_cron, timezone, output_format, recipient_ids, report_params
         FROM rpt_scheduled_reports
         WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
        id,
        tenant.schoolId,
      );
    })) as Array<{
      report_name: string;
      template_name: string;
      schedule_cron: string;
      timezone: string;
      output_format: string;
      recipient_ids: string[];
      report_params: Record<string, unknown>;
    }>;
    if (rows.length === 0) throw new NotFoundException('Scheduled report not found');
    const r = rows[0]!;

    // Resolve the matching report definition by name (template_name),
    // OR the report_params.definition_id if explicitly set.
    let definitionId: string | null = null;
    if (typeof r.report_params?.definition_id === 'string') {
      definitionId = r.report_params.definition_id as string;
    } else {
      const defRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          `SELECT id::text FROM rpt_report_definitions WHERE school_id = $1::uuid AND name = $2 AND is_active = true LIMIT 1`,
          tenant.schoolId,
          r.template_name,
        );
      })) as Array<{ id: string }>;
      definitionId = defRows[0]?.id ?? null;
    }
    if (!definitionId) {
      throw new BadRequestException(
        `No active report definition matches template_name="${r.template_name}". Set report_params.definition_id explicitly or create a matching definition.`,
      );
    }

    let runStatus: 'SUCCESS' | 'FAILED' = 'SUCCESS';
    try {
      await this.runs.run(actor, definitionId, {
        outputFormat: r.output_format as 'CSV' | 'PDF' | 'XLSX',
      });
    } catch (err) {
      runStatus = 'FAILED';
      this.logger.error(`Scheduled report ${id} run failed: ${(err as Error).message}`);
    }

    // REVIEW-CYCLE29 BLOCKING 4 — apply the stored timezone
    const next = this.computeNextRun(r.schedule_cron, r.timezone);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        `UPDATE rpt_scheduled_reports SET last_run_at = now(), last_run_status = $1, next_run_at = $2::timestamptz, updated_at = now()
         WHERE id = $3::uuid`,
        runStatus,
        next.toISOString(),
        id,
      );
    });

    const list = await this.list();
    const found = list.find((rr) => rr.id === id);
    if (!found) throw new NotFoundException('Scheduled report not found after run');
    return found;
  }

  /**
   * REVIEW-CYCLE29 BLOCKING 4 — validate IANA timezone via Intl. Throws
   * if the runtime can't construct a DateTimeFormat for the timezone.
   */
  private assertValidTimezone(timezone: string): void {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    } catch {
      throw new BadRequestException(
        `timezone "${timezone}" is not a valid IANA timezone identifier (e.g. "UTC", "America/Chicago", "Europe/London").`,
      );
    }
  }

  /**
   * REVIEW-CYCLE29 BLOCKING 4 — TIMEZONE-AWARE next-run computation.
   *
   * Walks forward from "now" 1 minute at a time, evaluating the cron
   * expression against the WALL CLOCK in the supplied timezone (via
   * Intl.DateTimeFormat). Returns the first UTC instant whose
   * timezone-local representation matches the cron pattern.
   *
   * Supports the 5-field shape (minute hour day-of-month month day-of-week)
   * with comma lists, ranges, * and `* / N` step values. Names like MON
   * are accepted in the day-of-week field.
   *
   * Bounded to 366 days lookahead (the cap protects against pathological
   * expressions that match nothing — e.g. minute=99). Falls back to
   * "24 hours from now" only when the cron is structurally invalid.
   */
  private computeNextRun(cron: string, timezone: string = 'UTC'): Date {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) {
      const fallback = new Date(Date.now() + 24 * 60 * 60 * 1000);
      return fallback;
    }
    const [mField, hField, domField, monField, dowField] = parts as [
      string,
      string,
      string,
      string,
      string,
    ];
    let minutes: Set<number>;
    let hours: Set<number>;
    let doms: Set<number>;
    let months: Set<number>;
    let dows: Set<number>;
    try {
      minutes = this.parseField(mField, 0, 59);
      hours = this.parseField(hField, 0, 23);
      doms = this.parseField(domField, 1, 31);
      months = this.parseField(monField, 1, 12);
      dows = this.parseField(dowField, 0, 6, {
        SUN: 0,
        MON: 1,
        TUE: 2,
        WED: 3,
        THU: 4,
        FRI: 5,
        SAT: 6,
      });
    } catch {
      const fallback = new Date(Date.now() + 24 * 60 * 60 * 1000);
      return fallback;
    }

    // Start from the next minute boundary.
    const start = new Date(Math.ceil(Date.now() / 60000) * 60000);
    const horizonMs = 366 * 24 * 60 * 60 * 1000;
    for (let offset = 0; offset < horizonMs; offset += 60_000) {
      const candidate = new Date(start.getTime() + offset);
      const local = this.zonedComponents(candidate, timezone);
      // Standard cron rule: when both DOM and DOW are restricted, EITHER
      // matches; otherwise both must match.
      const domRestricted = domField !== '*';
      const dowRestricted = dowField !== '*';
      const dayMatches = (() => {
        const domOk = doms.has(local.dom);
        const dowOk = dows.has(local.dow);
        if (domRestricted && dowRestricted) return domOk || dowOk;
        return domOk && dowOk;
      })();
      if (
        minutes.has(local.minute) &&
        hours.has(local.hour) &&
        months.has(local.month) &&
        dayMatches
      ) {
        return candidate;
      }
    }
    // No match within the lookahead — fall back to 24 hours from now.
    return new Date(Date.now() + 24 * 60 * 60 * 1000);
  }

  /**
   * Extract calendar components in a target timezone using Intl.DateTimeFormat.
   * Used by the cron walker to evaluate the cron pattern against wall time.
   */
  private zonedComponents(
    when: Date,
    timezone: string,
  ): { minute: number; hour: number; dom: number; month: number; dow: number } {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
    const parts = fmt.formatToParts(when);
    const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
    const weekdayMap: Record<string, number> = {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
    };
    let hour = parseInt(get('hour'), 10);
    if (hour === 24) hour = 0; // Intl edge case: midnight in some locales returns "24"
    return {
      minute: parseInt(get('minute'), 10),
      hour,
      dom: parseInt(get('day'), 10),
      month: parseInt(get('month'), 10),
      dow: weekdayMap[get('weekday')] ?? 0,
    };
  }

  /**
   * Parse a cron field into the set of integer values it matches.
   * Supports `*`, lists `1,2,3`, ranges `1-5`, steps `* / N` or `0-30 / 5`,
   * and named tokens (MON/TUE/...) when nameMap is supplied.
   */
  private parseField(
    field: string,
    min: number,
    max: number,
    nameMap?: Record<string, number>,
  ): Set<number> {
    const out = new Set<number>();
    const tokens = field.split(',');
    for (const tok of tokens) {
      let body = tok;
      let step = 1;
      const slashIdx = body.indexOf('/');
      if (slashIdx >= 0) {
        step = parseInt(body.slice(slashIdx + 1), 10);
        body = body.slice(0, slashIdx);
        if (!Number.isFinite(step) || step <= 0) {
          throw new Error(`bad step in cron field "${field}"`);
        }
      }
      let lo: number;
      let hi: number;
      if (body === '*' || body === '') {
        lo = min;
        hi = max;
      } else if (body.includes('-')) {
        const [aRaw, bRaw] = body.split('-');
        lo = this.parseToken(aRaw!, nameMap);
        hi = this.parseToken(bRaw!, nameMap);
      } else {
        lo = this.parseToken(body, nameMap);
        hi = lo;
      }
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < min || hi > max || lo > hi) {
        throw new Error(`bad range "${body}" in cron field "${field}" [${min}..${max}]`);
      }
      for (let v = lo; v <= hi; v += step) out.add(v);
    }
    return out;
  }

  private parseToken(s: string, nameMap?: Record<string, number>): number {
    const trimmed = s.trim().toUpperCase();
    if (nameMap && trimmed in nameMap) return nameMap[trimmed]!;
    return parseInt(trimmed, 10);
  }
}
