import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  isUniqueViolation,
  resolveStudentIdForActor,
  isAssignedTeacherOf,
  isLinkedGuardianOf,
} from './portfolio-access';
import type {
  CreateReflectionDto,
  ReflectionDto,
  UpdateReflectionDto,
} from './dto/portfolio-advanced.dto';

interface ReflectionRow {
  id: string;
  portfolio_item_id: string;
  student_id: string;
  prompt: string | null;
  reflection_text: string;
  written_at: string;
  updated_at: string;
}

const SELECT_REFLECTION_BASE = `
  SELECT
    r.id::text AS id,
    r.portfolio_item_id::text AS portfolio_item_id,
    r.student_id::text AS student_id,
    r.prompt,
    r.reflection_text,
    r.written_at::text AS written_at,
    r.updated_at::text AS updated_at
  FROM pfl_reflections r
`;

@Injectable()
export class ReflectionService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private rowToDto(r: ReflectionRow): ReflectionDto {
    return {
      id: r.id,
      portfolioItemId: r.portfolio_item_id,
      studentId: r.student_id,
      prompt: r.prompt,
      reflectionText: r.reflection_text,
      writtenAt: r.written_at,
      updatedAt: r.updated_at,
    };
  }

  // Resolve the portfolio item + its parent portfolio for ownership / visibility
  // routing. Returns the parent portfolio student_id and visibility.
  private async loadItemContext(
    itemId: string,
  ): Promise<{ studentId: string; visibility: string } | null> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT p.student_id::text AS student_id, p.visibility::text AS visibility
         FROM pfl_portfolio_items i
         JOIN pfl_portfolios p ON p.id = i.portfolio_id
         WHERE i.id = $1::uuid AND p.school_id = $2::uuid
         LIMIT 1`,
        itemId,
        tenant.schoolId,
      );
    })) as Array<{ student_id: string; visibility: string }>;
    if (rows.length === 0) return null;
    return { studentId: rows[0]!.student_id, visibility: rows[0]!.visibility };
  }

  // Reflections inherit the parent portfolio visibility lattice — the
  // STUDENT-OWNED contract gates writes (only the student authoring),
  // reads follow the parent.
  private async canReadReflectionsFor(
    actor: ResolvedActor,
    studentId: string,
    visibility: string,
  ): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const ownerStudentId = await resolveStudentIdForActor(this.tenantPrisma, actor);
    if (ownerStudentId === studentId) return true;
    if (visibility === 'PRIVATE') return false;
    if (visibility === 'PUBLIC') return true;
    if (visibility === 'TEACHER') {
      return isAssignedTeacherOf(this.tenantPrisma, actor, studentId);
    }
    if (visibility === 'PARENT') {
      if (await isAssignedTeacherOf(this.tenantPrisma, actor, studentId)) return true;
      return isLinkedGuardianOf(this.tenantPrisma, actor, studentId);
    }
    return false;
  }

  async listForItem(itemId: string, actor: ResolvedActor): Promise<ReflectionDto[]> {
    const ctx = await this.loadItemContext(itemId);
    if (!ctx) throw new NotFoundException('Portfolio item not found');
    if (!(await this.canReadReflectionsFor(actor, ctx.studentId, ctx.visibility))) {
      throw new NotFoundException('Portfolio item not found');
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_REFLECTION_BASE + ' WHERE r.portfolio_item_id = $1::uuid ORDER BY r.written_at DESC',
        itemId,
      );
    })) as ReflectionRow[];
    return rows.map((r) => this.rowToDto(r));
  }

  async create(
    itemId: string,
    actor: ResolvedActor,
    input: CreateReflectionDto,
  ): Promise<ReflectionDto> {
    if (actor.personType !== 'STUDENT' && !actor.isSchoolAdmin) {
      // STUDENT-OWNED — even teachers cannot write a student's reflection.
      // Admin override allowed (e.g. recovering from a data-loss event).
      throw new ForbiddenException(
        'Only the owning student or a school admin can write reflections. Reflections are student-owned per the P2-27 contract.',
      );
    }
    const ctx = await this.loadItemContext(itemId);
    if (!ctx) throw new NotFoundException('Portfolio item not found');

    if (actor.personType === 'STUDENT') {
      const ownerStudentId = await resolveStudentIdForActor(this.tenantPrisma, actor);
      if (ownerStudentId !== ctx.studentId) {
        // Don't-leak-existence: a student trying to write on another
        // student's portfolio item gets a 404, not a 403.
        throw new NotFoundException('Portfolio item not found');
      }
    }

    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO pfl_reflections (id, portfolio_item_id, student_id, prompt, reflection_text) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)',
          id,
          itemId,
          ctx.studentId,
          input.prompt ?? null,
          input.reflectionText,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          'A reflection already exists for this portfolio item. Use PATCH to update.',
        );
      }
      throw err;
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_REFLECTION_BASE + ' WHERE r.id = $1::uuid', id);
    })) as ReflectionRow[];
    return this.rowToDto(rows[0]!);
  }

  async patch(
    reflectionId: string,
    actor: ResolvedActor,
    input: UpdateReflectionDto,
  ): Promise<ReflectionDto> {
    return this.tenantPrisma.executeInTenantTransaction(async (client) => {
      const tenant = getCurrentTenant();
      const rows = (await client.$queryRawUnsafe(
        `SELECT r.id::text AS id, r.student_id::text AS student_id, p.school_id::text AS school_id
         FROM pfl_reflections r
         JOIN pfl_portfolio_items i ON i.id = r.portfolio_item_id
         JOIN pfl_portfolios p ON p.id = i.portfolio_id
         WHERE r.id = $1::uuid
         FOR UPDATE OF r`,
        reflectionId,
      )) as Array<{ id: string; student_id: string; school_id: string }>;
      if (rows.length === 0) throw new NotFoundException('Reflection not found');
      if (rows[0]!.school_id !== tenant.schoolId) {
        throw new NotFoundException('Reflection not found');
      }
      // STUDENT-OWNED — only the writing student can edit. Admin override
      // allowed but teachers/parents are explicitly refused even if they
      // can read.
      const ownerStudentId = await resolveStudentIdForActor(this.tenantPrisma, actor);
      if (!actor.isSchoolAdmin && ownerStudentId !== rows[0]!.student_id) {
        throw new ForbiddenException(
          'Only the owning student or a school admin can edit this reflection.',
        );
      }
      const sets: string[] = [];
      const params: unknown[] = [];
      const push = (col: string, value: unknown) => {
        params.push(value);
        sets.push(`${col} = $${params.length}`);
      };
      if (input.prompt !== undefined) push('prompt', input.prompt);
      push('reflection_text', input.reflectionText);
      sets.push('updated_at = now()');
      params.push(reflectionId);
      await client.$executeRawUnsafe(
        `UPDATE pfl_reflections SET ${sets.join(', ')} WHERE id = $${params.length}::uuid`,
        ...params,
      );
      const after = (await client.$queryRawUnsafe(
        SELECT_REFLECTION_BASE + ' WHERE r.id = $1::uuid',
        reflectionId,
      )) as ReflectionRow[];
      return this.rowToDto(after[0]!);
    });
  }
}
