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
import { ScreeningService } from './screening.service';
import {
  CreateScreeningDto,
  ListScreeningsQueryDto,
  ScreeningResponseDto,
  UpdateScreeningDto,
} from './dto/health.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Health Screenings')
@ApiBearerAuth()
@Controller()
export class ScreeningController {
  constructor(
    private readonly screenings: ScreeningService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('health/screenings/follow-up')
  @RequirePermission('hlt-004:admin')
  @ApiOperation({
    summary:
      'Admin follow-up queue — every screening with follow_up_required=true AND follow_up_completed=false. Hits the partial INDEX from Step 3. Admin-only at the gate; the service additionally checks isSchoolAdmin.',
  })
  async followUp(@Req() req: AuthedRequest): Promise<ScreeningResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.screenings.listFollowUp(actor);
  }

  @Get('health/screenings')
  @RequirePermission('hlt-004:read')
  @ApiOperation({
    summary:
      'List screenings with optional studentId / screeningType / result / from / to filters. Newest first, capped at 500. Writes one VIEW_SCREENING audit row per distinct student in the response.',
  })
  async list(
    @Query() query: ListScreeningsQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<ScreeningResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.screenings.list(query, actor);
  }

  @Post('health/screenings')
  @RequirePermission('hlt-004:write')
  @ApiOperation({
    summary:
      'Record a screening result. Nurse / counsellor / admin only. Stamps screened_by from actor.employeeId; the schema CHECK refuses BOGUS result values (PASS / REFER / RESCREEN / ABSENT or NULL while pending).',
  })
  async create(
    @Body() body: CreateScreeningDto,
    @Req() req: AuthedRequest,
  ): Promise<ScreeningResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.screenings.create(body, actor);
  }

  @Patch('health/screenings/:id')
  @RequirePermission('hlt-004:write')
  @ApiOperation({
    summary:
      'Update a screening — flip result, mark follow-up complete, append referral notes. Nurse / counsellor / admin only.',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateScreeningDto,
    @Req() req: AuthedRequest,
  ): Promise<ScreeningResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.screenings.update(id, body, actor);
  }
}
