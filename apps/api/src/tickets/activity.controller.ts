import { Controller, Get, Param, ParseUUIDPipe, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { ActivityService } from './activity.service';
import { TicketActivityResponseDto } from './dto/ticket.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Ticket Activity')
@ApiBearerAuth()
@Controller('tickets/:id/activity')
export class ActivityController {
  constructor(
    private readonly activity: ActivityService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('it-001:read')
  @ApiOperation({
    summary: 'Read-only audit timeline for a ticket. Row-scoped (admin or requester or assignee).',
  })
  async list(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<TicketActivityResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.activity.list(id, actor);
  }
}
