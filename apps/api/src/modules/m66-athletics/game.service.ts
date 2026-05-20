import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import { ProgrammeService } from './programme.service';
import {
  CreateGameDto,
  GameLocation,
  GameOutcome,
  GameResponseDto,
  GameResultResponseDto,
  GameStatus,
  RosterLevel,
  UpdateGameDto,
} from './dto/athletics.dto';

interface GameRow {
  id: string;
  season_id: string;
  roster_id: string;
  roster_level: string | null;
  programme_name: string | null;
  game_date: string;
  game_time: string;
  opponent_name: string;
  opponent_school_id: string | null;
  location: string;
  status: string;
  is_conference_game: boolean;
  is_ticketed: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
  // result columns inlined via LEFT JOIN
  result_id: string | null;
  result_home_score: number | null;
  result_away_score: number | null;
  result_score_by_period: Record<string, unknown> | null;
  result_outcome: string | null;
  result_notes: string | null;
  result_entered_by: string | null;
  result_entered_by_name: string | null;
  result_entered_at: string | null;
}

const SELECT_GAME =
  'SELECT g.id::text AS id, g.season_id::text AS season_id, g.roster_id::text AS roster_id, ' +
  'r.level AS roster_level, p.sport_name AS programme_name, ' +
  "TO_CHAR(g.game_date, 'YYYY-MM-DD') AS game_date, " +
  "TO_CHAR(g.game_time, 'HH24:MI') AS game_time, " +
  'g.opponent_name, g.opponent_school_id::text AS opponent_school_id, g.location, g.status, ' +
  'g.is_conference_game, g.is_ticketed, g.notes, ' +
  'TO_CHAR(g.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(g.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at, ' +
  'res.id::text AS result_id, res.home_score AS result_home_score, ' +
  'res.away_score AS result_away_score, res.score_by_period AS result_score_by_period, ' +
  'res.outcome AS result_outcome, res.notes AS result_notes, ' +
  'res.entered_by::text AS result_entered_by, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM hr_employees he " +
  '  JOIN platform.iam_person ip ON ip.id = he.person_id ' +
  '  WHERE he.id = res.entered_by) AS result_entered_by_name, ' +
  'TO_CHAR(res.entered_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS result_entered_at ' +
  'FROM ath_games g ' +
  'JOIN ath_rosters r ON r.id = g.roster_id ' +
  'JOIN ath_seasons s ON s.id = g.season_id ' +
  'JOIN ath_programmes p ON p.id = s.programme_id ' +
  'LEFT JOIN ath_game_results res ON res.game_id = g.id ';

