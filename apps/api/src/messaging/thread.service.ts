import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { UnreadCountService } from './unread-count.service';
import {
  ArchiveThreadDto,
  CreateThreadDto,
  ListThreadsQueryDto,
  ThreadParticipantDto,
  ThreadResponseDto,
} from './dto/thread.dto';

interface ThreadRow {
  id: string;
  school_id: string;
  thread_type_id: string;
  thread_type_name: string;
  subject: string | null;
  created_by: string;
  last_message_at: Date | string | null;
  is_archived: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ParticipantRow {
  id: string;
  thread_id: string;
  platform_user_id: string;
  role: string;
  display_name: string | null;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  is_muted: boolean;
  last_read_at: Date | string | null;
  left_at: Date | string | null;
}

function toIso(v: Date | string | null): string | null {
  if (v === null) return null;
  return typeof v === 'string' ? v : v.toISOString();
}

function rowToDto(
  t: ThreadRow,
  participants: ParticipantRow[],
  unreadCount: number,
): ThreadResponseDto {
  return {
    id: t.id,
    schoolId: t.school_id,
    threadTypeId: t.thread_type_id,
    threadTypeName: t.thread_type_name,
    subject: t.subject,
    createdBy: t.created_by,
    lastMessageAt: toIso(t.last_message_at),
    isArchived: t.is_archived,
    createdAt: toIso(t.created_at) || '',
    updatedAt: toIso(t.updated_at) || '',
    participants: participants.map(participantRowToDto),
    unreadCount: unreadCount,
  };
}

function participantRowToDto(p: ParticipantRow): ThreadParticipantDto {
  var name =
    p.first_name && p.last_name ? p.first_name + ' ' + p.last_name : p.display_name || p.email;
  return {
    id: p.id,
    platformUserId: p.platform_user_id,
    role: p.role,
    displayName: name,
    email: p.email,
    isMuted: p.is_muted,
    lastReadAt: toIso(p.last_read_at),
    leftAt: toIso(p.left_at),
  };
}

/**
 * Map an iam_roles.name (the human-readable role name in the seed) to the
 * synthetic role token stored in `msg_thread_types.allowed_participant_roles`.
 *
 * The seed uses tokens like 'TEACHER', 'PARENT', 'STUDENT', 'SCHOOL_ADMIN',
 * 'PLATFORM_ADMIN', 'STAFF'. The IAM role table uses 'Teacher', 'Parent',
 * 'Student', 'School Admin', 'Platform Admin', 'Staff'. The conversion is
 * simply UPPER + spaces → underscores.
 */
function roleNameToToken(name: string): string {
  return name.toUpperCase().replace(/\s+/g, '_');
}

@Injectable()
export class ThreadService {
  private readonly logger = new Logger(ThreadService.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly unread: UnreadCountService,
  ) {}

  /**
   * List threads visible to the actor. STAFF / GUARDIAN / STUDENT see only
   * threads they are an active participant in. School admins see every
   * thread in the tenant — admin reads of non-participant threads are
   * audit-logged via msg_admin_access_log when the caller hits a per-thread
   * read endpoint (Step 6 ships the schema; the audit log entry lands in
   * `getById` below).
   */
  async list(
    filters: ListThreadsQueryDto,
    actor: ResolvedActor,
  ): Promise<ThreadResponseDto[]> {
    var includeArchived = filters.includeArchived === true;
    var threads = await this.tenantPrisma.executeInTenantContext(async (client) => {
      var sql =
        'SELECT t.id, t.school_id, t.thread_type_id, tt.name AS thread_type_name, ' +
        ' t.subject, t.created_by, t.last_message_at, t.is_archived, ' +
        ' t.created_at, t.updated_at ' +
        'FROM msg_threads t ' +
        'JOIN msg_thread_types tt ON tt.id = t.thread_type_id ';
      var params: any[] = [];
      if (!actor.isSchoolAdmin) {
        sql +=
          'JOIN msg_thread_participants p ON p.thread_id = t.id AND p.platform_user_id = $1::uuid AND p.left_at IS NULL ';
        params.push(actor.accountId);
      }
      if (!includeArchived) {
        sql += 'WHERE t.is_archived = false ';
      } else {
        sql += 'WHERE 1=1 ';
      }
      sql += 'ORDER BY t.last_message_at DESC NULLS LAST, t.created_at DESC';
      return client.$queryRawUnsafe<ThreadRow[]>(sql, ...params);
    });
    if (threads.length === 0) return [];

    var threadIds = threads.map(function (t) {
      return t.id;
    });
    var participants = await this.loadParticipants(threadIds);
    var byThread: Record<string, ParticipantRow[]> = {};
    for (var i = 0; i < participants.length; i++) {
      var pr = participants[i]!;
      (byThread[pr.thread_id] = byThread[pr.thread_id] || []).push(pr);
    }
    var unread = await this.unread.getByThread(actor.accountId);
    return threads.map(function (t) {
      return rowToDto(t, byThread[t.id] || [], unread[t.id] || 0);
    });
  }

