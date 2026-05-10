import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import {
  CreateMediaAssetDto,
  CreateTeamPhotoDto,
  MediaAssetResponseDto,
  MediaAssetType,
  PhotoType,
  TeamPhotoResponseDto,
} from './dto/athletics-advanced.dto';

interface PhotoRow {
  id: string;
  roster_id: string;
  photo_type: string;
  s3_key: string;
  caption: string | null;
  uploaded_by: string | null;
  uploaded_by_name: string | null;
  uploaded_at: string;
  created_at: string;
  updated_at: string;
}

const SELECT_PHOTO =
  'SELECT t.id::text AS id, t.roster_id::text AS roster_id, t.photo_type, t.s3_key, t.caption, ' +
  't.uploaded_by::text AS uploaded_by, ' +
  "(p.first_name || ' ' || p.last_name) AS uploaded_by_name, " +
  'TO_CHAR(t.uploaded_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS uploaded_at, ' +
  'TO_CHAR(t.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(t.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM ath_team_photos t LEFT JOIN platform.iam_person p ON p.id = t.uploaded_by ';

interface MediaAssetRow {
  id: string;
  school_id: string;
  programme_id: string | null;
  programme_name: string | null;
  asset_type: string;
  s3_key: string;
  title: string | null;
  description: string | null;
  season_id: string | null;
  uploaded_by: string | null;
  uploaded_by_name: string | null;
  uploaded_at: string;
  created_at: string;
  updated_at: string;
}

const SELECT_MEDIA =
  'SELECT m.id::text AS id, m.school_id::text AS school_id, m.programme_id::text AS programme_id, ' +
  'pr.sport_name AS programme_name, m.asset_type, m.s3_key, m.title, m.description, ' +
  'm.season_id::text AS season_id, m.uploaded_by::text AS uploaded_by, ' +
  "(p.first_name || ' ' || p.last_name) AS uploaded_by_name, " +
  'TO_CHAR(m.uploaded_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS uploaded_at, ' +
  'TO_CHAR(m.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(m.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM ath_media_assets m ' +
  'LEFT JOIN ath_programmes pr ON pr.id = m.programme_id ' +
  'LEFT JOIN platform.iam_person p ON p.id = m.uploaded_by ';

