import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { RefundService } from './refund.service';
import { IssueRefundDto, ListRefundsQueryDto, RefundResponseDto } from './dto/refund.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Payments: Refunds')
@ApiBearerAuth()
@Controller()
export class RefundController {
  constructor(
    private readonly refunds: RefundService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('refunds')
  @RequirePermission('fin-001:read')
  @ApiOperation({ summary: 'List refunds (admin-only at the service layer)' })
  async list(
    @Query() query: ListRefundsQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<RefundResponseDto[]> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.refunds.list(query, actor);
  }

  @Post('payments/:id/refund')
  @RequirePermission('fin-001:admin')
  @ApiOperation({
    summary:
      'Issue a refund against a completed payment (admin only). Locks payment FOR UPDATE, writes pay_refunds row + REFUND ledger entry, emits pay.refund.issued.',
  })
  async issue(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: IssueRefundDto,
    @Req() req: AuthedRequest,
  ): Promise<RefundResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.refunds.issue(id, body, actor);
  }
}
