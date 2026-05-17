import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { canEditPublication, isStudentCollaborator, isUniqueViolation } from './access';
import type {
  CreateCheckpointDto,
  CreateFromTemplateDto,
  CreateTemplateDto,
  PublicationDto,
  PublicationVersionDetailDto,
  PublicationVersionDto,
  RevertToVersionDto,
  TemplateDto,
  UpdateTemplateDto,
  VersionTrigger,
} from './dto/publications.dto';

interface VersionRow {
  id: string;
  publication_id: string;
  version_number: number;
  trigger: VersionTrigger;
  reverted_from_version: number | null;
  version_note: string | null;
  created_by: string;
  created_by_name: string | null;
  created_at: string;
}

interface VersionWithSnapshotRow extends VersionRow {
  snapshot_content: Record<string, unknown>;
}

interface TemplateRow {
  id: string;
  school_id: string | null;
  name: string;
  description: string | null;
  publication_type: string;
  template_content: Record<string, unknown>;
  is_system: boolean;
  is_active: boolean;
  parent_template_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_VERSION_BASE = `
  SELECT
    v.id::text AS id,
    v.publication_id::text AS publication_id,
    v.version_number,
    v.trigger,
    v.reverted_from_version,
    v.version_note,
    v.created_by::text AS created_by,
    (SELECT pu.email FROM platform.platform_users pu WHERE pu.id = v.created_by LIMIT 1) AS created_by_name,
    v.created_at::text AS created_at
  FROM pub_publication_versions v
`;

/**
 * VersionService — Phase 2 Cycle 26 Step 3.
 *
 * pub_publication_versions is IMMUTABLE per ADR-010. This service is
 * the sole writer and exposes ONLY list + getById + checkpoint +
 * revert + the internal captureForStatusChange hook that
 * PublicationService.patchStatus calls inside its locked tenant tx.
 *
 * NO UPDATE METHOD. NO DELETE METHOD. The version trail is the
 * publication's append-only audit history. Revert creates a NEW
 * version derived from an earlier snapshot — it never modifies an
 * existing row.
 *
 * Visibility — canEditPublication is the gate. Versions inherit the
 * publication's edit-scope: editors + admins + collaborators see the
 * full timeline; non-collaborator non-editor readers cannot enumerate
 * versions on a publication they do not own.
 */
@Injectable()
export class VersionService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissionCheck: PermissionCheckService,
  ) {}

  async listForPublication(
    actor: ResolvedActor,
    publicationId: string,
  ): Promise<PublicationVersionDto[]> {
    await this.assertCanAccess(actor, publicationId);
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      // REVIEW-P2C26 R-B5 — JOIN through pub_publications.school_id so the
      // version trail cannot surface rows from a foreign-school publication
      // even if a forged publication UUID slipped past assertCanAccess.
      const rows = (await client.$queryRawUnsafe(
        `${SELECT_VERSION_BASE}
         JOIN pub_publications p ON p.id = v.publication_id AND p.school_id = $2::uuid
         WHERE v.publication_id = $1::uuid
         ORDER BY v.version_number DESC`,
        publicationId,
        tenant.schoolId,
      )) as VersionRow[];
      return rows.map((r) => this.rowToDto(r));
    });
  }

  async getById(actor: ResolvedActor, versionId: string): Promise<PublicationVersionDetailDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      // REVIEW-P2C26 R-B5 — JOIN through pub_publications.school_id so a
      // version id forged from another school's publication collapses to 404
      // before the access check fires.
      const rows = (await client.$queryRawUnsafe(
        `${SELECT_VERSION_BASE.replace('FROM pub_publication_versions v', ', v.snapshot_content FROM pub_publication_versions v')}
         JOIN pub_publications p ON p.id = v.publication_id AND p.school_id = $2::uuid
         WHERE v.id = $1::uuid LIMIT 1`,
        versionId,
        tenant.schoolId,
      )) as VersionWithSnapshotRow[];
      if (rows.length === 0) throw new NotFoundException('Version not found');
      const row = rows[0]!;
      await this.assertCanAccess(actor, row.publication_id);
      return {
        ...this.rowToDto(row),
        snapshotContent: row.snapshot_content ?? {},
      };
    });
  }

  // Manual editor checkpoint — captures the current publication shape
  // into a new version with trigger=MANUAL_CHECKPOINT.
  async checkpoint(
    actor: ResolvedActor,
    publicationId: string,
    input: CreateCheckpointDto,
  ): Promise<PublicationVersionDto> {
    await this.assertCanAccess(actor, publicationId);
    return this.tenantPrisma.executeInTenantTransaction(async (client) => {
      const versionId = await this.captureInTx(
        client,
        publicationId,
        'MANUAL_CHECKPOINT',
        input.versionNote ?? null,
        null,
        actor.accountId,
      );
      // REVIEW-P2C26 R-B5 — reload through the parent publication school
      // predicate (defence-in-depth alongside captureInTx's own check).
      const tenant = getCurrentTenant();
      const rows = (await client.$queryRawUnsafe(
        `${SELECT_VERSION_BASE}
         JOIN pub_publications p ON p.id = v.publication_id AND p.school_id = $2::uuid
         WHERE v.id = $1::uuid LIMIT 1`,
        versionId,
        tenant.schoolId,
      )) as VersionRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  // Revert KEYSTONE — creates a NEW version from an earlier snapshot.
  // Append-only. Never modifies an existing row. The target version's
  // snapshot_content is copied verbatim into a fresh row at
  // version_number = max + 1, with trigger=REVERT and
  // reverted_from_version=target.
  async revert(
    actor: ResolvedActor,
    publicationId: string,
    versionNumber: number,
    input: RevertToVersionDto,
  ): Promise<PublicationVersionDto> {
    await this.assertCanAccess(actor, publicationId);
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (client) => {
      // REVIEW-P2C26 R-B5 — target version lookup carries the school
      // predicate through the parent publication JOIN so a forged version
      // number cannot pull a foreign-school snapshot into this publication.
      const targetRows = (await client.$queryRawUnsafe(
        `SELECT v.snapshot_content
         FROM pub_publication_versions v
         JOIN pub_publications p ON p.id = v.publication_id AND p.school_id = $3::uuid
         WHERE v.publication_id = $1::uuid AND v.version_number = $2 LIMIT 1`,
        publicationId,
        versionNumber,
        tenant.schoolId,
      )) as Array<{ snapshot_content: Record<string, unknown> }>;
      if (targetRows.length === 0) {
        throw new NotFoundException(`Version ${versionNumber} not found for this publication.`);
      }
      const snapshot = targetRows[0]!.snapshot_content;

      const versionId = generateId();
      const nextNumber = await this.nextVersionNumber(client, publicationId);
      try {
        await client.$executeRawUnsafe(
          `INSERT INTO pub_publication_versions
             (id, publication_id, version_number, snapshot_content, trigger, reverted_from_version, version_note, created_by)
           VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, 'REVERT', $5, $6, $7::uuid)`,
          versionId,
          publicationId,
          nextNumber,
          JSON.stringify(snapshot),
          versionNumber,
          input.versionNote ?? `Reverted to v${versionNumber}`,
          actor.accountId,
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException('A concurrent version write occurred. Retry the revert.');
        }
        throw err;
      }
      // REVIEW-P2C26 R-B5 — reload via parent publication school predicate.
      const rows = (await client.$queryRawUnsafe(
        `${SELECT_VERSION_BASE}
         JOIN pub_publications p ON p.id = v.publication_id AND p.school_id = $2::uuid
         WHERE v.id = $1::uuid LIMIT 1`,
        versionId,
        tenant.schoolId,
      )) as VersionRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  // Internal helper called by PublicationService.patchStatus inside
  // its locked tx. Always captures with trigger=STATUS_CHANGE.
  async captureForStatusChange(
    client: Prisma.TransactionClient,
    publicationId: string,
    accountId: string,
    note: string | null,
  ): Promise<string> {
    return this.captureInTx(client, publicationId, 'STATUS_CHANGE', note, null, accountId);
  }

  // Shared snapshot composer — reads the publication + its sections
  // and writes a JSONB snapshot. Caller controls trigger + note +
  // reverted_from_version.
  private async captureInTx(
    client: Prisma.TransactionClient,
    publicationId: string,
    trigger: VersionTrigger,
    note: string | null,
    revertedFromVersion: number | null,
    createdByAccountId: string,
  ): Promise<string> {
    const snapshot = await this.composeSnapshot(client, publicationId);
    const versionId = generateId();
    const nextNumber = await this.nextVersionNumber(client, publicationId);
    try {
      await client.$executeRawUnsafe(
        `INSERT INTO pub_publication_versions
           (id, publication_id, version_number, snapshot_content, trigger, reverted_from_version, version_note, created_by)
         VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5, $6, $7, $8::uuid)`,
        versionId,
        publicationId,
        nextNumber,
        JSON.stringify(snapshot),
        trigger,
        revertedFromVersion,
        note,
        createdByAccountId,
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('A concurrent version write occurred. Retry the operation.');
      }
      throw err;
    }
    return versionId;
  }

  private async composeSnapshot(
    client: Prisma.TransactionClient,
    publicationId: string,
  ): Promise<Record<string, unknown>> {
    // REVIEW-P2C26 R-B5 — snapshot composer reads via the parent publication
    // school predicate so a forged publication id (e.g. from a worker that
    // skipped the canEditPublication gate) can't surface foreign-school
    // content into a version snapshot.
    const tenant = getCurrentTenant();
    const pubs = (await client.$queryRawUnsafe(
      `SELECT title, status, publication_type, published_at::text AS published_at
       FROM pub_publications WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
      publicationId,
      tenant.schoolId,
    )) as Array<{
      title: string;
      status: string;
      publication_type: string;
      published_at: string | null;
    }>;
    if (pubs.length === 0) throw new NotFoundException('Publication not found');
    const pub = pubs[0]!;
    const sections = (await client.$queryRawUnsafe(
      `SELECT s.id::text AS id, s.title, s.body, s.section_type, s.sort_order, s.is_approved
       FROM pub_sections s
       JOIN pub_publications p ON p.id = s.publication_id AND p.school_id = $2::uuid
       WHERE s.publication_id = $1::uuid ORDER BY s.sort_order`,
      publicationId,
      tenant.schoolId,
    )) as Array<{
      id: string;
      title: string;
      body: string | null;
      section_type: string;
      sort_order: number;
      is_approved: boolean;
    }>;
    return {
      title: pub.title,
      status: pub.status,
      publicationType: pub.publication_type,
      publishedAt: pub.published_at,
      sections: sections.map((s) => ({
        id: s.id,
        title: s.title,
        body: s.body,
        sectionType: s.section_type,
        sortOrder: s.sort_order,
        isApproved: s.is_approved,
      })),
    };
  }

  private async nextVersionNumber(
    client: Prisma.TransactionClient,
    publicationId: string,
  ): Promise<number> {
    // REVIEW-P2C26 R-B5 — JOIN through pub_publications.school_id so the
    // counter calculation can't surface MAX from a foreign-school publication
    // even if a forged publication id slipped past the access check.
    const tenant = getCurrentTenant();
    const rows = (await client.$queryRawUnsafe(
      `SELECT COALESCE(MAX(v.version_number), 0) + 1 AS next
       FROM pub_publication_versions v
       JOIN pub_publications p ON p.id = v.publication_id AND p.school_id = $2::uuid
       WHERE v.publication_id = $1::uuid`,
      publicationId,
      tenant.schoolId,
    )) as Array<{ next: number }>;
    return Number(rows[0]!.next);
  }

  private async assertCanAccess(actor: ResolvedActor, publicationId: string): Promise<void> {
    // Existence check against current tenant — collapsed 404 if missing.
    const tenant = getCurrentTenant();
    const exists = (await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe(
        'SELECT 1 FROM pub_publications WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        publicationId,
        tenant.schoolId,
      ),
    )) as Array<unknown>;
    if (exists.length === 0) throw new NotFoundException('Publication not found');
    const ok = await canEditPublication(
      this.tenantPrisma,
      this.permissionCheck,
      actor,
      publicationId,
    );
    if (!ok) {
      throw new ForbiddenException(
        'Only the publication editor or collaborators may see the version history.',
      );
    }
  }

  private rowToDto(row: VersionRow): PublicationVersionDto {
    return {
      id: row.id,
      publicationId: row.publication_id,
      versionNumber: row.version_number,
      trigger: row.trigger,
      revertedFromVersion: row.reverted_from_version,
      versionNote: row.version_note,
      createdById: row.created_by,
      createdByName: row.created_by_name,
      createdAt: row.created_at,
    };
  }
}

const SELECT_TEMPLATE_BASE = `
  SELECT
    t.id::text AS id,
    t.school_id::text AS school_id,
    t.name,
    t.description,
    t.publication_type,
    t.template_content,
    t.is_system,
    t.is_active,
    t.parent_template_id::text AS parent_template_id,
    t.created_by::text AS created_by,
    t.created_at::text AS created_at,
    t.updated_at::text AS updated_at
  FROM pub_templates t
`;

/**
 * TemplateService — Phase 2 Cycle 26 Step 3.
 *
 * Reusable publication structure. Platform-seeded templates have
 * school_id=NULL + is_system=true and every tenant sees them.
 * Schools may also author custom templates with school_id populated.
 *
 * CRITICAL: is_system=true templates CANNOT be edited or deleted
 * by schools — only the Step 7 platform seeder writes those rows.
 * Both update + delete fail-closed with 403 when targeting a system
 * template, even for school admins.
 *
 * The from-template path is the load-bearing flow: POST
 * /publications/from-template/:templateId creates a new
 * pub_publications row and auto-populates sections from
 * template_content.sections inside one tenant tx.
 */
@Injectable()
export class TemplateService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissionCheck: PermissionCheckService,
  ) {}

  async list(actor: ResolvedActor, includeInactive = false): Promise<TemplateDto[]> {
    void actor;
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      // REVIEW-P2C26 R-B1 — visibility = system templates (school_id IS NULL)
      // OR templates owned by the current school. Without this filter, a
      // multi-school tenant pool would leak School B custom templates to
      // School A staff. The system rows are platform-seeded into every
      // tenant so every school sees the same catalogue.
      const params: unknown[] = [tenant.schoolId];
      let where = ' WHERE (t.school_id IS NULL OR t.school_id = $1::uuid)';
      if (!includeInactive) {
        where += ' AND t.is_active = true';
      }
      const rows = (await client.$queryRawUnsafe(
        `${SELECT_TEMPLATE_BASE}${where} ORDER BY t.is_system DESC, t.name`,
        ...params,
      )) as TemplateRow[];
      return rows.map((r) => this.rowToDto(r));
    });
  }

  async getById(actor: ResolvedActor, id: string): Promise<TemplateDto> {
    void actor;
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      // REVIEW-P2C26 R-B1 — read carries the same school predicate as list.
      // A forged template UUID for a foreign-school custom template collapses
      // to 404 here rather than leaking the row.
      const rows = (await client.$queryRawUnsafe(
        `${SELECT_TEMPLATE_BASE}
         WHERE t.id = $1::uuid
           AND (t.school_id IS NULL OR t.school_id = $2::uuid) LIMIT 1`,
        id,
        tenant.schoolId,
      )) as TemplateRow[];
      if (rows.length === 0) throw new NotFoundException('Template not found');
      return this.rowToDto(rows[0]!);
    });
  }

  async create(actor: ResolvedActor, input: CreateTemplateDto): Promise<TemplateDto> {
    await this.assertCanManage(actor);
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (client) => {
      const id = generateId();
      try {
        await client.$executeRawUnsafe(
          `INSERT INTO pub_templates
             (id, school_id, name, description, publication_type, template_content, is_system, is_active, created_by)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, false, $7, $8::uuid)`,
          id,
          tenant.schoolId,
          input.name,
          input.description ?? null,
          input.publicationType,
          JSON.stringify(input.templateContent ?? { sections: [] }),
          input.isActive ?? true,
          actor.accountId,
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException(
            `A template named "${input.name}" already exists for this school or platform.`,
          );
        }
        throw err;
      }
      const rows = (await client.$queryRawUnsafe(
        `${SELECT_TEMPLATE_BASE} WHERE t.id = $1::uuid LIMIT 1`,
        id,
      )) as TemplateRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  async patch(actor: ResolvedActor, id: string, input: UpdateTemplateDto): Promise<TemplateDto> {
    await this.assertCanManage(actor);
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (client) => {
      // REVIEW-P2C26 R-B1 — lookup AND lock the row via school predicate so
      // a forged template UUID from another school can't be mutated. Reads
      // school_id alongside is_system to keep both checks atomic.
      const cur = (await client.$queryRawUnsafe(
        `SELECT is_system, school_id::text AS school_id
         FROM pub_templates
         WHERE id = $1::uuid
           AND (school_id IS NULL OR school_id = $2::uuid)
         FOR UPDATE`,
        id,
        tenant.schoolId,
      )) as Array<{ is_system: boolean; school_id: string | null }>;
      if (cur.length === 0) throw new NotFoundException('Template not found');
      if (cur[0]!.is_system) {
        throw new ForbiddenException(
          'System templates are read-only. Only the platform seeder may modify them.',
        );
      }
      if (cur[0]!.school_id !== tenant.schoolId) {
        // Defence-in-depth — the lookup predicate already enforces this, but
        // school admins legitimately reach the patch path so we belt-and-brace.
        throw new ForbiddenException('Template is not owned by this school.');
      }
      const sets: string[] = [];
      const params: unknown[] = [];
      const push = (sql: string, val: unknown) => {
        params.push(val);
        sets.push(`${sql} = $${params.length}`);
      };
      if (input.name !== undefined) push('name', input.name);
      if (input.description !== undefined) push('description', input.description ?? null);
      if (input.templateContent !== undefined)
        push('template_content', JSON.stringify(input.templateContent));
      if (input.isActive !== undefined) push('is_active', input.isActive);
      if (sets.length === 0) {
        const fresh = (await client.$queryRawUnsafe(
          `${SELECT_TEMPLATE_BASE}
           WHERE t.id = $1::uuid AND (t.school_id IS NULL OR t.school_id = $2::uuid) LIMIT 1`,
          id,
          tenant.schoolId,
        )) as TemplateRow[];
        return this.rowToDto(fresh[0]!);
      }
      params.push(id);
      params.push(tenant.schoolId);
      try {
        await client.$executeRawUnsafe(
          `UPDATE pub_templates SET ${sets.join(', ')}, updated_at = now()
           WHERE id = $${params.length - 1}::uuid AND school_id = $${params.length}::uuid`,
          ...params,
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException('A template with that name already exists.');
        }
        throw err;
      }
      const fresh = (await client.$queryRawUnsafe(
        `${SELECT_TEMPLATE_BASE}
         WHERE t.id = $1::uuid AND (t.school_id IS NULL OR t.school_id = $2::uuid) LIMIT 1`,
        id,
        tenant.schoolId,
      )) as TemplateRow[];
      return this.rowToDto(fresh[0]!);
    });
  }

  async remove(actor: ResolvedActor, id: string): Promise<void> {
    await this.assertCanManage(actor);
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (client) => {
      // REVIEW-P2C26 R-B1 — same school-scope contract as patch.
      const cur = (await client.$queryRawUnsafe(
        `SELECT is_system, school_id::text AS school_id
         FROM pub_templates
         WHERE id = $1::uuid
           AND (school_id IS NULL OR school_id = $2::uuid)
         FOR UPDATE`,
        id,
        tenant.schoolId,
      )) as Array<{ is_system: boolean; school_id: string | null }>;
      if (cur.length === 0) throw new NotFoundException('Template not found');
      if (cur[0]!.is_system) {
        throw new ForbiddenException(
          'System templates are read-only. Only the platform seeder may modify them.',
        );
      }
      if (cur[0]!.school_id !== tenant.schoolId) {
        throw new ForbiddenException('Template is not owned by this school.');
      }
      await client.$executeRawUnsafe(
        'DELETE FROM pub_templates WHERE id = $1::uuid AND school_id = $2::uuid',
        id,
        tenant.schoolId,
      );
    });
  }

  // FROM-TEMPLATE KEYSTONE — creates a new pub_publications row +
  // auto-populates sections from template_content.sections, all in
  // one tenant tx.
  async createFromTemplate(
    actor: ResolvedActor,
    templateId: string,
    input: CreateFromTemplateDto,
  ): Promise<PublicationDto> {
    await this.assertCanManage(actor);
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (client) => {
      // REVIEW-P2C26 R-B1 — template must be either a system template
      // (school_id IS NULL) or owned by the current school. A forged
      // template UUID from another school is rejected with 404.
      const tplRows = (await client.$queryRawUnsafe(
        `SELECT publication_type, template_content, is_active
         FROM pub_templates
         WHERE id = $1::uuid
           AND (school_id IS NULL OR school_id = $2::uuid) LIMIT 1`,
        templateId,
        tenant.schoolId,
      )) as Array<{
        publication_type: string;
        template_content: Record<string, unknown>;
        is_active: boolean;
      }>;
      if (tplRows.length === 0) throw new NotFoundException('Template not found');
      if (!tplRows[0]!.is_active) {
        throw new BadRequestException('Template is inactive and cannot be used.');
      }
      const tpl = tplRows[0]!;

      const publicationId = generateId();
      await client.$executeRawUnsafe(
        `INSERT INTO pub_publications
           (id, school_id, title, publication_type, series_id, edition_id, created_by, status)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6::uuid, $7::uuid, 'DRAFT')`,
        publicationId,
        tenant.schoolId,
        input.title,
        tpl.publication_type,
        input.seriesId ?? null,
        input.editionId ?? null,
        actor.accountId,
      );

      const sections = Array.isArray((tpl.template_content as { sections?: unknown[] }).sections)
        ? ((tpl.template_content as { sections: Array<{ title?: string; sortOrder?: number }> })
            .sections ?? [])
        : [];
      let sortOrder = 0;
      for (const s of sections) {
        const sortValue = typeof s.sortOrder === 'number' ? s.sortOrder : sortOrder;
        await client.$executeRawUnsafe(
          `INSERT INTO pub_sections
             (id, publication_id, title, body, section_type, owner_id, sort_order, is_approved)
           VALUES ($1::uuid, $2::uuid, $3, '', 'ARTICLE', NULL, $4, false)`,
          generateId(),
          publicationId,
          (s.title as string) ?? 'Untitled section',
          sortValue,
        );
        sortOrder = sortValue + 1;
      }

      const pubRows = (await client.$queryRawUnsafe(
        `SELECT
           p.id::text AS id,
           p.school_id::text AS school_id,
           p.title,
           p.publication_type,
           p.series_id::text AS series_id,
           p.edition_id::text AS edition_id,
           p.created_by::text AS created_by,
           p.status,
           p.scheduled_publish_at::text AS scheduled_publish_at,
           p.published_at::text AS published_at,
           p.approval_request_id::text AS approval_request_id,
           p.created_at::text AS created_at,
           p.updated_at::text AS updated_at
         FROM pub_publications p
         WHERE p.id = $1::uuid LIMIT 1`,
        publicationId,
      )) as Array<{
        id: string;
        school_id: string;
        title: string;
        publication_type: string;
        series_id: string | null;
        edition_id: string | null;
        created_by: string | null;
        status: string;
        scheduled_publish_at: string | null;
        published_at: string | null;
        approval_request_id: string | null;
        created_at: string;
        updated_at: string;
      }>;
      const r = pubRows[0]!;
      return {
        id: r.id,
        schoolId: r.school_id,
        title: r.title,
        publicationType: r.publication_type as PublicationDto['publicationType'],
        seriesId: r.series_id,
        seriesTitle: null,
        editionId: r.edition_id,
        editionNumber: null,
        createdById: r.created_by,
        createdByName: null,
        status: r.status as PublicationDto['status'],
        scheduledPublishAt: r.scheduled_publish_at,
        publishedAt: r.published_at,
        approvalRequestId: r.approval_request_id,
        sectionCount: sections.length,
        pendingSectionCount: sections.length,
        recipientCount: 0,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    });
  }

  // Template-writer scope = admin OR pub-001:write STAFF. Students
  // cannot manage templates even if they are publication collaborators.
  private async assertCanManage(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const writerOk = await this.permissionCheck.hasAnyPermissionInTenant(
      actor.accountId,
      tenant.schoolId,
      ['pub-001:write'],
    );
    // Defence-in-depth: student collaborators on a publication may not
    // author templates.
    const stuOnAnyPub = await isStudentCollaborator(
      this.tenantPrisma,
      actor,
      '00000000-0000-0000-0000-000000000000',
    );
    void stuOnAnyPub; // The check above is symbolic; we gate by persona.
    if (writerOk && actor.personType === 'STAFF') return;
    throw new ForbiddenException(
      'Only school admins or staff with publications write may manage templates.',
    );
  }

  private rowToDto(row: TemplateRow): TemplateDto {
    return {
      id: row.id,
      schoolId: row.school_id,
      name: row.name,
      description: row.description,
      publicationType: row.publication_type as TemplateDto['publicationType'],
      templateContent: row.template_content ?? {},
      isSystem: row.is_system,
      isActive: row.is_active,
      parentTemplateId: row.parent_template_id,
      createdById: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
