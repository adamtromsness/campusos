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
import type {
  CreatePortfolioDto,
  CreatePortfolioItemDto,
  ItemSourceCandidateDto,
  PortfolioDetailDto,
  PortfolioDto,
  PortfolioItemDto,
  PortfolioVisibility,
  UpdatePortfolioDto,
  UpdatePortfolioItemDto,
} from './dto/portfolio.dto';

export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e?.code === 'P2002') return true;
  if (e?.code === 'P2010' && e?.meta?.code === '23505') return true;
  if (typeof e?.message === 'string' && e.message.includes('23505')) return true;
  return false;
}

interface PortfolioRow {
  id: string;
  student_id: string;
  school_id: string;
  title: string;
  description: string | null;
  visibility: PortfolioVisibility;
  share_link_enabled: boolean;
  created_at: string;
  updated_at: string;
  student_name: string | null;
  item_count: number;
  achievement_count: number;
}

interface ItemRow {
  id: string;
  portfolio_id: string;
  item_type: PortfolioItemType;
  source_ref_id: string | null;
  title: string;
  description: string | null;
  s3_key: string | null;
  is_featured: boolean;
  added_at: string;
}

type PortfolioItemType = PortfolioItemDto['itemType'];

const SELECT_PORTFOLIO_BASE = `
  SELECT
    p.id::text AS id,
    p.student_id::text AS student_id,
    p.school_id::text AS school_id,
    p.title,
    p.description,
    p.visibility,
    p.share_link_enabled,
    p.created_at::text AS created_at,
    p.updated_at::text AS updated_at,
    (SELECT ip.first_name || ' ' || ip.last_name
       FROM sis_students s
       JOIN platform.platform_students ps ON ps.id = s.platform_student_id
       JOIN platform.iam_person ip ON ip.id = ps.person_id
       WHERE s.id = p.student_id LIMIT 1) AS student_name,
    (SELECT COUNT(*)::int FROM pfl_portfolio_items i WHERE i.portfolio_id = p.id) AS item_count,
    (SELECT COUNT(*)::int FROM pfl_achievements a WHERE a.student_id = p.student_id AND a.school_id = p.school_id) AS achievement_count
  FROM pfl_portfolios p
`;

