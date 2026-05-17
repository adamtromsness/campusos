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
import { isUniqueViolation, isOwningStudent } from './portfolio-access';
import type {
  AssignItemToSectionDto,
  CreateSectionDto,
  PortfolioSectionDto,
  UpdateSectionDto,
} from './dto/portfolio-advanced.dto';

interface SectionRow {
  id: string;
  portfolio_id: string;
  title: string;
  description: string | null;
  sort_order: number;
  cover_image_s3_key: string | null;
  item_count: number;
  created_at: string;
  updated_at: string;
}

// REVIEW-P2C27 BLOCKING 5 — section reads JOIN through pfl_portfolios so
// the school predicate is bound on every list / get / reload.
const SELECT_SECTION_BASE = `
  SELECT
    s.id::text AS id,
    s.portfolio_id::text AS portfolio_id,
    s.title,
    s.description,
    s.sort_order,
    s.cover_image_s3_key,
    s.created_at::text AS created_at,
    s.updated_at::text AS updated_at,
    (SELECT COUNT(*)::int FROM pfl_portfolio_items i WHERE i.section_id = s.id) AS item_count
  FROM pfl_portfolio_sections s
  JOIN pfl_portfolios p ON p.id = s.portfolio_id
`;

@Injectable()
export class PortfolioSectionService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private rowToDto(r: SectionRow): PortfolioSectionDto {
    return {
      id: r.id,
      portfolioId: r.portfolio_id,
      title: r.title,
      description: r.description,
      sortOrder: r.sort_order,
      coverImageS3Key: r.cover_image_s3_key,
      itemCount: Number(r.item_count),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  // Resolve the parent portfolio + scope-check that the actor can edit it.
  // Sections are STUDENT-OWNED — only the owning student or a school admin
  // can mutate.
  private async assertPortfolioOwnedByActor(
    portfolioId: string,
    actor: ResolvedActor,
  ): Promise<void> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT student_id::text AS student_id FROM pfl_portfolios WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        portfolioId,
        tenant.schoolId,
      );
    })) as Array<{ student_id: string }>;
    if (rows.length === 0) {
      throw new NotFoundException('Portfolio not found');
    }
    if (!(await isOwningStudent(this.tenantPrisma, actor, rows[0]!.student_id))) {
      throw new ForbiddenException(
        'Only the owning student or a school admin can manage portfolio sections.',
      );
    }
  }

  async listForPortfolio(portfolioId: string): Promise<PortfolioSectionDto[]> {
    const tenant = getCurrentTenant();
    const found = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT 1 FROM pfl_portfolios WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        portfolioId,
        tenant.schoolId,
      );
    })) as Array<unknown>;
    if (found.length === 0) {
      throw new NotFoundException('Portfolio not found');
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_SECTION_BASE +
          ' WHERE s.portfolio_id = $1::uuid AND p.school_id = $2::uuid ORDER BY s.sort_order ASC',
        portfolioId,
        tenant.schoolId,
      );
    })) as SectionRow[];
    return rows.map((r) => this.rowToDto(r));
  }

  async create(
    portfolioId: string,
    actor: ResolvedActor,
    input: CreateSectionDto,
  ): Promise<PortfolioSectionDto> {
    await this.assertPortfolioOwnedByActor(portfolioId, actor);
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (client) => {
      const maxRows = (await client.$queryRawUnsafe(
        `SELECT COALESCE(MAX(s.sort_order), 0) AS max_order
         FROM pfl_portfolio_sections s
         JOIN pfl_portfolios p ON p.id = s.portfolio_id
         WHERE s.portfolio_id = $1::uuid AND p.school_id = $2::uuid`,
        portfolioId,
        tenant.schoolId,
      )) as Array<{ max_order: number }>;
      const nextOrder = Number(maxRows[0]?.max_order ?? 0) + 1;
      const id = generateId();
      try {
        await client.$executeRawUnsafe(
          'INSERT INTO pfl_portfolio_sections (id, portfolio_id, title, description, sort_order, cover_image_s3_key) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)',
          id,
          portfolioId,
          input.title,
          input.description ?? null,
          nextOrder,
          input.coverImageS3Key ?? null,
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException(
            'A section already exists at this position. Try again — the next slot is being recomputed.',
          );
        }
        throw err;
      }
      const rows = (await client.$queryRawUnsafe(
        SELECT_SECTION_BASE + ' WHERE s.id = $1::uuid AND p.school_id = $2::uuid',
        id,
        tenant.schoolId,
      )) as SectionRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  async patch(
    sectionId: string,
    actor: ResolvedActor,
    input: UpdateSectionDto,
  ): Promise<PortfolioSectionDto> {
    return this.tenantPrisma.executeInTenantTransaction(async (client) => {
      const tenant = getCurrentTenant();
      const rows = (await client.$queryRawUnsafe(
        `SELECT s.id::text AS id, s.portfolio_id::text AS portfolio_id, p.student_id::text AS student_id, p.school_id::text AS school_id
         FROM pfl_portfolio_sections s
         JOIN pfl_portfolios p ON p.id = s.portfolio_id
         WHERE s.id = $1::uuid AND p.school_id = $2::uuid
         FOR UPDATE OF s`,
        sectionId,
        tenant.schoolId,
      )) as Array<{ id: string; portfolio_id: string; student_id: string; school_id: string }>;
      if (rows.length === 0) throw new NotFoundException('Section not found');
      if (!(await isOwningStudent(this.tenantPrisma, actor, rows[0]!.student_id))) {
        throw new ForbiddenException(
          'Only the owning student or a school admin can manage portfolio sections.',
        );
      }

      const sets: string[] = [];
      const params: unknown[] = [];
      const push = (col: string, value: unknown) => {
        params.push(value);
        sets.push(`${col} = $${params.length}`);
      };
      if (input.title !== undefined) push('title', input.title);
      if (input.description !== undefined) push('description', input.description);
      if (input.coverImageS3Key !== undefined) push('cover_image_s3_key', input.coverImageS3Key);
      if (input.sortOrder !== undefined) {
        if (input.sortOrder < 1) {
          throw new BadRequestException('sortOrder must be >= 1.');
        }
        const conflictRows = (await client.$queryRawUnsafe(
          `SELECT s.id::text AS id, s.sort_order
           FROM pfl_portfolio_sections s
           JOIN pfl_portfolios p ON p.id = s.portfolio_id
           WHERE s.portfolio_id = $1::uuid
             AND s.sort_order = $2
             AND s.id <> $3::uuid
             AND p.school_id = $4::uuid
           LIMIT 1`,
          rows[0]!.portfolio_id,
          input.sortOrder,
          sectionId,
          tenant.schoolId,
        )) as Array<{ id: string; sort_order: number }>;
        if (conflictRows.length > 0) {
          const currentOrderRows = (await client.$queryRawUnsafe(
            `SELECT s.sort_order
             FROM pfl_portfolio_sections s
             JOIN pfl_portfolios p ON p.id = s.portfolio_id
             WHERE s.id = $1::uuid AND p.school_id = $2::uuid
             LIMIT 1`,
            sectionId,
            tenant.schoolId,
          )) as Array<{ sort_order: number }>;
          const currentOrder = currentOrderRows[0]!.sort_order;
          // Park the conflict section at -conflict.sort_order with a school-
          // joined UPDATE so cross-school sections cannot be touched.
          await client.$executeRawUnsafe(
            `UPDATE pfl_portfolio_sections AS upd
             SET sort_order = $1
             FROM pfl_portfolios p
             WHERE p.id = upd.portfolio_id
               AND upd.id = $2::uuid
               AND p.school_id = $3::uuid`,
            -conflictRows[0]!.sort_order,
            conflictRows[0]!.id,
            tenant.schoolId,
          );
          push('sort_order', input.sortOrder);
          sets.push('updated_at = now()');
          params.push(sectionId);
          params.push(tenant.schoolId);
          await client.$executeRawUnsafe(
            `UPDATE pfl_portfolio_sections AS upd
             SET ${sets.join(', ')}
             FROM pfl_portfolios p
             WHERE p.id = upd.portfolio_id
               AND upd.id = $${params.length - 1}::uuid
               AND p.school_id = $${params.length}::uuid`,
            ...params,
          );
          await client.$executeRawUnsafe(
            `UPDATE pfl_portfolio_sections AS upd
             SET sort_order = $1
             FROM pfl_portfolios p
             WHERE p.id = upd.portfolio_id
               AND upd.id = $2::uuid
               AND p.school_id = $3::uuid`,
            currentOrder,
            conflictRows[0]!.id,
            tenant.schoolId,
          );
          const after = (await client.$queryRawUnsafe(
            SELECT_SECTION_BASE + ' WHERE s.id = $1::uuid AND p.school_id = $2::uuid',
            sectionId,
            tenant.schoolId,
          )) as SectionRow[];
          return this.rowToDto(after[0]!);
        }
        push('sort_order', input.sortOrder);
      }
      if (sets.length === 0) {
        const cur = (await client.$queryRawUnsafe(
          SELECT_SECTION_BASE + ' WHERE s.id = $1::uuid AND p.school_id = $2::uuid',
          sectionId,
          tenant.schoolId,
        )) as SectionRow[];
        return this.rowToDto(cur[0]!);
      }
      sets.push('updated_at = now()');
      params.push(sectionId);
      params.push(tenant.schoolId);
      try {
        await client.$executeRawUnsafe(
          `UPDATE pfl_portfolio_sections AS upd
           SET ${sets.join(', ')}
           FROM pfl_portfolios p
           WHERE p.id = upd.portfolio_id
             AND upd.id = $${params.length - 1}::uuid
             AND p.school_id = $${params.length}::uuid`,
          ...params,
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException(
            'Another section already occupies this sort_order. Use the reorder endpoint.',
          );
        }
        throw err;
      }
      const after = (await client.$queryRawUnsafe(
        SELECT_SECTION_BASE + ' WHERE s.id = $1::uuid AND p.school_id = $2::uuid',
        sectionId,
        tenant.schoolId,
      )) as SectionRow[];
      return this.rowToDto(after[0]!);
    });
  }

  async remove(sectionId: string, actor: ResolvedActor): Promise<void> {
    return this.tenantPrisma.executeInTenantTransaction(async (client) => {
      const tenant = getCurrentTenant();
      const rows = (await client.$queryRawUnsafe(
        `SELECT p.student_id::text AS student_id, p.school_id::text AS school_id
         FROM pfl_portfolio_sections s
         JOIN pfl_portfolios p ON p.id = s.portfolio_id
         WHERE s.id = $1::uuid AND p.school_id = $2::uuid
         FOR UPDATE OF s`,
        sectionId,
        tenant.schoolId,
      )) as Array<{ student_id: string; school_id: string }>;
      if (rows.length === 0) throw new NotFoundException('Section not found');
      if (!(await isOwningStudent(this.tenantPrisma, actor, rows[0]!.student_id))) {
        throw new ForbiddenException(
          'Only the owning student or a school admin can delete portfolio sections.',
        );
      }
      // REVIEW-P2C27 BLOCKING 5 — DELETE joins through pfl_portfolios so the
      // school predicate is enforced on the write.
      await client.$executeRawUnsafe(
        `DELETE FROM pfl_portfolio_sections AS del
         USING pfl_portfolios p
         WHERE p.id = del.portfolio_id
           AND del.id = $1::uuid
           AND p.school_id = $2::uuid`,
        sectionId,
        tenant.schoolId,
      );
    });
  }

  async assignItemToSection(
    itemId: string,
    actor: ResolvedActor,
    input: AssignItemToSectionDto,
  ): Promise<void> {
    return this.tenantPrisma.executeInTenantTransaction(async (client) => {
      const tenant = getCurrentTenant();
      const itemRows = (await client.$queryRawUnsafe(
        `SELECT i.id::text AS id, i.portfolio_id::text AS portfolio_id, p.student_id::text AS student_id, p.school_id::text AS school_id
         FROM pfl_portfolio_items i
         JOIN pfl_portfolios p ON p.id = i.portfolio_id
         WHERE i.id = $1::uuid AND p.school_id = $2::uuid
         FOR UPDATE OF i`,
        itemId,
        tenant.schoolId,
      )) as Array<{ id: string; portfolio_id: string; student_id: string; school_id: string }>;
      if (itemRows.length === 0) throw new NotFoundException('Portfolio item not found');
      if (!(await isOwningStudent(this.tenantPrisma, actor, itemRows[0]!.student_id))) {
        throw new ForbiddenException(
          'Only the owning student or a school admin can assign items to sections.',
        );
      }
      if (input.sectionId) {
        const sectionRows = (await client.$queryRawUnsafe(
          `SELECT s.portfolio_id::text AS portfolio_id
           FROM pfl_portfolio_sections s
           JOIN pfl_portfolios p ON p.id = s.portfolio_id
           WHERE s.id = $1::uuid AND p.school_id = $2::uuid
           LIMIT 1`,
          input.sectionId,
          tenant.schoolId,
        )) as Array<{ portfolio_id: string }>;
        if (sectionRows.length === 0) {
          throw new BadRequestException('sectionId does not match any section.');
        }
        if (sectionRows[0]!.portfolio_id !== itemRows[0]!.portfolio_id) {
          throw new BadRequestException(
            'sectionId belongs to a different portfolio than the item.',
          );
        }
      }
      // REVIEW-P2C27 BLOCKING 5 — UPDATE joins through pfl_portfolios so the
      // school predicate is bound on the assignment write.
      await client.$executeRawUnsafe(
        `UPDATE pfl_portfolio_items AS upd
         SET section_id = $1::uuid
         FROM pfl_portfolios p
         WHERE p.id = upd.portfolio_id
           AND upd.id = $2::uuid
           AND p.school_id = $3::uuid`,
        input.sectionId ?? null,
        itemId,
        tenant.schoolId,
      );
    });
  }
}
