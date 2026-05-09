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
import { RequirePermission } from '../auth/require-permission.decorator';
import {
  AppraisalCommentService,
  AppraisalCycleService,
  AppraisalFrameworkService,
  AppraisalGoalService,
  AppraisalService,
  LessonObservationService,
} from './appraisals.service';
import { ExpenseClaimService } from './expense-claim.service';
import {
  AppraisalCommentDto,
  AppraisalCycleDto,
  AppraisalDto,
  AppraisalFrameworkDto,
  AppraisalGoalDto,
  CreateAppraisalCommentDto,
  CreateAppraisalCycleDto,
  CreateAppraisalDto,
  CreateAppraisalFrameworkDto,
  CreateAppraisalGoalDto,
  CreateExpenseClaimDto,
  CreateLessonObservationDto,
  DecideExpenseClaimDto,
  ExpenseClaimDto,
  ExpenseStatus,
  LessonObservationDto,
  MarkExpensePaidDto,
  UpdateAppraisalCycleDto,
  UpdateAppraisalDto,
  UpdateAppraisalFrameworkDto,
  UpdateAppraisalGoalDto,
  UpdateLessonObservationDto,
} from './dto/appraisals.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('hr-appraisals')
@ApiBearerAuth()
@Controller('hr')
export class AppraisalsController {
  constructor(
    private readonly frameworks: AppraisalFrameworkService,
    private readonly cycles: AppraisalCycleService,
    private readonly appraisals: AppraisalService,
    private readonly goals: AppraisalGoalService,
    private readonly comments: AppraisalCommentService,
    private readonly observations: LessonObservationService,
    private readonly claims: ExpenseClaimService,
    private readonly actors: ActorContextService,
  ) {}

  // Frameworks (admin only)

  @Get('appraisals/frameworks')
  @RequirePermission('hr-005:read')
  async listFrameworks(
    @Query('includeInactive') includeInactive?: string,
  ): Promise<AppraisalFrameworkDto[]> {
    return this.frameworks.list(includeInactive === 'true');
  }

