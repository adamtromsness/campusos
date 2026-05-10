import {
  Body,
  Controller,
  Get,
  Param,
  ParseBoolPipe,
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
import { OfficialService } from './official.service';
import {
  CreateOfficialAssignmentDto,
  CreateOfficialAvailabilityDto,
  CreateOfficialProfileDto,
  CreateOfficialRatingDto,
  OfficialAssignmentResponseDto,
  OfficialAvailabilityResponseDto,
  OfficialProfileResponseDto,
  OfficialRatingResponseDto,
  TransitionOfficialAssignmentDto,
  UpdateOfficialProfileDto,
} from './dto/athletics-advanced.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string };
}

@ApiTags('Athletics Advanced — Officials Marketplace')
@ApiBearerAuth()
@Controller('athletics')
export class OfficialController {
  constructor(
    private readonly officials: OfficialService,
    private readonly actors: ActorContextService,
  ) {}

  // ── Official profiles (platform schema per ADR-063) ─────────────

  @Get('officials')
  @RequirePermission('ath-003:read')
  @ApiOperation({
    summary:
      'Search the officials marketplace. Officials live in the platform schema (ADR-063) so search results are not tenant-scoped. Per REVIEW-P2-8 MAJOR 3, contact email and phone are stripped for non-AD readers.',
  })
  async listProfiles(
    @Req() req: AuthedRequest,
    @Query('sport') sport?: string,
    @Query('isAvailable', new ParseBoolPipe({ optional: true })) isAvailable?: boolean,
    @Query('availableDate') availableDate?: string,
    @Query('search') search?: string,
  ): Promise<OfficialProfileResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.officials.listProfiles({ sport, isAvailable, availableDate, search }, actor);
  }

  @Get('officials/:id')
  @RequirePermission('ath-003:read')
  async getProfile(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<OfficialProfileResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.officials.getProfileById(id, actor);
  }

  @Post('officials/profile')
  @RequirePermission('ath-003:write')
  @ApiOperation({
    summary:
      'Create an official profile. Admin-only this cycle — the official-self-service onboarding path is a Phase 2 carry-over once officials hold platform user accounts.',
  })
  async createProfile(
    @Req() req: AuthedRequest,
    @Body() body: CreateOfficialProfileDto,
  ): Promise<OfficialProfileResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.officials.createProfile(body, actor);
  }

  @Patch('officials/:id')
  @RequirePermission('ath-003:write')
  async updateProfile(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateOfficialProfileDto,
  ): Promise<OfficialProfileResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.officials.updateProfile(id, body, actor);
  }

  // ── Availability ────────────────────────────────────────────────

  @Get('officials/:id/availability')
  @RequirePermission('ath-003:read')
  async listAvailability(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<OfficialAvailabilityResponseDto[]> {
    return this.officials.listAvailability(id);
  }

  @Post('officials/:id/availability')
  @RequirePermission('ath-003:write')
  async createAvailability(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateOfficialAvailabilityDto,
  ): Promise<OfficialAvailabilityResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.officials.createAvailability(id, body, actor);
  }

  // ── Assignments ─────────────────────────────────────────────────

  @Get('games/:gameId/officials')
  @RequirePermission('ath-003:read')
  async listAssignmentsForGame(
    @Param('gameId', ParseUUIDPipe) gameId: string,
  ): Promise<OfficialAssignmentResponseDto[]> {
    return this.officials.listAssignmentsForGame(gameId);
  }

  @Get('officials/:id/assignments')
  @RequirePermission('ath-003:read')
  async listAssignmentsForOfficial(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<OfficialAssignmentResponseDto[]> {
    return this.officials.listAssignmentsForOfficial(id);
  }

  @Get('official-assignments/:id')
  @RequirePermission('ath-003:read')
  async getAssignment(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<OfficialAssignmentResponseDto> {
    return this.officials.getAssignmentById(id);
  }

  @Post('games/:gameId/officials')
  @RequirePermission('ath-003:write')
  async createAssignment(
    @Req() req: AuthedRequest,
    @Param('gameId', ParseUUIDPipe) gameId: string,
    @Body() body: CreateOfficialAssignmentDto,
  ): Promise<OfficialAssignmentResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.officials.createAssignment(gameId, body, actor);
  }

  @Patch('official-assignments/:id')
  @RequirePermission('ath-003:write')
  @ApiOperation({
    summary:
      'Transition an assignment through its lifecycle. POSTED → ACCEPTED → CONFIRMED → COMPLETED, with CANCELLED and NO_SHOW as terminal alternates. Emits ath.official.assignment.completed on the COMPLETED transition.',
  })
  async transitionAssignment(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: TransitionOfficialAssignmentDto,
  ): Promise<OfficialAssignmentResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.officials.transitionAssignment(id, body, actor);
  }

  // ── Bidirectional ratings ───────────────────────────────────────

  @Get('official-assignments/:id/ratings')
  @RequirePermission('ath-003:read')
  async listRatings(@Param('id', ParseUUIDPipe) id: string): Promise<OfficialRatingResponseDto[]> {
    return this.officials.listRatingsForAssignment(id);
  }

  @Post('official-assignments/:id/rate')
  @RequirePermission('ath-003:write')
  @ApiOperation({
    summary:
      'Submit a bidirectional rating. UNIQUE(assignment_id, rater_type) caps each direction at one row per assignment.',
  })
  async createRating(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateOfficialRatingDto,
  ): Promise<OfficialRatingResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.officials.createRating(id, body, actor);
  }
}
