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
import { assertAccountInCurrentTenant, isUniqueViolation } from './access';
import type {
  CollaboratorRole,
  CreateEditionDto,
  CreatePublicationDto,
  CreateSeriesDto,
  EditionDto,
  InviteCollaboratorDto,
  PublicationCollaboratorDto,
  PublicationDetailDto,
  PublicationDto,
  PublicationStatus,
  SeriesDto,
  UpdateEditionDto,
  UpdatePublicationStatusDto,
  UpdateSeriesDto,
} from './dto/publications.dto';

// isUniqueViolation moved to access.ts in Phase 2 Cycle 26 to break
// the circular dependency between series.service (PublicationService) +
// versions.service (VersionService). Kept here as a re-export for
// backwards compatibility with sections.service.ts + distribution.service.ts
// imports.
export { isUniqueViolation } from './access';

interface SeriesRow {
  id: string;
  school_id: string;
  title: string;
  description: string | null;
  publication_type: string;
  frequency: string;
  series_logo_s3_key: string | null;
  is_active: boolean;
  created_by: string | null;
  created_by_name: string | null;
  edition_count: number;
  subscriber_count: number;
  created_at: string;
  updated_at: string;
}

interface EditionRow {
  id: string;
  series_id: string;
  edition_number: number;
  edition_label: string | null;
  theme: string | null;
  cover_image_s3_key: string | null;
  editorial_note: string | null;
  status: PublicationStatus;
  scheduled_publish_at: string | null;
  published_at: string | null;
  editor_id: string | null;
  editor_name: string | null;
  approval_request_id: string | null;
  created_at: string;
  updated_at: string;
}

interface PublicationRow {
  id: string;
  school_id: string;
  title: string;
  publication_type: string;
  series_id: string | null;
  series_title: string | null;
  edition_id: string | null;
  edition_number: number | null;
  created_by: string | null;
  created_by_name: string | null;
  status: PublicationStatus;
  scheduled_publish_at: string | null;
  published_at: string | null;
  approval_request_id: string | null;
  section_count: number;
  pending_section_count: number;
  recipient_count: number;
  created_at: string;
  updated_at: string;
}

const SELECT_SERIES_BASE = `
  SELECT
    s.id::text AS id,
    s.school_id::text AS school_id,
    s.title,
    s.description,
    s.publication_type,
    s.frequency,
    s.series_logo_s3_key,
    s.is_active,
    s.created_by::text AS created_by,
    (SELECT ip.first_name || ' ' || ip.last_name FROM hr_employees e JOIN platform.iam_person ip ON ip.id = e.person_id WHERE e.id = s.created_by LIMIT 1) AS created_by_name,
    (SELECT COUNT(*)::int FROM pub_edition e WHERE e.series_id = s.id) AS edition_count,
    (SELECT COUNT(*)::int FROM pub_series_subscriptions sub WHERE sub.series_id = s.id AND sub.status = 'SUBSCRIBED') AS subscriber_count,
    s.created_at::text AS created_at,
    s.updated_at::text AS updated_at
  FROM pub_series s
`;

const SELECT_EDITION_BASE = `
  SELECT
    e.id::text AS id,
    e.series_id::text AS series_id,
    e.edition_number,
    e.edition_label,
    e.theme,
    e.cover_image_s3_key,
    e.editorial_note,
    e.status,
    e.scheduled_publish_at::text AS scheduled_publish_at,
    e.published_at::text AS published_at,
    e.editor_id::text AS editor_id,
    (SELECT ip.first_name || ' ' || ip.last_name FROM hr_employees emp JOIN platform.iam_person ip ON ip.id = emp.person_id WHERE emp.id = e.editor_id LIMIT 1) AS editor_name,
    e.approval_request_id::text AS approval_request_id,
    e.created_at::text AS created_at,
    e.updated_at::text AS updated_at
  FROM pub_edition e
`;

