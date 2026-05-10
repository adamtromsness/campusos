import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { AITutoringService } from './ai-tutoring.service';
import {
  AIMessageDto,
  AILearningSignalResponseDto,
  AITutoringMessageResponseDto,
  AITutoringSessionResponseDto,
  AITutoringSessionWithMessagesDto,
  CompleteAISessionDto,
  StartAITutoringSessionDto,
} from './dto/ai-tutoring.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Classroom Advanced — AI Tutoring')
@ApiBearerAuth()
@Controller('classroom')
export class AITutoringController {
  constructor(
    private readonly tutoring: AITutoringService,
    private readonly actors: ActorContextService,
  ) {}

  @Post('ai-tutoring/sessions')
  @RequirePermission('tch-007:write')
  @ApiOperation({
    summary:
      'Start an AI tutoring session. Service checks the cls_ai_tutoring_opt_outs table BEFORE the AI Gateway is contacted — opted-out students receive 403 with the canonical message. STUDENT actors must omit studentId or pass own id.',
  })
  async start(
    @Body() body: StartAITutoringSessionDto,
    @Req() req: AuthedRequest,
  ): Promise<AITutoringSessionResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.tutoring.startSession(body, actor);
  }

  @Get('ai-tutoring/sessions')
  @RequirePermission('tch-007:read')
  @ApiOperation({
    summary:
      'List AI tutoring sessions visible to the calling actor. STUDENT sees own; STAFF sees students in their classes; admin sees all.',
  })
  async list(@Req() req: AuthedRequest): Promise<AITutoringSessionResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.tutoring.listSessions(actor);
  }

  @Get('ai-tutoring/sessions/:id')
  @RequirePermission('tch-007:read')
  @ApiOperation({
    summary:
      "Fetch a session with messages inlined. Row-scope at the service layer rejects cross-student reads with 404 don't-leak-existence.",
  })
  async getOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<AITutoringSessionWithMessagesDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.tutoring.getSessionWithMessages(id, actor);
  }

  @Post('ai-tutoring/sessions/:id/message')
  @RequirePermission('tch-007:write')
  @ApiOperation({
    summary:
      'Send a message to the AI tutor. SAFETY KEYSTONE — service checks opt-out + quota BEFORE the AI Gateway call, hashes student_id into an opaque token, sends transcript + new message to the Gateway, persists the assistant reply, bumps total_messages, logs tokens to cls_ai_usage_log. AI never receives PII per ADR-004.',
  })
  async postMessage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AIMessageDto,
    @Req() req: AuthedRequest,
  ): Promise<{ student: AITutoringMessageResponseDto; assistant: AITutoringMessageResponseDto }> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.tutoring.postMessage(id, body, actor);
  }

  @Patch('ai-tutoring/sessions/:id/complete')
  @RequirePermission('tch-007:write')
  @ApiOperation({ summary: 'Mark an active session COMPLETED. Schema lockstep stamps ended_at.' })
  async complete(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CompleteAISessionDto,
    @Req() req: AuthedRequest,
  ): Promise<AITutoringSessionResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.tutoring.completeSession(id, body, actor);
  }

  @Post('ai-tutoring/sessions/:id/extract-signals')
  @RequirePermission('tch-007:write')
  @ApiOperation({
    summary:
      'Extract learning signals from a completed session. Teacher / admin only — students cannot view their own signals to avoid labelling. Quota gate fires BEFORE the AI Gateway call.',
  })
  async extractSignals(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<AILearningSignalResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.tutoring.extractSignals(id, actor);
  }

  @Get('ai-tutoring/sessions/:id/signals')
  @RequirePermission('tch-007:read')
  @ApiOperation({
    summary:
      'List extracted learning signals for a session. Teacher + counsellor + admin only — students cannot view their own signals.',
  })
  async listSessionSignals(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<AILearningSignalResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.tutoring.listSignals(id, actor);
  }

  @Get('students/:studentId/learning-signals')
  @RequirePermission('tch-007:read')
  @ApiOperation({
    summary:
      'List learning signals across all sessions for a student — teacher + counsellor + admin only. Visible per ADR-004 to caseload-linked counsellors.',
  })
  async listStudentSignals(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Req() req: AuthedRequest,
  ): Promise<AILearningSignalResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.tutoring.listSignalsForStudent(studentId, actor);
  }
}
