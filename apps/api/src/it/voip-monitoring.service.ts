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
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import type {
  AcknowledgeAlertDto,
  AssignPhoneExtensionDto,
  ConfigDocCategory,
  ConfigDocDto,
  CreateConfigDocDto,
  CreateMonitoringCheckDto,
  CreatePhoneExtensionDto,
  MonitoringAlertDto,
  MonitoringCheckDto,
  PhoneExtensionDto,
  RecordCheckResultDto,
  UpdateConfigDocDto,
  PatchInfrastructureItemDto,
  UpdateMonitoringCheckDto,
  UpdatePhoneExtensionDto,
} from './dto/it.dto';

/**
 * P2-20a — IT Advanced VOIP / Documentation / Monitoring /
 * Infrastructure.
 *
 *   PhoneExtensionService   VOIP extension directory CRUD plus
 *                           assign / unassign helpers.
 *
 *   ConfigDocumentationService  Versioned IT config docs. Update
 *                               increments version atomically;
 *                               diagram is a signed-S3-key.
 *
 *   MonitoringService       Uptime monitoring checks + alerts. The
 *                           keystone is /:id/result — records the
 *                           latest check result; on consecutive DOWN
 *                           results crossing the threshold creates a
 *                           tech_monitoring_alerts row and emits
 *                           tech.monitoring.alert; on HEALTHY after
 *                           DOWN, resolves the active alert with
 *                           a RECOVERED row + sets resolved_at.
 *
 *   InfrastructureService   Network item registry write-only (read
 *                           side stays on the Cycle 22
 *                           InfrastructureService). P2-20 adds the
 *                           last_checked_at column the existing
 *                           Cycle 22 service surfaces unchanged.
 */