  @Post('appraisals/frameworks')
  @RequirePermission('hr-005:write')
  async createFramework(
    @Req() req: AuthedRequest,
    @Body() input: CreateAppraisalFrameworkDto,
  ): Promise<AppraisalFrameworkDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.frameworks.create(input, actor);
  }

  @Patch('appraisals/frameworks/:id')
  @RequirePermission('hr-005:write')
  async patchFramework(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: UpdateAppraisalFrameworkDto,
  ): Promise<AppraisalFrameworkDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.frameworks.patch(id, input, actor);
  }

  // Cycles (admin only)

  @Get('appraisals/cycles')
  @RequirePermission('hr-005:read')
  async listCycles(): Promise<AppraisalCycleDto[]> {
    return this.cycles.list();
  }

  @Get('appraisals/cycles/:id')
  @RequirePermission('hr-005:read')
  async getCycle(@Param('id', ParseUUIDPipe) id: string): Promise<AppraisalCycleDto> {
    return this.cycles.getById(id);
  }

  @Post('appraisals/cycles')
  @RequirePermission('hr-005:write')
  async createCycle(
    @Req() req: AuthedRequest,
    @Body() input: CreateAppraisalCycleDto,
  ): Promise<AppraisalCycleDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.cycles.create(input, actor);
  }

  @Patch('appraisals/cycles/:id')
  @RequirePermission('hr-005:write')
  async patchCycle(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: UpdateAppraisalCycleDto,
  ): Promise<AppraisalCycleDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.cycles.patch(id, input, actor);
  }

  // Appraisals — own + admin

  @Get('appraisals')
  @RequirePermission('hr-005:read')
  async listAppraisals(
    @Req() req: AuthedRequest,
    @Query('cycleId') cycleId?: string,
    @Query('employeeId') employeeId?: string,
  ): Promise<AppraisalDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.appraisals.list({ cycleId, employeeId }, actor);
  }

  @Get('appraisals/:id')
  @RequirePermission('hr-005:read')
  async getAppraisal(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AppraisalDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.appraisals.getById(id, actor);
  }

  @Post('appraisals')
  @RequirePermission('hr-005:write')
  async createAppraisal(
    @Req() req: AuthedRequest,
    @Body() input: CreateAppraisalDto,
  ): Promise<AppraisalDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.appraisals.create(input, actor);
  }

  @Patch('appraisals/:id')
  @RequirePermission('hr-005:read')
  @ApiOperation({
    summary:
      'Update an appraisal. Service-layer authorisation: admin/appraiser may edit appraiserReview/overallRating/status; the appraisee may only edit selfReview. SIGNED_OFF is the immutable terminal — refused once status reaches it.',
  })
  async patchAppraisal(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: UpdateAppraisalDto,
  ): Promise<AppraisalDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.appraisals.patch(id, input, actor);
  }

  // Goals

  @Post('appraisals/:id/goals')
  @RequirePermission('hr-005:read')
  async createGoal(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: CreateAppraisalGoalDto,
  ): Promise<AppraisalGoalDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.goals.create(id, input, actor);
  }

  @Patch('appraisal-goals/:id')
  @RequirePermission('hr-005:read')
  async patchGoal(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: UpdateAppraisalGoalDto,
  ): Promise<AppraisalGoalDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.goals.patch(id, input, actor);
  }

  // Comments

  @Post('appraisals/:id/comments')
  @RequirePermission('hr-005:read')
  async createComment(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: CreateAppraisalCommentDto,
  ): Promise<AppraisalCommentDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.comments.create(id, input, actor);
  }

  // Lesson observations — keystone gate

  @Get('appraisals/lesson-observations/employee/:employeeId')
  @RequirePermission('hr-005:read')
  async listEmployeeObservations(
    @Req() req: AuthedRequest,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
  ): Promise<LessonObservationDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.observations.listForEmployee(employeeId, actor);
  }

  @Post('appraisals/lesson-observations')
  @RequirePermission('lesson_observation:write')
  @ApiOperation({
    summary:
      'Author a lesson observation. KEYSTONE — gated on lesson_observation:write (held only by School Admin / Platform Admin via everyFunction). Generic Staff with hr-005:write CANNOT reach this surface. Defence-in-depth: the service-layer assertObservationWrite check runs the same gate.',
  })
  async createObservation(
    @Req() req: AuthedRequest,
    @Body() input: CreateLessonObservationDto,
  ): Promise<LessonObservationDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.observations.create(input, actor);
  }

  @Patch('appraisals/lesson-observations/:id')
  @RequirePermission('lesson_observation:write')
  async patchObservation(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: UpdateLessonObservationDto,
  ): Promise<LessonObservationDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.observations.patch(id, input, actor);
  }

  @Patch('appraisals/lesson-observations/:id/lock')
  @RequirePermission('lesson_observation:write')
  async lockObservation(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<LessonObservationDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.observations.lock(id, actor);
  }

  // Expense claims

  @Get('expense-claims')
  @RequirePermission('hr-012:read')
  async listClaims(
    @Req() req: AuthedRequest,
    @Query('status') status?: ExpenseStatus,
    @Query('mine') mine?: string,
  ): Promise<ExpenseClaimDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.claims.list({ status, mine: mine === 'true' }, actor);
  }

  @Post('expense-claims')
  @RequirePermission('hr-012:write')
  async createClaim(
    @Req() req: AuthedRequest,
    @Body() input: CreateExpenseClaimDto,
  ): Promise<ExpenseClaimDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.claims.create(input, actor);
  }

  @Patch('expense-claims/:id/decide')
  @RequirePermission('hr-012:write')
  @ApiOperation({
    summary:
      'Approve or reject an expense claim. Service-layer admin check (school admin OR hr-012:admin via everyFunction). REJECTED requires non-empty rejectionReason. Multi-column decided_chk schema invariant enforces approver fields populated.',
  })
  async decideClaim(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: DecideExpenseClaimDto,
  ): Promise<ExpenseClaimDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.claims.decide(id, input, actor);
  }

  @Patch('expense-claims/:id/mark-paid')
  @RequirePermission('hr-012:write')
  async markPaid(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: MarkExpensePaidDto,
  ): Promise<ExpenseClaimDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.claims.markPaid(id, input, actor);
  }
}
