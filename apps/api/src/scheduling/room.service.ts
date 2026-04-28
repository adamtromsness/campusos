import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  CreateRoomDto,
  ListRoomsQueryDto,
  RoomAvailabilityDto,
  RoomResponseDto,
  UpdateRoomDto,
} from './dto/room.dto';

interface RoomRow {
  id: string;
  school_id: string;
  name: string;
  capacity: number | null;
  room_type: string;
  has_projector: boolean;
  has_av: boolean;
  floor: string | null;
  building: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

function rowToDto(row: RoomRow): RoomResponseDto {
  return {
    id: row.id,
    schoolId: row.school_id,
    name: row.name,
    capacity: row.capacity === null ? null : Number(row.capacity),
    roomType: row.room_type as RoomResponseDto['roomType'],
    hasProjector: row.has_projector,
    hasAv: row.has_av,
    floor: row.floor,
    building: row.building,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

var SELECT_ROOM_BASE =
  'SELECT id, school_id, name, capacity, room_type, has_projector, has_av, floor, building, is_active, created_at, updated_at ' +
  'FROM sch_rooms ';

@Injectable()
export class RoomService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async list(query: ListRoomsQueryDto): Promise<RoomAvailabilityDto[]> {
    var includeInactive = query.includeInactive === true;
    var roomType = query.roomType ?? null;
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<RoomRow[]>(
        SELECT_ROOM_BASE +
          'WHERE ($1::boolean = true OR is_active = true) ' +
          'AND ($2::text IS NULL OR room_type = $2::text) ' +
          'ORDER BY building NULLS LAST, floor NULLS LAST, name',
        includeInactive,
        roomType,
      );
    });
    var checkAvailability =
      query.availabilityDate !== undefined &&
      query.availabilityDate !== null &&
      query.availabilityPeriodId !== undefined &&
      query.availabilityPeriodId !== null;
    if (!checkAvailability) {
      return rows.map(function (r) {
        return Object.assign({}, rowToDto(r), { available: null });
      });
    }
    var busyRoomIds = await this.tenantPrisma.executeInTenantContext(async (client) => {
      var slotRows = await client.$queryRawUnsafe<Array<{ room_id: string }>>(
        'SELECT DISTINCT room_id FROM sch_timetable_slots ' +
          'WHERE period_id = $1::uuid ' +
          'AND effective_from <= $2::date ' +
          'AND (effective_to IS NULL OR effective_to >= $2::date)',
        query.availabilityPeriodId,
        query.availabilityDate,
      );
      return new Set(
        slotRows.map(function (r) {
          return r.room_id;
        }),
      );
    });
    return rows.map(function (r) {
      return Object.assign({}, rowToDto(r), {
        available: !busyRoomIds.has(r.id),
      });
    });
  }

  async getById(id: string): Promise<RoomResponseDto> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<RoomRow[]>(SELECT_ROOM_BASE + 'WHERE id = $1::uuid', id);
    });
    if (rows.length === 0) throw new NotFoundException('Room ' + id + ' not found');
    return rowToDto(rows[0]!);
  }

  async create(body: CreateRoomDto, actor: ResolvedActor): Promise<RoomResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can create rooms');
    }
    var schoolId = getCurrentTenant().schoolId;
    var roomId = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO sch_rooms (id, school_id, name, capacity, room_type, has_projector, has_av, floor, building) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9)',
        roomId,
        schoolId,
        body.name,
        body.capacity ?? null,
        body.roomType,
        body.hasProjector === true,
        body.hasAv === true,
        body.floor ?? null,
        body.building ?? null,
      );
    });
    return this.getById(roomId);
  }

  async update(id: string, body: UpdateRoomDto, actor: ResolvedActor): Promise<RoomResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can update rooms');
    }
    var existing = await this.getById(id);

    var setClauses: string[] = [];
    var params: any[] = [];
    var idx = 1;
    if (body.name !== undefined) {
      setClauses.push('name = $' + idx);
      params.push(body.name);
      idx++;
    }
    if (body.capacity !== undefined) {
      setClauses.push('capacity = $' + idx);
      params.push(body.capacity);
      idx++;
    }
    if (body.roomType !== undefined) {
      setClauses.push('room_type = $' + idx);
      params.push(body.roomType);
      idx++;
    }
    if (body.hasProjector !== undefined) {
      setClauses.push('has_projector = $' + idx);
      params.push(body.hasProjector);
      idx++;
    }
    if (body.hasAv !== undefined) {
      setClauses.push('has_av = $' + idx);
      params.push(body.hasAv);
      idx++;
    }
    if (body.floor !== undefined) {
      setClauses.push('floor = $' + idx);
      params.push(body.floor);
      idx++;
    }
    if (body.building !== undefined) {
      setClauses.push('building = $' + idx);
      params.push(body.building);
      idx++;
    }
    if (body.isActive !== undefined) {
      setClauses.push('is_active = $' + idx);
      params.push(body.isActive);
      idx++;
    }
    if (setClauses.length === 0) return existing;

    setClauses.push('updated_at = now()');
    params.push(id);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'UPDATE sch_rooms SET ' + setClauses.join(', ') + ' WHERE id = $' + idx + '::uuid',
        ...params,
      );
    });
    return this.getById(id);
  }
}