@Injectable()
export class PhoneExtensionService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  private async assertItAdmin(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'it-007:write',
      'it-007:admin',
    ]);
    if (!ok) {
      throw new ForbiddenException('Only IT admins can manage phone extensions');
    }
    if (actor.personType !== 'STAFF') {
      throw new ForbiddenException('Only IT admins can manage phone extensions');
    }
  }

  private async assertItRead(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'it-007:read',
      'it-007:write',
      'it-007:admin',
    ]);
    if (!ok) {
      throw new ForbiddenException('IT-007:read required to view phone extension directory');
    }
  }

  private rowToDto(row: ExtensionRow): PhoneExtensionDto {
    return {
      id: row.id,
      schoolId: row.school_id,
      extensionNumber: row.extension_number,
      assignedTo: row.assigned_to ?? null,
      assignedToName:
        row.assigned_to_first || row.assigned_to_last
          ? `${row.assigned_to_first ?? ''} ${row.assigned_to_last ?? ''}`.trim()
          : null,
      displayName: row.display_name ?? null,
      location: row.location ?? null,
      department: row.department ?? null,
      extensionType: row.extension_type as PhoneExtensionDto['extensionType'],
      isActive: row.is_active,
      notes: row.notes ?? null,
    };
  }

  async list(
    actor: ResolvedActor,
    args: { search?: string; department?: string; includeInactive?: boolean } = {},
  ): Promise<PhoneExtensionDto[]> {
    await this.assertItRead(actor);
    const tenant = getCurrentTenant();
    const filters: string[] = ['e.school_id = $1::uuid'];
    const params: Array<string | boolean> = [tenant.schoolId];
    if (!args.includeInactive) {
      filters.push('e.is_active = true');
    }
    if (args.department) {
      params.push(args.department);
      filters.push(`e.department = $${params.length}`);
    }
    if (args.search) {
      params.push(`%${args.search}%`);
      const idx = params.length;
      filters.push(
        `(e.extension_number ILIKE $${idx} OR e.display_name ILIKE $${idx} OR e.location ILIKE $${idx} OR (ip.first_name || ' ' || ip.last_name) ILIKE $${idx})`,
      );
    }
    const sql = `${EXTENSION_SELECT_BASE} WHERE ${filters.join(' AND ')} ORDER BY e.extension_number`;
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(sql, ...params);
    })) as ExtensionRow[];
    return rows.map((r) => this.rowToDto(r));
  }

  async getById(id: string, actor: ResolvedActor): Promise<PhoneExtensionDto> {
    await this.assertItRead(actor);
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        EXTENSION_SELECT_BASE + ' WHERE e.id = $1::uuid AND e.school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      );
    })) as ExtensionRow[];
    if (rows.length === 0) throw new NotFoundException('Phone extension not found');
    return this.rowToDto(rows[0]!);
  }

  private async assertAssigneeInTenant(employeeId: string): Promise<void> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM hr_employees WHERE id = $1::uuid LIMIT 1',
        employeeId,
      );
    })) as Array<{ ok: number }>;
    if (rows.length === 0) {
      throw new BadRequestException('assignedTo does not match an employee in this school');
    }
  }

  async create(dto: CreatePhoneExtensionDto, actor: ResolvedActor): Promise<PhoneExtensionDto> {
    await this.assertItAdmin(actor);
    const tenant = getCurrentTenant();
    if (dto.assignedTo) await this.assertAssigneeInTenant(dto.assignedTo);
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO tech_phone_extensions (id, school_id, extension_number, assigned_to, display_name, location, department, extension_type, notes) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7, $8, $9)',
          id,
          tenant.schoolId,
          dto.extensionNumber,
          dto.assignedTo ?? null,
          dto.displayName ?? null,
          dto.location ?? null,
          dto.department ?? null,
          dto.extensionType,
          dto.notes ?? null,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException(
          `Extension number ${dto.extensionNumber} already exists in this school`,
        );
      }
      throw err;
    }
    return this.getById(id, actor);
  }

  async patch(
    id: string,
    dto: UpdatePhoneExtensionDto,
    actor: ResolvedActor,
  ): Promise<PhoneExtensionDto> {
    await this.assertItAdmin(actor);
    const tenant = getCurrentTenant();
    const sets: string[] = [];
    const params: Array<string | boolean | null> = [];
    function add(col: string, val: string | boolean | null | undefined) {
      if (val !== undefined) {
        params.push(val);
        sets.push(`${col} = $${params.length}`);
      }
    }
    add('extension_number', dto.extensionNumber);
    add('extension_type', dto.extensionType);
    add('display_name', dto.displayName);
    add('location', dto.location);
    add('department', dto.department);
    add('notes', dto.notes);
    add('is_active', dto.isActive);
    if (sets.length === 0) {
      return this.getById(id, actor);
    }
    sets.push('updated_at = now()');
    params.push(id);
    params.push(tenant.schoolId);
    const sql = `UPDATE tech_phone_extensions SET ${sets.join(', ')} WHERE id = $${params.length - 1}::uuid AND school_id = $${params.length}::uuid`;
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(sql, ...params);
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException('Extension number already exists in this school');
      }
      throw err;
    }
    return this.getById(id, actor);
  }

  async assign(
    id: string,
    dto: AssignPhoneExtensionDto,
    actor: ResolvedActor,
  ): Promise<PhoneExtensionDto> {
    await this.assertItAdmin(actor);
    const tenant = getCurrentTenant();
    await this.assertAssigneeInTenant(dto.assignedTo);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'UPDATE tech_phone_extensions SET assigned_to = $1::uuid, updated_at = now() WHERE id = $2::uuid AND school_id = $3::uuid',
        dto.assignedTo,
        id,
        tenant.schoolId,
      );
    });
    return this.getById(id, actor);
  }

  async unassign(id: string, actor: ResolvedActor): Promise<PhoneExtensionDto> {
    await this.assertItAdmin(actor);
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'UPDATE tech_phone_extensions SET assigned_to = NULL, updated_at = now() WHERE id = $1::uuid AND school_id = $2::uuid',
        id,
        tenant.schoolId,
      );
    });
    return this.getById(id, actor);
  }
}

const EXTENSION_SELECT_BASE = `
  SELECT
    e.id::text AS id,
    e.school_id::text AS school_id,
    e.extension_number,
    e.assigned_to::text AS assigned_to,
    ip.first_name AS assigned_to_first,
    ip.last_name AS assigned_to_last,
    e.display_name,
    e.location,
    e.department,
    e.extension_type,
    e.is_active,
    e.notes
  FROM tech_phone_extensions e
  LEFT JOIN hr_employees emp ON emp.id = e.assigned_to
  LEFT JOIN platform.iam_person ip ON ip.id = emp.person_id
`;