  /**
   * Single-thread read. Throws 404 when the actor is not a participant
   * AND not a school admin. The 404 collapses 403 → 404 to avoid probing.
   * When a school admin opens a non-participant thread we write a row to
   * `msg_admin_access_log` (FERPA audit per Step 3 design notes).
   */
  async getById(id: string, actor: ResolvedActor, reason?: string): Promise<ThreadResponseDto> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ThreadRow[]>(
        'SELECT t.id, t.school_id, t.thread_type_id, tt.name AS thread_type_name, ' +
          ' t.subject, t.created_by, t.last_message_at, t.is_archived, ' +
          ' t.created_at, t.updated_at ' +
          'FROM msg_threads t ' +
          'JOIN msg_thread_types tt ON tt.id = t.thread_type_id ' +
          'WHERE t.id = $1::uuid',
        id,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Thread ' + id + ' not found');
    var t = rows[0]!;

    var isParticipant = await this.isActiveParticipant(id, actor.accountId);
    if (!isParticipant) {
      if (!actor.isSchoolAdmin) {
        throw new NotFoundException('Thread ' + id + ' not found');
      }
      // Admin reading a non-participant thread — audit it.
      await this.logAdminAccess(id, actor.accountId, reason || 'Admin thread review');
    }

    var participants = await this.loadParticipants([id]);
    var unread = isParticipant ? await this.unread.getByThread(actor.accountId) : {};
    return rowToDto(t, participants, unread[id] || 0);
  }

  /**
   * Create a thread + participants. Validates:
   *   - threadTypeId belongs to this school + is_active.
   *   - allowed_participant_roles is empty (system threads only — admins/system)
   *     OR the creator AND every recipient holds at least one matching IAM role
   *     in the tenant scope chain.
   *   - participant accounts exist in `platform.platform_users`.
   *   - block-list: the creator can't add a participant who has blocked them
   *     (or vice versa).
   *
   * Atomic: writes to `msg_threads` + `msg_thread_participants` inside a
   * single tenant transaction. If `initialMessage` is supplied the caller
   * is expected to also call MessageService.post() — this service does NOT
   * post the message itself to keep the moderation flow centralised in
   * MessageService. The controller composes the two calls.
   */
  async create(input: CreateThreadDto, actor: ResolvedActor): Promise<ThreadResponseDto> {
    var tenant = getCurrentTenant();

    if (input.participants.length === 0) {
      throw new BadRequestException('At least one participant is required');
    }

    // Reject duplicates and self-as-recipient up front.
    var seen: Record<string, boolean> = {};
    var recipientIds: string[] = [];
    for (var i = 0; i < input.participants.length; i++) {
      var pid = input.participants[i]!.platformUserId;
      if (pid === actor.accountId) {
        throw new BadRequestException('The thread creator is added automatically and must not appear in `participants`');
      }
      if (seen[pid]) continue;
      seen[pid] = true;
      recipientIds.push(pid);
    }

    var threadTypeRows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<
        Array<{
          id: string;
          name: string;
          allowed_participant_roles: string[];
          is_active: boolean;
          is_system: boolean;
        }>
      >(
        'SELECT id::text AS id, name, allowed_participant_roles, is_active, is_system ' +
          'FROM msg_thread_types ' +
          'WHERE id = $1::uuid AND school_id = $2::uuid',
        input.threadTypeId,
        tenant.schoolId,
      );
    });
    if (threadTypeRows.length === 0) {
      throw new NotFoundException('Thread type ' + input.threadTypeId + ' not found');
    }
    var threadType = threadTypeRows[0]!;
    if (!threadType.is_active) {
      throw new BadRequestException('Thread type ' + threadType.name + ' is not active');
    }
    if (threadType.is_system && !actor.isSchoolAdmin) {
      throw new ForbiddenException('System thread types may only be created by administrators');
    }

