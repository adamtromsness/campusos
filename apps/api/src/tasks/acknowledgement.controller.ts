import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { AcknowledgementService } from './acknowledgement.service';
import {
  AcknowledgementResponseDto,
  DisputeAcknowledgementDto,
} from './dto/task.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

class ListAcksQueryDto {
  @IsOptional()
  @Transform(function (params: { value: unknown }) {
    if (typeof params.value === 'boolean') return params.value;
    if (typeof params.value === 'string') return params.value === 'true';
    return false;
  })
  @IsBoolean()
  all?: boolean;
}

@ApiTags('Acknowledgements')
@ApiBearerAuth()
@Controller('acknowledgements')
export class AcknowledgementController {
  constructor(
    private readonly acks: AcknowledgementService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('ops-001:read')
  @ApiOperation({
    summary:
      'List acknowledgements. Default: own pending. Admins can pass ?all=true to see every row.',
  })
  async list(
    @Query() q: ListAcksQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<AcknowledgementResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    if (q.all && actor.isSchoolAdmin) {
      return this.acks.listAll(actor);
    }
    return this.acks.listOwnPending(actor);
  }

  @Get(':id')
  @RequirePermission('ops-001:read')
  @ApiOperation({ summary: 'Fetch a single acknowledgement.' })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<AcknowledgementResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.acks.getById(id, actor);
  }

  @Post(':id/acknowledge')
  @RequirePermission('ops-001:write')
  @ApiOperation({
    summary:
      'Mark this acknowledgement as ACKNOWLEDGED. Cascades the linked task(s) to DONE in one tx and emits student.acknowledgement.completed.',
  })
  async acknowledge(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<AcknowledgementResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.acks.acknowledge(id, actor);
  }

  @Post(':id/dispute')
  @RequirePermission('ops-001:write')
  @ApiOperation({
    summary:
      'Mark this acknowledgement as ACKNOWLEDGED_WITH_DISPUTE with a required reason. Linked tasks still flip to DONE.',
  })
  async dispute(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DisputeAcknowledgementDto,
    @Req() req: AuthedRequest,
  ): Promise<AcknowledgementResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.acks.dispute(id, body.reason, actor);
  }
}
