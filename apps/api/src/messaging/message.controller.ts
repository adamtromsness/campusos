import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { MessageService } from './message.service';
import {
  EditMessageDto,
  ListMessagesQueryDto,
  MessageResponseDto,
  PostMessageDto,
} from './dto/message.dto';

interface AuthedRequest extends Request {
  user?: {
    sub: string;
    personId: string;
    email: string;
    displayName: string;
    sessionId: string;
  };
}

@ApiTags('Messages')
@ApiBearerAuth()
@Controller()
export class MessageController {
  constructor(
    private readonly messages: MessageService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('threads/:threadId/messages')
  @RequirePermission('com-001:read')
  @ApiOperation({ summary: 'List messages in a thread (newest first, paginated)' })
  async list(
    @Param('threadId', ParseUUIDPipe) threadId: string,
    @Query() q: ListMessagesQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<MessageResponseDto[]> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.messages.list(threadId, q, actor);
  }

  @Post('threads/:threadId/messages')
  @RequirePermission('com-001:write')
  @ApiOperation({
    summary:
      'Post a new message. Runs through content moderation. BLOCKED returns 422 ' +
      'with a generic policy message; FLAGGED / ESCALATED messages persist with ' +
      'the corresponding moderation_status and a row in msg_moderation_log.',
  })
  async post(
    @Param('threadId', ParseUUIDPipe) threadId: string,
    @Body() body: PostMessageDto,
    @Req() req: AuthedRequest,
  ): Promise<MessageResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.messages.post(threadId, body, actor);
  }

  @Patch('messages/:id')
  @RequirePermission('com-001:write')
  @ApiOperation({ summary: 'Edit a message (author only, within 15 minutes of posting)' })
  async edit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: EditMessageDto,
    @Req() req: AuthedRequest,
  ): Promise<MessageResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.messages.edit(id, body, actor);
  }

  @Delete('messages/:id')
  @RequirePermission('com-001:write')
  @ApiOperation({
    summary: 'Soft-delete a message (sender or school admin). Idempotent.',
  })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<MessageResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.messages.softDelete(id, actor);
  }
}
