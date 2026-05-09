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
import { PermissionCheckService } from '../iam/permission-check.service';
import {
  CreateTrainingProgrammeDto,
  TrainingProgrammeDto,
  UpdateTrainingProgrammeDto,
} from './dto/training.dto';

interface ProgrammeRow {
  id: string;
  school_id: string;
  name: string;
  description: string | null;
  is_mandatory: boolean;
  renewal_months: number | null;
  is_active: boolean;
  created_at: string;
}

const SELECT_PROGRAMME =
  'SELECT id::text AS id, school_id::text AS school_id, name, description, ' +
  '       is_mandatory, renewal_months, is_active, created_at::text AS created_at ' +
  'FROM hr_training_programmes ';

@Injectable()
export class TrainingProgrammeService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  async list(includeInactive: boolean): Promise<TrainingProgrammeDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const where = includeInactive
        ? 'WHERE school_id = $1::uuid'
        : 'WHERE school_id = $1::uuid AND is_active = true';
      const rows = (await client.$queryRawUnsafe(
        SELECT_PROGRAMME + where + ' ORDER BY name',
        tenant.schoolId,
      )) as ProgrammeRow[];
      return rows.map((r) => this.rowToDto(r));
    });
  }

  async getById(id: string): Promise<TrainingProgrammeDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_PROGRAMME + 'WHERE school_id = $1::uuid AND id = $2::uuid LIMIT 1',
        tenant.schoolId,
        id,
      )) as ProgrammeRow[];
      if (rows.length === 0) throw new NotFoundException('Training programme not found');
      return this.rowToDto(rows[0]!);
    });
  }

  async create(
    input: CreateTrainingProgrammeDto,
    actor: ResolvedActor,
  ): Promise<TrainingProgrammeDto> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    const id = generateId();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO hr_training_programmes ' +
            '(id, school_id, name, description, is_mandatory, renewal_months) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)',
          id,
          tenant.schoolId,
          input.name,
          input.description ?? null,
          input.isMandatory ?? false,
          input.renewalMonths ?? null,
        );
      } catch (e: unknown) {
        if (this.isUniqueViolation(e)) {
          throw new BadRequestException(
            `A programme with name "${input.name}" already exists in this school.`,
          );
        }
        throw e;
      }
      return this.getById(id);
    });
  }

  async patch(
    id: string,
    input: UpdateTrainingProgrammeDto,
    actor: ResolvedActor,
  ): Promise<TrainingProgrammeDto> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id FROM hr_training_programmes WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        id,
      )) as Array<{ id: string }>;
      if (lock.length === 0) throw new NotFoundException('Training programme not found');
      const sets: string[] = [];
      const values: unknown[] = [];
      let n = 1;
      const push = (col: string, value: unknown) => {
        sets.push(`${col} = $${n}`);
        values.push(value);
        n += 1;
      };
      if (input.name !== undefined) push('name', input.name);
      if (input.description !== undefined) push('description', input.description);
      if (input.isMandatory !== undefined) push('is_mandatory', input.isMandatory);
      if (input.renewalMonths !== undefined) push('renewal_months', input.renewalMonths);
      if (input.isActive !== undefined) push('is_active', input.isActive);
      if (sets.length === 0) return this.getById(id);
      sets.push('updated_at = now()');
      values.push(tenant.schoolId, id);
      try {
        await tx.$executeRawUnsafe(
          `UPDATE hr_training_programmes SET ${sets.join(', ')} ` +
            `WHERE school_id = $${n}::uuid AND id = $${n + 1}::uuid`,
          ...values,
        );
      } catch (e: unknown) {
        if (this.isUniqueViolation(e)) {
          throw new BadRequestException('A programme with that name already exists.');
        }
        throw e;
      }
      return this.getById(id);
    });
  }

  /** Internal — used by CompletionService.recordCompletion to fetch the
   * programme metadata (is_mandatory + renewal_months) without
   * re-running the admin-tier read gate. */
  async loadInternal(id: string): Promise<TrainingProgrammeDto | null> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_PROGRAMME + 'WHERE school_id = $1::uuid AND id = $2::uuid LIMIT 1',
        tenant.schoolId,
        id,
      )) as ProgrammeRow[];
      if (rows.length === 0) return null;
      return this.rowToDto(rows[0]!);
    });
  }

  private async assertAdmin(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'hr-004:write',
      'hr-004:admin',
    ]);
    if (!ok) {
      throw new ForbiddenException(
        'Training programme administration requires hr-004:write or school admin.',
      );
    }
  }

  private rowToDto(r: ProgrammeRow): TrainingProgrammeDto {
    return {
      id: r.id,
      schoolId: r.school_id,
      name: r.name,
      description: r.description,
      isMandatory: r.is_mandatory,
      renewalMonths: r.renewal_months,
      isActive: r.is_active,
      createdAt: r.created_at,
    };
  }

  private isUniqueViolation(err: unknown): boolean {
    const e = err as { code?: string; meta?: { code?: string }; message?: string };
    if (!e) return false;
    if (e.code === 'P2010' && e.meta?.code === '23505') return true;
    if (typeof e.message === 'string' && /unique/i.test(e.message)) return true;
    return false;
  }
}
