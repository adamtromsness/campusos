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
import { RequirePermission } from '@shared/auth/require-permission.decorator';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { FinancialAidService } from './financial-aid.service';
import {
  CreateFinancialAidApplicationDto,
  CreateFinancialAidProgramDto,
  FinancialAidApplicationResponseDto,
  FinancialAidAwardResponseDto,
  FinancialAidProgramResponseDto,
  ListFinancialAidApplicationsQueryDto,
  ReviewFinancialAidApplicationDto,
  UpdateFinancialAidApplicationDto,
  UpdateFinancialAidProgramDto,
  WithdrawFinancialAidApplicationDto,
} from './dto/financial-aid.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Payments: Financial Aid')
@ApiBearerAuth()
@Controller('payments/financial-aid')
export class FinancialAidController {
  constructor(
    private readonly aid: FinancialAidService,
    private readonly actors: ActorContextService,
  ) {}

  /** ───── Programmes ───── */

  @Get('programs')
  @RequirePermission('fin-002:read')
  @ApiOperation({ summary: 'List financial aid programmes (active only by default)' })
  async listPrograms(
    @Query('includeInactive') includeInactive?: string,
  ): Promise<FinancialAidProgramResponseDto[]> {
    return this.aid.listPrograms(includeInactive === 'true');
  }

  @Get('programs/:id')
  @RequirePermission('fin-002:read')
  @ApiOperation({ summary: 'Get a single financial aid programme' })
  async getProgramById(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<FinancialAidProgramResponseDto> {
    return this.aid.getProgramById(id);
  }

  @Post('programs')
  @RequirePermission('fin-002:admin')
  @ApiOperation({ summary: 'Create a financial aid programme (admin only)' })
  async createProgram(
    @Body() body: CreateFinancialAidProgramDto,
    @Req() req: AuthedRequest,
  ): Promise<FinancialAidProgramResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.aid.createProgram(body, actor);
  }

  @Patch('programs/:id')
  @RequirePermission('fin-002:admin')
  @ApiOperation({ summary: 'Patch a financial aid programme (admin only)' })
  async updateProgram(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateFinancialAidProgramDto,
    @Req() req: AuthedRequest,
  ): Promise<FinancialAidProgramResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.aid.updateProgram(id, body, actor);
  }

  /** ───── Applications ───── */

  @Get('applications')
  @RequirePermission('fin-002:read')
  @ApiOperation({
    summary:
      'List financial aid applications. Admins see all. Parents see own-submitted plus own children applications (row-scoped via sis_guardians.person_id).',
  })
  async listApplications(
    @Query() query: ListFinancialAidApplicationsQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<FinancialAidApplicationResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.aid.listApplications(query, actor);
  }

  @Get('applications/:id')
  @RequirePermission('fin-002:read')
  @ApiOperation({ summary: 'Get a single financial aid application' })
  async getApplicationById(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<FinancialAidApplicationResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.aid.getApplicationById(id, actor);
  }

  @Post('applications')
  @RequirePermission('fin-002:write')
  @ApiOperation({
    summary:
      'Create a financial aid application. Parent submits for own child (row-scoped via sis_guardians); admin can create on behalf.',
  })
  async createApplication(
    @Body() body: CreateFinancialAidApplicationDto,
    @Req() req: AuthedRequest,
  ): Promise<FinancialAidApplicationResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.aid.createApplication(body, actor);
  }

  @Patch('applications/:id')
  @RequirePermission('fin-002:write')
  @ApiOperation({
    summary:
      'Patch a DRAFT financial aid application (parent path). Admins can patch in any state.',
  })
  async updateApplication(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateFinancialAidApplicationDto,
    @Req() req: AuthedRequest,
  ): Promise<FinancialAidApplicationResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.aid.updateApplication(id, body, actor);
  }

  @Post('applications/:id/submit')
  @RequirePermission('fin-002:write')
  @ApiOperation({ summary: 'Move a DRAFT application to SUBMITTED' })
  async submitApplication(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<FinancialAidApplicationResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.aid.submitApplication(id, actor);
  }

  @Post('applications/:id/withdraw')
  @RequirePermission('fin-002:write')
  @ApiOperation({ summary: 'Withdraw a non-terminal application (parent or admin)' })
  async withdrawApplication(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: WithdrawFinancialAidApplicationDto,
    @Req() req: AuthedRequest,
  ): Promise<FinancialAidApplicationResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.aid.withdrawApplication(id, body, actor);
  }

  @Post('applications/:id/review')
  @RequirePermission('fin-002:admin')
  @ApiOperation({
    summary:
      'Admin review action: APPROVE creates an award and decrements programme fund_remaining atomically inside a locked tenant tx so the fund cannot oversell. REJECT records a rejection. UNDER_REVIEW marks the application in-review.',
  })
  async reviewApplication(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReviewFinancialAidApplicationDto,
    @Req() req: AuthedRequest,
  ): Promise<FinancialAidApplicationResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.aid.reviewApplication(id, body, actor);
  }

  /** ───── Awards ───── */

  @Get('awards/:studentId')
  @RequirePermission('fin-002:read')
  @ApiOperation({
    summary: 'List financial aid awards for a student (admin: all; parent: own children only)',
  })
  async listAwardsForStudent(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Req() req: AuthedRequest,
  ): Promise<FinancialAidAwardResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.aid.listAwardsForStudent(studentId, actor);
  }
}
