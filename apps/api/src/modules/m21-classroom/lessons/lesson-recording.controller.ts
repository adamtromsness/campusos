import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth';
import { ActorContextService } from '@modules/m00-platform';
import { LessonRecordingService } from './lesson-recording.service';
import {
  CreateLessonRecordingDto,
  LessonRecordingResponseDto,
} from '../ai-tutoring/dto/ai-tutoring.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Classroom Advanced — Lesson Recordings')
@ApiBearerAuth()
@Controller('classroom')
export class LessonRecordingController {
  constructor(
    private readonly recordings: LessonRecordingService,
    private readonly actors: ActorContextService,
  ) {}

  @Post('lessons/:lessonId/recordings')
  @RequirePermission('tch-001:write')
  @ApiOperation({
    summary:
      'Register a freshly-uploaded lesson recording. Caller must teach the class for the lesson (admin bypass). Emits video.uploaded for the Video Processing service to begin transcription.',
  })
  async create(
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
    @Body() body: CreateLessonRecordingDto,
    @Req() req: AuthedRequest,
  ): Promise<LessonRecordingResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    // Force the path lessonId into the body so the body and the route param cannot drift.
    return this.recordings.create({ ...body, lessonId }, actor);
  }

  @Get('recordings/:id')
  @RequirePermission('tch-001:read')
  @ApiOperation({
    summary:
      'Fetch a recording with transcript + summary inlined when available. Row-scoped to admin OR class teacher OR enrolled student.',
  })
  async getOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<LessonRecordingResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.recordings.getById(id, actor);
  }

  @Get('lessons/:lessonId/recordings')
  @RequirePermission('tch-001:read')
  @ApiOperation({ summary: 'List recordings for a lesson with row scope filtering.' })
  async listForLesson(
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
    @Req() req: AuthedRequest,
  ): Promise<LessonRecordingResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.recordings.listForLesson(lessonId, actor);
  }
}
