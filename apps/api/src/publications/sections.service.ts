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
import { isUniqueViolation } from './series.service';
import {
  assertAccountInCurrentTenant,
  canApproveSection,
  canEditPublication,
  isStudentCollaborator,
} from './access';
import { PermissionCheckService } from '../iam/permission-check.service';
import type {
  AddContributorDto,
  CreateCommentDto,
  CreateSectionDto,
  SectionCommentDto,
  SectionContributorDto,
  SectionDto,
  SectionType,
  UpdateSectionDto,
} from './dto/publications.dto';

interface SectionRow {
  id: string;
  publication_id: string;
  title: string;
  body: string | null;
  section_type: SectionType;
  owner_id: string | null;
  owner_name: string | null;
  sort_order: number;
  is_approved: boolean;
  created_at: string;
  updated_at: string;
}

const SELECT_SECTION_BASE = `
  SELECT
    s.id::text AS id,
    s.publication_id::text AS publication_id,
    s.title,
    s.body,
    s.section_type,
    s.owner_id::text AS owner_id,
    (SELECT ip.first_name || ' ' || ip.last_name FROM hr_employees e JOIN platform.iam_person ip ON ip.id = e.person_id WHERE e.id = s.owner_id LIMIT 1) AS owner_name,
    s.sort_order,
    s.is_approved,
    s.created_at::text AS created_at,
    s.updated_at::text AS updated_at
  FROM pub_sections s
`;

