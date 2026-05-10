import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  CloneRubricDto,
  CreateRubricDto,
  CreateRubricScoreDto,
  RubricCriterionInputDto,
  RubricCriterionResponseDto,
  RubricResponseDto,
  RubricScoreResponseDto,
  UpdateRubricDto,
} from './dto/rubric.dto';

interface RubricRow {
  id: string;
  school_id: string;
  created_by: string;
  created_by_name: string | null;
  title: string;
  description: string | null;
  is_template: boolean;
  total_points: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface CriterionRow {
  id: string;
  rubric_id: string;
  criterion_name: string;
  description: string | null;
  weight: string;
  max_points: string;
  sort_order: number;
  performance_levels: unknown;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ScoreRow {
  id: string;
  submission_id: string;
  criterion_id: string;
  criterion_name: string;
  scored_by: string;
  scored_by_name: string | null;
  points_awarded: string;
  performance_level: string | null;
  feedback: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function toIso(v: Date | string | null): string {
  if (v === null) return '';
  return typeof v === 'string' ? v : v.toISOString();
}

function rubricRowToDto(row: RubricRow, criteria: CriterionRow[]): RubricResponseDto {
  const dtos = criteria.map(criterionRowToDto);
  const weightTotal = dtos.reduce((acc, c) => acc + c.weight, 0);
  const weightWarning =
    Math.abs(weightTotal - 100) > 0.01 && dtos.length > 0
      ? 'Criteria weights sum to ' +
        weightTotal.toFixed(2) +
        ' instead of 100. Update the weights so they total 100% for accurate scoring.'
      : null;
  return {
    id: row.id,
    schoolId: row.school_id,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    title: row.title,
    description: row.description,
    isTemplate: row.is_template,
    totalPoints: Number(row.total_points),
    weightTotal,
    weightWarning,
    criteria: dtos,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function criterionRowToDto(row: CriterionRow): RubricCriterionResponseDto {
  return {
    id: row.id,
    rubricId: row.rubric_id,
    criterionName: row.criterion_name,
    description: row.description,
    weight: Number(row.weight),
    maxPoints: Number(row.max_points),
    sortOrder: row.sort_order,
    performanceLevels: Array.isArray(row.performance_levels)
      ? (row.performance_levels as Array<Record<string, unknown>>)
      : [],
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function scoreRowToDto(row: ScoreRow): RubricScoreResponseDto {
  return {
    id: row.id,
    submissionId: row.submission_id,
    criterionId: row.criterion_id,
    criterionName: row.criterion_name,
    scoredBy: row.scored_by,
    scoredByName: row.scored_by_name,
    pointsAwarded: Number(row.points_awarded),
    performanceLevel: row.performance_level,
    feedback: row.feedback,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

const SELECT_RUBRIC_BASE =
  'SELECT r.id, r.school_id, r.created_by, ' +
  "(ip.first_name || ' ' || ip.last_name) AS created_by_name, " +
  'r.title, r.description, r.is_template, r.total_points, r.created_at, r.updated_at ' +
  'FROM cls_rubrics r ' +
  'LEFT JOIN hr_employees he ON he.id = r.created_by ' +
  'LEFT JOIN platform.iam_person ip ON ip.id = he.person_id ';

const SELECT_CRITERIA_BASE =
  'SELECT id, rubric_id, criterion_name, description, weight, max_points, sort_order, ' +
  'performance_levels, created_at, updated_at FROM cls_rubric_criteria ';

const SELECT_SCORE_BASE =
  'SELECT s.id, s.submission_id, s.criterion_id, c.criterion_name, ' +
  's.scored_by, ' +
  "(ip.first_name || ' ' || ip.last_name) AS scored_by_name, " +
  's.points_awarded, s.performance_level, s.feedback, s.created_at, s.updated_at ' +
  'FROM cls_rubric_scores s ' +
  'JOIN cls_rubric_criteria c ON c.id = s.criterion_id ' +
  'LEFT JOIN platform.iam_person ip ON ip.id = s.scored_by ';

@Injectable()
export class RubricService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private requireEmployee(actor: ResolvedActor): string {
    if (!actor.employeeId) {
      throw new ForbiddenException(
        'Only employees can author or score rubrics. The calling user has no hr_employees record.',
      );
    }
    return actor.employeeId;
  }

  private async loadCriteriaForRubrics(rubricIds: string[]): Promise<Map<string, CriterionRow[]>> {
    if (rubricIds.length === 0) return new Map();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = await client.$queryRawUnsafe<CriterionRow[]>(
        SELECT_CRITERIA_BASE + ' WHERE rubric_id = ANY($1::uuid[]) ORDER BY rubric_id, sort_order',
        rubricIds,
      );
      const map = new Map<string, CriterionRow[]>();
      for (const r of rows) {
        const arr = map.get(r.rubric_id) ?? [];
        arr.push(r);
        map.set(r.rubric_id, arr);
      }
      return map;
    });
  }

  /** GET /classroom/rubrics?templates=true|all */
  async list(actor: ResolvedActor, scope?: string): Promise<RubricResponseDto[]> {
    const tenant = getCurrentTenant();
    const params: unknown[] = [tenant.schoolId];
    let where = ' WHERE r.school_id = $1::uuid';
    if (scope === 'templates') {
      where += ' AND r.is_template = true';
    } else if (scope === 'mine' && actor.employeeId) {
      where += ' AND r.created_by = $2::uuid';
      params.push(actor.employeeId);
    }
    const rubrics = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<RubricRow[]>(
        SELECT_RUBRIC_BASE + where + ' ORDER BY r.created_at DESC',
        ...params,
      );
    });
    const criteriaMap = await this.loadCriteriaForRubrics(rubrics.map((r) => r.id));
    return rubrics.map((r) => rubricRowToDto(r, criteriaMap.get(r.id) ?? []));
  }

  /** GET /classroom/rubrics/:id */
  async getById(id: string): Promise<RubricResponseDto> {
    const rubrics = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<RubricRow[]>(SELECT_RUBRIC_BASE + ' WHERE r.id = $1::uuid', id);
    });
    if (rubrics.length === 0) throw new NotFoundException('Rubric ' + id + ' not found');
    const criteriaMap = await this.loadCriteriaForRubrics([id]);
    return rubricRowToDto(rubrics[0]!, criteriaMap.get(id) ?? []);
  }

  /** POST /classroom/rubrics */
  async create(input: CreateRubricDto, actor: ResolvedActor): Promise<RubricResponseDto> {
    const employeeId = this.requireEmployee(actor);
    const tenant = getCurrentTenant();
    const rubricId = generateId();
    const totalPoints = input.criteria.reduce(
      (acc, c) => acc + (Number.isFinite(c.maxPoints) ? c.maxPoints : 0),
      0,
    );
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO cls_rubrics (id, school_id, created_by, title, description, is_template, total_points) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::numeric)',
        rubricId,
        tenant.schoolId,
        employeeId,
        input.title,
        input.description ?? null,
        input.isTemplate ?? false,
        totalPoints,
      );
      for (const c of input.criteria) {
        await this.insertCriterion(tx, rubricId, c);
      }
    });
    return this.getById(rubricId);
  }

  /** PATCH /classroom/rubrics/:id */
  async update(
    id: string,
    input: UpdateRubricDto,
    actor: ResolvedActor,
  ): Promise<RubricResponseDto> {
    this.requireEmployee(actor);
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<{ id: string; created_by: string }>>(
        'SELECT id::text AS id, created_by::text AS created_by FROM cls_rubrics WHERE id = $1::uuid FOR UPDATE',
        id,
      );
      if (rows.length === 0) throw new NotFoundException('Rubric ' + id + ' not found');
      if (!actor.isSchoolAdmin && rows[0]!.created_by !== actor.employeeId) {
        throw new ForbiddenException('Only the rubric creator or an admin can update it.');
      }
      const sets: string[] = [];
      const params: unknown[] = [];
      let i = 1;
      if (input.title !== undefined) {
        sets.push('title = $' + i++);
        params.push(input.title);
      }
      if (input.description !== undefined) {
        sets.push('description = $' + i++);
        params.push(input.description);
      }
      if (input.isTemplate !== undefined) {
        sets.push('is_template = $' + i++);
        params.push(input.isTemplate);
      }
      if (input.criteria !== undefined) {
        const totalPoints = input.criteria.reduce(
          (acc, c) => acc + (Number.isFinite(c.maxPoints) ? c.maxPoints : 0),
          0,
        );
        sets.push('total_points = $' + i++ + '::numeric');
        params.push(totalPoints);
      }
      if (sets.length > 0) {
        sets.push('updated_at = now()');
        params.push(id);
        await tx.$executeRawUnsafe(
          'UPDATE cls_rubrics SET ' + sets.join(', ') + ' WHERE id = $' + i + '::uuid',
          ...params,
        );
      }
      if (input.criteria !== undefined) {
        await tx.$executeRawUnsafe(
          'DELETE FROM cls_rubric_criteria WHERE rubric_id = $1::uuid',
          id,
        );
        for (const c of input.criteria) {
          await this.insertCriterion(tx, id, c);
        }
      }
    });
    return this.getById(id);
  }

  /** DELETE /classroom/rubrics/:id */
  async delete(id: string, actor: ResolvedActor): Promise<void> {
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<{ created_by: string }>>(
        'SELECT created_by::text AS created_by FROM cls_rubrics WHERE id = $1::uuid FOR UPDATE',
        id,
      );
      if (rows.length === 0) throw new NotFoundException('Rubric ' + id + ' not found');
      if (!actor.isSchoolAdmin && rows[0]!.created_by !== actor.employeeId) {
        throw new ForbiddenException('Only the rubric creator or an admin can delete it.');
      }
      // Refuse if any rubric scores reference any of this rubric's criteria
      const refs = await tx.$queryRawUnsafe<Array<{ count: number }>>(
        'SELECT count(*)::int AS count FROM cls_rubric_scores s ' +
          'JOIN cls_rubric_criteria c ON c.id = s.criterion_id WHERE c.rubric_id = $1::uuid',
        id,
      );
      if (refs[0]!.count > 0) {
        throw new BadRequestException(
          'Cannot delete rubric — ' + refs[0]!.count + ' rubric score(s) reference its criteria.',
        );
      }
      await tx.$executeRawUnsafe('DELETE FROM cls_rubrics WHERE id = $1::uuid', id);
    });
  }

  /** POST /classroom/rubrics/:id/clone */
  async clone(id: string, input: CloneRubricDto, actor: ResolvedActor): Promise<RubricResponseDto> {
    const employeeId = this.requireEmployee(actor);
    const tenant = getCurrentTenant();
    const source = await this.getById(id);
    const newId = generateId();
    const newTitle = input.title ?? source.title + ' (copy)';
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO cls_rubrics (id, school_id, created_by, title, description, is_template, total_points) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, false, $6::numeric)',
        newId,
        tenant.schoolId,
        employeeId,
        newTitle,
        source.description,
        source.totalPoints,
      );
      for (const c of source.criteria) {
        await tx.$executeRawUnsafe(
          'INSERT INTO cls_rubric_criteria (id, rubric_id, criterion_name, description, weight, max_points, sort_order, performance_levels) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5::numeric, $6::numeric, $7::int, $8::jsonb)',
          generateId(),
          newId,
          c.criterionName,
          c.description,
          c.weight,
          c.maxPoints,
          c.sortOrder,
          JSON.stringify(c.performanceLevels),
        );
      }
    });
    return this.getById(newId);
  }

  /** POST /classroom/rubric-scores */
  async upsertScore(
    input: CreateRubricScoreDto,
    actor: ResolvedActor,
  ): Promise<RubricScoreResponseDto> {
    const employeeId = this.requireEmployee(actor);
    // Validate criterion + max_points
    const criterion = await this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = await client.$queryRawUnsafe<Array<{ id: string; max_points: string }>>(
        'SELECT id::text AS id, max_points FROM cls_rubric_criteria WHERE id = $1::uuid',
        input.criterionId,
      );
      return rows[0];
    });
    if (!criterion) throw new NotFoundException('Criterion ' + input.criterionId + ' not found');
    if (input.pointsAwarded > Number(criterion.max_points)) {
      throw new BadRequestException(
        'pointsAwarded exceeds the criterion max_points (' + criterion.max_points + ').',
      );
    }
    // Validate submission exists
    const subExists = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM cls_submissions WHERE id = $1::uuid',
        input.submissionId,
      );
    });
    if (subExists.length === 0) {
      throw new NotFoundException('Submission ' + input.submissionId + ' not found');
    }

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO cls_rubric_scores (id, submission_id, criterion_id, scored_by, points_awarded, performance_level, feedback) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::numeric, $6, $7) ' +
          'ON CONFLICT (submission_id, criterion_id, scored_by) DO UPDATE SET ' +
          'points_awarded = EXCLUDED.points_awarded, ' +
          'performance_level = EXCLUDED.performance_level, ' +
          'feedback = EXCLUDED.feedback, ' +
          'updated_at = now()',
        generateId(),
        input.submissionId,
        input.criterionId,
        employeeId,
        input.pointsAwarded,
        input.performanceLevel ?? null,
        input.feedback ?? null,
      );
    });

    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ScoreRow[]>(
        SELECT_SCORE_BASE +
          ' WHERE s.submission_id = $1::uuid AND s.criterion_id = $2::uuid AND s.scored_by = $3::uuid',
        input.submissionId,
        input.criterionId,
        employeeId,
      );
    });
    return scoreRowToDto(rows[0]!);
  }

  /** GET /classroom/submissions/:id/rubric-scores */
  async listScoresForSubmission(submissionId: string): Promise<RubricScoreResponseDto[]> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ScoreRow[]>(
        SELECT_SCORE_BASE + ' WHERE s.submission_id = $1::uuid ORDER BY c.sort_order',
        submissionId,
      );
    });
    return rows.map(scoreRowToDto);
  }

  private async insertCriterion(
    tx: PrismaClient,
    rubricId: string,
    c: RubricCriterionInputDto,
  ): Promise<void> {
    await tx.$executeRawUnsafe(
      'INSERT INTO cls_rubric_criteria (id, rubric_id, criterion_name, description, weight, max_points, sort_order, performance_levels) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4, $5::numeric, $6::numeric, $7::int, $8::jsonb)',
      c.id ?? generateId(),
      rubricId,
      c.criterionName,
      c.description ?? null,
      c.weight,
      c.maxPoints,
      c.sortOrder,
      JSON.stringify(c.performanceLevels ?? []),
    );
  }
}
