import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import {
  BroadcastSegmentDto,
  CreateBroadcastSegmentDto,
  SegmentPreviewDto,
  SegmentResolutionDto,
  SegmentType,
  UpdateBroadcastSegmentDto,
} from './dto/communications-advanced.dto';

interface SegmentRow {
  id: string;
  school_id: string;
  name: string;
  description: string | null;
  segment_type: SegmentType;
  filter_criteria: unknown;
  estimated_recipients: number | null;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function rowToDto(row: SegmentRow): BroadcastSegmentDto {
  const fc =
    typeof row.filter_criteria === 'object' && row.filter_criteria !== null
      ? (row.filter_criteria as Record<string, unknown>)
      : {};
  return {
    id: row.id,
    schoolId: row.school_id,
    name: row.name,
    description: row.description,
    segmentType: row.segment_type,
    filterCriteria: fc,
    estimatedRecipients: row.estimated_recipients,
    isActive: row.is_active,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e?.code === 'P2002') return true;
  if (e?.code === 'P2010' && e?.meta?.code === '23505') return true;
  if (typeof e?.message === 'string' && e.message.includes('23505')) return true;
  return false;
}

/**
 * BroadcastSegmentService — reusable audience definitions for the
 * messaging + push broadcast surfaces.
 *
 * Resolution contract:
 *   resolve(segmentId) — returns the set of platform_users.id values
 *   that match the segment's filter_criteria right now. Six branches:
 *     ALL_PARENTS      — every platform_user joined via sis_guardians
 *                        in this school
 *     ALL_STAFF        — every platform_user joined via hr_employees
 *                        with employment_status IN ('ACTIVE','ON_LEAVE')
 *     GRADE_LEVEL      — guardians of every active enrolled student in
 *                        the given grade (filter_criteria.grade_level)
 *     CLASS            — guardians of every enrolled student plus the
 *                        assigned teachers for each class
 *                        (filter_criteria.class_ids: UUID[])
 *     TRANSPORT_ROUTE  — guardians of every student assigned to a
 *                        listed route (filter_criteria.route_ids: UUID[]).
 *                        When the transport tables haven't been seeded
 *                        in this tenant, returns an empty set rather
 *                        than throwing.
 *     CUSTOM           — direct passthrough of filter_criteria.custom_user_ids
 *
 * Authorisation: write paths (create/patch) require school admin —
 * segments are an admin publishing surface mirroring templates.
 */
@Injectable()
export class BroadcastSegmentService {
  private readonly logger = new Logger(BroadcastSegmentService.name);

  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async list(args: { includeInactive?: boolean } = {}): Promise<BroadcastSegmentDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client: PrismaClient) => {
      const params: unknown[] = [tenant.schoolId];
      let sql =
        'SELECT id::text AS id, school_id::text AS school_id, name, description, ' +
        'segment_type, filter_criteria, estimated_recipients, is_active, ' +
        'created_by::text AS created_by, created_at::text AS created_at, ' +
        'updated_at::text AS updated_at ' +
        'FROM msg_broadcast_segments WHERE school_id = $1::uuid';
      if (!args.includeInactive) sql += ' AND is_active = true';
      sql += ' ORDER BY name ASC';
      const rows = await client.$queryRawUnsafe<SegmentRow[]>(sql, ...params);
      return rows.map(rowToDto);
    });
  }

  async getById(id: string): Promise<BroadcastSegmentDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client: PrismaClient) => {
      const rows = await client.$queryRawUnsafe<SegmentRow[]>(
        'SELECT id::text AS id, school_id::text AS school_id, name, description, ' +
          'segment_type, filter_criteria, estimated_recipients, is_active, ' +
          'created_by::text AS created_by, created_at::text AS created_at, ' +
          'updated_at::text AS updated_at ' +
          'FROM msg_broadcast_segments WHERE school_id = $1::uuid AND id = $2::uuid LIMIT 1',
        tenant.schoolId,
        id,
      );
      if (rows.length === 0) throw new NotFoundException('Segment not found');
      return rowToDto(rows[0]!);
    });
  }

  async create(
    input: CreateBroadcastSegmentDto,
    actor: ResolvedActor,
  ): Promise<BroadcastSegmentDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only school admins can create broadcast segments.');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    return this.tenantPrisma.executeInTenantTransaction(async (tx: PrismaClient) => {
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO msg_broadcast_segments ' +
            '(id, school_id, name, description, segment_type, filter_criteria, is_active, created_by) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7, $8::uuid)',
          id,
          tenant.schoolId,
          input.name,
          input.description ?? null,
          input.segmentType,
          JSON.stringify(input.filterCriteria ?? {}),
          input.isActive ?? true,
          actor.accountId,
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException(
            'A broadcast segment named "' + input.name + '" already exists in this school.',
          );
        }
        throw err;
      }
      // REVIEW-P2C19 MAJOR 3: reload carries school_id predicate as
      // belt-and-braces alongside the INSERT's tenant scoping.
      const rows = await tx.$queryRawUnsafe<SegmentRow[]>(
        'SELECT id::text AS id, school_id::text AS school_id, name, description, ' +
          'segment_type, filter_criteria, estimated_recipients, is_active, ' +
          'created_by::text AS created_by, created_at::text AS created_at, ' +
          'updated_at::text AS updated_at ' +
          'FROM msg_broadcast_segments WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      );
      return rowToDto(rows[0]!);
    });
  }

  async patch(
    id: string,
    input: UpdateBroadcastSegmentDto,
    actor: ResolvedActor,
  ): Promise<BroadcastSegmentDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only school admins can edit broadcast segments.');
    }
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (tx: PrismaClient) => {
      const lock = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id::text AS id FROM msg_broadcast_segments ' +
          'WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        id,
      );
      if (lock.length === 0) throw new NotFoundException('Segment not found');

      const sets: string[] = [];
      const params: unknown[] = [];
      function set(col: string, val: unknown, cast?: string): void {
        params.push(val);
        sets.push(col + ' = $' + params.length + (cast ? '::' + cast : ''));
      }
      if (input.name !== undefined) set('name', input.name);
      if (input.description !== undefined) set('description', input.description);
      if (input.segmentType !== undefined) set('segment_type', input.segmentType);
      if (input.filterCriteria !== undefined) {
        set('filter_criteria', JSON.stringify(input.filterCriteria), 'jsonb');
      }
      if (input.isActive !== undefined) set('is_active', input.isActive);
      sets.push('updated_at = now()');

      // REVIEW-P2C19 MAJOR 3: UPDATE carries school_id predicate too.
      params.push(id);
      params.push(tenant.schoolId);
      try {
        await tx.$executeRawUnsafe(
          'UPDATE msg_broadcast_segments SET ' +
            sets.join(', ') +
            ' WHERE id = $' +
            (params.length - 1) +
            '::uuid AND school_id = $' +
            params.length +
            '::uuid',
          ...params,
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException(
            'A broadcast segment named "' +
              (input.name ?? '<unchanged>') +
              '" already exists in this school.',
          );
        }
        throw err;
      }

      const rows = await tx.$queryRawUnsafe<SegmentRow[]>(
        'SELECT id::text AS id, school_id::text AS school_id, name, description, ' +
          'segment_type, filter_criteria, estimated_recipients, is_active, ' +
          'created_by::text AS created_by, created_at::text AS created_at, ' +
          'updated_at::text AS updated_at ' +
          'FROM msg_broadcast_segments WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      );
      return rowToDto(rows[0]!);
    });
  }

  /**
   * Resolve a segment to a concrete recipient set. The result is also
   * cached back onto the segment row as estimated_recipients so the
   * preview endpoint can read it without re-resolving.
   *
   * Recipients are platform_users.id values. The caller (broadcast
   * send path) is responsible for de-duplicating across multiple
   * resolved segments and pushing notifications.
   */
  async resolve(id: string): Promise<SegmentResolutionDto> {
    const segment = await this.getById(id);
    const tenant = getCurrentTenant();
    const accountIds = await this.tenantPrisma.executeInTenantContext(
      async (client: PrismaClient) => {
        return this.resolveAccountIds(client, segment, tenant.schoolId);
      },
    );
    // Cache the count on the segment row for the preview path.
    // REVIEW-P2C19 MAJOR 3: cache-update carries school_id predicate.
    const total = accountIds.length;
    await this.tenantPrisma.executeInTenantContext(async (client: PrismaClient) => {
      await client.$executeRawUnsafe(
        'UPDATE msg_broadcast_segments SET estimated_recipients = $2, updated_at = now() ' +
          'WHERE id = $1::uuid AND school_id = $3::uuid',
        id,
        total,
        tenant.schoolId,
      );
    });
    return {
      segmentId: segment.id,
      segmentType: segment.segmentType,
      accountIds,
      totalRecipients: total,
    };
  }

  async preview(id: string): Promise<SegmentPreviewDto> {
    const segment = await this.getById(id);
    if (segment.estimatedRecipients !== null) {
      return {
        segmentId: segment.id,
        segmentType: segment.segmentType,
        estimatedRecipients: segment.estimatedRecipients,
      };
    }
    // No cached count yet — resolve once to populate it.
    const resolution = await this.resolve(id);
    return {
      segmentId: segment.id,
      segmentType: segment.segmentType,
      estimatedRecipients: resolution.totalRecipients,
    };
  }

  private async resolveAccountIds(
    client: PrismaClient,
    segment: BroadcastSegmentDto,
    schoolId: string,
  ): Promise<string[]> {
    const fc = segment.filterCriteria ?? {};
    switch (segment.segmentType) {
      case 'ALL_PARENTS': {
        const rows = await client.$queryRawUnsafe<Array<{ account_id: string }>>(
          'SELECT DISTINCT pu.id::text AS account_id ' +
            'FROM sis_guardians g ' +
            'JOIN platform.platform_users pu ON pu.person_id = g.person_id ' +
            'WHERE g.school_id = $1::uuid',
          schoolId,
        );
        return rows.map((r) => r.account_id);
      }
      case 'ALL_STAFF': {
        const rows = await client.$queryRawUnsafe<Array<{ account_id: string }>>(
          'SELECT DISTINCT pu.id::text AS account_id ' +
            'FROM hr_employees e ' +
            'JOIN platform.platform_users pu ON pu.person_id = e.person_id ' +
            "WHERE e.school_id = $1::uuid AND e.employment_status IN ('ACTIVE','ON_LEAVE')",
          schoolId,
        );
        return rows.map((r) => r.account_id);
      }
      case 'GRADE_LEVEL': {
        const grade = typeof fc.grade_level === 'string' ? fc.grade_level : null;
        if (!grade) {
          throw new BadRequestException('GRADE_LEVEL segment requires filter_criteria.grade_level');
        }
        const rows = await client.$queryRawUnsafe<Array<{ account_id: string }>>(
          'SELECT DISTINCT pu.id::text AS account_id ' +
            'FROM sis_students s ' +
            'JOIN sis_student_guardians sg ON sg.student_id = s.id ' +
            'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
            'JOIN platform.platform_users pu ON pu.person_id = g.person_id ' +
            'WHERE s.school_id = $1::uuid AND s.grade_level = $2',
          schoolId,
          grade,
        );
        return rows.map((r) => r.account_id);
      }
      case 'CLASS': {
        const classIds = Array.isArray(fc.class_ids)
          ? (fc.class_ids as unknown[]).filter((v) => typeof v === 'string')
          : [];
        if (classIds.length === 0) {
          throw new BadRequestException(
            'CLASS segment requires filter_criteria.class_ids (UUID[])',
          );
        }
        const rows = await client.$queryRawUnsafe<Array<{ account_id: string }>>(
          'SELECT DISTINCT pu.id::text AS account_id FROM ( ' +
            // guardians of every enrolled student in the listed classes
            'SELECT g.person_id FROM sis_enrollments en ' +
            'JOIN sis_students s ON s.id = en.student_id ' +
            'JOIN sis_student_guardians sg ON sg.student_id = s.id ' +
            'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
            "WHERE en.class_id = ANY($2::uuid[]) AND en.status = 'ACTIVE' AND s.school_id = $1::uuid " +
            'UNION ' +
            // teachers assigned to the listed classes
            'SELECT e.person_id FROM sis_class_teachers ct ' +
            'JOIN hr_employees e ON e.id = ct.teacher_employee_id ' +
            'WHERE ct.class_id = ANY($2::uuid[]) AND e.school_id = $1::uuid ' +
            ') sub ' +
            'JOIN platform.platform_users pu ON pu.person_id = sub.person_id',
          schoolId,
          classIds as string[],
        );
        return rows.map((r) => r.account_id);
      }
      case 'TRANSPORT_ROUTE': {
        const routeIds = Array.isArray(fc.route_ids)
          ? (fc.route_ids as unknown[]).filter((v) => typeof v === 'string')
          : [];
        if (routeIds.length === 0) {
          throw new BadRequestException(
            'TRANSPORT_ROUTE segment requires filter_criteria.route_ids (UUID[])',
          );
        }
        // Transport tables may not exist in this tenant. The seed
        // attaches a synthetic route id; the resolution path must
        // tolerate a missing trn_student_assignments table gracefully.
        try {
          const rows = await client.$queryRawUnsafe<Array<{ account_id: string }>>(
            'SELECT DISTINCT pu.id::text AS account_id ' +
              'FROM trn_student_assignments ta ' +
              'JOIN sis_students s ON s.id = ta.student_id ' +
              'JOIN sis_student_guardians sg ON sg.student_id = s.id ' +
              'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
              'JOIN platform.platform_users pu ON pu.person_id = g.person_id ' +
              'WHERE ta.route_id = ANY($1::uuid[]) AND s.school_id = $2::uuid',
            routeIds as string[],
            schoolId,
          );
          return rows.map((r) => r.account_id);
        } catch (err) {
          const msg = (err as { message?: string }).message ?? '';
          if (msg.includes('trn_student_assignments') || msg.includes('relation')) {
            // Tolerate missing transport schema in test/demo tenants —
            // the segment resolves to empty rather than 500.
            this.logger.warn(
              'TRANSPORT_ROUTE segment resolution skipped — transport tables not present in this tenant',
            );
            return [];
          }
          throw err;
        }
      }
      case 'CUSTOM': {
        const userIds = Array.isArray(fc.custom_user_ids)
          ? (fc.custom_user_ids as unknown[]).filter((v) => typeof v === 'string')
          : [];
        if (userIds.length === 0) {
          throw new BadRequestException(
            'CUSTOM segment requires filter_criteria.custom_user_ids (UUID[])',
          );
        }
        // REVIEW-P2C19 BLOCKING 3: every custom user id must have a
        // current-school projection in sis_students (via
        // platform_students.person_id), sis_guardians.person_id, OR
        // hr_employees.person_id. Existence in platform.platform_users
        // alone is not enough — that allows a School A admin to seed
        // School B users into a custom segment and broadcast to them.
        // The UNION of the three projections is the current-school
        // affiliation gate; bogus or cross-school ids fall out of the
        // result set silently.
        const tenant = getCurrentTenant();
        const rows = await client.$queryRawUnsafe<Array<{ account_id: string }>>(
          'SELECT DISTINCT pu.id::text AS account_id ' +
            'FROM platform.platform_users pu ' +
            'JOIN platform.iam_person ip ON ip.id = pu.person_id ' +
            'WHERE pu.id = ANY($1::uuid[]) ' +
            '  AND ( ' +
            '    EXISTS ( ' +
            '      SELECT 1 FROM sis_students s ' +
            '      JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
            '      WHERE s.school_id = $2::uuid AND ps.person_id = ip.id' +
            '    ) OR EXISTS ( ' +
            '      SELECT 1 FROM sis_guardians g WHERE g.school_id = $2::uuid AND g.person_id = ip.id' +
            '    ) OR EXISTS ( ' +
            '      SELECT 1 FROM hr_employees e WHERE e.school_id = $2::uuid AND e.person_id = ip.id' +
            '    ) ' +
            '  )',
          userIds as string[],
          tenant.schoolId,
        );
        return rows.map((r) => r.account_id);
      }
      default:
        throw new BadRequestException('Unsupported segment_type: ' + segment.segmentType);
    }
  }
}
