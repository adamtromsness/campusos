import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';
import { OutboxService } from '@shared/kafka/outbox.service';
import { deterministicTenantAccessGrantedEventId } from '../event-ids';
import { CreateTenantAccessGrantDto, TenantAccessGrantDto, TenantAccessType } from '../dto/ops.dto';
import { OpsEmployeeService } from './ops-employee.service';

/**
 * Platform-tier sentinel UUID used for platform-scoped outbox emits
 * (where no school-level tenant context applies). Matches the
 * existing all-zeros sentinel pattern used elsewhere in the codebase
 * for cross-tenant ops (e.g. finance gl.consumer placeholder).
 */
const PLATFORM_SENTINEL_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/**
 * P2-21b — TenantAccessService.
 *
 * The keystone of internal ops auditing. CampusOS staff can grant
 * themselves time-bounded access to a school tenant schema to
 * investigate issues, but every grant:
 *
 *  1. Is bounded to <= 4 hours from granted_at (schema duration_chk).
 *  2. Requires a mandatory justification of >= 20 characters (schema
 *     justification_chk; DTO @MinLength(20) catches the common case
 *     earlier).
 *  3. Must be approved by an ops_employees row that holds the
 *     INTERNAL_ADMIN scope on ops_permissions. Approver != requester
 *     is enforced.
 *  4. Emits ops.tenant_access.granted via the ADR-057 envelope so the
 *     audit trail flows to any downstream observability / alerting.
 *  5. Can be revoked manually; the TenantAccessExpiryWorker (in this
 *     module) auto-revokes any grant whose expires_at < now() every
 *     5 minutes.
 *
 * Grants live in platform.ops_tenant_access_grants. The schema-side
 * constraints are the safety net; the service layer is the gate.
 *
 * Note: the envelope tenant_id is omitted (set to undefined) because
 * the grant is platform-scoped — it doesn't belong to one school.
 * The payload includes tenant_schema for the audit trail.
 */
@Injectable()
export class TenantAccessService {
  private readonly logger = new Logger(TenantAccessService.name);

  constructor(
    private readonly platform: PrismaClient,
    private readonly outbox: OutboxService,
    private readonly employees: OpsEmployeeService,
  ) {}

  // ── Reads ─────────────────────────────────────────────────────────

  async listActive(): Promise<TenantAccessGrantDto[]> {
    const rows = await this.platform.$queryRawUnsafe<RawGrantRow[]>(
      `SELECT id::text, employee_id::text, tenant_schema, justification, access_type,
              granted_at, expires_at, revoked_at, approved_by::text
         FROM platform.ops_tenant_access_grants
         WHERE revoked_at IS NULL AND expires_at > now()
         ORDER BY granted_at DESC`,
    );
    return rows.map(rowToGrantDto);
  }

  async listAuditLog(
    args: { employeeId?: string; tenantSchema?: string } = {},
  ): Promise<TenantAccessGrantDto[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (args.employeeId) {
      params.push(args.employeeId);
      where.push(`employee_id = $${params.length}::uuid`);
    }
    if (args.tenantSchema) {
      params.push(args.tenantSchema);
      where.push(`tenant_schema = $${params.length}`);
    }
    const whereSql = where.length === 0 ? '' : 'WHERE ' + where.join(' AND ');
    const rows = await this.platform.$queryRawUnsafe<RawGrantRow[]>(
      `SELECT id::text, employee_id::text, tenant_schema, justification, access_type,
              granted_at, expires_at, revoked_at, approved_by::text
         FROM platform.ops_tenant_access_grants
         ${whereSql}
         ORDER BY granted_at DESC
         LIMIT 500`,
      ...params,
    );
    return rows.map(rowToGrantDto);
  }

  async getById(id: string): Promise<TenantAccessGrantDto> {
    return rowToGrantDto(await this.loadOrFail(id));
  }

  // ── Writes ────────────────────────────────────────────────────────

