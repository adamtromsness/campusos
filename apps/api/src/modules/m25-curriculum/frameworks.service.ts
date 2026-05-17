import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import type {
  AdoptionDto,
  CreateAdoptionDto,
  CreateCustomFrameworkDto,
  CreateStandardDto,
  FrameworkDetailDto,
  FrameworkDto,
  FrameworkSource,
  StandardDto,
  StandardSource,
  UpdateCustomFrameworkDto,
  UpdateStandardDto,
} from './dto/curriculum.dto';

/**
 * Curriculum Coordinator scope helper.
 *
 * The Cycle 23 IAM seed grants `tch-008:write` to Teacher,
 * `tch-008:read` to Parent + Student, and the admin tier flows to
 * School Admin via `everyFunction`. School-level configuration
 * (adopting a national framework, creating a custom framework)
 * is admin-tier only.
 */
async function assertCurriculumAdmin(
  actor: ResolvedActor,
  permCheck: PermissionCheckService,
): Promise<void> {
  if (actor.isSchoolAdmin) return;
  const tenant = getCurrentTenant();
  const ok = await permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
    'tch-008:admin',
  ]);
  if (!ok) {
    throw new ForbiddenException(
      'Only school admins can adopt frameworks or create school-custom frameworks',
    );
  }
}

async function assertCurriculumWriter(
  actor: ResolvedActor,
  permCheck: PermissionCheckService,
): Promise<void> {
  if (actor.isSchoolAdmin) return;
  const tenant = getCurrentTenant();
  const ok = await permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
    'tch-008:write',
  ]);
  if (!ok) {
    throw new ForbiddenException(
      'Only teachers, curriculum coordinators, or school admins can edit curriculum',
    );
  }
}

export function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e.code === 'P2010' || e.meta?.code === '23505') return true;
  if (e.code === '23505') return true;
  return typeof e.message === 'string' && e.message.includes('23505');
}

