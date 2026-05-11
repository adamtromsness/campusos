import { createHash } from 'node:crypto';
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
import { OutboxService } from '../kafka/outbox.service';

/**
 * REVIEW-P2-8 BLOCKING 4 — deterministic event_id helper for the
 * highlight-clip portfolio-link outbox emit.
 */
export function deterministicHighlightLinkEventId(clipId: string): string {
  const hash = createHash('sha256')
    .update(clipId + ':ath.highlight_clip.portfolio_link_requested:v1')
    .digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return (
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-' +
    hex.slice(12, 16) +
    '-' +
    hex.slice(16, 20) +
    '-' +
    hex.slice(20, 32)
  );
}
import {
  CreateGameRecordingDto,
  CreateGameStreamDto,
  CreateHighlightClipDto,
  GameRecordingResponseDto,
  GameStreamResponseDto,
  HighlightClipResponseDto,
  RecordHighlightClipConsentDto,
  RecordingType,
  StreamAccessLevel,
  StreamStatus,
  UpdateGameStreamDto,
} from './dto/athletics-advanced.dto';

interface StreamRow {
  id: string;
  game_id: string;
  stream_url: string | null;
  stream_status: string;
  access_level: string;
  recording_s3_key: string | null;
  recording_duration_seconds: number | null;
  configured_by: string;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_STREAM =
  'SELECT id::text AS id, game_id::text AS game_id, stream_url, stream_status, access_level, ' +
  'recording_s3_key, recording_duration_seconds, configured_by::text AS configured_by, ' +
  'TO_CHAR(started_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS started_at, ' +
  'TO_CHAR(ended_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS ended_at, ' +
  'TO_CHAR(created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM ath_game_streams ';

interface ClipRow {
  id: string;
  stream_id: string;
  student_id: string;
  student_name: string | null;
  start_time_seconds: number;
  end_time_seconds: number;
  title: string | null;
  description: string | null;
  s3_key: string;
  added_to_portfolio: boolean;
  portfolio_item_id: string | null;
  consent_status: string;
  consent_recorded_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_CLIP =
  'SELECT c.id::text AS id, c.stream_id::text AS stream_id, c.student_id::text AS student_id, ' +
  "(p.first_name || ' ' || p.last_name) AS student_name, " +
  'c.start_time_seconds, c.end_time_seconds, c.title, c.description, c.s3_key, ' +
  'c.added_to_portfolio, c.portfolio_item_id::text AS portfolio_item_id, c.consent_status, ' +
  'TO_CHAR(c.consent_recorded_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS consent_recorded_at, ' +
  'c.created_by::text AS created_by, ' +
  'TO_CHAR(c.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(c.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM ath_highlight_clips c ' +
  'LEFT JOIN sis_students s ON s.id = c.student_id ' +
  'LEFT JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
  'LEFT JOIN platform.iam_person p ON p.id = ps.person_id ';

interface RecordingRow {
  id: string;
  game_id: string;
  recording_type: string;
  s3_key: string;
  duration_seconds: number | null;
  title: string | null;
  description: string | null;
  uploaded_by: string | null;
  uploaded_at: string;
  created_at: string;
  updated_at: string;
}

const SELECT_RECORDING =
  'SELECT id::text AS id, game_id::text AS game_id, recording_type, s3_key, duration_seconds, ' +
  'title, description, uploaded_by::text AS uploaded_by, ' +
  'TO_CHAR(uploaded_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS uploaded_at, ' +
  'TO_CHAR(created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM ath_game_recordings ';

function rowToStreamDto(r: StreamRow): GameStreamResponseDto {
  return {
    id: r.id,
    gameId: r.game_id,
    streamUrl: r.stream_url,
    streamStatus: r.stream_status as StreamStatus,
    accessLevel: r.access_level as StreamAccessLevel,
    recordingS3Key: r.recording_s3_key,
    recordingDurationSeconds: r.recording_duration_seconds,
    configuredBy: r.configured_by,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToClipDto(r: ClipRow): HighlightClipResponseDto {
  return {
    id: r.id,
    streamId: r.stream_id,
    studentId: r.student_id,
    studentName: r.student_name,
    startTimeSeconds: r.start_time_seconds,
    endTimeSeconds: r.end_time_seconds,
    title: r.title,
    description: r.description,
    s3Key: r.s3_key,
    addedToPortfolio: r.added_to_portfolio,
    portfolioItemId: r.portfolio_item_id,
    consentStatus: r.consent_status as 'PENDING' | 'CONSENTED' | 'DECLINED',
    consentRecordedAt: r.consent_recorded_at,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToRecordingDto(r: RecordingRow): GameRecordingResponseDto {
  return {
    id: r.id,
    gameId: r.game_id,
    recordingType: r.recording_type as RecordingType,
    s3Key: r.s3_key,
    durationSeconds: r.duration_seconds,
    title: r.title,
    description: r.description,
    uploadedBy: r.uploaded_by,
    uploadedAt: r.uploaded_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

@Injectable()
export class GameStreamService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,

    private readonly outbox: OutboxService,
  ) {}

  async hasStreamScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'ath-005:write',
    ]);
  }

  // Validate the game lives in this school. ath_games has no school_id —
  // it is derived via the chain ath_games → ath_seasons → ath_programmes.school_id.
  private async assertGameInSchool(client: unknown, gameId: string): Promise<void> {
    const tenant = getCurrentTenant();
    const c = client as {
      $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T>;
    };
    const rows = await c.$queryRawUnsafe<Array<{ id: string }>>(
      'SELECT g.id FROM ath_games g JOIN ath_seasons sea ON sea.id = g.season_id JOIN ath_programmes pr ON pr.id = sea.programme_id WHERE g.id = $1::uuid AND pr.school_id = $2::uuid',
      gameId,
      tenant.schoolId,
    );
    if (rows.length === 0) {
      throw new BadRequestException('gameId does not match a game in this school');
    }
  }

  // ── Game Stream CRUD ────────────────────────────────────────────

  async configureStream(
    gameId: string,
    input: CreateGameStreamDto,
    actor: ResolvedActor,
  ): Promise<GameStreamResponseDto> {
    if (!(await this.hasStreamScope(actor))) {
      throw new ForbiddenException('Only the AD or admin can configure game streams');
    }
    if (!actor.personId) {
      throw new ForbiddenException('Configurer must have a person record');
    }
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await this.assertGameInSchool(client, gameId);
      // UNIQUE(game_id) is the schema-side dedup guard — surface any
      // existing row with a friendly 400.
      const existing = (await (
        client as { $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T> }
      ).$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id::text AS id FROM ath_game_streams WHERE game_id = $1::uuid',
        gameId,
      )) as Array<{ id: string }>;
      if (existing.length > 0) {
        throw new BadRequestException(
          'Game already has a stream configured (' + existing[0]!.id + ')',
        );
      }
      await (
        client as { $executeRawUnsafe: (sql: string, ...args: unknown[]) => Promise<number> }
      ).$executeRawUnsafe(
        'INSERT INTO ath_game_streams (id, game_id, stream_url, stream_status, access_level, configured_by) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid)',
        id,
        gameId,
        input.streamUrl ?? null,
        'SCHEDULED',
        input.accessLevel ?? 'SCHOOL_ONLY',
        actor.personId,
      );
    });
    return this.getById(id);
  }

