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
import { RequirePermission } from '@shared/auth';
import { ActorContextService } from '@modules/m00-platform';
import { ReferralService } from './referral.service';
import { ReferralActivityService } from './referral-activity.service';
import {
  AcceptReferralDto,
  CompleteReferralDto,
  CreateReferralDto,
  DeclineReferralDto,
  ListReferralsQueryDto,
  ReferralActivityResponseDto,
  ReferralResponseDto,
  TriageReferralDto,
} from '../counselling/dto/counselling.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Counselling Referrals')
@ApiBearerAuth()
@Controller('counselling/referrals')
export class ReferralController {
  constructor(
    private readonly referrals: ReferralService,
    private readonly activity: ReferralActivityService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('cou-002:read')
  @ApiOperation({
    summary:
      'List referrals. Admins see all. Counsellors see assigned + the unassigned-triage queue. Teachers see own submitted. Parents and students never reach this gate.',
  })
  async list(
    @Query() query: ListReferralsQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<ReferralResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.referrals.list(query, actor);
  }

  @Get(':id')
  @RequirePermission('cou-002:read')
  @ApiOperation({
    summary:
      'Fetch a single referral with inlined activity timeline (chronological audit). 404 to non-participants.',
  })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<ReferralResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.referrals.getById(id, actor);
  }

  @Get(':id/activity')
  @RequirePermission('cou-002:read')
  @ApiOperation({ summary: 'Chronological activity timeline for a referral.' })
  async listActivity(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<ReferralActivityResponseDto[]> {
    // Reuse the row-scope at the ReferralService layer via getById to
    // ensure non-participants 404 before any audit rows are returned.
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    await this.referrals.getById(id, actor);
    return this.activity.listForReferral(id);
  }

  @Post()
  @RequirePermission('cou-002:write')
  @ApiOperation({
    summary:
      'Submit a new referral. Stamps referred_by from actor.employeeId; copies default_priority from the chosen referral_type when no override is supplied; emits svc.referral.created.',
  })
  async create(
    @Body() body: CreateReferralDto,
    @Req() req: AuthedRequest,
  ): Promise<ReferralResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.referrals.create(body, actor);
  }

  @Patch(':id/triage')
  @RequirePermission('cou-002:write')
  @ApiOperation({
    summary:
      'Counsellor or admin transitions SUBMITTED → TRIAGED with assigned_counselor_id stamped. Writes ASSIGNMENT_CHANGE + STATUS_CHANGE activity rows.',
  })
  async triage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: TriageReferralDto,
    @Req() req: AuthedRequest,
  ): Promise<ReferralResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.referrals.triage(id, body, actor);
  }

  @Patch(':id/accept')
  @RequirePermission('cou-002:write')
  @ApiOperation({
    summary:
      'Counsellor or admin transitions TRIAGED → ACCEPTED. Optionally auto-opens a caseload for the referral student in the same flow when openCaseload=true.',
  })
  async accept(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AcceptReferralDto,
    @Req() req: AuthedRequest,
  ): Promise<ReferralResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.referrals.accept(id, body, actor);
  }

  @Patch(':id/start')
  @RequirePermission('cou-002:write')
  @ApiOperation({
    summary:
      'Counsellor or admin transitions ACCEPTED → IN_PROGRESS to mark the start of casework.',
  })
  async start(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<ReferralResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.referrals.start(id, actor);
  }

  @Patch(':id/complete')
  @RequirePermission('cou-002:write')
  @ApiOperation({
    summary:
      'Counsellor or admin transitions IN_PROGRESS or ACCEPTED → COMPLETED with an outcome summary.',
  })
  async complete(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CompleteReferralDto,
    @Req() req: AuthedRequest,
  ): Promise<ReferralResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.referrals.complete(id, body, actor);
  }

  @Patch(':id/decline')
  @RequirePermission('cou-002:write')
  @ApiOperation({
    summary: 'Counsellor or admin declines a non-terminal referral with a written reason.',
  })
  async decline(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DeclineReferralDto,
    @Req() req: AuthedRequest,
  ): Promise<ReferralResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.referrals.decline(id, body, actor);
  }
}
