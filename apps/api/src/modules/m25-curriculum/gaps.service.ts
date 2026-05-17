import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { KafkaProducerService } from '@shared/kafka/kafka-producer.service';
import { StandardService } from './frameworks.service';
import type {
  CreateResourceDto,
  DeliveryGapDto,
  GapType,
  ResourceDto,
  ResourceType,
  UpdateResourceDto,
} from './dto/curriculum.dto';

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
    throw new ForbiddenException('Only school admins can manually re-materialise delivery gaps');
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
      'Only teachers, curriculum coordinators, or school admins can edit resources',
    );
  }
}

/**
 * REVIEW-CYCLE23 KEYSTONE — Delivery Gap materialisation per ADR-018.
 *
 * The Step 6 worker walks each PUBLISHED cur_curriculum_maps:
 * for each unit, for each aligned standard, count
 *   - lessons_planned: rows in cur_unit_lessons under this unit
 *   - lessons_delivered: cls_lessons rows under this unit's
 *     curriculum_map.subject + grade_level whose status='PUBLISHED'
 *     AND date <= CURRENT_DATE (the proxy for "delivered" since
 *     cls_lessons has no separate delivery flag).
 * Then UPSERT cur_delivery_gaps with the matching gap_type and
 * emit cur.delivery_gap.detected for new NOT_STARTED / PARTIAL
 * gaps on PUBLISHED maps.
 *
 * Never computed on demand at the read path — the GET endpoints
 * read the materialised cur_delivery_gaps rows directly.
 */
@Injectable()
export class DeliveryGapService {
  private readonly logger = new Logger(DeliveryGapService.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
    private readonly kafka: KafkaProducerService,
    private readonly standards: StandardService,
  ) {}

