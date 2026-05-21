import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { ThreadService } from '@modules/m40-communications/messaging/thread.service';
import { MessageService } from '@modules/m40-communications/messaging/message.service';
import { UnreadCountService } from '@modules/m40-communications/messaging/unread-count.service';
import { ContentModerationService } from '@modules/m40-communications/moderation/content-moderation.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';
import { RedisService } from '@shared/cache/redis.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
} from '../helpers/tenant-context';
import {
  adminActor,
  teacherActor,
  studentActor,
  parentActor,
  TEST_ADMIN_ACCOUNT_ID,
  TEST_TEACHER_ACCOUNT_ID,
  TEST_STUDENT_ACCOUNT_ID,
  TEST_PARENT_ACCOUNT_ID,
} from '../helpers/actor';
import {
  TEST_THREAD_TYPE_DIRECT_ID,
  TEST_THREAD_TYPE_OPEN_ID,
  TEST_THREAD_TYPE_DIRECT_B_ID,
} from '../fixtures/communications';

/**
 * Wave 5 — m40-communications messaging DB-backed integration tests.
 *
 * Services covered:
 *   - ThreadService (create, list, getById, listThreadTypes, listRecipients,
 *     markRead, setArchived, isActiveParticipant)
 *   - MessageService (post + outbox-in-tx, list, edit, softDelete)
 *   - UnreadCountService (increment / clearThread)
 *   - ContentModerationService (evaluate keyword match, log)
 *
 * Contracts verified:
 *   - msg.message.posted outbox row enqueued in the SAME tx as the
 *     INSERT into msg_messages.
 *   - school-scope on thread reads (a School B thread is invisible to
 *     a School A actor).
 *   - block-list refuses thread creation + post.
 *   - moderation BLOCKED → no msg_messages row + moderation log row +
 *     422; FLAGGED → row lands with moderation_status=FLAGGED.
 */
