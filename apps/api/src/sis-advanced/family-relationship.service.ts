import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { PermissionCheckService } from '../iam/permission-check.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  CUSTODY_ARRANGEMENTS,
  RELATIONSHIP_TYPES,
  type CreateFamilyRelationshipDto,
  type CustodyArrangement,
  type FamilyRelationshipDto,
  type RelationshipType,
  type UpdateFamilyRelationshipDto,
} from './dto/sis-advanced.dto';

interface RelationshipRow {
  id: string;
  family_id: string;
  guardian_a_id: string;
  guardian_b_id: string;
  relationship_type: string;
  custody_arrangement: string | null;
  notes: string | null;
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: string }).code;
  const meta = (err as { meta?: { code?: string } }).meta;
  if (code === 'P2002') return true;
  if (code === 'P2010' && meta?.code === '23505') return true;
  return false;
}

@Injectable()
export class FamilyRelationshipService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  private rowToDto(r: RelationshipRow): FamilyRelationshipDto {
    return {
      id: r.id,
      familyId: r.family_id,
      guardianAId: r.guardian_a_id,
      guardianBId: r.guardian_b_id,
      relationshipType: r.relationship_type as RelationshipType,
      custodyArrangement: r.custody_arrangement as CustodyArrangement | null,
      notes: r.notes,
    };
  }

  private async isAdmin(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'stu-002:admin',
    ]);
  }

  private async assertGuardiansInTenant(guardianAId: string, guardianBId: string): Promise<void> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id::text AS id FROM sis_guardians WHERE id = ANY($1::uuid[])',
        [guardianAId, guardianBId],
      ),
    );
    const found = new Set(rows.map((r) => r.id));
    if (!found.has(guardianAId)) {
      throw new BadRequestException('guardianAId does not match a guardian in this school');
    }
    if (!found.has(guardianBId)) {
      throw new BadRequestException('guardianBId does not match a guardian in this school');
    }
  }

  async listForFamily(familyId: string): Promise<FamilyRelationshipDto[]> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<RelationshipRow[]>(
        'SELECT id::text, family_id::text, guardian_a_id::text, guardian_b_id::text, ' +
          'relationship_type, custody_arrangement, notes ' +
          'FROM sis_family_relationships WHERE family_id = $1::uuid ' +
          'ORDER BY created_at DESC',
        familyId,
      ),
    );
    return rows.map((r) => this.rowToDto(r));
  }

  async getByIdOrFail(id: string): Promise<FamilyRelationshipDto> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<RelationshipRow[]>(
        'SELECT id::text, family_id::text, guardian_a_id::text, guardian_b_id::text, ' +
          'relationship_type, custody_arrangement, notes ' +
          'FROM sis_family_relationships WHERE id = $1::uuid',
        id,
      ),
    );
    if (rows.length === 0) throw new NotFoundException('Family relationship not found');
    return this.rowToDto(rows[0]!);
  }

  async create(
    dto: CreateFamilyRelationshipDto,
    actor: ResolvedActor,
  ): Promise<FamilyRelationshipDto> {
    if (!(await this.isAdmin(actor))) {
      throw new ForbiddenException('Only admins can record family relationships.');
    }
    if (dto.guardianAId === dto.guardianBId) {
      throw new BadRequestException('guardian_a_id and guardian_b_id must be different.');
    }
    if (!RELATIONSHIP_TYPES.includes(dto.relationshipType)) {
      throw new BadRequestException(
        'relationshipType must be one of ' + RELATIONSHIP_TYPES.join(', '),
      );
    }
    if (
      dto.custodyArrangement !== undefined &&
      !CUSTODY_ARRANGEMENTS.includes(dto.custodyArrangement)
    ) {
      throw new BadRequestException(
        'custodyArrangement must be one of ' + CUSTODY_ARRANGEMENTS.join(', '),
      );
    }
    await this.assertGuardiansInTenant(dto.guardianAId, dto.guardianBId);

    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) =>
        client.$executeRawUnsafe(
          'INSERT INTO sis_family_relationships ' +
            '(id, family_id, guardian_a_id, guardian_b_id, relationship_type, ' +
            'custody_arrangement, notes) VALUES ' +
            '($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7)',
          id,
          dto.familyId,
          dto.guardianAId,
          dto.guardianBId,
          dto.relationshipType,
          dto.custodyArrangement ?? null,
          dto.notes ?? null,
        ),
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          'A relationship between these two guardians already exists in this family.',
        );
      }
      throw err;
    }
    return this.getByIdOrFail(id);
  }

  async patch(
    id: string,
    dto: UpdateFamilyRelationshipDto,
    actor: ResolvedActor,
  ): Promise<FamilyRelationshipDto> {
    if (!(await this.isAdmin(actor))) {
      throw new ForbiddenException('Only admins can update family relationships.');
    }
    const existing = await this.getByIdOrFail(id);
    void existing;

    const sets: string[] = [];
    const params: unknown[] = [];
    let n = 1;
    if (dto.relationshipType !== undefined) {
      if (!RELATIONSHIP_TYPES.includes(dto.relationshipType)) {
        throw new BadRequestException(
          'relationshipType must be one of ' + RELATIONSHIP_TYPES.join(', '),
        );
      }
      sets.push('relationship_type = $' + n);
      params.push(dto.relationshipType);
      n += 1;
    }
    if (dto.custodyArrangement !== undefined) {
      if (
        dto.custodyArrangement !== null &&
        !CUSTODY_ARRANGEMENTS.includes(dto.custodyArrangement)
      ) {
        throw new BadRequestException(
          'custodyArrangement must be one of ' + CUSTODY_ARRANGEMENTS.join(', '),
        );
      }
      sets.push('custody_arrangement = $' + n);
      params.push(dto.custodyArrangement);
      n += 1;
    }
    if (dto.notes !== undefined) {
      sets.push('notes = $' + n);
      params.push(dto.notes);
      n += 1;
    }
    if (sets.length > 0) {
      sets.push('updated_at = now()');
      params.push(id);
      await this.tenantPrisma.executeInTenantContext(async (client) =>
        client.$executeRawUnsafe(
          'UPDATE sis_family_relationships SET ' + sets.join(', ') + ' WHERE id = $' + n + '::uuid',
          ...params,
        ),
      );
    }
    return this.getByIdOrFail(id);
  }

  async delete(id: string, actor: ResolvedActor): Promise<void> {
    if (!(await this.isAdmin(actor))) {
      throw new ForbiddenException('Only admins can delete family relationships.');
    }
    await this.getByIdOrFail(id);
    await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$executeRawUnsafe('DELETE FROM sis_family_relationships WHERE id = $1::uuid', id),
    );
  }
}