interface ExtensionRow {
  id: string;
  school_id: string;
  extension_number: string;
  assigned_to: string | null;
  assigned_to_first: string | null;
  assigned_to_last: string | null;
  display_name: string | null;
  location: string | null;
  department: string | null;
  extension_type: string;
  is_active: boolean;
  notes: string | null;
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e.code === 'P2010' || e.meta?.code === '23505') return true;
  if (e.code === '23505') return true;
  return typeof e.message === 'string' && e.message.includes('23505');
}

// ════════════════════════════════════════════════════════════
//  ConfigDocumentationService
// ════════════════════════════════════════════════════════════

@Injectable()
export class ConfigDocumentationService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  private async assertWrite(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'it-009:write',
      'it-009:admin',
    ]);
    if (!ok) {
      throw new ForbiddenException('Only IT staff can author configuration documentation');
    }
    if (actor.personType !== 'STAFF') {
      throw new ForbiddenException('Only IT staff can author configuration documentation');
    }
  }

  private async assertRead(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'it-009:read',
      'it-009:write',
      'it-009:admin',
    ]);
    if (!ok) {
      throw new ForbiddenException('IT-009:read required to view documentation');
    }
  }

  private rowToDto(row: DocRow): ConfigDocDto {
    return {
      id: row.id,
      schoolId: row.school_id,
      title: row.title,
      category: row.category as ConfigDocCategory,
      contentMarkdown: row.content_markdown,
      version: row.version,
      diagramS3Key: row.diagram_s3_key ?? null,
      lastUpdatedBy: row.last_updated_by,
      lastUpdatedByName:
        row.last_updated_first || row.last_updated_last
          ? `${row.last_updated_first ?? ''} ${row.last_updated_last ?? ''}`.trim()
          : null,
      lastUpdatedAt: row.last_updated_at,
    };
  }

  async list(actor: ResolvedActor, category?: ConfigDocCategory): Promise<ConfigDocDto[]> {
    await this.assertRead(actor);
    const tenant = getCurrentTenant();
    const filters: string[] = ['d.school_id = $1::uuid'];
    const params: string[] = [tenant.schoolId];
    if (category) {
      params.push(category);
      filters.push(`d.category = $${params.length}`);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        DOC_SELECT_BASE + ` WHERE ${filters.join(' AND ')} ORDER BY d.category, d.title`,
        ...params,
      );
    })) as DocRow[];
    return rows.map((r) => this.rowToDto(r));
  }

  async getById(id: string, actor: ResolvedActor): Promise<ConfigDocDto> {
    await this.assertRead(actor);
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        DOC_SELECT_BASE + ' WHERE d.id = $1::uuid AND d.school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      );
    })) as DocRow[];
    if (rows.length === 0) throw new NotFoundException('Documentation not found');
    return this.rowToDto(rows[0]!);
  }

  async create(dto: CreateConfigDocDto, actor: ResolvedActor): Promise<ConfigDocDto> {
    await this.assertWrite(actor);
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO tech_config_documentation (id, school_id, title, category, content_markdown, version, diagram_s3_key, last_updated_by, last_updated_at) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, 1, $6, $7::uuid, now())',
          id,
          tenant.schoolId,
          dto.title,
          dto.category,
          dto.contentMarkdown,
          dto.diagramS3Key ?? null,
          actor.personId,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException(`Documentation titled "${dto.title}" already exists`);
      }
      throw err;
    }
    return this.getById(id, actor);
  }

  /**
   * Versioned update — increments tech_config_documentation.version
   * atomically inside one tenant tx so concurrent updates don't both
   * land on the same version number. The locked-row pattern is the
   * standard project lifecycle keystone.
   */
  async patch(id: string, dto: UpdateConfigDocDto, actor: ResolvedActor): Promise<ConfigDocDto> {
    await this.assertWrite(actor);
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const locked = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id FROM tech_config_documentation WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE',
        id,
        tenant.schoolId,
      )) as Array<{ id: string }>;
      if (locked.length === 0) throw new NotFoundException('Documentation not found');

      const sets: string[] = [];
      const params: Array<string | null> = [];
      function add(col: string, val: string | null | undefined) {
        if (val !== undefined) {
          params.push(val);
          sets.push(`${col} = $${params.length}`);
        }
      }
      add('title', dto.title);
      add('category', dto.category);
      add('content_markdown', dto.contentMarkdown);
      add('diagram_s3_key', dto.diagramS3Key);
      sets.push('version = version + 1');
      sets.push(`last_updated_by = $${params.length + 1}::uuid`);
      params.push(actor.personId);
      sets.push('last_updated_at = now()');
      params.push(id);
      const sql = `UPDATE tech_config_documentation SET ${sets.join(', ')} WHERE id = $${params.length}::uuid`;
      try {
        await tx.$executeRawUnsafe(sql, ...params);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new BadRequestException('Documentation title already exists in this school');
        }
        throw err;
      }
    });
    return this.getById(id, actor);
  }
}