function gameRowToDto(r: GameRow): GameResponseDto {
  let result: GameResultResponseDto | null = null;
  if (r.result_id) {
    result = {
      id: r.result_id,
      gameId: r.id,
      homeScore: r.result_home_score!,
      awayScore: r.result_away_score!,
      scoreByPeriod: r.result_score_by_period,
      outcome: r.result_outcome as GameOutcome,
      notes: r.result_notes,
      enteredBy: r.result_entered_by!,
      enteredByName: r.result_entered_by_name,
      enteredAt: r.result_entered_at!,
    };
  }
  return {
    id: r.id,
    seasonId: r.season_id,
    rosterId: r.roster_id,
    rosterLevel: r.roster_level as RosterLevel | null,
    programmeName: r.programme_name,
    gameDate: r.game_date,
    gameTime: r.game_time,
    opponentName: r.opponent_name,
    opponentSchoolId: r.opponent_school_id,
    location: r.location as GameLocation,
    status: r.status as GameStatus,
    isConferenceGame: r.is_conference_game,
    isTicketed: r.is_ticketed,
    notes: r.notes,
    result,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

@Injectable()
export class GameService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly programmes: ProgrammeService,
  ) {}

  /**
   * AD scope for game writes — admin OR holds ath-001:write
   * (canonical AD signal) OR holds ath-002:write (game-write
   * grant). Rewritten per REVIEW-CYCLE13 MAJOR 7 to avoid the
   * brittle mixed-promise short-circuit.
   *
   * Wave 7 FIX: previously joined `platform.iam_effective_access_cache`
   * directly via `scope_ids = ANY(...)` but the schema column is
   * `scope_id` (singular). Walk the scope chain by ANY-checking
   * permission_codes across rows for this account scoped to the
   * current school or platform.
   */
  async hasResultScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    if (await this.programmes.hasAdScope(actor)) return true;
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT 1 FROM platform.iam_effective_access_cache c ' +
          'JOIN platform.iam_scope s ON s.id = c.scope_id ' +
          'WHERE c.account_id = $1::uuid AND $2::text = ANY(c.permission_codes) ' +
          "AND ((s.entity_id = $3::uuid) OR (s.scope_type_id IN (SELECT id FROM platform.iam_scope_type WHERE code = 'PLATFORM')))",
        actor.accountId,
        'ath-002:write',
        tenant.schoolId,
      )) as unknown[];
      return rows.length > 0;
    });
  }

  async list(filters: {
    seasonId?: string;
    rosterId?: string;
    status?: GameStatus;
    fromDate?: string;
    toDate?: string;
  }): Promise<GameResponseDto[]> {
    const sql: string[] = [SELECT_GAME, 'WHERE 1=1 '];
    const params: unknown[] = [];
    if (filters.seasonId) {
      params.push(filters.seasonId);
      sql.push('AND g.season_id = $' + params.length + '::uuid ');
    }
    if (filters.rosterId) {
      params.push(filters.rosterId);
      sql.push('AND g.roster_id = $' + params.length + '::uuid ');
    }
    if (filters.status) {
      params.push(filters.status);
      sql.push('AND g.status = $' + params.length + ' ');
    }
    if (filters.fromDate) {
      params.push(filters.fromDate);
      sql.push('AND g.game_date >= $' + params.length + '::date ');
    }
    if (filters.toDate) {
      params.push(filters.toDate);
      sql.push('AND g.game_date <= $' + params.length + '::date ');
    }
    sql.push('ORDER BY g.game_date ASC, g.game_time ASC LIMIT 500');
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<GameRow[]>(sql.join(''), ...params);
    });
    return rows.map(gameRowToDto);
  }

  async getById(id: string): Promise<GameResponseDto> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<GameRow[]>(SELECT_GAME + 'WHERE g.id = $1::uuid', id);
    });
    if (rows.length === 0) throw new NotFoundException('Game not found');
    return gameRowToDto(rows[0]!);
  }

  async create(input: CreateGameDto, actor: ResolvedActor): Promise<GameResponseDto> {
    if (!(await this.programmes.hasAdScope(actor))) {
      throw new ForbiddenException('Only the Athletic Director or admin can schedule games');
    }
    // Resolve season from roster
    const rosterRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT season_id::text AS season_id FROM ath_rosters WHERE id = $1::uuid',
        input.rosterId,
      );
    })) as Array<{ season_id: string }>;
    if (rosterRows.length === 0) throw new BadRequestException('rosterId not found');

    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO ath_games (id, season_id, roster_id, game_date, game_time, opponent_name, opponent_school_id, location, status, is_conference_game, is_ticketed, notes) ' +
            "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5::time, $6, $7::uuid, $8, 'SCHEDULED', $9, $10, $11)",
          id,
          rosterRows[0]!.season_id,
          input.rosterId,
          input.gameDate,
          input.gameTime,
          input.opponentName,
          input.opponentSchoolId ?? null,
          input.location,
          input.isConferenceGame ?? false,
          input.isTicketed ?? false,
          input.notes ?? null,
        );
      });
    } catch (e) {
      throw e;
    }
    return this.getById(id);
  }

  async patch(id: string, input: UpdateGameDto, actor: ResolvedActor): Promise<GameResponseDto> {
    if (!(await this.programmes.hasAdScope(actor))) {
      throw new ForbiddenException('Only the Athletic Director or admin can edit games');
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.gameDate !== undefined) {
      params.push(input.gameDate);
      sets.push('game_date = $' + params.length + '::date');
    }
    if (input.gameTime !== undefined) {
      params.push(input.gameTime);
      sets.push('game_time = $' + params.length + '::time');
    }
    if (input.opponentName !== undefined) {
      params.push(input.opponentName);
      sets.push('opponent_name = $' + params.length);
    }
    if (input.opponentSchoolId !== undefined) {
      if (input.opponentSchoolId === null) sets.push('opponent_school_id = NULL');
      else {
        params.push(input.opponentSchoolId);
        sets.push('opponent_school_id = $' + params.length + '::uuid');
      }
    }
    if (input.location !== undefined) {
      params.push(input.location);
      sets.push('location = $' + params.length);
    }
    if (input.status !== undefined) {
      params.push(input.status);
      sets.push('status = $' + params.length);
    }
    if (input.isConferenceGame !== undefined) {
      params.push(input.isConferenceGame);
      sets.push('is_conference_game = $' + params.length);
    }
    if (input.isTicketed !== undefined) {
      params.push(input.isTicketed);
      sets.push('is_ticketed = $' + params.length);
    }
    if (input.notes !== undefined) {
      params.push(input.notes);
      sets.push('notes = $' + params.length);
    }
    if (sets.length === 0) return this.getById(id);
    sets.push('updated_at = now()');
    params.push(id);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$executeRawUnsafe(
        'UPDATE ath_games SET ' + sets.join(', ') + ' WHERE id = $' + params.length + '::uuid',
        ...params,
      );
    });
    return this.getById(id);
  }
}
