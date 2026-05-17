import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import {
  assertCoordinatorScope,
  assertStaffOrAdmin,
  isUniqueViolation,
  resolveStandard,
} from './access';
import type {
  AdoptionDto,
  CreateAdoptionDto,
  CreateCustomFrameworkDto,
  FrameworkDto,
  StandardDto,
} from './dto/accreditation.dto';

/**
 * P2-23a — FrameworkService.
 *
 * Surfaces:
 *   GET  /accreditation/frameworks                  list adopted + available
 *   POST /accreditation/adoptions                   adopt a platform framework
 *   GET  /accreditation/adoptions                   adopted-framework-with-standards
 *   POST /accreditation/custom-frameworks           create a school-custom framework
 *   GET  /accreditation/standards/:frameworkId       standards under a framework
 *   GET  /accreditation/standards/by-id/:id          single standard via SOFT INTEGRITY resolve
 *
 * The framework list always returns BOTH platform frameworks and the
 * school's custom frameworks tagged with `source`. Adoption status is
 * computed per platform framework so the UI can show "adopt" vs
 * "already adopted".
 */
@Injectable()
export class FrameworkService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  async listFrameworks(actor: ResolvedActor): Promise<FrameworkDto[]> {
    assertStaffOrAdmin(actor, 'Listing accreditation frameworks');
    const tenant = getCurrentTenant();

