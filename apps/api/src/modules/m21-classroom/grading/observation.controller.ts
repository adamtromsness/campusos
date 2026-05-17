import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth/require-permission.decorator';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { ObservationService } from './observation.service';
import {
  CreateObservationDto,
  ObservationResponseDto,
  UpdateObservationDto,
} from './dto/observation.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Classroom Advanced — Student Observations')
@ApiBearerAuth()
@Controller('classroom')
export class ObservationController {
  constructor(
    private readonly observations: ObservationService,
    private readonly actors: ActorContextService,
  ) {}

  @Post('observations')
  @RequirePermission('tch-003:write')
  @ApiOperation({
    summary:
      'Author a student observation. note_type 3-value CHECK PROGRESS / CONCERN / COMMENDATION. is_shared_with_parent defaults to false (staff-internal).',
  })
  async create(
    @Body() body: CreateObservationDto,
    @Req() req: AuthedRequest,
  ): Promise<ObservationResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.observations.create(body, actor);
  }

  @Get('students/:studentId/observations')
  @RequirePermission('tch-003:read')
  @ApiOperation({
    summary:
      'List observations for a student. Visibility — admin / staff sees all. Linked guardian via sis_student_guardians sees is_shared_with_parent=true rows only. Students do not see observations about themselves.',
  })
  async listForStudent(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Req() req: AuthedRequest,
  ): Promise<ObservationResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.observations.listForStudent(studentId, actor);
  }

  @Get('observations/:id')
  @RequirePermission('tch-003:read')
  @ApiOperation({
    summary:
      'Fetch a single observation. Row-scoped — guardians need is_shared_with_parent=true and a sis_student_guardians link.',
  })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<ObservationResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.observations.getById(id, actor);
  }

  @Patch('observations/:id')
  @RequirePermission('tch-003:write')
  @ApiOperation({
    summary: 'Update an observation. Author or admin only — locked-row PATCH inside one tenant tx.',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateObservationDto,
    @Req() req: AuthedRequest,
  ): Promise<ObservationResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.observations.update(id, body, actor);
  }

  @Delete('observations/:id')
  @HttpCode(204)
  @RequirePermission('tch-003:write')
  @ApiOperation({ summary: 'Delete an observation. Author or admin only.' })
  async delete(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest): Promise<void> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.observations.delete(id, actor);
  }
}
