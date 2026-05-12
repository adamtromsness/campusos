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
import { OutboxService } from '../kafka/outbox.service';
import {
  deterministicRemoteActionIssuedEventId,
  deterministicUsageFlaggedEventId,
} from './event-ids';
import type {
  CreateDeviceUsageDto,
  CreateInventoryAuditDto,
  CreateLicenceRenewalDto,
  CreateRemoteActionDto,
  DeviceUsageDto,
  InventoryAuditDto,
  InventoryAuditItemDto,
  InventoryAuditReportDto,
  LicenceRenewalDto,
  RemoteActionDto,
  RemoteActionType,
  ScanAuditItemDto,
  UpdateRemoteActionStatusDto,
} from './dto/it.dto';

/**
 * P2-20a — IT Advanced operational depth.
 *
 * Four services in one file (the surface is small enough that a
 * single file keeps related concerns together):
 *
 *   RemoteActionService     IMMUTABLE remote MDM actions (LOCK, WIPE,
 *                           RESTART, LOCATE, UNENROLL, ENABLE/DISABLE_
 *                           LOST_MODE). No UPDATE, no DELETE methods
 *                           exposed at the service layer — the only
 *                           mutation is the /:id/status endpoint which
 *                           the MDM provider callback hits to flip
 *                           the row from PENDING/SENT to COMPLETED or
 *                           FAILED. On WIPE + COMPLETED, the service
 *                           atomically flips tech_assets.status to
 *                           AVAILABLE inside the same tenant tx.
 *
 *   InventoryAuditService   Formal physical inventory audit lifecycle:
 *                           POST creates with total_assets_expected
 *                           pulled from tech_assets for the building.
 *                           POST /scan adds an audit item (asset_id
 *                           null for unrecorded tags). POST /complete
 *                           computes the totals from
 *                           tech_inventory_audit_items and stamps
 *                           completed_at inside one locked tenant tx.
 *                           GET /report builds the discrepancy report
 *                           (missing assets + unrecorded assets +
 *                           condition observations).
 *
 *   LicenceRenewalService   Records a renewal and atomically updates
 *                           tech_software_licences.expiry_date in the
 *                           same tenant tx. The renewal history feeds
 *                           the licence cost chart on the licence
 *                           dashboard.
 *
 *   DeviceUsageService      Per-(asset, date) usage rollup. flagged_
 *                           activity=true rows feed the Step 8
 *                           tech.usage.flagged emit.
 *
 * One Kafka emit topic: tech.remote_action.issued AFTER the create tx
 * commits with the full payload the future MDM provider integration
 * would need to dispatch the command.
 */
