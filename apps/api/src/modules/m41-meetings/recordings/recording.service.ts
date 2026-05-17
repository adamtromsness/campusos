import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import {
  CreateRecordingDto,
  GiveConsentDto,
  RecordingConsentResponseDto,
  RecordingResponseDto,
  RecordingStatus,
} from '../meetings/dto/meeting.dto';
import { MeetingService } from '../meetings/meeting.service';

interface RecordingRow {
  id: string;
  meeting_id: string;
  s3_key: string | null;
  duration_seconds: number | null;
  file_size_bytes: number | null;
  status: string;
  consent_confirmed: boolean;
  created_at: string;
  updated_at: string;
}

interface ConsentRow {
  id: string;
  recording_id: string;
  participant_id: string;
  participant_name: string | null;
  consent_given: boolean;
  consented_at: string;
  notes: string | null;
}

const SELECT_RECORDING =
  'SELECT id::text AS id, meeting_id::text AS meeting_id, s3_key, ' +
  'duration_seconds, file_size_bytes, status, consent_confirmed, ' +
  'TO_CHAR(created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM mtg_recordings ';

const SELECT_CONSENT =
  'SELECT c.id::text AS id, c.recording_id::text AS recording_id, ' +
  'c.participant_id::text AS participant_id, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.platform_users pu " +
  '  JOIN platform.iam_person ip ON ip.id = pu.person_id ' +
  '  WHERE pu.id = c.participant_id) AS participant_name, ' +
  'c.consent_given, ' +
  'TO_CHAR(c.consented_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS consented_at, ' +
  'c.notes ' +
  'FROM mtg_recording_consents c ';

