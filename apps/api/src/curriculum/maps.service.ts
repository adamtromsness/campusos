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
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import { isUniqueViolation, StandardService } from './frameworks.service';
import type {
  AlignStandardDto,
  CreateCurriculumMapDto,
  CreateUnitDto,
  CurriculumMapDto,
  CurriculumMapStatus,
  FrameworkSource,
  LinkLessonDto,
  ReorderUnitsDto,
  UnitDetailDto,
  UnitDto,
  UnitLessonDto,
  UnitStandardDto,
  UpdateCurriculumMapDto,
  UpdateUnitDto,
} from './dto/curriculum.dto';

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

const ALLOWED_TRANSITIONS: Record<CurriculumMapStatus, CurriculumMapStatus[]> = {
  DRAFT: ['PUBLISHED', 'ARCHIVED'],
  PUBLISHED: ['DRAFT', 'ARCHIVED'],
  ARCHIVED: ['DRAFT'],
};

@Injectable()
export class CurriculumMapService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  // Non-staff actors only see PUBLISHED maps. Teachers + admins
  // see all statuses.
  private async buildVisibility(
    actor: ResolvedActor,
  ): Promise<{ predicate: string; params: unknown[] }> {
    const tenant = getCurrentTenant();
    if (actor.isSchoolAdmin) {
      return { predicate: '', params: [tenant.schoolId] };
    }
    const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'tch-008:write',
    ]);
    if (ok) {
      return { predicate: '', params: [tenant.schoolId] };
    }
    // Read-only personas (parent, student): PUBLISHED only
    return {
      predicate: " AND m.status = 'PUBLISHED'",
      params: [tenant.schoolId],
    };
  }

  async list(
    actor: ResolvedActor,
    filters: {
      subject?: string;
      gradeLevel?: string;
      academicYearId?: string;
      status?: CurriculumMapStatus;
    } = {},
  ): Promise<CurriculumMapDto[]> {
    const tenant = getCurrentTenant();
    const vis = await this.buildVisibility(actor);
    const params: unknown[] = vis.params.length > 0 ? [...vis.params] : [tenant.schoolId];
    let where = ' WHERE m.school_id = $1::uuid' + vis.predicate;
    if (filters.subject) {
      params.push(filters.subject);
      where += ' AND m.subject = $' + params.length;
    }
    if (filters.gradeLevel) {
      params.push(filters.gradeLevel);
      where += ' AND m.grade_level = $' + params.length;
    }
    if (filters.academicYearId) {
      params.push(filters.academicYearId);
      where += ' AND m.academic_year_id = $' + params.length + '::uuid';
    }
    if (filters.status) {
      params.push(filters.status);
      where += ' AND m.status = $' + params.length;
    }

    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT m.id::text AS id, m.school_id::text AS school_id, ' +
          'm.academic_year_id::text AS academic_year_id, ay.name AS academic_year_name, ' +
          'm.framework_id::text AS framework_id, m.subject, m.grade_level, m.title, ' +
          'm.description, m.status, m.created_by::text AS created_by, ' +
          'm.published_at::text AS published_at, m.archived_at::text AS archived_at, ' +
          '(SELECT COUNT(*)::int FROM cur_units u WHERE u.curriculum_map_id = m.id) AS unit_count, ' +
          '(SELECT COUNT(*)::int FROM cur_unit_standards us JOIN cur_units u ON u.id = us.unit_id WHERE u.curriculum_map_id = m.id) AS total_standards, ' +
          "(SELECT COUNT(*)::int FROM cur_delivery_gaps g JOIN cur_units u ON u.id = g.unit_id WHERE u.curriculum_map_id = m.id AND g.gap_type = 'COMPLETE') AS gap_complete, " +
          "(SELECT COUNT(*)::int FROM cur_delivery_gaps g JOIN cur_units u ON u.id = g.unit_id WHERE u.curriculum_map_id = m.id AND g.gap_type = 'PARTIAL') AS gap_partial, " +
          "(SELECT COUNT(*)::int FROM cur_delivery_gaps g JOIN cur_units u ON u.id = g.unit_id WHERE u.curriculum_map_id = m.id AND g.gap_type = 'NOT_STARTED') AS gap_not_started " +
          'FROM cur_curriculum_maps m ' +
          'JOIN sis_academic_years ay ON ay.id = m.academic_year_id' +
          where +
          ' ORDER BY m.created_at DESC',
        ...params,
      );
    })) as Array<{
      id: string;
      school_id: string;
      academic_year_id: string;
      academic_year_name: string;
      framework_id: string | null;
      subject: string;
      grade_level: string;
      title: string;
      description: string | null;
      status: CurriculumMapStatus;
      created_by: string;
      published_at: string | null;
      archived_at: string | null;
      unit_count: number;
      total_standards: number;
      gap_complete: number;
      gap_partial: number;
      gap_not_started: number;
    }>;

    // Resolve framework name + source per row
    const out: CurriculumMapDto[] = [];
    for (const r of rows) {
      let fwName: string | null = null;
      let fwSource: FrameworkSource | null = null;
      if (r.framework_id) {
        const platformRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
          return client.$queryRawUnsafe(
            'SELECT name FROM platform.cur_standards_frameworks_platform WHERE id = $1::uuid LIMIT 1',
            r.framework_id,
          );
        })) as Array<{ name: string }>;
        if (platformRows.length > 0) {
          fwName = platformRows[0]!.name;
          fwSource = 'PLATFORM';
        } else {
          const tenantRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
            return client.$queryRawUnsafe(
              'SELECT name FROM cur_standards_frameworks WHERE id = $1::uuid LIMIT 1',
              r.framework_id,
            );
          })) as Array<{ name: string }>;
          if (tenantRows.length > 0) {
            fwName = tenantRows[0]!.name;
            fwSource = 'SCHOOL';
          }
        }
      }
      out.push({
        id: r.id,
        schoolId: r.school_id,
        academicYearId: r.academic_year_id,
        academicYearName: r.academic_year_name,
        frameworkId: r.framework_id,
        frameworkName: fwName,
        frameworkSource: fwSource,
        subject: r.subject,
        gradeLevel: r.grade_level,
        title: r.title,
        description: r.description,
        status: r.status,
        createdBy: r.created_by,
        publishedAt: r.published_at,
        archivedAt: r.archived_at,
        unitCount: r.unit_count,
        totalStandards: r.total_standards,
        gapSummary: {
          complete: r.gap_complete,
          partial: r.gap_partial,
          notStarted: r.gap_not_started,
        },
      });
    }
    return out;
  }

  async getById(id: string, actor: ResolvedActor): Promise<CurriculumMapDto> {
    const all = await this.list(actor);
    const found = all.find((m) => m.id === id);
    if (!found) throw new NotFoundException('Curriculum map not found');
    return found;
  }

  /**
   * REVIEW-CYCLE23 MAJOR 4 — frameworkId validation on map
   * create/patch. Validates the supplied frameworkId resolves to
   * EITHER:
   *   (a) a current-tenant cur_standards_frameworks row that's
   *       active and belongs to this school; OR
   *   (b) an adopted platform.cur_standards_frameworks_platform
   *       framework — verified via cur_school_framework_adoptions
   *       for the supplied academic_year_id.
   *
   * Mirrors the soft-integrity validation pattern from prior
   * cycles (Cycle 6.1 ProfileService.assertTargetInCurrentTenant,
   * Cycle 22 assertAccountInCurrentTenant).
   */
  private async assertFrameworkVisibleForMap(
    frameworkId: string,
    academicYearId: string,
  ): Promise<void> {
    const tenant = getCurrentTenant();
    // (a) tenant custom framework
    const tenantRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM cur_standards_frameworks ' +
          'WHERE id = $1::uuid AND school_id = $2::uuid AND is_active = true LIMIT 1',
        frameworkId,
        tenant.schoolId,
      );
    })) as Array<{ ok: number }>;
    if (tenantRows.length > 0) return;
    // (b) adopted platform framework for this school + year
    const platformRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM cur_school_framework_adoptions ' +
          'WHERE platform_framework_id = $1::uuid AND school_id = $2::uuid AND academic_year_id = $3::uuid LIMIT 1',
        frameworkId,
        tenant.schoolId,
        academicYearId,
      );
    })) as Array<{ ok: number }>;
    if (platformRows.length > 0) return;
    throw new BadRequestException(
      'frameworkId must reference a current-tenant custom framework OR a platform framework adopted for this school + academic year',
    );
  }

  async create(input: CreateCurriculumMapDto, actor: ResolvedActor): Promise<CurriculumMapDto> {
    await assertCurriculumWriter(actor, this.permCheck);
    const tenant = getCurrentTenant();
    // Validate academic year belongs to school
    const yearRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM sis_academic_years WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        input.academicYearId,
        tenant.schoolId,
      );
    })) as Array<{ ok: number }>;
    if (yearRows.length === 0) {
      throw new BadRequestException('academicYearId does not match a year in this school');
    }
    if (input.frameworkId) {
      await this.assertFrameworkVisibleForMap(input.frameworkId, input.academicYearId);
    }
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO cur_curriculum_maps (id, school_id, framework_id, academic_year_id, subject, grade_level, title, description, created_by) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9::uuid)',
        id,
        tenant.schoolId,
        input.frameworkId ?? null,
        input.academicYearId,
        input.subject,
        input.gradeLevel,
        input.title,
        input.description ?? null,
        actor.accountId,
      );
    });
    return this.getById(id, actor);
  }

  async patch(
    id: string,
    input: UpdateCurriculumMapDto,
    actor: ResolvedActor,
  ): Promise<CurriculumMapDto> {
    await assertCurriculumWriter(actor, this.permCheck);
    // P2-H1 Step 1: school-scope the lock + UPDATE so a foreign-school map id
    // resolves to NotFoundException at the loader stage.
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT status, academic_year_id::text AS academic_year_id FROM cur_curriculum_maps ' +
          'WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE',
        id,
        tenant.schoolId,
      )) as Array<{ status: CurriculumMapStatus; academic_year_id: string }>;
      if (lockRows.length === 0) throw new NotFoundException('Curriculum map not found');
      const cur = lockRows[0]!.status;
      const curYearId = lockRows[0]!.academic_year_id;
      // REVIEW-CYCLE23 MAJOR 4 — validate frameworkId against the
      // current academic year (the academic year column itself is
      // not editable via this DTO).
      if (input.frameworkId !== undefined) {
        await this.assertFrameworkVisibleForMap(input.frameworkId, curYearId);
      }
      const sets: string[] = [];
      const params: unknown[] = [];

      if (input.title !== undefined) {
        sets.push('title = $' + (params.length + 1));
        params.push(input.title);
      }
      if (input.description !== undefined) {
        sets.push('description = $' + (params.length + 1));
        params.push(input.description);
      }
      if (input.subject !== undefined) {
        sets.push('subject = $' + (params.length + 1));
        params.push(input.subject);
      }
      if (input.gradeLevel !== undefined) {
        sets.push('grade_level = $' + (params.length + 1));
        params.push(input.gradeLevel);
      }
      if (input.frameworkId !== undefined) {
        sets.push('framework_id = $' + (params.length + 1) + '::uuid');
        params.push(input.frameworkId);
      }
      if (input.status !== undefined && input.status !== cur) {
        const allowed = ALLOWED_TRANSITIONS[cur] ?? [];
        if (!allowed.includes(input.status)) {
          throw new ConflictException(
            'Status transition ' + cur + ' → ' + input.status + ' is not allowed',
          );
        }
        sets.push('status = $' + (params.length + 1));
        params.push(input.status);
        if (input.status === 'PUBLISHED') {
          sets.push('published_at = COALESCE(published_at, now())');
          sets.push('archived_at = NULL');
        } else if (input.status === 'ARCHIVED') {
          sets.push('archived_at = now()');
        } else if (input.status === 'DRAFT') {
          sets.push('published_at = NULL');
          sets.push('archived_at = NULL');
        }
      }
      if (sets.length > 0) {
        sets.push('updated_at = now()');
        params.push(id);
        params.push(tenant.schoolId);
        await tx.$executeRawUnsafe(
          'UPDATE cur_curriculum_maps SET ' +
            sets.join(', ') +
            ' WHERE id = $' +
            (params.length - 1) +
            '::uuid AND school_id = $' +
            params.length +
            '::uuid',
          ...params,
        );
      }
    });
    return this.getById(id, actor);
  }
}