const DOC_SELECT_BASE = `
  SELECT
    d.id::text AS id,
    d.school_id::text AS school_id,
    d.title,
    d.category,
    d.content_markdown,
    d.version,
    d.diagram_s3_key,
    d.last_updated_by::text AS last_updated_by,
    ip.first_name AS last_updated_first,
    ip.last_name AS last_updated_last,
    d.last_updated_at::text AS last_updated_at
  FROM tech_config_documentation d
  LEFT JOIN platform.iam_person ip ON ip.id = d.last_updated_by
`;

interface DocRow {
  id: string;
  school_id: string;
  title: string;
  category: string;
  content_markdown: string;
  version: number;
  diagram_s3_key: string | null;
  last_updated_by: string;
  last_updated_first: string | null;
  last_updated_last: string | null;
  last_updated_at: string;
}

// ════════════════════════════════════════════════════════════
//  MonitoringService
// ════════════════════════════════════════════════════════════

@Injectable()
export class MonitoringService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
    private readonly kafka: KafkaProducerService,
  ) {}

  private async assertItAdmin(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'it-006:write',
      'it-006:admin',
    ]);
    if (!ok) {
      throw new ForbiddenException('Only IT admins can manage system monitoring');
    }
    if (actor.personType !== 'STAFF') {
      throw new ForbiddenException('Only IT admins can manage system monitoring');
    }
  }

  private async assertItRead(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'it-006:read',
      'it-006:write',
      'it-006:admin',
    ]);
    if (!ok) {
      throw new ForbiddenException('IT-006:read required to view system monitoring');
    }
  }

  private checkRowToDto(row: CheckRow): MonitoringCheckDto {
    return {
      id: row.id,
      schoolId: row.school_id,
      systemName: row.system_name,
      checkUrl: row.check_url ?? null,
      checkType: row.check_type as MonitoringCheckDto['checkType'],
      intervalMinutes: row.interval_minutes,
      expectedStatusCode: row.expected_status_code ?? null,
      timeoutSeconds: row.timeout_seconds,
      consecutiveFailuresToAlert: row.consecutive_failures_to_alert,
      isActive: row.is_active,
      lastStatus: row.last_status as MonitoringCheckDto['lastStatus'],
      lastCheckedAt: row.last_checked_at ?? null,
      consecutiveFailures: row.consecutive_failures,
      activeAlertCount: row.active_alert_count ?? 0,
    };
  }

  private alertRowToDto(row: AlertRow): MonitoringAlertDto {
    return {
      id: row.id,
      checkId: row.check_id,
      systemName: row.system_name,
      alertType: row.alert_type as MonitoringAlertDto['alertType'],
      detectedAt: row.detected_at,
      resolvedAt: row.resolved_at ?? null,
      responseTimeMs: row.response_time_ms ?? null,
      statusCode: row.status_code ?? null,
      errorMessage: row.error_message ?? null,
      acknowledgedBy: row.acknowledged_by ?? null,
      acknowledgedByName:
        row.acknowledged_by_first || row.acknowledged_by_last
          ? `${row.acknowledged_by_first ?? ''} ${row.acknowledged_by_last ?? ''}`.trim()
          : null,
      acknowledgedAt: row.acknowledged_at ?? null,
      notes: row.notes ?? null,
    };
  }

  async listChecks(actor: ResolvedActor): Promise<MonitoringCheckDto[]> {
    await this.assertItRead(actor);
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        CHECK_SELECT_BASE +
          ' WHERE c.school_id = $1::uuid ORDER BY c.is_active DESC, c.system_name',
        tenant.schoolId,
      );
    })) as CheckRow[];
    return rows.map((r) => this.checkRowToDto(r));
  }

  async getCheckById(id: string, actor: ResolvedActor): Promise<MonitoringCheckDto> {
    await this.assertItRead(actor);
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        CHECK_SELECT_BASE + ' WHERE c.id = $1::uuid AND c.school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      );
    })) as CheckRow[];
    if (rows.length === 0) throw new NotFoundException('Monitoring check not found');
    return this.checkRowToDto(rows[0]!);
  }

  async createCheck(
    dto: CreateMonitoringCheckDto,
    actor: ResolvedActor,
  ): Promise<MonitoringCheckDto> {
    await this.assertItAdmin(actor);
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO tech_monitoring_checks (id, school_id, system_name, check_url, check_type, interval_minutes, expected_status_code, timeout_seconds, consecutive_failures_to_alert, created_by) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::int, $7::int, $8::int, $9::int, $10::uuid)',
          id,
          tenant.schoolId,
          dto.systemName,
          dto.checkUrl ?? null,
          dto.checkType,
          dto.intervalMinutes ?? 5,
          dto.expectedStatusCode ?? 200,
          dto.timeoutSeconds ?? 10,
          dto.consecutiveFailuresToAlert ?? 2,
          actor.personId,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException(
          `A monitoring check for "${dto.systemName}" already exists in this school`,
        );
      }
      throw err;
    }
    return this.getCheckById(id, actor);
  }

  async patchCheck(
    id: string,
    dto: UpdateMonitoringCheckDto,
    actor: ResolvedActor,
  ): Promise<MonitoringCheckDto> {
    await this.assertItAdmin(actor);
    const tenant = getCurrentTenant();
    const sets: string[] = [];
    const params: Array<string | number | boolean | null> = [];
    function add(col: string, val: string | number | boolean | null | undefined) {
      if (val !== undefined) {
        params.push(val);
        sets.push(`${col} = $${params.length}`);
      }
    }
    add('system_name', dto.systemName);
    add('check_url', dto.checkUrl);
    add('check_type', dto.checkType);
    add('interval_minutes', dto.intervalMinutes);
    add('expected_status_code', dto.expectedStatusCode);
    add('timeout_seconds', dto.timeoutSeconds);
    add('consecutive_failures_to_alert', dto.consecutiveFailuresToAlert);
    add('is_active', dto.isActive);
    if (sets.length === 0) {
      return this.getCheckById(id, actor);
    }
    sets.push('updated_at = now()');
    params.push(id);
    params.push(tenant.schoolId);
    const sql = `UPDATE tech_monitoring_checks SET ${sets.join(', ')} WHERE id = $${params.length - 1}::uuid AND school_id = $${params.length}::uuid`;
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(sql, ...params);
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException('Monitoring check name conflict');
      }
      throw err;
    }
    return this.getCheckById(id, actor);
  }

  /**
   * KEYSTONE — record a check result. Increments consecutive_failures
   * on non-HEALTHY; resets to 0 on HEALTHY. On crossing the
   * consecutive_failures_to_alert threshold, creates a tech_monitoring
   * _alerts DOWN/DEGRADED row inside the same tx and emits
   * tech.monitoring.alert AFTER commit. On HEALTHY when an active
   * alert exists, resolves it (RECOVERED row + resolved_at set on
   * the active row).
   */
  async recordResult(
    checkId: string,
    dto: RecordCheckResultDto,
    actor: ResolvedActor,
  ): Promise<MonitoringCheckDto> {
    await this.assertItAdmin(actor);
    const tenant = getCurrentTenant();

    type AlertEmission = {
      alertId: string;
      alertType: 'DOWN' | 'DEGRADED' | 'RECOVERED';
      systemName: string;
      responseTimeMs: number | null;
      statusCode: number | null;
      errorMessage: string | null;
    };
    const emit: AlertEmission[] = [];

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const locked = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, system_name, consecutive_failures, consecutive_failures_to_alert, last_status FROM tech_monitoring_checks WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE',
        checkId,
        tenant.schoolId,
      )) as Array<{
        id: string;
        system_name: string;
        consecutive_failures: number;
        consecutive_failures_to_alert: number;
        last_status: string | null;
      }>;
      if (locked.length === 0) throw new NotFoundException('Monitoring check not found');
      const check = locked[0]!;

      const newStatus = dto.status;
      const newConsecutive = newStatus === 'HEALTHY' ? 0 : check.consecutive_failures + 1;

      await tx.$executeRawUnsafe(
        'UPDATE tech_monitoring_checks SET last_status = $1, last_checked_at = now(), consecutive_failures = $2::int, updated_at = now() WHERE id = $3::uuid',
        newStatus,
        newConsecutive,
        checkId,
      );

      // Threshold-crossing alert creation. Fires once per crossing —
      // when newConsecutive == threshold AND prior < threshold. If a
      // user records repeated DOWN beyond the threshold, no
      // duplicate alert is created (the consecutive failures count
      // increases but the alert already exists).
      const crossedThreshold =
        newConsecutive >= check.consecutive_failures_to_alert &&
        check.consecutive_failures < check.consecutive_failures_to_alert &&
        (newStatus === 'DOWN' || newStatus === 'DEGRADED');

      if (crossedThreshold) {
        const alertId = generateId();
        await tx.$executeRawUnsafe(
          'INSERT INTO tech_monitoring_alerts (id, check_id, alert_type, response_time_ms, status_code, error_message) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4::int, $5::int, $6)',
          alertId,
          checkId,
          newStatus,
          dto.responseTimeMs ?? null,
          dto.statusCode ?? null,
          dto.errorMessage ?? null,
        );
        emit.push({
          alertId,
          alertType: newStatus,
          systemName: check.system_name,
          responseTimeMs: dto.responseTimeMs ?? null,
          statusCode: dto.statusCode ?? null,
          errorMessage: dto.errorMessage ?? null,
        });
      }

      // Recovery — when status HEALTHY and there is an unresolved
      // alert on this check, resolve all unresolved + insert a
      // RECOVERED row for the audit trail.
      if (newStatus === 'HEALTHY') {
        const open = (await tx.$queryRawUnsafe(
          'SELECT id::text AS id FROM tech_monitoring_alerts WHERE check_id = $1::uuid AND resolved_at IS NULL',
          checkId,
        )) as Array<{ id: string }>;
        if (open.length > 0) {
          await tx.$executeRawUnsafe(
            'UPDATE tech_monitoring_alerts SET resolved_at = now() WHERE check_id = $1::uuid AND resolved_at IS NULL',
            checkId,
          );
          const recoveredId = generateId();
          await tx.$executeRawUnsafe(
            'INSERT INTO tech_monitoring_alerts (id, check_id, alert_type, response_time_ms, status_code, resolved_at) ' +
              "VALUES ($1::uuid, $2::uuid, 'RECOVERED', $3::int, $4::int, now())",
            recoveredId,
            checkId,
            dto.responseTimeMs ?? null,
            dto.statusCode ?? null,
          );
          emit.push({
            alertId: recoveredId,
            alertType: 'RECOVERED',
            systemName: check.system_name,
            responseTimeMs: dto.responseTimeMs ?? null,
            statusCode: dto.statusCode ?? null,
            errorMessage: null,
          });
        }
      }
    });

    for (const e of emit) {
      await this.kafka.emit({
        topic: 'tech.monitoring.alert',
        key: e.alertId,
        sourceModule: 'it',
        payload: {
          alertId: e.alertId,
          checkId,
          schoolId: tenant.schoolId,
          systemName: e.systemName,
          alertType: e.alertType,
          responseTimeMs: e.responseTimeMs,
          statusCode: e.statusCode,
          errorMessage: e.errorMessage,
          sourceRefId: e.alertId,
        },
      });
    }

    return this.getCheckById(checkId, actor);
  }

  async listAlerts(actor: ResolvedActor, activeOnly = false): Promise<MonitoringAlertDto[]> {
    await this.assertItRead(actor);
    const tenant = getCurrentTenant();
    const where = activeOnly
      ? 'c.school_id = $1::uuid AND a.resolved_at IS NULL'
      : 'c.school_id = $1::uuid';
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        ALERT_SELECT_BASE + ` WHERE ${where} ORDER BY a.detected_at DESC LIMIT 200`,
        tenant.schoolId,
      );
    })) as AlertRow[];
    return rows.map((r) => this.alertRowToDto(r));
  }

  async acknowledgeAlert(
    id: string,
    dto: AcknowledgeAlertDto,
    actor: ResolvedActor,
  ): Promise<MonitoringAlertDto> {
    await this.assertItAdmin(actor);
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const locked = (await tx.$queryRawUnsafe(
        'SELECT a.id::text AS id, a.acknowledged_at FROM tech_monitoring_alerts a JOIN tech_monitoring_checks c ON c.id = a.check_id WHERE a.id = $1::uuid AND c.school_id = $2::uuid FOR UPDATE OF a',
        id,
        tenant.schoolId,
      )) as Array<{ id: string; acknowledged_at: string | null }>;
      if (locked.length === 0) throw new NotFoundException('Alert not found');
      if (locked[0]!.acknowledged_at) {
        throw new BadRequestException('Alert is already acknowledged');
      }
      await tx.$executeRawUnsafe(
        'UPDATE tech_monitoring_alerts SET acknowledged_by = $1::uuid, acknowledged_at = now(), notes = COALESCE($2, notes) WHERE id = $3::uuid',
        actor.personId,
        dto.notes ?? null,
        id,
      );
    });
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(ALERT_SELECT_BASE + ' WHERE a.id = $1::uuid LIMIT 1', id);
    })) as AlertRow[];
    if (rows.length === 0) throw new NotFoundException('Alert not found after acknowledge');
    return this.alertRowToDto(rows[0]!);
  }
}

