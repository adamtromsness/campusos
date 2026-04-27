import { Controller, Get, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { UnreadCountService } from './unread-count.service';
import { UnreadCountResponseDto } from './dto/message.dto';

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
 * `GET /notifications/unread-count` — the read endpoint that powers the
 * Step 8 NotificationBell. Lives in the messaging module today because the
 * bell aggregates messaging unread counts; when announcements + other
 * notification types ship a unified counter, this endpoint will move into
 * a dedicated NotificationsController.
 */
@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationBadgeController {
  constructor(private readonly unread: UnreadCountService) {}

  @Get('unread-count')
  @RequirePermission('com-001:read', 'com-002:read')
  @ApiOperation({
    summary:
      'Total unread message count + per-thread breakdown for the calling user. ' +
      'Backed by the `inbox:{accountId}` Redis HASH; returns zero when Redis is unavailable.',
  })
  async getCount(@Req() req: AuthedRequest): Promise<UnreadCountResponseDto> {
    var accountId = req.user!.sub;
    var byThread = await this.unread.getByThread(accountId);
    var total = 0;
    var keys = Object.keys(byThread);
    for (var i = 0; i < keys.length; i++) total += byThread[keys[i]!]!;
    return { total: total, byThread: byThread };
  }
}
