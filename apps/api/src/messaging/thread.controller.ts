import {
  Body,
  Controller,
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
import { ThreadService } from './thread.service';
import { MessageService } from './message.service';
import {
  ArchiveThreadDto,
  CreateThreadDto,
  ListThreadsQueryDto,
  MessagingRecipientDto,
  ThreadResponseDto,
  ThreadTypeDto,
} from './dto/thread.dto';
import { MarkThreadReadResponseDto } from './dto/message.dto';

interface AuthedRequest extends Request {
  user?: {
    sub: string;
    personId: string;
    email: string;
    displayName: string;
    sessionId: string;
  };
}

@ApiTags('Threads')
@ApiBearerAuth()
@Controller('threads')
export class ThreadController {
  constructor(
    private readonly threads: ThreadService,
    private readonly messages: MessageService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('com-001:read')
  @ApiOperation({ summary: 'Inbox — threads visible to the calling user' })
  async list(
    @Query() q: ListThreadsQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<ThreadResponseDto[]> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.threads.list(q, actor);
  }

  @Get('types')
  @RequirePermission('com-001:read')
  @ApiOperation({
    summary:
      'Active thread types for this tenant. Used by the compose UI to drive the thread-type ' +
      'selector and the recipient-picker role filter.',
  })
  async listTypes(@Req() req: AuthedRequest): Promise<ThreadTypeDto[]> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.threads.listThreadTypes(actor);
  }

  @Get('recipients')
  @RequirePermission('com-001:write')
  @ApiOperation({
    summary:
      "Platform users in this school whose IAM role token matches the thread type's " +
      'allowed_participant_roles. Excludes self and users with a msg_user_blocks row in ' +
      'either direction. Used by the compose UI to populate the recipient picker.',
  })
  async listRecipients(
    @Query('threadTypeId', new ParseUUIDPipe()) threadTypeId: string,
    @Req() req: AuthedRequest,
  ): Promise<MessagingRecipientDto[]> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.threads.listRecipients(threadTypeId, actor);
  }

  @Get(':id')
  @RequirePermission('com-001:read')
  @ApiOperation({ summary: 'Get a single thread (row-scoped — participants + admins)' })
  async getOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<ThreadResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.threads.getById(id, actor);
  }

  @Post()
  @RequirePermission('com-001:write')
  @ApiOperation({
    summary:
      'Create a new thread. Validates participant roles against the thread type, ' +
      'block-list entries, and (if `initialMessage` is set) routes the first message ' +
      'through content moderation.',
  })
  async create(
    @Body() body: CreateThreadDto,
    @Req() req: AuthedRequest,
  ): Promise<ThreadResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    var thread = await this.threads.create(body, actor);
    if (body.initialMessage && body.initialMessage.trim().length > 0) {
      await this.messages.post(thread.id, { body: body.initialMessage }, actor);
      // Re-fetch so lastMessageAt reflects the post.
      return this.threads.getById(thread.id, actor);
    }
    return thread;
  }

  @Post(':id/read')
  @RequirePermission('com-001:read')
  @ApiOperation({
    summary:
      'Mark every unread message in this thread as read. Idempotent. Clears ' +
      'the per-thread Redis unread counter on success.',
  })
  async markRead(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<MarkThreadReadResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    var marked = await this.threads.markRead(id, actor);
    var thread = await this.threads.getById(id, actor);
    return { threadId: id, marked: marked, unreadCount: thread.unreadCount };
  }

  @Patch(':id/archive')
  @RequirePermission('com-001:write')
  @ApiOperation({ summary: 'Archive or unarchive a thread (participant or admin only)' })
  async archive(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ArchiveThreadDto,
    @Req() req: AuthedRequest,
  ): Promise<ThreadResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.threads.setArchived(id, body, actor);
  }
}