  async list(
    filters: {
      curriculumMapId?: string;
      unitId?: string;
      gapType?: GapType;
    } = {},
    actor?: ResolvedActor,
  ): Promise<DeliveryGapDto[]> {
    // REVIEW-CYCLE23 BLOCKING 3 — delivery gap analytics are
    // internal coverage data. Read-only personas (parents/students)
    // cannot enumerate. Internal callers (UnitService.getById
    // hydrates per-unit gaps for the unit detail surface) pass no
    // actor and bypass this gate; the parent UnitService method
    // already gates teacher-only and parent-map visibility.
    if (actor && !actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      throw new ForbiddenException(
        'Only teachers, curriculum coordinators, or school admins can read delivery gap analytics',
      );
    }
    const params: unknown[] = [];
    const wheres: string[] = [];
    if (filters.unitId) {
      params.push(filters.unitId);
      wheres.push('g.unit_id = $' + params.length + '::uuid');
    }
    if (filters.curriculumMapId) {
      params.push(filters.curriculumMapId);
      wheres.push('u.curriculum_map_id = $' + params.length + '::uuid');
    }
    if (filters.gapType) {
      params.push(filters.gapType);
      wheres.push('g.gap_type = $' + params.length);
    }
    const where = wheres.length === 0 ? '' : ' WHERE ' + wheres.join(' AND ');
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT g.id::text AS id, g.unit_id::text AS unit_id, u.title AS unit_title, ' +
          'u.curriculum_map_id::text AS curriculum_map_id, ' +
          'g.standard_id::text AS standard_id, g.gap_type, ' +
          'g.lessons_planned, g.lessons_delivered, ' +
          'g.last_assessed_at::text AS last_assessed_at, g.computed_at::text AS computed_at ' +
          'FROM cur_delivery_gaps g ' +
          'JOIN cur_units u ON u.id = g.unit_id' +
          where +
          ' ORDER BY g.computed_at DESC',
        ...params,
      );
    })) as Array<{
      id: string;
      unit_id: string;
      unit_title: string;
      curriculum_map_id: string;
      standard_id: string;
      gap_type: GapType;
      lessons_planned: number;
      lessons_delivered: number;
      last_assessed_at: string | null;
      computed_at: string;
    }>;
    const out: DeliveryGapDto[] = [];
    for (const r of rows) {
      const resolved = await this.standards.resolveById(r.standard_id);
      out.push({
        id: r.id,
        unitId: r.unit_id,
        unitTitle: r.unit_title,
        curriculumMapId: r.curriculum_map_id,
        standardId: r.standard_id,
        standardCode: resolved?.standard.code ?? '(unknown)',
        standardDescription: resolved?.standard.description ?? '',
        gapType: r.gap_type,
        lessonsPlanned: r.lessons_planned,
        lessonsDelivered: r.lessons_delivered,
        lastAssessedAt: r.last_assessed_at,
        computedAt: r.computed_at,
      });
    }
    return out;
  }

  /**
   * Manual re-materialisation endpoint for the calling tenant.
   * The nightly cron (out of scope this cycle) calls
   * runForAllTenants() instead.
   */
  async refreshTenant(
    actor: ResolvedActor,
  ): Promise<{ unitsScanned: number; gapsWritten: number }> {
    await assertCurriculumAdmin(actor, this.permCheck);
    return this.materialiseCurrentTenant();
  }

  async materialiseCurrentTenant(): Promise<{ unitsScanned: number; gapsWritten: number }> {
    const tenant = getCurrentTenant();
    let unitsScanned = 0;
    let gapsWritten = 0;
    const newGapsForEmit: Array<{
      unitId: string;
      standardId: string;
      gapType: GapType;
    }> = [];

    // 1. Collect every (map, unit, standard) tuple under PUBLISHED
    //    maps in this tenant
    const tuples = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT m.id::text AS map_id, m.subject, m.grade_level, m.status AS map_status, ' +
          'u.id::text AS unit_id, u.title AS unit_title, ' +
          'us.standard_id::text AS standard_id ' +
          'FROM cur_curriculum_maps m ' +
          'JOIN cur_units u ON u.curriculum_map_id = m.id ' +
          'JOIN cur_unit_standards us ON us.unit_id = u.id ' +
          "WHERE m.school_id = $1::uuid AND m.status = 'PUBLISHED'",
        tenant.schoolId,
      );
    })) as Array<{
      map_id: string;
      subject: string;
      grade_level: string;
      map_status: string;
      unit_id: string;
      unit_title: string;
      standard_id: string;
    }>;

    const unitIds = new Set(tuples.map((t) => t.unit_id));
    unitsScanned = unitIds.size;

    // For efficiency: per-unit lessons_planned (one query per
    // unit) + per-(map subject, grade) delivered count
    const plannedByUnit = new Map<string, number>();
    for (const uid of unitIds) {
      const r = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT COUNT(*)::int AS c FROM cur_unit_lessons WHERE unit_id = $1::uuid',
          uid,
        );
      })) as Array<{ c: number }>;
      plannedByUnit.set(uid, r[0]!.c);
    }

    // For each tuple, count delivered lessons among the linked
    // cls_lessons under this unit. "Delivered" = status='PUBLISHED'
    // AND date <= CURRENT_DATE.
    const deliveredByUnit = new Map<string, number>();
    for (const uid of unitIds) {
      const r = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT COUNT(*)::int AS c FROM cur_unit_lessons ul ' +
            'JOIN cls_lessons l ON l.id = ul.cls_lesson_id ' +
            "WHERE ul.unit_id = $1::uuid AND l.status = 'PUBLISHED' AND (l.date IS NULL OR l.date <= CURRENT_DATE)",
          uid,
        );
      })) as Array<{ c: number }>;
      deliveredByUnit.set(uid, r[0]!.c);
    }

    // 2. UPSERT cur_delivery_gaps for each (unit, standard)
    for (const t of tuples) {
      const planned = plannedByUnit.get(t.unit_id) ?? 0;
      const delivered = deliveredByUnit.get(t.unit_id) ?? 0;
      let gapType: GapType;
      if (planned === 0 && delivered === 0) {
        gapType = 'NOT_STARTED';
      } else if (delivered >= planned && planned > 0) {
        gapType = 'COMPLETE';
      } else if (delivered === 0) {
        gapType = 'NOT_STARTED';
      } else {
        gapType = 'PARTIAL';
      }

      // Was this row a new NOT_STARTED / PARTIAL transition?
      const prior = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT gap_type FROM cur_delivery_gaps WHERE unit_id = $1::uuid AND standard_id = $2::uuid LIMIT 1',
          t.unit_id,
          t.standard_id,
        );
      })) as Array<{ gap_type: GapType }>;
      const isNewProblem =
        (gapType === 'NOT_STARTED' || gapType === 'PARTIAL') &&
        (prior.length === 0 || prior[0]!.gap_type !== gapType);

      try {
        await this.tenantPrisma.executeInTenantContext(async (client) => {
          await client.$executeRawUnsafe(
            'INSERT INTO cur_delivery_gaps (id, unit_id, standard_id, gap_type, lessons_planned, lessons_delivered, computed_at) ' +
              'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, now()) ' +
              'ON CONFLICT (unit_id, standard_id) DO UPDATE SET ' +
              'gap_type = EXCLUDED.gap_type, lessons_planned = EXCLUDED.lessons_planned, ' +
              'lessons_delivered = EXCLUDED.lessons_delivered, computed_at = now()',
            generateId(),
            t.unit_id,
            t.standard_id,
            gapType,
            planned,
            delivered,
          );
        });
        gapsWritten++;
        if (isNewProblem) {
          newGapsForEmit.push({
            unitId: t.unit_id,
            standardId: t.standard_id,
            gapType,
          });
        }
      } catch (err) {
        this.logger.warn(
          `[delivery-gap] UPSERT failed for unit=${t.unit_id} standard=${t.standard_id}: ${
            (err as Error).message
          }`,
        );
      }
    }

    // 3. Emit cur.delivery_gap.detected for new NOT_STARTED /
    //    PARTIAL gaps. Resolves the standard code for each emit.
    for (const g of newGapsForEmit) {
      const resolved = await this.standards.resolveById(g.standardId);
      await this.kafka.emit({
        topic: 'cur.delivery_gap.detected',
        key: g.unitId,
        sourceModule: 'curriculum',
        payload: {
          unitId: g.unitId,
          standardId: g.standardId,
          standardCode: resolved?.standard.code ?? null,
          gapType: g.gapType,
          schoolId: tenant.schoolId,
          sourceRefId: g.unitId,
        },
      });
    }

    return { unitsScanned, gapsWritten };
  }
}

