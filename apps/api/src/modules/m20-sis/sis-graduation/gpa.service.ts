import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import {
  GPA_CALCULATION_METHODS,
  GPA_SCALE_TYPES,
  type CreateGpaConfigDto,
  type GpaCalculationMethod,
  type GpaConfigDto,
  type GpaScaleType,
  type GpaSnapshotDto,
  type UpdateGpaConfigDto,
} from './dto/sis-graduation.dto';

interface ConfigRow {
  id: string;
  school_id: string;
  config_name: string;
  calculation_method: string;
  scale_type: string;
  grade_point_mapping: Record<string, number>;
  honors_weight_bonus: string;
  ap_weight_bonus: string;
  is_default: boolean;
  is_active: boolean;
}

interface SnapshotRow {
  id: string;
  student_id: string;
  gpa_config_id: string;
  academic_year_id: string | null;
  term_id: string | null;
  cumulative_gpa: string | null;
  term_gpa: string | null;
  total_credits_attempted: string | null;
  total_credits_earned: string | null;
  class_rank: number | null;
  class_size: number | null;
  calculated_at: string;
}

/**
 * GpaService — CRUD for sis_gpa_configurations + read paths over
 * sis_student_gpa_snapshots. GPAWorker is the sole writer to the
 * snapshot table; the request path exposes reads only.
 */