function rowToPhotoDto(r: PhotoRow): TeamPhotoResponseDto {
  return {
    id: r.id,
    rosterId: r.roster_id,
    photoType: r.photo_type as PhotoType,
    s3Key: r.s3_key,
    caption: r.caption,
    uploadedBy: r.uploaded_by,
    uploadedByName: r.uploaded_by_name,
    uploadedAt: r.uploaded_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToMediaDto(r: MediaAssetRow): MediaAssetResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    programmeId: r.programme_id,
    programmeName: r.programme_name,
    assetType: r.asset_type as MediaAssetType,
    s3Key: r.s3_key,
    title: r.title,
    description: r.description,
    seasonId: r.season_id,
    uploadedBy: r.uploaded_by,
    uploadedByName: r.uploaded_by_name,
    uploadedAt: r.uploaded_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

@Injectable()
export class TeamMediaService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  async hasMediaScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'ath-001:write',
    ]);
  }

  // ── Team photos ────────────────────────────────────────────────

  async listForRoster(rosterId: string): Promise<TeamPhotoResponseDto[]> {
    const tenant = getCurrentTenant();
    // Verify roster belongs to this school
    const r = await this.tenantPrisma.executeInTenantContext((client) =>
      client.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT r.id FROM ath_rosters r JOIN ath_seasons s ON s.id = r.season_id JOIN ath_programmes p ON p.id = s.programme_id WHERE r.id = $1::uuid AND p.school_id = $2::uuid',
        rosterId,
        tenant.schoolId,
      ),
    );
    if (r.length === 0) throw new NotFoundException('Roster not found');
    const rows = await this.tenantPrisma.executeInTenantContext((client) =>
      client.$queryRawUnsafe<PhotoRow[]>(
        SELECT_PHOTO + 'WHERE t.roster_id = $1::uuid ORDER BY t.uploaded_at DESC LIMIT 200',
        rosterId,
      ),
    );
    return rows.map(rowToPhotoDto);
  }

  async createPhoto(
    input: CreateTeamPhotoDto,
    actor: ResolvedActor,
  ): Promise<TeamPhotoResponseDto> {
    if (!(await this.hasMediaScope(actor))) {
      throw new ForbiddenException('Only the AD or admin can upload team photos');
    }
    const tenant = getCurrentTenant();
    // Validate roster in this school
    const r = await this.tenantPrisma.executeInTenantContext((client) =>
      client.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT r.id FROM ath_rosters r JOIN ath_seasons s ON s.id = r.season_id JOIN ath_programmes p ON p.id = s.programme_id WHERE r.id = $1::uuid AND p.school_id = $2::uuid',
        input.rosterId,
        tenant.schoolId,
      ),
    );
    if (r.length === 0) {
      throw new NotFoundException('Roster not found');
    }
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext((client) =>
      client.$executeRawUnsafe(
        'INSERT INTO ath_team_photos (id, roster_id, photo_type, s3_key, caption, uploaded_by) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid)',
        id,
        input.rosterId,
        input.photoType,
        input.s3Key,
        input.caption ?? null,
        actor.personId,
      ),
    );
    const rows = await this.tenantPrisma.executeInTenantContext((client) =>
      client.$queryRawUnsafe<PhotoRow[]>(SELECT_PHOTO + 'WHERE t.id = $1::uuid', id),
    );
    return rowToPhotoDto(rows[0]!);
  }

  // ── Media assets ────────────────────────────────────────────────

  async listForProgramme(programmeId: string): Promise<MediaAssetResponseDto[]> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext((client) =>
      client.$queryRawUnsafe<MediaAssetRow[]>(
        SELECT_MEDIA +
          'WHERE m.programme_id = $1::uuid AND m.school_id = $2::uuid ORDER BY m.uploaded_at DESC LIMIT 200',
        programmeId,
        tenant.schoolId,
      ),
    );
    return rows.map(rowToMediaDto);
  }

  async listMedia(filters: {
    programmeId?: string;
    assetType?: MediaAssetType;
    seasonId?: string;
  }): Promise<MediaAssetResponseDto[]> {
    const tenant = getCurrentTenant();
    const sql: string[] = [SELECT_MEDIA, 'WHERE m.school_id = $1::uuid '];
    const params: unknown[] = [tenant.schoolId];
    if (filters.programmeId) {
      params.push(filters.programmeId);
      sql.push('AND m.programme_id = $' + params.length + '::uuid ');
    }
    if (filters.assetType) {
      params.push(filters.assetType);
      sql.push('AND m.asset_type = $' + params.length + ' ');
    }
    if (filters.seasonId) {
      params.push(filters.seasonId);
      sql.push('AND m.season_id = $' + params.length + '::uuid ');
    }
    sql.push('ORDER BY m.uploaded_at DESC LIMIT 500');
    const rows = await this.tenantPrisma.executeInTenantContext((client) =>
      client.$queryRawUnsafe<MediaAssetRow[]>(sql.join(''), ...params),
    );
    return rows.map(rowToMediaDto);
  }

  async createAsset(
    input: CreateMediaAssetDto,
    actor: ResolvedActor,
  ): Promise<MediaAssetResponseDto> {
    if (!(await this.hasMediaScope(actor))) {
      throw new ForbiddenException('Only the AD or admin can upload media assets');
    }
    const tenant = getCurrentTenant();
    if (input.programmeId) {
      const prog = await this.tenantPrisma.executeInTenantContext((client) =>
        client.$queryRawUnsafe<Array<{ id: string }>>(
          'SELECT id FROM ath_programmes WHERE id = $1::uuid AND school_id = $2::uuid',
          input.programmeId,
          tenant.schoolId,
        ),
      );
      if (prog.length === 0) {
        throw new NotFoundException('Programme not found');
      }
    }
    // REVIEW-P2-8 MAJOR 1 — validate seasonId belongs to the current
    // school via ath_seasons → ath_programmes.school_id chain. If both
    // programmeId and seasonId are supplied, also enforce the season
    // belongs to that programme.
    if (input.seasonId) {
      const seasonSql =
        input.programmeId !== undefined
          ? 'SELECT s.id FROM ath_seasons s JOIN ath_programmes pr ON pr.id = s.programme_id WHERE s.id = $1::uuid AND pr.school_id = $2::uuid AND s.programme_id = $3::uuid'
          : 'SELECT s.id FROM ath_seasons s JOIN ath_programmes pr ON pr.id = s.programme_id WHERE s.id = $1::uuid AND pr.school_id = $2::uuid';
      const seasonArgs: unknown[] =
        input.programmeId !== undefined
          ? [input.seasonId, tenant.schoolId, input.programmeId]
          : [input.seasonId, tenant.schoolId];
      const seasonRows = (await this.tenantPrisma.executeInTenantContext((client) =>
        client.$queryRawUnsafe<Array<{ id: string }>>(seasonSql, ...seasonArgs),
      )) as Array<{ id: string }>;
      if (seasonRows.length === 0) {
        throw new BadRequestException(
          input.programmeId !== undefined
            ? 'seasonId does not match a season for this programme in this school'
            : 'seasonId does not match a season in this school',
        );
      }
    }
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext((client) =>
      client.$executeRawUnsafe(
        'INSERT INTO ath_media_assets (id, school_id, programme_id, asset_type, s3_key, title, description, season_id, uploaded_by) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::uuid, $9::uuid)',
        id,
        tenant.schoolId,
        input.programmeId ?? null,
        input.assetType,
        input.s3Key,
        input.title ?? null,
        input.description ?? null,
        input.seasonId ?? null,
        actor.personId,
      ),
    );
    const rows = await this.tenantPrisma.executeInTenantContext((client) =>
      client.$queryRawUnsafe<MediaAssetRow[]>(SELECT_MEDIA + 'WHERE m.id = $1::uuid', id),
    );
    return rowToMediaDto(rows[0]!);
  }
}
