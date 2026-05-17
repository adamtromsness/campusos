import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { OutboxService } from '@shared/kafka/outbox.service';
import type {
  BreachRecordDto,
  CreateBreachDto,
  NotifyDataSubjectsDto,
  NotifySupervisoryAuthorityDto,
  ResolveBreachDto,
  UpdateBreachDto,
} from './dto/governance.dto';

const HOUR_MS = 60 * 60 * 1000;
const SEVENTY_TWO_HOURS_MS = 72 * HOUR_MS;

/**
 * BreachService — GDPR Article 33 data breach register +
 * **THE 72-HOUR COUNTDOWN KEYSTONE**.
 *
 * On INSERT with `supervisoryAuthorityNotificationRequired=true`:
 *   1. After tx commits, emit `dpo.breach.discovered` with the breach
 *      context payload.
 *   2. Cycle 7 TaskWorker subscribes to that topic and creates an
 *      URGENT auto-task with a 72-hour deadline.
 *
 * The Step 4 seed registered the auto-task rule; this service ships
 * the emit half. A missed 72-hour window is a regulatory violation —
 * this is the highest-urgency automated escalation in CampusOS.
 *
 * Lifecycle: UNDER_INVESTIGATION → CONTAINED / NOTIFIED → RESOLVED.
 * Multi-column `resolved_chk` keeps (status, is_resolved, resolved_at)
 * in lockstep at the schema layer.
 */
