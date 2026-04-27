import { Controller, Get, HttpCode, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { NotificationInboxService } from './notification-inbox.service';
import {
  MarkAllReadResponseDto,
  NotificationHistoryQueryDto,
  NotificationHistoryResponseDto,
  NotificationInboxResponseDto,
} from './dto/notification-inbox.dto';

interface AuthedRequest extends Request {
  user?: {
    sub: string;
    personId: string;
    email: string;
    displayName: string;
    sessionId: string;
  };
}

/**
 * `/notifications/inbox`, `/notifications/history`, `/notifications/mark-all-read`
 * — the read side of the notification pipeline that powers the Step 8
 * NotificationBell + dropdown + full /notifications page.
 *
 * Permission gate: the existing `GET /notifications/unread-count` (in
 * messaging) gates on `com-001:read` OR `com-002:read`. We use the same
 * pair here so any persona that can see communications also sees the
 * bell. Every seeded persona (Platform Admin, School Admin, Teacher,
 * Student, Parent) holds at least one of those tiers.
 *
 * The legacy `unread-count` endpoint stays put — it returns the
 * per-thread messaging unread map that the messaging UI uses for
 * inbox-row badges. The bell uses `/inbox` here for the unified count.
 */
@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationInboxController {
  constructor(private readonly inbox: NotificationInboxService) {}

  @Get('inbox')
  @RequirePermission('com-001:read', 'com-002:read')
  @ApiOperation({
    summary:
      'Recent in-app notifications + unread count for the bell dropdown. ' +
      'Reads from the Redis sorted set populated by NotificationDeliveryWorker; ' +
      'returns empty when Redis is unreachable.',
  })
  async getInbox(
    @Req() req: AuthedRequest,
    @Query('limit') limitRaw?: string,
  ): Promise<NotificationInboxResponseDto> {
    var accountId = req.user!.sub;
    var limit = parseLimit(limitRaw, 10, 50);
    return this.inbox.getInbox(accountId, limit);
  }

  @Get('history')
  @RequirePermission('com-001:read', 'com-002:read')
  @ApiOperation({
    summary:
      'Paginated notification history for the /notifications page. Reads from ' +
      'msg_notification_queue (long-term storage; the Redis sorted set caps at 100).',
  })
  async getHistory(
    @Req() req: AuthedRequest,
    @Query() query: NotificationHistoryQueryDto,
  ): Promise<NotificationHistoryResponseDto> {
    var accountId = req.user!.sub;
    return this.inbox.getHistory(accountId, {
      limit: query.limit,
      type: query.type,
      before: query.before,
    });
  }

  @Post('mark-all-read')
  @HttpCode(200)
  @RequirePermission('com-001:read', 'com-002:read')
  @ApiOperation({
    summary:
      'Bump the last-read timestamp to "now" so the bell badge clears on the next poll. ' +
      'Idempotent.',
  })
  async markAllRead(@Req() req: AuthedRequest): Promise<MarkAllReadResponseDto> {
    var accountId = req.user!.sub;
    var ts = await this.inbox.markAllRead(accountId);
    return { lastReadAt: ts };
  }
}

function parseLimit(raw: string | undefined, fallback: number, max: number): number {
  if (!raw) return fallback;
  var n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  if (n < 1) return 1;
  if (n > max) return max;
  return Math.floor(n);
}
