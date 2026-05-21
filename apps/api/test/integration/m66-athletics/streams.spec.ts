import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { ProgrammeService } from '@modules/m66-athletics/programme.service';
import { GameService } from '@modules/m66-athletics/game.service';
import { GameStreamService } from '@modules/m66-athletics/game-stream.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
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
  studentActor,
  parentActor,
  TEST_STUDENT_PERSON_ID,
  TEST_PARENT_PERSON_ID,
  TEST_PARENT_ACCOUNT_ID,
} from '../helpers/actor';
import { seedStudent, ensureGuardianForPerson, linkStudentGuardian } from '../m20-sis/sis-helpers';
import {
  resetAthleticsTables,
  ensureAthleticsSeed,
  TEST_ATH_ROSTER_A_ID,
  TEST_ATH_ROSTER_B_ID,
} from '../fixtures/athletics';

describe('integration:m66-athletics/streams', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let games: GameService;
  let streams: GameStreamService;

  const personIds: string[] = [];
  const platformStudentIds: string[] = [];
  const studentIds: string[] = [];
  const guardianIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    const outbox = new OutboxService();
    const programmes = new ProgrammeService(tenantPrisma, permCheck);
    games = new GameService(tenantPrisma, programmes);
    streams = new GameStreamService(tenantPrisma, permCheck, outbox);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetAthleticsTables(rawClient);
    if (studentIds.length) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sis_student_guardians WHERE student_id = ANY($1::uuid[])`,
        studentIds,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE id = ANY($1::uuid[])`,
        studentIds.splice(0),
      );
    }
    if (platformStudentIds.length) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.platform_students WHERE id = ANY($1::uuid[])`,
        platformStudentIds.splice(0),
      );
    }
    if (guardianIds.length) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sis_guardians WHERE id = ANY($1::uuid[])`,
        guardianIds.splice(0),
      );
    }
    if (personIds.length) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.iam_person WHERE id = ANY($1::uuid[])`,
        personIds.splice(0),
      );
    }
    await ensureAthleticsSeed(rawClient);
  });

  async function trackedSeedStudent(opts: Parameters<typeof seedStudent>[1] = {}) {
    const s = await seedStudent(rawClient, opts);
    studentIds.push(s.studentId);
    platformStudentIds.push(s.platformStudentId);
    personIds.push(s.personId);
    return s;
  }

  async function createGame() {
    return withTestTenant(() =>
      games.create(
        {
          rosterId: TEST_ATH_ROSTER_A_ID,
          gameDate: '2026-09-10',
          gameTime: '15:00',
          opponentName: 'Rival',
          location: 'HOME',
        } as any,
        adminActor(),
      ),
    );
  }

  // ─────────────────────────────────────────────────────────────────
  // Stream lifecycle
  // ─────────────────────────────────────────────────────────────────
  it('configureStream + getById + getByGameId + listLive', async () => {
    const g = await createGame();
    const s = await withTestTenant(() =>
      streams.configureStream(
        g.id,
        { streamUrl: 'rtmp://x', accessLevel: 'PUBLIC' } as any,
        adminActor(),
      ),
    );
    expect(s.streamStatus).toBe('SCHEDULED');
    expect(s.accessLevel).toBe('PUBLIC');

    const got = await withTestTenant(() => streams.getById(s.id));
    expect(got.id).toBe(s.id);

    const byGame = await withTestTenant(() => streams.getByGameId(g.id));
    expect(byGame?.id).toBe(s.id);

    // No live streams yet
    const live = await withTestTenant(() => streams.listLive());
    expect(live).toEqual([]);
  });

  it('configureStream: duplicate → BadRequestException', async () => {
    const g = await createGame();
    await withTestTenant(() => streams.configureStream(g.id, {} as any, adminActor()));
    await expect(
      withTestTenant(() => streams.configureStream(g.id, {} as any, adminActor())),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('configureStream: missing game → BadRequestException', async () => {
    await expect(
      withTestTenant(() =>
        streams.configureStream('00000000-0000-0000-0000-000000000000', {} as any, adminActor()),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('configureStream: student → ForbiddenException', async () => {
    const g = await createGame();
    await expect(
      withTestTenant(() => streams.configureStream(g.id, {} as any, studentActor())),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('configureStream: actor with no personId → ForbiddenException', async () => {
    const g = await createGame();
    const ghost: any = {
      accountId: '019e0cf8-aaaa-7777-8888-000000000099',
      personId: null,
      employeeId: null,
      personType: 'STAFF',
      isSchoolAdmin: true,
    };
    await expect(
      withTestTenant(() => streams.configureStream(g.id, {} as any, ghost)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('getById missing → NotFoundException; getByGameId missing returns null', async () => {
    await expect(
      withTestTenant(() => streams.getById('00000000-0000-0000-0000-000000000000')),
    ).rejects.toBeInstanceOf(NotFoundException);

    const out = await withTestTenant(() =>
      streams.getByGameId('00000000-0000-0000-0000-000000000000'),
    );
    expect(out).toBeNull();
  });

  it('patchStream: SCHEDULED → LIVE → ENDED with timestamps', async () => {
    const g = await createGame();
    const s = await withTestTenant(() => streams.configureStream(g.id, {} as any, adminActor()));
    const live = await withTestTenant(() =>
      streams.patchStream(
        s.id,
        { streamStatus: 'LIVE', streamUrl: 'rtmp://live' } as any,
        adminActor(),
      ),
    );
    expect(live.streamStatus).toBe('LIVE');
    expect(live.startedAt).not.toBeNull();

    const ended = await withTestTenant(() =>
      streams.patchStream(
        s.id,
        {
          streamStatus: 'ENDED',
          recordingS3Key: 'rec/x.mp4',
          recordingDurationSeconds: 7200,
        } as any,
        adminActor(),
      ),
    );
    expect(ended.streamStatus).toBe('ENDED');
    expect(ended.endedAt).not.toBeNull();
    expect(ended.recordingS3Key).toBe('rec/x.mp4');
  });

  it('patchStream: illegal transition → BadRequestException', async () => {
    const g = await createGame();
    const s = await withTestTenant(() => streams.configureStream(g.id, {} as any, adminActor()));
    await expect(
      withTestTenant(() =>
        streams.patchStream(s.id, { streamStatus: 'ENDED' } as any, adminActor()),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('patchStream: no-op + accessLevel change', async () => {
    const g = await createGame();
    const s = await withTestTenant(() => streams.configureStream(g.id, {} as any, adminActor()));
    const noop = await withTestTenant(() => streams.patchStream(s.id, {} as any, adminActor()));
    expect(noop.id).toBe(s.id);
    const updated = await withTestTenant(() =>
      streams.patchStream(s.id, { accessLevel: 'COACHES_ONLY' } as any, adminActor()),
    );
    expect(updated.accessLevel).toBe('COACHES_ONLY');
  });

  it('patchStream: missing → NotFoundException; student → ForbiddenException', async () => {
    await expect(
      withTestTenant(() =>
        streams.patchStream(
          '00000000-0000-0000-0000-000000000000',
          { accessLevel: 'PUBLIC' } as any,
          adminActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      withTestTenant(() =>
        streams.patchStream(
          '00000000-0000-0000-0000-000000000000',
          { accessLevel: 'PUBLIC' } as any,
          studentActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('listLive: returns LIVE-only', async () => {
    const g = await createGame();
    const s = await withTestTenant(() => streams.configureStream(g.id, {} as any, adminActor()));
    await withTestTenant(() =>
      streams.patchStream(s.id, { streamStatus: 'LIVE' } as any, adminActor()),
    );
    const live = await withTestTenant(() => streams.listLive());
    expect(live.map((x) => x.id)).toContain(s.id);
  });

  // ─────────────────────────────────────────────────────────────────
  // Clips
  // ─────────────────────────────────────────────────────────────────
  describe('Highlight clips', () => {
    async function setupClip() {
      const g = await createGame();
      const s = await withTestTenant(() => streams.configureStream(g.id, {} as any, adminActor()));
      const stu = await trackedSeedStudent({ firstName: 'Player' });
      const c = await withTestTenant(() =>
        streams.createClip(
          s.id,
          {
            studentId: stu.studentId,
            startTimeSeconds: 0,
            endTimeSeconds: 10,
            s3Key: 'clips/x.mp4',
            title: 'Goal',
          } as any,
          adminActor(),
        ),
      );
      return { stream: s, clip: c, student: stu };
    }

    it('createClip + listClipsForStream + listClipsForStudent + getClipById', async () => {
      const { stream, clip, student } = await setupClip();
      expect(clip.consentStatus).toBe('PENDING');

      const byStream = await withTestTenant(() => streams.listClipsForStream(stream.id));
      expect(byStream.map((x) => x.id)).toContain(clip.id);

      const byStudent = await withTestTenant(() => streams.listClipsForStudent(student.studentId));
      expect(byStudent.map((x) => x.id)).toContain(clip.id);

      const got = await withTestTenant(() => streams.getClipById(clip.id));
      expect(got.id).toBe(clip.id);
    });

    it('createClip: bad time window → BadRequestException', async () => {
      const g = await createGame();
      const s = await withTestTenant(() => streams.configureStream(g.id, {} as any, adminActor()));
      const stu = await trackedSeedStudent();
      await expect(
        withTestTenant(() =>
          streams.createClip(
            s.id,
            {
              studentId: stu.studentId,
              startTimeSeconds: 10,
              endTimeSeconds: 5,
              s3Key: 'x.mp4',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('createClip: missing stream → BadRequestException', async () => {
      const stu = await trackedSeedStudent();
      await expect(
        withTestTenant(() =>
          streams.createClip(
            '00000000-0000-0000-0000-000000000000',
            {
              studentId: stu.studentId,
              startTimeSeconds: 0,
              endTimeSeconds: 10,
              s3Key: 'x.mp4',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('createClip: missing student → BadRequestException', async () => {
      const g = await createGame();
      const s = await withTestTenant(() => streams.configureStream(g.id, {} as any, adminActor()));
      await expect(
        withTestTenant(() =>
          streams.createClip(
            s.id,
            {
              studentId: '00000000-0000-0000-0000-000000000000',
              startTimeSeconds: 0,
              endTimeSeconds: 10,
              s3Key: 'x.mp4',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('createClip: student → ForbiddenException', async () => {
      const g = await createGame();
      const s = await withTestTenant(() => streams.configureStream(g.id, {} as any, adminActor()));
      const stu = await trackedSeedStudent();
      await expect(
        withTestTenant(() =>
          streams.createClip(
            s.id,
            {
              studentId: stu.studentId,
              startTimeSeconds: 0,
              endTimeSeconds: 10,
              s3Key: 'x.mp4',
            } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('getClipById missing → NotFoundException', async () => {
      await expect(
        withTestTenant(() => streams.getClipById('00000000-0000-0000-0000-000000000000')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('recordClipConsent: admin CONSENTED + duplicate consent → BadRequestException', async () => {
      const { clip } = await setupClip();
      const after = await withTestTenant(() =>
        streams.recordClipConsent(clip.id, { consentStatus: 'CONSENTED' } as any, adminActor()),
      );
      expect(after.consentStatus).toBe('CONSENTED');

      await expect(
        withTestTenant(() =>
          streams.recordClipConsent(clip.id, { consentStatus: 'DECLINED' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('recordClipConsent: parent linked → consent allowed', async () => {
      // Setup a parent linked to a clip student
      const g = await createGame();
      const s = await withTestTenant(() => streams.configureStream(g.id, {} as any, adminActor()));
      const stu = await trackedSeedStudent({ firstName: 'P' });
      const guardianId = await ensureGuardianForPerson(
        rawClient,
        TEST_PARENT_PERSON_ID,
        TEST_PARENT_ACCOUNT_ID,
      );
      guardianIds.push(guardianId);
      await linkStudentGuardian(rawClient, stu.studentId, guardianId);

      const c = await withTestTenant(() =>
        streams.createClip(
          s.id,
          {
            studentId: stu.studentId,
            startTimeSeconds: 0,
            endTimeSeconds: 5,
            s3Key: 'x.mp4',
          } as any,
          adminActor(),
        ),
      );
      const after = await withTestTenant(() =>
        streams.recordClipConsent(c.id, { consentStatus: 'CONSENTED' } as any, parentActor()),
      );
      expect(after.consentStatus).toBe('CONSENTED');
    });

    it('recordClipConsent: missing clip → NotFoundException', async () => {
      await expect(
        withTestTenant(() =>
          streams.recordClipConsent(
            '00000000-0000-0000-0000-000000000000',
            { consentStatus: 'CONSENTED' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('recordClipConsent: unrelated student → ForbiddenException', async () => {
      const { clip } = await setupClip();
      // Random student actor with no link
      await expect(
        withTestTenant(() =>
          streams.recordClipConsent(clip.id, { consentStatus: 'CONSENTED' } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('recordClipConsent: COPPA under-13 student-self → ForbiddenException', async () => {
      // Create a clip for a student linked to studentActor.personId with DOB making them < 13.
      const g = await createGame();
      const s = await withTestTenant(() => streams.configureStream(g.id, {} as any, adminActor()));
      // Create platform_students row for studentActor.personId if missing
      const existingPs = (await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text AS id FROM platform.platform_students WHERE person_id = $1::uuid LIMIT 1`,
        TEST_STUDENT_PERSON_ID,
      )) as Array<{ id: string }>;
      let psId: string;
      if (existingPs.length > 0) {
        psId = existingPs[0]!.id;
      } else {
        const created = (await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
          `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
           VALUES (gen_random_uuid(), $1::uuid, 'Y', 'Stu', true)
           RETURNING id::text AS id`,
          TEST_STUDENT_PERSON_ID,
        )) as Array<{ id: string }>;
        psId = created[0]!.id;
        platformStudentIds.push(psId);
      }
      // Force iam_person DOB to 5 years ago.
      const youngDob = new Date(Date.now() - 5 * 365 * 86400000).toISOString().slice(0, 10);
      await rawClient.$executeRawUnsafe(
        `UPDATE platform.iam_person SET date_of_birth = $1::date WHERE id = $2::uuid`,
        youngDob,
        TEST_STUDENT_PERSON_ID,
      );
      // Idempotent sis_students row
      const existingStu = (await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text AS id FROM ${TEST_SCHEMA}.sis_students WHERE platform_student_id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
        psId,
        TEST_SCHOOL_ID,
      )) as Array<{ id: string }>;
      let stuId: string;
      if (existingStu.length > 0) {
        stuId = existingStu[0]!.id;
      } else {
        const created = (await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
          `INSERT INTO ${TEST_SCHEMA}.sis_students (id, platform_student_id, school_id, student_number, grade_level, enrollment_status)
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, '5', 'ENROLLED')
           RETURNING id::text AS id`,
          psId,
          TEST_SCHOOL_ID,
          'COPPA-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
        )) as Array<{ id: string }>;
        stuId = created[0]!.id;
        studentIds.push(stuId);
      }
      const c = await withTestTenant(() =>
        streams.createClip(
          s.id,
          {
            studentId: stuId,
            startTimeSeconds: 0,
            endTimeSeconds: 5,
            s3Key: 'x.mp4',
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(() =>
          streams.recordClipConsent(c.id, { consentStatus: 'CONSENTED' } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      // Clear DOB so we don't poison future tests
      await rawClient.$executeRawUnsafe(
        `UPDATE platform.iam_person SET date_of_birth = NULL WHERE id = $1::uuid`,
        TEST_STUDENT_PERSON_ID,
      );
    });

    it('addClipToPortfolio: consented → emits outbox', async () => {
      const { clip } = await setupClip();
      await withTestTenant(() =>
        streams.recordClipConsent(clip.id, { consentStatus: 'CONSENTED' } as any, adminActor()),
      );
      const after = await withTestTenant(() => streams.addClipToPortfolio(clip.id, adminActor()));
      expect(after.addedToPortfolio).toBe(true);

      const outboxRows = (await rawClient.$queryRawUnsafe(
        `SELECT id FROM platform.platform_outbox WHERE topic = 'ath.highlight_clip.portfolio_link_requested' AND message_key = $1`,
        clip.id,
      )) as unknown[];
      expect(outboxRows.length).toBe(1);
    });

    it('addClipToPortfolio: not consented → BadRequestException', async () => {
      const { clip } = await setupClip();
      await expect(
        withTestTenant(() => streams.addClipToPortfolio(clip.id, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('addClipToPortfolio: already added → BadRequestException', async () => {
      const { clip } = await setupClip();
      await withTestTenant(() =>
        streams.recordClipConsent(clip.id, { consentStatus: 'CONSENTED' } as any, adminActor()),
      );
      await withTestTenant(() => streams.addClipToPortfolio(clip.id, adminActor()));
      await expect(
        withTestTenant(() => streams.addClipToPortfolio(clip.id, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('addClipToPortfolio: missing → NotFoundException; student → ForbiddenException', async () => {
      await expect(
        withTestTenant(() =>
          streams.addClipToPortfolio('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        withTestTenant(() =>
          streams.addClipToPortfolio('00000000-0000-0000-0000-000000000000', studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Recordings
  // ─────────────────────────────────────────────────────────────────
  describe('Game recordings', () => {
    it('createRecording + listRecordingsForGame + getRecordingById', async () => {
      const g = await createGame();
      const r = await withTestTenant(() =>
        streams.createRecording(
          g.id,
          {
            recordingType: 'FULL_GAME',
            s3Key: 'rec/full.mp4',
            durationSeconds: 7200,
            title: 'Full',
          } as any,
          adminActor(),
        ),
      );
      expect(r.recordingType).toBe('FULL_GAME');

      const list = await withTestTenant(() => streams.listRecordingsForGame(g.id));
      expect(list.map((x) => x.id)).toContain(r.id);

      const got = await withTestTenant(() => streams.getRecordingById(r.id));
      expect(got.id).toBe(r.id);
    });

    it('createRecording: missing game → BadRequestException', async () => {
      await expect(
        withTestTenant(() =>
          streams.createRecording(
            '00000000-0000-0000-0000-000000000000',
            { recordingType: 'FULL_GAME', s3Key: 'x' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('createRecording: student → ForbiddenException', async () => {
      const g = await createGame();
      await expect(
        withTestTenant(() =>
          streams.createRecording(
            g.id,
            { recordingType: 'FULL_GAME', s3Key: 'x' } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('getRecordingById missing → NotFoundException', async () => {
      await expect(
        withTestTenant(() => streams.getRecordingById('00000000-0000-0000-0000-000000000000')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // hasStreamScope + cross-school
  // ─────────────────────────────────────────────────────────────────
  it('hasStreamScope: admin true / student false', async () => {
    const a = await withTestTenant(() => streams.hasStreamScope(adminActor()));
    expect(a).toBe(true);
    const s = await withTestTenant(() => streams.hasStreamScope(studentActor()));
    expect(s).toBe(false);
  });

  it('cross-school: School A cannot see School B stream', async () => {
    // Seed a B-game + stream directly
    const bGameId = generateId();
    const bStreamId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.ath_games (id, season_id, roster_id, game_date, game_time, opponent_name, location, status) VALUES ($1::uuid, $2::uuid, $3::uuid, '2026-09-01', '15:00', 'B-Opp', 'HOME', 'SCHEDULED')`,
      bGameId,
      (await import('../fixtures/athletics')).TEST_ATH_SEASON_B_ID,
      TEST_ATH_ROSTER_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.ath_game_streams (id, game_id, configured_by, stream_status, access_level) VALUES ($1::uuid, $2::uuid, $3::uuid, 'SCHEDULED', 'PUBLIC')`,
      bStreamId,
      bGameId,
      // Use admin person id as the configurer
      '019e0cf8-aaaa-7777-8888-000000000010',
    );
    await expect(withTestTenant(() => streams.getById(bStreamId))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const a = await withTestTenant(() => streams.getByGameId(bGameId));
    expect(a).toBeNull();
  });
});
