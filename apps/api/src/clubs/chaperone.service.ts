import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  AddChaperoneDto,
  BackgroundCheckStatus,
  ChaperoneRole,
  FieldTripChaperoneDto,
  UpdateChaperoneDto,
} from './dto/clubs.dto';

interface ChaperoneRow {
  id: string;
  field_trip_id: string;
  person_id: string;
  person_name: string | null;
  role: string;
  background_check_status: string;
  confirmed: boolean;
}

const SELECT_CHAPERONE =
  'SELECT c.id::text AS id, c.field_trip_id::text AS field_trip_id, ' +
  'c.person_id::text AS person_id, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.iam_person ip WHERE ip.id = c.person_id) AS person_name, " +
  'c.role, c.background_check_status, c.confirmed ' +
  'FROM ext_field_trip_chaperones c ';

function rowToDto(r: ChaperoneRow): FieldTripChaperoneDto {
  return {
    id: r.id,
    fieldTripId: r.field_trip_id,
    personId: r.person_id,
    personName: r.person_name,
    role: r.role as ChaperoneRole,
    backgroundCheckStatus: r.background_check_status as BackgroundCheckStatus,
    confirmed: r.confirmed,
  };
}

@Injectable()
export class ChaperoneService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private isManager(actor: ResolvedActor): boolean {
    return actor.isSchoolAdmin || actor.personType === 'STAFF';
  }

  async add(
    tripId: string,
    input: AddChaperoneDto,
    actor: ResolvedActor,
  ): Promise<FieldTripChaperoneDto> {
    if (!this.isManager(actor)) {
      throw new ForbiddenException('Only Staff or admins can assign chaperones');
    }
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO ext_field_trip_chaperones (id, field_trip_id, person_id, role) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4)',
          id,
          tripId,
          input.personId,
          input.role ?? 'CHAPERONE',
        );
      });
    } catch (e) {
      const err = e as { code?: string; meta?: { code?: string }; message?: string };
      if (err.code === '23505' || /duplicate key|already exists/i.test(err.message ?? '')) {
        throw new BadRequestException('Person is already assigned as a chaperone on this trip');
      }
      throw e;
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_CHAPERONE + 'WHERE c.id = $1::uuid', id);
    })) as ChaperoneRow[];
    return rowToDto(rows[0]!);
  }

  async patch(
    id: string,
    input: UpdateChaperoneDto,
    actor: ResolvedActor,
  ): Promise<FieldTripChaperoneDto> {
    if (!this.isManager(actor)) {
      throw new ForbiddenException('Only Staff or admins can update chaperones');
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.backgroundCheckStatus !== undefined) {
      params.push(input.backgroundCheckStatus);
      sets.push('background_check_status = $' + params.length);
    }
    if (input.confirmed !== undefined) {
      params.push(input.confirmed);
      sets.push('confirmed = $' + params.length);
    }
    if (sets.length === 0) {
      const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(SELECT_CHAPERONE + 'WHERE c.id = $1::uuid', id);
      })) as ChaperoneRow[];
      if (rows.length === 0) throw new NotFoundException('Chaperone not found');
      return rowToDto(rows[0]!);
    }
    sets.push('updated_at = now()');
    params.push(id);
    const updated = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$executeRawUnsafe(
        'UPDATE ext_field_trip_chaperones SET ' +
          sets.join(', ') +
          ' WHERE id = $' +
          params.length +
          '::uuid',
        ...params,
      );
    });
    if (updated === 0) throw new NotFoundException('Chaperone not found');
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_CHAPERONE + 'WHERE c.id = $1::uuid', id);
    })) as ChaperoneRow[];
    return rowToDto(rows[0]!);
  }
}
