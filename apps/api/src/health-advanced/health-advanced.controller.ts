import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ActorContextService } from '../iam/actor-context.service';
import { RequirePermission } from '../auth/require-permission.decorator';
import {
  ComplianceDashboardDto,
  CreateImmunisationRequirementDto,
  CreateScreeningReferralDto,
  CreateTelehealthProviderDto,
  CreateTelehealthSessionDto,
  ImmunisationComplianceDto,
  ImmunisationRequirementDto,
  ListComplianceQueryDto,
  ListReferralsQueryDto,
  ListTelehealthSessionsQueryDto,
  ManualComputeDto,
  ScreeningReferralDto,
  TelehealthDocumentDto,
  TelehealthProviderDto,
  TelehealthSessionDto,
  UpdateImmunisationRequirementDto,
  UpdateScreeningReferralDto,
  UpdateTelehealthProviderDto,
  UpdateTelehealthSessionDto,
  UploadTelehealthDocumentDto,
} from './dto/health-advanced.dto';
import { ImmunisationComplianceService } from './immunisation-compliance.service';
import { ImmunisationRequirementService } from './immunisation-requirement.service';
import { ScreeningReferralService } from './screening-referral.service';
import { TelehealthProviderService } from './telehealth-provider.service';
import { TelehealthSessionService } from './telehealth-session.service';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Health Advanced')
@Controller('health')
export class HealthAdvancedController {
  constructor(
    private readonly actors: ActorContextService,
    private readonly providers: TelehealthProviderService,
    private readonly sessions: TelehealthSessionService,
    private readonly requirements: ImmunisationRequirementService,
    private readonly compliance: ImmunisationComplianceService,
    private readonly referrals: ScreeningReferralService,
  ) {}

  // ---------- Telehealth providers ---------------------------------------

  @Get('telehealth/providers')
  @RequirePermission('hlt-006:read')
  async listProviders(
    @Query('includeInactive') includeInactive?: string,
  ): Promise<TelehealthProviderDto[]> {
    return this.providers.list(includeInactive === 'true');
  }

  @Get('telehealth/providers/:id')
  @RequirePermission('hlt-006:read')
  async getProvider(@Param('id', ParseUUIDPipe) id: string): Promise<TelehealthProviderDto> {
    return this.providers.getById(id);
  }

