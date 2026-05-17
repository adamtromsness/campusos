import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import { PermissionCheckService } from '@modules/m00-platform';
import { KafkaProducerService } from '@shared/kafka';
import {
  DeclareIncidentDto,
  IncidentDto,
  IncidentSeverity,
  IncidentStatus,
  ListIncidentsQueryDto,
  OutboxStatusDto,
  ResolveIncidentDto,
} from '../common/dto/incident.dto';

interface IncidentRow {
  id: string;
  school_id: string;
  incident_type_id: string | null;
  type_code: string | null;
  type_name: string | null;
  severity: string | null;
  requires_lockdown: boolean | null;
  declared_by: string;
  declared_by_first: string | null;
  declared_by_last: string | null;
  declared_at: string;
  title: string | null;
  description: string | null;
  status: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_notes: string | null;
  created_at: string;
  updated_at: string;
}

interface OutboxRow {
  id: string;
  incident_id: string;
  declared_at: string;
  tasks_created_at: string | null;
  muster_taken_at: string | null;
  alert_sent_at: string | null;
  last_attempt_at: string | null;
  attempt_count: number;
  last_error: string | null;
}

const SELECT_INCIDENT_BASE =
  'SELECT i.id::text AS id, i.school_id::text AS school_id, ' +
  '       i.incident_type_id::text AS incident_type_id, ' +
  '       it.code AS type_code, it.name AS type_name, it.severity AS severity, ' +
  '       it.requires_lockdown AS requires_lockdown, ' +
  '       i.declared_by::text AS declared_by, ' +
  '       ip.first_name AS declared_by_first, ip.last_name AS declared_by_last, ' +
  '       i.declared_at::text AS declared_at, i.title, i.description, i.status, ' +
  '       i.resolved_at::text AS resolved_at, i.resolved_by::text AS resolved_by, ' +
  '       i.resolution_notes, ' +
  '       i.created_at::text AS created_at, i.updated_at::text AS updated_at ' +
  'FROM inc_incidents i ' +
  'LEFT JOIN inc_incident_types it ON it.id = i.incident_type_id ' +
  'LEFT JOIN platform.platform_users pu ON pu.id = i.declared_by ' +
  'LEFT JOIN platform.iam_person ip ON ip.id = pu.person_id ';

const SELECT_OUTBOX_BASE =
  'SELECT id::text AS id, incident_id::text AS incident_id, ' +
  '       declared_at::text AS declared_at, ' +
  '       tasks_created_at::text AS tasks_created_at, ' +
  '       muster_taken_at::text AS muster_taken_at, ' +
  '       alert_sent_at::text AS alert_sent_at, ' +
  '       last_attempt_at::text AS last_attempt_at, ' +
  '       attempt_count, last_error ' +
  'FROM inc_declaration_outbox ';

@Injectable()
export class IncidentService {
  private readonly logger = new Logger(IncidentService.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
    private readonly kafka: KafkaProducerService,
  ) {}

