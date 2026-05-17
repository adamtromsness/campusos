import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth/require-permission.decorator';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { RosterService } from './roster.service';
import {
  AddRosterMemberDto,
  CreateRosterDto,
  RosterMemberResponseDto,
  RosterResponseDto,
  UpdateRosterDto,
  UpdateRosterMemberDto,
} from './dto/athletics.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string };
}

@ApiTags('Athletics — Rosters')
@ApiBearerAuth()
@Controller('athletics')
export class RosterController {
  constructor(
    private readonly rosters: RosterService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('seasons/:id/rosters')
  @RequirePermission('ath-001:read')
  async listForSeason(@Param('id', ParseUUIDPipe) id: string): Promise<RosterResponseDto[]> {
    return this.rosters.listForSeason(id);
  }

  @Get('rosters/:id')
  @RequirePermission('ath-001:read')
  async getById(@Param('id', ParseUUIDPipe) id: string): Promise<RosterResponseDto> {
    return this.rosters.getById(id);
  }

  @Get('rosters/:id/members')
  @RequirePermission('ath-001:read')
  async listMembers(@Param('id', ParseUUIDPipe) id: string): Promise<RosterMemberResponseDto[]> {
    return this.rosters.listMembers(id);
  }

  @Post('seasons/:id/rosters')
  @RequirePermission('ath-001:write')
  @ApiOperation({ summary: 'Create a roster at a level. AD or admin only.' })
  async create(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateRosterDto,
  ): Promise<RosterResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.rosters.create(id, body, actor);
  }

  @Patch('rosters/:id')
  @RequirePermission('ath-001:write')
  async patch(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateRosterDto,
  ): Promise<RosterResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.rosters.patch(id, body, actor);
  }

  @Post('rosters/:id/certify')
  @RequirePermission('ath-001:write')
  @ApiOperation({ summary: 'Certify the roster. Refuses if any active member is INELIGIBLE.' })
  async certify(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<RosterResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.rosters.certify(id, actor);
  }

  @Post('rosters/:id/members')
  @RequirePermission('ath-001:write')
  @ApiOperation({
    summary:
      'Add a student to the roster. The GPA eligibility check reads live grades from the Cycle 2 gradebook and sets eligibility_status accordingly when programme.min_gpa is set.',
  })
  async addMember(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AddRosterMemberDto,
  ): Promise<RosterMemberResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.rosters.addMember(id, body, actor);
  }

  @Patch('roster-members/:memberId')
  @RequirePermission('ath-001:write')
  async patchMember(
    @Req() req: AuthedRequest,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Body() body: UpdateRosterMemberDto,
  ): Promise<RosterMemberResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.rosters.patchMember(memberId, body, actor);
  }

  @Post('rosters/:id/check-eligibility')
  @RequirePermission('ath-001:write')
  @ApiOperation({
    summary:
      'Bulk re-check eligibility for every active member of the roster against the live gradebook. Returns the updated members.',
  })
  async checkEligibility(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<RosterMemberResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.rosters.checkEligibility(id, actor);
  }
}
