import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { ModerationService, isUniqueViolation } from './moderation.service';
import {
  AppealDto,
  AppealStatus,
  CreateAppealDto,
  PatchAppealDto,
} from './dto/communications-advanced.dto';

interface AppealRow {
  id: string;
  action_id: string;
  action_created_at: string;
  appealed_by: string;
  appeal_reason: string;
  status: AppealStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  reviewer_notes: string | null;
  created_at: string;
}

function rowToDto(row: AppealRow): AppealDto {
  return {
    id: row.id,
    actionId: row.action_id,
    actionCreatedAt: row.action_created_at,
    appealedBy: row.appealed_by,
    appealReason: row.appeal_reason,
    status: row.status,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    reviewerNotes: row.reviewer_notes,
    createdAt: row.created_at,
  };
}

/**
 * AppealService — user appeal workflow on top of moderation actions.
 *
 * Workflow:
 *   1. User whose message landed BLOCKED / FLAGGED / ESCALATED hits
 *      POST /communications/moderation-actions/:id/appeal with a
 *      reason. The schema's UNIQUE(action_id, action_created_at)
 *      means each action accepts at most one appeal — a duplicate
 *      attempt returns 409.
 *   2. Admin reviews the queue at GET /communications/moderation/appeals
 *      (default status=SUBMITTED).
 *   3. Admin PATCHes the appeal with status=UPHELD or
 *      status=OVERTURNED. The keystone:
 *        - UPHELD: appeal flips to UPHELD, parent action stays as-is.
 *        - OVERTURNED: appeal flips to OVERTURNED AND the parent action
 *          flips to review_status=RELEASED inside the same tenant tx.
 *      Both flips happen atomically so the schema-side reviewed_chk
 *      lockstep on msg_moderation_actions is always satisfied.
 *
 * Phase 2 punch list: emit msg.message.released so the recipient is
 * notified when an OVERTURNED appeal releases their message. Today
 * the service returns the refreshed action row in the response but
 * does not fan out a notification.
 */