const SELECT_PUBLICATION_BASE = `
  SELECT
    p.id::text AS id,
    p.school_id::text AS school_id,
    p.title,
    p.publication_type,
    p.series_id::text AS series_id,
    (SELECT s.title FROM pub_series s WHERE s.id = p.series_id LIMIT 1) AS series_title,
    p.edition_id::text AS edition_id,
    (SELECT e.edition_number FROM pub_edition e WHERE e.id = p.edition_id LIMIT 1) AS edition_number,
    p.created_by::text AS created_by,
    (SELECT pu.email FROM platform.platform_users pu WHERE pu.id = p.created_by LIMIT 1) AS created_by_name,
    p.status,
    p.scheduled_publish_at::text AS scheduled_publish_at,
    p.published_at::text AS published_at,
    p.approval_request_id::text AS approval_request_id,
    (SELECT COUNT(*)::int FROM pub_sections sec WHERE sec.publication_id = p.id) AS section_count,
    (SELECT COUNT(*)::int FROM pub_sections sec WHERE sec.publication_id = p.id AND sec.is_approved = false) AS pending_section_count,
    (SELECT COUNT(*)::int FROM pub_distribution_recipients r WHERE r.publication_id = p.id) AS recipient_count,
    p.created_at::text AS created_at,
    p.updated_at::text AS updated_at
  FROM pub_publications p
`;

const ALLOWED_TRANSITIONS: Record<PublicationStatus, PublicationStatus[]> = {
  DRAFT: ['IN_REVIEW', 'ARCHIVED'],
  IN_REVIEW: ['DRAFT', 'APPROVED', 'ARCHIVED'],
  APPROVED: ['PUBLISHED', 'IN_REVIEW', 'ARCHIVED'],
  PUBLISHED: ['ARCHIVED'],
  ARCHIVED: ['DRAFT'],
};

@Injectable()
export class SeriesService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  private async assertWriter(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'pub-001:write',
    ]);
    if (!ok) {
      throw new ForbiddenException(
        'Only teachers, editors, or school admins can manage publication series.',
      );
    }
  }

  private rowToDto(r: SeriesRow): SeriesDto {
    return {
      id: r.id,
      schoolId: r.school_id,
      title: r.title,
      description: r.description,
      publicationType: r.publication_type as SeriesDto['publicationType'],
      frequency: r.frequency as SeriesDto['frequency'],
      seriesLogoS3Key: r.series_logo_s3_key,
      isActive: r.is_active,
      createdById: r.created_by,
      createdByName: r.created_by_name,
      editionCount: Number(r.edition_count),
      subscriberCount: Number(r.subscriber_count),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  async list(): Promise<SeriesDto[]> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_SERIES_BASE +
          ' WHERE s.school_id = $1::uuid ORDER BY s.is_active DESC, s.created_at DESC',
        tenant.schoolId,
      );
    })) as SeriesRow[];
    return rows.map((r) => this.rowToDto(r));
  }

  async getById(id: string): Promise<SeriesDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_SERIES_BASE + ' WHERE s.id = $1::uuid AND s.school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      );
    })) as SeriesRow[];
    if (rows.length === 0) throw new NotFoundException('Series not found');
    return this.rowToDto(rows[0]!);
  }

  async create(actor: ResolvedActor, input: CreateSeriesDto): Promise<SeriesDto> {
    await this.assertWriter(actor);
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO pub_series (id, school_id, title, description, publication_type, frequency, series_logo_s3_key, created_by) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::uuid)',
          id,
          tenant.schoolId,
          input.title,
          input.description ?? null,
          input.publicationType,
          input.frequency,
          input.seriesLogoS3Key ?? null,
          actor.employeeId ?? null,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          `A series with the title "${input.title}" already exists for this school.`,
        );
      }
      throw err;
    }
    return this.getById(id);
  }

  async patch(actor: ResolvedActor, id: string, input: UpdateSeriesDto): Promise<SeriesDto> {
    await this.assertWriter(actor);
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT id::text AS id FROM pub_series WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE',
        id,
        tenant.schoolId,
      )) as Array<{ id: string }>;
      if (rows.length === 0) throw new NotFoundException('Series not found');
      const sets: string[] = [];
      const params: unknown[] = [];
      const push = (sql: string, value: unknown) => {
        params.push(value);
        sets.push(`${sql} = $${params.length}`);
      };
      if (input.title !== undefined) push('title', input.title);
      if (input.description !== undefined) push('description', input.description);
      if (input.frequency !== undefined) push('frequency', input.frequency);
      if (input.isActive !== undefined) push('is_active', input.isActive);
      if (sets.length === 0) {
        return this.getById(id);
      }
      sets.push('updated_at = now()');
      params.push(id);
      await client.$executeRawUnsafe(
        `UPDATE pub_series SET ${sets.join(', ')} WHERE id = $${params.length}::uuid`,
        ...params,
      );
      return this.getById(id);
    });
  }
}