    // Platform frameworks (all active)
    const platformRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT pf.id::text AS id, pf.name, pf.abbreviation, pf.organisation,
                pf.description, pf.version, pf.is_active,
                (SELECT COUNT(*)::int FROM platform.acc_standards_platform s
                 WHERE s.framework_id = pf.id) AS standard_count,
                EXISTS(SELECT 1 FROM acc_school_framework_adoptions a
                       WHERE a.platform_framework_id = pf.id
                         AND a.school_id = $1::uuid
                         AND a.is_active = true) AS is_adopted
         FROM platform.acc_frameworks_platform pf
         WHERE pf.is_active = true
         ORDER BY pf.name`,
        tenant.schoolId,
      );
    })) as Array<{
      id: string;
      name: string;
      abbreviation: string;
      organisation: string;
      description: string | null;
      version: string | null;
      is_active: boolean;
      standard_count: number;
      is_adopted: boolean;
    }>;

    // Custom frameworks (school-scoped)
    const customRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text AS id, name, description, is_active
         FROM acc_frameworks
         WHERE school_id = $1::uuid
         ORDER BY name`,
        tenant.schoolId,
      );
    })) as Array<{
      id: string;
      name: string;
      description: string | null;
      is_active: boolean;
    }>;

    const out: FrameworkDto[] = platformRows.map((r) => ({
      id: r.id,
      source: 'PLATFORM',
      name: r.name,
      abbreviation: r.abbreviation,
      organisation: r.organisation,
      description: r.description,
      version: r.version,
      isActive: r.is_active,
      standardCount: Number(r.standard_count),
      isAdopted: r.is_adopted,
    }));
    for (const r of customRows) {
      out.push({
        id: r.id,
        source: 'TENANT',
        name: r.name,
        abbreviation: null,
        organisation: null,
        description: r.description,
        version: null,
        isActive: r.is_active,
        standardCount: 0,
        isAdopted: true,
      });
    }
    return out;
  }

  async listAdoptions(actor: ResolvedActor): Promise<AdoptionDto[]> {
    assertStaffOrAdmin(actor, 'Listing framework adoptions');
    const tenant = getCurrentTenant();

    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT a.id::text AS id, a.school_id::text AS school_id,
                a.platform_framework_id::text AS platform_framework_id,
                a.adopted_at::text AS adopted_at, a.is_active,
                pf.name AS framework_name, pf.abbreviation AS framework_abbreviation
         FROM acc_school_framework_adoptions a
         JOIN platform.acc_frameworks_platform pf ON pf.id = a.platform_framework_id
         WHERE a.school_id = $1::uuid
         ORDER BY pf.name`,
        tenant.schoolId,
      );
    })) as Array<{
      id: string;
      school_id: string;
      platform_framework_id: string;
      adopted_at: string;
      is_active: boolean;
      framework_name: string;
      framework_abbreviation: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      schoolId: r.school_id,
      platformFrameworkId: r.platform_framework_id,
      frameworkName: r.framework_name,
      frameworkAbbreviation: r.framework_abbreviation,
      adoptedAt: r.adopted_at,
      isActive: r.is_active,
    }));
  }

  async createAdoption(actor: ResolvedActor, input: CreateAdoptionDto): Promise<AdoptionDto> {
    await assertCoordinatorScope(actor, this.permCheck, 'Adopting a framework');
    const tenant = getCurrentTenant();

    // Validate platform framework exists + is active
    const fwRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text AS id, name, abbreviation
         FROM platform.acc_frameworks_platform
         WHERE id = $1::uuid AND is_active = true LIMIT 1`,
        input.platformFrameworkId,
      );
    })) as Array<{ id: string; name: string; abbreviation: string }>;
    if (fwRows.length === 0) {
      throw new NotFoundException(`Platform framework ${input.platformFrameworkId} not found`);
    }

    const id = generateId();
    const adoptedAt = input.adoptedAt ?? new Date().toISOString().slice(0, 10);
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          `INSERT INTO acc_school_framework_adoptions (id, school_id, platform_framework_id, adopted_at, is_active)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, true)`,
          id,
          tenant.schoolId,
          input.platformFrameworkId,
          adoptedAt,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(`Framework ${fwRows[0]!.name} already adopted by this school`);
      }
      throw err;
    }

    return {
      id,
      schoolId: tenant.schoolId,
      platformFrameworkId: input.platformFrameworkId,
      frameworkName: fwRows[0]!.name,
      frameworkAbbreviation: fwRows[0]!.abbreviation,
      adoptedAt,
      isActive: true,
    };
  }

  async createCustomFramework(
    actor: ResolvedActor,
    input: CreateCustomFrameworkDto,
  ): Promise<FrameworkDto> {
    await assertCoordinatorScope(actor, this.permCheck, 'Creating a custom framework');
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          `INSERT INTO acc_frameworks (id, school_id, name, description, is_active)
           VALUES ($1::uuid, $2::uuid, $3, $4, true)`,
          id,
          tenant.schoolId,
          input.name.trim(),
          input.description ?? null,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(`Custom framework "${input.name}" already exists`);
      }
      throw err;
    }
    return {
      id,
      source: 'TENANT',
      name: input.name.trim(),
      abbreviation: null,
      organisation: null,
      description: input.description ?? null,
      version: null,
      isActive: true,
      standardCount: 0,
      isAdopted: true,
    };
  }

  /**
   * List standards under a framework (platform OR tenant). Returns
   * empty array for tenant custom frameworks since the M85 custom-
   * standards child table is deferred — the framework row itself
   * acts as a single standard via SOFT INTEGRITY in P2-23a.
   */
  async listStandardsForFramework(
    actor: ResolvedActor,
    frameworkId: string,
  ): Promise<StandardDto[]> {
    assertStaffOrAdmin(actor, 'Listing standards for a framework');

    // Platform first
    const platformRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text AS id, framework_id::text AS framework_id,
                standard_code, domain, standard_text, guidance_notes, sort_order
         FROM platform.acc_standards_platform
         WHERE framework_id = $1::uuid
         ORDER BY sort_order ASC`,
        frameworkId,
      );
    })) as Array<{
      id: string;
      framework_id: string;
      standard_code: string;
      domain: string;
      standard_text: string;
      guidance_notes: string | null;
      sort_order: number;
    }>;
    if (platformRows.length > 0) {
      return platformRows.map((r) => ({
        id: r.id,
        source: 'PLATFORM',
        frameworkId: r.framework_id,
        standardCode: r.standard_code,
        domain: r.domain,
        standardText: r.standard_text,
        guidanceNotes: r.guidance_notes,
        sortOrder: r.sort_order,
      }));
    }

    // Tenant custom framework — verify it exists in this school then
    // return a single placeholder representing the framework itself
    // (per the SOFT INTEGRITY note above; future cycles ship a real
    // child table).
    const tenant = getCurrentTenant();
    const customRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text AS id, name, description
         FROM acc_frameworks
         WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
        frameworkId,
        tenant.schoolId,
      );
    })) as Array<{ id: string; name: string; description: string | null }>;
    if (customRows.length === 0) {
      throw new NotFoundException(`Framework ${frameworkId} not found`);
    }
    const c = customRows[0]!;
    return [
      {
        id: c.id,
        source: 'TENANT',
        frameworkId: c.id,
        standardCode: c.name,
        domain: null,
        standardText: c.description ?? c.name,
        guidanceNotes: null,
        sortOrder: 1,
      },
    ];
  }

  async getStandardById(actor: ResolvedActor, standardId: string): Promise<StandardDto> {
    assertStaffOrAdmin(actor, 'Reading a standard');
    if (!standardId) throw new BadRequestException('standardId is required');
    const resolved = await resolveStandard(this.tenantPrisma, standardId);
    if (!resolved) {
      throw new NotFoundException(`Standard ${standardId} not found`);
    }
    return {
      id: resolved.id,
      source: resolved.source,
      frameworkId: resolved.frameworkId,
      standardCode: resolved.standardCode,
      domain: resolved.domain,
      standardText: resolved.standardText,
      guidanceNotes: null,
      sortOrder: 0,
    };
  }
}