@Injectable()
export class AppealService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly moderation: ModerationService,
  ) {}

  /**
   * REVIEW-P2C19 BLOCKING 2: list/get/patch each apply the same EXISTS
   * scope filter through msg_moderation_actions → msg_moderation_rules
   * so an admin sees only appeals whose parent action's rule is
   * PLATFORM-tier OR belongs to the calling tenant school.
   */
  async list(args: { status?: AppealStatus; limit?: number }): Promise<AppealDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client: PrismaClient) => {
      const status = args.status ?? 'SUBMITTED';
      const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
      const rows = await client.$queryRawUnsafe<AppealRow[]>(
        this.selectBase() +
          'WHERE status = $1 ' +
          this.actionScopeExistsClause('$2') +
          ' ORDER BY created_at DESC LIMIT $3',
        status,
        tenant.schoolId,
        limit,
      );
      return rows.map(rowToDto);
    });
  }

  async getById(id: string): Promise<AppealDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client: PrismaClient) => {
      const rows = await client.$queryRawUnsafe<AppealRow[]>(
        this.selectBase() +
          'WHERE id = $1::uuid ' +
          this.actionScopeExistsClause('$2') +
          ' LIMIT 1',
        id,
        tenant.schoolId,
      );
      if (rows.length === 0) throw new NotFoundException('Appeal not found');
      return rowToDto(rows[0]!);
    });
  }

  async create(actionId: string, input: CreateAppealDto, actor: ResolvedActor): Promise<AppealDto> {
    return this.tenantPrisma.executeInTenantTransaction(async (tx: PrismaClient) => {
      const action = await this.moderation.loadActionInTx(tx, actionId);
      if (action === null) throw new NotFoundException('Moderation action not found');
      // Cannot appeal an AUTO_APPROVED action — there's nothing to release.
      if (action.action_taken === 'AUTO_APPROVED') {
        throw new BadRequestException(
          'AUTO_APPROVED actions do not need an appeal — the message was already released',
        );
      }
      // Appeal authority: only the action's owner (the message sender) or
      // an admin can submit an appeal. The seed makes admins the catch-
      // all submitter — real schools narrow this with a delegated reviewer
      // role.
      if (!actor.isSchoolAdmin) {
        // Non-admin must own the message — the soft FK chain runs:
        // moderation_action.message_id → msg_messages.sender_id == actor.accountId.
        const senderRows = await tx.$queryRawUnsafe<Array<{ sender_id: string }>>(
          'SELECT sender_id::text AS sender_id FROM msg_messages WHERE id = $1::uuid LIMIT 1',
          action.message_id,
        );
        if (senderRows.length === 0) {
          throw new NotFoundException('Source message not found');
        }
        if (senderRows[0]!.sender_id !== actor.accountId) {
          throw new ForbiddenException(
            'Only the message sender or a school admin can submit an appeal for this action',
          );
        }
      }
      const id = generateId();
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO msg_moderation_appeals ' +
            '(id, action_id, action_created_at, appealed_by, appeal_reason) ' +
            'VALUES ($1::uuid, $2::uuid, $3::timestamptz, $4::uuid, $5)',
          id,
          actionId,
          action.created_at,
          actor.accountId,
          input.appealReason,
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException(
            'An appeal already exists for this moderation action — only one appeal per action is allowed',
          );
        }
        throw err;
      }
      const rows = await tx.$queryRawUnsafe<AppealRow[]>(
        this.selectBase() + 'WHERE id = $1::uuid LIMIT 1',
        id,
      );
      return rowToDto(rows[0]!);
    });
  }

  async patch(id: string, input: PatchAppealDto, actor: ResolvedActor): Promise<AppealDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can review appeals');
    }
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (tx: PrismaClient) => {
      const existing = await tx.$queryRawUnsafe<AppealRow[]>(
        this.selectBase() +
          'WHERE id = $1::uuid ' +
          this.actionScopeExistsClause('$2') +
          ' FOR UPDATE',
        id,
        tenant.schoolId,
      );
      if (existing.length === 0) throw new NotFoundException('Appeal not found');
      const row = existing[0]!;
      if (row.status !== 'SUBMITTED') {
        throw new BadRequestException(
          'Appeal is already ' + row.status + ' — review_status is terminal',
        );
      }
      // Step 1: flip the appeal row to the terminal status.
      await tx.$executeRawUnsafe(
        'UPDATE msg_moderation_appeals SET ' +
          'status = $2, reviewed_by = $3::uuid, reviewed_at = now(), ' +
          'reviewer_notes = $4, updated_at = now() WHERE id = $1::uuid',
        id,
        input.status,
        actor.accountId,
        input.reviewerNotes ?? null,
      );
      // Step 2 (OVERTURNED keystone): release the parent action.
      // The msg_moderation_actions.reviewed_chk lockstep on (review_status,
      // reviewed_by, reviewed_at) is satisfied atomically inside this tx
      // because the parent action might be PENDING (lockstep requires all
      // three NULL) and we are transitioning it to RELEASED with both
      // reviewer columns populated together.
      if (input.status === 'OVERTURNED') {
        const action = await this.moderation.loadActionInTx(tx, row.action_id);
        if (action !== null && action.review_status === 'PENDING') {
          await this.moderation.releaseActionInTx(
            tx,
            row.action_id,
            row.action_created_at,
            actor.accountId,
            'Released via appeal ' + id,
          );
        }
      }
      const refreshed = await tx.$queryRawUnsafe<AppealRow[]>(
        this.selectBase() + 'WHERE id = $1::uuid LIMIT 1',
        id,
      );
      return rowToDto(refreshed[0]!);
    });
  }

  private selectBase(): string {
    return (
      'SELECT id::text AS id, action_id::text AS action_id, ' +
      'action_created_at::text AS action_created_at, ' +
      'appealed_by::text AS appealed_by, appeal_reason, status, ' +
      'reviewed_by::text AS reviewed_by, reviewed_at::text AS reviewed_at, ' +
      'reviewer_notes, created_at::text AS created_at ' +
      'FROM msg_moderation_appeals '
    );
  }

  /**
   * REVIEW-P2C19 BLOCKING 2 — EXISTS clause through msg_moderation_actions
   * → msg_moderation_rules that scopes appeals to PLATFORM-tier rules
   * OR rules owned by the calling tenant school.
   */
  private actionScopeExistsClause(schoolArgPlaceholder: string): string {
    return (
      'AND EXISTS (' +
      ' SELECT 1 FROM msg_moderation_actions a' +
      ' JOIN msg_moderation_rules r ON r.id = a.rule_id' +
      ' WHERE a.id = msg_moderation_appeals.action_id' +
      "  AND (r.scope = 'PLATFORM' OR r.school_id = " +
      schoolArgPlaceholder +
      '::uuid)' +
      ') '
    );
  }
}