@Injectable()
export class RemoteActionService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
    private readonly outbox: OutboxService,
  ) {}

  private async assertItAdmin(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'it-002:admin',
      'it-006:read',
    ]);
    if (!ok) {
      throw new ForbiddenException('Only IT admins can issue MDM remote actions');
    }
  }

  private rowToDto(row: RemoteActionRow): RemoteActionDto {
    return {
      id: row.id,
      assetId: row.asset_id,
      assetTag: row.asset_tag,
      actionType: row.action_type as RemoteActionType,
      initiatedBy: row.initiated_by,
      initiatedByName:
        row.initiated_by_first || row.initiated_by_last
          ? `${row.initiated_by_first ?? ''} ${row.initiated_by_last ?? ''}`.trim()
          : null,
      initiatedAt: row.initiated_at,
      justification: row.justification,
      mdmCommandRef: row.mdm_command_ref ?? null,
      status: row.status as RemoteActionDto['status'],
      completedAt: row.completed_at ?? null,
      failureReason: row.failure_reason ?? null,
    };
  }

  async listForAsset(assetId: string, actor: ResolvedActor): Promise<RemoteActionDto[]> {
    await this.assertItAdmin(actor);
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_BASE +
          ' WHERE r.asset_id = $1::uuid AND a.school_id = $2::uuid ORDER BY r.initiated_at DESC',
        assetId,
        tenant.schoolId,
      );
    })) as RemoteActionRow[];
    return rows.map((r) => this.rowToDto(r));
  }

  async getById(id: string, actor: ResolvedActor): Promise<RemoteActionDto> {
    await this.assertItAdmin(actor);
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_BASE + ' WHERE r.id = $1::uuid AND a.school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      );
    })) as RemoteActionRow[];
    if (rows.length === 0) throw new NotFoundException('Remote action not found');
    return this.rowToDto(rows[0]!);
  }

  /**
   * Issue a remote MDM action against an asset.
   *
   * IMMUTABLE — the row that lands here can be transitioned via
   * /:id/status (PENDING → SENT → COMPLETED / FAILED) but the
   * core fields (action_type, justification, initiated_by, asset_id)
   * cannot be modified or deleted by any service path.
   *
   * Validates the asset belongs to the calling tenant before insert.
   * justification CHECK (length trimmed >= 20) is enforced both at
   * the DTO layer (Length(20, 2000)) and the schema layer.
   */
  async create(
    assetId: string,
    dto: CreateRemoteActionDto,
    actor: ResolvedActor,
  ): Promise<RemoteActionDto> {
    await this.assertItAdmin(actor);
    const trimmed = (dto.justification ?? '').trim();
    if (trimmed.length < 20) {
      throw new BadRequestException('justification must be at least 20 characters after trimming');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    // REVIEW-P2C20 ROUND 1 BLOCKING 1 — every remote-action path is
    // school-scoped through tech_assets.school_id so a foreign-tenant
    // asset UUID cannot land a remote MDM command on a School B device.
    //
    // REVIEW-P2C20 ROUND 1 BLOCKING 2 — tech.remote_action.issued is
    // now durable via OutboxService.enqueueInTx INSIDE the same tenant
    // tx as the INSERT. The future MDM provider dispatcher consumes
    // the outbox row; a Kafka outage can no longer leave an audit row
    // without its downstream MDM command.
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const exists = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, asset_tag FROM tech_assets WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        assetId,
        tenant.schoolId,
      )) as Array<{ id: string; asset_tag: string }>;
      if (exists.length === 0) {
        throw new NotFoundException('Asset not found');
      }
      await tx.$executeRawUnsafe(
        'INSERT INTO tech_remote_actions (id, asset_id, action_type, initiated_by, justification, mdm_command_ref, status) ' +
          "VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6, 'PENDING')",
        id,
        assetId,
        dto.actionType,
        actor.personId,
        trimmed,
        dto.mdmCommandRef ?? null,
      );
      await this.outbox.enqueueInTx(tx, {
        topic: 'tech.remote_action.issued',
        key: id,
        sourceModule: 'it',
        eventId: deterministicRemoteActionIssuedEventId(id),
        payload: {
          actionId: id,
          assetId,
          assetTag: exists[0]!.asset_tag,
          schoolId: tenant.schoolId,
          actionType: dto.actionType,
          initiatedBy: actor.personId,
          initiatedByAccountId: actor.accountId,
          justification: trimmed,
          mdmCommandRef: dto.mdmCommandRef ?? null,
          sourceRefId: id,
        },
      });
    });

    return this.getById(id, actor);
  }

  /**
   * MDM callback or operator updates the remote action status.
   *
   * The IMMUTABLE invariant means we update only the lifecycle
   * fields (status, completed_at, mdm_command_ref, failure_reason).
   * The justification, action_type, asset_id, initiated_by all stay.
   *
   * WIPE + COMPLETED triggers a cross-table side effect — the parent
   * tech_assets.status flips to AVAILABLE inside the same tenant tx
   * as the status update so the device-reset invariant is atomic.
   */
  async updateStatus(
    id: string,
    dto: UpdateRemoteActionStatusDto,
    actor: ResolvedActor,
  ): Promise<RemoteActionDto> {
    await this.assertItAdmin(actor);
    const allowed: Array<UpdateRemoteActionStatusDto['status']> = [
      'PENDING',
      'SENT',
      'COMPLETED',
      'FAILED',
    ];
    if (!allowed.includes(dto.status)) {
      throw new BadRequestException('Invalid status value');
    }
    if (dto.status === 'FAILED') {
      const reason = (dto.failureReason ?? '').trim();
      if (reason.length === 0) {
        throw new BadRequestException('failureReason is required when status is FAILED');
      }
    }

    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // REVIEW-P2C20 ROUND 1 BLOCKING 1 — lock the remote action only
      // when it belongs to a tech_assets row in the calling tenant.
      // School A cannot mutate School B's action lifecycle (including
      // the WIPE-completion asset reset) by guessing the action UUID.
      const locked = (await tx.$queryRawUnsafe(
        'SELECT r.id::text AS id, r.asset_id::text AS asset_id, r.action_type, r.status ' +
          'FROM tech_remote_actions r ' +
          'JOIN tech_assets a ON a.id = r.asset_id ' +
          'WHERE r.id = $1::uuid AND a.school_id = $2::uuid FOR UPDATE OF r',
        id,
        tenant.schoolId,
      )) as Array<{ id: string; asset_id: string; action_type: string; status: string }>;
      if (locked.length === 0) {
        throw new NotFoundException('Remote action not found');
      }
      const row = locked[0]!;
      const isTerminal = row.status === 'COMPLETED' || row.status === 'FAILED';
      if (isTerminal) {
        throw new BadRequestException(
          `Remote action is already ${row.status} and cannot be updated`,
        );
      }

      const completedAt = dto.status === 'COMPLETED' || dto.status === 'FAILED' ? 'now()' : 'NULL';
      const failureReason = dto.status === 'FAILED' ? (dto.failureReason ?? '').trim() : null;

      await tx.$executeRawUnsafe(
        'UPDATE tech_remote_actions SET status = $1, mdm_command_ref = COALESCE($2, mdm_command_ref), completed_at = ' +
          completedAt +
          ', failure_reason = $3 WHERE id = $4::uuid',
        dto.status,
        dto.mdmCommandRef ?? null,
        failureReason,
        id,
      );

      // WIPE + COMPLETED keystone — auto-reset the asset to AVAILABLE
      // inside the same tx so the invariant cannot be violated by a
      // Kafka outage or a crash between two statements. The UPDATE
      // carries `school_id = $tenant` as defence-in-depth, matching
      // every other tenant write across Phase 2.
      if (row.action_type === 'WIPE' && dto.status === 'COMPLETED') {
        await tx.$executeRawUnsafe(
          "UPDATE tech_assets SET status = 'AVAILABLE', updated_at = now() WHERE id = $1::uuid AND school_id = $2::uuid",
          row.asset_id,
          tenant.schoolId,
        );
      }
    });

    return this.getById(id, actor);
  }
}

