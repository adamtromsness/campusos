import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import { GroupService } from '@modules/m103-groups';
import { assertGroupInCurrentSchool } from '../groups/access';
import {
  CreateResourceDto,
  CreateResourceVersionDto,
  ResourceResponseDto,
  ResourceType,
  ResourceVersionResponseDto,
  UpdateResourceDto,
} from '../groups/dto/groups-advanced.dto';

interface ResourceRow {
  id: string;
  group_id: string;
  title: string;
  description: string | null;
  resource_type: string;
  s3_key: string | null;
  url: string | null;
  uploaded_by: string;
  version: number;
  is_pinned: boolean;
  created_at: Date;
  updated_at: Date;
}

interface VersionRow {
  id: string;
  version_number: number;
  s3_key: string | null;
  url: string | null;
  uploaded_by: string;
  change_notes: string | null;
  created_at: Date;
}

/**
 * ResourceLibraryService — P2-28a Step 2.
 *
 * Group-scoped resource library with version tracking. New-version
 * INSERT runs inside one tenant tx that also increments
 * grp_resource_library.version — version is monotonic per resource.
 *
 * Any active member can upload; group OWNER / ADMIN / school admin
 * can pin / unpin and delete.
 */
@Injectable()
export class ResourceLibraryService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly groups: GroupService,
  ) {}

  private async assertGroupMember(groupId: string, actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const group = await this.groups.getById(groupId, actor);
    if (!group.myMembership || group.myMembership.status !== 'ACTIVE') {
      throw new ForbiddenException('Only active group members can use this library');
    }
  }

  async create(
    groupId: string,
    input: CreateResourceDto,
    actor: ResolvedActor,
  ): Promise<ResourceResponseDto> {
    // REVIEW-P2C28 Round 1 BLOCKING 2 — school admins still validate
    // the target group belongs to the current school before insert.
    await assertGroupInCurrentSchool(this.tenantPrisma, groupId);
    await this.assertGroupMember(groupId, actor);
    if (!input.s3Key && !input.url) {
      throw new BadRequestException('Either s3Key or url must be provided');
    }
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO grp_resource_library (id, group_id, title, description, resource_type, s3_key, url, uploaded_by, version, is_pinned) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::uuid, 1, $9)',
        id,
        groupId,
        input.title,
        input.description ?? null,
        input.resourceType,
        input.s3Key ?? null,
        input.url ?? null,
        actor.accountId,
        input.isPinned ?? false,
      );
    });
    return this.getById(id, actor);
  }

  async listForGroup(groupId: string, actor: ResolvedActor): Promise<ResourceResponseDto[]> {
    await this.assertGroupMember(groupId, actor);
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, group_id::text AS group_id, title, description, resource_type, s3_key, url, ' +
          'uploaded_by::text AS uploaded_by, version, is_pinned, created_at, updated_at ' +
          'FROM grp_resource_library WHERE group_id = $1::uuid ' +
          'ORDER BY is_pinned DESC, created_at DESC LIMIT 200',
        groupId,
      );
    })) as ResourceRow[];
    return rows.map((r) => this.rowToDto(r));
  }

  async getById(resourceId: string, actor: ResolvedActor): Promise<ResourceResponseDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, group_id::text AS group_id, title, description, resource_type, s3_key, url, ' +
          'uploaded_by::text AS uploaded_by, version, is_pinned, created_at, updated_at ' +
          'FROM grp_resource_library WHERE id = $1::uuid LIMIT 1',
        resourceId,
      );
    })) as ResourceRow[];
    if (rows.length === 0) throw new NotFoundException('Resource not found');
    await this.assertGroupMember(rows[0]!.group_id, actor);
    return this.rowToDto(rows[0]!);
  }

  async patch(
    resourceId: string,
    input: UpdateResourceDto,
    actor: ResolvedActor,
  ): Promise<ResourceResponseDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT group_id::text AS group_id, uploaded_by::text AS uploaded_by FROM grp_resource_library WHERE id = $1::uuid LIMIT 1',
        resourceId,
      );
    })) as Array<{ group_id: string; uploaded_by: string }>;
    if (rows.length === 0) throw new NotFoundException('Resource not found');
    // REVIEW-P2C28 MAJOR 1 — parent group must belong to current school
    await assertGroupInCurrentSchool(this.tenantPrisma, rows[0]!.group_id);
    if (!actor.isSchoolAdmin && rows[0]!.uploaded_by !== actor.accountId) {
      await this.groups.assertCanManageGroup(rows[0]!.group_id, actor);
    }

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
    if (input.isPinned !== undefined) {
      sets.push('is_pinned = $' + (params.length + 1));
      params.push(input.isPinned);
    }
    if (sets.length > 0) {
      sets.push('updated_at = now()');
      params.push(resourceId);
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'UPDATE grp_resource_library SET ' +
            sets.join(', ') +
            ' WHERE id = $' +
            params.length +
            '::uuid',
          ...params,
        );
      });
    }
    return this.getById(resourceId, actor);
  }

  async remove(resourceId: string, actor: ResolvedActor): Promise<{ ok: true }> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT group_id::text AS group_id, uploaded_by::text AS uploaded_by FROM grp_resource_library WHERE id = $1::uuid LIMIT 1',
        resourceId,
      );
    })) as Array<{ group_id: string; uploaded_by: string }>;
    if (rows.length === 0) throw new NotFoundException('Resource not found');
    // REVIEW-P2C28 MAJOR 1 — parent group must belong to current school
    await assertGroupInCurrentSchool(this.tenantPrisma, rows[0]!.group_id);
    if (!actor.isSchoolAdmin && rows[0]!.uploaded_by !== actor.accountId) {
      await this.groups.assertCanManageGroup(rows[0]!.group_id, actor);
    }
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'DELETE FROM grp_resource_library WHERE id = $1::uuid',
        resourceId,
      );
    });
    return { ok: true };
  }

  /**
   * New version KEYSTONE — atomic version increment.
   *
   * 1. Lock the parent grp_resource_library row.
   * 2. Read the existing version.
   * 3. INSERT a grp_resource_versions row at version_number = version+1.
   * 4. UPDATE grp_resource_library.version = version+1 and update target
   *    (s3_key / url) so the public DTO reflects the latest.
   */
  async addVersion(
    resourceId: string,
    input: CreateResourceVersionDto,
    actor: ResolvedActor,
  ): Promise<ResourceVersionResponseDto> {
    if (!input.s3Key && !input.url) {
      throw new BadRequestException('Either s3Key or url must be provided');
    }
    const versionId = generateId();
    let newVersion = 0;
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, group_id::text AS group_id, version FROM grp_resource_library WHERE id = $1::uuid FOR UPDATE',
        resourceId,
      )) as Array<{ id: string; group_id: string; version: number }>;
      if (lockRows.length === 0) throw new NotFoundException('Resource not found');
      // REVIEW-P2C28 MAJOR 1 — parent group must belong to current school
      await assertGroupInCurrentSchool(this.tenantPrisma, lockRows[0]!.group_id);
      await this.assertGroupMember(lockRows[0]!.group_id, actor);
      newVersion = lockRows[0]!.version + 1;

      await tx.$executeRawUnsafe(
        'INSERT INTO grp_resource_versions (id, resource_id, version_number, s3_key, url, uploaded_by, change_notes) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7)',
        versionId,
        resourceId,
        newVersion,
        input.s3Key ?? null,
        input.url ?? null,
        actor.accountId,
        input.changeNotes ?? null,
      );

      await tx.$executeRawUnsafe(
        'UPDATE grp_resource_library SET version = $1, s3_key = $2, url = $3, updated_at = now() WHERE id = $4::uuid',
        newVersion,
        input.s3Key ?? null,
        input.url ?? null,
        resourceId,
      );
    });

    const versionRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, version_number, s3_key, url, uploaded_by::text AS uploaded_by, change_notes, created_at ' +
          'FROM grp_resource_versions WHERE id = $1::uuid LIMIT 1',
        versionId,
      );
    })) as VersionRow[];
    return this.versionRowToDto(versionRows[0]!);
  }

  async listVersions(
    resourceId: string,
    actor: ResolvedActor,
  ): Promise<ResourceVersionResponseDto[]> {
    await this.getById(resourceId, actor); // also asserts membership
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, version_number, s3_key, url, uploaded_by::text AS uploaded_by, change_notes, created_at ' +
          'FROM grp_resource_versions WHERE resource_id = $1::uuid ORDER BY version_number DESC',
        resourceId,
      );
    })) as VersionRow[];
    return rows.map((r) => this.versionRowToDto(r));
  }

  private rowToDto(r: ResourceRow): ResourceResponseDto {
    return {
      id: r.id,
      groupId: r.group_id,
      title: r.title,
      description: r.description,
      resourceType: r.resource_type as ResourceType,
      s3Key: r.s3_key,
      url: r.url,
      uploadedBy: r.uploaded_by,
      version: r.version,
      isPinned: r.is_pinned,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    };
  }

  private versionRowToDto(r: VersionRow): ResourceVersionResponseDto {
    return {
      id: r.id,
      versionNumber: r.version_number,
      s3Key: r.s3_key,
      url: r.url,
      uploadedBy: r.uploaded_by,
      changeNotes: r.change_notes,
      createdAt: r.created_at.toISOString(),
    };
  }
}