  /**
   * Grant a CampusOS employee time-bounded access to a tenant
   * schema. Service-layer gate enforces:
   *  - approver != requester (no self-approval)
   *  - approver has INTERNAL_ADMIN scope on ops_permissions
   *  - justification length >= 20 (DTO + schema both enforce)
   *  - durationHours bounded 1..4 (schema duration_chk is the safety net)
   *
   * Emits ops.tenant_access.granted AFTER the INSERT commits.
   */
  async grant(input: CreateTenantAccessGrantDto): Promise<TenantAccessGrantDto> {
    if (input.approvedBy === input.employeeId) {
      throw new ForbiddenException('Approver cannot be the same employee as the requester.');
    }
    // Validate both employees exist + approver has INTERNAL_ADMIN scope.
    await this.employees.loadOrFail(input.employeeId);
    await this.employees.loadOrFail(input.approvedBy);

    const approverHasAdmin = await this.employees.hasScope(input.approvedBy, 'INTERNAL_ADMIN');
    if (!approverHasAdmin) {
      throw new ForbiddenException(
        'Approver must hold the INTERNAL_ADMIN ops_permissions scope to grant tenant access.',
      );
    }

    if (!input.justification || input.justification.trim().length < 20) {
      throw new BadRequestException('justification must be at least 20 characters (after trim).');
    }

    const hours = input.durationHours ?? 4;
    if (hours < 1 || hours > 4) {
      throw new BadRequestException(
        'durationHours must be between 1 and 4 (4-hour hard cap per ADR-072).',
      );
    }

    const id = generateId();
    // REVIEW-P2C21 BLOCKING 1 — INSERT + outbox enqueue in one tx so
    // a broker outage cannot lose the audit event for a FERPA/GDPR-
    // sensitive tenant access grant.
    try {
      await this.platform.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO platform.ops_tenant_access_grants
            (id, employee_id, tenant_schema, justification, access_type,
             granted_at, expires_at, approved_by)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5,
             now(), now() + ($6 || ' hours')::interval, $7::uuid)`,
          id,
          input.employeeId,
          input.tenantSchema,
          input.justification.trim(),
          input.accessType,
          String(hours),
          input.approvedBy,
        );
        // ADR-057 envelope: this grant is platform-scoped — the
        // controller is `@PlatformScoped()` with no tenant context.
        // Supply the platform-tier sentinel UUID so envelopeFromOptions
        // doesn't reject the emit. The payload's tenantSchema carries
        // the actual target tenant for the audit trail. Deterministic
        // event_id keyed on grantId so retries dedupe cleanly.
        await this.outbox.enqueueInTx(tx, {
          topic: 'ops.tenant_access.granted',
          key: id,
          payload: {
            grantId: id,
            employeeId: input.employeeId,
            tenantSchema: input.tenantSchema,
            accessType: input.accessType,
            justification: input.justification.trim(),
            durationHours: hours,
            approvedBy: input.approvedBy,
          },
          sourceModule: 'ops',
          tenantId: PLATFORM_SENTINEL_TENANT_ID,
          tenantSubdomain: 'platform',
          eventId: deterministicTenantAccessGrantedEventId(id),
        });
      });
    } catch (e: unknown) {
      const err = e as { message?: string };
      if (typeof err?.message === 'string' && err.message.includes('duration_chk')) {
        throw new BadRequestException(
          'Tenant access grants are capped at 4 hours from granted_at (schema duration_chk).',
        );
      }
      if (typeof err?.message === 'string' && err.message.includes('justification_chk')) {
        throw new BadRequestException('justification must be at least 20 characters (after trim).');
      }
      throw e;
    }

    const dto = rowToGrantDto(await this.loadOrFail(id));
    this.logger.log(
      `[ops-tenant-access] granted ${dto.accessType} access to ${dto.tenantSchema} for employee ${dto.employeeId} until ${dto.expiresAt} (approved by ${dto.approvedBy})`,
    );
    return dto;
  }

  /**
   * Revoke an active grant. Idempotent — calling on an already-revoked
   * row returns the row unchanged (no error). Calling on an expired
   * row also works (records the revocation time after expiry).
   */
  async revoke(id: string, revokedBy: string): Promise<TenantAccessGrantDto> {
    const row = await this.loadOrFail(id);
    if (row.revoked_at) {
      // Idempotent — already revoked.
      return rowToGrantDto(row);
    }
    await this.employees.loadOrFail(revokedBy);
    await this.platform.$executeRawUnsafe(
      `UPDATE platform.ops_tenant_access_grants
         SET revoked_at = now()
       WHERE id = $1::uuid AND revoked_at IS NULL`,
      id,
    );
    return rowToGrantDto(await this.loadOrFail(id));
  }

  /**
   * Worker hook — sweep expired grants every 5 minutes and stamp
   * revoked_at on rows whose expires_at < now() AND revoked_at is
   * still NULL. Returns the count flipped for observability.
   *
   * This is idempotent — a second sweep on already-stamped rows is a
   * no-op via the WHERE clause.
   */
  async sweepExpired(): Promise<number> {
    const result = await this.platform.$executeRawUnsafe(
      `UPDATE platform.ops_tenant_access_grants
         SET revoked_at = now()
       WHERE revoked_at IS NULL AND expires_at < now()`,
    );
    return result;
  }

  // ── Internals ─────────────────────────────────────────────────────

  async loadOrFail(id: string): Promise<RawGrantRow> {
    const rows = await this.platform.$queryRawUnsafe<RawGrantRow[]>(
      `SELECT id::text, employee_id::text, tenant_schema, justification, access_type,
              granted_at, expires_at, revoked_at, approved_by::text
         FROM platform.ops_tenant_access_grants WHERE id = $1::uuid`,
      id,
    );
    if (rows.length === 0) {
      throw new NotFoundException(`ops_tenant_access_grants ${id} not found.`);
    }
    return rows[0]!;
  }
}

// ── Row + mapper ─────────────────────────────────────────────────────

interface RawGrantRow {
  id: string;
  employee_id: string;
  tenant_schema: string;
  justification: string;
  access_type: string;
  granted_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  approved_by: string;
}

export function rowToGrantDto(row: RawGrantRow): TenantAccessGrantDto {
  const now = Date.now();
  const expiresMs = row.expires_at.getTime();
  const isActive = row.revoked_at === null && expiresMs > now;
  const remainingMinutes = isActive ? Math.max(0, Math.floor((expiresMs - now) / 60_000)) : 0;
  return {
    id: row.id,
    employeeId: row.employee_id,
    tenantSchema: row.tenant_schema,
    justification: row.justification,
    accessType: row.access_type as TenantAccessType,
    grantedAt: row.granted_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
    approvedBy: row.approved_by,
    isActive,
    remainingMinutes,
  };
}