const SELECT_BASE = `
  SELECT
    r.id::text AS id,
    r.asset_id::text AS asset_id,
    a.asset_tag,
    r.action_type,
    r.initiated_by::text AS initiated_by,
    ip.first_name AS initiated_by_first,
    ip.last_name AS initiated_by_last,
    r.initiated_at::text AS initiated_at,
    r.justification,
    r.mdm_command_ref,
    r.status,
    r.completed_at::text AS completed_at,
    r.failure_reason
  FROM tech_remote_actions r
  JOIN tech_assets a ON a.id = r.asset_id
  LEFT JOIN platform.iam_person ip ON ip.id = r.initiated_by
`;

interface RemoteActionRow {
  id: string;
  asset_id: string;
  asset_tag: string;
  action_type: string;
  initiated_by: string;
  initiated_by_first: string | null;
  initiated_by_last: string | null;
  initiated_at: string;
  justification: string;
  mdm_command_ref: string | null;
  status: string;
  completed_at: string | null;
  failure_reason: string | null;
}

// ════════════════════════════════════════════════════════════
//  InventoryAuditService
// ════════════════════════════════════════════════════════════

@Injectable()
export class InventoryAuditService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  private async assertItStaff(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'it-002:write',
      'it-002:admin',
    ]);
    if (!ok) {
      throw new ForbiddenException('Only IT staff or school admins can conduct inventory audits');
    }
    if (actor.personType !== 'STAFF') {
      throw new ForbiddenException('Only IT staff or school admins can conduct inventory audits');
    }
  }

  private rowToDto(row: AuditRow): InventoryAuditDto {
    return {
      id: row.id,
      schoolId: row.school_id,
      auditName: row.audit_name,
      building: row.building ?? null,
      conductedBy: row.conducted_by,
      conductedByName:
        row.conducted_by_first || row.conducted_by_last
          ? `${row.conducted_by_first ?? ''} ${row.conducted_by_last ?? ''}`.trim()
          : null,
      auditDate: row.audit_date,
      totalAssetsExpected: row.total_assets_expected,
      totalAssetsFound: row.total_assets_found,
      totalAssetsMissing: row.total_assets_missing,
      totalAssetsUnrecorded: row.total_assets_unrecorded,
      auditNotes: row.audit_notes ?? null,
      status: row.status as 'IN_PROGRESS' | 'COMPLETED',
      completedAt: row.completed_at ?? null,
    };
  }

  async list(actor: ResolvedActor): Promise<InventoryAuditDto[]> {
    await this.assertItStaff(actor);
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        AUDIT_SELECT_BASE +
          ' WHERE au.school_id = $1::uuid ORDER BY au.audit_date DESC, au.created_at DESC',
        tenant.schoolId,
      );
    })) as AuditRow[];
    return rows.map((r) => this.rowToDto(r));
  }

  async getById(id: string, actor: ResolvedActor): Promise<InventoryAuditDto> {
    await this.assertItStaff(actor);
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        AUDIT_SELECT_BASE + ' WHERE au.id = $1::uuid AND au.school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      );
    })) as AuditRow[];
    if (rows.length === 0) throw new NotFoundException('Inventory audit not found');
    return this.rowToDto(rows[0]!);
  }

  /**
   * Start an inventory audit. Computes total_assets_expected from
   * tech_assets for the supplied building (or every active asset
   * school-wide if building is null).
   */
  async create(dto: CreateInventoryAuditDto, actor: ResolvedActor): Promise<InventoryAuditDto> {
    await this.assertItStaff(actor);
    const tenant = getCurrentTenant();
    const id = generateId();
    const auditDate = dto.auditDate ?? new Date().toISOString().slice(0, 10);

    // total_assets_expected — count of active assets in scope.
    // tech_assets carries no `building` column, so the count is
    // school-wide when building is supplied or omitted. A future
    // schema iteration may add location to tech_assets, at which
    // point this query refines.
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const expectedRow = (await tx.$queryRawUnsafe(
        "SELECT COUNT(*)::int AS c FROM tech_assets WHERE school_id = $1::uuid AND status <> 'RETIRED'",
        tenant.schoolId,
      )) as Array<{ c: number }>;
      const expected = expectedRow[0]?.c ?? 0;

      await tx.$executeRawUnsafe(
        'INSERT INTO tech_inventory_audits (id, school_id, audit_name, building, conducted_by, audit_date, total_assets_expected, status) ' +
          "VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6::date, $7::int, 'IN_PROGRESS')",
        id,
        tenant.schoolId,
        dto.auditName,
        dto.building ?? null,
        actor.personId,
        auditDate,
        expected,
      );
    });
    return this.getById(id, actor);
  }

  /**
   * Scan an asset during an audit. asset_id is resolved by
   * asset_tag (lookup against tech_assets in the current school).
   * Unknown tags land with asset_id=null and are counted as
   * unrecorded on /complete.
   */
  async scan(
    auditId: string,
    dto: ScanAuditItemDto,
    actor: ResolvedActor,
  ): Promise<InventoryAuditItemDto> {
    await this.assertItStaff(actor);
    const tenant = getCurrentTenant();
    const itemId = generateId();
    const itemRow = (await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const audit = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, status FROM tech_inventory_audits WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE',
        auditId,
        tenant.schoolId,
      )) as Array<{ id: string; status: string }>;
      if (audit.length === 0) throw new NotFoundException('Inventory audit not found');
      if (audit[0]!.status !== 'IN_PROGRESS') {
        throw new BadRequestException(
          'Audit is COMPLETED — no further scans allowed. Start a new audit instead.',
        );
      }

      // Resolve asset_id from asset_tag in current school
      const assetLookup = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id FROM tech_assets WHERE school_id = $1::uuid AND asset_tag = $2 LIMIT 1',
        tenant.schoolId,
        dto.assetTag,
      )) as Array<{ id: string }>;
      const assetId = assetLookup[0]?.id ?? null;

      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO tech_inventory_audit_items (id, audit_id, asset_id, asset_tag, found, condition_observed, location_observed, discrepancy_notes, scanned_by) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::boolean, $6, $7, $8, $9::uuid)',
          itemId,
          auditId,
          assetId,
          dto.assetTag,
          dto.found,
          dto.conditionObserved ?? null,
          dto.locationObserved ?? null,
          dto.discrepancyNotes ?? null,
          actor.personId,
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new BadRequestException(
            `Asset tag ${dto.assetTag} has already been scanned in this audit`,
          );
        }
        throw err;
      }

      // REVIEW-P2C20 ROUND 1 MAJOR 3 — reload joins the parent audit
      // on school_id so leaked item UUIDs cannot surface a foreign
      // row. The audit was already locked above by (id, school_id);
      // this is defence-in-depth.
      const reloaded = (await tx.$queryRawUnsafe(
        'SELECT i.id::text AS id, i.audit_id::text AS audit_id, i.asset_id::text AS asset_id, i.asset_tag, i.found, i.condition_observed, i.location_observed, i.discrepancy_notes, i.scanned_at::text AS scanned_at ' +
          'FROM tech_inventory_audit_items i ' +
          'JOIN tech_inventory_audits au ON au.id = i.audit_id ' +
          'WHERE i.id = $1::uuid AND au.school_id = $2::uuid LIMIT 1',
        itemId,
        tenant.schoolId,
      )) as Array<{
        id: string;
        audit_id: string;
        asset_id: string | null;
        asset_tag: string;
        found: boolean;
        condition_observed: string | null;
        location_observed: string | null;
        discrepancy_notes: string | null;
        scanned_at: string;
      }>;
      return reloaded[0]!;
    })) as {
      id: string;
      audit_id: string;
      asset_id: string | null;
      asset_tag: string;
      found: boolean;
      condition_observed: string | null;
      location_observed: string | null;
      discrepancy_notes: string | null;
      scanned_at: string;
    };

    return {
      id: itemRow.id,
      auditId: itemRow.audit_id,
      assetId: itemRow.asset_id,
      assetTag: itemRow.asset_tag,
      found: itemRow.found,
      conditionObserved: itemRow.condition_observed as InventoryAuditItemDto['conditionObserved'],
      locationObserved: itemRow.location_observed,
      discrepancyNotes: itemRow.discrepancy_notes,
      scannedAt: itemRow.scanned_at,
    };
  }

  async listItems(auditId: string, actor: ResolvedActor): Promise<InventoryAuditItemDto[]> {
    await this.getById(auditId, actor);
    const tenant = getCurrentTenant();
    // REVIEW-P2C20 ROUND 1 MAJOR 3 — defence-in-depth join through
    // the parent audit's school_id even though getById already passes.
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT i.id::text AS id, i.audit_id::text AS audit_id, i.asset_id::text AS asset_id, i.asset_tag, i.found, i.condition_observed, i.location_observed, i.discrepancy_notes, i.scanned_at::text AS scanned_at ' +
          'FROM tech_inventory_audit_items i ' +
          'JOIN tech_inventory_audits au ON au.id = i.audit_id ' +
          'WHERE i.audit_id = $1::uuid AND au.school_id = $2::uuid ORDER BY i.scanned_at',
        auditId,
        tenant.schoolId,
      );
    })) as Array<{
      id: string;
      audit_id: string;
      asset_id: string | null;
      asset_tag: string;
      found: boolean;
      condition_observed: string | null;
      location_observed: string | null;
      discrepancy_notes: string | null;
      scanned_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      auditId: r.audit_id,
      assetId: r.asset_id,
      assetTag: r.asset_tag,
      found: r.found,
      conditionObserved: r.condition_observed as InventoryAuditItemDto['conditionObserved'],
      locationObserved: r.location_observed,
      discrepancyNotes: r.discrepancy_notes,
      scannedAt: r.scanned_at,
    }));
  }

  /**
   * Complete the audit. Computes totals from
   * tech_inventory_audit_items:
   *   found = COUNT(*) WHERE found=true AND asset_id IS NOT NULL
   *   unrecorded = COUNT(*) WHERE found=true AND asset_id IS NULL
   *   missing = total_expected - found
   * Stamps completed_at + flips status to COMPLETED inside one
   * locked tenant tx.
   */
  async complete(auditId: string, actor: ResolvedActor): Promise<InventoryAuditDto> {
    await this.assertItStaff(actor);
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const audit = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, status, total_assets_expected FROM tech_inventory_audits WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE',
        auditId,
        tenant.schoolId,
      )) as Array<{ id: string; status: string; total_assets_expected: number }>;
      if (audit.length === 0) throw new NotFoundException('Inventory audit not found');
      if (audit[0]!.status === 'COMPLETED') {
        throw new BadRequestException('Audit is already COMPLETED');
      }
      const counts = (await tx.$queryRawUnsafe(
        'SELECT ' +
          'COUNT(*) FILTER (WHERE found = true AND asset_id IS NOT NULL)::int AS found_known, ' +
          'COUNT(*) FILTER (WHERE found = true AND asset_id IS NULL)::int AS unrecorded ' +
          'FROM tech_inventory_audit_items WHERE audit_id = $1::uuid',
        auditId,
      )) as Array<{ found_known: number; unrecorded: number }>;
      const found = counts[0]?.found_known ?? 0;
      const unrecorded = counts[0]?.unrecorded ?? 0;
      const expected = audit[0]!.total_assets_expected;
      const missing = Math.max(0, expected - found);

      await tx.$executeRawUnsafe(
        "UPDATE tech_inventory_audits SET total_assets_found = $1::int, total_assets_missing = $2::int, total_assets_unrecorded = $3::int, status = 'COMPLETED', completed_at = now(), updated_at = now() WHERE id = $4::uuid",
        found,
        missing,
        unrecorded,
        auditId,
      );
    });
    return this.getById(auditId, actor);
  }

  /**
   * Generate the discrepancy report for a completed (or in-progress)
   * audit. Lists:
   *   - missing assets: tech_assets school-rows that don't appear in
   *     audit_items as found=true
   *   - unrecorded assets: audit_items rows with asset_id=null
   *   - condition changes: audit_items with condition_observed set
   */
  async report(auditId: string, actor: ResolvedActor): Promise<InventoryAuditReportDto> {
    const audit = await this.getById(auditId, actor);
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      const missing = (await client.$queryRawUnsafe(
        'SELECT a.id::text AS asset_id, a.asset_tag AS asset_tag, NULL::text AS last_known_location ' +
          'FROM tech_assets a ' +
          'WHERE a.school_id = $1::uuid ' +
          "AND a.status <> 'RETIRED' " +
          'AND NOT EXISTS (' +
          'SELECT 1 FROM tech_inventory_audit_items i ' +
          'WHERE i.audit_id = $2::uuid AND i.asset_id = a.id AND i.found = true' +
          ')',
        tenant.schoolId,
        auditId,
      )) as Array<{ asset_id: string; asset_tag: string; last_known_location: string | null }>;
      const unrecorded = (await client.$queryRawUnsafe(
        'SELECT asset_tag, location_observed, discrepancy_notes AS notes FROM tech_inventory_audit_items WHERE audit_id = $1::uuid AND asset_id IS NULL AND found = true',
        auditId,
      )) as Array<{ asset_tag: string; location_observed: string | null; notes: string | null }>;
      const conditions = (await client.$queryRawUnsafe(
        'SELECT i.asset_id::text AS asset_id, i.asset_tag, i.condition_observed FROM tech_inventory_audit_items i WHERE i.audit_id = $1::uuid AND i.condition_observed IS NOT NULL AND i.asset_id IS NOT NULL',
        auditId,
      )) as Array<{ asset_id: string; asset_tag: string; condition_observed: string }>;
      const total = (await client.$queryRawUnsafe(
        'SELECT COUNT(*)::int AS c FROM tech_inventory_audit_items WHERE audit_id = $1::uuid',
        auditId,
      )) as Array<{ c: number }>;
      return { missing, unrecorded, conditions, total: total[0]?.c ?? 0 };
    })) as {
      missing: Array<{ asset_id: string; asset_tag: string; last_known_location: string | null }>;
      unrecorded: Array<{
        asset_tag: string;
        location_observed: string | null;
        notes: string | null;
      }>;
      conditions: Array<{ asset_id: string; asset_tag: string; condition_observed: string }>;
      total: number;
    };
    return {
      audit,
      missingAssets: rows.missing.map((m) => ({
        assetId: m.asset_id,
        assetTag: m.asset_tag,
        lastKnownLocation: m.last_known_location,
      })),
      unrecordedAssets: rows.unrecorded.map((u) => ({
        assetTag: u.asset_tag,
        locationObserved: u.location_observed,
        notes: u.notes,
      })),
      conditionChanges: rows.conditions.map((c) => ({
        assetId: c.asset_id,
        assetTag: c.asset_tag,
        conditionObserved: c.condition_observed,
      })),
      itemCount: rows.total,
    };
  }
}

