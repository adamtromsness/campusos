import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth';
import { ActorContextService } from '@modules/m00-platform';
import { CoachingService } from './coaching.service';
import {
  CoachingAssignmentResponseDto,
  CreateCoachingAssignmentDto,
  UpdateCoachingAssignmentDto,
} from './dto/athletics.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string };
}

@ApiTags('Athletics — Coaching')
@ApiBearerAuth()
@Controller('athletics')
export class CoachingController {
  constructor(
    private readonly coaching: CoachingService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('rosters/:id/coaches')
  @RequirePermission('ath-003:read')
  async list(@Param('id', ParseUUIDPipe) id: string): Promise<CoachingAssignmentResponseDto[]> {
    return this.coaching.listForRoster(id);
  }

  @Post('rosters/:id/coaches')
  @RequirePermission('ath-003:write')
  async create(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateCoachingAssignmentDto,
  ): Promise<CoachingAssignmentResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.coaching.create(id, body, actor);
  }

  @Patch('coaching-assignments/:id')
  @RequirePermission('ath-003:write')
  async patch(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateCoachingAssignmentDto,
  ): Promise<CoachingAssignmentResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.coaching.patch(id, body, actor);
  }
}