@Injectable()
export class EditionService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  private async assertWriter(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'pub-001:write',
    ]);
    if (!ok) {
      throw new ForbiddenException('Only teachers, editors, or school admins can manage editions.');
    }
  }

  private rowToDto(r: EditionRow): EditionDto {
    return {
      id: r.id,
      seriesId: r.series_id,
      editionNumber: Number(r.edition_number),
      editionLabel: r.edition_label,
      theme: r.theme,
      coverImageS3Key: r.cover_image_s3_key,
      editorialNote: r.editorial_note,
      status: r.status,
      scheduledPublishAt: r.scheduled_publish_at,
      publishedAt: r.published_at,
      editorId: r.editor_id,
      editorName: r.editor_name,
      approvalRequestId: r.approval_request_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  async listForSeries(seriesId: string): Promise<EditionDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_EDITION_BASE + ' WHERE e.series_id = $1::uuid ORDER BY e.edition_number DESC',
        seriesId,
      );
    })) as EditionRow[];
    return rows.map((r) => this.rowToDto(r));
  }

  async getById(id: string): Promise<EditionDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_EDITION_BASE + ' WHERE e.id = $1::uuid LIMIT 1', id);
    })) as EditionRow[];
    if (rows.length === 0) throw new NotFoundException('Edition not found');
    return this.rowToDto(rows[0]!);
  }

  // Auto-increment edition_number per series. Locks the series row to
  // serialise concurrent edition creates against the same series.
  async create(
    actor: ResolvedActor,
    seriesId: string,
    input: CreateEditionDto,
  ): Promise<EditionDto> {
    await this.assertWriter(actor);
    return this.tenantPrisma.executeInTenantTransaction(async (client) => {
      const seriesRows = (await client.$queryRawUnsafe(
        'SELECT id::text AS id FROM pub_series WHERE id = $1::uuid FOR UPDATE',
        seriesId,
      )) as Array<{ id: string }>;
      if (seriesRows.length === 0) throw new NotFoundException('Series not found');
      const maxRows = (await client.$queryRawUnsafe(
        'SELECT COALESCE(MAX(edition_number), 0)::int AS max_no FROM pub_edition WHERE series_id = $1::uuid',
        seriesId,
      )) as Array<{ max_no: number }>;
      const nextNumber = Number(maxRows[0]!.max_no) + 1;
      const id = generateId();
      await client.$executeRawUnsafe(
        "INSERT INTO pub_edition (id, series_id, edition_number, edition_label, theme, cover_image_s3_key, editorial_note, status, editor_id) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, 'DRAFT', $8::uuid)",
        id,
        seriesId,
        nextNumber,
        input.editionLabel ?? null,
        input.theme ?? null,
        input.coverImageS3Key ?? null,
        input.editorialNote ?? null,
        actor.employeeId ?? null,
      );
      const fresh = (await client.$queryRawUnsafe(
        SELECT_EDITION_BASE + ' WHERE e.id = $1::uuid LIMIT 1',
        id,
      )) as EditionRow[];
      return this.rowToDto(fresh[0]!);
    });
  }

  async patch(actor: ResolvedActor, id: string, input: UpdateEditionDto): Promise<EditionDto> {
    await this.assertWriter(actor);
    return this.tenantPrisma.executeInTenantTransaction(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT status FROM pub_edition WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ status: PublicationStatus }>;
      if (rows.length === 0) throw new NotFoundException('Edition not found');
      const sets: string[] = [];
      const params: unknown[] = [];
      const push = (sql: string, value: unknown) => {
        params.push(value);
        sets.push(`${sql} = $${params.length}`);
      };
      if (input.editionLabel !== undefined) push('edition_label', input.editionLabel);
      if (input.theme !== undefined) push('theme', input.theme);
      if (input.coverImageS3Key !== undefined) push('cover_image_s3_key', input.coverImageS3Key);
      if (input.editorialNote !== undefined) push('editorial_note', input.editorialNote);
      if (input.status !== undefined) {
        const allowed = ALLOWED_TRANSITIONS[rows[0]!.status];
        if (!allowed.includes(input.status)) {
          throw new BadRequestException(
            `Cannot transition edition status ${rows[0]!.status} → ${input.status}.`,
          );
        }
        push('status', input.status);
        if (input.status === 'PUBLISHED') push('published_at', new Date().toISOString());
      }
      if (sets.length === 0) return this.getById(id);
      sets.push('updated_at = now()');
      params.push(id);
      await client.$executeRawUnsafe(
        `UPDATE pub_edition SET ${sets.join(', ')} WHERE id = $${params.length}::uuid`,
        ...params,
      );
      return this.getById(id);
    });
  }
}

