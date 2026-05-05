import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import { GameService } from './game.service';
import {
  EnterGameResultDto,
  GameOutcome,
  GameResponseDto,
  GameResultResponseDto,
  SeasonRecordResponseDto,
} from './dto/athletics.dto';

@Injectable()
export class ResultService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly games: GameService,
    private readonly kafka: KafkaProducerService,
  ) {}

  async enterResult(
    gameId: string,
    input: EnterGameResultDto,
    actor: ResolvedActor,
  ): Promise<GameResponseDto> {
    if (!(await this.games.hasResultScope(actor))) {
      throw new ForbiddenException('Only the AD or admin can enter game results');
    }
    if (!actor.employeeId) {
      throw new ForbiddenException('Result entry requires an hr_employees identity');
    }
    const resultId = generateId();
    let kafkaPayload: Record<string, unknown> | null = null;
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Lock game
      const gameLock = (await tx.$queryRawUnsafe(
        'SELECT id, roster_id::text AS roster_id, is_conference_game, season_id::text AS season_id FROM ath_games WHERE id = $1::uuid FOR UPDATE',
        gameId,
      )) as Array<{
        id: string;
        roster_id: string;
        is_conference_game: boolean;
        season_id: string;
      }>;
      if (gameLock.length === 0) throw new NotFoundException('Game not found');

      // Refuse double-entry
      const existing = (await tx.$queryRawUnsafe(
        'SELECT id FROM ath_game_results WHERE game_id = $1::uuid',
        gameId,
      )) as Array<{ id: string }>;
      if (existing.length > 0) {
        throw new BadRequestException(
          'Game already has a result. PATCH the existing result row to correct it.',
        );
      }

      // Insert result
      await tx.$executeRawUnsafe(
        'INSERT INTO ath_game_results (id, game_id, home_score, away_score, score_by_period, outcome, notes, entered_by) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6, $7, $8::uuid)',
        resultId,
        gameId,
        input.homeScore,
        input.awayScore,
        input.scoreByPeriod ? JSON.stringify(input.scoreByPeriod) : null,
        input.outcome,
        input.notes ?? null,
        actor.employeeId,
      );

      // Flip game to COMPLETED
      await tx.$executeRawUnsafe(
        "UPDATE ath_games SET status = 'COMPLETED', updated_at = now() WHERE id = $1::uuid",
        gameId,
      );

      // UPSERT season_record
      await tx.$executeRawUnsafe(
        'INSERT INTO ath_season_records (id, roster_id, wins, losses, draws, conference_wins, conference_losses, conference_draws) ' +
          'VALUES ($1::uuid, $2::uuid, 0, 0, 0, 0, 0, 0) ON CONFLICT (roster_id) DO NOTHING',
        generateId(),
        gameLock[0]!.roster_id,
      );

      const winsBump = input.outcome === 'WIN' || input.outcome === 'FORFEIT' ? 1 : 0;
      const lossesBump = input.outcome === 'LOSS' ? 1 : 0;
      const drawsBump = input.outcome === 'DRAW' ? 1 : 0;
      const isConf = gameLock[0]!.is_conference_game;
      await tx.$executeRawUnsafe(
        'UPDATE ath_season_records SET wins = wins + $1, losses = losses + $2, draws = draws + $3, ' +
          'conference_wins = conference_wins + $4, conference_losses = conference_losses + $5, conference_draws = conference_draws + $6, ' +
          'last_updated_at = now() WHERE roster_id = $7::uuid',
        winsBump,
        lossesBump,
        drawsBump,
        isConf ? winsBump : 0,
        isConf ? lossesBump : 0,
        isConf ? drawsBump : 0,
        gameLock[0]!.roster_id,
      );

      kafkaPayload = {
        gameId,
        resultId,
        seasonId: gameLock[0]!.season_id,
        rosterId: gameLock[0]!.roster_id,
        homeScore: input.homeScore,
        awayScore: input.awayScore,
        outcome: input.outcome,
        isConferenceGame: isConf,
        enteredBy: actor.employeeId,
        sourceRefId: resultId,
      };
    });

    // Emit AFTER tx commit
    if (kafkaPayload) {
      try {
        await this.kafka.emit({
          topic: 'ath.game.result.entered',
          key: gameId,
          payload: kafkaPayload,
          sourceModule: 'athletics',
        });
      } catch {
        // Best-effort emit per existing convention
      }
    }

    return this.games.getById(gameId);
  }

  async patchResult(
    resultId: string,
    input: EnterGameResultDto,
    actor: ResolvedActor,
  ): Promise<GameResultResponseDto> {
    if (!(await this.games.hasResultScope(actor))) {
      throw new ForbiddenException('Only the AD or admin can correct game results');
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.homeScore !== undefined) {
      params.push(input.homeScore);
      sets.push('home_score = $' + params.length);
    }
    if (input.awayScore !== undefined) {
      params.push(input.awayScore);
      sets.push('away_score = $' + params.length);
    }
    if (input.scoreByPeriod !== undefined) {
      params.push(JSON.stringify(input.scoreByPeriod));
      sets.push('score_by_period = $' + params.length + '::jsonb');
    }
    if (input.outcome !== undefined) {
      params.push(input.outcome);
      sets.push('outcome = $' + params.length);
    }
    if (input.notes !== undefined) {
      params.push(input.notes);
      sets.push('notes = $' + params.length);
    }
    if (sets.length === 0) {
      // No-op
    } else {
      sets.push('updated_at = now()');
      params.push(resultId);
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$executeRawUnsafe(
          'UPDATE ath_game_results SET ' +
            sets.join(', ') +
            ' WHERE id = $' +
            params.length +
            '::uuid',
          ...params,
        );
      });
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, game_id::text AS game_id, home_score, away_score, score_by_period, outcome, notes, entered_by::text AS entered_by, ' +
          'TO_CHAR(entered_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS entered_at FROM ath_game_results WHERE id = $1::uuid',
        resultId,
      );
    })) as Array<{
      id: string;
      game_id: string;
      home_score: number;
      away_score: number;
      score_by_period: Record<string, unknown> | null;
      outcome: string;
      notes: string | null;
      entered_by: string;
      entered_at: string;
    }>;
    if (rows.length === 0) throw new NotFoundException('Result not found');
    return {
      id: rows[0]!.id,
      gameId: rows[0]!.game_id,
      homeScore: rows[0]!.home_score,
      awayScore: rows[0]!.away_score,
      scoreByPeriod: rows[0]!.score_by_period,
      outcome: rows[0]!.outcome as GameOutcome,
      notes: rows[0]!.notes,
      enteredBy: rows[0]!.entered_by,
      enteredByName: null,
      enteredAt: rows[0]!.entered_at,
    };
  }

  async getSeasonRecord(rosterId: string): Promise<SeasonRecordResponseDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT roster_id::text AS roster_id, wins, losses, draws, conference_wins, conference_losses, conference_draws, ' +
          'TO_CHAR(last_updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS last_updated_at FROM ath_season_records WHERE roster_id = $1::uuid',
        rosterId,
      );
    })) as Array<{
      roster_id: string;
      wins: number;
      losses: number;
      draws: number;
      conference_wins: number;
      conference_losses: number;
      conference_draws: number;
      last_updated_at: string;
    }>;
    if (rows.length === 0) {
      // Return a zero record if no row yet
      return {
        rosterId,
        wins: 0,
        losses: 0,
        draws: 0,
        conferenceWins: 0,
        conferenceLosses: 0,
        conferenceDraws: 0,
        lastUpdatedAt: new Date().toISOString(),
      };
    }
    return {
      rosterId: rows[0]!.roster_id,
      wins: rows[0]!.wins,
      losses: rows[0]!.losses,
      draws: rows[0]!.draws,
      conferenceWins: rows[0]!.conference_wins,
      conferenceLosses: rows[0]!.conference_losses,
      conferenceDraws: rows[0]!.conference_draws,
      lastUpdatedAt: rows[0]!.last_updated_at,
    };
  }
}
