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
  CreateProgrammeDto,
  ProgrammeResponseDto,
  ProgrammeSeason,
  RosterLevel,
  UpdateProgrammeDto,
} from './dto/athletics.dto';

interface ProgrammeRow {
  id: string;
  school_id: string;
  sport_name: string;
  season: string;
  levels_offered: string[];
  max_roster_size_per_level: Record<string, number> | null;
  min_gpa: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

const SELECT_PROGRAMME =
  'SELECT id::text AS id, school_id::text AS school_id, sport_name, season, levels_offered, ' +
  'max_roster_size_per_level, min_gpa::text AS min_gpa, is_active, ' +
  'TO_CHAR(created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM ath_programmes ';

function rowToDto(r: ProgrammeRow): ProgrammeResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    sportName: r.sport_name,
    season: r.season as ProgrammeSeason,
    levelsOffered: r.levels_offered as RosterLevel[],
    maxRosterSizePerLevel: r.max_roster_size_per_level,
    minGpa: r.min_gpa === null ? null : Number(r.min_gpa),
    isActive: r.is_active,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

@Injectable()
export class ProgrammeService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  /**
   * AD scope: admin OR holds ath-001:write — the canonical signal
   * the IAM seed grants only to Staff (covering the AD).
   */
  async hasAdScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'ath-001:write',
    ]);
  }

  async list(filters: {
    season?: ProgrammeSeason;
    sport?: string;
    includeInactive?: boolean;
  }): Promise<ProgrammeResponseDto[]> {
    const tenant = getCurrentTenant();
    const sql: string[] = [SELECT_PROGRAMME, 'WHERE school_id = $1::uuid '];
    const params: unknown[] = [tenant.schoolId];
    if (!filters.includeInactive) {
      sql.push('AND is_active = true ');
    }
    if (filters.season) {
      params.push(filters.season);
      sql.push('AND season = $' + params.length + ' ');
    }
    if (filters.sport) {
      params.push('%' + filters.sport + '%');
      sql.push('AND sport_name ILIKE $' + params.length + ' ');
    }
    sql.push('ORDER BY season ASC, sport_name ASC LIMIT 200');
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ProgrammeRow[]>(sql.join(''), ...params);
    });
    return rows.map(rowToDto);
  }

  async getById(id: string): Promise<ProgrammeResponseDto> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ProgrammeRow[]>(
        SELECT_PROGRAMME + 'WHERE id = $1::uuid AND school_id = $2::uuid',
        id,
        tenant.schoolId,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Programme not found');
    return rowToDto(rows[0]!);
  }

  async loadActiveOrFail(id: string): Promise<ProgrammeResponseDto> {
    const programme = await this.getById(id);
    if (!programme.isActive) {
      throw new BadRequestException(
        'Programme "' + programme.sportName + '" is inactive. Reactivate before adding seasons.',
      );
    }
    return programme;
  }

  async create(input: CreateProgrammeDto, actor: ResolvedActor): Promise<ProgrammeResponseDto> {
    if (!(await this.hasAdScope(actor))) {
      throw new ForbiddenException('Only the Athletic Director or admin can create programmes');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO ath_programmes (id, school_id, sport_name, season, levels_offered, max_roster_size_per_level, min_gpa, is_active) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5::text[], $6::jsonb, $7, $8)',
          id,
          tenant.schoolId,
          input.sportName,
          input.season,
          input.levelsOffered,
          input.maxRosterSizePerLevel ? JSON.stringify(input.maxRosterSizePerLevel) : null,
          input.minGpa ?? null,
          input.isActive ?? true,
        );
      });
    } catch (e) {
      if (this.isUniqueViolation(e)) {
        throw new BadRequestException(
          'A programme named "' + input.sportName + '" already exists in this school.',
        );
      }
      throw e;
    }
    return this.getById(id);
  }

  async patch(
    id: string,
    input: UpdateProgrammeDto,
    actor: ResolvedActor,
  ): Promise<ProgrammeResponseDto> {
    if (!(await this.hasAdScope(actor))) {
      throw new ForbiddenException('Only the Athletic Director or admin can edit programmes');
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.sportName !== undefined) {
      params.push(input.sportName);
      sets.push('sport_name = $' + params.length);
    }
    if (input.season !== undefined) {
      params.push(input.season);
      sets.push('season = $' + params.length);
    }
    if (input.levelsOffered !== undefined) {
      params.push(input.levelsOffered);
      sets.push('levels_offered = $' + params.length + '::text[]');
    }
    if (input.maxRosterSizePerLevel !== undefined) {
      params.push(JSON.stringify(input.maxRosterSizePerLevel));
      sets.push('max_roster_size_per_level = $' + params.length + '::jsonb');
    }
    if (input.minGpa !== undefined) {
      params.push(input.minGpa);
      sets.push('min_gpa = $' + params.length);
    }
    if (input.isActive !== undefined) {
      params.push(input.isActive);
      sets.push('is_active = $' + params.length);
    }
    if (sets.length === 0) return this.getById(id);
    sets.push('updated_at = now()');
    params.push(id);
    const sql =
      'UPDATE ath_programmes SET ' + sets.join(', ') + ' WHERE id = $' + params.length + '::uuid';
    try {
      const updated = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$executeRawUnsafe(sql, ...params);
      });
      if (updated === 0) throw new NotFoundException('Programme not found');
    } catch (e) {
      if (this.isUniqueViolation(e)) {
        throw new BadRequestException(
          'A programme with that sport name already exists in this school.',
        );
      }
      throw e;
    }
    return this.getById(id);
  }

  private isUniqueViolation(err: unknown): boolean {
    const e = err as { code?: string; meta?: { code?: string }; message?: string };
    if (e?.code === 'P2010' && e?.meta?.code === '23505') return true;
    if (e?.code === '23505') return true;
    if (typeof e?.message === 'string' && e.message.includes('23505')) return true;
    return false;
  }
}
