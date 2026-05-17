import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import {
  CreateImmunisationRequirementDto,
  ImmunisationRequirementDto,
  UpdateImmunisationRequirementDto,
} from './dto/health-advanced.dto';

interface RequirementRow {
  id: string;
  school_id: string | null;
  state_code: string;
  vaccine_name: string;
  required_doses: number;
  required_by_grade: string;
  allows_exemption: boolean;
  exemption_types: string[] | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

const SELECT_REQ_BASE =
  'SELECT id::text AS id, school_id::text AS school_id, state_code, vaccine_name, ' +
  '       required_doses, required_by_grade, allows_exemption, exemption_types, is_active, ' +
  '       created_at::text AS created_at, updated_at::text AS updated_at ' +
  'FROM hlth_immunisation_requirements ';

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: string }).code;
  if (code === 'P2010' || code === '23505') return true;
  const meta = (err as { meta?: { code?: string } }).meta;
  if (meta && meta.code === '23505') return true;
  const msg = (err as { message?: string }).message;
  return typeof msg === 'string' && msg.includes('23505');
}

/**
 * State immunisation requirement catalogue. Read access is wide (the
 * dashboard surfaces requirements to nurses and admins). Write +
 * admin actions are gated on hlt-001:admin per the plan ("HLT-001:admin
 * extended for immunisation requirements configuration").
 */
@Injectable()
export class ImmunisationRequirementService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  async list(stateCode?: string): Promise<ImmunisationRequirementDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      // Surface platform-default rows (school_id IS NULL) PLUS this
      // school's overrides.
      let where = 'WHERE (school_id IS NULL OR school_id = $1::uuid)';
      const params: unknown[] = [tenant.schoolId];
      if (stateCode) {
        params.push(stateCode);
        where += ' AND state_code = $' + params.length;
      }
      const rows = (await client.$queryRawUnsafe(
        SELECT_REQ_BASE + where + ' ORDER BY state_code, vaccine_name, required_by_grade',
        ...params,
      )) as RequirementRow[];
      return rows.map((r) => this.rowToDto(r));
    });
  }

  async getById(id: string): Promise<ImmunisationRequirementDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_REQ_BASE +
          'WHERE id = $1::uuid AND (school_id IS NULL OR school_id = $2::uuid) LIMIT 1',
        id,
        tenant.schoolId,
      )) as RequirementRow[];
      if (rows.length === 0) throw new NotFoundException('Requirement not found');
      return this.rowToDto(rows[0]!);
    });
  }

  async create(
    input: CreateImmunisationRequirementDto,
    actor: ResolvedActor,
  ): Promise<ImmunisationRequirementDto> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    const id = generateId();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      try {
        await client.$executeRawUnsafe(
          'INSERT INTO hlth_immunisation_requirements ' +
            '(id, school_id, state_code, vaccine_name, required_doses, required_by_grade, ' +
            ' allows_exemption, exemption_types) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::text[])',
          id,
          tenant.schoolId,
          input.stateCode.toUpperCase(),
          input.vaccineName,
          input.requiredDoses,
          input.requiredByGrade,
          input.allowsExemption ?? true,
          input.exemptionTypes && input.exemptionTypes.length > 0
            ? '{' + input.exemptionTypes.join(',') + '}'
            : null,
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new BadRequestException(
            'A requirement for ' +
              input.stateCode.toUpperCase() +
              ' / ' +
              input.vaccineName +
              ' / grade ' +
              input.requiredByGrade +
              ' already exists for this scope.',
          );
        }
        throw err;
      }
      const rows = (await client.$queryRawUnsafe(
        SELECT_REQ_BASE + 'WHERE id = $1::uuid LIMIT 1',
        id,
      )) as RequirementRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  async patch(
    id: string,
    input: UpdateImmunisationRequirementDto,
    actor: ResolvedActor,
  ): Promise<ImmunisationRequirementDto> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();

    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id, school_id::text AS school_id FROM hlth_immunisation_requirements ' +
          'WHERE id = $1::uuid AND (school_id IS NULL OR school_id = $2::uuid) FOR UPDATE',
        id,
        tenant.schoolId,
      )) as Array<{ id: string; school_id: string | null }>;
      if (lock.length === 0) throw new NotFoundException('Requirement not found');
      // Schools cannot edit platform-default rows (school_id IS NULL) — those
      // are seeded centrally. They can clone-and-override by POSTing a new
      // row with school_id NOT NULL.
      if (lock[0]!.school_id === null) {
        throw new ForbiddenException(
          'Platform-default requirements are read-only. Create a per-school override instead.',
        );
      }

      const sets: string[] = [];
      const values: unknown[] = [];
      let n = 1;
      const push = (col: string, value: unknown) => {
        sets.push(col + ' = $' + n);
        values.push(value);
        n += 1;
      };
      if (input.requiredDoses !== undefined) push('required_doses', input.requiredDoses);
      if (input.allowsExemption !== undefined) push('allows_exemption', input.allowsExemption);
      if (input.exemptionTypes !== undefined) {
        const arrLit =
          input.exemptionTypes && input.exemptionTypes.length > 0
            ? '{' + input.exemptionTypes.join(',') + '}'
            : null;
        sets.push('exemption_types = $' + n + '::text[]');
        values.push(arrLit);
        n += 1;
      }
      if (input.isActive !== undefined) push('is_active', input.isActive);
      if (sets.length === 0) {
        const rows = (await tx.$queryRawUnsafe(
          SELECT_REQ_BASE + 'WHERE id = $1::uuid LIMIT 1',
          id,
        )) as RequirementRow[];
        return this.rowToDto(rows[0]!);
      }
      sets.push('updated_at = now()');
      values.push(id, tenant.schoolId);
      await tx.$executeRawUnsafe(
        'UPDATE hlth_immunisation_requirements SET ' +
          sets.join(', ') +
          ' WHERE id = $' +
          n +
          '::uuid AND school_id = $' +
          (n + 1) +
          '::uuid',
        ...values,
      );
      const rows = (await tx.$queryRawUnsafe(
        SELECT_REQ_BASE + 'WHERE id = $1::uuid LIMIT 1',
        id,
      )) as RequirementRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  /**
   * Used by the ImmunisationComplianceWorker — returns every active
   * requirement applicable to the school, scoped to the optional
   * state_code (the worker uses the school's state if known).
   */
  async loadActiveForCompute(stateCode: string): Promise<RequirementRow[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      return (await client.$queryRawUnsafe(
        SELECT_REQ_BASE +
          'WHERE state_code = $1 AND is_active = true AND ' +
          '  (school_id IS NULL OR school_id = $2::uuid) ' +
          'ORDER BY vaccine_name, required_by_grade',
        stateCode,
        tenant.schoolId,
      )) as RequirementRow[];
    });
  }

  private async assertAdmin(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'hlt-001:admin',
    ]);
    if (!ok) {
      throw new ForbiddenException(
        'Configuring immunisation requirements requires hlt-001:admin or school admin.',
      );
    }
  }

  private rowToDto(r: RequirementRow): ImmunisationRequirementDto {
    return {
      id: r.id,
      schoolId: r.school_id,
      stateCode: r.state_code,
      vaccineName: r.vaccine_name,
      requiredDoses: r.required_doses,
      requiredByGrade: r.required_by_grade,
      allowsExemption: r.allows_exemption,
      exemptionTypes: r.exemption_types,
      isActive: r.is_active,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}
