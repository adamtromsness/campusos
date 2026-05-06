import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { ApplicationScoreResponseDto, CreateScoreDto, UpdateScoreDto } from './dto/cycle16.dto';

interface ScoreRow {
  id: string;
  application_id: string;
  criterion_name: string;
  score: string;
  max_score: string | null;
  scored_by: string;
  scored_by_name: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_SCORE =
  'SELECT s.id::text AS id, s.application_id::text AS application_id, ' +
  's.criterion_name, s.score::text AS score, s.max_score::text AS max_score, ' +
  's.scored_by::text AS scored_by, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.platform_users pu " +
  '  JOIN platform.iam_person ip ON ip.id = pu.person_id ' +
  '  WHERE pu.id = s.scored_by) AS scored_by_name, ' +
  's.notes, ' +
  'TO_CHAR(s.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(s.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM enr_application_scores s ';

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  return (
    e?.code === '23505' ||
    e?.meta?.code === '23505' ||
    (e?.code === 'P2010' && /23505|duplicate key/i.test(e?.message ?? '')) ||
    /duplicate key value violates unique constraint/i.test(e?.message ?? '')
  );
}

function isCheckViolation(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  return (
    e?.code === '23514' ||
    e?.meta?.code === '23514' ||
    /violates check constraint/i.test(e?.message ?? '')
  );
}

function rowToDto(r: ScoreRow): ApplicationScoreResponseDto {
  return {
    id: r.id,
    applicationId: r.application_id,
    criterionName: r.criterion_name,
    score: Number(r.score),
    maxScore: r.max_score === null ? null : Number(r.max_score),
    scoredBy: r.scored_by,
    scoredByName: r.scored_by_name,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

@Injectable()
export class ApplicationScoringService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private assertEoOrAdmin(actor: ResolvedActor) {
    if (!actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      throw new ForbiddenException('Only Enrolment Officers (Staff) or admins can score');
    }
  }

  /**
   * Score reads are restricted to admin / Enrolment Officer per
   * REVIEW-CYCLE16 BLOCKING 1 + MAJOR 4 — admissions scoring rows
   * carry ranked-selection criteria + scorer notes that must not be
   * visible to guardians or students. The permission gate
   * (stu-003:read) is the same surface guardians use for their own
   * applications, so the actual access boundary is the
   * actor.personType check at the service layer.
   */
  async listForApplication(
    applicationId: string,
    actor: ResolvedActor,
  ): Promise<ApplicationScoreResponseDto[]> {
    this.assertEoOrAdmin(actor);
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_SCORE + 'WHERE s.application_id = $1::uuid ORDER BY s.criterion_name ASC',
        applicationId,
      );
    })) as ScoreRow[];
    return rows.map(rowToDto);
  }

  async create(
    applicationId: string,
    input: CreateScoreDto,
    actor: ResolvedActor,
  ): Promise<ApplicationScoreResponseDto> {
    this.assertEoOrAdmin(actor);
    if (input.maxScore !== undefined && input.score > input.maxScore) {
      throw new BadRequestException('score cannot exceed maxScore');
    }
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO enr_application_scores (id, application_id, criterion_name, score, max_score, scored_by, notes) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7)',
          id,
          applicationId,
          input.criterionName,
          input.score,
          input.maxScore ?? null,
          actor.accountId,
          input.notes ?? null,
        );
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new BadRequestException(
          'A score for criterion "' +
            input.criterionName +
            '" already exists. Use PATCH to update.',
        );
      }
      if (isCheckViolation(e)) {
        throw new BadRequestException('Score / maxScore violates a CHECK constraint');
      }
      throw e;
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_SCORE + 'WHERE s.id = $1::uuid', id);
    })) as ScoreRow[];
    return rowToDto(rows[0]!);
  }

  async patch(
    id: string,
    input: UpdateScoreDto,
    actor: ResolvedActor,
  ): Promise<ApplicationScoreResponseDto> {
    this.assertEoOrAdmin(actor);
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.score !== undefined) {
      params.push(input.score);
      sets.push('score = $' + params.length);
    }
    if (input.maxScore !== undefined) {
      params.push(input.maxScore);
      sets.push('max_score = $' + params.length);
    }
    if (input.notes !== undefined) {
      params.push(input.notes);
      sets.push('notes = $' + params.length);
    }
    if (sets.length === 0) {
      const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(SELECT_SCORE + 'WHERE s.id = $1::uuid', id);
      })) as ScoreRow[];
      if (rows.length === 0) throw new NotFoundException('Score not found');
      return rowToDto(rows[0]!);
    }
    sets.push('scored_by = $' + (params.length + 1) + '::uuid');
    params.push(actor.accountId);
    sets.push('updated_at = now()');
    params.push(id);
    try {
      const updated = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$executeRawUnsafe(
          'UPDATE enr_application_scores SET ' +
            sets.join(', ') +
            ' WHERE id = $' +
            params.length +
            '::uuid',
          ...params,
        );
      });
      if (updated === 0) throw new NotFoundException('Score not found');
    } catch (e) {
      if (isCheckViolation(e)) {
        throw new BadRequestException('Score / maxScore violates a CHECK constraint');
      }
      throw e;
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_SCORE + 'WHERE s.id = $1::uuid', id);
    })) as ScoreRow[];
    return rowToDto(rows[0]!);
  }

  async remove(id: string, actor: ResolvedActor): Promise<void> {
    this.assertEoOrAdmin(actor);
    const removed = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$executeRawUnsafe('DELETE FROM enr_application_scores WHERE id = $1::uuid', id);
    });
    if (removed === 0) throw new NotFoundException('Score not found');
  }
}
