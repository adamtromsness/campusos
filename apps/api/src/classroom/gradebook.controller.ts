import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { GradebookService } from './gradebook.service';
import {
  GradebookClassResponseDto,
  GradebookQueryDto,
  GradebookStudentResponseDto,
} from './dto/gradebook.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Classroom — Gradebook')
@ApiBearerAuth()
@Controller()
export class GradebookController {
  constructor(
    private readonly gradebook: GradebookService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('classes/:classId/gradebook')
  @RequirePermission('tch-003:read')
  @ApiOperation({
    summary:
      'Class gradebook (teacher / admin view). One row per actively-enrolled student joined to ' +
      'the gradebook snapshot for the resolved term. Term defaults to the current term.',
  })
  async getClassGradebook(
    @Param('classId', ParseUUIDPipe) classId: string,
    @Query() query: GradebookQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<GradebookClassResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.gradebook.getClassGradebook(classId, query.termId, actor);
  }

  @Get('students/:studentId/gradebook')
  @RequirePermission('tch-003:read')
  @ApiOperation({
    summary:
      'Per-student gradebook (student / parent / teacher view). Row-scoped: students see ' +
      'themselves, parents see linked children, teachers see students they teach.',
  })
  async getStudentGradebook(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Query() query: GradebookQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<GradebookStudentResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.gradebook.getStudentGradebook(studentId, query.termId, actor);
  }
}
