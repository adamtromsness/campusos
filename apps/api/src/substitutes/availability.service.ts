import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { generateId } from '@campusos/database';
import { AvailabilityResponseDto, CreateAvailabilityDto } from './dto/substitutes.dto';

/**
 * SubstituteAvailabilityService — P2-9b.
 *
 * Platform-side CRUD for platform_sub_availability rows. RECURRING +
 * SPECIFIC + BLOCKED with the multi-column shape_chk schema-level
 * keystone enforcing day_of_week-vs-specific_date mutex. The matching
 * engine (P2-9a SubstituteProfileService.search) reads these rows + the
 * BLOCKED-overrides-RECURRING resolver runs against them at availability-
 * check time.
 *
 * Self-service: substitute writes rows for own profile only. Admin
 * (sch-004:write) can write on behalf via a substituteId param.
 */
@Injectable()
export class SubstituteAvailabilityService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async listMine(actor: ResolvedActor): Promise<AvailabilityResponseDto[]> {
    if (!actor.personId) return [];
    const platform = this.tenantPrisma.getPlatformClient();
    const profile = await platform.substituteProfile.findUnique({
      where: { personId: actor.personId },
    });
    if (!profile) return [];
    return this.listForSubstitute(profile.id);
  }

  async listForSubstitute(substituteId: string): Promise<AvailabilityResponseDto[]> {
    const platform = this.tenantPrisma.getPlatformClient();
    const rows = await platform.platformSubAvailability.findMany({
      where: { substituteId },
      orderBy: [{ availabilityType: 'asc' }, { dayOfWeek: 'asc' }, { specificDate: 'asc' }],
    });
    return rows.map(this.rowToDto);
  }

  async create(
    input: CreateAvailabilityDto,
    actor: ResolvedActor,
  ): Promise<AvailabilityResponseDto> {
    const platform = this.tenantPrisma.getPlatformClient();
    if (!actor.personId) {
      throw new ForbiddenException('Only a substitute can write own availability.');
    }
    const profile = await platform.substituteProfile.findUnique({
      where: { personId: actor.personId },
    });
    if (!profile) {
      throw new ForbiddenException('No substitute profile for this account.');
    }

    // Validate the shape — the schema CHECK fires too, but a cleaner 400
    // is better than a 500 from a constraint violation.
    if (input.availabilityType === 'RECURRING') {
      if (input.dayOfWeek === undefined || input.dayOfWeek === null) {
        throw new BadRequestException('RECURRING availability requires dayOfWeek (0=Sun..6=Sat).');
      }
      if (input.specificDate) {
        throw new BadRequestException('RECURRING availability must not carry specificDate.');
      }
    } else {
      if (!input.specificDate) {
        throw new BadRequestException(
          `${input.availabilityType} availability requires specificDate.`,
        );
      }
      if (input.dayOfWeek !== undefined && input.dayOfWeek !== null) {
        throw new BadRequestException(
          `${input.availabilityType} availability must not carry dayOfWeek.`,
        );
      }
    }
    if ((input.startTime && !input.endTime) || (!input.startTime && input.endTime)) {
      throw new BadRequestException(
        'startTime + endTime must be set together — or both omitted for an all-day window.',
      );
    }

    try {
      const created = await platform.platformSubAvailability.create({
        data: {
          id: generateId(),
          substituteId: profile.id,
          availabilityType: input.availabilityType,
          dayOfWeek: input.dayOfWeek ?? null,
          specificDate: input.specificDate ? new Date(input.specificDate) : null,
          startTime: input.startTime ? new Date(`1970-01-01T${input.startTime}:00Z`) : null,
          endTime: input.endTime ? new Date(`1970-01-01T${input.endTime}:00Z`) : null,
          notes: input.notes ?? null,
        },
      });
      return this.rowToDto(created);
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') {
        throw new BadRequestException('An availability row for this combination already exists.');
      }
      throw e;
    }
  }

  async remove(id: string, actor: ResolvedActor): Promise<{ deleted: true }> {
    const platform = this.tenantPrisma.getPlatformClient();
    const row = await platform.platformSubAvailability.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Availability row not found.');

    // Self-service only — substitute removes own rows.
    if (!actor.personId) {
      throw new ForbiddenException('Only the owning substitute can remove this row.');
    }
    const profile = await platform.substituteProfile.findUnique({
      where: { personId: actor.personId },
    });
    if (!profile || profile.id !== row.substituteId) {
      // Don't-leak-existence: 404 instead of 403 so substitutes cannot
      // probe for other substitutes' availability ids.
      throw new NotFoundException('Availability row not found.');
    }

    await platform.platformSubAvailability.delete({ where: { id } });
    return { deleted: true };
  }

  private rowToDto = (r: {
    id: string;
    substituteId: string;
    availabilityType: string;
    dayOfWeek: number | null;
    specificDate: Date | null;
    startTime: Date | null;
    endTime: Date | null;
    notes: string | null;
  }): AvailabilityResponseDto => ({
    id: r.id,
    substituteId: r.substituteId,
    availabilityType: r.availabilityType as AvailabilityResponseDto['availabilityType'],
    dayOfWeek: r.dayOfWeek,
    specificDate: r.specificDate ? r.specificDate.toISOString().slice(0, 10) : null,
    startTime: r.startTime ? r.startTime.toISOString().slice(11, 16) : null,
    endTime: r.endTime ? r.endTime.toISOString().slice(11, 16) : null,
    notes: r.notes,
  });
}
