import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { ContentModerationService } from './content-moderation.service';
import { ThreadService } from './thread.service';
import { UnreadCountService } from './unread-count.service';
import {
  EditMessageDto,
  ListMessagesQueryDto,
  MessageResponseDto,
  PostMessageDto,
} from './dto/message.dto';

interface MessageRow {
  id: string;
  thread_id: string;
  sender_id: string;
  sender_first_name: string | null;
  sender_last_name: string | null;
  sender_display_name: string | null;
  body: string;
  is_edited: boolean;
  edited_at: Date | string | null;
  is_deleted: boolean;
  deleted_at: Date | string | null;
  moderation_status: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function toIso(v: Date | string | null): string | null {
  if (v === null) return null;
  return typeof v === 'string' ? v : v.toISOString();
}

function rowToDto(r: MessageRow): MessageResponseDto {
  var name =
    r.sender_first_name && r.sender_last_name
      ? r.sender_first_name + ' ' + r.sender_last_name
      : r.sender_display_name || null;
  // Hide the body of soft-deleted messages from non-author readers but keep
  // the row + status visible so the timeline shows "Message deleted" without
  // breaking the conversation flow.
  var body = r.is_deleted ? '' : r.body;
  return {
    id: r.id,
    threadId: r.thread_id,
    senderId: r.sender_id,
    senderName: name,
    body: body,
    isEdited: r.is_edited,
    editedAt: toIso(r.edited_at),
    isDeleted: r.is_deleted,
    deletedAt: toIso(r.deleted_at),
    moderationStatus: r.moderation_status,
    createdAt: toIso(r.created_at) || '',
    updatedAt: toIso(r.updated_at) || '',
  };
}

var SELECT_MESSAGE_BASE =
  'SELECT m.id, m.thread_id, m.sender_id, m.body, m.is_edited, m.edited_at, ' +
  ' m.is_deleted, m.deleted_at, m.moderation_status, m.created_at, m.updated_at, ' +
  ' u.display_name AS sender_display_name, ' +
  ' ip.first_name AS sender_first_name, ip.last_name AS sender_last_name ' +
  'FROM msg_messages m ' +
  'LEFT JOIN platform.platform_users u ON u.id = m.sender_id ' +
  'LEFT JOIN platform.iam_person ip ON ip.id = u.person_id ';

var EDIT_WINDOW_MS = 15 * 60 * 1000;

@Injectable()
export class MessageService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly threads: ThreadService,
    private readonly moderation: ContentModerationService,
    private readonly unread: UnreadCountService,
    private readonly kafka: KafkaProducerService,
  ) {}

  /**
   * Post a message to a thread. Pipeline:
   *   1. Existence + active-participant check (OBSERVERs cannot post).
   *   2. Block-list check between sender and every other participant.
   *   3. Content moderation. BLOCKED → 422 + log, message never persists.
   *      FLAGGED / ESCALATED → message persists with the corresponding
   *      moderation_status; moderator queue picks it up via msg_moderation_log.
   *   4. INSERT into msg_messages, bump msg_threads.last_message_at.
   *   5. Increment Redis unread counter for every other active participant
   *      and emit `msg.message.posted` so the Step 5 MessageNotificationConsumer
   *      can fan out the in-app notifications.
   */
  async post(
    threadId: string,
    body: PostMessageDto,
    actor: ResolvedActor,
  ): Promise<MessageResponseDto> {
    var tenant = getCurrentTenant();

    // Hydrate thread metadata + caller participation in one tx.
    var threadRow = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<
        Array<{ id: string; school_id: string; subject: string | null; thread_type_name: string }>
      >(
        'SELECT t.id, t.school_id, t.subject, tt.name AS thread_type_name ' +
          'FROM msg_threads t ' +
          'JOIN msg_thread_types tt ON tt.id = t.thread_type_id ' +
          'WHERE t.id = $1::uuid',
        threadId,
      );
    });
    if (threadRow.length === 0) throw new NotFoundException('Thread ' + threadId + ' not found');
    var thread = threadRow[0]!;

    var role = await this.threads.activeParticipantRole(threadId, actor.accountId);
    if (role === null) {
      // Admins can read non-participant threads but cannot post — posting
      // would impersonate the admin into a private conversation.
      throw new ForbiddenException('Only thread participants may post messages');
    }
    if (role === 'OBSERVER') {
      throw new ForbiddenException('OBSERVER role cannot post messages to this thread');
    }

    // Block-list — if any other participant has a block in either direction
    // with the sender, refuse the post. The Step 6 plan calls this out
    // explicitly.
    var otherParticipants = await this.loadOtherActiveParticipants(threadId, actor.accountId);
    if (otherParticipants.length > 0) {
      var blocks = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<Array<{ count: bigint }>>(
          'SELECT COUNT(*)::bigint AS count FROM msg_user_blocks ' +
            'WHERE (blocker_id = $1::uuid AND blocked_id = ANY($2::uuid[])) ' +
            ' OR (blocked_id = $1::uuid AND blocker_id = ANY($2::uuid[]))',
          actor.accountId,
          otherParticipants,
        );
      });
      if (blocks.length > 0 && Number(blocks[0]!.count) > 0) {
        throw new ForbiddenException('You cannot send messages to this thread.');
      }
    }

    var verdict = await this.moderation.evaluate(body.body);

    if (verdict.action === 'BLOCKED') {
      // Persist a moderation log row even though the message never lands —
      // the moderator queue tracks attempts. Use a synthetic message id so
      // the soft ref isn't all zeros.
      var blockedMessageId = generateId();
      await this.moderation.log({
        verdict: verdict,
        messageId: blockedMessageId,
        messageCreatedAt: new Date(),
        threadId: threadId,
        senderId: actor.accountId,
      });
      throw new UnprocessableEntityException(
        'This message was not sent because it contains content that violates school policy.',
      );
    }

    var messageId = generateId();
    var createdAt = new Date();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO msg_messages ' +
          '(id, thread_id, school_id, sender_id, body, moderation_status, created_at, updated_at) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::timestamptz, $7::timestamptz)',
        messageId,
        threadId,
        tenant.schoolId,
        actor.accountId,
        body.body,
        verdict.messageStatus,
        createdAt.toISOString(),
      );
      await tx.$executeRawUnsafe(
        'UPDATE msg_threads SET last_message_at = $1::timestamptz, updated_at = now() ' +
          'WHERE id = $2::uuid',
        createdAt.toISOString(),
        threadId,
      );
      // Auto-mark the sender as having read their own message so the badge
      // doesn't pop on their own UI.
      await tx.$executeRawUnsafe(
        'INSERT INTO msg_message_reads (id, message_id, message_created_at, thread_id, reader_id) ' +
          'VALUES ($1::uuid, $2::uuid, $3::timestamptz, $4::uuid, $5::uuid) ' +
          'ON CONFLICT (message_id, reader_id) DO NOTHING',
        generateId(),
        messageId,
        createdAt.toISOString(),
        threadId,
        actor.accountId,
      );
    });

    if (verdict.action !== 'CLEAN') {
      await this.moderation.log({
        verdict: verdict,
        messageId: messageId,
        messageCreatedAt: createdAt,
        threadId: threadId,
        senderId: actor.accountId,
      });
    }

    // Bump per-thread unread counters synchronously so the badge is correct
    // even before the MessageNotificationConsumer catches the Kafka event
    // (which is the slower path that also writes the in-app sorted set).
    for (var i = 0; i < otherParticipants.length; i++) {
      await this.unread.increment(otherParticipants[i]!, threadId);
    }

    // Emit msg.message.posted so the Step 5 MessageNotificationConsumer
    // fans out IN_APP notifications + bumps the inbox HASH (idempotent
    // with the in-process bump above — both write to the same key).
    void this.kafka.emit({
      topic: 'msg.message.posted',
      key: threadId,
      sourceModule: 'communications',
      occurredAt: createdAt.toISOString(),
      payload: {
        messageId: messageId,
        threadId: threadId,
        senderId: actor.accountId,
        body: body.body,
        postedAt: createdAt.toISOString(),
        threadSubject: thread.subject,
        threadType: thread.thread_type_name,
      },
    });

    return this.fetchById(messageId, createdAt);
  }

  /**
   * List messages in a thread, newest-first. Soft-deleted messages remain
   * in the response with an empty body and `isDeleted=true` so the
   * conversation flow stays intact ("Message deleted").
   *
   * Caller must be a thread participant or a school admin (admin reads
   * are audit-logged through ThreadService.getById).
   */
  async list(
    threadId: string,
    query: ListMessagesQueryDto,
    actor: ResolvedActor,
  ): Promise<MessageResponseDto[]> {
    await this.threads.getById(threadId, actor, 'Read thread messages');

    var limit = query.limit ?? 50;
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      var sql = SELECT_MESSAGE_BASE + 'WHERE m.thread_id = $1::uuid ';
      var params: any[] = [threadId];
      if (query.before) {
        sql += 'AND m.created_at < $2::timestamptz ';
        params.push(query.before);
        sql += 'ORDER BY m.created_at DESC LIMIT $3';
        params.push(limit);
      } else {
        sql += 'ORDER BY m.created_at DESC LIMIT $2';
        params.push(limit);
      }
      return client.$queryRawUnsafe<MessageRow[]>(sql, ...params);
    });
    return rows.map(rowToDto);
  }

  /**
   * Edit a message. Author-only. Must be within the EDIT_WINDOW_MS (15min)
   * grace window. Sets is_edited + edited_at; runs the new body through
   * content moderation (BLOCKED edits are refused, FLAGGED edits
   * downgrade `moderation_status`).
   */
  async edit(
    messageId: string,
    body: EditMessageDto,
    actor: ResolvedActor,
  ): Promise<MessageResponseDto> {
    var existing = await this.fetchByIdRaw(messageId);
    if (existing.is_deleted) {
      throw new BadRequestException('Cannot edit a deleted message');
    }
    if (existing.sender_id !== actor.accountId) {
      throw new ForbiddenException('Only the original sender may edit this message');
    }
    var createdAtMs = (typeof existing.created_at === 'string'
      ? new Date(existing.created_at)
      : existing.created_at).getTime();
    if (Date.now() - createdAtMs > EDIT_WINDOW_MS) {
      throw new BadRequestException('Messages can only be edited within 15 minutes of posting');
    }

    var verdict = await this.moderation.evaluate(body.body);
    if (verdict.action === 'BLOCKED') {
      await this.moderation.log({
        verdict: verdict,
        messageId: existing.id,
        messageCreatedAt:
          typeof existing.created_at === 'string'
            ? new Date(existing.created_at)
            : existing.created_at,
        threadId: existing.thread_id,
        senderId: existing.sender_id,
      });
      throw new UnprocessableEntityException(
        'This message was not edited because the new content violates school policy.',
      );
    }

    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'UPDATE msg_messages SET body = $1, is_edited = true, edited_at = now(), ' +
          ' moderation_status = $2, updated_at = now() ' +
          'WHERE id = $3::uuid AND created_at = $4::timestamptz',
        body.body,
        verdict.messageStatus,
        messageId,
        typeof existing.created_at === 'string'
          ? existing.created_at
          : existing.created_at.toISOString(),
      );
    });

    if (verdict.action !== 'CLEAN') {
      await this.moderation.log({
        verdict: verdict,
        messageId: existing.id,
        messageCreatedAt:
          typeof existing.created_at === 'string'
            ? new Date(existing.created_at)
            : existing.created_at,
        threadId: existing.thread_id,
        senderId: existing.sender_id,
      });
    }

    return this.fetchById(messageId, null);
  }

  /**
   * Soft-delete a message. Author or school admin only. Sets is_deleted +
   * deleted_at. The row stays in `msg_messages` so the partition routing +
   * read receipts remain consistent — `rowToDto` blanks the body for
   * non-author readers.
   */
  async softDelete(messageId: string, actor: ResolvedActor): Promise<MessageResponseDto> {
    var existing = await this.fetchByIdRaw(messageId);
    if (existing.is_deleted) {
      // Idempotent — already deleted.
      return this.fetchById(messageId, null);
    }
    var canDelete = existing.sender_id === actor.accountId || actor.isSchoolAdmin;
    if (!canDelete) {
      throw new ForbiddenException('Only the sender or a school administrator may delete a message');
    }
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'UPDATE msg_messages SET is_deleted = true, deleted_at = now(), updated_at = now() ' +
          'WHERE id = $1::uuid AND created_at = $2::timestamptz',
        messageId,
        typeof existing.created_at === 'string'
          ? existing.created_at
          : existing.created_at.toISOString(),
      );
    });
    return this.fetchById(messageId, null);
  }

  // ──────────────────────────────────────────────────────────
  // Internal lookups
  // ──────────────────────────────────────────────────────────

  private async loadOtherActiveParticipants(
    threadId: string,
    senderAccountId: string,
  ): Promise<string[]> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ platform_user_id: string }>>(
        'SELECT platform_user_id::text AS platform_user_id ' +
          'FROM msg_thread_participants ' +
          'WHERE thread_id = $1::uuid AND platform_user_id <> $2::uuid AND left_at IS NULL ' +
          ' AND is_muted = false',
        threadId,
        senderAccountId,
      );
    });
    return rows.map(function (r) {
      return r.platform_user_id;
    });
  }

  private async fetchById(
    messageId: string,
    createdAt: Date | null,
  ): Promise<MessageResponseDto> {
    // Composite PK is (id, created_at) — but `id` is a UUIDv7 with embedded
    // timestamp prefix and the tenant has at most ~10⁵ messages per month,
    // so a `WHERE id = $1` scan against the index is fine. We pass
    // `created_at` only when the caller already knows it (post path) so PG
    // can prune partitions. Otherwise the partition scan goes wide.
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      if (createdAt !== null) {
        return client.$queryRawUnsafe<MessageRow[]>(
          SELECT_MESSAGE_BASE + 'WHERE m.id = $1::uuid AND m.created_at = $2::timestamptz',
          messageId,
          createdAt.toISOString(),
        );
      }
      return client.$queryRawUnsafe<MessageRow[]>(
        SELECT_MESSAGE_BASE + 'WHERE m.id = $1::uuid',
        messageId,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Message ' + messageId + ' not found');
    return rowToDto(rows[0]!);
  }

  private async fetchByIdRaw(messageId: string): Promise<MessageRow> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<MessageRow[]>(
        SELECT_MESSAGE_BASE + 'WHERE m.id = $1::uuid',
        messageId,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Message ' + messageId + ' not found');
    return rows[0]!;
  }
}
