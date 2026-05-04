import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { CommentService } from './comment.service';
import { CreateCommentDto, TicketCommentResponseDto } from './dto/ticket.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Ticket Comments')
@ApiBearerAuth()
@Controller('tickets/:id/comments')
export class CommentController {
  constructor(
    private readonly comments: CommentService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('it-001:read')
  @ApiOperation({
    summary:
      'Comment thread on a ticket. Internal-only rows are filtered out for the requester; staff and admins see everything.',
  })
  async list(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<TicketCommentResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.comments.list(id, actor);
  }

  @Post()
  @RequirePermission('it-001:write')
  @ApiOperation({
    summary:
      'Post a comment. Staff posts honour isInternal; requester posts are always public. The first staff comment bumps first_response_at and stops the SLA response clock. Emits tkt.ticket.commented.',
  })
  async post(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateCommentDto,
    @Req() req: AuthedRequest,
  ): Promise<TicketCommentResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.comments.post(id, body, actor);
  }
}
