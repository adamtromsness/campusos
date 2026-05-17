import { ForbiddenException, Injectable } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { KafkaProducerService } from '@shared/kafka/kafka-producer.service';
import { CreateDelayReportDto, DelayReportResponseDto } from './dto/transport.dto';

@Injectable()
export class DelayReportService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
  ) {}

  async list(
    actor: ResolvedActor,
    args: { routeId?: string; date?: string },
  ): Promise<DelayReportResponseDto[]> {
    if (!actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      throw new ForbiddenException('Only admins or staff can read delay reports');
    }
    const where: string[] = [];
    const params: unknown[] = [];
    if (args.routeId) {
      where.push('route_id = $' + (params.length + 1) + '::uuid');
      params.push(args.routeId);
    }
    if (args.date) {
      where.push('run_date = $' + (params.length + 1) + '::date');
      params.push(args.date);
    }
    const whereSql = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, route_id::text AS route_id, run_date, reported_by::text AS reported_by, ' +
          'delay_minutes, reason, affected_stops, parent_notification_sent, reported_at ' +
          'FROM trn_delay_reports ' +
          whereSql +
          ' ORDER BY run_date DESC, reported_at DESC LIMIT 200',
        ...params,
      );
    })) as Array<{
      id: string;
      route_id: string;
      run_date: Date;
      reported_by: string;
      delay_minutes: number;
      reason: string;
      affected_stops: string[] | null;
      parent_notification_sent: boolean;
      reported_at: Date;
    }>;
    return rows.map((r) => ({
      id: r.id,
      routeId: r.route_id,
      runDate: r.run_date.toISOString().slice(0, 10),
      reportedBy: r.reported_by,
      delayMinutes: r.delay_minutes,
      reason: r.reason,
      affectedStops: r.affected_stops,
      parentNotificationSent: r.parent_notification_sent,
      reportedAt: r.reported_at.toISOString(),
    }));
  }

  async create(input: CreateDelayReportDto, actor: ResolvedActor): Promise<DelayReportResponseDto> {
    if (!actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      throw new ForbiddenException('Only drivers, admins, or staff can report delays');
    }
    getCurrentTenant(); // ensures tenant context is active
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO trn_delay_reports (id, route_id, run_date, reported_by, delay_minutes, reason, affected_stops, parent_notification_sent, reported_at) ' +
          'VALUES ($1::uuid, $2::uuid, $3::date, $4::uuid, $5, $6, $7::text[], false, now())',
        id,
        input.routeId,
        input.runDate,
        actor.accountId,
        input.delayMinutes,
        input.reason,
        input.affectedStops ?? null,
      );
    });

    await this.kafka.emit({
      topic: 'trn.delay.reported',
      key: id,
      sourceModule: 'transport',
      payload: {
        delayId: id,
        routeId: input.routeId,
        runDate: input.runDate,
        reportedById: actor.accountId,
        delayMinutes: input.delayMinutes,
        reason: input.reason,
        affectedStops: input.affectedStops ?? [],
      },
    });

    const rows = await this.list(actor, { routeId: input.routeId, date: input.runDate });
    return rows.find((r) => r.id === id) ?? rows[0]!;
  }
}
