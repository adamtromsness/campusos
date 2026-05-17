import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth';
import { ActorContextService } from '@modules/m00-platform';
import {
  CreateReenrolDto,
  ReenrolResponseDto,
  ReenrolSummaryDto,
} from '../withdrawals/dto/withdrawal.dto';
import { ReenrolmentService } from './reenrolment.service';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Enrolment Re-enrolment')
@ApiBearerAuth()
@Controller('enrolment')
export class ReenrolmentController {
  constructor(
    private readonly reenrolment: ReenrolmentService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('reenrolment')
  @RequirePermission('stu-004:read')
  @ApiOperation({
    summary:
      'List re-enrolment confirmations (admin: all; parent: own only). Optional academicYearId filter.',
  })
  async list(
    @Req() req: AuthedRequest,
    @Query('academicYearId') academicYearId?: string,
    @Query('mine') mine?: string,
  ): Promise<ReenrolResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.reenrolment.list(actor, {
      academicYearId,
      mine: mine === 'true',
    });
  }

  @Get('reenrolment/summary')
  @RequirePermission('stu-004:admin')
  @ApiOperation({
    summary:
      'Admin — per-grade continuing vs departing vs outstanding counts for an academic year.',
  })
  async summary(
    @Query('academicYearId', ParseUUIDPipe) academicYearId: string,
    @Req() req: AuthedRequest,
  ): Promise<ReenrolSummaryDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.reenrolment.summary(actor, academicYearId);
  }

  @Get('reenrolment/:id')
  @RequirePermission('stu-004:read')
  @ApiOperation({ summary: 'Get a single re-enrolment confirmation (row-scoped to admin or own).' })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<ReenrolResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.reenrolment.getById(id, actor);
  }

  @Post('reenrolment')
  @RequirePermission('stu-004:write')
  @ApiOperation({
    summary:
      'Submit re-enrolment confirmation for next academic year. confirmed_continuing=false auto-initiates an enr_withdrawal_request inside the same tx and stamps linked_withdrawal_id.',
  })
  async submit(
    @Body() body: CreateReenrolDto,
    @Req() req: AuthedRequest,
  ): Promise<ReenrolResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.reenrolment.submit(body, actor);
  }
}