@Injectable()
export class ResourceLinkService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  /**
   * Read-time filter — non-staff actors never see
   * is_teacher_only=true rows. Teachers + admins see all.
   */
  private async hideTeacherOnlyForActor(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return false;
    if (actor.personType === 'STAFF') return false;
    return true;
  }

  async listForUnit(unitId: string, actor: ResolvedActor): Promise<ResourceDto[]> {
    const hide = await this.hideTeacherOnlyForActor(actor);
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, unit_id::text AS unit_id, resource_type, title, description, ' +
          'url, s3_key, is_teacher_only, uploaded_by::text AS uploaded_by, ' +
          'created_at::text AS created_at ' +
          'FROM cur_resource_links WHERE unit_id = $1::uuid' +
          (hide ? ' AND is_teacher_only = false' : '') +
          ' ORDER BY created_at DESC',
        unitId,
      );
    })) as Array<{
      id: string;
      unit_id: string;
      resource_type: string;
      title: string;
      description: string | null;
      url: string | null;
      s3_key: string | null;
      is_teacher_only: boolean;
      uploaded_by: string;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      unitId: r.unit_id,
      resourceType: r.resource_type as ResourceType,
      title: r.title,
      description: r.description,
      url: r.url,
      s3Key: r.s3_key,
      isTeacherOnly: r.is_teacher_only,
      uploadedBy: r.uploaded_by,
      createdAt: r.created_at,
    }));
  }

  async create(
    unitId: string,
    input: CreateResourceDto,
    actor: ResolvedActor,
  ): Promise<ResourceDto> {
    await assertCurriculumWriter(actor, this.permCheck);
    if (input.resourceType === 'URL' || input.resourceType === 'VIDEO') {
      if (!input.url) {
        throw new BadRequestException('url is required for ' + input.resourceType + ' resources');
      }
    }
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO cur_resource_links (id, unit_id, resource_type, title, description, url, s3_key, is_teacher_only, uploaded_by) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::uuid)',
        id,
        unitId,
        input.resourceType,
        input.title,
        input.description ?? null,
        input.url ?? null,
        input.s3Key ?? null,
        input.isTeacherOnly ?? false,
        actor.accountId,
      );
    });
    const list = await this.listForUnit(unitId, actor);
    const found = list.find((r) => r.id === id);
    if (!found) throw new NotFoundException('Resource not found after create');
    return found;
  }

  async patch(id: string, input: UpdateResourceDto, actor: ResolvedActor): Promise<ResourceDto> {
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
    if (input.url !== undefined) {
      sets.push('url = $' + (params.length + 1));
      params.push(input.url);
    }
    if (input.isTeacherOnly !== undefined) {
      sets.push('is_teacher_only = $' + (params.length + 1));
      params.push(input.isTeacherOnly);
    }
    let unitId = '';
    if (sets.length > 0) {
      sets.push('updated_at = now()');
      params.push(id);
      const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'UPDATE cur_resource_links SET ' +
            sets.join(', ') +
            ' WHERE id = $' +
            params.length +
            '::uuid RETURNING unit_id::text AS unit_id',
          ...params,
        );
      })) as Array<{ unit_id: string }>;
      if (rows.length === 0) throw new NotFoundException('Resource not found');
      unitId = rows[0]!.unit_id;
    } else {
      const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT unit_id::text AS unit_id FROM cur_resource_links WHERE id = $1::uuid LIMIT 1',
          id,
        );
      })) as Array<{ unit_id: string }>;
      if (rows.length === 0) throw new NotFoundException('Resource not found');
      unitId = rows[0]!.unit_id;
    }
    const list = await this.listForUnit(unitId, actor);
    const found = list.find((r) => r.id === id);
    if (!found) throw new NotFoundException('Resource not found after update');
    return found;
  }

  async remove(id: string, actor: ResolvedActor): Promise<void> {
    await assertCurriculumWriter(actor, this.permCheck);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe('DELETE FROM cur_resource_links WHERE id = $1::uuid', id);
    });
  }
}
