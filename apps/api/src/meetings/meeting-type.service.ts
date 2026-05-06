import { Injectable, NotFoundException } from '@nestjs/common';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { MeetingTypeResponseDto } from './dto/meeting.dto';

interface TypeRow {
  id: string;
  school_id: string;
  name: string;
  description: string | null;
  default_duration_minutes: number;
  is_video: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

const SELECT_TYPE =
  'SELECT id::text AS id, school_id::text AS school_id, name, description, ' +
  'default_duration_minutes, is_video, is_active, ' +
  'TO_CHAR(created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM mtg_meeting_types ';

function rowToDto(r: TypeRow): MeetingTypeResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    name: r.name,
    description: r.description,
    defaultDurationMinutes: r.default_duration_minutes,
    isVideo: r.is_video,
    isActive: r.is_active,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

@Injectable()
export class MeetingTypeService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async list(): Promise<MeetingTypeResponseDto[]> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_TYPE + 'WHERE school_id = $1::uuid AND is_active = true ORDER BY name ASC',
        tenant.schoolId,
      );
    })) as TypeRow[];
    return rows.map(rowToDto);
  }

  async getById(id: string): Promise<MeetingTypeResponseDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_TYPE + 'WHERE id = $1::uuid AND school_id = $2::uuid',
        id,
        tenant.schoolId,
      );
    })) as TypeRow[];
    if (rows.length === 0) throw new NotFoundException('Meeting type not found');
    return rowToDto(rows[0]!);
  }
}