const CHECK_SELECT_BASE = `
  SELECT
    c.id::text AS id,
    c.school_id::text AS school_id,
    c.system_name,
    c.check_url,
    c.check_type,
    c.interval_minutes,
    c.expected_status_code,
    c.timeout_seconds,
    c.consecutive_failures_to_alert,
    c.is_active,
    c.last_status,
    c.last_checked_at::text AS last_checked_at,
    c.consecutive_failures,
    (SELECT COUNT(*)::int FROM tech_monitoring_alerts a WHERE a.check_id = c.id AND a.resolved_at IS NULL) AS active_alert_count
  FROM tech_monitoring_checks c
`;

interface CheckRow {
  id: string;
  school_id: string;
  system_name: string;
  check_url: string | null;
  check_type: string;
  interval_minutes: number;
  expected_status_code: number | null;
  timeout_seconds: number;
  consecutive_failures_to_alert: number;
  is_active: boolean;
  last_status: string | null;
  last_checked_at: string | null;
  consecutive_failures: number;
  active_alert_count: number;
}

const ALERT_SELECT_BASE = `
  SELECT
    a.id::text AS id,
    a.check_id::text AS check_id,
    c.system_name,
    a.alert_type,
    a.detected_at::text AS detected_at,
    a.resolved_at::text AS resolved_at,
    a.response_time_ms,
    a.status_code,
    a.error_message,
    a.acknowledged_by::text AS acknowledged_by,
    ip.first_name AS acknowledged_by_first,
    ip.last_name AS acknowledged_by_last,
    a.acknowledged_at::text AS acknowledged_at,
    a.notes
  FROM tech_monitoring_alerts a
  JOIN tech_monitoring_checks c ON c.id = a.check_id
  LEFT JOIN platform.iam_person ip ON ip.id = a.acknowledged_by
`;