@Injectable()
export class PublicationService {
  // Phase 2 Cycle 26 — VersionService is wired via setter (not constructor)
  // to break the circular dependency between PublicationService (which
  // calls captureForStatusChange) and VersionService (which loads
  // PublicationService.composeSnapshot via the access helpers).
  private versionService: { captureForStatusChange: (...args: any[]) => Promise<string> } | null =
    null;

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  setVersionService(svc: { captureForStatusChange: (...args: any[]) => Promise<string> }): void {
    this.versionService = svc;
  }

  private async assertWriter(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'pub-001:write',
      'pub-002:write',
    ]);
    if (!ok) {
      throw new ForbiddenException(
        'Only teachers, editors, or school admins can manage publications.',
      );
    }
  }

  private rowToDto(r: PublicationRow): PublicationDto {
    return {
      id: r.id,
      schoolId: r.school_id,
      title: r.title,
      publicationType: r.publication_type as PublicationDto['publicationType'],
      seriesId: r.series_id,
      seriesTitle: r.series_title,
      editionId: r.edition_id,
      editionNumber: r.edition_number !== null ? Number(r.edition_number) : null,
      createdById: r.created_by,
      createdByName: r.created_by_name,
      status: r.status,
      scheduledPublishAt: r.scheduled_publish_at,
      publishedAt: r.published_at,
      approvalRequestId: r.approval_request_id,
      sectionCount: Number(r.section_count),
      pendingSectionCount: Number(r.pending_section_count),
      recipientCount: Number(r.recipient_count),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  // REVIEW-CYCLE25 BLOCKING 1 — non-writer non-collaborator readers see
  // only PUBLISHED publications. Writers (admin / pub-001:write +
  // pub-002:write STAFF) and collaborators see every status.
  private async isWriterPersona(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    if (actor.personType !== 'STAFF') return false;
    const tenant = getCurrentTenant();
    return this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'pub-001:write',
      'pub-002:write',
    ]);
  }

  async list(
    actor: ResolvedActor,
    filters: { status?: PublicationStatus; seriesId?: string } = {},
  ): Promise<PublicationDto[]> {
    const tenant = getCurrentTenant();
    const isWriter = await this.isWriterPersona(actor);
    const params: unknown[] = [tenant.schoolId];
    let where = ' WHERE p.school_id = $1::uuid';
    if (!isWriter) {
      // Non-writer readers see PUBLISHED only OR publications they
      // collaborate on. PUB-001:read is held by parents and students; this
      // is the privacy boundary between reader and editor surfaces.
      params.push(actor.accountId);
      where += ` AND (p.status = 'PUBLISHED' OR EXISTS (SELECT 1 FROM pub_publication_collaborators c WHERE c.publication_id = p.id AND c.user_id = $${params.length}::uuid))`;
    }
    if (filters.status) {
      params.push(filters.status);
      where += ` AND p.status = $${params.length}`;
    }
    if (filters.seriesId) {
      params.push(filters.seriesId);
      where += ` AND p.series_id = $${params.length}::uuid`;
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_PUBLICATION_BASE + where + ' ORDER BY COALESCE(p.published_at, p.created_at) DESC',
        ...params,
      );
    })) as PublicationRow[];
    return rows.map((r) => this.rowToDto(r));
  }

  async getById(id: string, actor: ResolvedActor): Promise<PublicationDetailDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_PUBLICATION_BASE + ' WHERE p.id = $1::uuid AND p.school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      );
    })) as PublicationRow[];
    if (rows.length === 0) throw new NotFoundException('Publication not found');
    // BLOCKING 1 — non-writer non-collaborator can only read PUBLISHED.
    const row = rows[0]!;
    const isWriter = await this.isWriterPersona(actor);
    if (!isWriter && row.status !== 'PUBLISHED') {
      const collab = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT 1 FROM pub_publication_collaborators WHERE publication_id = $1::uuid AND user_id = $2::uuid LIMIT 1',
          id,
          actor.accountId,
        );
      })) as Array<unknown>;
      if (collab.length === 0) {
        // Don't-leak-existence collapsed 404.
        throw new NotFoundException('Publication not found');
      }
    }
    const collaborators = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        "SELECT c.id::text AS id, c.publication_id::text AS publication_id, c.user_id::text AS user_id, c.role, c.invited_by::text AS invited_by, c.invited_at::text AS invited_at, c.accepted_at::text AS accepted_at, (SELECT ip.first_name || ' ' || ip.last_name FROM platform.platform_users pu JOIN platform.iam_person ip ON ip.id = pu.person_id WHERE pu.id = c.user_id LIMIT 1) AS user_name FROM pub_publication_collaborators c WHERE c.publication_id = $1::uuid ORDER BY c.invited_at",
        id,
      );
    })) as Array<{
      id: string;
      publication_id: string;
      user_id: string;
      user_name: string | null;
      role: CollaboratorRole;
      invited_by: string | null;
      invited_at: string;
      accepted_at: string | null;
    }>;
    return {
      ...this.rowToDto(row),
      collaborators: collaborators.map((c) => ({
        id: c.id,
        publicationId: c.publication_id,
        userId: c.user_id,
        userName: c.user_name,
        role: c.role,
        invitedById: c.invited_by,
        invitedAt: c.invited_at,
        acceptedAt: c.accepted_at,
      })),
    };
  }

  async create(actor: ResolvedActor, input: CreatePublicationDto): Promise<PublicationDto> {
    await this.assertWriter(actor);
    const tenant = getCurrentTenant();
    if (input.editionId && !input.seriesId) {
      throw new BadRequestException('seriesId is required when editionId is set.');
    }
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        "INSERT INTO pub_publications (id, school_id, title, publication_type, series_id, edition_id, created_by, status) VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6::uuid, $7::uuid, 'DRAFT')",
        id,
        tenant.schoolId,
        input.title,
        input.publicationType,
        input.seriesId ?? null,
        input.editionId ?? null,
        actor.accountId,
      );
    });
    const detail = await this.getById(id, actor);
    return detail;
  }

  // ADR-035 KEYSTONE — student-authored sections require approval before
  // the parent publication can advance to APPROVED. The Step 5 guard reads
  // pending_section_count and refuses APPROVED transitions when any
  // section has is_approved=false.
  async patchStatus(
    actor: ResolvedActor,
    id: string,
    input: UpdatePublicationStatusDto,
  ): Promise<PublicationDto> {
    await this.assertWriter(actor);
    return this.tenantPrisma.executeInTenantTransaction(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT status FROM pub_publications WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ status: PublicationStatus }>;
      if (rows.length === 0) throw new NotFoundException('Publication not found');
      const allowed = ALLOWED_TRANSITIONS[rows[0]!.status];
      if (!allowed.includes(input.status)) {
        throw new BadRequestException(
          `Cannot transition publication status ${rows[0]!.status} → ${input.status}.`,
        );
      }
      // ADR-035 gate: all sections must be approved before APPROVED.
      if (input.status === 'APPROVED') {
        const pending = (await client.$queryRawUnsafe(
          'SELECT COUNT(*)::int AS n FROM pub_sections WHERE publication_id = $1::uuid AND is_approved = false',
          id,
        )) as Array<{ n: number }>;
        if (Number(pending[0]!.n) > 0) {
          throw new BadRequestException(
            'Cannot approve a publication while sections remain pending approval (ADR-035).',
          );
        }
      }
      const sets: string[] = ['status = $1', 'updated_at = now()'];
      const params: unknown[] = [input.status];
      if (input.status === 'PUBLISHED') {
        params.push(new Date().toISOString());
        sets.push(`published_at = $${params.length}`);
      }
      params.push(id);
      await client.$executeRawUnsafe(
        `UPDATE pub_publications SET ${sets.join(', ')} WHERE id = $${params.length}::uuid`,
        ...params,
      );
      // Phase 2 Cycle 26 — auto-create a STATUS_CHANGE version inside the
      // same locked tx so the version trail captures every transition. The
      // hook is best-effort — if VersionService isn't wired yet (unit
      // tests without the bridge) we skip silently.
      if (this.versionService) {
        await this.versionService.captureForStatusChange(
          client,
          id,
          actor.accountId,
          `Status: ${rows[0]!.status} → ${input.status}`,
        );
      }
      return this.getById(id, actor);
    });
  }
}