@Injectable()
export class FrameworkService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  /**
   * DUAL-RESOLUTION KEYSTONE: returns ALL frameworks visible to the
   * caller, both adopted-platform and school-custom, tagged with
   * source=PLATFORM or source=SCHOOL.
   *
   * Adopted platform frameworks come from
   * cur_school_framework_adoptions JOIN
   * platform.cur_standards_frameworks_platform.
   * School-custom frameworks come from cur_standards_frameworks.
   */
  async list(includeUnadopted = false): Promise<FrameworkDto[]> {
    const tenant = getCurrentTenant();

    // School-custom frameworks
    const customRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT f.id::text AS id, f.school_id::text AS school_id, f.name, f.version, f.description, f.is_active, ' +
          '(SELECT COUNT(*)::int FROM cur_standards s WHERE s.framework_id = f.id) AS standard_count ' +
          'FROM cur_standards_frameworks f WHERE f.school_id = $1::uuid ORDER BY f.name',
        tenant.schoolId,
      );
    })) as Array<{
      id: string;
      school_id: string;
      name: string;
      version: string | null;
      description: string | null;
      is_active: boolean;
      standard_count: number;
    }>;

    // Adopted platform frameworks
    const adoptedRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT DISTINCT pf.id::text AS id, pf.name, pf.body, pf.region, pf.version, ' +
          '(SELECT COUNT(*)::int FROM platform.cur_standards_platform s WHERE s.framework_id = pf.id) AS standard_count ' +
          'FROM cur_school_framework_adoptions a ' +
          'JOIN platform.cur_standards_frameworks_platform pf ON pf.id = a.platform_framework_id ' +
          'WHERE a.school_id = $1::uuid ORDER BY pf.name',
        tenant.schoolId,
      );
    })) as Array<{
      id: string;
      name: string;
      body: string | null;
      region: string | null;
      version: string | null;
      standard_count: number;
    }>;

    // If includeUnadopted, also return all platform frameworks not yet adopted
    let unadoptedPlatform: Array<{
      id: string;
      name: string;
      body: string | null;
      region: string | null;
      version: string | null;
      standard_count: number;
    }> = [];
    if (includeUnadopted) {
      unadoptedPlatform = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT pf.id::text AS id, pf.name, pf.body, pf.region, pf.version, ' +
            '(SELECT COUNT(*)::int FROM platform.cur_standards_platform s WHERE s.framework_id = pf.id) AS standard_count ' +
            'FROM platform.cur_standards_frameworks_platform pf ' +
            'WHERE NOT EXISTS (SELECT 1 FROM cur_school_framework_adoptions a ' +
            '                  WHERE a.platform_framework_id = pf.id AND a.school_id = $1::uuid) ' +
            'ORDER BY pf.name',
          tenant.schoolId,
        );
      })) as typeof unadoptedPlatform;
    }

    const customDtos: FrameworkDto[] = customRows.map((r) => ({
      id: r.id,
      source: 'SCHOOL' as FrameworkSource,
      name: r.name,
      body: null,
      region: null,
      version: r.version,
      description: r.description,
      schoolId: r.school_id,
      isActive: r.is_active,
      standardCount: r.standard_count,
    }));
    const adoptedDtos: FrameworkDto[] = adoptedRows.map((r) => ({
      id: r.id,
      source: 'PLATFORM' as FrameworkSource,
      name: r.name,
      body: r.body,
      region: r.region,
      version: r.version,
      description: null,
      schoolId: null,
      isActive: true,
      standardCount: r.standard_count,
    }));
    const unadoptedDtos: FrameworkDto[] = unadoptedPlatform.map((r) => ({
      id: r.id,
      source: 'PLATFORM' as FrameworkSource,
      name: r.name,
      body: r.body,
      region: r.region,
      version: r.version,
      description: null,
      schoolId: null,
      isActive: false,
      standardCount: r.standard_count,
    }));
    return [...adoptedDtos, ...customDtos, ...unadoptedDtos];
  }

  async getById(id: string): Promise<FrameworkDetailDto> {
    const tenant = getCurrentTenant();
    // Try platform first
    const platformRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT pf.id::text AS id, pf.name, pf.body, pf.region, pf.version ' +
          'FROM platform.cur_standards_frameworks_platform pf WHERE pf.id = $1::uuid LIMIT 1',
        id,
      );
    })) as Array<{
      id: string;
      name: string;
      body: string | null;
      region: string | null;
      version: string | null;
    }>;
    if (platformRows.length > 0) {
      const pr = platformRows[0]!;
      const stdRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT id::text AS id, code, description, grade_band, domain, cluster ' +
            'FROM platform.cur_standards_platform WHERE framework_id = $1::uuid ORDER BY code',
          id,
        );
      })) as Array<{
        id: string;
        code: string;
        description: string;
        grade_band: string | null;
        domain: string | null;
        cluster: string | null;
      }>;
      return {
        id: pr.id,
        source: 'PLATFORM',
        name: pr.name,
        body: pr.body,
        region: pr.region,
        version: pr.version,
        description: null,
        schoolId: null,
        isActive: true,
        standardCount: stdRows.length,
        standards: stdRows.map((s) => ({
          id: s.id,
          source: 'PLATFORM' as StandardSource,
          frameworkId: id,
          frameworkName: pr.name,
          code: s.code,
          description: s.description,
          gradeBand: s.grade_band,
          domain: s.domain,
          cluster: s.cluster,
        })),
      };
    }
    // Fall back to school custom
    const customRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, school_id::text AS school_id, name, version, description, is_active ' +
          'FROM cur_standards_frameworks WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      );
    })) as Array<{
      id: string;
      school_id: string;
      name: string;
      version: string | null;
      description: string | null;
      is_active: boolean;
    }>;
    if (customRows.length === 0) throw new NotFoundException('Framework not found');
    const cr = customRows[0]!;
    const stdRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, code, description, grade_band, domain, cluster ' +
          'FROM cur_standards WHERE framework_id = $1::uuid ORDER BY code',
        id,
      );
    })) as Array<{
      id: string;
      code: string;
      description: string;
      grade_band: string | null;
      domain: string | null;
      cluster: string | null;
    }>;
    return {
      id: cr.id,
      source: 'SCHOOL',
      name: cr.name,
      body: null,
      region: null,
      version: cr.version,
      description: cr.description,
      schoolId: cr.school_id,
      isActive: cr.is_active,
      standardCount: stdRows.length,
      standards: stdRows.map((s) => ({
        id: s.id,
        source: 'SCHOOL' as StandardSource,
        frameworkId: id,
        frameworkName: cr.name,
        code: s.code,
        description: s.description,
        gradeBand: s.grade_band,
        domain: s.domain,
        cluster: s.cluster,
      })),
    };
  }

  async createCustom(
    input: CreateCustomFrameworkDto,
    actor: ResolvedActor,
  ): Promise<FrameworkDetailDto> {
    await assertCurriculumAdmin(actor, this.permCheck);
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO cur_standards_frameworks (id, school_id, name, version, description, created_by) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid)',
          id,
          tenant.schoolId,
          input.name,
          input.version ?? null,
          input.description ?? null,
          actor.accountId,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          'A custom framework with this name and version already exists for this school',
        );
      }
      throw err;
    }
    return this.getById(id);
  }

  async patchCustom(
    id: string,
    input: UpdateCustomFrameworkDto,
    actor: ResolvedActor,
  ): Promise<FrameworkDetailDto> {
    await assertCurriculumAdmin(actor, this.permCheck);
    const tenant = getCurrentTenant();
    // Confirm it's a school-custom framework (cannot patch platform)
    const exists = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM cur_standards_frameworks WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      );
    })) as Array<{ ok: number }>;
    if (exists.length === 0) {
      throw new NotFoundException('Custom framework not found (platform frameworks are read-only)');
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.name !== undefined) {
      sets.push('name = $' + (params.length + 1));
      params.push(input.name);
    }
    if (input.version !== undefined) {
      sets.push('version = $' + (params.length + 1));
      params.push(input.version);
    }
    if (input.description !== undefined) {
      sets.push('description = $' + (params.length + 1));
      params.push(input.description);
    }
    if (input.isActive !== undefined) {
      sets.push('is_active = $' + (params.length + 1));
      params.push(input.isActive);
    }
    if (sets.length > 0) {
      sets.push('updated_at = now()');
      params.push(id);
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'UPDATE cur_standards_frameworks SET ' +
            sets.join(', ') +
            ' WHERE id = $' +
            params.length +
            '::uuid',
          ...params,
        );
      });
    }
    return this.getById(id);
  }

  async listAdoptions(): Promise<AdoptionDto[]> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT a.id::text AS id, a.school_id::text AS school_id, ' +
          'a.platform_framework_id::text AS platform_framework_id, pf.name AS platform_framework_name, ' +
          'a.academic_year_id::text AS academic_year_id, ay.name AS academic_year_name, ' +
          'a.adopted_at::text AS adopted_at, a.adopted_by::text AS adopted_by, a.notes ' +
          'FROM cur_school_framework_adoptions a ' +
          'JOIN platform.cur_standards_frameworks_platform pf ON pf.id = a.platform_framework_id ' +
          'JOIN sis_academic_years ay ON ay.id = a.academic_year_id ' +
          'WHERE a.school_id = $1::uuid ORDER BY a.adopted_at DESC',
        tenant.schoolId,
      );
    })) as Array<{
      id: string;
      school_id: string;
      platform_framework_id: string;
      platform_framework_name: string;
      academic_year_id: string;
      academic_year_name: string;
      adopted_at: string;
      adopted_by: string;
      notes: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      schoolId: r.school_id,
      platformFrameworkId: r.platform_framework_id,
      platformFrameworkName: r.platform_framework_name,
      academicYearId: r.academic_year_id,
      academicYearName: r.academic_year_name,
      adoptedAt: r.adopted_at,
      adoptedBy: r.adopted_by,
      notes: r.notes,
    }));
  }

  async createAdoption(input: CreateAdoptionDto, actor: ResolvedActor): Promise<AdoptionDto> {
    await assertCurriculumAdmin(actor, this.permCheck);
    const tenant = getCurrentTenant();
    // Validate platform framework exists
    const pfRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM platform.cur_standards_frameworks_platform WHERE id = $1::uuid LIMIT 1',
        input.platformFrameworkId,
      );
    })) as Array<{ ok: number }>;
    if (pfRows.length === 0) {
      throw new BadRequestException('platformFrameworkId does not match a platform framework');
    }
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO cur_school_framework_adoptions (id, school_id, platform_framework_id, academic_year_id, adopted_by, notes) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6)',
          id,
          tenant.schoolId,
          input.platformFrameworkId,
          input.academicYearId,
          actor.accountId,
          input.notes ?? null,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          'This framework is already adopted for this school + academic year',
        );
      }
      throw err;
    }
    const all = await this.listAdoptions();
    const found = all.find((a) => a.id === id);
    if (!found) throw new NotFoundException('Adoption not found after create');
    return found;
  }
}