@Injectable()
export class SectionService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  private async loadContributors(sectionId: string): Promise<SectionContributorDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        "SELECT c.id::text AS id, c.section_id::text AS section_id, c.contributor_id::text AS contributor_id, c.contribution_note, c.contributed_at::text AS contributed_at, (SELECT ip.first_name || ' ' || ip.last_name FROM platform.platform_users pu JOIN platform.iam_person ip ON ip.id = pu.person_id WHERE pu.id = c.contributor_id LIMIT 1) AS contributor_name FROM pub_section_contributors c WHERE c.section_id = $1::uuid ORDER BY c.contributed_at",
        sectionId,
      );
    })) as Array<{
      id: string;
      section_id: string;
      contributor_id: string;
      contributor_name: string | null;
      contribution_note: string | null;
      contributed_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      sectionId: r.section_id,
      contributorId: r.contributor_id,
      contributorName: r.contributor_name,
      contributionNote: r.contribution_note,
      contributedAt: r.contributed_at,
    }));
  }

  private async toDto(r: SectionRow): Promise<SectionDto> {
    return {
      id: r.id,
      publicationId: r.publication_id,
      title: r.title,
      body: r.body,
      sectionType: r.section_type,
      ownerId: r.owner_id,
      ownerName: r.owner_name,
      sortOrder: Number(r.sort_order),
      isApproved: r.is_approved,
      contributors: await this.loadContributors(r.id),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  async listForPublication(publicationId: string, actor: ResolvedActor): Promise<SectionDto[]> {
    // BLOCKING 1 (REVIEW-CYCLE25) — actor-aware. Load parent publication's
    // status; non-writer non-collaborator readers see only PUBLISHED
    // publications, and only approved sections within them.
    const tenant = getCurrentTenant();
    const pubRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT status FROM pub_publications WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        publicationId,
        tenant.schoolId,
      );
    })) as Array<{ status: string }>;
    if (pubRows.length === 0) {
      throw new NotFoundException('Publication not found');
    }
    const isWriter = await canEditPublication(
      this.tenantPrisma,
      this.permCheck,
      actor,
      publicationId,
    );
    if (!isWriter && pubRows[0]!.status !== 'PUBLISHED') {
      throw new NotFoundException('Publication not found');
    }
    const params: unknown[] = [publicationId];
    let where = ' WHERE s.publication_id = $1::uuid';
    if (!isWriter) {
      // Non-writer readers do not see pending sections.
      where += ' AND s.is_approved = true';
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_SECTION_BASE + where + ' ORDER BY s.sort_order',
        ...params,
      );
    })) as SectionRow[];
    const out: SectionDto[] = [];
    for (const r of rows) out.push(await this.toDto(r));
    return out;
  }

  async create(
    actor: ResolvedActor,
    publicationId: string,
    input: CreateSectionDto,
  ): Promise<SectionDto> {
    const tenant = getCurrentTenant();
    // BLOCKING 2 (REVIEW-CYCLE25) — students may only create sections on
    // publications where they hold an active EDITOR or CONTRIBUTOR
    // collaborator row. This blocks the "any student with PUB-002:write
    // can pollute any publication by UUID" attack while keeping the
    // student-input keystone alive for legitimate authoring flows.
    if (actor.personType === 'STUDENT' && !actor.isSchoolAdmin) {
      const ok = await isStudentCollaborator(this.tenantPrisma, actor, publicationId);
      if (!ok) {
        throw new ForbiddenException(
          'Students must be invited as a CONTRIBUTOR or EDITOR collaborator on the publication before adding a section.',
        );
      }
    }
    return this.tenantPrisma.executeInTenantTransaction(async (client) => {
      const pubRows = (await client.$queryRawUnsafe(
        'SELECT status FROM pub_publications WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE',
        publicationId,
        tenant.schoolId,
      )) as Array<{ status: string }>;
      if (pubRows.length === 0) throw new NotFoundException('Publication not found');
      // Determine the sort_order — last + 1 if not supplied.
      let sortOrder = input.sortOrder ?? null;
      if (sortOrder === null) {
        const max = (await client.$queryRawUnsafe(
          'SELECT COALESCE(MAX(sort_order), -1)::int AS m FROM pub_sections WHERE publication_id = $1::uuid',
          publicationId,
        )) as Array<{ m: number }>;
        sortOrder = Number(max[0]!.m) + 1;
      }
      // ADR-035 — student-owned sections (no employee owner_id) default to
      // is_approved=false and require an editor or admin to approve.
      const isApprovedDefault = !!input.ownerEmployeeId;
      const id = generateId();
      await client.$executeRawUnsafe(
        'INSERT INTO pub_sections (id, publication_id, title, body, section_type, owner_id, sort_order, is_approved) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7, $8)',
        id,
        publicationId,
        input.title,
        input.body ?? null,
        input.sectionType ?? 'ARTICLE',
        input.ownerEmployeeId ?? null,
        sortOrder,
        isApprovedDefault,
      );
      const fresh = (await client.$queryRawUnsafe(
        SELECT_SECTION_BASE + ' WHERE s.id = $1::uuid LIMIT 1',
        id,
      )) as SectionRow[];
      return this.toDto(fresh[0]!);
    });
  }

  async patch(
    _actor: ResolvedActor,
    sectionId: string,
    input: UpdateSectionDto,
  ): Promise<SectionDto> {
    return this.tenantPrisma.executeInTenantTransaction(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT id::text AS id FROM pub_sections WHERE id = $1::uuid FOR UPDATE',
        sectionId,
      )) as Array<{ id: string }>;
      if (rows.length === 0) throw new NotFoundException('Section not found');
      const sets: string[] = [];
      const params: unknown[] = [];
      const push = (sql: string, value: unknown) => {
        params.push(value);
        sets.push(`${sql} = $${params.length}`);
      };
      if (input.title !== undefined) push('title', input.title);
      if (input.body !== undefined) push('body', input.body);
      if (input.sectionType !== undefined) push('section_type', input.sectionType);
      if (input.sortOrder !== undefined) push('sort_order', input.sortOrder);
      if (sets.length === 0) {
        const cur = (await client.$queryRawUnsafe(
          SELECT_SECTION_BASE + ' WHERE s.id = $1::uuid LIMIT 1',
          sectionId,
        )) as SectionRow[];
        return this.toDto(cur[0]!);
      }
      sets.push('updated_at = now()');
      params.push(sectionId);
      await client.$executeRawUnsafe(
        `UPDATE pub_sections SET ${sets.join(', ')} WHERE id = $${params.length}::uuid`,
        ...params,
      );
      const cur = (await client.$queryRawUnsafe(
        SELECT_SECTION_BASE + ' WHERE s.id = $1::uuid LIMIT 1',
        sectionId,
      )) as SectionRow[];
      return this.toDto(cur[0]!);
    });
  }

  async remove(_actor: ResolvedActor, sectionId: string): Promise<void> {
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe('DELETE FROM pub_sections WHERE id = $1::uuid', sectionId);
    });
  }

  // ADR-035 approval flip — editor / reviewer / admin lifts the pending
  // flag on a section. BLOCKING 3 (REVIEW-CYCLE25) — generic PUB-002:write
  // is no longer enough; the actor must be school admin, the publication
  // creator, or an EDITOR/REVIEWER collaborator.
  async approve(actor: ResolvedActor, sectionId: string): Promise<SectionDto> {
    if (!actor.isSchoolAdmin && actor.personType === 'STUDENT') {
      throw new ForbiddenException('Students cannot approve their own sections.');
    }
    return this.tenantPrisma.executeInTenantTransaction(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT id::text AS id, publication_id::text AS publication_id FROM pub_sections WHERE id = $1::uuid FOR UPDATE',
        sectionId,
      )) as Array<{ id: string; publication_id: string }>;
      if (rows.length === 0) throw new NotFoundException('Section not found');
      const publicationId = rows[0]!.publication_id;
      const ok = await canApproveSection(this.tenantPrisma, actor, publicationId);
      if (!ok) {
        throw new ForbiddenException(
          'Only the publication creator, an EDITOR/REVIEWER collaborator, or a school admin can approve this section.',
        );
      }
      await client.$executeRawUnsafe(
        'UPDATE pub_sections SET is_approved = true, updated_at = now() WHERE id = $1::uuid',
        sectionId,
      );
      const fresh = (await client.$queryRawUnsafe(
        SELECT_SECTION_BASE + ' WHERE s.id = $1::uuid LIMIT 1',
        sectionId,
      )) as SectionRow[];
      return this.toDto(fresh[0]!);
    });
  }
}