@Injectable()
export class CollaboratorService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async invite(
    actor: ResolvedActor,
    publicationId: string,
    input: InviteCollaboratorDto,
  ): Promise<PublicationCollaboratorDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (client) => {
      const exists = (await client.$queryRawUnsafe(
        'SELECT 1 FROM pub_publications WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        publicationId,
        tenant.schoolId,
      )) as Array<unknown>;
      if (exists.length === 0) throw new NotFoundException('Publication not found');
      // BLOCKING 4 — soft platform_users.id ref must point at a current-
      // tenant user (sis_students / sis_guardians / hr_employees projection).
      await assertAccountInCurrentTenant(this.tenantPrisma, input.userId, 'userId');
      const id = generateId();
      try {
        await client.$executeRawUnsafe(
          'INSERT INTO pub_publication_collaborators (id, publication_id, user_id, role, invited_by) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid)',
          id,
          publicationId,
          input.userId,
          input.role,
          actor.accountId,
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException('User is already a collaborator on this publication.');
        }
        throw err;
      }
      const fresh = (await client.$queryRawUnsafe(
        "SELECT c.id::text AS id, c.publication_id::text AS publication_id, c.user_id::text AS user_id, c.role, c.invited_by::text AS invited_by, c.invited_at::text AS invited_at, c.accepted_at::text AS accepted_at, (SELECT ip.first_name || ' ' || ip.last_name FROM platform.platform_users pu JOIN platform.iam_person ip ON ip.id = pu.person_id WHERE pu.id = c.user_id LIMIT 1) AS user_name FROM pub_publication_collaborators c WHERE c.id = $1::uuid LIMIT 1",
        id,
      )) as Array<{
        id: string;
        publication_id: string;
        user_id: string;
        user_name: string | null;
        role: CollaboratorRole;
        invited_by: string | null;
        invited_at: string;
        accepted_at: string | null;
      }>;
      const r = fresh[0]!;
      return {
        id: r.id,
        publicationId: r.publication_id,
        userId: r.user_id,
        userName: r.user_name,
        role: r.role,
        invitedById: r.invited_by,
        invitedAt: r.invited_at,
        acceptedAt: r.accepted_at,
      };
    });
  }

  async remove(actor: ResolvedActor, collaboratorId: string): Promise<void> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only school admins can remove collaborators.');
    }
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'DELETE FROM pub_publication_collaborators WHERE id = $1::uuid',
        collaboratorId,
      );
    });
  }
}
