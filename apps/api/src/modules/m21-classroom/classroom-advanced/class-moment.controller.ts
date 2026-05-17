import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth/require-permission.decorator';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { ClassMomentService } from './class-moment.service';
import {
  ClassMomentResponseDto,
  CreateClassMomentDto,
  CreateMomentReactionDto,
} from './dto/class-moment.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Classroom Advanced — Class Moments')
@ApiBearerAuth()
@Controller('classroom')
export class ClassMomentController {
  constructor(
    private readonly moments: ClassMomentService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('classes/:classId/moments')
  @RequirePermission('tch-009:read')
  @ApiOperation({
    summary:
      'List class moments (newest-first). Row-scoped: admins / staff see all; parents see classes their children are enrolled in; students see classes they are enrolled in.',
  })
  async listForClass(
    @Param('classId', ParseUUIDPipe) classId: string,
    @Req() req: AuthedRequest,
  ): Promise<ClassMomentResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.moments.listForClass(classId, actor);
  }

  @Get('moments/:id')
  @RequirePermission('tch-009:read')
  @ApiOperation({ summary: 'Fetch a single class moment with photos + reactions inlined.' })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<ClassMomentResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.moments.getById(id, actor);
  }

  @Post('classes/:classId/moments')
  @RequirePermission('tch-009:write')
  @ApiOperation({
    summary:
      'Post a new class moment with one or more photos. Caller must be admin or a teacher of the class. is_approved defaults to true for teacher-posted moments.',
  })
  async create(
    @Param('classId', ParseUUIDPipe) classId: string,
    @Body() body: CreateClassMomentDto,
    @Req() req: AuthedRequest,
  ): Promise<ClassMomentResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.moments.create(classId, body, actor);
  }

  @Delete('moments/:id')
  @HttpCode(204)
  @RequirePermission('tch-009:write')
  @ApiOperation({
    summary:
      'Delete a class moment. CASCADE drops attached photos + reactions. Caller must be admin or the posting teacher.',
  })
  async delete(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest): Promise<void> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.moments.delete(id, actor);
  }

  @Post('moments/:id/react')
  @RequirePermission('tch-009:read')
  @ApiOperation({
    summary:
      'React to a moment. UPSERT keyed on (moment, reacting user) so re-reacting flips the type. Reaction types: LIKE / LOVE / CELEBRATE.',
  })
  async react(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateMomentReactionDto,
    @Req() req: AuthedRequest,
  ): Promise<ClassMomentResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.moments.react(id, body, actor);
  }

  @Delete('moments/:id/react')
  @RequirePermission('tch-009:read')
  @ApiOperation({ summary: 'Remove your reaction from a moment.' })
  async unreact(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<ClassMomentResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.moments.unreact(id, actor);
  }
}