const AUDIT_SELECT_BASE = `
  SELECT
    au.id::text AS id,
    au.school_id::text AS school_id,
    au.audit_name,
    au.building,
    au.conducted_by::text AS conducted_by,
    ip.first_name AS conducted_by_first,
    ip.last_name AS conducted_by_last,
    au.audit_date::text AS audit_date,
    au.total_assets_expected,
    au.total_assets_found,
    au.total_assets_missing,
    au.total_assets_unrecorded,
    au.audit_notes,
    au.status,
    au.completed_at::text AS completed_at
  FROM tech_inventory_audits au
  LEFT JOIN platform.iam_person ip ON ip.id = au.conducted_by
`;

interface AuditRow {
  id: string;
  school_id: string;
  audit_name: string;
  building: string | null;
  conducted_by: string;
  conducted_by_first: string | null;
  conducted_by_last: string | null;
  audit_date: string;
  total_assets_expected: number;
  total_assets_found: number;
  total_assets_missing: number;
  total_assets_unrecorded: number;
  audit_notes: string | null;
  status: string;
  completed_at: string | null;
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e.code === 'P2010' || e.meta?.code === '23505') return true;
  if (e.code === '23505') return true;
  return typeof e.message === 'string' && e.message.includes('23505');
}

// ════════════════════════════════════════════════════════════
//  LicenceRenewalService
// ════════════════════════════════════════════════════════════