@Injectable()
export class UnitService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
    private readonly standards: StandardService,
  ) {}

  /**
   * REVIEW-CYCLE23 BLOCKING 2 — propagate the parent map visibility
   * down to unit reads. Read-only personas (Parent, Student) can
   * only see units under PUBLISHED maps. Staff + admins see all.
   * Non-staff actors trying to read units under a DRAFT/ARCHIVED
   * map (or a map that doesn't exist in this tenant) get a
   * collapsed 404.
   */
  private async assertCanReadMap(mapId: string, actor: ResolvedActor): Promise<void> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT status FROM cur_curriculum_maps WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        mapId,
        tenant.schoolId,
      );
    })) as Array<{ status: CurriculumMapStatus }>;
    if (rows.length === 0) {
      throw new NotFoundException('Curriculum map not found');
    }
    if (actor.isSchoolAdmin) return;
    const isWriter = await this.permCheck.hasAnyPermissionInTenant(
      actor.accountId,
      tenant.schoolId,
      ['tch-008:write'],
    );
    if (isWriter) return;
    if (rows[0]!.status !== 'PUBLISHED') {
      throw new NotFoundException('Curriculum map not found');
    }
  }

  async listForMap(mapId: string, actor: ResolvedActor): Promise<UnitDto[]> {
    await this.assertCanReadMap(mapId, actor);
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT u.id::text AS id, u.curriculum_map_id::text AS curriculum_map_id, u.title, u.description, ' +
          'u.sequence_order, u.estimated_weeks, u.start_date::text AS start_date, u.end_date::text AS end_date, ' +
          'u.essential_questions, ' +
          '(SELECT COUNT(*)::int FROM cur_unit_standards s WHERE s.unit_id = u.id) AS standard_count, ' +
          '(SELECT COUNT(*)::int FROM cur_unit_lessons l WHERE l.unit_id = u.id) AS lesson_count, ' +
          '(SELECT COUNT(*)::int FROM cur_resource_links r WHERE r.unit_id = u.id) AS resource_count, ' +
          "(SELECT COUNT(*)::int FROM cur_delivery_gaps g WHERE g.unit_id = u.id AND g.gap_type = 'COMPLETE') AS gap_complete, " +
          "(SELECT COUNT(*)::int FROM cur_delivery_gaps g WHERE g.unit_id = u.id AND g.gap_type = 'PARTIAL') AS gap_partial, " +
          "(SELECT COUNT(*)::int FROM cur_delivery_gaps g WHERE g.unit_id = u.id AND g.gap_type = 'NOT_STARTED') AS gap_not_started " +
          'FROM cur_units u WHERE u.curriculum_map_id = $1::uuid ORDER BY u.sequence_order',
        mapId,
      );
    })) as Array<{
      id: string;
      curriculum_map_id: string;
      title: string;
      description: string | null;
      sequence_order: number;
      estimated_weeks: number | null;
      start_date: string | null;
      end_date: string | null;
      essential_questions: string[];
      standard_count: number;
      lesson_count: number;
      resource_count: number;
      gap_complete: number;
      gap_partial: number;
      gap_not_started: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      curriculumMapId: r.curriculum_map_id,
      title: r.title,
      description: r.description,
      sequenceOrder: r.sequence_order,
      estimatedWeeks: r.estimated_weeks,
      startDate: r.start_date,
      endDate: r.end_date,
      essentialQuestions: r.essential_questions,
      standardCount: r.standard_count,
      lessonCount: r.lesson_count,
      resourceCount: r.resource_count,
      gapSummary: {
        complete: r.gap_complete,
        partial: r.gap_partial,
        notStarted: r.gap_not_started,
      },
    }));
  }

  async getById(id: string, actor: ResolvedActor): Promise<UnitDetailDto> {
    // P2-H1 Step 1: school-scope via JOIN to cur_curriculum_maps.school_id.
    const tenant = getCurrentTenant();
    const list = await this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT u.id::text AS id, u.curriculum_map_id::text AS curriculum_map_id, u.title, u.description, ' +
          'u.sequence_order, u.estimated_weeks, u.start_date::text AS start_date, u.end_date::text AS end_date, ' +
          'u.essential_questions ' +
          'FROM cur_units u JOIN cur_curriculum_maps m ON m.id = u.curriculum_map_id ' +
          'WHERE u.id = $1::uuid AND m.school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      )) as Array<{
        id: string;
        curriculum_map_id: string;
        title: string;
        description: string | null;
        sequence_order: number;
        estimated_weeks: number | null;
        start_date: string | null;
        end_date: string | null;
        essential_questions: string[];
      }>;
      return rows;
    });
    if (list.length === 0) throw new NotFoundException('Unit not found');
    if (list.length === 0) {
      throw new NotFoundException('Unit not found');
    }
    const u = list[0]!;
    // REVIEW-CYCLE23 BLOCKING 2 — propagate parent map visibility.
    // Read-only personas (Parent, Student) cannot see units under
    // DRAFT/ARCHIVED maps even if they obtain the unit id.
    await this.assertCanReadMap(u.curriculum_map_id, actor);
    const summary = await this.listForMap(u.curriculum_map_id, actor);
    const summaryRow = summary.find((s) => s.id === id);

    // REVIEW-CYCLE23 BLOCKING 1 — non-staff actors must not see
    // is_teacher_only resources via the unit-detail endpoint either.
    // Mirrors the ResourceLinkService.listForUnit visibility rule.
    const isStaffActor = actor.isSchoolAdmin || actor.personType === 'STAFF';

    // Standards
    const stdLinks = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, standard_id::text AS standard_id, notes ' +
          'FROM cur_unit_standards WHERE unit_id = $1::uuid',
        id,
      );
    })) as Array<{ id: string; standard_id: string; notes: string | null }>;
    const standards: UnitStandardDto[] = [];
    for (const link of stdLinks) {
      const resolved = await this.standards.resolveById(link.standard_id);
      if (resolved) {
        standards.push({
          id: link.id,
          unitId: id,
          standardId: link.standard_id,
          standard: resolved.standard,
          notes: link.notes,
        });
      }
    }

    // Lessons
    const lessonRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT ul.id::text AS id, ul.cls_lesson_id::text AS cls_lesson_id, ' +
          'l.title AS lesson_title, l.date::text AS lesson_date, l.status AS lesson_status ' +
          'FROM cur_unit_lessons ul ' +
          'LEFT JOIN cls_lessons l ON l.id = ul.cls_lesson_id ' +
          'WHERE ul.unit_id = $1::uuid ORDER BY l.date NULLS LAST, l.title',
        id,
      );
    })) as Array<{
      id: string;
      cls_lesson_id: string;
      lesson_title: string | null;
      lesson_date: string | null;
      lesson_status: string | null;
    }>;
    const lessons: UnitLessonDto[] = lessonRows.map((r) => ({
      id: r.id,
      unitId: id,
      clsLessonId: r.cls_lesson_id,
      lessonTitle: r.lesson_title ?? '(deleted lesson)',
      lessonDate: r.lesson_date,
      lessonStatus: r.lesson_status ?? 'UNKNOWN',
    }));

    // Resources — non-staff actors never see is_teacher_only=true rows
    const resRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, resource_type, title, description, url, s3_key, is_teacher_only, ' +
          'uploaded_by::text AS uploaded_by, created_at::text AS created_at ' +
          'FROM cur_resource_links WHERE unit_id = $1::uuid' +
          (isStaffActor ? '' : ' AND is_teacher_only = false') +
          ' ORDER BY created_at DESC',
        id,
      );
    })) as Array<{
      id: string;
      resource_type: string;
      title: string;
      description: string | null;
      url: string | null;
      s3_key: string | null;
      is_teacher_only: boolean;
      uploaded_by: string;
      created_at: string;
    }>;

    // Gaps
    const gapRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT g.id::text AS id, g.unit_id::text AS unit_id, g.standard_id::text AS standard_id, ' +
          'g.gap_type, g.lessons_planned, g.lessons_delivered, ' +
          'g.last_assessed_at::text AS last_assessed_at, g.computed_at::text AS computed_at ' +
          'FROM cur_delivery_gaps g WHERE g.unit_id = $1::uuid',
        id,
      );
    })) as Array<{
      id: string;
      unit_id: string;
      standard_id: string;
      gap_type: 'NOT_STARTED' | 'PARTIAL' | 'COMPLETE';
      lessons_planned: number;
      lessons_delivered: number;
      last_assessed_at: string | null;
      computed_at: string;
    }>;
    const gaps = [];
    for (const g of gapRows) {
      const resolved = await this.standards.resolveById(g.standard_id);
      gaps.push({
        id: g.id,
        unitId: g.unit_id,
        unitTitle: u.title,
        curriculumMapId: u.curriculum_map_id,
        standardId: g.standard_id,
        standardCode: resolved?.standard.code ?? '(unknown)',
        standardDescription: resolved?.standard.description ?? '',
        gapType: g.gap_type,
        lessonsPlanned: g.lessons_planned,
        lessonsDelivered: g.lessons_delivered,
        lastAssessedAt: g.last_assessed_at,
        computedAt: g.computed_at,
      });
    }

    return {
      id: u.id,
      curriculumMapId: u.curriculum_map_id,
      title: u.title,
      description: u.description,
      sequenceOrder: u.sequence_order,
      estimatedWeeks: u.estimated_weeks,
      startDate: u.start_date,
      endDate: u.end_date,
      essentialQuestions: u.essential_questions,
      standardCount: standards.length,
      lessonCount: lessons.length,
      resourceCount: resRows.length,
      gapSummary: summaryRow?.gapSummary ?? { complete: 0, partial: 0, notStarted: 0 },
      standards,
      lessons,
      resources: resRows.map((r) => ({
        id: r.id,
        unitId: id,
        resourceType: r.resource_type as UnitDetailDto['resources'][number]['resourceType'],
        title: r.title,
        description: r.description,
        url: r.url,
        s3Key: r.s3_key,
        isTeacherOnly: r.is_teacher_only,
        uploadedBy: r.uploaded_by,
        createdAt: r.created_at,
      })),
      gaps,
    };
  }

  async create(mapId: string, input: CreateUnitDto, actor: ResolvedActor): Promise<UnitDto> {
    await assertCurriculumWriter(actor, this.permCheck);
    // P2-H5 DEFECT 1b fix: validate the parent map belongs to the current
    // school BEFORE inserting the unit. The check runs inside the same tenant
    // transaction as the INSERT so a crafted cross-school mapId cannot pass
    // and then have a unit inserted under it.
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const mapRows = (await tx.$queryRawUnsafe(
        'SELECT 1 AS ok FROM cur_curriculum_maps WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        mapId,
        tenant.schoolId,
      )) as Array<{ ok: number }>;
      if (mapRows.length === 0) {
        throw new BadRequestException('curriculum_map_id does not match a map in this school');
      }
      // Compute next sequence_order under the lock to avoid races
      const seqRows = (await tx.$queryRawUnsafe(
        'SELECT COALESCE(MAX(sequence_order), 0) + 1 AS next FROM cur_units WHERE curriculum_map_id = $1::uuid',
        mapId,
      )) as Array<{ next: number }>;
      const nextSeq = seqRows[0]!.next;
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO cur_units (id, curriculum_map_id, title, description, sequence_order, estimated_weeks, start_date, end_date, essential_questions) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::date, $8::date, $9::text[])',
          id,
          mapId,
          input.title,
          input.description ?? null,
          nextSeq,
          input.estimatedWeeks ?? null,
          input.startDate ?? null,
          input.endDate ?? null,
          input.essentialQuestions ?? [],
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException(
            'A unit with this sequence order already exists in the curriculum map',
          );
        }
        throw err;
      }
    });
    const list = await this.listForMap(mapId, actor);
    const found = list.find((u) => u.id === id);
    if (!found) throw new NotFoundException('Unit not found after create');
    return found;
  }

  async patch(id: string, input: UpdateUnitDto, actor: ResolvedActor): Promise<UnitDetailDto> {
    await assertCurriculumWriter(actor, this.permCheck);
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.title !== undefined) {
      sets.push('title = $' + (params.length + 1));
      params.push(input.title);
    }
    if (input.description !== undefined) {
      sets.push('description = $' + (params.length + 1));
      params.push(input.description);
    }
    if (input.estimatedWeeks !== undefined) {
      sets.push('estimated_weeks = $' + (params.length + 1));
      params.push(input.estimatedWeeks);
    }
    if (input.startDate !== undefined) {
      sets.push('start_date = $' + (params.length + 1) + '::date');
      params.push(input.startDate);
    }
    if (input.endDate !== undefined) {
      sets.push('end_date = $' + (params.length + 1) + '::date');
      params.push(input.endDate);
    }
    if (input.essentialQuestions !== undefined) {
      sets.push('essential_questions = $' + (params.length + 1) + '::text[]');
      params.push(input.essentialQuestions);
    }
    if (sets.length > 0) {
      sets.push('updated_at = now()');
      params.push(id);
      // P2-H1 Step 1: UPDATE joins through cur_curriculum_maps.school_id.
      const tenant = getCurrentTenant();
      params.push(tenant.schoolId);
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'UPDATE cur_units AS u SET ' +
            sets.join(', ') +
            ' FROM cur_curriculum_maps m ' +
            ' WHERE u.id = $' +
            (params.length - 1) +
            '::uuid AND m.id = u.curriculum_map_id AND m.school_id = $' +
            params.length +
            '::uuid',
          ...params,
        );
      });
    }
    return this.getById(id, actor);
  }

  /**
   * Batch-reorder units within a map. Runs the entire renumber
   * inside one tenant tx; uses a temporary very-large offset to
   * dodge the UNIQUE(curriculum_map_id, sequence_order) constraint
   * that would otherwise fire mid-update.
   */
  async reorder(mapId: string, input: ReorderUnitsDto, actor: ResolvedActor): Promise<UnitDto[]> {
    await assertCurriculumWriter(actor, this.permCheck);
    if (input.order.length === 0) return this.listForMap(mapId, actor);
    // P2-H5 DEFECT 1b fix: every UPDATE binds the parent map's school_id so a
    // cross-school mapId cannot drive reorder writes against the foreign-school
    // units. The map ownership check runs inside the same tx as the renumber.
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const mapRows = (await tx.$queryRawUnsafe(
        'SELECT 1 AS ok FROM cur_curriculum_maps WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        mapId,
        tenant.schoolId,
      )) as Array<{ ok: number }>;
      if (mapRows.length === 0) {
        throw new BadRequestException('curriculum_map_id does not match a map in this school');
      }
      // Phase 1: bump all referenced units to a high temp offset
      for (const o of input.order) {
        await tx.$executeRawUnsafe(
          'UPDATE cur_units AS u SET sequence_order = u.sequence_order + 100000 ' +
            'FROM cur_curriculum_maps m ' +
            'WHERE u.id = $1::uuid AND u.curriculum_map_id = $2::uuid ' +
            'AND m.id = u.curriculum_map_id AND m.school_id = $3::uuid',
          o.unitId,
          mapId,
          tenant.schoolId,
        );
      }
      // Phase 2: assign final positions
      for (const o of input.order) {
        await tx.$executeRawUnsafe(
          'UPDATE cur_units AS u SET sequence_order = $1, updated_at = now() ' +
            'FROM cur_curriculum_maps m ' +
            'WHERE u.id = $2::uuid AND u.curriculum_map_id = $3::uuid ' +
            'AND m.id = u.curriculum_map_id AND m.school_id = $4::uuid',
          o.sequenceOrder,
          o.unitId,
          mapId,
          tenant.schoolId,
        );
      }
    });
    return this.listForMap(mapId, actor);
  }

  // ── Standards alignment ──

  async alignStandard(
    unitId: string,
    input: AlignStandardDto,
    actor: ResolvedActor,
  ): Promise<UnitStandardDto> {
    await assertCurriculumWriter(actor, this.permCheck);
    // DUAL RESOLUTION KEYSTONE — validate the standard resolves
    // from EITHER the platform or tenant catalogue before INSERT
    const resolved = await this.standards.resolveById(input.standardId);
    if (!resolved) {
      throw new BadRequestException(
        'standardId does not resolve in either the platform or school catalogue',
      );
    }
    // P2-H5 DEFECT 1b fix: validate the unit belongs to a map in the current
    // school. Otherwise a crafted cross-school unitId combined with a valid
    // current-school (or platform) standard would land a foreign alignment.
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const unitRows = (await tx.$queryRawUnsafe(
        'SELECT 1 AS ok FROM cur_units u ' +
          'JOIN cur_curriculum_maps m ON m.id = u.curriculum_map_id ' +
          'WHERE u.id = $1::uuid AND m.school_id = $2::uuid LIMIT 1',
        unitId,
        tenant.schoolId,
      )) as Array<{ ok: number }>;
      if (unitRows.length === 0) {
        throw new BadRequestException('unitId does not match a unit in this school');
      }
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO cur_unit_standards (id, unit_id, standard_id, notes) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4)',
          id,
          unitId,
          input.standardId,
          input.notes ?? null,
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException('This standard is already aligned to this unit');
        }
        throw err;
      }
    });
    return {
      id,
      unitId,
      standardId: input.standardId,
      standard: resolved.standard,
      notes: input.notes ?? null,
    };
  }

  async unalignStandard(linkId: string, actor: ResolvedActor): Promise<void> {
    await assertCurriculumWriter(actor, this.permCheck);
    // P2-H1 Step 1: school-scope via JOIN through cur_units → cur_curriculum_maps.school_id.
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'DELETE FROM cur_unit_standards us ' +
          'USING cur_units u, cur_curriculum_maps m ' +
          'WHERE us.id = $1::uuid AND u.id = us.unit_id AND m.id = u.curriculum_map_id ' +
          'AND m.school_id = $2::uuid',
        linkId,
        tenant.schoolId,
      );
    });
  }

  // ── Lesson linking (cross-cycle keystone) ──

  async linkLesson(
    unitId: string,
    input: LinkLessonDto,
    actor: ResolvedActor,
  ): Promise<UnitLessonDto> {
    await assertCurriculumWriter(actor, this.permCheck);
    const tenant = getCurrentTenant();
    // P2-H5 DEFECT 1b fix: validate BOTH the unit AND the lesson belong to
    // the calling school. The pre-fix code only checked the lesson — a crafted
    // cross-school unitId combined with a valid current-school lesson could
    // land a foreign-school link row.
    const id = generateId();
    let lessonTitle = '';
    let lessonDate: string | null = null;
    let lessonStatus = '';
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const unitRows = (await tx.$queryRawUnsafe(
        'SELECT 1 AS ok FROM cur_units u ' +
          'JOIN cur_curriculum_maps m ON m.id = u.curriculum_map_id ' +
          'WHERE u.id = $1::uuid AND m.school_id = $2::uuid LIMIT 1',
        unitId,
        tenant.schoolId,
      )) as Array<{ ok: number }>;
      if (unitRows.length === 0) {
        throw new BadRequestException('unitId does not match a unit in this school');
      }
      const lessonRows = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, title, date::text AS date, status FROM cls_lessons ' +
          'WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        input.clsLessonId,
        tenant.schoolId,
      )) as Array<{ id: string; title: string; date: string | null; status: string }>;
      if (lessonRows.length === 0) {
        throw new BadRequestException('clsLessonId does not match a lesson in this school');
      }
      const lesson = lessonRows[0]!;
      lessonTitle = lesson.title;
      lessonDate = lesson.date;
      lessonStatus = lesson.status;
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO cur_unit_lessons (id, unit_id, cls_lesson_id) VALUES ($1::uuid, $2::uuid, $3::uuid)',
          id,
          unitId,
          input.clsLessonId,
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException('This lesson is already linked to this unit');
        }
        throw err;
      }
    });
    return {
      id,
      unitId,
      clsLessonId: input.clsLessonId,
      lessonTitle,
      lessonDate,
      lessonStatus,
    };
  }

  async unlinkLesson(linkId: string, actor: ResolvedActor): Promise<void> {
    await assertCurriculumWriter(actor, this.permCheck);
    // P2-H1 Step 1: school-scope via JOIN through cur_units → cur_curriculum_maps.school_id.
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'DELETE FROM cur_unit_lessons ul ' +
          'USING cur_units u, cur_curriculum_maps m ' +
          'WHERE ul.id = $1::uuid AND u.id = ul.unit_id AND m.id = u.curriculum_map_id ' +
          'AND m.school_id = $2::uuid',
        linkId,
        tenant.schoolId,
      );
    });
  }
}
