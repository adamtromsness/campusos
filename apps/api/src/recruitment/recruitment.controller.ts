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
import { ActorContextService } from '../iam/actor-context.service';
import { Public } from '../auth/public.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ApplicationService } from './application.service';
import { InterviewService } from './interview.service';
import { JobPostingService } from './job-posting.service';
import { OfferService } from './offer.service';
import {
  ApplicationDto,
  ApplyToJobDto,
  CreateInterviewPanelDto,
  CreateJobPostingDto,
  ExtendOfferDto,
  InterviewDto,
  InterviewEvaluationDto,
  InterviewPanelDto,
  JobPostingDto,
  ListApplicationsQueryDto,
  ListJobPostingsQueryDto,
  OfferDto,
  RespondToOfferDto,
  ScheduleInterviewDto,
  SubmitEvaluationDto,
  UpdateApplicationDto,
  UpdateInterviewDto,
  UpdateJobPostingDto,
} from './dto/recruitment.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('hr-recruitment')
@ApiBearerAuth()
@Controller('hr')
export class RecruitmentController {
  constructor(
    private readonly postings: JobPostingService,
    private readonly applications: ApplicationService,
    private readonly interviews: InterviewService,
    private readonly offers: OfferService,
    private readonly actors: ActorContextService,
  ) {}

  // ---- Job postings (admin) -------------------------------------------------

  @Get('jobs')
  @RequirePermission('hr-002:read')
  async listPostings(@Query() query: ListJobPostingsQueryDto): Promise<JobPostingDto[]> {
    return this.postings.list(query);
  }

  @Get('jobs/:id')
  @RequirePermission('hr-002:read')
  async getPosting(@Param('id', ParseUUIDPipe) id: string): Promise<JobPostingDto> {
    return this.postings.getById(id);
  }

