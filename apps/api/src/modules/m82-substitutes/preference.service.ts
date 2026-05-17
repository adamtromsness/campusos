import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { generateId } from '@campusos/database';
import { CreatePreferenceDto, PreferenceResponseDto } from './dto/substitutes.dto';

/**
 * SubstitutePreferenceService — P2-9b.
 *
 * Substitute marks schools as PREFERRED or BLOCKED. reason is private —
 * visible only to the substitute. The matching engine excludes BLOCKED
 * schools from notification fan-out and prioritises PREFERRED rows.
 *
 * Self-service only — substitutes write their own preferences.
 */
@Injectable()
export class SubstitutePreferenceService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async listMine(actor: ResolvedActor): Promise<PreferenceResponseDto[]> {
    if (!actor.personId) return [];
    const platform = this.tenantPrisma.getPlatformClient();
    const profile = await platform.substituteProfile.findUnique({
      where: { personId: actor.personId },
    });
    if (!profile) return [];
    const rows = await platform.platformSubPreference.findMany({
      where: { substituteId: profile.id },
      orderBy: [{ preferenceType: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(this.rowToDto);
  }

  async create(input: CreatePreferenceDto, actor: ResolvedActor): Promise<PreferenceResponseDto> {
    if (!actor.personId) {
      throw new ForbiddenException('Only a substitute can write own preferences.');
    }
    const platform = this.tenantPrisma.getPlatformClient();
    const profile = await platform.substituteProfile.findUnique({
      where: { personId: actor.personId },
    });
    if (!profile) {
      throw new ForbiddenException('No substitute profile for this account.');
    }
    try {
      const created = await platform.platformSubPreference.create({
        data: {
          id: generateId(),
          substituteId: profile.id,
          schoolId: input.schoolId,
          preferenceType: input.preferenceType,
          reason: input.reason ?? null,
        },
      });
      return this.rowToDto(created);
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') {
        throw new BadRequestException(
          'A preference for this school already exists. PATCH or DELETE the existing row first.',
        );
      }
      throw e;
    }
  }

  async remove(id: string, actor: ResolvedActor): Promise<{ deleted: true }> {
    const platform = this.tenantPrisma.getPlatformClient();
    const row = await platform.platformSubPreference.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Preference row not found.');

    if (!actor.personId) {
      throw new ForbiddenException('Only the owning substitute can remove this row.');
    }
    const profile = await platform.substituteProfile.findUnique({
      where: { personId: actor.personId },
    });
    if (!profile || profile.id !== row.substituteId) {
      throw new NotFoundException('Preference row not found.');
    }

    await platform.platformSubPreference.delete({ where: { id } });
    return { deleted: true };
  }

  private rowToDto = (r: {
    id: string;
    substituteId: string;
    schoolId: string;
    preferenceType: string;
    reason: string | null;
  }): PreferenceResponseDto => ({
    id: r.id,
    substituteId: r.substituteId,
    schoolId: r.schoolId,
    preferenceType: r.preferenceType as PreferenceResponseDto['preferenceType'],
    reason: r.reason,
  });
}
