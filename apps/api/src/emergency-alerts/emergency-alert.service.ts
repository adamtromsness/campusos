import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import { AlertTypeService } from './alert-type.service';
import {
  AlertChannel,
  AlertSeverity,
  AlertStatus,
  DeliveryStatus,
  EmergencyAlertDeliveryDto,
  EmergencyAlertResponseDto,
  EmergencyAlertStatusDto,
  IssueEmergencyAlertDto,
  ListEmergencyAlertsQueryDto,
} from './dto/emergency-alert.dto';

interface AlertRow {
  id: string;
  school_id: string;
  alert_type_id: string;
  alert_type_name: string | null;
  alert_severity: string;
  requires_acknowledgement: boolean;
  title: string;
  body: string;
  issued_by: string;
  issued_by_name: string | null;
  incident_id: string | null;
  issued_at: string;
  status: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolved_by_name: string | null;
  created_at: string;
  updated_at: string;
}

interface DeliveryRow {
  id: string;
  alert_id: string;
  recipient_id: string;
  recipient_name: string | null;
  channel: string;
  status: string;
  sent_at: string | null;
  acknowledged_at: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_ALERT =
  'SELECT a.id::text AS id, a.school_id::text AS school_id, ' +
  'a.alert_type_id::text AS alert_type_id, t.name AS alert_type_name, ' +
  't.severity AS alert_severity, t.requires_acknowledgement, ' +
  'a.title, a.body, a.issued_by::text AS issued_by, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.platform_users pu " +
  '  JOIN platform.iam_person ip ON ip.id = pu.person_id ' +
  '  WHERE pu.id = a.issued_by) AS issued_by_name, ' +
  'a.incident_id::text AS incident_id, ' +
  'TO_CHAR(a.issued_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS issued_at, ' +
  'a.status, ' +
  'TO_CHAR(a.resolved_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS resolved_at, ' +
  'a.resolved_by::text AS resolved_by, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.platform_users pu " +
  '  JOIN platform.iam_person ip ON ip.id = pu.person_id ' +
  '  WHERE pu.id = a.resolved_by) AS resolved_by_name, ' +
  'TO_CHAR(a.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(a.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM msg_emergency_alerts a ' +
  'JOIN msg_alert_types t ON t.id = a.alert_type_id ';

const SELECT_DELIVERY =
  'SELECT d.id::text AS id, d.alert_id::text AS alert_id, ' +
  'd.recipient_id::text AS recipient_id, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.platform_users pu " +
  '  JOIN platform.iam_person ip ON ip.id = pu.person_id ' +
  '  WHERE pu.id = d.recipient_id) AS recipient_name, ' +
  'd.channel, d.status, ' +
  'TO_CHAR(d.sent_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS sent_at, ' +
  'TO_CHAR(d.acknowledged_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS acknowledged_at, ' +
  'd.failure_reason, ' +
  'TO_CHAR(d.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(d.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM msg_emergency_alert_deliveries d ';

function alertRowToDto(r: AlertRow): EmergencyAlertResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    alertTypeId: r.alert_type_id,
    alertTypeName: r.alert_type_name,
    alertSeverity: r.alert_severity as AlertSeverity,
    requiresAcknowledgement: r.requires_acknowledgement,
    title: r.title,
    body: r.body,
    issuedBy: r.issued_by,
    issuedByName: r.issued_by_name,
    incidentId: r.incident_id,
    issuedAt: r.issued_at,
    status: r.status as AlertStatus,
    resolvedAt: r.resolved_at,
    resolvedBy: r.resolved_by,
    resolvedByName: r.resolved_by_name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function deliveryRowToDto(r: DeliveryRow): EmergencyAlertDeliveryDto {
  return {
    id: r.id,
    alertId: r.alert_id,
    recipientId: r.recipient_id,
    recipientName: r.recipient_name,
    channel: r.channel as AlertChannel,
    status: r.status as DeliveryStatus,
    sentAt: r.sent_at,
    acknowledgedAt: r.acknowledged_at,
    failureReason: r.failure_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

@Injectable()
export class EmergencyAlertService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly alertTypes: AlertTypeService,
    private readonly kafka: KafkaProducerService,
    private readonly permissions: PermissionCheckService,
  ) {}

  /**
   * Issuer scope = School Admin OR holds com-003:write. Generic
   * com-003:read is held by every persona for banner read access
   * but never grants issue rights.
   */
  private async hasIssuerScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'com-003:write',
    ]);
  }

  async list(
    filters: ListEmergencyAlertsQueryDto,
    actor: ResolvedActor,
  ): Promise<EmergencyAlertResponseDto[]> {
    const tenant = getCurrentTenant();
    const sql: string[] = [SELECT_ALERT, 'WHERE a.school_id = $1::uuid '];
    const params: unknown[] = [tenant.schoolId];
    if (filters.status) {
      params.push(filters.status);
      sql.push('AND a.status = $' + params.length + ' ');
    }
    sql.push('ORDER BY a.issued_at DESC LIMIT 200');
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<AlertRow[]>(sql.join(''), ...params);
    });

    if (rows.length === 0) return [];

    // Inline myDelivery for non-admin readers so the banner can decide
    // whether to render. Admins get the per-recipient deliveries via
    // getById on the dashboard instead.
    if (!actor.isSchoolAdmin) {
      const alertIds = rows.map((r) => r.id);
      const deliveries = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<DeliveryRow[]>(
          SELECT_DELIVERY + 'WHERE d.recipient_id = $1::uuid AND d.alert_id = ANY($2::uuid[])',
          actor.accountId,
          alertIds,
        );
      })) as DeliveryRow[];
      const myByAlert = new Map<string, EmergencyAlertDeliveryDto>();
      for (const d of deliveries) {
        myByAlert.set(d.alert_id, deliveryRowToDto(d));
      }
      return rows.map((r) => {
        const dto = alertRowToDto(r);
        dto.myDelivery = myByAlert.get(r.id) ?? null;
        return dto;
      });
    }

    return rows.map(alertRowToDto);
  }

  async getById(id: string, actor: ResolvedActor): Promise<EmergencyAlertResponseDto> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<AlertRow[]>(
        SELECT_ALERT + 'WHERE a.id = $1::uuid AND a.school_id = $2::uuid',
        id,
        tenant.schoolId,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Emergency alert not found');
    const dto = alertRowToDto(rows[0]!);

    if (actor.isSchoolAdmin || (await this.hasIssuerScope(actor))) {
      // Admin / issuer view: full deliveries inlined
      const deliveries = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<DeliveryRow[]>(
          SELECT_DELIVERY + 'WHERE d.alert_id = $1::uuid ORDER BY d.created_at ASC',
          id,
        );
      });
      dto.deliveries = deliveries.map(deliveryRowToDto);
    } else {
      // Recipient view: only own delivery row
      const deliveries = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<DeliveryRow[]>(
          SELECT_DELIVERY + 'WHERE d.alert_id = $1::uuid AND d.recipient_id = $2::uuid',
          id,
          actor.accountId,
        );
      });
      dto.myDelivery = deliveries.length > 0 ? deliveryRowToDto(deliveries[0]!) : null;
    }

    return dto;
  }

  /**
   * Issue keystone. Validates the alert type exists + is active,
   * INSERTs the head row, fans out delivery rows for every active
   * platform user in the school per the alert type's default
   * channels (or the channels override on the input), all inside
   * one tenant transaction. Emits msg.emergency.issued AFTER tx
   * commit so a Kafka hiccup cannot roll back the alert.
   */
  async issue(
    input: IssueEmergencyAlertDto,
    actor: ResolvedActor,
  ): Promise<EmergencyAlertResponseDto> {
    if (!(await this.hasIssuerScope(actor))) {
      throw new ForbiddenException('Only admins or staff with com-003:write can issue alerts');
    }
    const tenant = getCurrentTenant();
    const alertType = await this.alertTypes.loadActiveOrFail(input.alertTypeId);
    const channels =
      input.channels && input.channels.length > 0 ? input.channels : alertType.defaultChannels;
    if (channels.length === 0) {
      throw new BadRequestException(
        'Alert type has no default channels and no channels override was supplied.',
      );
    }

    const alertId = generateId();
    let recipientCount = 0;
    let deliveryCount = 0;

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO msg_emergency_alerts (id, school_id, alert_type_id, title, body, issued_by, incident_id, status) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid, $7::uuid, 'ACTIVE')",
        alertId,
        tenant.schoolId,
        input.alertTypeId,
        input.title,
        input.body,
        actor.accountId,
        input.incidentId ?? null,
      );

      // Resolve recipients — every active platform_user with a
      // role assignment scoped to the school OR platform-tier.
      // Mirrors the audience-fan-out approach used by Cycle 3
      // AudienceFanOutWorker for ALL_SCHOOL announcements.
      const recipients = (await tx.$queryRawUnsafe(
        'SELECT DISTINCT pu.id::text AS id FROM platform.platform_users pu ' +
          'JOIN platform.iam_role_assignment ra ON ra.account_id = pu.id ' +
          'JOIN platform.iam_scope sc ON sc.id = ra.scope_id ' +
          'JOIN platform.iam_scope_type st ON st.id = sc.scope_type_id ' +
          "WHERE pu.is_active = true AND ra.is_active = true AND st.name IN ('SCHOOL', 'PLATFORM') " +
          "AND (sc.scope_ref_id = $1::uuid OR st.name = 'PLATFORM')",
        tenant.schoolId,
      )) as Array<{ id: string }>;
      recipientCount = recipients.length;

      for (const r of recipients) {
        for (const channel of channels) {
          const delivId = generateId();
          await tx.$executeRawUnsafe(
            'INSERT INTO msg_emergency_alert_deliveries (id, alert_id, recipient_id, channel, status) ' +
              "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'PENDING') " +
              'ON CONFLICT (alert_id, recipient_id, channel) DO NOTHING',
            delivId,
            alertId,
            r.id,
            channel,
          );
          deliveryCount += 1;
        }
      }
    });

    // Emit AFTER tx commit
    try {
      await this.kafka.emit({
        topic: 'msg.emergency.issued',
        key: alertId,
        sourceModule: 'communications',
        payload: {
          alertId,
          schoolId: tenant.schoolId,
          alertTypeId: input.alertTypeId,
          alertTypeName: alertType.name,
          severity: alertType.severity,
          title: input.title,
          body: input.body,
          issuedBy: actor.accountId,
          channels,
          recipientCount,
          deliveryCount,
          requiresAcknowledgement: alertType.requiresAcknowledgement,
          sourceRefId: alertId,
        },
      });
    } catch {
      // Best-effort emit per existing convention
    }

    return this.getById(alertId, actor);
  }

  async resolve(id: string, actor: ResolvedActor): Promise<EmergencyAlertResponseDto> {
    if (!(await this.hasIssuerScope(actor))) {
      throw new ForbiddenException('Only admins or staff with com-003:write can resolve alerts');
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id, status FROM msg_emergency_alerts WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ id: string; status: string }>;
      if (lock.length === 0) throw new NotFoundException('Emergency alert not found');
      if (lock[0]!.status === 'RESOLVED') {
        throw new BadRequestException('Alert is already RESOLVED');
      }
      await tx.$executeRawUnsafe(
        "UPDATE msg_emergency_alerts SET status = 'RESOLVED', resolved_at = now(), resolved_by = $1::uuid, updated_at = now() WHERE id = $2::uuid",
        actor.accountId,
        id,
      );
    });
    return this.getById(id, actor);
  }

  /**
   * Recipient acknowledges their own delivery. Idempotent — re-ack
   * leaves the existing acknowledged_at in place. Row scope =
   * delivery.recipient_id == actor.accountId.
   */
  async acknowledgeDelivery(
    deliveryId: string,
    actor: ResolvedActor,
  ): Promise<EmergencyAlertDeliveryDto> {
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id, recipient_id::text AS recipient_id, alert_id::text AS alert_id, acknowledged_at FROM msg_emergency_alert_deliveries WHERE id = $1::uuid FOR UPDATE',
        deliveryId,
      )) as Array<{
        id: string;
        recipient_id: string;
        alert_id: string;
        acknowledged_at: string | null;
      }>;
      if (lock.length === 0) throw new NotFoundException('Delivery not found');
      if (lock[0]!.recipient_id !== actor.accountId) {
        // Don't leak existence to the wrong recipient
        throw new NotFoundException('Delivery not found');
      }
      if (lock[0]!.acknowledged_at === null) {
        await tx.$executeRawUnsafe(
          'UPDATE msg_emergency_alert_deliveries SET acknowledged_at = now(), updated_at = now() WHERE id = $1::uuid',
          deliveryId,
        );
      }
    });

    // Re-fetch the delivery row
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<DeliveryRow[]>(
        SELECT_DELIVERY + 'WHERE d.id = $1::uuid',
        deliveryId,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Delivery not found');
    return deliveryRowToDto(rows[0]!);
  }

  async status(id: string, actor: ResolvedActor): Promise<EmergencyAlertStatusDto> {
    if (!(await this.hasIssuerScope(actor))) {
      throw new ForbiddenException('Only admins or staff with com-003:write can view alert status');
    }
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<
        Array<{
          total: number;
          sent: number;
          delivered: number;
          ack: number;
          failed: number;
          pending: number;
        }>
      >(
        'SELECT COUNT(*)::int AS total, ' +
          "SUM(CASE WHEN status = 'SENT' THEN 1 ELSE 0 END)::int AS sent, " +
          "SUM(CASE WHEN status = 'DELIVERED' THEN 1 ELSE 0 END)::int AS delivered, " +
          'SUM(CASE WHEN acknowledged_at IS NOT NULL THEN 1 ELSE 0 END)::int AS ack, ' +
          "SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END)::int AS failed, " +
          "SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END)::int AS pending " +
          'FROM msg_emergency_alert_deliveries WHERE alert_id = $1::uuid',
        id,
      );
    });
    const r = rows[0] || { total: 0, sent: 0, delivered: 0, ack: 0, failed: 0, pending: 0 };
    return {
      alertId: id,
      totalDeliveries: r.total,
      sentCount: r.sent,
      deliveredCount: r.delivered,
      acknowledgedCount: r.ack,
      failedCount: r.failed,
      pendingCount: r.pending,
    };
  }
}