    // Role check — only when the thread type pins allowed roles. Empty
    // array means "any role" (per the seed convention for system threads).
    if (threadType.allowed_participant_roles.length > 0) {
      var allowed = threadType.allowed_participant_roles;
      var allAccountIds = [actor.accountId].concat(recipientIds);
      var rolesByAccount = await this.loadRoleTokens(allAccountIds, tenant.schoolId);
      for (var ai = 0; ai < allAccountIds.length; ai++) {
        var aid = allAccountIds[ai]!;
        var tokens = rolesByAccount[aid] || [];
        var ok = false;
        for (var k = 0; k < tokens.length; k++) {
          if (allowed.indexOf(tokens[k]!) >= 0) {
            ok = true;
            break;
          }
        }
        if (!ok) {
          throw new BadRequestException(
            'Participant ' +
              aid +
              ' does not hold any of the required roles for thread type ' +
              threadType.name +
              ' (' +
              allowed.join(', ') +
              ')',
          );
        }
      }
    }

    // Validate every recipient has a platform_users row in the system.
    var existing = await this.tenantPrisma
      .getPlatformClient()
      .platformUser.findMany({
        where: { id: { in: recipientIds } },
        select: { id: true },
      });
    var existingSet: Record<string, boolean> = {};
    for (var ei = 0; ei < existing.length; ei++) existingSet[existing[ei]!.id] = true;
    for (var ri = 0; ri < recipientIds.length; ri++) {
      if (!existingSet[recipientIds[ri]!]) {
        throw new BadRequestException('Recipient ' + recipientIds[ri] + ' does not exist');
      }
    }

    // Block-list check: creator cannot add a recipient who blocked them OR
    // a recipient the creator has blocked. Either side severs messaging.
    await this.assertNoBlocks(actor.accountId, recipientIds);

