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
import { GameService } from './game.service';
import {
  AllTimeRecordResponseDto,
  CreateAllTimeRecordDto,
  EnterPlayerStatsDto,
  PlayerGameStatResponseDto,
  RecordType,
} from './dto/athletics.dto';

@Injectable()
export class StatsService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly games: GameService,
  ) {}

  async listForGame(gameId: string): Promise<PlayerGameStatResponseDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT s.id::text AS id, s.game_id::text AS game_id, s.student_id::text AS student_id, ' +
          "(ip.first_name || ' ' || ip.last_name) AS student_name, " +
          's.stat_category, s.stat_value::text AS stat_value, s.notes, s.entered_by::text AS entered_by, ' +
          'TO_CHAR(s.entered_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS entered_at ' +
          'FROM ath_player_game_stats s ' +
          'JOIN sis_students ss ON ss.id = s.student_id ' +
          'JOIN platform.platform_students ps ON ps.id = ss.platform_student_id ' +
          'JOIN platform.iam_person ip ON ip.id = ps.person_id ' +
          'WHERE s.game_id = $1::uuid ' +
          'ORDER BY ip.last_name, ip.first_name, s.stat_category',
        gameId,
      );
    })) as Array<{
      id: string;
      game_id: string;
      student_id: string;
      student_name: string;
      stat_category: string;
      stat_value: string;
      notes: string | null;
      entered_by: string;
      entered_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      gameId: r.game_id,
      studentId: r.student_id,
      studentName: r.student_name,
      statCategory: r.stat_category,
      statValue: Number(r.stat_value),
      notes: r.notes,
      enteredBy: r.entered_by,
      enteredAt: r.entered_at,
    }));
  }

  async listForPlayer(studentId: string): Promise<PlayerGameStatResponseDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT s.id::text AS id, s.game_id::text AS game_id, s.student_id::text AS student_id, ' +
          "(ip.first_name || ' ' || ip.last_name) AS student_name, " +
          's.stat_category, s.stat_value::text AS stat_value, s.notes, s.entered_by::text AS entered_by, ' +
          'TO_CHAR(s.entered_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS entered_at ' +
          'FROM ath_player_game_stats s ' +
          'JOIN sis_students ss ON ss.id = s.student_id ' +
          'JOIN platform.platform_students ps ON ps.id = ss.platform_student_id ' +
          'JOIN platform.iam_person ip ON ip.id = ps.person_id ' +
          'WHERE s.student_id = $1::uuid ' +
          'ORDER BY s.entered_at DESC LIMIT 500',
        studentId,
      );
    })) as Array<{
      id: string;
      game_id: string;
      student_id: string;
      student_name: string;
      stat_category: string;
      stat_value: string;
      notes: string | null;
      entered_by: string;
      entered_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      gameId: r.game_id,
      studentId: r.student_id,
      studentName: r.student_name,
      statCategory: r.stat_category,
      statValue: Number(r.stat_value),
      notes: r.notes,
      enteredBy: r.entered_by,
      enteredAt: r.entered_at,
    }));
  }

  async bulkEnter(
    gameId: string,
    input: EnterPlayerStatsDto,
    actor: ResolvedActor,
  ): Promise<PlayerGameStatResponseDto[]> {
    if (!(await this.games.hasResultScope(actor))) {
      throw new ForbiddenException('Only the AD or admin can enter player stats');
    }
    if (!actor.employeeId) {
      throw new ForbiddenException('Stats entry requires an hr_employees identity');
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // REVIEW-CYCLE13 MAJOR 5: validate every studentId is an
      // active member of the game's parent roster. The schema
      // enforces uniqueness on (game, student, category) but not
      // membership, so this is the app-layer gate.
      const gameRows = (await tx.$queryRawUnsafe(
        'SELECT roster_id::text AS roster_id FROM ath_games WHERE id = $1::uuid',
        gameId,
      )) as Array<{ roster_id: string }>;
      if (gameRows.length === 0) throw new NotFoundException('Game not found');
      const rosterId = gameRows[0]!.roster_id;

      const studentIds = Array.from(new Set(input.stats.map((line) => line.studentId)));
      if (studentIds.length === 0) return;
      const memberRows = (await tx.$queryRawUnsafe(
        'SELECT student_id::text AS student_id FROM ath_roster_members ' +
          'WHERE roster_id = $1::uuid AND removed_at IS NULL AND student_id = ANY($2::uuid[])',
        rosterId,
        studentIds,
      )) as Array<{ student_id: string }>;
      const allowed = new Set(memberRows.map((r) => r.student_id));
      const missing = studentIds.filter((id) => !allowed.has(id));
      if (missing.length > 0) {
        throw new BadRequestException(
          'The following studentId values are not active members of the game roster: ' +
            missing.join(', ') +
            '. Add them to the roster before entering stats, or remove the rows.',
        );
      }

      for (const line of input.stats) {
        const id = generateId();
        try {
          await tx.$executeRawUnsafe(
            'INSERT INTO ath_player_game_stats (id, game_id, student_id, stat_category, stat_value, notes, entered_by) ' +
              'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::uuid)',
            id,
            gameId,
            line.studentId,
            line.statCategory,
            line.statValue,
            line.notes ?? null,
            actor.employeeId,
          );
        } catch (e) {
          const err = e as { code?: string; meta?: { code?: string }; message?: string };
          const code = err.code === 'P2010' ? err.meta?.code : err.code;
          if (code === '23505' || /23505/.test(err.message ?? '')) {
            throw new BadRequestException(
              'Stat already exists for student ' +
                line.studentId +
                ' / category ' +
                line.statCategory +
                '. PATCH the existing row instead.',
            );
          }
          throw e;
        }
      }
    });
    return this.listForGame(gameId);
  }

  async listAllTimeRecords(): Promise<AllTimeRecordResponseDto[]> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, school_id::text AS school_id, sport, record_type, stat_category, ' +
          'record_value::text AS record_value, holder_student_id::text AS holder_student_id, holder_name_snapshot, ' +
          "TO_CHAR(set_date, 'YYYY-MM-DD') AS set_date, set_season_id::text AS set_season_id, notes, " +
          'TO_CHAR(created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at ' +
          'FROM ath_all_time_records WHERE school_id = $1::uuid ORDER BY sport, record_type, stat_category',
        tenant.schoolId,
      );
    })) as Array<{
      id: string;
      school_id: string;
      sport: string;
      record_type: string;
      stat_category: string;
      record_value: string;
      holder_student_id: string | null;
      holder_name_snapshot: string | null;
      set_date: string | null;
      set_season_id: string | null;
      notes: string | null;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      schoolId: r.school_id,
      sport: r.sport,
      recordType: r.record_type as RecordType,
      statCategory: r.stat_category,
      recordValue: Number(r.record_value),
      holderStudentId: r.holder_student_id,
      holderNameSnapshot: r.holder_name_snapshot,
      setDate: r.set_date,
      setSeasonId: r.set_season_id,
      notes: r.notes,
      createdAt: r.created_at,
    }));
  }

  async createAllTimeRecord(
    input: CreateAllTimeRecordDto,
    actor: ResolvedActor,
  ): Promise<AllTimeRecordResponseDto> {
    if (!(await this.games.hasResultScope(actor))) {
      throw new ForbiddenException('Only the AD or admin can manage all-time records');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO ath_all_time_records (id, school_id, sport, record_type, stat_category, record_value, holder_student_id, holder_name_snapshot, set_date, set_season_id, notes) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid, $8, $9::date, $10::uuid, $11)',
          id,
          tenant.schoolId,
          input.sport,
          input.recordType,
          input.statCategory,
          input.recordValue,
          input.holderStudentId ?? null,
          input.holderNameSnapshot ?? null,
          input.setDate ?? null,
          input.setSeasonId ?? null,
          input.notes ?? null,
        );
      });
    } catch (e) {
      const err = e as { code?: string; meta?: { code?: string }; message?: string };
      const code = err.code === 'P2010' ? err.meta?.code : err.code;
      if (code === '23505' || /23505/.test(err.message ?? '')) {
        throw new BadRequestException(
          'A record already exists for (sport, record_type, stat_category). PATCH it instead.',
        );
      }
      throw e;
    }
    const all = await this.listAllTimeRecords();
    const found = all.find((r) => r.id === id);
    if (!found) throw new NotFoundException('Created record not found');
    return found;
  }
}