  @Post('jobs')
  @RequirePermission('hr-002:write')
  async createPosting(
    @Req() req: AuthedRequest,
    @Body() input: CreateJobPostingDto,
  ): Promise<JobPostingDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.postings.create(input, actor);
  }

  @Patch('jobs/:id')
  @RequirePermission('hr-002:write')
  @ApiOperation({
    summary:
      'Update a job posting. status=LIVE transition stamps posted_at and enqueues hr.job.posted in platform_outbox via OutboxService.enqueueInTx.',
  })
  async patchPosting(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: UpdateJobPostingDto,
  ): Promise<JobPostingDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.postings.patch(id, input, actor);
  }

  // ---- Public job board ----------------------------------------------------

  @Get('jobs-public')
  @Public()
  @ApiOperation({
    summary:
      'Public-facing job board — returns LIVE postings only. The tenant context is resolved through the standard resolver middleware so the result is automatically scoped to the requesting school subdomain.',
  })
  async listPublicPostings(): Promise<JobPostingDto[]> {
    return this.postings.listPublicLive();
  }

  // ---- Applications ---------------------------------------------------------

  @Get('applications')
  @RequirePermission('hr-002:read')
  async listApplications(
    @Req() req: AuthedRequest,
    @Query() query: ListApplicationsQueryDto,
  ): Promise<ApplicationDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.applications.list(query, actor);
  }

  @Get('applications/:id')
  @RequirePermission('hr-002:read')
  async getApplication(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ApplicationDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.applications.getById(id, actor);
  }

  @Get('jobs/:postingId/applications')
  @RequirePermission('hr-002:read')
  async listForPosting(
    @Req() req: AuthedRequest,
    @Param('postingId', ParseUUIDPipe) postingId: string,
  ): Promise<ApplicationDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.applications.listForPosting(postingId, actor);
  }

  @Post('jobs/:postingId/apply')
  @Public()
  @ApiOperation({
    summary:
      'Public application path — creates iam_person + platform_users on email miss; INSERTs hr_applications. UNIQUE(posting_id, person_id) prevents double-apply (returns 400).',
  })
  async apply(
    @Param('postingId', ParseUUIDPipe) postingId: string,
    @Body() input: ApplyToJobDto,
  ): Promise<ApplicationDto> {
    return this.applications.apply(postingId, input);
  }

  @Patch('applications/:id')
  @RequirePermission('hr-002:write')
  async patchApplication(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: UpdateApplicationDto,
  ): Promise<ApplicationDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.applications.patch(id, input, actor);
  }

  // ---- Interview panels -----------------------------------------------------

  @Get('jobs/:postingId/panels')
  @RequirePermission('hr-002:read')
  async listPanels(
    @Req() req: AuthedRequest,
    @Param('postingId', ParseUUIDPipe) postingId: string,
  ): Promise<InterviewPanelDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.interviews.listPanels(postingId, actor);
  }

  @Post('interview-panels')
  @RequirePermission('hr-002:write')
  async createPanel(
    @Req() req: AuthedRequest,
    @Body() input: CreateInterviewPanelDto,
  ): Promise<InterviewPanelDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.interviews.createPanel(input, actor);
  }

  // ---- Interviews -----------------------------------------------------------

  @Post('interviews')
  @RequirePermission('hr-002:write')
  async scheduleInterview(
    @Req() req: AuthedRequest,
    @Body() input: ScheduleInterviewDto,
  ): Promise<InterviewDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.interviews.schedule(input, actor);
  }

  @Get('applications/:applicationId/interviews')
  @RequirePermission('hr-002:read')
  async listInterviews(
    @Req() req: AuthedRequest,
    @Param('applicationId', ParseUUIDPipe) applicationId: string,
  ): Promise<InterviewDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.interviews.listForApplication(applicationId, actor);
  }

  @Get('interviews/:id')
  @RequirePermission('hr-002:read')
  async getInterview(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<InterviewDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.interviews.getById(id, actor);
  }

  @Patch('interviews/:id')
  @RequirePermission('hr-002:write')
  async patchInterview(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: UpdateInterviewDto,
  ): Promise<InterviewDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.interviews.patch(id, input, actor);
  }

  // ---- Interview evaluations -----------------------------------------------

  @Post('interviews/:id/evaluations')
  @RequirePermission('hr-002:read')
  @ApiOperation({
    summary:
      'Submit an evaluation. Service-layer scope check: only members of the panel that conducted the interview can submit. UPSERT on (interview_id, evaluator_id) — re-submitting overwrites.',
  })
  async submitEvaluation(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: SubmitEvaluationDto,
  ): Promise<InterviewEvaluationDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.interviews.submitEvaluation(id, input, actor);
  }

  @Get('interviews/:id/evaluations')
  @RequirePermission('hr-002:read')
  async listEvaluations(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<InterviewEvaluationDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.interviews.listEvaluations(id, actor);
  }

  // ---- Offers ---------------------------------------------------------------

  @Get('offers')
  @RequirePermission('hr-002:read')
  async listOffers(@Req() req: AuthedRequest): Promise<OfferDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.offers.list(actor);
  }

  @Get('offers/:id')
  @RequirePermission('hr-002:read')
  async getOffer(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<OfferDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.offers.getById(id, actor);
  }

  @Post('applications/:applicationId/offer')
  @RequirePermission('hr-002:write')
  async extendOffer(
    @Req() req: AuthedRequest,
    @Param('applicationId', ParseUUIDPipe) applicationId: string,
    @Body() input: ExtendOfferDto,
  ): Promise<OfferDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.offers.extendOffer(applicationId, input, actor);
  }

  @Patch('offers/:id')
  @RequirePermission('hr-002:read')
  @ApiOperation({
    summary:
      'Respond to an offer. The candidate (matched on application.person_id == actor.personId) or an admin can call this. ACCEPTED auto-creates hr_employees + hr_employee_positions inside the same tx and enqueues hr.offer.accepted in platform_outbox.',
  })
  async respondToOffer(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: RespondToOfferDto,
  ): Promise<OfferDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.offers.respond(id, input, actor);
  }
}
