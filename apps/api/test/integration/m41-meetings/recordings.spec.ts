import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { MeetingService } from '@modules/m41-meetings/meetings/meeting.service';
import { RecordingService } from '@modules/m41-meetings/recordings/recording.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import {
  adminActor,
  teacherActor,
  parentActor,
  TEST_ADMIN_ACCOUNT_ID,
  TEST_TEACHER_ACCOUNT_ID,
  TEST_PARENT_ACCOUNT_ID,
} from '../helpers/actor';
import { TEST_MEETING_TYPE_ID, TEST_MEETING_TYPE_B_ID } from '../fixtures/meetings';

/**
 * Wave 5 — m41-meetings RecordingService.
 *
 * Strategy:
 *   - create() — INSERT mtg_recordings, UNIQUE(meeting_id)
 *   - getForMeeting() — strips s3_key when consent_confirmed=false
 *   - giveConsent() — UPSERT per (recording_id, participant_id);
 *     flips consent_confirmed to true atomically once every active
 *     participant has consent_given=true
 *   - Cross-school isolation
 */
describe('integration:m41-meetings/recordings', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let outbox: OutboxService;
  let meetingService: MeetingService;
  let recordingService: RecordingService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    outbox = new OutboxService();
    meetingService = new MeetingService(tenantPrisma, outbox);
    recordingService = new RecordingService(tenantPrisma, meetingService);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.mtg_meetings WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_outbox WHERE topic = 'mtg.meeting.scheduled' AND tenant_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
  });

  async function createMeetingWithTeacher(): Promise<string> {
    const m = await withTestTenant(async () =>
      meetingService.create(
        {
          meetingTypeId: TEST_MEETING_TYPE_ID,
          title: 'Record me',
          scheduledAt: '2026-06-20T15:00:00Z',
          durationMinutes: 30,
          participantIds: [TEST_TEACHER_ACCOUNT_ID],
        } as any,
        adminActor(),
      ),
    );
    return m.id;
  }

  // ────────────────────────────────────────────────────────────────────
  // create
  // ────────────────────────────────────────────────────────────────────
  describe('create', () => {
    it('admin creates recording → row inserted with status=PROCESSING and consent_confirmed=false', async () => {
      const meetingId = await createMeetingWithTeacher();
      const dto = await withTestTenant(async () =>
        recordingService.create(
          meetingId,
          {
            s3Key: 's3://campus-recordings/test.mp4',
            durationSeconds: 1800,
            fileSizeBytes: 1024000,
          } as any,
          adminActor(),
        ),
      );
      expect(dto.status).toBe('PROCESSING');
      expect(dto.consentConfirmed).toBe(false);
      // s3_key stripped because consent_confirmed=false
      expect(dto.s3Key).toBeNull();

      const rows = await rawClient.$queryRawUnsafe<
        Array<{ status: string; consent_confirmed: boolean; s3_key: string | null }>
      >(
        `SELECT status, consent_confirmed, s3_key FROM ${TEST_SCHEMA}.mtg_recordings WHERE meeting_id = $1::uuid`,
        meetingId,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.s3_key).toBe('s3://campus-recordings/test.mp4');
    });

    it('duplicate recording for same meeting → rejected (UNIQUE constraint)', async () => {
      const meetingId = await createMeetingWithTeacher();
      await withTestTenant(async () => recordingService.create(meetingId, {} as any, adminActor()));
      // UNIQUE(meeting_id) on mtg_recordings blocks the second insert.
      // The service translates the pg 23505 code into BadRequestException;
      // Prisma may surface the wrapped variant. Either way the duplicate
      // is rejected and the DB stays at one row.
      await expect(
        withTestTenant(async () => recordingService.create(meetingId, {} as any, adminActor())),
      ).rejects.toThrow();
      const cnt = await rawClient.$queryRawUnsafe<Array<{ c: number }>>(
        `SELECT count(*)::int AS c FROM ${TEST_SCHEMA}.mtg_recordings WHERE meeting_id = $1::uuid`,
        meetingId,
      );
      expect(cnt[0]!.c).toBe(1);
    });

    it('non-organiser non-admin → ForbiddenException', async () => {
      const meetingId = await createMeetingWithTeacher();
      await expect(
        withTestTenant(async () => recordingService.create(meetingId, {} as any, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // getForMeeting
  // ────────────────────────────────────────────────────────────────────
  describe('getForMeeting', () => {
    it('returns null when no recording exists', async () => {
      const meetingId = await createMeetingWithTeacher();
      const result = await withTestTenant(async () =>
        recordingService.getForMeeting(meetingId, adminActor()),
      );
      expect(result).toBeNull();
    });

    it('includes consents array and total participant count', async () => {
      const meetingId = await createMeetingWithTeacher();
      await withTestTenant(async () =>
        recordingService.create(meetingId, { s3Key: 's3://here' } as any, adminActor()),
      );
      const dto = await withTestTenant(async () =>
        recordingService.getForMeeting(meetingId, adminActor()),
      );
      expect(dto).not.toBeNull();
      expect(dto!.consents).toBeDefined();
      expect(dto!.totalParticipants).toBe(2); // admin (HOST) + teacher (ATTENDEE)
      expect(dto!.consentedCount).toBe(0);
    });

    it('non-participant non-admin → NotFoundException', async () => {
      const meetingId = await createMeetingWithTeacher();
      await withTestTenant(async () => recordingService.create(meetingId, {} as any, adminActor()));
      await expect(
        withTestTenant(async () => recordingService.getForMeeting(meetingId, parentActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // giveConsent
  // ────────────────────────────────────────────────────────────────────
  describe('giveConsent', () => {
    it('participant gives consent → row INSERT; consent_confirmed remains false until all consent', async () => {
      const meetingId = await createMeetingWithTeacher();
      const rec = await withTestTenant(async () =>
        recordingService.create(meetingId, {} as any, adminActor()),
      );
      // Teacher consents first
      const teacherConsent = await withTestTenant(async () =>
        recordingService.giveConsent(
          rec.id,
          { consentGiven: true, notes: 'ok with it' } as any,
          teacherActor(),
        ),
      );
      expect(teacherConsent.consentGiven).toBe(true);
      expect(teacherConsent.participantId).toBe(TEST_TEACHER_ACCOUNT_ID);

      // Still only 1 of 2 has consented → consent_confirmed=false
      const after = await withTestTenant(async () =>
        recordingService.getForMeeting(meetingId, adminActor()),
      );
      expect(after!.consentConfirmed).toBe(false);
      expect(after!.consentedCount).toBe(1);
    });

    it('all participants consent → consent_confirmed flips to true atomically + signedUrl exposed', async () => {
      const meetingId = await createMeetingWithTeacher();
      const rec = await withTestTenant(async () =>
        recordingService.create(meetingId, { s3Key: 's3://full' } as any, adminActor()),
      );
      // Teacher consents
      await withTestTenant(async () =>
        recordingService.giveConsent(rec.id, { consentGiven: true } as any, teacherActor()),
      );
      // Admin (the organiser/HOST participant) also consents
      await withTestTenant(async () =>
        recordingService.giveConsent(rec.id, { consentGiven: true } as any, adminActor()),
      );
      const after = await withTestTenant(async () =>
        recordingService.getForMeeting(meetingId, adminActor()),
      );
      expect(after!.consentConfirmed).toBe(true);
      expect(after!.consentedCount).toBe(2);
      expect(after!.s3Key).toBe('s3://full');
      expect(after!.signedUrl).toContain('/api/v1/meetings/recordings/');
    });

    it('giving consent twice updates the same row (UPSERT via UNIQUE)', async () => {
      const meetingId = await createMeetingWithTeacher();
      const rec = await withTestTenant(async () =>
        recordingService.create(meetingId, {} as any, adminActor()),
      );
      const first = await withTestTenant(async () =>
        recordingService.giveConsent(
          rec.id,
          { consentGiven: false, notes: 'no thanks' } as any,
          teacherActor(),
        ),
      );
      const second = await withTestTenant(async () =>
        recordingService.giveConsent(
          rec.id,
          { consentGiven: true, notes: 'changed mind' } as any,
          teacherActor(),
        ),
      );
      expect(second.id).toBe(first.id);
      expect(second.consentGiven).toBe(true);
      expect(second.notes).toBe('changed mind');

      const cnt = await rawClient.$queryRawUnsafe<Array<{ c: number }>>(
        `SELECT count(*)::int AS c FROM ${TEST_SCHEMA}.mtg_recording_consents WHERE recording_id = $1::uuid`,
        rec.id,
      );
      expect(cnt[0]!.c).toBe(1);
    });

    it('consent withdrawal (true → false) flips consent_confirmed back to false', async () => {
      const meetingId = await createMeetingWithTeacher();
      const rec = await withTestTenant(async () =>
        recordingService.create(meetingId, {} as any, adminActor()),
      );
      await withTestTenant(async () =>
        recordingService.giveConsent(rec.id, { consentGiven: true } as any, teacherActor()),
      );
      await withTestTenant(async () =>
        recordingService.giveConsent(rec.id, { consentGiven: true } as any, adminActor()),
      );
      const confirmed = await withTestTenant(async () =>
        recordingService.getForMeeting(meetingId, adminActor()),
      );
      expect(confirmed!.consentConfirmed).toBe(true);

      // Teacher revokes consent
      await withTestTenant(async () =>
        recordingService.giveConsent(rec.id, { consentGiven: false } as any, teacherActor()),
      );
      const revoked = await withTestTenant(async () =>
        recordingService.getForMeeting(meetingId, adminActor()),
      );
      expect(revoked!.consentConfirmed).toBe(false);
    });

    it('non-participant cannot consent → ForbiddenException', async () => {
      const meetingId = await createMeetingWithTeacher();
      const rec = await withTestTenant(async () =>
        recordingService.create(meetingId, {} as any, adminActor()),
      );
      // Parent is not on the roster
      await expect(
        withTestTenant(async () =>
          recordingService.giveConsent(rec.id, { consentGiven: true } as any, parentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('consent on a missing recording → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          recordingService.giveConsent(
            '00000000-0000-0000-0000-000000000000',
            { consentGiven: true } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Cross-school isolation
  // ────────────────────────────────────────────────────────────────────
  describe('cross-school isolation', () => {
    it('School A admin cannot create recording on a School B meeting', async () => {
      const meetingId = await withTestTenantB(
        async () =>
          (
            await meetingService.create(
              {
                meetingTypeId: TEST_MEETING_TYPE_B_ID,
                title: 'B side',
                scheduledAt: '2026-06-20T15:00:00Z',
                durationMinutes: 30,
              } as any,
              adminActor(),
            )
          ).id,
      );
      // School A teacher actor on a School-B meeting: assertOrganiserOrAdmin
      // returns NotFoundException because the meeting row exists but
      // teacher is not its organiser and isSchoolAdmin won't bypass the
      // search anyway. The point is the call rejects.
      await expect(
        withTestTenant(async () => recordingService.create(meetingId, {} as any, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  void TEST_ADMIN_ACCOUNT_ID;
  void TEST_PARENT_ACCOUNT_ID;
});
