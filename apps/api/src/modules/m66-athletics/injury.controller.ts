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
import { RequirePermission } from '@shared/auth/require-permission.decorator';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { InjuryService } from './injury.service';
import {
  CreateInjuryDto,
  InjuryResponseDto,
  ReturnToPlayStatus,
  UpdateInjuryDto,
} from './dto/athletics.dto';
import { ConcussionProtocolService } from './concussion-protocol.service';
import { MedicalClearanceService } from './medical-clearance.service';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string };
}

@ApiTags('Athletics — Injuries')
@ApiBearerAuth()
@Controller('athletics')
export class InjuryController {
  constructor(
    private readonly injuries: InjuryService,
    private readonly protocol: ConcussionProtocolService,
    private readonly clearances: MedicalClearanceService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('injuries')
  @RequirePermission('ath-004:read')
  async list(
    @Req() req: AuthedRequest,
    @Query('rosterId') rosterId?: string,
    @Query('status') status?: string,
    @Query('studentId') studentId?: string,
  ): Promise<InjuryResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.injuries.list(
      { rosterId, status: status as ReturnToPlayStatus | undefined, studentId },
      actor,
    );
  }

  @Get('injuries/:id')
  @RequirePermission('ath-004:read')
  async getById(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<InjuryResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    // Row scope is enforced inside the service — non-authorized
    // callers receive a 404 rather than leaking the row.
    const dto = await this.injuries.getById(id, actor);
    dto.protocolSteps = await this.protocol.listForInjury(id);
    dto.clearances = await this.clearances.listForInjury(id);
    return dto;
  }

  @Post('injuries')
  @RequirePermission('ath-004:write')
  @ApiOperation({
    summary:
      'Log an injury. When return_to_play_status is CONCUSSION_PROTOCOL the matching active roster_member is auto-flipped to INJURED_NOT_CLEARED.',
  })
  async create(
    @Req() req: AuthedRequest,
    @Body() body: CreateInjuryDto,
  ): Promise<InjuryResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.injuries.create(body, actor);
  }

  @Patch('injuries/:id')
  @RequirePermission('ath-004:write')
  async patch(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateInjuryDto,
  ): Promise<InjuryResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.injuries.patch(id, body, actor);
  }
}