@Injectable()
export class ContributorService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async add(
    _actor: ResolvedActor,
    sectionId: string,
    input: AddContributorDto,
  ): Promise<SectionContributorDto> {
    // BLOCKING 4 (REVIEW-CYCLE25) — validate the soft platform_users.id ref
    // points at a current-tenant user before insert.
    await assertAccountInCurrentTenant(this.tenantPrisma, input.contributorId, 'contributorId');
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO pub_section_contributors (id, section_id, contributor_id, contribution_note) VALUES ($1::uuid, $2::uuid, $3::uuid, $4)',
          id,
          sectionId,
          input.contributorId,
          input.contributionNote ?? null,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('User is already a contributor on this section.');
      }
      throw err;
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        "SELECT c.id::text AS id, c.section_id::text AS section_id, c.contributor_id::text AS contributor_id, c.contribution_note, c.contributed_at::text AS contributed_at, (SELECT ip.first_name || ' ' || ip.last_name FROM platform.platform_users pu JOIN platform.iam_person ip ON ip.id = pu.person_id WHERE pu.id = c.contributor_id LIMIT 1) AS contributor_name FROM pub_section_contributors c WHERE c.id = $1::uuid LIMIT 1",
        id,
      );
    })) as Array<{
      id: string;
      section_id: string;
      contributor_id: string;
      contributor_name: string | null;
      contribution_note: string | null;
      contributed_at: string;
    }>;
    const r = rows[0]!;
    return {
      id: r.id,
      sectionId: r.section_id,
      contributorId: r.contributor_id,
      contributorName: r.contributor_name,
      contributionNote: r.contribution_note,
      contributedAt: r.contributed_at,
    };
  }

  async remove(_actor: ResolvedActor, contributorRowId: string): Promise<void> {
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'DELETE FROM pub_section_contributors WHERE id = $1::uuid',
        contributorRowId,
      );
    });
  }
}