@Injectable()
export class LicenceRenewalService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  private async assertItAdmin(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'it-004:write',
      'it-004:admin',
    ]);
    if (!ok) {
      throw new ForbiddenException('Only IT admins can manage software licence renewals');
    }
    if (actor.personType !== 'STAFF') {
      throw new ForbiddenException('Only IT admins can manage software licence renewals');
    }
  }

  private rowToDto(row: RenewalRow): LicenceRenewalDto {
    return {
      id: row.id,
      licenceId: row.licence_id,
      softwareName: row.software_name,
      previousExpiryDate: row.previous_expiry_date,
      newExpiryDate: row.new_expiry_date,
      renewalCost: row.renewal_cost === null ? null : Number(row.renewal_cost),
      renewedBy: row.renewed_by,
      renewedByName:
        row.renewed_by_first || row.renewed_by_last
          ? `${row.renewed_by_first ?? ''} ${row.renewed_by_last ?? ''}`.trim()
          : null,
      renewedAt: row.renewed_at,
      notes: row.notes ?? null,
    };
  }

  async listForLicence(licenceId: string, actor: ResolvedActor): Promise<LicenceRenewalDto[]> {
    await this.assertItAdmin(actor);
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        RENEWAL_SELECT_BASE +
          ' WHERE r.licence_id = $1::uuid AND l.school_id = $2::uuid ORDER BY r.renewed_at DESC',
        licenceId,
        tenant.schoolId,
      );
    })) as RenewalRow[];
    return rows.map((r) => this.rowToDto(r));
  }

  /**
   * Renew a licence — atomically writes the renewal row and updates
   * tech_software_licences.expiry_date inside one tenant tx so the
   * licence cost history chart and the active expiry date stay
   * consistent.
   */
  async renew(
    licenceId: string,
    dto: CreateLicenceRenewalDto,
    actor: ResolvedActor,
  ): Promise<LicenceRenewalDto> {
    await this.assertItAdmin(actor);
    const tenant = getCurrentTenant();
    const id = generateId();
    if (dto.renewalCost !== undefined && dto.renewalCost !== null && dto.renewalCost < 0) {
      throw new BadRequestException('renewalCost must be non-negative');
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const licence = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, expiry_date::text AS expiry_date FROM tech_software_licences WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE',
        licenceId,
        tenant.schoolId,
      )) as Array<{ id: string; expiry_date: string | null }>;
      if (licence.length === 0) throw new NotFoundException('Software licence not found');
      const prevExpiry = licence[0]!.expiry_date ?? dto.newExpiryDate;
      if (new Date(dto.newExpiryDate) < new Date(prevExpiry)) {
        throw new BadRequestException('newExpiryDate must be on or after previous expiry');
      }
      await tx.$executeRawUnsafe(
        'INSERT INTO tech_licence_renewals (id, licence_id, previous_expiry_date, new_expiry_date, renewal_cost, renewed_by, notes) ' +
          'VALUES ($1::uuid, $2::uuid, $3::date, $4::date, $5::numeric, $6::uuid, $7)',
        id,
        licenceId,
        prevExpiry,
        dto.newExpiryDate,
        dto.renewalCost ?? null,
        actor.personId,
        dto.notes ?? null,
      );
      // REVIEW-P2C20 ROUND 1 MAJOR 2 — carry the school predicate
      // through the post-lock UPDATE for defence-in-depth, matching
      // the Phase 2 "every write carries school_id" convention.
      await tx.$executeRawUnsafe(
        'UPDATE tech_software_licences SET expiry_date = $1::date, updated_at = now() ' +
          'WHERE id = $2::uuid AND school_id = $3::uuid',
        dto.newExpiryDate,
        licenceId,
        tenant.schoolId,
      );
    });

    // Reload joins through tech_software_licences with the school
    // predicate so a leaked renewal id cannot surface a foreign row.
    const created = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        RENEWAL_SELECT_BASE + ' WHERE r.id = $1::uuid AND l.school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      );
    })) as RenewalRow[];
    if (created.length === 0) throw new NotFoundException('Renewal not found after create');
    return this.rowToDto(created[0]!);
  }
}

