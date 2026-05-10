import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { ActorContextService } from '../iam/actor-context.service';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string };
}
import { RequirePermission } from '../auth/require-permission.decorator';
import { SubstituteProfileService } from './substitute-profile.service';
import { SchoolPoolService } from './school-pool.service';
import { JobPostingService } from './job-posting.service';
import {
  AddToPoolDto,
  AssignmentResponseDto,
  CreateSubstituteProfileDto,
  JobPostingResponseDto,
  PostJobDto,
  SchoolPoolMemberResponseDto,
  SubstituteProfileResponseDto,
  SubstituteSearchDto,
  UpdatePoolMemberDto,
} from './dto/substitutes.dto';

/**
 * SubstitutesController — P2-9 step 5 + 6 unified controller.
 *
 * Routes split by access tier:
 *   Profile         /substitutes/profile/* — sub-001 self-service or admin
 *   Pool            /substitutes/pool/*    — sch-004:write admin
 *   Jobs            /substitutes/jobs/*    — sch-004 read + write
 *   Search          /substitutes/search    — sch-004:read for matching
 *
 * Substitute self-service writes (own profile, accept/decline) gate on
 * SUB-001:write. Admin writes (manage pool, post jobs) gate on
 * SCH-004:write. Reads gate on SCH-004:read or SUB-001:read.
 */
@ApiTags('substitutes')
@Controller('substitutes')
export class SubstitutesController {
  constructor(
    private readonly profiles: SubstituteProfileService,
    private readonly pool: SchoolPoolService,
    private readonly jobs: JobPostingService,
    private readonly actors: ActorContextService,
  ) {}

  // ── Profile + Search ────────────────────────────────────────────

  @Get('profile/me')
  @RequirePermission('sub-001:read')
  @ApiOperation({ summary: 'Get my own substitute profile (self-service).' })
  async myProfile(@Req() req: AuthedRequest): Promise<SubstituteProfileResponseDto | null> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.profiles.getMyProfile(actor);
  }

  @Get('profile/:id')
  @RequirePermission('sch-004:read')
  @ApiOperation({ summary: 'Get a substitute profile by id (admin or self).' })
  async getProfile(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<SubstituteProfileResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.profiles.getById(id, actor);
  }

  @Get('profiles')
  @RequirePermission('sch-004:read')
  @ApiOperation({ summary: 'List substitute profiles (admin only — substitutes use /me).' })
  async listProfiles(@Req() req: AuthedRequest): Promise<SubstituteProfileResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.profiles.list(actor);
  }

  @Post('profile')
  @RequirePermission('sub-001:write')
  @ApiOperation({ summary: 'Create my own substitute profile (or admin on behalf).' })
  async createProfile(
    @Body() input: CreateSubstituteProfileDto,
    @Req() req: AuthedRequest,
  ): Promise<SubstituteProfileResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.profiles.create(input, actor);
  }

  @Get('search')
  @RequirePermission('sch-004:read')
  @ApiOperation({
    summary:
      'Substitute matching engine. Filters by grade_levels (GIN), subject_areas, availability for a date (BLOCKED overrides RECURRING), VERIFIED credentials, and excludes BLOCKED schools.',
  })
  async search(@Query() query: SubstituteSearchDto): Promise<SubstituteProfileResponseDto[]> {
    return this.profiles.search(query);
  }

  // ── School Pool ─────────────────────────────────────────────────

  @Get('pool')
  @RequirePermission('sch-004:read')
  @ApiOperation({ summary: 'List my school substitute pool.' })
  async listPool(@Req() req: AuthedRequest): Promise<SchoolPoolMemberResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.pool.list(actor);
  }

  @Post('pool')
  @RequirePermission('sch-004:write')
  @ApiOperation({ summary: 'Add a substitute to the school pool.' })
  async addToPool(
    @Body() input: AddToPoolDto,
    @Req() req: AuthedRequest,
  ): Promise<SchoolPoolMemberResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.pool.addToPool(input, actor);
  }

  @Patch('pool/:id')
  @RequirePermission('sch-004:write')
  @ApiOperation({ summary: 'Update a pool member (suspend, reactivate, remove).' })
  async updatePoolMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: UpdatePoolMemberDto,
    @Req() req: AuthedRequest,
  ): Promise<SchoolPoolMemberResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.pool.updatePoolMember(id, input, actor);
  }

  // ── Jobs ────────────────────────────────────────────────────────

  @Get('jobs')
  @RequirePermission('sch-004:read')
  @ApiOperation({ summary: 'List substitute jobs (admin all; substitute notified-jobs only).' })
  async listJobs(
    @Req() req: AuthedRequest,
    @Query('status') status?: string,
  ): Promise<JobPostingResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.jobs.list(actor, status);
  }

  @Get('jobs/:id')
  @RequirePermission('sch-004:read')
  @ApiOperation({ summary: 'Get a job posting by id (with classes + notifications).' })
  async getJob(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<JobPostingResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.jobs.getById(id, actor);
  }

  @Post('jobs')
  @RequirePermission('sch-004:write')
  @ApiOperation({
    summary:
      'Post a substitute job. Tier 1 (POOL) notifications fan out to ACTIVE pool members on insert. sub.job.posted emits via outbox.',
  })
  async postJob(
    @Body() input: PostJobDto,
    @Req() req: AuthedRequest,
  ): Promise<JobPostingResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.jobs.post(input, actor);
  }

  @Post('jobs/:id/accept')
  @HttpCode(201)
  @RequirePermission('sub-001:write')
  @ApiOperation({
    summary:
      'Substitute accepts a job notification. Locks the row + validates window. Creates sub_assignments + flips job to FILLED. Emits sub.assignment.confirmed.',
  })
  async acceptJob(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<AssignmentResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.jobs.accept(id, actor);
  }

  @Post('jobs/:id/decline')
  @HttpCode(200)
  @RequirePermission('sub-001:write')
  @ApiOperation({ summary: 'Substitute declines a job notification.' })
  async declineJob(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<{ jobId: string; response: 'DECLINED' }> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.jobs.decline(id, actor);
  }
}