@Injectable()
export class PortfolioService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  // Resolve the calling student's sis_students.id from actor.personId.
  private async resolveStudentIdForActor(actor: ResolvedActor): Promise<string | null> {
    if (actor.personType !== 'STUDENT') return null;
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT s.id::text AS id FROM sis_students s JOIN platform.platform_students ps ON ps.id = s.platform_student_id WHERE ps.person_id = $1::uuid LIMIT 1',
        actor.personId,
      );
    })) as Array<{ id: string }>;
    return rows[0]?.id ?? null;
  }

  // Visibility check: returns true if actor can read the portfolio of the given student.
  // Decision matrix: PRIVATE -> owner only; TEACHER -> owner + teachers + admin;
  // PARENT -> owner + teachers + linked guardians + admin; PUBLIC -> any auth user.
  private async canRead(
    actor: ResolvedActor,
    studentId: string,
    visibility: PortfolioVisibility,
  ): Promise<boolean> {
    // Owner check
    const ownerStudentId = await this.resolveStudentIdForActor(actor);
    if (ownerStudentId === studentId) return true;
    if (actor.isSchoolAdmin) return true;
    if (visibility === 'PRIVATE') return false;
    if (visibility === 'PUBLIC') return true;
    if (visibility === 'TEACHER') {
      if (actor.personType === 'STAFF') return true;
      return false;
    }
    if (visibility === 'PARENT') {
      if (actor.personType === 'STAFF') return true;
      if (actor.personType === 'GUARDIAN') {
        const linked = (await this.tenantPrisma.executeInTenantContext(async (client) => {
          return client.$queryRawUnsafe(
            'SELECT 1 FROM sis_student_guardians sg JOIN sis_guardians g ON g.id = sg.guardian_id WHERE g.person_id = $1::uuid AND sg.student_id = $2::uuid LIMIT 1',
            actor.personId,
            studentId,
          );
        })) as Array<unknown>;
        return linked.length > 0;
      }
    }
    return false;
  }

  private rowToDto(r: PortfolioRow): PortfolioDto {
    return {
      id: r.id,
      studentId: r.student_id,
      studentName: r.student_name,
      schoolId: r.school_id,
      title: r.title,
      description: r.description,
      visibility: r.visibility,
      shareLinkEnabled: r.share_link_enabled,
      itemCount: Number(r.item_count),
      achievementCount: Number(r.achievement_count),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  // Public: load by id (used for share-link view). Bypasses persona checks.
  async loadByIdRaw(id: string): Promise<PortfolioRow | null> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_PORTFOLIO_BASE + ' WHERE p.id = $1::uuid AND p.school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      );
    })) as PortfolioRow[];
    return rows[0] ?? null;
  }

  async getMy(actor: ResolvedActor): Promise<PortfolioDetailDto | null> {
    if (actor.personType !== 'STUDENT') {
      throw new ForbiddenException(
        'Only students have a personal portfolio at /portfolio/my. Teachers and parents view student portfolios via /portfolio/students/:studentId.',
      );
    }
    const studentId = await this.resolveStudentIdForActor(actor);
    if (!studentId) {
      throw new BadRequestException('Could not resolve sis_students row for the calling user.');
    }
    return this.getByStudent(actor, studentId);
  }

  async getByStudent(actor: ResolvedActor, studentId: string): Promise<PortfolioDetailDto | null> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_PORTFOLIO_BASE + ' WHERE p.student_id = $1::uuid AND p.school_id = $2::uuid LIMIT 1',
        studentId,
        tenant.schoolId,
      );
    })) as PortfolioRow[];
    if (rows.length === 0) {
      // Don't-leak-existence — every persona gets the same 404 if there's no row.
      throw new NotFoundException('Portfolio not found');
    }
    const row = rows[0]!;
    if (!(await this.canRead(actor, studentId, row.visibility))) {
      throw new NotFoundException('Portfolio not found');
    }
    const items = await this.listItemsForPortfolio(row.id);
    return { ...this.rowToDto(row), items };
  }

  async create(actor: ResolvedActor, input: CreatePortfolioDto): Promise<PortfolioDto> {
    if (actor.personType !== 'STUDENT') {
      throw new ForbiddenException('Only students can create their own portfolio.');
    }
    const studentId = await this.resolveStudentIdForActor(actor);
    if (!studentId) {
      throw new BadRequestException('Could not resolve sis_students row for the calling user.');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO pfl_portfolios (id, student_id, school_id, title, description, visibility) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6)',
          id,
          studentId,
          tenant.schoolId,
          input.title,
          input.description ?? null,
          input.visibility ?? 'PRIVATE',
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          'You already have a portfolio for this school. Use PATCH to update it.',
        );
      }
      throw err;
    }
    const row = (await this.loadOwnedRow(studentId))!;
    return this.rowToDto(row);
  }

  private async loadOwnedRow(studentId: string): Promise<PortfolioRow | null> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_PORTFOLIO_BASE + ' WHERE p.student_id = $1::uuid AND p.school_id = $2::uuid LIMIT 1',
        studentId,
        tenant.schoolId,
      );
    })) as PortfolioRow[];
    return rows[0] ?? null;
  }

  async patch(actor: ResolvedActor, id: string, input: UpdatePortfolioDto): Promise<PortfolioDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT student_id::text AS student_id FROM pfl_portfolios WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE',
        id,
        tenant.schoolId,
      )) as Array<{ student_id: string }>;
      if (rows.length === 0) throw new NotFoundException('Portfolio not found');
      const studentId = rows[0]!.student_id;
      // Owner-only — student must own the portfolio. Admin override allowed.
      const ownerStudentId = await this.resolveStudentIdForActor(actor);
      if (!actor.isSchoolAdmin && ownerStudentId !== studentId) {
        throw new ForbiddenException(
          'Only the owning student or a school admin can edit this portfolio.',
        );
      }

      const sets: string[] = [];
      const params: unknown[] = [];
      const push = (sql: string, value: unknown) => {
        params.push(value);
        sets.push(`${sql} = $${params.length}`);
      };
      if (input.title !== undefined) push('title', input.title);
      if (input.description !== undefined) push('description', input.description);
      if (input.visibility !== undefined) push('visibility', input.visibility);
      if (input.shareLinkEnabled !== undefined) push('share_link_enabled', input.shareLinkEnabled);
      if (sets.length === 0) {
        const cur = await this.loadOwnedRow(studentId);
        return this.rowToDto(cur!);
      }
      sets.push('updated_at = now()');
      params.push(id);
      await client.$executeRawUnsafe(
        `UPDATE pfl_portfolios SET ${sets.join(', ')} WHERE id = $${params.length}::uuid`,
        ...params,
      );
      const cur = await this.loadOwnedRow(studentId);
      return this.rowToDto(cur!);
    });
  }

  // ── Items ─────────────────────────────────────────────────

  async listItemsForPortfolio(portfolioId: string): Promise<PortfolioItemDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, portfolio_id::text AS portfolio_id, item_type, source_ref_id::text AS source_ref_id, title, description, s3_key, is_featured, added_at::text AS added_at FROM pfl_portfolio_items WHERE portfolio_id = $1::uuid ORDER BY is_featured DESC, added_at DESC',
        portfolioId,
      );
    })) as ItemRow[];
    const out: PortfolioItemDto[] = [];
    for (const r of rows) {
      out.push({
        id: r.id,
        portfolioId: r.portfolio_id,
        itemType: r.item_type,
        sourceRefId: r.source_ref_id,
        sourceTitle: await this.resolveSourceTitle(r.item_type, r.source_ref_id),
        title: r.title,
        description: r.description,
        s3Key: r.s3_key,
        isFeatured: r.is_featured,
        addedAt: r.added_at,
      });
    }
    return out;
  }

  // Polymorphic source resolution: SUBMISSION -> cls_submissions, GRADE -> cls_grades,
  // ACHIEVEMENT -> pfl_achievements. REFLECTION/EXTERNAL_FILE/CERTIFICATE return null.
  private async resolveSourceTitle(
    itemType: PortfolioItemType,
    sourceRefId: string | null,
  ): Promise<string | null> {
    if (!sourceRefId) return null;
    if (itemType === 'SUBMISSION') {
      const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT a.title FROM cls_submissions s JOIN cls_assignments a ON a.id = s.assignment_id WHERE s.id = $1::uuid LIMIT 1',
          sourceRefId,
        );
      })) as Array<{ title: string }>;
      return rows[0]?.title ?? null;
    }
    if (itemType === 'GRADE') {
      const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT a.title FROM cls_grades g JOIN cls_assignments a ON a.id = g.assignment_id WHERE g.id = $1::uuid LIMIT 1',
          sourceRefId,
        );
      })) as Array<{ title: string }>;
      return rows[0]?.title ?? null;
    }
    if (itemType === 'ACHIEVEMENT') {
      const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT title FROM pfl_achievements WHERE id = $1::uuid LIMIT 1',
          sourceRefId,
        );
      })) as Array<{ title: string }>;
      return rows[0]?.title ?? null;
    }
    return null;
  }

  async addItem(
    actor: ResolvedActor,
    portfolioId: string,
    input: CreatePortfolioItemDto,
  ): Promise<PortfolioItemDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT student_id::text AS student_id FROM pfl_portfolios WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE',
        portfolioId,
        tenant.schoolId,
      )) as Array<{ student_id: string }>;
      if (rows.length === 0) throw new NotFoundException('Portfolio not found');
      const studentId = rows[0]!.student_id;
      const ownerStudentId = await this.resolveStudentIdForActor(actor);
      if (!actor.isSchoolAdmin && ownerStudentId !== studentId) {
        throw new ForbiddenException(
          'Only the owning student or a school admin can add items to this portfolio.',
        );
      }
      // Validate source_ref_id resolves in tenant when item is source-typed.
      if (input.sourceRefId) {
        if (input.itemType === 'SUBMISSION') {
          const ok = (await client.$queryRawUnsafe(
            'SELECT 1 FROM cls_submissions WHERE id = $1::uuid LIMIT 1',
            input.sourceRefId,
          )) as Array<unknown>;
          if (ok.length === 0) {
            throw new BadRequestException(
              'sourceRefId does not match a submission in this tenant.',
            );
          }
        } else if (input.itemType === 'GRADE') {
          const ok = (await client.$queryRawUnsafe(
            'SELECT 1 FROM cls_grades WHERE id = $1::uuid LIMIT 1',
            input.sourceRefId,
          )) as Array<unknown>;
          if (ok.length === 0) {
            throw new BadRequestException('sourceRefId does not match a grade in this tenant.');
          }
        } else if (input.itemType === 'ACHIEVEMENT') {
          const ok = (await client.$queryRawUnsafe(
            'SELECT 1 FROM pfl_achievements WHERE id = $1::uuid LIMIT 1',
            input.sourceRefId,
          )) as Array<unknown>;
          if (ok.length === 0) {
            throw new BadRequestException(
              'sourceRefId does not match an achievement in this tenant.',
            );
          }
        }
      }
      const id = generateId();
      await client.$executeRawUnsafe(
        'INSERT INTO pfl_portfolio_items (id, portfolio_id, item_type, source_ref_id, title, description, s3_key, is_featured) VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7, $8)',
        id,
        portfolioId,
        input.itemType,
        input.sourceRefId ?? null,
        input.title,
        input.description ?? null,
        input.s3Key ?? null,
        input.isFeatured ?? false,
      );
      const fresh = (await client.$queryRawUnsafe(
        'SELECT id::text AS id, portfolio_id::text AS portfolio_id, item_type, source_ref_id::text AS source_ref_id, title, description, s3_key, is_featured, added_at::text AS added_at FROM pfl_portfolio_items WHERE id = $1::uuid LIMIT 1',
        id,
      )) as ItemRow[];
      const r = fresh[0]!;
      return {
        id: r.id,
        portfolioId: r.portfolio_id,
        itemType: r.item_type,
        sourceRefId: r.source_ref_id,
        sourceTitle: await this.resolveSourceTitle(r.item_type, r.source_ref_id),
        title: r.title,
        description: r.description,
        s3Key: r.s3_key,
        isFeatured: r.is_featured,
        addedAt: r.added_at,
      };
    });
  }

  async patchItem(
    actor: ResolvedActor,
    itemId: string,
    input: UpdatePortfolioItemDto,
  ): Promise<PortfolioItemDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT i.portfolio_id::text AS portfolio_id, p.student_id::text AS student_id FROM pfl_portfolio_items i JOIN pfl_portfolios p ON p.id = i.portfolio_id WHERE i.id = $1::uuid AND p.school_id = $2::uuid FOR UPDATE OF i',
        itemId,
        tenant.schoolId,
      )) as Array<{ portfolio_id: string; student_id: string }>;
      if (rows.length === 0) throw new NotFoundException('Portfolio item not found');
      const ownerStudentId = await this.resolveStudentIdForActor(actor);
      if (!actor.isSchoolAdmin && ownerStudentId !== rows[0]!.student_id) {
        throw new ForbiddenException(
          'Only the owning student or a school admin can edit this item.',
        );
      }
      const sets: string[] = [];
      const params: unknown[] = [];
      const push = (sql: string, value: unknown) => {
        params.push(value);
        sets.push(`${sql} = $${params.length}`);
      };
      if (input.title !== undefined) push('title', input.title);
      if (input.description !== undefined) push('description', input.description);
      if (input.isFeatured !== undefined) push('is_featured', input.isFeatured);
      if (sets.length > 0) {
        params.push(itemId);
        await client.$executeRawUnsafe(
          `UPDATE pfl_portfolio_items SET ${sets.join(', ')} WHERE id = $${params.length}::uuid`,
          ...params,
        );
      }
      const fresh = (await client.$queryRawUnsafe(
        'SELECT id::text AS id, portfolio_id::text AS portfolio_id, item_type, source_ref_id::text AS source_ref_id, title, description, s3_key, is_featured, added_at::text AS added_at FROM pfl_portfolio_items WHERE id = $1::uuid LIMIT 1',
        itemId,
      )) as ItemRow[];
      const r = fresh[0]!;
      return {
        id: r.id,
        portfolioId: r.portfolio_id,
        itemType: r.item_type,
        sourceRefId: r.source_ref_id,
        sourceTitle: await this.resolveSourceTitle(r.item_type, r.source_ref_id),
        title: r.title,
        description: r.description,
        s3Key: r.s3_key,
        isFeatured: r.is_featured,
        addedAt: r.added_at,
      };
    });
  }

  async removeItem(actor: ResolvedActor, itemId: string): Promise<void> {
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT p.student_id::text AS student_id FROM pfl_portfolio_items i JOIN pfl_portfolios p ON p.id = i.portfolio_id WHERE i.id = $1::uuid AND p.school_id = $2::uuid',
        itemId,
        tenant.schoolId,
      )) as Array<{ student_id: string }>;
      if (rows.length === 0) throw new NotFoundException('Portfolio item not found');
      const ownerStudentId = await this.resolveStudentIdForActor(actor);
      if (!actor.isSchoolAdmin && ownerStudentId !== rows[0]!.student_id) {
        throw new ForbiddenException(
          'Only the owning student or a school admin can remove this item.',
        );
      }
      await client.$executeRawUnsafe('DELETE FROM pfl_portfolio_items WHERE id = $1::uuid', itemId);
    });
  }

  // Returns a list of items the calling student is eligible to add: own classroom
  // submissions, own grades, own achievements. Used by /portfolio/:id/items/sources.
  async listSourceCandidates(actor: ResolvedActor): Promise<ItemSourceCandidateDto[]> {
    const studentId = await this.resolveStudentIdForActor(actor);
    if (!studentId) return [];
    const tenant = getCurrentTenant();
    const subs = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT s.id::text AS id, a.title, c.section_code AS section FROM cls_submissions s JOIN cls_assignments a ON a.id = s.assignment_id JOIN sis_classes c ON c.id = a.class_id WHERE s.student_id = $1::uuid ORDER BY s.submitted_at DESC NULLS LAST LIMIT 50',
        studentId,
      );
    })) as Array<{ id: string; title: string; section: string }>;
    const grades = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT g.id::text AS id, a.title, c.section_code AS section FROM cls_grades g JOIN cls_assignments a ON a.id = g.assignment_id JOIN sis_classes c ON c.id = a.class_id WHERE g.student_id = $1::uuid AND g.is_published = true ORDER BY g.published_at DESC NULLS LAST LIMIT 50',
        studentId,
      );
    })) as Array<{ id: string; title: string; section: string }>;
    const achs = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, title, achievement_type AS section FROM pfl_achievements WHERE student_id = $1::uuid AND school_id = $2::uuid ORDER BY awarded_at DESC LIMIT 50',
        studentId,
        tenant.schoolId,
      );
    })) as Array<{ id: string; title: string; section: string }>;
    const out: ItemSourceCandidateDto[] = [];
    for (const r of subs)
      out.push({ itemType: 'SUBMISSION', sourceRefId: r.id, title: r.title, subtitle: r.section });
    for (const r of grades)
      out.push({ itemType: 'GRADE', sourceRefId: r.id, title: r.title, subtitle: r.section });
    for (const r of achs)
      out.push({ itemType: 'ACHIEVEMENT', sourceRefId: r.id, title: r.title, subtitle: r.section });
    return out;
  }
}