  @Post('telehealth/providers')
  @RequirePermission('hlt-006:write')
  async createProvider(
    @Req() req: AuthedRequest,
    @Body() input: CreateTelehealthProviderDto,
  ): Promise<TelehealthProviderDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.providers.create(input, actor);
  }

  @Patch('telehealth/providers/:id')
  @RequirePermission('hlt-006:write')
  async patchProvider(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: UpdateTelehealthProviderDto,
  ): Promise<TelehealthProviderDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.providers.patch(id, input, actor);
  }

  // ---------- Telehealth sessions ----------------------------------------

  @Get('telehealth/sessions')
  @RequirePermission('hlt-006:read')
  @ApiOperation({
    summary:
      'List telehealth sessions. HIPAA: every row returned writes a hlth_health_access_log entry with access_type=VIEW_TELEHEALTH.',
  })
  async listSessions(
    @Req() req: AuthedRequest,
    @Query() query: ListTelehealthSessionsQueryDto,
  ): Promise<TelehealthSessionDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.sessions.list(query, actor);
  }

  @Get('telehealth/sessions/:id')
  @RequirePermission('hlt-006:read')
  async getSession(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TelehealthSessionDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.sessions.getById(id, actor);
  }

  @Post('telehealth/sessions')
  @RequirePermission('hlt-006:write')
  async scheduleSession(
    @Req() req: AuthedRequest,
    @Body() input: CreateTelehealthSessionDto,
  ): Promise<TelehealthSessionDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.sessions.schedule(input, actor);
  }

  @Patch('telehealth/sessions/:id')
  @RequirePermission('hlt-006:write')
  async patchSession(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: UpdateTelehealthSessionDto,
  ): Promise<TelehealthSessionDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.sessions.patch(id, input, actor);
  }

  @Post('telehealth/sessions/:id/consent')
  @RequirePermission('hlt-006:write')
  async recordConsent(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: { signatureRequestId?: string },
  ): Promise<TelehealthSessionDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.sessions.recordConsent(id, input.signatureRequestId ?? null, actor);
  }

  @Get('telehealth/sessions/:id/documents')
  @RequirePermission('hlt-006:read')
  async listDocuments(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TelehealthDocumentDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.sessions.listDocuments(id, actor);
  }

  @Post('telehealth/sessions/:id/documents')
  @RequirePermission('hlt-006:write')
  async uploadDocument(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: UploadTelehealthDocumentDto,
  ): Promise<TelehealthDocumentDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.sessions.uploadDocument(id, input, actor);
  }

  // ---------- Immunisation requirements ----------------------------------

  @Get('immunisation/requirements')
  @RequirePermission('hlt-001:read')
  async listRequirements(
    @Query('stateCode') stateCode?: string,
  ): Promise<ImmunisationRequirementDto[]> {
    return this.requirements.list(stateCode);
  }

  @Post('immunisation/requirements')
  @RequirePermission('hlt-001:admin')
  async createRequirement(
    @Req() req: AuthedRequest,
    @Body() input: CreateImmunisationRequirementDto,
  ): Promise<ImmunisationRequirementDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.requirements.create(input, actor);
  }

  @Patch('immunisation/requirements/:id')
  @RequirePermission('hlt-001:admin')
  async patchRequirement(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: UpdateImmunisationRequirementDto,
  ): Promise<ImmunisationRequirementDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.requirements.patch(id, input, actor);
  }

  // ---------- Immunisation compliance ------------------------------------

  @Get('immunisation/compliance')
  @RequirePermission('hlt-001:read')
  async listCompliance(
    @Query() query: ListComplianceQueryDto,
  ): Promise<ImmunisationComplianceDto[]> {
    return this.compliance.list(query);
  }

  @Get('immunisation/compliance/dashboard')
  @RequirePermission('hlt-001:read')
  async complianceDashboard(): Promise<ComplianceDashboardDto> {
    return this.compliance.dashboard();
  }

  @Get('immunisation/compliance/report')
  @RequirePermission('hlt-001:read')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @ApiOperation({
    summary:
      'State-formatted CSV. Columns: student_state_id, grade_level, vaccine_name, doses_required, doses_received, compliance_status, exemption_type. Source for the annual state immunisation submission.',
  })
  async complianceReport(@Res() res: Response): Promise<void> {
    const csv = await this.compliance.stateReportCsv();
    const today = new Date().toISOString().slice(0, 10);
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="immunisation-compliance-' + today + '.csv"',
    );
    res.send(csv);
  }

  @Get('immunisation/compliance/:studentId')
  @RequirePermission('hlt-001:read')
  async getComplianceForStudent(
    @Req() req: AuthedRequest,
    @Param('studentId', ParseUUIDPipe) studentId: string,
  ): Promise<ImmunisationComplianceDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.compliance.getForStudent(studentId, actor);
  }

  @Post('immunisation/compliance/run')
  @RequirePermission('hlt-001:admin')
  async runCompliance(
    @Req() req: AuthedRequest,
    @Body() input: ManualComputeDto,
  ): Promise<{ computed: number; newlyNonCompliant: number }> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.compliance.runManually(input.studentId ?? null, actor);
  }

  // ---------- Screening referrals ----------------------------------------

  @Post('screenings/:id/referrals')
  @RequirePermission('hlt-004:write')
  async createReferral(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) screeningId: string,
    @Body() input: CreateScreeningReferralDto,
  ): Promise<ScreeningReferralDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.referrals.createFromScreening(screeningId, input, actor);
  }

  @Get('screening-referrals')
  @RequirePermission('hlt-004:read')
  async listReferrals(@Query() query: ListReferralsQueryDto): Promise<ScreeningReferralDto[]> {
    return this.referrals.list(query);
  }

  @Get('screening-referrals/overdue')
  @RequirePermission('hlt-004:read')
  async overdueReferrals(): Promise<ScreeningReferralDto[]> {
    return this.referrals.overdue();
  }

  @Get('screening-referrals/:id')
  @RequirePermission('hlt-004:read')
  async getReferral(@Param('id', ParseUUIDPipe) id: string): Promise<ScreeningReferralDto> {
    return this.referrals.getById(id);
  }

  @Patch('screening-referrals/:id')
  @RequirePermission('hlt-004:write')
  async patchReferral(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: UpdateScreeningReferralDto,
  ): Promise<ScreeningReferralDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.referrals.patch(id, input, actor);
  }
}
