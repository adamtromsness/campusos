import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { HouseholdsService } from './households.service';
import {
  AddHouseholdMemberDto,
  HouseholdDto,
  UpdateHouseholdDto,
  UpdateHouseholdMemberDto,
} from './dto/household.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Households')
@ApiBearerAuth()
@Controller('households')
export class HouseholdsController {
  constructor(
    private readonly households: HouseholdsService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('my')
  @RequirePermission('usr-001:read')
  @ApiOperation({ summary: 'Read the calling user’s household' })
  async getMy(@Req() req: AuthedRequest): Promise<HouseholdDto | null> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.households.getMyHousehold(actor);
  }

  @Get(':id')
  @RequirePermission('usr-001:read')
  @ApiOperation({ summary: 'Read a household — only callable by a member or admin' })
  async getOne(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<HouseholdDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    const result = await this.households.getHouseholdById(id, actor);
    if (!result) throw new NotFoundException('Household not found');
    return result;
  }

  @Patch(':id')
  @RequirePermission('usr-001:write')
  @ApiOperation({ summary: 'Update household shared fields (head/spouse only, admin overrides)' })
  async update(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateHouseholdDto,
  ): Promise<HouseholdDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.households.updateHousehold(id, dto, actor);
  }

  @Post(':id/members')
  @RequirePermission('usr-001:write')
  @ApiOperation({ summary: 'Add a person to the household' })
  async addMember(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddHouseholdMemberDto,
  ): Promise<HouseholdDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.households.addMember(id, dto, actor);
  }

  @Patch(':id/members/:memberId')
  @RequirePermission('usr-001:write')
  @ApiOperation({ summary: 'Update a member’s role or primary-contact flag' })
  async updateMember(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Body() dto: UpdateHouseholdMemberDto,
  ): Promise<HouseholdDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.households.updateMember(id, memberId, dto, actor);
  }

  @Delete(':id/members/:memberId')
  @RequirePermission('usr-001:write')
  @ApiOperation({ summary: 'Remove a member; refuses last head and self-eviction' })
  async removeMember(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
  ): Promise<HouseholdDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.households.removeMember(id, memberId, actor);
  }
}