@Injectable()
export class CommentService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  async listForSection(sectionId: string, actor: ResolvedActor): Promise<SectionCommentDto[]> {
    // BLOCKING 1 (REVIEW-CYCLE25) — comments are an editorial-review
    // surface. Restricted to staff writers + collaborators on the parent
    // publication. Resolve the publication id from the section, then
    // gate via canEditPublication.
    const sectionRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT publication_id::text AS publication_id FROM pub_sections WHERE id = $1::uuid LIMIT 1',
        sectionId,
      );
    })) as Array<{ publication_id: string }>;
    if (sectionRows.length === 0) {
      throw new NotFoundException('Section not found');
    }
    const ok = await canEditPublication(
      this.tenantPrisma,
      this.permCheck,
      actor,
      sectionRows[0]!.publication_id,
    );
    if (!ok) {
      // Don't-leak-existence — collapsed 404.
      throw new NotFoundException('Section not found');
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        "SELECT c.id::text AS id, c.section_id::text AS section_id, c.author_id::text AS author_id, c.body, c.is_resolved, c.resolved_by::text AS resolved_by, c.resolved_at::text AS resolved_at, c.parent_comment_id::text AS parent_comment_id, c.created_at::text AS created_at, (SELECT ip.first_name || ' ' || ip.last_name FROM platform.platform_users pu JOIN platform.iam_person ip ON ip.id = pu.person_id WHERE pu.id = c.author_id LIMIT 1) AS author_name FROM pub_section_comments c WHERE c.section_id = $1::uuid ORDER BY c.created_at",
        sectionId,
      );
    })) as Array<{
      id: string;
      section_id: string;
      author_id: string;
      author_name: string | null;
      body: string;
      is_resolved: boolean;
      resolved_by: string | null;
      resolved_at: string | null;
      parent_comment_id: string | null;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      sectionId: r.section_id,
      authorId: r.author_id,
      authorName: r.author_name,
      body: r.body,
      isResolved: r.is_resolved,
      resolvedById: r.resolved_by,
      resolvedAt: r.resolved_at,
      parentCommentId: r.parent_comment_id,
      createdAt: r.created_at,
    }));
  }

  async create(
    actor: ResolvedActor,
    sectionId: string,
    input: CreateCommentDto,
  ): Promise<SectionCommentDto> {
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO pub_section_comments (id, section_id, author_id, body, parent_comment_id) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid)',
        id,
        sectionId,
        actor.accountId,
        input.body,
        input.parentCommentId ?? null,
      );
    });
    const list = await this.listForSection(sectionId, actor);
    return list.find((c) => c.id === id)!;
  }

  async resolve(actor: ResolvedActor, commentId: string): Promise<SectionCommentDto> {
    return this.tenantPrisma.executeInTenantTransaction(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT section_id::text AS section_id, is_resolved FROM pub_section_comments WHERE id = $1::uuid FOR UPDATE',
        commentId,
      )) as Array<{ section_id: string; is_resolved: boolean }>;
      if (rows.length === 0) throw new NotFoundException('Comment not found');
      if (rows[0]!.is_resolved) {
        throw new BadRequestException('Comment is already resolved.');
      }
      await client.$executeRawUnsafe(
        'UPDATE pub_section_comments SET is_resolved = true, resolved_by = $1::uuid, resolved_at = now(), updated_at = now() WHERE id = $2::uuid',
        actor.accountId,
        commentId,
      );
      const list = await this.listForSection(rows[0]!.section_id, actor);
      return list.find((c) => c.id === commentId)!;
    });
  }
}