    var threadId = generateId();

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO msg_threads (id, school_id, thread_type_id, subject, created_by) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid)',
        threadId,
        tenant.schoolId,
        threadType.id,
        input.subject ?? null,
        actor.accountId,
      );
      // Owner row first — the creator is always added with role OWNER even
      // if they appeared in the input list with a different role.
      await tx.$executeRawUnsafe(
        "INSERT INTO msg_thread_participants (id, thread_id, school_id, platform_user_id, role) " +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'OWNER') " +
          'ON CONFLICT (thread_id, platform_user_id) DO NOTHING',
        generateId(),
        threadId,
        tenant.schoolId,
        actor.accountId,
      );
      for (var pi = 0; pi < input.participants.length; pi++) {
        var pp = input.participants[pi]!;
        if (pp.platformUserId === actor.accountId) continue;
        await tx.$executeRawUnsafe(
          'INSERT INTO msg_thread_participants (id, thread_id, school_id, platform_user_id, role) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5) ' +
            'ON CONFLICT (thread_id, platform_user_id) DO NOTHING',
          generateId(),
          threadId,
          tenant.schoolId,
          pp.platformUserId,
          pp.role || 'PARTICIPANT',
        );
      }
    });

    return this.getById(threadId, actor);
  }

  /**
   * Mark every unread message in a thread as read for the calling user
   * (idempotent — re-running is a no-op except for `last_read_at`). Clears
   * the per-thread Redis unread counter on success.
   *
   * Inserts a `msg_message_reads` row for each unread message (ON CONFLICT
   * DO NOTHING). Updates `msg_thread_participants.last_read_at` so the
   * inbox UI can render a "last seen" indicator.
   *
   * Returns the number of newly-inserted read rows. School admins who are
   * not participants can still call this — the call is a no-op for them
   * (no participant row to update; no Redis counter to clear).
   */
  async markRead(threadId: string, actor: ResolvedActor): Promise<number> {
    // Existence + visibility check
    await this.getById(threadId, actor);

    var marked = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      var unread = await tx.$queryRawUnsafe<
        Array<{ id: string; created_at: Date; thread_id: string }>
      >(
        'SELECT m.id, m.created_at, m.thread_id ' +
          'FROM msg_messages m ' +
          'WHERE m.thread_id = $1::uuid ' +
          ' AND m.sender_id <> $2::uuid ' +
          ' AND m.is_deleted = false ' +
          ' AND NOT EXISTS (' +
          '   SELECT 1 FROM msg_message_reads r ' +
          '   WHERE r.message_id = m.id AND r.reader_id = $2::uuid' +
          ')',
        threadId,
        actor.accountId,
      );
      var inserted = 0;
      for (var i = 0; i < unread.length; i++) {
        var u = unread[i]!;
        var n = await tx.$executeRawUnsafe(
          'INSERT INTO msg_message_reads (id, message_id, message_created_at, thread_id, reader_id) ' +
            'VALUES ($1::uuid, $2::uuid, $3::timestamptz, $4::uuid, $5::uuid) ' +
            'ON CONFLICT (message_id, reader_id) DO NOTHING',
          generateId(),
          u.id,
          (typeof u.created_at === 'string' ? u.created_at : u.created_at.toISOString()),
          u.thread_id,
          actor.accountId,
        );
        if (typeof n === 'number' && n > 0) inserted++;
      }
      // Bump last_read_at when the actor is a participant — admin reads
      // of non-participant threads don't update participant state.
      await tx.$executeRawUnsafe(
        'UPDATE msg_thread_participants SET last_read_at = now(), updated_at = now() ' +
          'WHERE thread_id = $1::uuid AND platform_user_id = $2::uuid',
        threadId,
        actor.accountId,
      );
      return inserted;
    });

    await this.unread.clearThread(actor.accountId, threadId);
    return marked;
  }

  /**
   * Archive or unarchive a thread for the *thread* (not per-user). The
   * plan keeps archive on the thread row itself; per-user mute lives on
   * msg_thread_participants.is_muted (not exposed by Step 6 — Phase 2).
   *
   * Only the OWNER, a non-OBSERVER participant, or a school admin can
   * archive; OBSERVERs may not change archive state.
   */
  async setArchived(
    threadId: string,
    body: ArchiveThreadDto,
    actor: ResolvedActor,
  ): Promise<ThreadResponseDto> {
    await this.getById(threadId, actor);
    if (!actor.isSchoolAdmin) {
      var role = await this.activeParticipantRole(threadId, actor.accountId);
      if (role === null || role === 'OBSERVER') {
        throw new ForbiddenException('Only thread participants may archive threads');
      }
    }
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'UPDATE msg_threads SET is_archived = $1, updated_at = now() WHERE id = $2::uuid',
        body.isArchived,
        threadId,
      );
    });
    return this.getById(threadId, actor);
  }

  /**
   * Internal helper: load participants for a set of thread ids in one
   * round-trip. Joins through platform_users + iam_person to surface the
   * display name + email used by the inbox UI.
   */
  private async loadParticipants(threadIds: string[]): Promise<ParticipantRow[]> {
    if (threadIds.length === 0) return [];
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ParticipantRow[]>(
        'SELECT p.id, p.thread_id, p.platform_user_id, p.role, p.is_muted, ' +
          ' p.last_read_at, p.left_at, ' +
          ' u.display_name, u.email, ' +
          ' ip.first_name, ip.last_name ' +
          'FROM msg_thread_participants p ' +
          'LEFT JOIN platform.platform_users u ON u.id = p.platform_user_id ' +
          'LEFT JOIN platform.iam_person ip ON ip.id = u.person_id ' +
          'WHERE p.thread_id = ANY($1::uuid[]) ' +
          'ORDER BY p.role = \'OWNER\' DESC, ip.last_name, ip.first_name',
        threadIds,
      );
    });
  }

  /**
   * True if the account holds an active row in `msg_thread_participants`.
   * Used by every per-thread guard.
   */
  async isActiveParticipant(threadId: string, accountId: string): Promise<boolean> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM msg_thread_participants ' +
          'WHERE thread_id = $1::uuid AND platform_user_id = $2::uuid AND left_at IS NULL ' +
          'LIMIT 1',
        threadId,
        accountId,
      );
    });
    return rows.length > 0;
  }

  /**
   * Returns the active participant's role string ('OWNER' | 'PARTICIPANT' |
   * 'OBSERVER') or null when the actor is not an active participant.
   */
  async activeParticipantRole(threadId: string, accountId: string): Promise<string | null> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ role: string }>>(
        'SELECT role FROM msg_thread_participants ' +
          'WHERE thread_id = $1::uuid AND platform_user_id = $2::uuid AND left_at IS NULL ' +
          'LIMIT 1',
        threadId,
        accountId,
      );
    });
    if (rows.length === 0) return null;
    return rows[0]!.role;
  }

  /**
   * Ensure no msg_user_blocks row exists between the creator and any
   * recipient in either direction. Throws ForbiddenException with a
   * deliberately generic message — the API never reveals which side is
   * blocking who.
   */
  private async assertNoBlocks(creatorAccountId: string, recipientAccountIds: string[]): Promise<void> {
    if (recipientAccountIds.length === 0) return;
    var blocks = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ blocker_id: string; blocked_id: string }>>(
        'SELECT blocker_id::text AS blocker_id, blocked_id::text AS blocked_id ' +
          'FROM msg_user_blocks ' +
          'WHERE (blocker_id = $1::uuid AND blocked_id = ANY($2::uuid[])) ' +
          ' OR (blocked_id = $1::uuid AND blocker_id = ANY($2::uuid[]))',
        creatorAccountId,
        recipientAccountIds,
      );
    });
    if (blocks.length > 0) {
      throw new ForbiddenException(
        'One or more recipients cannot be added to this thread (blocked).',
      );
    }
  }

  /**
   * Resolve the IAM role tokens for a list of accounts in the tenant scope
   * chain (school + platform). Used to check thread-type allowed_roles.
   *
   * The query reads `iam_role_assignment` joined to `iam_role` and
   * `iam_scope`, filtered to ACTIVE assignments in the school's scope chain.
   * Role names are tokenised (UPPER, spaces → underscores) to match the
   * `allowed_participant_roles` shape from the Step 4 seed.
   */
  private async loadRoleTokens(
    accountIds: string[],
    schoolId: string,
  ): Promise<Record<string, string[]>> {
    if (accountIds.length === 0) return {};
    var pclient = this.tenantPrisma.getPlatformClient();
    var rows = await pclient.$queryRawUnsafe<Array<{ account_id: string; role_name: string }>>(
      'SELECT ra.account_id::text AS account_id, r.name AS role_name ' +
        'FROM platform.iam_role_assignment ra ' +
        'JOIN platform.iam_role r ON r.id = ra.role_id ' +
        'JOIN platform.iam_scope sc ON sc.id = ra.scope_id ' +
        'JOIN platform.iam_scope_type stp ON stp.id = sc.scope_type_id ' +
        "WHERE ra.status = 'ACTIVE' " +
        ' AND ra.account_id = ANY($1::uuid[]) ' +
        " AND ((stp.code = 'SCHOOL' AND sc.entity_id = $2::uuid) OR stp.code = 'PLATFORM')",
      accountIds,
      schoolId,
    );
    var out: Record<string, string[]> = {};
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i]!;
      var token = roleNameToToken(r.role_name);
      var lst = out[r.account_id] || [];
      if (lst.indexOf(token) === -1) lst.push(token);
      out[r.account_id] = lst;
    }
    return out;
  }

  /**
   * Append a row to `msg_admin_access_log` whenever a school admin reads a
   * thread they are not a participant in. FERPA audit requirement per
   * Step 3 design notes.
   */
  private async logAdminAccess(
    threadId: string,
    adminAccountId: string,
    reason: string,
  ): Promise<void> {
    var tenant = getCurrentTenant();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO msg_admin_access_log (id, school_id, admin_id, thread_id, reason) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5)',
          generateId(),
          tenant.schoolId,
          adminAccountId,
          threadId,
          reason,
        );
      });
    } catch (e: any) {
      this.logger.error(
        'Failed to write msg_admin_access_log: ' + (e?.stack || e?.message || e),
      );
    }
  }
}
