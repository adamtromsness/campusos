import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth';
import { ActorContextService } from '@modules/m00-platform';
import { AgencyReferralService } from './agency-referral.service';
import { CaseloadDashboardService } from '../caseload/caseload-dashboard.service';
import { CrisisEscalationService } from './crisis-escalation.service';
import { MtssTeamMeetingService } from '../mtss/mtss-team-meeting.service';
import { WellbeingLongitudinalService } from '../wellbeing/wellbeing-longitudinal.service';
import {
  AgencyReferralResponseDto,
  CaseloadDashboardResponseDto,
  CreateAgencyReferralDto,
  CreateMtssTeamMeetingDto,
  EscalateReferralResponseDto,
  ListAgencyReferralsQueryDto,
  MaterialiseLongitudinalDto,
  MtssStudentDiscussionResponseDto,
  MtssTeamMeetingResponseDto,
  RecordStudentDiscussionDto,
  StudentLongitudinalResponseDto,
  UpdateAgencyReferralDto,
  WellbeingLongitudinalRowDto,
} from './dto/student-services-advanced.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Student Services Advanced (P2-28c)')
@Controller()
export class StudentServicesAdvancedController {
  constructor(
    private readonly dashboard: CaseloadDashboardService,
    private readonly agency: AgencyReferralService,
    private readonly wellbeing: WellbeingLongitudinalService,
    private readonly mtss: MtssTeamMeetingService,
    private readonly escalation: CrisisEscalationService,
    private readonly actors: ActorContextService,
  ) {}

  /* ── Caseload dashboard (1 endpoint) ── */

  @Get('counselling/caseloads/dashboard')
  @RequirePermission('cou-001:read')
  @ApiOperation({
    summary: 'Counsellor caseload dashboard — active counts, capacity utilisation, CRISIS counts',
  })
  async caseloadDashboard(
    @Query('academicYearId') academicYearId: string | undefined,
    @Req() req: AuthedRequest,
  ): Promise<CaseloadDashboardResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.dashboard.getDashboard(actor, academicYearId);
  }

  /* ── Agency referrals (5 endpoints) ── */

  @Get('counselling/agency-referrals')
  @RequirePermission('cou-002:read')
  @ApiOperation({
    summary: 'List external agency referrals (optionally by parent referral or status)',
  })
  async listAgency(
    @Query() query: ListAgencyReferralsQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<AgencyReferralResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.agency.list(query, actor);
  }

  @Get('counselling/agency-referrals/:id')
  @RequirePermission('cou-002:read')
  @ApiOperation({ summary: 'Get a single external agency referral' })
  async getAgency(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<AgencyReferralResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.agency.getById(id, actor);
  }

  @Post('counselling/agency-referrals')
  @RequirePermission('cou-002:write')
  @ApiOperation({
    summary:
      'Open an external agency referral attached to a parent svc_referrals row — consent gate enforced before ACTIVE_SERVICE',
  })
  async createAgency(
    @Body() dto: CreateAgencyReferralDto,
    @Req() req: AuthedRequest,
  ): Promise<AgencyReferralResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.agency.create(dto, actor);
  }

  @Patch('counselling/agency-referrals/:id')
  @RequirePermission('cou-002:write')
  @ApiOperation({
    summary: 'Update agency referral status, consent flag, follow-up date, or notes',
  })
  async patchAgency(
    @Param('id') id: string,
    @Body() dto: UpdateAgencyReferralDto,
    @Req() req: AuthedRequest,
  ): Promise<AgencyReferralResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.agency.patch(id, dto, actor);
  }

  /* ── Crisis escalation (1 endpoint) ── */

  @Post('counselling/referrals/:id/escalate')
  @RequirePermission('cou-002:write')
  @ApiOperation({
    summary:
      'Escalate a referral to URGENT + ACCEPTED — writes an ESCALATED activity row + emits svc.referral.escalated',
  })
  async escalate(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<EscalateReferralResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.escalation.escalate(id, actor);
  }

  /* ── Wellbeing longitudinal (3 endpoints) ── */

  @Get('counselling/wellbeing-longitudinal/student/:studentId')
  @RequirePermission('cou-004:read')
  @ApiOperation({
    summary: 'Multi-year wellbeing aggregates for a single student (staff-only)',
  })
  async studentLongitudinal(
    @Param('studentId') studentId: string,
    @Req() req: AuthedRequest,
  ): Promise<StudentLongitudinalResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.wellbeing.getForStudent(studentId, actor);
  }

  @Get('counselling/wellbeing-longitudinal/year/:academicYear')
  @RequirePermission('cou-004:read')
  @ApiOperation({ summary: 'School-wide longitudinal rows for one academic year' })
  async yearLongitudinal(
    @Param('academicYear') academicYear: string,
    @Req() req: AuthedRequest,
  ): Promise<WellbeingLongitudinalRowDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.wellbeing.listForYear(academicYear, actor);
  }

  @Post('counselling/wellbeing-longitudinal/materialise')
  @RequirePermission('cou-004:admin')
  @ApiOperation({
    summary:
      'Materialise annual longitudinal rows from svc_wellbeing_responses — idempotent UPSERT on (student, year, domain)',
  })
  async materialise(
    @Body() dto: MaterialiseLongitudinalDto,
    @Req() req: AuthedRequest,
  ): Promise<{ rowsWritten: number; academicYear: string }> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.wellbeing.materialise(dto.academicYear, actor);
  }

  /* ── MTSS team meetings (5 endpoints) ── */

  @Get('counselling/mtss-team-meetings')
  @RequirePermission('cou-003:read')
  @ApiOperation({ summary: 'List MTSS team meetings for this school' })
  async listMeetings(@Req() req: AuthedRequest): Promise<MtssTeamMeetingResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.mtss.list(actor);
  }

  @Get('counselling/mtss-team-meetings/:id')
  @RequirePermission('cou-003:read')
  @ApiOperation({ summary: 'Get a single MTSS team meeting' })
  async getMeeting(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<MtssTeamMeetingResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.mtss.getById(id, actor);
  }

  @Post('counselling/mtss-team-meetings')
  @RequirePermission('cou-003:write')
  @ApiOperation({ summary: 'Schedule a new MTSS team review meeting' })
  async createMeeting(
    @Body() dto: CreateMtssTeamMeetingDto,
    @Req() req: AuthedRequest,
  ): Promise<MtssTeamMeetingResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.mtss.create(dto, actor);
  }

  @Get('counselling/mtss-team-meetings/:id/discussions')
  @RequirePermission('cou-003:read')
  @ApiOperation({ summary: 'List student discussions recorded at the MTSS team meeting' })
  async listDiscussions(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<MtssStudentDiscussionResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.mtss.listDiscussions(id, actor);
  }

  @Post('counselling/mtss-team-meetings/:id/discussions')
  @RequirePermission('cou-003:write')
  @ApiOperation({
    summary:
      'Record a student discussion at an MTSS team meeting with MAINTAIN / ESCALATE / DE_ESCALATE recommendation',
  })
  async recordDiscussion(
    @Param('id') id: string,
    @Body() dto: RecordStudentDiscussionDto,
    @Req() req: AuthedRequest,
  ): Promise<MtssStudentDiscussionResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.mtss.recordDiscussion(id, dto, actor);
  }
}
