import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { ConcussionProtocolService } from './concussion-protocol.service';
import {
  CompleteProtocolStepDto,
  ConcussionProtocolStepDto,
  StartProtocolStepDto,
} from './dto/athletics.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string };
}

@ApiTags('Athletics — Concussion Protocol (SAFETY KEYSTONE)')
@ApiBearerAuth()
@Controller('athletics')
export class ConcussionProtocolController {
  constructor(
    private readonly protocol: ConcussionProtocolService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('injuries/:id/protocol')
  @RequirePermission('ath-004:read')
  async list(@Param('id', ParseUUIDPipe) id: string): Promise<ConcussionProtocolStepDto[]> {
    return this.protocol.listForInjury(id);
  }

  @Post('injuries/:id/protocol/steps')
  @RequirePermission('ath-004:write')
  @ApiOperation({
    summary:
      'Start the next concussion protocol step. Refuses if the previous step is not completed, the minimum_duration_hours has not elapsed, or the athlete is not symptom_free.',
  })
  async start(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: StartProtocolStepDto,
  ): Promise<ConcussionProtocolStepDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.protocol.startStep(id, body, actor);
  }

  @Patch('concussion-steps/:stepId')
  @RequirePermission('ath-004:write')
  async complete(
    @Req() req: AuthedRequest,
    @Param('stepId', ParseUUIDPipe) stepId: string,
    @Body() body: CompleteProtocolStepDto,
  ): Promise<ConcussionProtocolStepDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.protocol.completeStep(stepId, body, actor);
  }
}