@Injectable()
export class StandardService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  /**
   * GIN-INDEXED SEARCH KEYSTONE: when q is supplied, runs
   * `to_tsvector(code || ' ' || description) @@ plainto_tsquery(q)`
   * against BOTH platform AND tenant standards, with ts_rank
   * ordering. Returns unified results tagged source=PLATFORM or
   * source=SCHOOL.
   */
  async search(args: {
    q?: string;
    frameworkId?: string;
    gradeBand?: string;
    domain?: string;
    limit?: number;
  }): Promise<StandardDto[]> {
    const tenant = getCurrentTenant();
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 500);

    // Platform search
    const platformParams: unknown[] = [];
    const platformWheres: string[] = [];
    if (args.frameworkId) {
      // If frameworkId is supplied, restrict platform search to that id only when it matches
      platformParams.push(args.frameworkId);
      platformWheres.push('s.framework_id = $' + platformParams.length + '::uuid');
    }
    if (args.gradeBand) {
      platformParams.push(args.gradeBand);
      platformWheres.push('s.grade_band = $' + platformParams.length);
    }
    if (args.domain) {
      platformParams.push(args.domain);
      platformWheres.push('s.domain = $' + platformParams.length);
    }
    let platformOrder = 'ORDER BY s.code';
    if (args.q) {
      platformParams.push(args.q);
      platformWheres.push(
        "to_tsvector('english', s.code || ' ' || s.description) @@ plainto_tsquery('english', $" +
          platformParams.length +
          ')',
      );
      platformOrder =
        "ORDER BY ts_rank(to_tsvector('english', s.code || ' ' || s.description), plainto_tsquery('english', $" +
        platformParams.length +
        ')) DESC, s.code';
    }
    const platformWhere =
      platformWheres.length === 0 ? '' : ' WHERE ' + platformWheres.join(' AND ');
    const platformRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT s.id::text AS id, s.framework_id::text AS framework_id, pf.name AS framework_name, ' +
          's.code, s.description, s.grade_band, s.domain, s.cluster ' +
          'FROM platform.cur_standards_platform s ' +
          'JOIN platform.cur_standards_frameworks_platform pf ON pf.id = s.framework_id' +
          platformWhere +
          ' ' +
          platformOrder +
          ' LIMIT ' +
          limit,
        ...platformParams,
      );
    })) as Array<{
      id: string;
      framework_id: string;
      framework_name: string;
      code: string;
      description: string;
      grade_band: string | null;
      domain: string | null;
      cluster: string | null;
    }>;

    // Tenant search (school-custom standards)
    const tenantParams: unknown[] = [tenant.schoolId];
    const tenantWheres: string[] = ['f.school_id = $1::uuid'];
    if (args.frameworkId) {
      tenantParams.push(args.frameworkId);
      tenantWheres.push('s.framework_id = $' + tenantParams.length + '::uuid');
    }
    if (args.gradeBand) {
      tenantParams.push(args.gradeBand);
      tenantWheres.push('s.grade_band = $' + tenantParams.length);
    }
    if (args.domain) {
      tenantParams.push(args.domain);
      tenantWheres.push('s.domain = $' + tenantParams.length);
    }
    let tenantOrder = 'ORDER BY s.code';
    if (args.q) {
      tenantParams.push(args.q);
      // Tenant standards table doesn't have a GIN index per the
      // Step 1 schema (school-custom volume is small); ILIKE is
      // sufficient.
      tenantWheres.push(
        '(s.code ILIKE $' +
          tenantParams.length +
          ' OR s.description ILIKE $' +
          tenantParams.length +
          ')',
      );
      tenantParams[tenantParams.length - 1] = '%' + args.q + '%';
    }
    const tenantWhere = ' WHERE ' + tenantWheres.join(' AND ');
    const tenantRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT s.id::text AS id, s.framework_id::text AS framework_id, f.name AS framework_name, ' +
          's.code, s.description, s.grade_band, s.domain, s.cluster ' +
          'FROM cur_standards s ' +
          'JOIN cur_standards_frameworks f ON f.id = s.framework_id' +
          tenantWhere +
          ' ' +
          tenantOrder +
          ' LIMIT ' +
          limit,
        ...tenantParams,
      );
    })) as Array<{
      id: string;
      framework_id: string;
      framework_name: string;
      code: string;
      description: string;
      grade_band: string | null;
      domain: string | null;
      cluster: string | null;
    }>;

    const platformDtos: StandardDto[] = platformRows.map((r) => ({
      id: r.id,
      source: 'PLATFORM' as StandardSource,
      frameworkId: r.framework_id,
      frameworkName: r.framework_name,
      code: r.code,
      description: r.description,
      gradeBand: r.grade_band,
      domain: r.domain,
      cluster: r.cluster,
    }));
    const tenantDtos: StandardDto[] = tenantRows.map((r) => ({
      id: r.id,
      source: 'SCHOOL' as StandardSource,
      frameworkId: r.framework_id,
      frameworkName: r.framework_name,
      code: r.code,
      description: r.description,
      gradeBand: r.grade_band,
      domain: r.domain,
      cluster: r.cluster,
    }));
    return [...platformDtos, ...tenantDtos];
  }

  /**
   * Resolve a single standard from EITHER platform OR tenant.
   * Used by the Step 5 UnitService.alignStandard validation
   * before INSERTing into cur_unit_standards.
   */
  async resolveById(
    standardId: string,
  ): Promise<{ source: StandardSource; standard: StandardDto } | null> {
    const tenant = getCurrentTenant();
    const platformRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT s.id::text AS id, s.framework_id::text AS framework_id, pf.name AS framework_name, ' +
          's.code, s.description, s.grade_band, s.domain, s.cluster ' +
          'FROM platform.cur_standards_platform s ' +
          'JOIN platform.cur_standards_frameworks_platform pf ON pf.id = s.framework_id ' +
          'WHERE s.id = $1::uuid LIMIT 1',
        standardId,
      );
    })) as Array<{
      id: string;
      framework_id: string;
      framework_name: string;
      code: string;
      description: string;
      grade_band: string | null;
      domain: string | null;
      cluster: string | null;
    }>;
    if (platformRows.length > 0) {
      const r = platformRows[0]!;
      return {
        source: 'PLATFORM',
        standard: {
          id: r.id,
          source: 'PLATFORM',
          frameworkId: r.framework_id,
          frameworkName: r.framework_name,
          code: r.code,
          description: r.description,
          gradeBand: r.grade_band,
          domain: r.domain,
          cluster: r.cluster,
        },
      };
    }
    const tenantRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT s.id::text AS id, s.framework_id::text AS framework_id, f.name AS framework_name, ' +
          's.code, s.description, s.grade_band, s.domain, s.cluster ' +
          'FROM cur_standards s ' +
          'JOIN cur_standards_frameworks f ON f.id = s.framework_id ' +
          'WHERE s.id = $1::uuid AND f.school_id = $2::uuid LIMIT 1',
        standardId,
        tenant.schoolId,
      );
    })) as Array<{
      id: string;
      framework_id: string;
      framework_name: string;
      code: string;
      description: string;
      grade_band: string | null;
      domain: string | null;
      cluster: string | null;
    }>;
    if (tenantRows.length > 0) {
      const r = tenantRows[0]!;
      return {
        source: 'SCHOOL',
        standard: {
          id: r.id,
          source: 'SCHOOL',
          frameworkId: r.framework_id,
          frameworkName: r.framework_name,
          code: r.code,
          description: r.description,
          gradeBand: r.grade_band,
          domain: r.domain,
          cluster: r.cluster,
        },
      };
    }
    return null;
  }

  async createCustom(input: CreateStandardDto, actor: ResolvedActor): Promise<StandardDto> {
    await assertCurriculumWriter(actor, this.permCheck);
    const tenant = getCurrentTenant();
    // Validate framework is school-custom (cannot add platform standards via this endpoint)
    const fwRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM cur_standards_frameworks WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        input.frameworkId,
        tenant.schoolId,
      );
    })) as Array<{ ok: number }>;
    if (fwRows.length === 0) {
      throw new BadRequestException(
        'frameworkId must reference a school-custom framework — platform standards are read-only',
      );
    }
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO cur_standards (id, framework_id, code, description, grade_band, domain, cluster) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)',
          id,
          input.frameworkId,
          input.code,
          input.description,
          input.gradeBand ?? null,
          input.domain ?? null,
          input.cluster ?? null,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('A standard with this code already exists in this framework');
      }
      throw err;
    }
    const found = await this.resolveById(id);
    if (!found) throw new NotFoundException('Standard not found after create');
    return found.standard;
  }

  async patchCustom(
    id: string,
    input: UpdateStandardDto,
    actor: ResolvedActor,
  ): Promise<StandardDto> {
    await assertCurriculumWriter(actor, this.permCheck);
    const tenant = getCurrentTenant();
    // Confirm tenant standard
    const exists = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM cur_standards s JOIN cur_standards_frameworks f ON f.id = s.framework_id ' +
          'WHERE s.id = $1::uuid AND f.school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      );
    })) as Array<{ ok: number }>;
    if (exists.length === 0) {
      throw new NotFoundException('Custom standard not found (platform standards are read-only)');
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.code !== undefined) {
      sets.push('code = $' + (params.length + 1));
      params.push(input.code);
    }
    if (input.description !== undefined) {
      sets.push('description = $' + (params.length + 1));
      params.push(input.description);
    }
    if (input.gradeBand !== undefined) {
      sets.push('grade_band = $' + (params.length + 1));
      params.push(input.gradeBand);
    }
    if (input.domain !== undefined) {
      sets.push('domain = $' + (params.length + 1));
      params.push(input.domain);
    }
    if (input.cluster !== undefined) {
      sets.push('cluster = $' + (params.length + 1));
      params.push(input.cluster);
    }
    if (sets.length > 0) {
      sets.push('updated_at = now()');
      params.push(id);
      try {
        await this.tenantPrisma.executeInTenantContext(async (client) => {
          await client.$executeRawUnsafe(
            'UPDATE cur_standards SET ' +
              sets.join(', ') +
              ' WHERE id = $' +
              params.length +
              '::uuid',
            ...params,
          );
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException('A standard with this code already exists in this framework');
        }
        throw err;
      }
    }
    const found = await this.resolveById(id);
    if (!found) throw new NotFoundException('Standard not found after update');
    return found.standard;
  }
}