const RENEWAL_SELECT_BASE = `
  SELECT
    r.id::text AS id,
    r.licence_id::text AS licence_id,
    l.software_name,
    r.previous_expiry_date::text AS previous_expiry_date,
    r.new_expiry_date::text AS new_expiry_date,
    r.renewal_cost,
    r.renewed_by::text AS renewed_by,
    ip.first_name AS renewed_by_first,
    ip.last_name AS renewed_by_last,
    r.renewed_at::text AS renewed_at,
    r.notes
  FROM tech_licence_renewals r
  JOIN tech_software_licences l ON l.id = r.licence_id
  LEFT JOIN platform.iam_person ip ON ip.id = r.renewed_by
`;

interface RenewalRow {
  id: string;
  licence_id: string;
  software_name: string;
  previous_expiry_date: string;
  new_expiry_date: string;
  renewal_cost: string | number | null;
  renewed_by: string;
  renewed_by_first: string | null;
  renewed_by_last: string | null;
  renewed_at: string;
  notes: string | null;
}

// ════════════════════════════════════════════════════════════
//  DeviceUsageService
// ════════════════════════════════════════════════════════════

@Injectable()
export class DeviceUsageService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
    private readonly outbox: OutboxService,
  ) {}

  private async assertItAdmin(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'it-002:write',
      'it-002:admin',
      'it-006:read',
    ]);
    if (!ok) {
      throw new ForbiddenException('Only IT staff or school admins can review device usage');
    }
    if (actor.personType !== 'STAFF') {
      throw new ForbiddenException('Only IT staff or school admins can review device usage');
    }
  }

  private rowToDto(row: UsageRow): DeviceUsageDto {
    return {
      id: row.id,
      assetId: row.asset_id,
      assetTag: row.asset_tag,
      summaryDate: row.summary_date,
      screenTimeMinutes: row.screen_time_minutes,
      appsUsed: row.apps_used ?? [],
      flaggedActivity: row.flagged_activity,
      summarySource: row.summary_source ?? null,
    };
  }

  async listForAsset(assetId: string, actor: ResolvedActor): Promise<DeviceUsageDto[]> {
    await this.assertItAdmin(actor);
    const tenant = getCurrentTenant();
    // REVIEW-P2C20 ROUND 1 BLOCKING 3 — usage reads carry the school
    // predicate through the joined tech_assets row so a foreign-school
    // asset UUID cannot leak app-usage / screen-time data.
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        USAGE_SELECT_BASE +
          ' WHERE u.asset_id = $1::uuid AND a.school_id = $2::uuid ORDER BY u.summary_date DESC LIMIT 90',
        assetId,
        tenant.schoolId,
      );
    })) as UsageRow[];
    return rows.map((r) => this.rowToDto(r));
  }

  async listFlagged(actor: ResolvedActor): Promise<DeviceUsageDto[]> {
    await this.assertItAdmin(actor);
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        USAGE_SELECT_BASE +
          ' WHERE u.flagged_activity = true AND a.school_id = $1::uuid ORDER BY u.summary_date DESC LIMIT 200',
        tenant.schoolId,
      );
    })) as UsageRow[];
    return rows.map((r) => this.rowToDto(r));
  }

  /**
   * Record a daily usage summary. UNIQUE(asset_id, summary_date)
   * means a re-sync for the same day overwrites — we delete the
   * existing row first then insert, all inside one tenant tx.
   *
   * Step 8 — when flagged_activity=true the service emits
   * tech.usage.flagged for IT admin notification. The schema-level
   * partial index on flagged_activity feeds the dashboard hot path.
   */
  async record(
    assetId: string,
    dto: CreateDeviceUsageDto,
    actor: ResolvedActor,
  ): Promise<DeviceUsageDto> {
    await this.assertItAdmin(actor);
    const tenant = getCurrentTenant();
    const id = generateId();
    // REVIEW-P2C20 ROUND 1 BLOCKING 2 — tech.usage.flagged now writes
    // to the durable outbox INSIDE the same tenant tx as the usage
    // INSERT so the IT-admin notification consumer can never be
    // skipped by a Kafka outage. Deterministic event_id keys on the
    // usage row id so retries dedup cleanly.
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const asset = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, asset_tag FROM tech_assets WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        assetId,
        tenant.schoolId,
      )) as Array<{ id: string; asset_tag: string }>;
      if (asset.length === 0) throw new NotFoundException('Asset not found');

      // Upsert by deleting any existing row for the same (asset, date)
      await tx.$executeRawUnsafe(
        'DELETE FROM tech_device_usage_summaries WHERE asset_id = $1::uuid AND summary_date = $2::date',
        assetId,
        dto.summaryDate,
      );

      await tx.$executeRawUnsafe(
        'INSERT INTO tech_device_usage_summaries (id, asset_id, summary_date, screen_time_minutes, apps_used, flagged_activity, summary_source, recorded_by) ' +
          'VALUES ($1::uuid, $2::uuid, $3::date, $4::int, $5::text[], $6::boolean, $7, $8::uuid)',
        id,
        assetId,
        dto.summaryDate,
        dto.screenTimeMinutes ?? null,
        dto.appsUsed ?? [],
        dto.flaggedActivity ?? false,
        dto.summarySource ?? null,
        actor.personId,
      );

      if (dto.flaggedActivity === true) {
        await this.outbox.enqueueInTx(tx, {
          topic: 'tech.usage.flagged',
          key: id,
          sourceModule: 'it',
          eventId: deterministicUsageFlaggedEventId(id),
          payload: {
            usageId: id,
            assetId,
            assetTag: asset[0]!.asset_tag,
            schoolId: tenant.schoolId,
            summaryDate: dto.summaryDate,
            screenTimeMinutes: dto.screenTimeMinutes ?? null,
            appsUsed: dto.appsUsed ?? [],
            summarySource: dto.summarySource ?? null,
            recordedBy: actor.personId,
            sourceRefId: id,
          },
        });
      }
    });

    // REVIEW-P2C20 ROUND 1 BLOCKING 3 — reload through the joined
    // tech_assets row with the school predicate so a leaked usage UUID
    // cannot surface a foreign-tenant row.
    const reloaded = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        USAGE_SELECT_BASE + ' WHERE u.id = $1::uuid AND a.school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      );
    })) as UsageRow[];
    if (reloaded.length === 0) throw new NotFoundException('Usage summary not found after record');
    return this.rowToDto(reloaded[0]!);
  }
}

const USAGE_SELECT_BASE = `
  SELECT
    u.id::text AS id,
    u.asset_id::text AS asset_id,
    a.asset_tag,
    u.summary_date::text AS summary_date,
    u.screen_time_minutes,
    u.apps_used,
    u.flagged_activity,
    u.summary_source
  FROM tech_device_usage_summaries u
  JOIN tech_assets a ON a.id = u.asset_id
`;

interface UsageRow {
  id: string;
  asset_id: string;
  asset_tag: string;
  summary_date: string;
  screen_time_minutes: number | null;
  apps_used: string[] | null;
  flagged_activity: boolean;
  summary_source: string | null;
}