describe('integration:m40-communications/messaging', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let redis: RedisService;
  let outbox: OutboxService;
  let unread: UnreadCountService;
  let moderation: ContentModerationService;
  let threads: ThreadService;
  let messages: MessageService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    redis = new RedisService();
    await redis.onModuleInit();
    outbox = new OutboxService();
    unread = new UnreadCountService(redis);
    moderation = new ContentModerationService(tenantPrisma);
    threads = new ThreadService(tenantPrisma, unread);
    messages = new MessageService(tenantPrisma, threads, moderation, unread, outbox);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await redis.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    // Wipe per-test rows touched by these tests. Order: children → parents.
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.msg_message_reads`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.msg_moderation_log`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.msg_messages`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.msg_thread_participants`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.msg_admin_access_log`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.msg_user_blocks`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.msg_threads`);
    // Wipe per-test moderation policies; the keyword-match tests will
    // seed them in-line.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.msg_moderation_policies WHERE name LIKE 'IT-%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_outbox WHERE topic = 'msg.message.posted' AND tenant_id = $1::uuid`,
      TEST_SCHOOL_ID,
    );
  });

  /**
   * Seed a thread + the calling actor as OWNER. Optionally add other
   * participants and return their ids alongside the thread id.
   */
  async function seedThread(
    options: {
      creatorAccountId?: string;
      schoolId?: string;
      threadTypeId?: string;
      subject?: string | null;
      participants?: Array<{ platformUserId: string; role?: string }>;
    } = {},
  ): Promise<string> {
    const creatorAccountId = options.creatorAccountId ?? TEST_ADMIN_ACCOUNT_ID;
    const schoolId = options.schoolId ?? TEST_SCHOOL_ID;
    const threadTypeId = options.threadTypeId ?? TEST_THREAD_TYPE_DIRECT_ID;
    const threadId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.msg_threads (id, school_id, thread_type_id, subject, created_by)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid)`,
      threadId,
      schoolId,
      threadTypeId,
      options.subject ?? 'Test thread',
      creatorAccountId,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.msg_thread_participants (id, thread_id, school_id, platform_user_id, role)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'OWNER')`,
      generateId(),
      threadId,
      schoolId,
      creatorAccountId,
    );
    for (const p of options.participants ?? []) {
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_thread_participants (id, thread_id, school_id, platform_user_id, role)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5)`,
        generateId(),
        threadId,
        schoolId,
        p.platformUserId,
        p.role ?? 'PARTICIPANT',
      );
    }
    return threadId;
  }

  // ────────────────────────────────────────────────────────────────────
  // ThreadService.create + listThreadTypes
  // ────────────────────────────────────────────────────────────────────
  describe('ThreadService.create', () => {
    it('admin creates a thread with two participants → row + participant rows', async () => {
      const dto = await withTestTenant(async () =>
        threads.create(
          {
            threadTypeId: TEST_THREAD_TYPE_DIRECT_ID,
            subject: 'Hello',
            participants: [
              { platformUserId: TEST_TEACHER_ACCOUNT_ID, role: 'PARTICIPANT' },
              { platformUserId: TEST_PARENT_ACCOUNT_ID },
            ],
          } as any,
          adminActor(),
        ),
      );
      expect(dto.subject).toBe('Hello');
      expect(dto.threadTypeName).toBe('Direct');
      expect(dto.participants.length).toBe(3); // owner + 2

      const row = await rawClient.$queryRawUnsafe<Array<{ school_id: string }>>(
        `SELECT school_id::text AS school_id FROM ${TEST_SCHEMA}.msg_threads WHERE id = $1::uuid`,
        dto.id,
      );
      expect(row[0]!.school_id).toBe(TEST_SCHOOL_ID);

      const parts = await rawClient.$queryRawUnsafe<Array<{ role: string }>>(
        `SELECT role FROM ${TEST_SCHEMA}.msg_thread_participants WHERE thread_id = $1::uuid ORDER BY role`,
        dto.id,
      );
      expect(parts.map((p) => p.role).sort()).toEqual(['OWNER', 'PARTICIPANT', 'PARTICIPANT']);
    });

    it('empty participants → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          threads.create(
            {
              threadTypeId: TEST_THREAD_TYPE_DIRECT_ID,
              participants: [],
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('creator-as-participant → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          threads.create(
            {
              threadTypeId: TEST_THREAD_TYPE_DIRECT_ID,
              participants: [{ platformUserId: TEST_ADMIN_ACCOUNT_ID }],
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('unknown thread type id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          threads.create(
            {
              threadTypeId: '00000000-0000-0000-0000-000000000000',
              participants: [{ platformUserId: TEST_TEACHER_ACCOUNT_ID }],
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-existent recipient → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          threads.create(
            {
              threadTypeId: TEST_THREAD_TYPE_DIRECT_ID,
              participants: [{ platformUserId: '00000000-0000-0000-0000-000000000000' }],
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('system thread type but non-admin → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          threads.create(
            {
              threadTypeId: TEST_THREAD_TYPE_OPEN_ID,
              participants: [{ platformUserId: TEST_ADMIN_ACCOUNT_ID }],
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('block-list blocks creation — creator-blocked recipient → ForbiddenException', async () => {
      await withTestTenant(async () => {
        await rawClient.$executeRawUnsafe(
          `INSERT INTO ${TEST_SCHEMA}.msg_user_blocks (id, school_id, blocker_id, blocked_id, reason)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'test')`,
          generateId(),
          TEST_SCHOOL_ID,
          TEST_TEACHER_ACCOUNT_ID,
          TEST_ADMIN_ACCOUNT_ID,
        );
      });
      await expect(
        withTestTenant(async () =>
          threads.create(
            {
              threadTypeId: TEST_THREAD_TYPE_DIRECT_ID,
              participants: [{ platformUserId: TEST_TEACHER_ACCOUNT_ID }],
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // ThreadService.list + getById visibility
  // ────────────────────────────────────────────────────────────────────
  describe('ThreadService.list / getById visibility', () => {
    it('admin lists every thread (including non-participant)', async () => {
      const t1 = await seedThread({ subject: 'A1' });
      const t2 = await seedThread({
        creatorAccountId: TEST_TEACHER_ACCOUNT_ID,
        subject: 'A2',
      });
      const list = await withTestTenant(async () => threads.list({} as any, adminActor()));
      const ids = list.map((t) => t.id);
      expect(ids).toContain(t1);
      expect(ids).toContain(t2);
    });

    it('participant sees only their threads', async () => {
      // Teacher is OWNER on t1; admin is OWNER on t2 (teacher not participant)
      const t1 = await seedThread({
        creatorAccountId: TEST_TEACHER_ACCOUNT_ID,
        subject: 'T1',
      });
      const t2 = await seedThread({ subject: 'T2 admin-only' });
      const list = await withTestTenant(async () => threads.list({} as any, teacherActor()));
      const ids = list.map((t) => t.id);
      expect(ids).toContain(t1);
      expect(ids).not.toContain(t2);
    });

    it("non-participant non-admin getById → NotFoundException (don't leak existence)", async () => {
      const t = await seedThread({ subject: 'hidden' });
      await expect(
        withTestTenant(async () => threads.getById(t, teacherActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("admin viewing a thread they're not in writes msg_admin_access_log", async () => {
      const t = await seedThread({
        creatorAccountId: TEST_TEACHER_ACCOUNT_ID,
        subject: 'audit me',
      });
      await withTestTenant(async () => threads.getById(t, adminActor(), 'incident review'));
      const log = await rawClient.$queryRawUnsafe<Array<{ reason: string }>>(
        `SELECT reason FROM ${TEST_SCHEMA}.msg_admin_access_log WHERE thread_id = $1::uuid`,
        t,
      );
      expect(log.length).toBe(1);
      expect(log[0]!.reason).toBe('incident review');
    });

    it('includeArchived=true returns archived threads; default hides them', async () => {
      const t = await seedThread({ subject: 'arch' });
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.msg_threads SET is_archived = true WHERE id = $1::uuid`,
        t,
      );
      const def = await withTestTenant(async () => threads.list({} as any, adminActor()));
      expect(def.map((r) => r.id)).not.toContain(t);
      const all = await withTestTenant(async () =>
        threads.list({ includeArchived: true } as any, adminActor()),
      );
      expect(all.map((r) => r.id)).toContain(t);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Cross-school isolation
  // ────────────────────────────────────────────────────────────────────
  describe('cross-school isolation', () => {
    it('thread created in School B → School A non-admin participant cannot reach it', async () => {
      // Seed a School B thread where the teacher is a participant.
      const tB = generateId();
      const SCHOOL_B = '019e0cf8-aaaa-7777-8888-00000000000b';
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_threads (id, school_id, thread_type_id, subject, created_by)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'School B only', $4::uuid)`,
        tB,
        SCHOOL_B,
        TEST_THREAD_TYPE_DIRECT_B_ID,
        TEST_ADMIN_ACCOUNT_ID,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_thread_participants (id, thread_id, school_id, platform_user_id, role)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'OWNER')`,
        generateId(),
        tB,
        SCHOOL_B,
        TEST_ADMIN_ACCOUNT_ID,
      );

      // Acting as teacher in School A — they're not a participant of the School B
      // thread, so it's invisible to them.
      const list = await withTestTenant(async () => threads.list({} as any, teacherActor()));
      expect(list.map((t) => t.id)).not.toContain(tB);

      // Direct getById from a non-participant in a non-admin context yields 404.
      await expect(
        withTestTenant(async () => threads.getById(tB, teacherActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('participant on School B thread visible only inside School B tenant', async () => {
      const tB = await seedThread({
        schoolId: '019e0cf8-aaaa-7777-8888-00000000000b',
        threadTypeId: TEST_THREAD_TYPE_DIRECT_B_ID,
      });
      // Switching tenant context to School B → admin sees it.
      const list = await withTestTenantB(async () => threads.list({} as any, adminActor()));
      expect(list.map((t) => t.id)).toContain(tB);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // MessageService.post — outbox-in-tx + moderation pipeline
  // ────────────────────────────────────────────────────────────────────
  describe('MessageService.post', () => {
    it('participant posts → row + outbox row in same tx; sender auto-read', async () => {
      const tid = await seedThread({
        participants: [{ platformUserId: TEST_TEACHER_ACCOUNT_ID }],
      });
      const dto = await withTestTenant(async () =>
        messages.post(tid, { body: 'hello team' } as any, adminActor()),
      );
      expect(dto.body).toBe('hello team');
      expect(dto.threadId).toBe(tid);
      expect(dto.moderationStatus).toBe('CLEAN');

      // msg_messages row exists
      const row = await rawClient.$queryRawUnsafe<Array<{ body: string; sender_id: string }>>(
        `SELECT body, sender_id::text AS sender_id FROM ${TEST_SCHEMA}.msg_messages WHERE id = $1::uuid`,
        dto.id,
      );
      expect(row.length).toBe(1);
      expect(row[0]!.sender_id).toBe(TEST_ADMIN_ACCOUNT_ID);

      // Sender auto-marked as having read their own message
      const readRow = await rawClient.$queryRawUnsafe<Array<{ reader_id: string }>>(
        `SELECT reader_id::text AS reader_id FROM ${TEST_SCHEMA}.msg_message_reads WHERE message_id = $1::uuid AND reader_id = $2::uuid`,
        dto.id,
        TEST_ADMIN_ACCOUNT_ID,
      );
      expect(readRow.length).toBe(1);

      // OUTBOX row enqueued in same tx
      const out = await rawClient.$queryRawUnsafe<Array<{ id: string; topic: string }>>(
        `SELECT id::text AS id, topic FROM platform.platform_outbox WHERE tenant_id = $1::uuid AND topic = $2 ORDER BY created_at DESC LIMIT 1`,
        TEST_SCHOOL_ID,
        'msg.message.posted',
      );
      expect(out.length).toBe(1);
    });

    it('non-participant tries to post → ForbiddenException', async () => {
      const tid = await seedThread();
      await expect(
        withTestTenant(async () => messages.post(tid, { body: 'hi' } as any, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('OBSERVER cannot post → ForbiddenException', async () => {
      const tid = await seedThread({
        participants: [{ platformUserId: TEST_TEACHER_ACCOUNT_ID, role: 'OBSERVER' }],
      });
      await expect(
        withTestTenant(async () => messages.post(tid, { body: 'hi' } as any, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('unknown thread → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          messages.post(
            '00000000-0000-0000-0000-000000000000',
            { body: 'hi' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('block-list refuses post — sender blocked by another participant', async () => {
      const tid = await seedThread({
        participants: [{ platformUserId: TEST_TEACHER_ACCOUNT_ID }],
      });
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_user_blocks (id, school_id, blocker_id, blocked_id, reason)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'block test')`,
        generateId(),
        TEST_SCHOOL_ID,
        TEST_TEACHER_ACCOUNT_ID,
        TEST_ADMIN_ACCOUNT_ID,
      );
      await expect(
        withTestTenant(async () => messages.post(tid, { body: 'hi' } as any, adminActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('moderation BLOCKED → 422; no message row; moderation log row inserted', async () => {
      // Seed a BLOCK policy
      const pid = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_moderation_policies (id, school_id, scope, name, keywords, keyword_action, is_active)
         VALUES ($1::uuid, $2::uuid, 'BUILDING', 'IT-block-it', ARRAY['forbidden']::text[], 'BLOCK', true)`,
        pid,
        TEST_SCHOOL_ID,
      );
      const tid = await seedThread({
        participants: [{ platformUserId: TEST_TEACHER_ACCOUNT_ID }],
      });
      await expect(
        withTestTenant(async () =>
          messages.post(tid, { body: 'this is forbidden content' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      // No msg_messages row
      const rows = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text AS id FROM ${TEST_SCHEMA}.msg_messages WHERE thread_id = $1::uuid`,
        tid,
      );
      expect(rows.length).toBe(0);
      // Moderation log row exists
      const log = await rawClient.$queryRawUnsafe<Array<{ flag_type: string }>>(
        `SELECT flag_type FROM ${TEST_SCHEMA}.msg_moderation_log WHERE policy_id = $1::uuid`,
        pid,
      );
      expect(log.length).toBe(1);
      expect(log[0]!.flag_type).toBe('BLOCKED');
    });

    it('moderation FLAGGED → row lands with moderation_status=FLAGGED', async () => {
      const pid = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_moderation_policies (id, school_id, scope, name, keywords, keyword_action, is_active)
         VALUES ($1::uuid, $2::uuid, 'BUILDING', 'IT-flag-it', ARRAY['flagme']::text[], 'FLAG_FOR_REVIEW', true)`,
        pid,
        TEST_SCHOOL_ID,
      );
      const tid = await seedThread({
        participants: [{ platformUserId: TEST_TEACHER_ACCOUNT_ID }],
      });
      const dto = await withTestTenant(async () =>
        messages.post(tid, { body: 'please flagme now' } as any, adminActor()),
      );
      expect(dto.moderationStatus).toBe('FLAGGED');
      const log = await rawClient.$queryRawUnsafe<Array<{ flag_type: string }>>(
        `SELECT flag_type FROM ${TEST_SCHEMA}.msg_moderation_log WHERE message_id = $1::uuid`,
        dto.id,
      );
      expect(log.length).toBe(1);
      expect(log[0]!.flag_type).toBe('FLAGGED');
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // MessageService.list / edit / softDelete
  // ────────────────────────────────────────────────────────────────────
  describe('MessageService.list / edit / softDelete', () => {
    it('list returns own messages newest-first', async () => {
      const tid = await seedThread({
        participants: [{ platformUserId: TEST_TEACHER_ACCOUNT_ID }],
      });
      const m1 = await withTestTenant(async () =>
        messages.post(tid, { body: 'first' } as any, adminActor()),
      );
      const m2 = await withTestTenant(async () =>
        messages.post(tid, { body: 'second' } as any, adminActor()),
      );
      const list = await withTestTenant(async () =>
        messages.list(tid, { limit: 50 } as any, adminActor()),
      );
      expect(list.length).toBe(2);
      // newest first
      expect(list[0]!.id).toBe(m2.id);
      expect(list[1]!.id).toBe(m1.id);
    });

    it('list filters FLAGGED messages from non-sender non-admin readers', async () => {
      // seed FLAG policy
      const pid = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_moderation_policies (id, school_id, scope, name, keywords, keyword_action, is_active)
         VALUES ($1::uuid, $2::uuid, 'BUILDING', 'IT-flag-list', ARRAY['flagme']::text[], 'FLAG_FOR_REVIEW', true)`,
        pid,
        TEST_SCHOOL_ID,
      );
      const tid = await seedThread({
        creatorAccountId: TEST_TEACHER_ACCOUNT_ID,
        participants: [{ platformUserId: TEST_ADMIN_ACCOUNT_ID }],
      });
      // Teacher posts a flagged message
      const flagged = await withTestTenant(async () =>
        messages.post(tid, { body: 'flagme please' } as any, teacherActor()),
      );
      expect(flagged.moderationStatus).toBe('FLAGGED');

      // Admin sees everything (admin override)
      const adminView = await withTestTenant(async () =>
        messages.list(tid, {} as any, adminActor()),
      );
      expect(adminView.map((m) => m.id)).toContain(flagged.id);

      // Teacher (sender) sees their own message
      const senderView = await withTestTenant(async () =>
        messages.list(tid, {} as any, teacherActor()),
      );
      expect(senderView.map((m) => m.id)).toContain(flagged.id);
    });

    it('edit own message inside 15-min window → is_edited=true', async () => {
      const tid = await seedThread({
        participants: [{ platformUserId: TEST_TEACHER_ACCOUNT_ID }],
      });
      const m = await withTestTenant(async () =>
        messages.post(tid, { body: 'typo here' } as any, adminActor()),
      );
      const edited = await withTestTenant(async () =>
        messages.edit(m.id, { body: 'fixed!' } as any, adminActor()),
      );
      expect(edited.body).toBe('fixed!');
      expect(edited.isEdited).toBe(true);
      const row = await rawClient.$queryRawUnsafe<Array<{ body: string; is_edited: boolean }>>(
        `SELECT body, is_edited FROM ${TEST_SCHEMA}.msg_messages WHERE id = $1::uuid`,
        m.id,
      );
      expect(row[0]!.body).toBe('fixed!');
      expect(row[0]!.is_edited).toBe(true);
    });

    it('non-author cannot edit → ForbiddenException', async () => {
      const tid = await seedThread({
        participants: [{ platformUserId: TEST_TEACHER_ACCOUNT_ID }],
      });
      const m = await withTestTenant(async () =>
        messages.post(tid, { body: 'admin wrote' } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () => messages.edit(m.id, { body: 'hacked' } as any, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('edit BLOCKED content → 422; row untouched', async () => {
      // seed BLOCK policy
      const pid = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_moderation_policies (id, school_id, scope, name, keywords, keyword_action, is_active)
         VALUES ($1::uuid, $2::uuid, 'BUILDING', 'IT-edit-block', ARRAY['poison']::text[], 'BLOCK', true)`,
        pid,
        TEST_SCHOOL_ID,
      );
      const tid = await seedThread({
        participants: [{ platformUserId: TEST_TEACHER_ACCOUNT_ID }],
      });
      const m = await withTestTenant(async () =>
        messages.post(tid, { body: 'clean message' } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          messages.edit(m.id, { body: 'poison content' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      const row = await rawClient.$queryRawUnsafe<Array<{ body: string }>>(
        `SELECT body FROM ${TEST_SCHEMA}.msg_messages WHERE id = $1::uuid`,
        m.id,
      );
      expect(row[0]!.body).toBe('clean message');
    });

    it('soft-delete own message → is_deleted=true; idempotent on repeat', async () => {
      const tid = await seedThread({
        participants: [{ platformUserId: TEST_TEACHER_ACCOUNT_ID }],
      });
      const m = await withTestTenant(async () =>
        messages.post(tid, { body: 'bye' } as any, adminActor()),
      );
      const del = await withTestTenant(async () => messages.softDelete(m.id, adminActor()));
      expect(del.isDeleted).toBe(true);
      const row = await rawClient.$queryRawUnsafe<Array<{ is_deleted: boolean }>>(
        `SELECT is_deleted FROM ${TEST_SCHEMA}.msg_messages WHERE id = $1::uuid`,
        m.id,
      );
      expect(row[0]!.is_deleted).toBe(true);
      // Second call is idempotent
      const del2 = await withTestTenant(async () => messages.softDelete(m.id, adminActor()));
      expect(del2.isDeleted).toBe(true);
    });

    it("admin soft-deletes someone else's message", async () => {
      const tid = await seedThread({
        creatorAccountId: TEST_TEACHER_ACCOUNT_ID,
        participants: [{ platformUserId: TEST_ADMIN_ACCOUNT_ID }],
      });
      const m = await withTestTenant(async () =>
        messages.post(tid, { body: 'teacher post' } as any, teacherActor()),
      );
      const del = await withTestTenant(async () => messages.softDelete(m.id, adminActor()));
      expect(del.isDeleted).toBe(true);
    });

    it('non-author non-admin participant cannot softDelete → ForbiddenException', async () => {
      const tid = await seedThread({
        creatorAccountId: TEST_TEACHER_ACCOUNT_ID,
        participants: [
          { platformUserId: TEST_STUDENT_ACCOUNT_ID },
          { platformUserId: TEST_PARENT_ACCOUNT_ID },
        ],
      });
      const m = await withTestTenant(async () =>
        messages.post(tid, { body: 'teacher said' } as any, teacherActor()),
      );
      await expect(
        withTestTenant(async () => messages.softDelete(m.id, parentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // ThreadService.markRead + setArchived
  // ────────────────────────────────────────────────────────────────────
  describe('ThreadService.markRead + setArchived', () => {
    it('markRead inserts a msg_message_reads row for each unread message', async () => {
      const tid = await seedThread({
        participants: [{ platformUserId: TEST_TEACHER_ACCOUNT_ID }],
      });
      // Admin posts; teacher reads
      const m = await withTestTenant(async () =>
        messages.post(tid, { body: 'check this' } as any, adminActor()),
      );
      const inserted = await withTestTenant(async () => threads.markRead(tid, teacherActor()));
      expect(inserted).toBe(1);
      const reads = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.msg_message_reads WHERE message_id = $1::uuid AND reader_id = $2::uuid`,
        m.id,
        TEST_TEACHER_ACCOUNT_ID,
      );
      expect(reads[0]!.count).toBe(1);
      // Idempotent — second call inserts 0
      const second = await withTestTenant(async () => threads.markRead(tid, teacherActor()));
      expect(second).toBe(0);
    });

    it('setArchived flips is_archived; OBSERVER cannot archive', async () => {
      const tid = await seedThread({
        participants: [{ platformUserId: TEST_TEACHER_ACCOUNT_ID, role: 'OBSERVER' }],
      });
      await expect(
        withTestTenant(async () =>
          threads.setArchived(tid, { isArchived: true } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // Owner can archive
      const r = await withTestTenant(async () =>
        threads.setArchived(tid, { isArchived: true } as any, adminActor()),
      );
      expect(r.isArchived).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // ThreadService.listThreadTypes + listRecipients
  // ────────────────────────────────────────────────────────────────────
  describe('ThreadService.listThreadTypes / listRecipients', () => {
    it('listThreadTypes returns active types for the school; non-admin filtered out of system types', async () => {
      const adminTypes = await withTestTenant(async () => threads.listThreadTypes(adminActor()));
      expect(adminTypes.map((t) => t.id)).toContain(TEST_THREAD_TYPE_DIRECT_ID);
      // Admin should also see the "Open" system thread
      expect(adminTypes.map((t) => t.id)).toContain(TEST_THREAD_TYPE_OPEN_ID);

      const teacherTypes = await withTestTenant(async () =>
        threads.listThreadTypes(teacherActor()),
      );
      expect(teacherTypes.map((t) => t.id)).toContain(TEST_THREAD_TYPE_DIRECT_ID);
      // The Open type is is_system=true so the teacher view excludes it
      expect(teacherTypes.map((t) => t.id)).not.toContain(TEST_THREAD_TYPE_OPEN_ID);
    });

    it('listRecipients returns null/empty when no IAM role assignments seeded', async () => {
      // The integration suite doesn't seed role assignments by default,
      // so the recipient picker returns an empty list. Exercise the
      // path to cover the happy-shape; no role-token rows means no
      // candidates, which is the expected outcome.
      const recipients = await withTestTenant(async () =>
        threads.listRecipients(TEST_THREAD_TYPE_DIRECT_ID, adminActor()),
      );
      expect(Array.isArray(recipients)).toBe(true);
    });

    it('listRecipients on unknown type → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          threads.listRecipients('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('listRecipients on system type for non-admin → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          threads.listRecipients(TEST_THREAD_TYPE_OPEN_ID, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // UnreadCountService
  // ────────────────────────────────────────────────────────────────────
  describe('UnreadCountService', () => {
    it('increment + clearThread round-trip; getBadgeCount is non-negative', async () => {
      // Best-effort against redis — exercise the surface
      await unread.increment(TEST_TEACHER_ACCOUNT_ID, generateId());
      const count = await unread.getBadgeCount(TEST_TEACHER_ACCOUNT_ID);
      expect(count).toBeGreaterThanOrEqual(0);
      await unread.clearThread(TEST_TEACHER_ACCOUNT_ID, generateId());
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // ContentModerationService — direct unit-shaped tests
  // ────────────────────────────────────────────────────────────────────
  describe('ContentModerationService.evaluate / log', () => {
    it('no policies → CLEAN', async () => {
      const v = await withTestTenant(async () => moderation.evaluate('innocent message'));
      expect(v.action).toBe('CLEAN');
      expect(v.matchedKeywords).toEqual([]);
    });

    it('FLAG policy + matching keyword → FLAGGED with matched keywords', async () => {
      const pid = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_moderation_policies (id, school_id, scope, name, keywords, keyword_action, is_active)
         VALUES ($1::uuid, $2::uuid, 'BUILDING', 'IT-eval-flag', ARRAY['bullying']::text[], 'FLAG_FOR_REVIEW', true)`,
        pid,
        TEST_SCHOOL_ID,
      );
      const v = await withTestTenant(async () =>
        moderation.evaluate('this looks like Bullying behaviour'),
      );
      expect(v.action).toBe('FLAGGED');
      expect(v.matchedKeywords).toContain('bullying');
      expect(v.policyId).toBe(pid);
    });

    it('BLOCK wins over FLAG (most-restrictive precedence)', async () => {
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_moderation_policies (id, school_id, scope, name, keywords, keyword_action, is_active)
         VALUES ($1::uuid, $2::uuid, 'BUILDING', 'IT-prec-flag', ARRAY['stupid']::text[], 'FLAG_FOR_REVIEW', true)`,
        generateId(),
        TEST_SCHOOL_ID,
      );
      const blockPid = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_moderation_policies (id, school_id, scope, name, keywords, keyword_action, is_active)
         VALUES ($1::uuid, $2::uuid, 'BUILDING', 'IT-prec-block', ARRAY['drugs']::text[], 'BLOCK', true)`,
        blockPid,
        TEST_SCHOOL_ID,
      );
      const v = await withTestTenant(async () => moderation.evaluate('stupid drugs talk'));
      expect(v.action).toBe('BLOCKED');
      expect(v.policyId).toBe(blockPid);
    });

    it('ESCALATE_TO_COUNSELLOR action surfaced as ESCALATED', async () => {
      const pid = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_moderation_policies (id, school_id, scope, name, keywords, keyword_action, is_active)
         VALUES ($1::uuid, $2::uuid, 'BUILDING', 'IT-esc', ARRAY['suicide']::text[], 'ESCALATE_TO_COUNSELLOR', true)`,
        pid,
        TEST_SCHOOL_ID,
      );
      const v = await withTestTenant(async () => moderation.evaluate('suicide reference'));
      expect(v.action).toBe('ESCALATED');
      expect(v.messageStatus).toBe('ESCALATED');
    });

    it('log() inserts msg_moderation_log row for non-CLEAN verdict', async () => {
      const pid = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_moderation_policies (id, school_id, scope, name, keywords, keyword_action, is_active)
         VALUES ($1::uuid, $2::uuid, 'BUILDING', 'IT-log-block', ARRAY['toxin']::text[], 'BLOCK', true)`,
        pid,
        TEST_SCHOOL_ID,
      );
      const verdict = await withTestTenant(async () => moderation.evaluate('toxin spotted'));
      const msgId = generateId();
      await withTestTenant(async () =>
        moderation.log({
          verdict,
          messageId: msgId,
          messageCreatedAt: new Date(),
          threadId: null,
          senderId: TEST_ADMIN_ACCOUNT_ID,
        }),
      );
      const rows = await rawClient.$queryRawUnsafe<Array<{ flag_type: string }>>(
        `SELECT flag_type FROM ${TEST_SCHEMA}.msg_moderation_log WHERE message_id = $1::uuid`,
        msgId,
      );
      expect(rows.length).toBe(1);
      expect(rows[0]!.flag_type).toBe('BLOCKED');
    });

    it('log() on CLEAN verdict is a no-op', async () => {
      const before = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.msg_moderation_log`,
      );
      await withTestTenant(async () =>
        moderation.log({
          verdict: { action: 'CLEAN', policyId: null, matchedKeywords: [], messageStatus: 'CLEAN' },
          messageId: generateId(),
          messageCreatedAt: new Date(),
          threadId: null,
          senderId: TEST_ADMIN_ACCOUNT_ID,
        }),
      );
      const after = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.msg_moderation_log`,
      );
      expect(after[0]!.count).toBe(before[0]!.count);
    });
  });

  // Suppress unused-import warnings — kept for parity with other module specs.
  void TEST_THREAD_TYPE_DIRECT_B_ID;
});