interface AlertRow {
  id: string;
  check_id: string;
  system_name: string;
  alert_type: string;
  detected_at: string;
  resolved_at: string | null;
  response_time_ms: number | null;
  status_code: number | null;
  error_message: string | null;
  acknowledged_by: string | null;
  acknowledged_by_first: string | null;
  acknowledged_by_last: string | null;
  acknowledged_at: string | null;
  notes: string | null;
}

// ════════════════════════════════════════════════════════════
//  InfrastructureExtensionService
// ════════════════════════════════════════════════════════════

@Injectable()
export class InfrastructureExtensionService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  private async assertItAdmin(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'it-007:write',
      'it-007:admin',
    ]);
    if (!ok) {
      throw new ForbiddenException('Only IT admins can manage infrastructure registry');
    }
    if (actor.personType !== 'STAFF') {
      throw new ForbiddenException('Only IT admins can manage infrastructure registry');
    }
  }

  /**
   * P2-20 — Listing the warranty-expiring infrastructure items. The
   * core infrastructure read path lives on the Cycle 22
   * InfrastructureService; P2-20 adds the 30-day warranty lookahead
   * helper.
   */
  async warrantyExpiring(
    actor: ResolvedActor,
    daysAhead = 30,
  ): Promise<
    Array<{
      id: string;
      itemName: string;
      itemType: string;
      location: string;
      warrantyExpiry: string;
      daysUntilExpiry: number;
    }>
  > {
    if (!actor.isSchoolAdmin) {
      const tenant = getCurrentTenant();
      const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
        'it-007:read',
        'it-007:write',
        'it-007:admin',
      ]);
      if (!ok) {
        throw new ForbiddenException('IT-007:read required to view warranty expiry');
      }
    }
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        "SELECT id::text AS id, item_name, item_type, location, warranty_expiry::text AS warranty_expiry, (warranty_expiry - CURRENT_DATE)::int AS days_until_expiry FROM tech_infrastructure_items WHERE school_id = $1::uuid AND status <> 'DECOMMISSIONED' AND warranty_expiry IS NOT NULL AND warranty_expiry <= (CURRENT_DATE + $2::int * INTERVAL '1 day') ORDER BY warranty_expiry",
        tenant.schoolId,
        daysAhead,
      );
    })) as Array<{
      id: string;
      item_name: string;
      item_type: string;
      location: string;
      warranty_expiry: string;
      days_until_expiry: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      itemName: r.item_name,
      itemType: r.item_type,
      location: r.location,
      warrantyExpiry: r.warranty_expiry,
      daysUntilExpiry: r.days_until_expiry,
    }));
  }

  /**
   * P2-20 — Update last_checked_at on an existing infrastructure
   * item. Surfaced as a small admin-only action so IT staff can
   * mark an item as verified during their walkthrough.
   */
  async markChecked(
    id: string,
    actor: ResolvedActor,
  ): Promise<{ id: string; lastCheckedAt: string }> {
    await this.assertItAdmin(actor);
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'UPDATE tech_infrastructure_items SET last_checked_at = now(), updated_at = now() WHERE id = $1::uuid AND school_id = $2::uuid RETURNING id::text AS id, last_checked_at::text AS last_checked_at',
        id,
        tenant.schoolId,
      );
    })) as Array<{ id: string; last_checked_at: string }>;
    if (rows.length === 0) throw new NotFoundException('Infrastructure item not found');
    return { id: rows[0]!.id, lastCheckedAt: rows[0]!.last_checked_at };
  }

  async patch(
    id: string,
    dto: PatchInfrastructureItemDto,
    actor: ResolvedActor,
  ): Promise<{ id: string }> {
    await this.assertItAdmin(actor);
    const tenant = getCurrentTenant();
    const sets: string[] = [];
    const params: Array<string | null> = [];
    function add(col: string, val: string | null | undefined) {
      if (val !== undefined) {
        params.push(val);
        sets.push(`${col} = $${params.length}`);
      }
    }
    add('item_name', dto.itemName);
    add('location', dto.location);
    add('ip_address', dto.ipAddress);
    add('mac_address', dto.macAddress);
    add('make', dto.make);
    add('model', dto.model);
    add('serial_number', dto.serialNumber);
    add('purchase_date', dto.purchaseDate);
    add('warranty_expiry', dto.warrantyExpiry);
    add('status', dto.status);
    add('notes', dto.notes);
    if (sets.length === 0) return { id };
    sets.push('updated_at = now()');
    params.push(id);
    params.push(tenant.schoolId);
    const sql = `UPDATE tech_infrastructure_items SET ${sets.join(', ')} WHERE id = $${params.length - 1}::uuid AND school_id = $${params.length}::uuid`;
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(sql, ...params);
    });
    return { id };
  }
}
