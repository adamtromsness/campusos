import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth';
import { ActorContextService } from '@modules/m00-platform';
import {
  CreateMidYearAdmissionDto,
  MidYearAdmissionResponseDto,
  UpdateMidYearAdmissionDto,
} from '../withdrawals/dto/withdrawal.dto';
import { MidYearAdmissionService } from './mid-year-admission.service';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Enrolment Mid-Year Admissions')
@ApiBearerAuth()
@Controller('enrolment')
export class MidYearAdmissionController {
  constructor(
    private readonly midYear: MidYearAdmissionService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('mid-year')
  @RequirePermission('stu-004:read')
  @ApiOperation({
    summary: 'List mid-year admission requests (admin: all; parent: own only).',
  })
  async list(@Req() req: AuthedRequest): Promise<MidYearAdmissionResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.midYear.list(actor);
  }

  @Get('mid-year/:id')
  @RequirePermission('stu-004:read')
  @ApiOperation({ summary: 'Get a single mid-year admission request.' })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<MidYearAdmissionResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.midYear.getById(id, actor);
  }

  @Post('mid-year')
  @RequirePermission('stu-004:write')
  @ApiOperation({
    summary:
      'Parent or EO submits a mid-year admission request. Status starts at RECEIVED awaiting a capacity check.',
  })
  async submit(
    @Body() body: CreateMidYearAdmissionDto,
    @Req() req: AuthedRequest,
  ): Promise<MidYearAdmissionResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.midYear.submit(body, actor);
  }

  @Patch('mid-year/:id')
  @RequirePermission('stu-004:admin')
  @ApiOperation({
    summary:
      'EO checks capacity, advances status, links to a Cycle 16 application via linkedApplicationId.',
  })
  async patch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateMidYearAdmissionDto,
    @Req() req: AuthedRequest,
  ): Promise<MidYearAdmissionResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.midYear.patch(id, body, actor);
  }
}
