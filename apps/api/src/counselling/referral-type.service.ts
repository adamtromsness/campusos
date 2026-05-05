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
import {
  CreateReferralTypeDto,
  ReferralPriority,
  ReferralTypeResponseDto,
  UpdateReferralTypeDto,
} from './dto/counselling.dto';

interface TypeRow {
  id: string;
  school_id: string;
  name: string;
  description: string | null;
  default_priority: string;
  requires_parent_notification: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

const SELECT_TYPE_BASE =
  'SELECT t.id::text AS id, t.school_id::text AS school_id, t.name, t.description, ' +
  't.default_priority, t.requires_parent_notification, t.is_active, ' +
  'TO_CHAR(t.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(t.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM svc_referral_types t ';

function rowToDto(r: TypeRow): ReferralTypeResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    name: r.name,
    description: r.description,
    defaultPriority: r.default_priority as ReferralPriority,
    requiresParentNotification: r.requires_parent_notification,
    isActive: r.is_active,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * ReferralTypeService — per-school referral category catalogue.
 *
 * Reads are gated at the controller layer on cou-002:read (held by every
 * persona that can submit or track referrals: Teacher, Staff, Admin).
 * Writes are admin-only (cou-002:admin via everyFunction). Schools layer
 * their own catalogue on top of the seeded "Social/Emotional" and
 * "Academic Concern" defaults.
 */
@Injectable()
export class ReferralTypeService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async list(includeInactive = false): Promise<ReferralTypeResponseDto[]> {
    const sql =
      SELECT_TYPE_BASE +
      (includeInactive ? '' : 'WHERE t.is_active = true ') +
      'ORDER BY t.name ASC';
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<TypeRow[]>(sql);
    });
    return rows.map(rowToDto);
  }

  async getById(id: string): Promise<ReferralTypeResponseDto> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<TypeRow[]>(SELECT_TYPE_BASE + 'WHERE t.id = $1::uuid', id);
    });
    if (rows.length === 0) throw new NotFoundException('Referral type ' + id);
    return rowToDto(rows[0]!);
  }

  /**
   * Used by ReferralService.create to copy default_priority + read the
   * requires_parent_notification flag at submission time.
   */
  async assertActive(id: string): Promise<ReferralTypeResponseDto> {
    const dto = await this.getById(id);
    if (!dto.isActive) {
      throw new BadRequestException('Referral type ' + dto.name + ' is no longer active');
    }
    return dto;
  }

  async create(
    input: CreateReferralTypeDto,
    actor: ResolvedActor,
  ): Promise<ReferralTypeResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can create referral types');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO svc_referral_types ' +
            '(id, school_id, name, description, default_priority, requires_parent_notification, is_active) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)',
          id,
          tenant.schoolId,
          input.name,
          input.description ?? null,
          input.defaultPriority,
          input.requiresParentNotification ?? false,
          input.isActive ?? true,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException(
          'A referral type with name "' + input.name + '" already exists for this school',
        );
      }
      throw err;
    }
    return this.getById(id);
  }

  async patch(
    id: string,
    input: UpdateReferralTypeDto,
    actor: ResolvedActor,
  ): Promise<ReferralTypeResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can update referral types');
    }
    const updates: string[] = [];
    const params: unknown[] = [id];
    let idx = 2;
    if (input.name !== undefined) {
      updates.push('name = $' + idx);
      params.push(input.name);
      idx++;
    }
    if (input.description !== undefined) {
      updates.push('description = $' + idx);
      params.push(input.description);
      idx++;
    }
    if (input.defaultPriority !== undefined) {
      updates.push('default_priority = $' + idx);
      params.push(input.defaultPriority);
      idx++;
    }
    if (input.requiresParentNotification !== undefined) {
      updates.push('requires_parent_notification = $' + idx);
      params.push(input.requiresParentNotification);
      idx++;
    }
    if (input.isActive !== undefined) {
      updates.push('is_active = $' + idx);
      params.push(input.isActive);
      idx++;
    }
    if (updates.length === 0) {
      return this.getById(id);
    }
    updates.push('updated_at = now()');
    try {
      const result = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$executeRawUnsafe(
          'UPDATE svc_referral_types SET ' + updates.join(', ') + ' WHERE id = $1::uuid',
          ...params,
        );
      });
      if (result === 0) throw new NotFoundException('Referral type ' + id);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException('A referral type with that name already exists');
      }
      throw err;
    }
    return this.getById(id);
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e.code === 'P2010' || e.meta?.code === '23505') return true;
  if (typeof e.message === 'string' && e.message.includes('23505')) return true;
  return false;
}