  /**
   * Declare an emergency. ATOMIC ORCHESTRATION KEYSTONE.
   *
   * inc_incidents and inc_declaration_outbox are inserted in the same
   * tenant transaction. The schema's UNIQUE on inc_declaration_outbox
   * .incident_id enforces one outbox row per incident. After commit
   * the inc.emergency.declared event is emitted - the
   * DeclarationOutboxWorker then picks up the unstamped step columns
   * idempotently.
   *
   * Authorization: actor must hold saf-001:write OR be a school admin.
   */
  async declare(input: DeclareIncidentDto, actor: ResolvedActor): Promise<IncidentDto> {
    await this.assertEmergencyResponder(actor);
    const tenant = getCurrentTenant();

    // REVIEW-P2C2 ROUND 1 MAJOR 2 fix — keep the Kafka emit OUTSIDE the
    // tenant transaction so a slow/failing broker can't race the commit.
    // The durable orchestrator is `inc_declaration_outbox` (created in
    // the same tx as inc_incidents). The `inc.emergency.declared` emit
    // is supplementary best-effort metadata for downstream consumers
    // (analytics, audit feeds). Outbox guarantees the operational
    // fan-out (tasks, muster, alerts) independently via
    // DeclarationOutboxWorker's emit-first-stamp-after pattern.
    const result = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Validate the incident type exists and is active either at platform
      // (school_id IS NULL) scope or for this tenant.
      const types = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, code, name, severity, requires_lockdown, is_active ' +
          'FROM inc_incident_types WHERE id = $1::uuid AND ' +
          '  (school_id IS NULL OR school_id = $2::uuid)',
        input.incidentTypeId,
        tenant.schoolId,
      )) as Array<{ id: string; is_active: boolean }>;
      if (types.length === 0) {
        throw new BadRequestException('Incident type not found in this tenant');
      }
      if (!types[0]!.is_active) {
        throw new BadRequestException('Incident type is inactive');
      }

      const incidentId = generateId();
      const outboxId = generateId();
      const declaredAt = new Date().toISOString();

      await tx.$executeRawUnsafe(
        'INSERT INTO inc_incidents ' +
          '(id, school_id, incident_type_id, declared_by, declared_at, title, description, status) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::timestamptz, $6, $7, $8)',
        incidentId,
        tenant.schoolId,
        input.incidentTypeId,
        actor.accountId,
        declaredAt,
        input.title ?? null,
        input.description ?? null,
        'ACTIVE',
      );

      // Outbox row in the same tenant tx so they commit atomically.
      await tx.$executeRawUnsafe(
        'INSERT INTO inc_declaration_outbox ' +
          '(id, incident_id, school_id, declared_at) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz)',
        outboxId,
        incidentId,
        tenant.schoolId,
        declaredAt,
      );

      const rows = (await tx.$queryRawUnsafe(
        SELECT_INCIDENT_BASE + 'WHERE i.school_id = $1::uuid AND i.id = $2::uuid LIMIT 1',
        tenant.schoolId,
        incidentId,
      )) as IncidentRow[];
      const head = rows[0]!;
      return { dto: this.rowToDto(head), incidentId, declaredAt, head };
    });

    // Emit AFTER the tenant tx has committed — outside the executeInTenantTransaction
    // callback so a slow/failing broker can never race the DB commit.
    try {
      await this.kafka.emit({
        topic: 'inc.emergency.declared',
        key: result.incidentId,
        sourceModule: 'incident',
        payload: {
          incidentId: result.incidentId,
          schoolId: tenant.schoolId,
          incidentTypeId: input.incidentTypeId,
          incidentTypeCode: result.head.type_code,
          severity: result.head.severity,
          requiresLockdown: result.head.requires_lockdown ?? false,
          declaredBy: actor.accountId,
          declaredAt: result.declaredAt,
          title: result.head.title,
          sourceRefId: result.incidentId,
        },
      });
    } catch (e: any) {
      // The supplementary inc.emergency.declared emit is best-effort —
      // operational fan-out is owned by the DeclarationOutboxWorker, which
      // has its own emit-first-stamp-after durability per step.
      this.logger.error(
        'kafka emit failed for inc.emergency.declared (' +
          result.incidentId +
          '): ' +
          (e?.message || e),
      );
    }

    return result.dto;
  }

  /**
   * Resolve an active incident. status ACTIVE -> RESOLVED with
   * resolution_notes recorded. Multi-column resolved_chk is satisfied
   * by stamping resolved_at and resolved_by atomically.
   *
   * Authorization: saf-001:write OR school admin.
   */
  async resolve(
    incidentId: string,
    input: ResolveIncidentDto,
    actor: ResolvedActor,
  ): Promise<IncidentDto> {
    await this.assertEmergencyResponder(actor);
    const tenant = getCurrentTenant();

    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, status FROM inc_incidents ' +
          'WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        incidentId,
      )) as Array<{ id: string; status: string }>;
      if (lock.length === 0) throw new NotFoundException('Incident not found');
      if (lock[0]!.status !== 'ACTIVE') {
        throw new BadRequestException('Only ACTIVE incidents can be resolved');
      }

      await tx.$executeRawUnsafe(
        'UPDATE inc_incidents SET status = $1, resolved_at = now(), resolved_by = $2::uuid, ' +
          '  resolution_notes = $3, updated_at = now() ' +
          'WHERE school_id = $4::uuid AND id = $5::uuid',
        'RESOLVED',
        actor.accountId,
        input.resolutionNotes ?? null,
        tenant.schoolId,
        incidentId,
      );

      const rows = (await tx.$queryRawUnsafe(
        SELECT_INCIDENT_BASE + 'WHERE i.school_id = $1::uuid AND i.id = $2::uuid LIMIT 1',
        tenant.schoolId,
        incidentId,
      )) as IncidentRow[];

      return this.rowToDto(rows[0]!);
    });
  }

  /**
   * Cancel an incident — ACTIVE -> CANCELLED. Used when a declaration
   * was made in error (no real emergency).
   */
  async cancel(incidentId: string, actor: ResolvedActor): Promise<IncidentDto> {
    await this.assertEmergencyResponder(actor);
    const tenant = getCurrentTenant();

    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT status FROM inc_incidents WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        incidentId,
      )) as Array<{ status: string }>;
      if (lock.length === 0) throw new NotFoundException('Incident not found');
      if (lock[0]!.status !== 'ACTIVE') {
        throw new BadRequestException('Only ACTIVE incidents can be cancelled');
      }

      await tx.$executeRawUnsafe(
        'UPDATE inc_incidents SET status = $1, resolved_at = now(), resolved_by = $2::uuid, ' +
          '  resolution_notes = $3, updated_at = now() ' +
          'WHERE school_id = $4::uuid AND id = $5::uuid',
        'CANCELLED',
        actor.accountId,
        'Declaration cancelled by responder.',
        tenant.schoolId,
        incidentId,
      );

      const rows = (await tx.$queryRawUnsafe(
        SELECT_INCIDENT_BASE + 'WHERE i.school_id = $1::uuid AND i.id = $2::uuid LIMIT 1',
        tenant.schoolId,
        incidentId,
      )) as IncidentRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  async list(args: ListIncidentsQueryDto): Promise<IncidentDto[]> {
    const tenant = getCurrentTenant();
    const limit = Math.min(args.limit ?? 50, 200);
    const params: unknown[] = [tenant.schoolId];
    let where = 'WHERE i.school_id = $1::uuid';
    if (args.status) {
      params.push(args.status);
      where += ' AND i.status = $' + params.length;
    }
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_INCIDENT_BASE + where + ' ORDER BY i.declared_at DESC LIMIT ' + limit,
        ...params,
      )) as IncidentRow[];
      return rows.map((r) => this.rowToDto(r));
    });
  }

  /**
   * Get a single incident with its outbox status inlined. Used by the
   * emergency dashboard to render the orchestration banner. Inlining
   * the outbox keeps the dashboard reactive without a separate poll.
   */
  async getById(incidentId: string): Promise<IncidentDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_INCIDENT_BASE + 'WHERE i.school_id = $1::uuid AND i.id = $2::uuid LIMIT 1',
        tenant.schoolId,
        incidentId,
      )) as IncidentRow[];
      if (rows.length === 0) throw new NotFoundException('Incident not found');
      const dto = this.rowToDto(rows[0]!);

      const outboxRows = (await client.$queryRawUnsafe(
        SELECT_OUTBOX_BASE + 'WHERE incident_id = $1::uuid LIMIT 1',
        incidentId,
      )) as OutboxRow[];
      if (outboxRows.length > 0) {
        dto.outboxStatus = this.outboxRowToDto(outboxRows[0]!);
      }
      return dto;
    });
  }

  /**
   * Internal helper for the worker to load a single incident outside
   * the request lifecycle (no actor context).
   */
  async loadInternal(incidentId: string): Promise<IncidentRow | null> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_INCIDENT_BASE + 'WHERE i.school_id = $1::uuid AND i.id = $2::uuid LIMIT 1',
        tenant.schoolId,
        incidentId,
      )) as IncidentRow[];
      return rows.length > 0 ? rows[0]! : null;
    });
  }

  // ---------- authorization helpers ----------------------------------------

  async assertEmergencyResponder(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'saf-001:write',
    ]);
    if (!ok) {
      throw new ForbiddenException(
        'Emergency declaration and accountability require saf-001:write or school admin.',
      );
    }
  }

  // ---------- DTO mappers --------------------------------------------------

  rowToDto(r: IncidentRow): IncidentDto {
    const declaredByName =
      r.declared_by_first || r.declared_by_last
        ? [r.declared_by_first, r.declared_by_last].filter(Boolean).join(' ')
        : null;
    return {
      id: r.id,
      schoolId: r.school_id,
      incidentTypeId: r.incident_type_id,
      incidentTypeCode: r.type_code,
      incidentTypeName: r.type_name,
      severity: (r.severity as IncidentSeverity) ?? null,
      declaredBy: r.declared_by,
      declaredByName,
      declaredAt: r.declared_at,
      title: r.title,
      description: r.description,
      status: r.status as IncidentStatus,
      resolvedAt: r.resolved_at,
      resolvedBy: r.resolved_by,
      resolutionNotes: r.resolution_notes,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      requiresLockdown: r.requires_lockdown,
      outboxStatus: null,
    };
  }

  outboxRowToDto(r: OutboxRow): OutboxStatusDto {
    return {
      id: r.id,
      incidentId: r.incident_id,
      declaredAt: r.declared_at,
      tasksCreatedAt: r.tasks_created_at,
      musterTakenAt: r.muster_taken_at,
      alertSentAt: r.alert_sent_at,
      lastAttemptAt: r.last_attempt_at,
      attemptCount: r.attempt_count,
      lastError: r.last_error,
    };
  }
}
