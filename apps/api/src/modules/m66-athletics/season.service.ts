import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { ProgrammeService } from './programme.service';
import {
  CreateSeasonDto,
  SeasonResponseDto,
  SeasonStatus,
  UpdateSeasonDto,
} from './dto/athletics.dto';

interface SeasonRow {
  id: string;
  programme_id: string;
  programme_name: string | null;
  academic_year: string;
  first_practice_date: string | null;
  first_game_date: string | null;
  last_game_date: string | null;
  playoff_cutoff_date: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

const SELECT_SEASON =
  'SELECT s.id::text AS id, s.programme_id::text AS programme_id, ' +
  'p.sport_name AS programme_name, s.academic_year, ' +
  "TO_CHAR(s.first_practice_date, 'YYYY-MM-DD') AS first_practice_date, " +
  "TO_CHAR(s.first_game_date, 'YYYY-MM-DD') AS first_game_date, " +
  "TO_CHAR(s.last_game_date, 'YYYY-MM-DD') AS last_game_date, " +
  "TO_CHAR(s.playoff_cutoff_date, 'YYYY-MM-DD') AS playoff_cutoff_date, " +
  's.status, ' +
  'TO_CHAR(s.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(s.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM ath_seasons s JOIN ath_programmes p ON p.id = s.programme_id ';

function rowToDto(r: SeasonRow): SeasonResponseDto {
  return {
    id: r.id,
    programmeId: r.programme_id,
    programmeName: r.programme_name ?? undefined,
    academicYear: r.academic_year,
    firstPracticeDate: r.first_practice_date,
    firstGameDate: r.first_game_date,
    lastGameDate: r.last_game_date,
    playoffCutoffDate: r.playoff_cutoff_date,
    status: r.status as SeasonStatus,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

@Injectable()
export class SeasonService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly programmes: ProgrammeService,
  ) {}

  async listForProgramme(programmeId: string): Promise<SeasonResponseDto[]> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<SeasonRow[]>(
        SELECT_SEASON +
          'WHERE p.school_id = $1::uuid AND s.programme_id = $2::uuid ' +
          'ORDER BY s.academic_year DESC LIMIT 100',
        tenant.schoolId,
        programmeId,
      );
    });
    return rows.map(rowToDto);
  }

  async getById(id: string): Promise<SeasonResponseDto> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<SeasonRow[]>(
        SELECT_SEASON + 'WHERE s.id = $1::uuid AND p.school_id = $2::uuid',
        id,
        tenant.schoolId,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Season not found');
    return rowToDto(rows[0]!);
  }

  async create(
    programmeId: string,
    input: CreateSeasonDto,
    actor: ResolvedActor,
  ): Promise<SeasonResponseDto> {
    if (!(await this.programmes.hasAdScope(actor))) {
      throw new ForbiddenException('Only the Athletic Director or admin can create seasons');
    }
    await this.programmes.loadActiveOrFail(programmeId);
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO ath_seasons (id, programme_id, academic_year, first_practice_date, first_game_date, last_game_date, playoff_cutoff_date, status) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4::date, $5::date, $6::date, $7::date, $8)',
          id,
          programmeId,
          input.academicYear,
          input.firstPracticeDate ?? null,
          input.firstGameDate ?? null,
          input.lastGameDate ?? null,
          input.playoffCutoffDate ?? null,
          input.status ?? 'UPCOMING',
        );
      });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === '23505') {
        throw new BadRequestException(
          'A season for academic year "' +
            input.academicYear +
            '" already exists for this programme.',
        );
      }
      if (code === '23514') {
        throw new BadRequestException(
          'Season dates are inconsistent. last_game_date must be on or after first_game_date and first_game_date on or after first_practice_date.',
        );
      }
      throw e;
    }
    return this.getById(id);
  }

  async patch(
    id: string,
    input: UpdateSeasonDto,
    actor: ResolvedActor,
  ): Promise<SeasonResponseDto> {
    if (!(await this.programmes.hasAdScope(actor))) {
      throw new ForbiddenException('Only the Athletic Director or admin can edit seasons');
    }
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Lock row
      const lockedRows = (await tx.$queryRawUnsafe(
        'SELECT id FROM ath_seasons WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ id: string }>;
      if (lockedRows.length === 0) throw new NotFoundException('Season not found');

      const sets: string[] = [];
      const params: unknown[] = [];
      if (input.academicYear !== undefined) {
        params.push(input.academicYear);
        sets.push('academic_year = $' + params.length);
      }
      if (input.firstPracticeDate !== undefined) {
        params.push(input.firstPracticeDate);
        sets.push('first_practice_date = $' + params.length + '::date');
      }
      if (input.firstGameDate !== undefined) {
        params.push(input.firstGameDate);
        sets.push('first_game_date = $' + params.length + '::date');
      }
      if (input.lastGameDate !== undefined) {
        params.push(input.lastGameDate);
        sets.push('last_game_date = $' + params.length + '::date');
      }
      if (input.playoffCutoffDate !== undefined) {
        params.push(input.playoffCutoffDate);
        sets.push('playoff_cutoff_date = $' + params.length + '::date');
      }
      if (input.status !== undefined) {
        params.push(input.status);
        sets.push('status = $' + params.length);
      }
      if (sets.length === 0) {
        const tenant = getCurrentTenant();
        const rows = (await tx.$queryRawUnsafe(
          SELECT_SEASON + 'WHERE s.id = $1::uuid AND p.school_id = $2::uuid',
          id,
          tenant.schoolId,
        )) as SeasonRow[];
        return rowToDto(rows[0]!);
      }
      sets.push('updated_at = now()');
      params.push(id);
      try {
        await tx.$executeRawUnsafe(
          'UPDATE ath_seasons SET ' + sets.join(', ') + ' WHERE id = $' + params.length + '::uuid',
          ...params,
        );
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === '23514') {
          throw new BadRequestException(
            'Season dates are inconsistent. last_game_date must be on or after first_game_date.',
          );
        }
        throw e;
      }
      const tenant = getCurrentTenant();
      const rows = (await tx.$queryRawUnsafe(
        SELECT_SEASON + 'WHERE s.id = $1::uuid AND p.school_id = $2::uuid',
        id,
        tenant.schoolId,
      )) as SeasonRow[];
      return rowToDto(rows[0]!);
    });
  }
}