function recordingRowToDto(r: RecordingRow): RecordingResponseDto {
  return {
    id: r.id,
    meetingId: r.meeting_id,
    s3Key: r.s3_key,
    durationSeconds: r.duration_seconds,
    fileSizeBytes: r.file_size_bytes,
    status: r.status as RecordingStatus,
    consentConfirmed: r.consent_confirmed,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function consentRowToDto(r: ConsentRow): RecordingConsentResponseDto {
  return {
    id: r.id,
    recordingId: r.recording_id,
    participantId: r.participant_id,
    participantName: r.participant_name,
    consentGiven: r.consent_given,
    consentedAt: r.consented_at,
    notes: r.notes,
  };
}

@Injectable()
export class RecordingService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly meetings: MeetingService,
  ) {}

  /**
   * Returns the recording row + consent rollup. Refuses to return a
   * signed S3 URL until consent_confirmed is true. Recording metadata
   * (status, consent counts) is visible to all participants so the UI
   * can render the "waiting for consent" message.
   */
  async getForMeeting(
    meetingId: string,
    actor: ResolvedActor,
  ): Promise<RecordingResponseDto | null> {
    if (!actor.isSchoolAdmin) {
      const ok = await this.meetings.isParticipantOrOrganiser(meetingId, actor.accountId);
      if (!ok) throw new NotFoundException('Meeting not found');
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_RECORDING + 'WHERE meeting_id = $1::uuid', meetingId);
    })) as RecordingRow[];
    if (rows.length === 0) return null;
    const dto = recordingRowToDto(rows[0]!);
    const consents = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_CONSENT + 'WHERE c.recording_id = $1::uuid ORDER BY c.consented_at ASC',
        dto.id,
      );
    })) as ConsentRow[];
    dto.consents = consents.map(consentRowToDto);
    dto.consentedCount = consents.filter((c) => c.consent_given).length;
    const totalRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT COUNT(*)::int AS c FROM mtg_meeting_participants WHERE meeting_id = $1::uuid',
        meetingId,
      );
    })) as Array<{ c: number }>;
    dto.totalParticipants = totalRows[0]?.c ?? 0;
    // Strip s3_key when consent_confirmed=false. Production wiring
    // would generate a signed S3 URL here using actor identity.
    if (!dto.consentConfirmed) {
      dto.s3Key = null;
      dto.signedUrl = null;
    } else if (dto.s3Key) {
      // Placeholder for signed-URL integration (deferred). The UI
      // treats signedUrl as a hint that playback is available.
      dto.signedUrl = '/api/v1/meetings/recordings/' + dto.id + '/stream';
    }
    return dto;
  }

  async create(
    meetingId: string,
    input: CreateRecordingDto,
    actor: ResolvedActor,
  ): Promise<RecordingResponseDto> {
    await this.meetings.assertOrganiserOrAdmin(meetingId, actor);
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO mtg_recordings (id, meeting_id, s3_key, duration_seconds, file_size_bytes, status, created_by) ' +
            "VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'PROCESSING', $6::uuid)",
          id,
          meetingId,
          input.s3Key ?? null,
          input.durationSeconds ?? null,
          input.fileSizeBytes ?? null,
          actor.accountId,
        );
      });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === '23505') {
        throw new BadRequestException('A recording already exists for this meeting');
      }
      throw e;
    }
    const result = await this.getForMeeting(meetingId, actor);
    if (!result) throw new NotFoundException('Recording not found');
    return result;
  }

  /**
   * Participant gives or withholds consent for a recording. Idempotent
   * via UNIQUE(recording_id, participant_id). When every meeting
   * participant has a consent_given=true row, consent_confirmed flips
   * true atomically inside the same tx.
   */
  async giveConsent(
    recordingId: string,
    input: GiveConsentDto,
    actor: ResolvedActor,
  ): Promise<RecordingConsentResponseDto> {
    let resolvedConsentId: string | null = null;
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const recordingRows = (await tx.$queryRawUnsafe(
        'SELECT id, meeting_id::text AS meeting_id, consent_confirmed FROM mtg_recordings WHERE id = $1::uuid FOR UPDATE',
        recordingId,
      )) as Array<{ id: string; meeting_id: string; consent_confirmed: boolean }>;
      if (recordingRows.length === 0) throw new NotFoundException('Recording not found');
      const meetingId = recordingRows[0]!.meeting_id;

      // REVIEW-CYCLE15 MAJOR 7. Verify caller is a participant or
      // organiser. Admin no longer auto-bypasses — an admin who is
      // not on the meeting roster cannot consent on behalf of
      // someone else through this surface (a future override path
      // with audit can be added if real-school operations need it).
      const participantRows = (await tx.$queryRawUnsafe(
        'SELECT 1 FROM mtg_meetings WHERE id = $1::uuid AND organiser_id = $2::uuid ' +
          'UNION SELECT 1 FROM mtg_meeting_participants WHERE meeting_id = $1::uuid AND participant_id = $2::uuid',
        meetingId,
        actor.accountId,
      )) as Array<unknown>;
      if (participantRows.length === 0) {
        throw new ForbiddenException(
          'Only meeting participants can give consent. Admins must consent through their own participant row.',
        );
      }

      // UPSERT consent row
      const existing = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id FROM mtg_recording_consents WHERE recording_id = $1::uuid AND participant_id = $2::uuid',
        recordingId,
        actor.accountId,
      )) as Array<{ id: string }>;
      if (existing.length > 0) {
        await tx.$executeRawUnsafe(
          'UPDATE mtg_recording_consents SET consent_given = $1, consented_at = now(), notes = $2 WHERE id = $3::uuid',
          input.consentGiven,
          input.notes ?? null,
          existing[0]!.id,
        );
        resolvedConsentId = existing[0]!.id;
      } else {
        const newId = generateId();
        await tx.$executeRawUnsafe(
          'INSERT INTO mtg_recording_consents (id, recording_id, participant_id, consent_given, notes) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)',
          newId,
          recordingId,
          actor.accountId,
          input.consentGiven,
          input.notes ?? null,
        );
        resolvedConsentId = newId;
      }

      // Recompute consent_confirmed.
      // True when every active participant has a consent_given=true row.
      const stats = (await tx.$queryRawUnsafe(
        'SELECT ' +
          '(SELECT COUNT(*)::int FROM mtg_meeting_participants WHERE meeting_id = $1::uuid) AS total, ' +
          '(SELECT COUNT(DISTINCT c.participant_id)::int FROM mtg_recording_consents c ' +
          '  WHERE c.recording_id = $2::uuid AND c.consent_given = true) AS consented',
        meetingId,
        recordingId,
      )) as Array<{ total: number; consented: number }>;
      const allConsented = stats[0]!.total > 0 && stats[0]!.consented >= stats[0]!.total;
      if (allConsented !== recordingRows[0]!.consent_confirmed) {
        await tx.$executeRawUnsafe(
          'UPDATE mtg_recordings SET consent_confirmed = $1, updated_at = now() WHERE id = $2::uuid',
          allConsented,
          recordingId,
        );
      }
    });

    if (!resolvedConsentId) throw new NotFoundException('Consent row not found');
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_CONSENT + 'WHERE c.id = $1::uuid', resolvedConsentId);
    })) as ConsentRow[];
    return consentRowToDto(rows[0]!);
  }
}