@Injectable()
export class GpaService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  private cfgRowToDto(r: ConfigRow): GpaConfigDto {
    return {
      id: r.id,
      schoolId: r.school_id,
      configName: r.config_name,
      calculationMethod: r.calculation_method as GpaCalculationMethod,
      scaleType: r.scale_type as GpaScaleType,
      gradePointMapping: r.grade_point_mapping,
      honorsWeightBonus: Number(r.honors_weight_bonus),
      apWeightBonus: Number(r.ap_weight_bonus),
      isDefault: r.is_default,
      isActive: r.is_active,
    };
  }

  private snapRowToDto(r: SnapshotRow): GpaSnapshotDto {
    return {
      id: r.id,
      studentId: r.student_id,
      gpaConfigId: r.gpa_config_id,
      academicYearId: r.academic_year_id,
      termId: r.term_id,
      cumulativeGpa: r.cumulative_gpa === null ? null : Number(r.cumulative_gpa),
      termGpa: r.term_gpa === null ? null : Number(r.term_gpa),
      totalCreditsAttempted:
        r.total_credits_attempted === null ? null : Number(r.total_credits_attempted),
      totalCreditsEarned: r.total_credits_earned === null ? null : Number(r.total_credits_earned),
      classRank: r.class_rank,
      classSize: r.class_size,
      calculatedAt: r.calculated_at,
    };
  }

  private async assertAdmin(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'stu-005:admin',
    ]);
    if (!ok) {
      throw new ForbiddenException('Only admins can manage GPA configurations.');
    }
  }

  // ─── Configs ───

  async listConfigs(): Promise<GpaConfigDto[]> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<ConfigRow[]>(
        'SELECT id::text, school_id::text, config_name, calculation_method, scale_type, ' +
          'grade_point_mapping, honors_weight_bonus::text, ap_weight_bonus::text, is_default, is_active ' +
          'FROM sis_gpa_configurations WHERE school_id = $1::uuid ORDER BY is_default DESC, config_name',
        tenant.schoolId,
      ),
    );
    return rows.map((r) => this.cfgRowToDto(r));
  }

  async getConfig(id: string): Promise<GpaConfigDto> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<ConfigRow[]>(
        'SELECT id::text, school_id::text, config_name, calculation_method, scale_type, ' +
          'grade_point_mapping, honors_weight_bonus::text, ap_weight_bonus::text, is_default, is_active ' +
          'FROM sis_gpa_configurations WHERE id = $1::uuid AND school_id = $2::uuid',
        id,
        tenant.schoolId,
      ),
    );
    if (rows.length === 0) throw new NotFoundException('GPA configuration not found');
    return this.cfgRowToDto(rows[0]!);
  }

  async getDefaultConfig(): Promise<GpaConfigDto | null> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<ConfigRow[]>(
        'SELECT id::text, school_id::text, config_name, calculation_method, scale_type, ' +
          'grade_point_mapping, honors_weight_bonus::text, ap_weight_bonus::text, is_default, is_active ' +
          'FROM sis_gpa_configurations WHERE school_id = $1::uuid AND is_default = true AND is_active = true LIMIT 1',
        tenant.schoolId,
      ),
    );
    if (rows.length === 0) return null;
    return this.cfgRowToDto(rows[0]!);
  }

  async createConfig(dto: CreateGpaConfigDto, actor: ResolvedActor): Promise<GpaConfigDto> {
    await this.assertAdmin(actor);
    if (!GPA_CALCULATION_METHODS.includes(dto.calculationMethod)) {
      throw new BadRequestException(
        'calculationMethod must be one of ' + GPA_CALCULATION_METHODS.join(', '),
      );
    }
    if (!GPA_SCALE_TYPES.includes(dto.scaleType)) {
      throw new BadRequestException('scaleType must be one of ' + GPA_SCALE_TYPES.join(', '));
    }
    if (typeof dto.gradePointMapping !== 'object' || Array.isArray(dto.gradePointMapping)) {
      throw new BadRequestException('gradePointMapping must be a JSON object');
    }
    if (Object.keys(dto.gradePointMapping).length === 0) {
      throw new BadRequestException('gradePointMapping must contain at least one entry');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      if (dto.isDefault === true) {
        // Clear any existing default before INSERT so the partial UNIQUE
        // INDEX `sis_gpa_config_default_uq` never fires.
        await tx.$executeRawUnsafe(
          'UPDATE sis_gpa_configurations SET is_default = false, updated_at = now() ' +
            'WHERE school_id = $1::uuid AND is_default = true',
          tenant.schoolId,
        );
      }
      await tx.$executeRawUnsafe(
        'INSERT INTO sis_gpa_configurations ' +
          '(id, school_id, config_name, calculation_method, scale_type, grade_point_mapping, ' +
          'honors_weight_bonus, ap_weight_bonus, is_default) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7, $8, $9)',
        id,
        tenant.schoolId,
        dto.configName,
        dto.calculationMethod,
        dto.scaleType,
        JSON.stringify(dto.gradePointMapping),
        dto.honorsWeightBonus ?? 0.5,
        dto.apWeightBonus ?? 1.0,
        dto.isDefault ?? false,
      );
    });
    return this.getConfig(id);
  }

  async patchConfig(
    id: string,
    dto: UpdateGpaConfigDto,
    actor: ResolvedActor,
  ): Promise<GpaConfigDto> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      if (dto.isDefault === true) {
        await tx.$executeRawUnsafe(
          'UPDATE sis_gpa_configurations SET is_default = false, updated_at = now() ' +
            'WHERE school_id = $1::uuid AND is_default = true AND id <> $2::uuid',
          tenant.schoolId,
          id,
        );
      }
      const sets: string[] = [];
      const params: unknown[] = [];
      let n = 1;
      const add = (col: string, val: unknown, cast?: string): void => {
        sets.push(col + ' = $' + n + (cast ? '::' + cast : ''));
        params.push(val);
        n += 1;
      };
      if (dto.configName !== undefined) add('config_name', dto.configName);
      if (dto.gradePointMapping !== undefined)
        add('grade_point_mapping', JSON.stringify(dto.gradePointMapping), 'jsonb');
      if (dto.honorsWeightBonus !== undefined) add('honors_weight_bonus', dto.honorsWeightBonus);
      if (dto.apWeightBonus !== undefined) add('ap_weight_bonus', dto.apWeightBonus);
      if (dto.isDefault !== undefined) add('is_default', dto.isDefault);
      if (dto.isActive !== undefined) add('is_active', dto.isActive);
      if (sets.length > 0) {
        sets.push('updated_at = now()');
        params.push(id);
        params.push(tenant.schoolId);
        await tx.$executeRawUnsafe(
          'UPDATE sis_gpa_configurations SET ' +
            sets.join(', ') +
            ' WHERE id = $' +
            n +
            '::uuid AND school_id = $' +
            (n + 1) +
            '::uuid',
          ...params,
        );
      }
    });
    return this.getConfig(id);
  }

  // ─── Snapshots (read paths) ───

  async listSnapshotsForStudent(studentId: string): Promise<GpaSnapshotDto[]> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<SnapshotRow[]>(
        'SELECT s.id::text, s.student_id::text, s.gpa_config_id::text, ' +
          's.academic_year_id::text, s.term_id::text, s.cumulative_gpa::text, ' +
          's.term_gpa::text, s.total_credits_attempted::text, s.total_credits_earned::text, ' +
          's.class_rank, s.class_size, s.calculated_at::text ' +
          'FROM sis_student_gpa_snapshots s ' +
          'JOIN sis_gpa_configurations c ON c.id = s.gpa_config_id ' +
          'WHERE s.student_id = $1::uuid AND c.school_id = $2::uuid ' +
          'ORDER BY s.calculated_at DESC',
        studentId,
        tenant.schoolId,
      ),
    );
    return rows.map((r) => this.snapRowToDto(r));
  }

  async getLatestSnapshot(studentId: string): Promise<GpaSnapshotDto | null> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<SnapshotRow[]>(
        'SELECT s.id::text, s.student_id::text, s.gpa_config_id::text, ' +
          's.academic_year_id::text, s.term_id::text, s.cumulative_gpa::text, ' +
          's.term_gpa::text, s.total_credits_attempted::text, s.total_credits_earned::text, ' +
          's.class_rank, s.class_size, s.calculated_at::text ' +
          'FROM sis_student_gpa_snapshots s ' +
          'JOIN sis_gpa_configurations c ON c.id = s.gpa_config_id ' +
          'WHERE s.student_id = $1::uuid AND c.school_id = $2::uuid AND c.is_default = true ' +
          'ORDER BY s.calculated_at DESC LIMIT 1',
        studentId,
        tenant.schoolId,
      ),
    );
    if (rows.length === 0) return null;
    return this.snapRowToDto(rows[0]!);
  }
}