  async getById(id: string): Promise<GameStreamResponseDto> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext((client) =>
      (
        client as { $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T> }
      ).$queryRawUnsafe<StreamRow[]>(
        SELECT_STREAM +
          'WHERE id = $1::uuid AND EXISTS (SELECT 1 FROM ath_games g JOIN ath_seasons sea ON sea.id = g.season_id JOIN ath_programmes pr ON pr.id = sea.programme_id WHERE g.id = ath_game_streams.game_id AND pr.school_id = $2::uuid)',
        id,
        tenant.schoolId,
      ),
    );
    if ((rows as StreamRow[]).length === 0) throw new NotFoundException('Stream not found');
    return rowToStreamDto((rows as StreamRow[])[0]!);
  }

  async getByGameId(gameId: string): Promise<GameStreamResponseDto | null> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext((client) =>
      (
        client as { $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T> }
      ).$queryRawUnsafe<StreamRow[]>(
        SELECT_STREAM +
          'WHERE game_id = $1::uuid AND EXISTS (SELECT 1 FROM ath_games g JOIN ath_seasons sea ON sea.id = g.season_id JOIN ath_programmes pr ON pr.id = sea.programme_id WHERE g.id = $1::uuid AND pr.school_id = $2::uuid)',
        gameId,
        tenant.schoolId,
      ),
    );
    if ((rows as StreamRow[]).length === 0) return null;
    return rowToStreamDto((rows as StreamRow[])[0]!);
  }

  async listLive(): Promise<GameStreamResponseDto[]> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext((client) =>
      (
        client as { $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T> }
      ).$queryRawUnsafe<StreamRow[]>(
        SELECT_STREAM +
          "WHERE stream_status = 'LIVE' AND EXISTS (SELECT 1 FROM ath_games g JOIN ath_seasons sea ON sea.id = g.season_id JOIN ath_programmes pr ON pr.id = sea.programme_id WHERE g.id = ath_game_streams.game_id AND pr.school_id = $1::uuid) " +
          'ORDER BY started_at DESC LIMIT 100',
        tenant.schoolId,
      ),
    );
    return (rows as StreamRow[]).map(rowToStreamDto);
  }

  async patchStream(
    id: string,
    input: UpdateGameStreamDto,
    actor: ResolvedActor,
  ): Promise<GameStreamResponseDto> {
    if (!(await this.hasStreamScope(actor))) {
      throw new ForbiddenException('Only the AD or admin can update game streams');
    }
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Lock the row + verify it belongs to this school
      const tenant = getCurrentTenant();
      const lockRows = (await (
        tx as { $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T> }
      ).$queryRawUnsafe<Array<{ id: string; stream_status: string; school_id: string }>>(
        'SELECT s.id::text AS id, s.stream_status, pr.school_id::text AS school_id ' +
          'FROM ath_game_streams s JOIN ath_games g ON g.id = s.game_id JOIN ath_seasons sea ON sea.id = g.season_id JOIN ath_programmes pr ON pr.id = sea.programme_id ' +
          'WHERE s.id = $1::uuid FOR UPDATE OF s',
        id,
      )) as Array<{ id: string; stream_status: string; school_id: string }>;
      if (lockRows.length === 0) throw new NotFoundException('Stream not found');
      if (lockRows[0]!.school_id !== tenant.schoolId) {
        throw new NotFoundException('Stream not found');
      }
      const currentStatus = lockRows[0]!.stream_status as StreamStatus;
      const sets: string[] = [];
      const params: unknown[] = [];
      if (input.streamUrl !== undefined) {
        params.push(input.streamUrl);
        sets.push('stream_url = $' + params.length);
      }
      if (input.accessLevel !== undefined) {
        params.push(input.accessLevel);
        sets.push('access_level = $' + params.length);
      }
      if (input.recordingS3Key !== undefined) {
        params.push(input.recordingS3Key);
        sets.push('recording_s3_key = $' + params.length);
      }
      if (input.recordingDurationSeconds !== undefined) {
        params.push(input.recordingDurationSeconds);
        sets.push('recording_duration_seconds = $' + params.length);
      }
      if (input.streamStatus !== undefined && input.streamStatus !== currentStatus) {
        // Validate transition. SCHEDULED → LIVE → ENDED, FAILED can come from any.
        const allowed: Record<StreamStatus, StreamStatus[]> = {
          SCHEDULED: ['LIVE', 'FAILED'],
          LIVE: ['ENDED', 'FAILED'],
          ENDED: [],
          FAILED: [],
        };
        if (!allowed[currentStatus].includes(input.streamStatus)) {
          throw new BadRequestException(
            'Illegal stream transition ' + currentStatus + ' → ' + input.streamStatus,
          );
        }
        params.push(input.streamStatus);
        sets.push('stream_status = $' + params.length);
        if (input.streamStatus === 'LIVE') {
          sets.push('started_at = now()');
        }
        if (input.streamStatus === 'ENDED') {
          sets.push('ended_at = now()');
        }
      }
      if (sets.length === 0) {
        const noopRows = (await (
          tx as { $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T> }
        ).$queryRawUnsafe<StreamRow[]>(SELECT_STREAM + 'WHERE id = $1::uuid', id)) as StreamRow[];
        return rowToStreamDto(noopRows[0]!);
      }
      sets.push('updated_at = now()');
      params.push(id);
      await (
        tx as { $executeRawUnsafe: (sql: string, ...args: unknown[]) => Promise<number> }
      ).$executeRawUnsafe(
        'UPDATE ath_game_streams SET ' +
          sets.join(', ') +
          ' WHERE id = $' +
          params.length +
          '::uuid',
        ...params,
      );
      // Reread within the same tx
      const final = (await (
        tx as { $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T> }
      ).$queryRawUnsafe<StreamRow[]>(SELECT_STREAM + 'WHERE id = $1::uuid', id)) as StreamRow[];
      return rowToStreamDto(final[0]!);
    });
  }

  // ── Highlight Clips ─────────────────────────────────────────────

  async listClipsForStream(streamId: string): Promise<HighlightClipResponseDto[]> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext((client) =>
      (
        client as { $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T> }
      ).$queryRawUnsafe<ClipRow[]>(
        SELECT_CLIP +
          'WHERE c.stream_id = $1::uuid AND EXISTS (SELECT 1 FROM ath_game_streams st JOIN ath_games g ON g.id = st.game_id JOIN ath_seasons sea ON sea.id = g.season_id JOIN ath_programmes pr ON pr.id = sea.programme_id WHERE st.id = $1::uuid AND pr.school_id = $2::uuid) ' +
          'ORDER BY c.created_at DESC LIMIT 200',
        streamId,
        tenant.schoolId,
      ),
    );
    return (rows as ClipRow[]).map(rowToClipDto);
  }

  async listClipsForStudent(studentId: string): Promise<HighlightClipResponseDto[]> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext((client) =>
      (
        client as { $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T> }
      ).$queryRawUnsafe<ClipRow[]>(
        SELECT_CLIP +
          'WHERE c.student_id = $1::uuid AND EXISTS (SELECT 1 FROM sis_students s WHERE s.id = $1::uuid AND s.school_id = $2::uuid) ' +
          'ORDER BY c.created_at DESC LIMIT 200',
        studentId,
        tenant.schoolId,
      ),
    );
    return (rows as ClipRow[]).map(rowToClipDto);
  }

  async createClip(
    streamId: string,
    input: CreateHighlightClipDto,
    actor: ResolvedActor,
  ): Promise<HighlightClipResponseDto> {
    if (!(await this.hasStreamScope(actor))) {
      throw new ForbiddenException('Only the AD or admin can extract highlight clips');
    }
    if (input.endTimeSeconds <= input.startTimeSeconds) {
      throw new BadRequestException('endTimeSeconds must be greater than startTimeSeconds');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const c = client as {
        $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T>;
        $executeRawUnsafe: (sql: string, ...args: unknown[]) => Promise<number>;
      };
      // Verify stream lives in this school
      const stream = await c.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT s.id FROM ath_game_streams s JOIN ath_games g ON g.id = s.game_id JOIN ath_seasons sea ON sea.id = g.season_id JOIN ath_programmes pr ON pr.id = sea.programme_id WHERE s.id = $1::uuid AND pr.school_id = $2::uuid',
        streamId,
        tenant.schoolId,
      );
      if (stream.length === 0) {
        throw new BadRequestException('streamId does not match a stream in this school');
      }
      // Verify student belongs to this school
      const student = await c.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id FROM sis_students WHERE id = $1::uuid AND school_id = $2::uuid',
        input.studentId,
        tenant.schoolId,
      );
      if (student.length === 0) {
        throw new BadRequestException('studentId does not match a student in this school');
      }
      await c.$executeRawUnsafe(
        'INSERT INTO ath_highlight_clips (id, stream_id, student_id, start_time_seconds, end_time_seconds, title, description, s3_key, created_by) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9::uuid)',
        id,
        streamId,
        input.studentId,
        input.startTimeSeconds,
        input.endTimeSeconds,
        input.title ?? null,
        input.description ?? null,
        input.s3Key,
        actor.personId ?? null,
      );
    });
    return this.getClipById(id);
  }

  async getClipById(id: string): Promise<HighlightClipResponseDto> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext((client) =>
      (
        client as { $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T> }
      ).$queryRawUnsafe<ClipRow[]>(
        SELECT_CLIP +
          'WHERE c.id = $1::uuid AND EXISTS (SELECT 1 FROM ath_game_streams st JOIN ath_games g ON g.id = st.game_id JOIN ath_seasons sea ON sea.id = g.season_id JOIN ath_programmes pr ON pr.id = sea.programme_id WHERE st.id = c.stream_id AND pr.school_id = $2::uuid)',
        id,
        tenant.schoolId,
      ),
    );
    if ((rows as ClipRow[]).length === 0) throw new NotFoundException('Highlight clip not found');
    return rowToClipDto((rows as ClipRow[])[0]!);
  }

  async recordClipConsent(
    clipId: string,
    input: RecordHighlightClipConsentDto,
    actor: ResolvedActor,
  ): Promise<HighlightClipResponseDto> {
    // Consent recording is open to:
    //   - The student themself (resolved via actor.personId → platform_students)
    //   - The student's linked guardian (parent — resolved via sis_student_guardians)
    //   - The AD or admin (administrative consent on behalf of, e.g. for under-13 students per COPPA)
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const t = tx as {
        $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T>;
        $executeRawUnsafe: (sql: string, ...args: unknown[]) => Promise<number>;
      };
      const lock = await t.$queryRawUnsafe<
        Array<{
          id: string;
          student_id: string;
          consent_status: string;
          school_id: string;
        }>
      >(
        'SELECT c.id::text AS id, c.student_id::text AS student_id, c.consent_status, pr.school_id::text AS school_id ' +
          'FROM ath_highlight_clips c JOIN ath_game_streams st ON st.id = c.stream_id JOIN ath_games g ON g.id = st.game_id JOIN ath_seasons sea ON sea.id = g.season_id JOIN ath_programmes pr ON pr.id = sea.programme_id ' +
          'WHERE c.id = $1::uuid FOR UPDATE OF c',
        clipId,
      );
      if (lock.length === 0) throw new NotFoundException('Highlight clip not found');
      if (lock[0]!.school_id !== tenant.schoolId) {
        throw new NotFoundException('Highlight clip not found');
      }
      if (lock[0]!.consent_status !== 'PENDING') {
        throw new BadRequestException(
          'Consent has already been recorded as ' + lock[0]!.consent_status,
        );
      }
      // Authorisation check
      const isAdmin = await this.hasStreamScope(actor);
      const isStudent = await this.isStudentSelf(t, actor, lock[0]!.student_id);
      const isGuardian = await this.isLinkedGuardian(t, actor, lock[0]!.student_id);
      if (!isAdmin && !isStudent && !isGuardian) {
        throw new ForbiddenException(
          'Only the student, a linked guardian, or the AD/admin can record consent on this clip',
        );
      }
      // REVIEW-P2-8 MAJOR 2 — under-13 COPPA gate. For under-13
      // students, student-self consent is not legally valid. The
      // student must defer to a linked guardian or to an AD/admin
      // recording on their behalf. Resolves the student's date of
      // birth from sis_students and rejects student-self consent
      // when age < 13.
      if (isStudent && !isAdmin && !isGuardian) {
        const ageRows = await t.$queryRawUnsafe<Array<{ age_years: number | null }>>(
          'SELECT EXTRACT(YEAR FROM age(p.date_of_birth))::int AS age_years ' +
            'FROM sis_students s JOIN platform.platform_students ps ON ps.id = s.platform_student_id JOIN platform.iam_person p ON p.id = ps.person_id ' +
            'WHERE s.id = $1::uuid',
          lock[0]!.student_id,
        );
        const ageYears = ageRows[0]?.age_years ?? null;
        if (ageYears !== null && ageYears < 13) {
          throw new ForbiddenException(
            'COPPA: students under 13 cannot self-consent to highlight clip publication. A linked guardian or admin must record consent on their behalf.',
          );
        }
      }
      await t.$executeRawUnsafe(
        'UPDATE ath_highlight_clips SET consent_status = $1, consent_recorded_at = now(), updated_at = now() WHERE id = $2::uuid',
        input.consentStatus,
        clipId,
      );
      const final = await t.$queryRawUnsafe<ClipRow[]>(
        SELECT_CLIP + 'WHERE c.id = $1::uuid',
        clipId,
      );
      return rowToClipDto((final as ClipRow[])[0]!);
    });
  }

  private async isStudentSelf(
    tx: { $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T> },
    actor: ResolvedActor,
    studentId: string,
  ): Promise<boolean> {
    if (actor.personType !== 'STUDENT' || !actor.personId) return false;
    const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      'SELECT s.id FROM sis_students s JOIN platform.platform_students ps ON ps.id = s.platform_student_id WHERE s.id = $1::uuid AND ps.person_id = $2::uuid',
      studentId,
      actor.personId,
    );
    return rows.length > 0;
  }

  private async isLinkedGuardian(
    tx: { $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T> },
    actor: ResolvedActor,
    studentId: string,
  ): Promise<boolean> {
    if (actor.personType !== 'GUARDIAN' || !actor.personId) return false;
    const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      'SELECT sg.id FROM sis_student_guardians sg JOIN sis_guardians g ON g.id = sg.guardian_id WHERE sg.student_id = $1::uuid AND g.person_id = $2::uuid',
      studentId,
      actor.personId,
    );
    return rows.length > 0;
  }

  async addClipToPortfolio(
    clipId: string,
    actor: ResolvedActor,
  ): Promise<HighlightClipResponseDto> {
    if (!(await this.hasStreamScope(actor))) {
      throw new ForbiddenException('Only the AD or admin can link clips to portfolios');
    }
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const t = tx as {
        $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T>;
        $executeRawUnsafe: (sql: string, ...args: unknown[]) => Promise<number>;
      };
      const lock = await t.$queryRawUnsafe<
        Array<{
          id: string;
          student_id: string;
          consent_status: string;
          added_to_portfolio: boolean;
          s3_key: string;
          title: string | null;
          school_id: string;
        }>
      >(
        'SELECT c.id::text AS id, c.student_id::text AS student_id, c.consent_status, c.added_to_portfolio, c.s3_key, c.title, pr.school_id::text AS school_id ' +
          'FROM ath_highlight_clips c JOIN ath_game_streams st ON st.id = c.stream_id JOIN ath_games g ON g.id = st.game_id JOIN ath_seasons sea ON sea.id = g.season_id JOIN ath_programmes pr ON pr.id = sea.programme_id ' +
          'WHERE c.id = $1::uuid FOR UPDATE OF c',
        clipId,
      );
      if (lock.length === 0) throw new NotFoundException('Highlight clip not found');
      if (lock[0]!.school_id !== tenant.schoolId) {
        throw new NotFoundException('Highlight clip not found');
      }
      if (lock[0]!.consent_status !== 'CONSENTED') {
        throw new BadRequestException(
          'Cannot add clip to portfolio without CONSENTED status (current: ' +
            lock[0]!.consent_status +
            ')',
        );
      }
      if (lock[0]!.added_to_portfolio) {
        throw new BadRequestException('Clip is already linked to a portfolio item');
      }
      await t.$executeRawUnsafe(
        'UPDATE ath_highlight_clips SET added_to_portfolio = true, updated_at = now() WHERE id = $1::uuid',
        clipId,
      );
      // REVIEW-P2-8 BLOCKING 4 — durable outbox INSIDE the same tx so
      // a Kafka outage never drops the portfolio-link request silently.
      await this.outbox.enqueueInTx(tx as never, {
        topic: 'ath.highlight_clip.portfolio_link_requested',
        key: clipId,
        sourceModule: 'athletics',
        eventId: deterministicHighlightLinkEventId(clipId),
        payload: {
          clipId,
          studentId: lock[0]!.student_id,
          s3Key: lock[0]!.s3_key,
          title: lock[0]!.title,
          schoolId: tenant.schoolId,
          sourceRefId: clipId,
        },
      });
    });

    return this.getClipById(clipId);
  }

  // ── Game Recordings ─────────────────────────────────────────────

  async listRecordingsForGame(gameId: string): Promise<GameRecordingResponseDto[]> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext((client) =>
      (
        client as { $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T> }
      ).$queryRawUnsafe<RecordingRow[]>(
        SELECT_RECORDING +
          'WHERE game_id = $1::uuid AND EXISTS (SELECT 1 FROM ath_games g JOIN ath_seasons sea ON sea.id = g.season_id JOIN ath_programmes pr ON pr.id = sea.programme_id WHERE g.id = $1::uuid AND pr.school_id = $2::uuid) ' +
          'ORDER BY uploaded_at DESC LIMIT 100',
        gameId,
        tenant.schoolId,
      ),
    );
    return (rows as RecordingRow[]).map(rowToRecordingDto);
  }

  async createRecording(
    gameId: string,
    input: CreateGameRecordingDto,
    actor: ResolvedActor,
  ): Promise<GameRecordingResponseDto> {
    if (!(await this.hasStreamScope(actor))) {
      throw new ForbiddenException('Only the AD or admin can upload game recordings');
    }
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await this.assertGameInSchool(client, gameId);
      await (
        client as { $executeRawUnsafe: (sql: string, ...args: unknown[]) => Promise<number> }
      ).$executeRawUnsafe(
        'INSERT INTO ath_game_recordings (id, game_id, recording_type, s3_key, duration_seconds, title, description, uploaded_by) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::uuid)',
        id,
        gameId,
        input.recordingType,
        input.s3Key,
        input.durationSeconds ?? null,
        input.title ?? null,
        input.description ?? null,
        actor.personId ?? null,
      );
    });
    return this.getRecordingById(id);
  }

  async getRecordingById(id: string): Promise<GameRecordingResponseDto> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext((client) =>
      (
        client as { $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T> }
      ).$queryRawUnsafe<RecordingRow[]>(
        SELECT_RECORDING +
          'WHERE id = $1::uuid AND EXISTS (SELECT 1 FROM ath_games g JOIN ath_seasons sea ON sea.id = g.season_id JOIN ath_programmes pr ON pr.id = sea.programme_id WHERE g.id = ath_game_recordings.game_id AND pr.school_id = $2::uuid)',
        id,
        tenant.schoolId,
      ),
    );
    if ((rows as RecordingRow[]).length === 0) throw new NotFoundException('Recording not found');
    return rowToRecordingDto((rows as RecordingRow[])[0]!);
  }
}