@Injectable()
export class BreachService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
    private readonly outbox: OutboxService,
  ) {}

  async assertReadScope(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'dpo-003:read',
    ]);
    if (!ok) {
      throw new ForbiddenException(
        'Breach register access is restricted to the DPO scope (dpo-003:read).',
      );
    }
  }

  async assertWriteScope(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'dpo-003:write',
    ]);
    if (!ok) {
      throw new ForbiddenException('Only the DPO can mutate breach records (dpo-003:write).');
    }
  }

  private rowToBreachDto(r: Record<string, unknown>): BreachRecordDto {
    const discoveryMs = (r.discovery_date as Date).getTime();
    const elapsedMs = Date.now() - discoveryMs;
    const hoursSinceDiscovery = Math.max(0, Math.floor(elapsedMs / HOUR_MS));
    const required = r.supervisory_authority_notification_required as boolean;
    const notifiedAt = r.supervisory_authority_notified_at as Date | null;
    const remainingMs = SEVENTY_TWO_HOURS_MS - elapsedMs;
    const hoursRemainingTo72 = required && !notifiedAt ? Math.floor(remainingMs / HOUR_MS) : null;
    const isOverdue = required && !notifiedAt && remainingMs <= 0;
    return {
      id: r.id as string,
      schoolId: r.school_id as string,
      breachTitle: r.breach_title as string,
      breachType: r.breach_type as BreachRecordDto['breachType'],
      discoveryDate: (r.discovery_date as Date).toISOString(),
      breachStartDate: r.breach_start_date ? String(r.breach_start_date).slice(0, 10) : null,
      personalDataCategoriesInvolved: (r.personal_data_categories_involved as string[]) ?? [],
      estimatedAffectedIndividuals: (r.estimated_affected_individuals as number | null) ?? null,
      riskLevel: r.risk_level as BreachRecordDto['riskLevel'],
      riskToIndividuals: r.risk_to_individuals as BreachRecordDto['riskToIndividuals'],
      supervisoryAuthorityNotificationRequired: required,
      supervisoryAuthorityNotifiedAt: notifiedAt ? notifiedAt.toISOString() : null,
      supervisoryAuthorityReference: (r.supervisory_authority_reference as string | null) ?? null,
      dataSubjectsNotificationRequired: r.data_subjects_notification_required as boolean,
      dataSubjectsNotifiedAt: (r.data_subjects_notified_at as Date | null)?.toISOString() ?? null,
      breachCause: r.breach_cause as string,
      remediationActions: r.remediation_actions as string,
      isResolved: r.is_resolved as boolean,
      resolvedAt: (r.resolved_at as Date | null)?.toISOString() ?? null,
      reportedById: r.reported_by as string,
      status: r.status as BreachRecordDto['status'],
      hoursSinceDiscovery,
      hoursRemainingTo72,
      isOverdue,
      createdAt: (r.created_at as Date).toISOString(),
      updatedAt: (r.updated_at as Date).toISOString(),
    };
  }

  async list(
    actor: ResolvedActor,
    args?: { status?: string; pendingNotificationOnly?: boolean },
  ): Promise<BreachRecordDto[]> {
    await this.assertReadScope(actor);
    const tenant = getCurrentTenant();
    const where: string[] = ['school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    if (args?.status) {
      where.push(`status = $${params.length + 1}`);
      params.push(args.status);
    }
    if (args?.pendingNotificationOnly) {
      where.push(
        'supervisory_authority_notification_required = true AND supervisory_authority_notified_at IS NULL',
      );
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT * FROM dpo_data_breach_records WHERE ${where.join(' AND ')} ORDER BY discovery_date DESC`,
        ...params,
      );
    })) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToBreachDto(r));
  }

  async getById(actor: ResolvedActor, id: string): Promise<BreachRecordDto> {
    await this.assertReadScope(actor);
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT * FROM dpo_data_breach_records WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
        id,
        tenant.schoolId,
      );
    })) as Array<Record<string, unknown>>;
    if (rows.length === 0) throw new NotFoundException(`Breach ${id} not found.`);
    return this.rowToBreachDto(rows[0]!);
  }

  async create(actor: ResolvedActor, input: CreateBreachDto): Promise<BreachRecordDto> {
    await this.assertWriteScope(actor);
    if (input.personalDataCategoriesInvolved.length === 0) {
      throw new BadRequestException(
        'personalDataCategoriesInvolved must contain at least one entry.',
      );
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO dpo_data_breach_records
         (id, school_id, breach_title, breach_type, discovery_date, breach_start_date,
          personal_data_categories_involved, estimated_affected_individuals, risk_level,
          risk_to_individuals, supervisory_authority_notification_required,
          data_subjects_notification_required, breach_cause, remediation_actions,
          is_resolved, resolved_at, reported_by, status)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5::timestamptz, $6::date, $7::text[], $8, $9, $10, $11, $12, $13, $14, false, NULL, $15::uuid, 'UNDER_INVESTIGATION')`,
        id,
        tenant.schoolId,
        input.breachTitle,
        input.breachType,
        input.discoveryDate,
        input.breachStartDate ?? null,
        input.personalDataCategoriesInvolved,
        input.estimatedAffectedIndividuals ?? null,
        input.riskLevel,
        input.riskToIndividuals,
        input.supervisoryAuthorityNotificationRequired ?? false,
        input.dataSubjectsNotificationRequired ?? false,
        input.breachCause,
        input.remediationActions,
        actor.accountId,
      );

      // REVIEW-FINAL P2 — emit via OUTBOX inside the same tx as the
      // INSERT. The 72-hour regulatory deadline depends on this
      // event reaching the TaskWorker; a transient Kafka outage at
      // emit time would silently drop the auto-task creation under
      // the previous best-effort path. With the outbox, the row
      // commits with the breach insert and the OutboxPublisherWorker
      // delivers at-least-once on the next poll.
      if (input.supervisoryAuthorityNotificationRequired) {
        const discoveryDeadline = new Date(
          new Date(input.discoveryDate).getTime() + SEVENTY_TWO_HOURS_MS,
        ).toISOString();
        await this.outbox.enqueueInTx(tx, {
          topic: 'dpo.breach.discovered',
          key: id,
          sourceModule: 'governance',
          payload: {
            breachId: id,
            schoolId: tenant.schoolId,
            breachTitle: input.breachTitle,
            breachType: input.breachType,
            discoveryDate: input.discoveryDate,
            notificationDeadline: discoveryDeadline,
            riskLevel: input.riskLevel,
            riskToIndividuals: input.riskToIndividuals,
            estimatedAffectedIndividuals: input.estimatedAffectedIndividuals ?? null,
            reportedByAccountId: actor.accountId,
            sourceRefId: id,
          },
        });
      }
    });

    return this.getById(actor, id);
  }

  async update(actor: ResolvedActor, id: string, input: UpdateBreachDto): Promise<BreachRecordDto> {
    await this.assertWriteScope(actor);
    if (input.personalDataCategoriesInvolved && input.personalDataCategoriesInvolved.length === 0) {
      throw new BadRequestException(
        'personalDataCategoriesInvolved must contain at least one entry.',
      );
    }
    const tenant = getCurrentTenant();
    // REVIEW-CYCLE30 BLOCKING 5 — locked-row + status-safe transition.
    // The schema's resolved_chk lockstep stops half-states landing, but
    // without FOR UPDATE two DPO users can both pass the pre-check and
    // both write to the same breach. Now the SELECT … FOR UPDATE runs
    // inside the same tx as the write.
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockedRows = (await tx.$queryRawUnsafe(
        `SELECT status FROM dpo_data_breach_records
          WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE`,
        id,
        tenant.schoolId,
      )) as Array<{ status: string }>;
      if (lockedRows.length === 0) throw new NotFoundException(`Breach ${id} not found.`);
      if (lockedRows[0]!.status === 'RESOLVED') {
        throw new BadRequestException(
          'A RESOLVED breach is immutable. Open a new breach record for follow-up if necessary.',
        );
      }
      const sets: string[] = [];
      const params: unknown[] = [];
      let i = 1;
      const push = (col: string, val: unknown, cast?: string) => {
        sets.push(`${col} = $${i}${cast ?? ''}`);
        params.push(val);
        i++;
      };
      if (input.breachTitle !== undefined) push('breach_title', input.breachTitle);
      if (input.breachType !== undefined) push('breach_type', input.breachType);
      if (input.breachStartDate !== undefined)
        push('breach_start_date', input.breachStartDate, '::date');
      if (input.personalDataCategoriesInvolved !== undefined)
        push('personal_data_categories_involved', input.personalDataCategoriesInvolved, '::text[]');
      if (input.estimatedAffectedIndividuals !== undefined)
        push('estimated_affected_individuals', input.estimatedAffectedIndividuals);
      if (input.riskLevel !== undefined) push('risk_level', input.riskLevel);
      if (input.riskToIndividuals !== undefined)
        push('risk_to_individuals', input.riskToIndividuals);
      if (input.supervisoryAuthorityNotificationRequired !== undefined)
        push(
          'supervisory_authority_notification_required',
          input.supervisoryAuthorityNotificationRequired,
        );
      if (input.dataSubjectsNotificationRequired !== undefined)
        push('data_subjects_notification_required', input.dataSubjectsNotificationRequired);
      if (input.breachCause !== undefined) push('breach_cause', input.breachCause);
      if (input.remediationActions !== undefined)
        push('remediation_actions', input.remediationActions);
      if (sets.length === 0) return;
      sets.push('updated_at = now()');
      params.push(id);
      params.push(tenant.schoolId);
      await tx.$executeRawUnsafe(
        `UPDATE dpo_data_breach_records SET ${sets.join(', ')} WHERE id = $${i}::uuid AND school_id = $${i + 1}::uuid`,
        ...params,
      );
    });
    return this.getById(actor, id);
  }

  async notifySupervisoryAuthority(
    actor: ResolvedActor,
    id: string,
    input: NotifySupervisoryAuthorityDto,
  ): Promise<BreachRecordDto> {
    await this.assertWriteScope(actor);
    const tenant = getCurrentTenant();
    const notifiedAt = input.notifiedAt ?? new Date().toISOString();
    // REVIEW-CYCLE30 BLOCKING 5 — locked-read + status-safe WHERE.
    // The UPDATE WHERE clause requires `notified_at IS NULL` so a
    // second concurrent caller affects 0 rows; we rowCount-check and
    // reload the row to surface the right error.
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockedRows = (await tx.$queryRawUnsafe(
        `SELECT supervisory_authority_notification_required, supervisory_authority_notified_at
           FROM dpo_data_breach_records
          WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE`,
        id,
        tenant.schoolId,
      )) as Array<{
        supervisory_authority_notification_required: boolean;
        supervisory_authority_notified_at: Date | null;
      }>;
      if (lockedRows.length === 0) throw new NotFoundException(`Breach ${id} not found.`);
      if (!lockedRows[0]!.supervisory_authority_notification_required) {
        throw new BadRequestException(
          'This breach does not require supervisory authority notification.',
        );
      }
      if (lockedRows[0]!.supervisory_authority_notified_at) {
        throw new BadRequestException('Supervisory authority has already been notified.');
      }
      await tx.$executeRawUnsafe(
        `UPDATE dpo_data_breach_records
         SET supervisory_authority_notified_at = $1::timestamptz,
             supervisory_authority_reference = $2,
             status = CASE WHEN status = 'UNDER_INVESTIGATION' THEN 'NOTIFIED' ELSE status END,
             updated_at = now()
         WHERE id = $3::uuid AND school_id = $4::uuid AND supervisory_authority_notified_at IS NULL`,
        notifiedAt,
        input.supervisoryAuthorityReference,
        id,
        tenant.schoolId,
      );
    });
    return this.getById(actor, id);
  }

  async notifyDataSubjects(
    actor: ResolvedActor,
    id: string,
    input: NotifyDataSubjectsDto,
  ): Promise<BreachRecordDto> {
    await this.assertWriteScope(actor);
    const tenant = getCurrentTenant();
    const notifiedAt = input.notifiedAt ?? new Date().toISOString();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockedRows = (await tx.$queryRawUnsafe(
        `SELECT data_subjects_notification_required, data_subjects_notified_at
           FROM dpo_data_breach_records
          WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE`,
        id,
        tenant.schoolId,
      )) as Array<{
        data_subjects_notification_required: boolean;
        data_subjects_notified_at: Date | null;
      }>;
      if (lockedRows.length === 0) throw new NotFoundException(`Breach ${id} not found.`);
      if (!lockedRows[0]!.data_subjects_notification_required) {
        throw new BadRequestException('This breach does not require data subject notification.');
      }
      if (lockedRows[0]!.data_subjects_notified_at) {
        throw new BadRequestException('Data subjects have already been notified.');
      }
      await tx.$executeRawUnsafe(
        `UPDATE dpo_data_breach_records
         SET data_subjects_notified_at = $1::timestamptz, updated_at = now()
         WHERE id = $2::uuid AND school_id = $3::uuid AND data_subjects_notified_at IS NULL`,
        notifiedAt,
        id,
        tenant.schoolId,
      );
    });
    return this.getById(actor, id);
  }

  async resolve(
    actor: ResolvedActor,
    id: string,
    input: ResolveBreachDto,
  ): Promise<BreachRecordDto> {
    await this.assertWriteScope(actor);
    const tenant = getCurrentTenant();
    const resolvedAt = input.resolvedAt ?? new Date().toISOString();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockedRows = (await tx.$queryRawUnsafe(
        `SELECT status FROM dpo_data_breach_records
          WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE`,
        id,
        tenant.schoolId,
      )) as Array<{ status: string }>;
      if (lockedRows.length === 0) throw new NotFoundException(`Breach ${id} not found.`);
      if (lockedRows[0]!.status === 'RESOLVED') {
        throw new BadRequestException('Breach is already RESOLVED.');
      }
      await tx.$executeRawUnsafe(
        `UPDATE dpo_data_breach_records
         SET status = 'RESOLVED', is_resolved = true, resolved_at = $1::timestamptz, updated_at = now()
         WHERE id = $2::uuid AND school_id = $3::uuid AND status <> 'RESOLVED'`,
        resolvedAt,
        id,
        tenant.schoolId,
      );
    });
    return this.getById(actor, id);
  }
}
