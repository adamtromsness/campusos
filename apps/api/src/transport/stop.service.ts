import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { RouteService } from './route.service';
import { RouteChangeLogService } from './route-change-log.service';
import {
  CreateStopDto,
  ReorderStopsDto,
  StopResponseDto,
  UpdateStopDto,
} from './dto/transport.dto';

@Injectable()
export class StopService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly routes: RouteService,
    private readonly changeLog: RouteChangeLogService,
  ) {}

  async create(
    routeId: string,
    input: CreateStopDto,
    actor: ResolvedActor,
  ): Promise<StopResponseDto> {
    this.routes.assertManagerScope(actor);
    await this.routes.assertCanReadRoute(routeId, actor);

    const id = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO trn_stops (id, route_id, name, address, latitude, longitude, sequence_order, scheduled_time) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::time)',
        id,
        routeId,
        input.name,
        input.address ?? null,
        input.latitude ?? null,
        input.longitude ?? null,
        input.sequenceOrder,
        input.scheduledTime ?? null,
      );
      await this.changeLog.recordChange(tx, {
        routeId,
        changedBy: actor.accountId,
        changeType: 'STOP_ADDED',
        stopId: id,
        newValue: {
          name: input.name,
          sequenceOrder: input.sequenceOrder,
          scheduledTime: input.scheduledTime ?? null,
        },
      });
    });

    const fetched = await this.getById(id);
    return fetched;
  }

  async patch(
    stopId: string,
    input: UpdateStopDto,
    actor: ResolvedActor,
  ): Promise<StopResponseDto> {
    this.routes.assertManagerScope(actor);
    const before = await this.getById(stopId);

    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.name !== undefined) {
      sets.push('name = $' + (params.length + 1));
      params.push(input.name);
    }
    if (input.address !== undefined) {
      sets.push('address = $' + (params.length + 1));
      params.push(input.address);
    }
    if (input.sequenceOrder !== undefined) {
      sets.push('sequence_order = $' + (params.length + 1));
      params.push(input.sequenceOrder);
    }
    if (input.scheduledTime !== undefined) {
      sets.push('scheduled_time = $' + (params.length + 1) + '::time');
      params.push(input.scheduledTime);
    }
    if (sets.length === 0) return before;

    sets.push('updated_at = now()');
    params.push(stopId);

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'UPDATE trn_stops SET ' + sets.join(', ') + ' WHERE id = $' + params.length + '::uuid',
        ...params,
      );

      if (input.scheduledTime !== undefined && input.scheduledTime !== before.scheduledTime) {
        await this.changeLog.recordChange(tx, {
          routeId: before.routeId,
          changedBy: actor.accountId,
          changeType: 'STOP_TIME_CHANGED',
          stopId,
          oldValue: { scheduledTime: before.scheduledTime },
          newValue: { scheduledTime: input.scheduledTime },
        });
      }
      if (input.sequenceOrder !== undefined && input.sequenceOrder !== before.sequenceOrder) {
        await this.changeLog.recordChange(tx, {
          routeId: before.routeId,
          changedBy: actor.accountId,
          changeType: 'STOP_REORDERED',
          stopId,
          oldValue: { sequenceOrder: before.sequenceOrder },
          newValue: { sequenceOrder: input.sequenceOrder },
        });
      }
    });

    return this.getById(stopId);
  }

  async remove(stopId: string, actor: ResolvedActor): Promise<void> {
    this.routes.assertManagerScope(actor);
    const before = await this.getById(stopId);

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Refuse if any active student assignments reference this stop
      const refs = (await tx.$queryRawUnsafe(
        'SELECT COUNT(*)::int AS c FROM trn_student_assignments WHERE stop_id = $1::uuid AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)',
        stopId,
      )) as Array<{ c: number }>;
      if (refs[0]!.c > 0) {
        throw new BadRequestException(
          'Cannot delete a stop with active student assignments. Reassign students first.',
        );
      }
      await tx.$executeRawUnsafe('DELETE FROM trn_stops WHERE id = $1::uuid', stopId);
      await this.changeLog.recordChange(tx, {
        routeId: before.routeId,
        changedBy: actor.accountId,
        changeType: 'STOP_REMOVED',
        stopId,
        oldValue: {
          name: before.name,
          sequenceOrder: before.sequenceOrder,
        },
      });
    });
  }

  async reorder(
    routeId: string,
    input: ReorderStopsDto,
    actor: ResolvedActor,
  ): Promise<StopResponseDto[]> {
    this.routes.assertManagerScope(actor);
    await this.routes.assertCanReadRoute(routeId, actor);

    if (input.stops.length === 0) return [];

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Verify all stops belong to the route
      const ids = input.stops.map((s) => s.stopId);
      const verify = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id FROM trn_stops WHERE route_id = $1::uuid AND id = ANY($2::uuid[])',
        routeId,
        ids,
      )) as Array<{ id: string }>;
      if (verify.length !== ids.length) {
        throw new BadRequestException('One or more stops do not belong to this route');
      }

      // Two-phase reorder to avoid temporary UNIQUE-violation hits if
      // a UNIQUE constraint were ever added later. The schema does not
      // enforce UNIQUE on (route_id, sequence_order) today, so the
      // single UPDATE pass is fine — the two-phase shape is forward
      // compatible.
      for (const s of input.stops) {
        await tx.$executeRawUnsafe(
          'UPDATE trn_stops SET sequence_order = $1, updated_at = now() WHERE id = $2::uuid',
          -s.sequenceOrder,
          s.stopId,
        );
      }
      for (const s of input.stops) {
        await tx.$executeRawUnsafe(
          'UPDATE trn_stops SET sequence_order = $1 WHERE id = $2::uuid',
          s.sequenceOrder,
          s.stopId,
        );
      }
      await this.changeLog.recordChange(tx, {
        routeId,
        changedBy: actor.accountId,
        changeType: 'STOP_REORDERED',
        newValue: { reorderedCount: input.stops.length },
      });
    });

    return this.routes.getStops(routeId);
  }

  async getById(stopId: string): Promise<StopResponseDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, route_id::text AS route_id, name, address, latitude, longitude, sequence_order, ' +
          "to_char(scheduled_time, 'HH24:MI:SS') AS scheduled_time, notes " +
          'FROM trn_stops WHERE id = $1::uuid LIMIT 1',
        stopId,
      );
    })) as Array<{
      id: string;
      route_id: string;
      name: string;
      address: string | null;
      latitude: number | null;
      longitude: number | null;
      sequence_order: number;
      scheduled_time: string | null;
      notes: string | null;
    }>;
    if (rows.length === 0) throw new NotFoundException('Stop not found');
    const r = rows[0]!;
    return {
      id: r.id,
      routeId: r.route_id,
      name: r.name,
      address: r.address,
      latitude: r.latitude !== null ? Number(r.latitude) : null,
      longitude: r.longitude !== null ? Number(r.longitude) : null,
      sequenceOrder: r.sequence_order,
      scheduledTime: r.scheduled_time,
      notes: r.notes,
    };
  }
}
