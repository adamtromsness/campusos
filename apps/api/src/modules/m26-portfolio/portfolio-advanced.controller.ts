import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth/require-permission.decorator';
import { StudentOwned } from '@shared/auth/student-owned.decorator';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { PortfolioSectionService } from './section.service';
import { ReflectionService } from './reflection.service';
import { EndorsementService } from './endorsement.service';
import { ReadinessPathwayService } from './readiness.service';
import { CollegeApplicationService } from './college-application.service';
import { ResumeService } from './resume.service';
import {
  AssignItemToSectionDto,
  AssignPathwayDto,
  CollegeApplicationDto,
  CreateCollegeApplicationDto,
  CreateEndorsementDto,
  CreateMilestoneDto,
  CreatePathwayDto,
  CreateReflectionDto,
  CreateSectionDto,
  EndorsementDto,
  GenerateResumePdfResponseDto,
  PathwayAssignmentDto,
  PathwayMilestoneDto,
  PortfolioSectionDto,
  ReadinessDashboardRowDto,
  ReadinessPathwayDetailDto,
  ReadinessPathwayDto,
  ReflectionDto,
  ResumeProfileDto,
  UpdateCollegeApplicationDto,
  UpdateEndorsementVisibilityDto,
  UpdateMilestoneDto,
  UpdateMilestoneStatusDto,
  UpdatePathwayDto,
  UpdateReflectionDto,
  UpdateResumeDto,
  UpdateSectionDto,
} from './dto/portfolio-advanced.dto';

interface AuthedRequest extends Request {
  user?: {
    sub: string;
    personId: string;
    email: string;
    displayName: string;
    sessionId: string;
  };
}

@ApiTags('Portfolio Advanced')
@Controller()
export class PortfolioAdvancedController {
  constructor(
    private readonly sections: PortfolioSectionService,
    private readonly reflections: ReflectionService,
    private readonly endorsements: EndorsementService,
    private readonly readiness: ReadinessPathwayService,
    private readonly college: CollegeApplicationService,
    private readonly resume: ResumeService,
    private readonly actors: ActorContextService,
  ) {}

  private async resolveActor(req: AuthedRequest) {
    if (!req.user) throw new Error('Unauthenticated request reached PortfolioAdvanced controller');
    return this.actors.resolveActor(req.user.sub, req.user.personId);
  }

  // ── Sections ──────────────────────────────────────────────

  @Get('portfolio/:id/sections')
  @RequirePermission('ach-002:read')
  async listSections(@Param('id') id: string): Promise<PortfolioSectionDto[]> {
    return this.sections.listForPortfolio(id);
  }

  @Post('portfolio/:id/sections')
  @RequirePermission('ach-002:write')
  async createSection(
    @Param('id') id: string,
    @Body() dto: CreateSectionDto,
    @Req() req: AuthedRequest,
  ): Promise<PortfolioSectionDto> {
    return this.sections.create(id, await this.resolveActor(req), dto);
  }

  @Patch('portfolio/sections/:sectionId')
  @RequirePermission('ach-002:write')
  async patchSection(
    @Param('sectionId') sectionId: string,
    @Body() dto: UpdateSectionDto,
    @Req() req: AuthedRequest,
  ): Promise<PortfolioSectionDto> {
    return this.sections.patch(sectionId, await this.resolveActor(req), dto);
  }

  @Delete('portfolio/sections/:sectionId')
  @RequirePermission('ach-002:write')
  @HttpCode(204)
  async removeSection(
    @Param('sectionId') sectionId: string,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    return this.sections.remove(sectionId, await this.resolveActor(req));
  }

  @Patch('portfolio/items/:itemId/section')
  @RequirePermission('ach-002:write')
  @ApiOperation({
    summary:
      'Assign a portfolio item to a section (or null to remove). Item + section must belong to the same portfolio.',
  })
  async assignItemToSection(
    @Param('itemId') itemId: string,
    @Body() dto: AssignItemToSectionDto,
    @Req() req: AuthedRequest,
  ): Promise<{ ok: true }> {
    await this.sections.assignItemToSection(itemId, await this.resolveActor(req), dto);
    return { ok: true };
  }

  // ── Reflections ──────────────────────────────────────────

  @Get('portfolio/items/:itemId/reflections')
  @RequirePermission('ach-002:read')
  async listReflections(
    @Param('itemId') itemId: string,
    @Req() req: AuthedRequest,
  ): Promise<ReflectionDto[]> {
    return this.reflections.listForItem(itemId, await this.resolveActor(req));
  }

  @Post('portfolio/items/:itemId/reflections')
  @RequirePermission('ach-002:write')
  @StudentOwned({ studentIdBody: 'studentId', allowAdminOverride: true })
  @ApiOperation({
    summary:
      'STUDENT-OWNED (pfl_reflections) — only the student can write their own reflection. Teachers cannot author reflections; service-layer ReflectionService.create enforces.',
  })
  async createReflection(
    @Param('itemId') itemId: string,
    @Body() dto: CreateReflectionDto,
    @Req() req: AuthedRequest,
  ): Promise<ReflectionDto> {
    return this.reflections.create(itemId, await this.resolveActor(req), dto);
  }

  @Patch('portfolio/reflections/:reflectionId')
  @RequirePermission('ach-002:write')
  @StudentOwned({ allowAdminOverride: true })
  async patchReflection(
    @Param('reflectionId') reflectionId: string,
    @Body() dto: UpdateReflectionDto,
    @Req() req: AuthedRequest,
  ): Promise<ReflectionDto> {
    return this.reflections.patch(reflectionId, await this.resolveActor(req), dto);
  }

  // ── Endorsements ─────────────────────────────────────────

  @Get('portfolio/:id/endorsements')
  @RequirePermission('ach-002:read')
  async listEndorsements(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<EndorsementDto[]> {
    return this.endorsements.listForPortfolio(id, await this.resolveActor(req));
  }

  @Post('portfolio/:id/endorsements')
  @RequirePermission('ach-002:write')
  @ApiOperation({
    summary:
      'Teacher / counsellor / mentor endorses with skill tags + comment. Students CANNOT endorse — service-layer 403.',
  })
  async createEndorsement(
    @Param('id') id: string,
    @Body() dto: CreateEndorsementDto,
    @Req() req: AuthedRequest,
  ): Promise<EndorsementDto> {
    return this.endorsements.create(id, await this.resolveActor(req), dto);
  }

  @Patch('portfolio/endorsements/:endorsementId/visibility')
  @RequirePermission('ach-002:write')
  @ApiOperation({
    summary:
      'Student-controlled visibility toggle. Only the owning student or a school admin can flip is_visible_on_share.',
  })
  async patchEndorsementVisibility(
    @Param('endorsementId') endorsementId: string,
    @Body() dto: UpdateEndorsementVisibilityDto,
    @Req() req: AuthedRequest,
  ): Promise<EndorsementDto> {
    return this.endorsements.updateVisibility(endorsementId, await this.resolveActor(req), dto);
  }

  @Delete('portfolio/endorsements/:endorsementId')
  @RequirePermission('ach-002:write')
  @HttpCode(204)
  async removeEndorsement(
    @Param('endorsementId') endorsementId: string,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    return this.endorsements.remove(endorsementId, await this.resolveActor(req));
  }

  // ── Readiness Pathways (ACH-003) ────────────────────────

  @Get('portfolio/pathways')
  @RequirePermission('ach-003:read')
  async listPathways(
    @Query('includeInactive') includeInactive?: string,
  ): Promise<ReadinessPathwayDto[]> {
    return this.readiness.listPathways(includeInactive === 'true');
  }

  @Get('portfolio/pathways/:pathwayId')
  @RequirePermission('ach-003:read')
  async getPathway(@Param('pathwayId') pathwayId: string): Promise<ReadinessPathwayDetailDto> {
    return this.readiness.getPathway(pathwayId);
  }

  @Post('portfolio/pathways')
  @RequirePermission('ach-003:write')
  async createPathway(
    @Body() dto: CreatePathwayDto,
    @Req() req: AuthedRequest,
  ): Promise<ReadinessPathwayDto> {
    return this.readiness.createPathway(await this.resolveActor(req), dto);
  }

  @Patch('portfolio/pathways/:pathwayId')
  @RequirePermission('ach-003:write')
  async patchPathway(
    @Param('pathwayId') pathwayId: string,
    @Body() dto: UpdatePathwayDto,
    @Req() req: AuthedRequest,
  ): Promise<ReadinessPathwayDto> {
    return this.readiness.patchPathway(pathwayId, await this.resolveActor(req), dto);
  }

  @Post('portfolio/pathways/:pathwayId/milestones')
  @RequirePermission('ach-003:write')
  async createMilestone(
    @Param('pathwayId') pathwayId: string,
    @Body() dto: CreateMilestoneDto,
    @Req() req: AuthedRequest,
  ): Promise<PathwayMilestoneDto> {
    return this.readiness.createMilestone(pathwayId, await this.resolveActor(req), dto);
  }

  @Patch('portfolio/milestones/:milestoneId')
  @RequirePermission('ach-003:write')
  async patchMilestone(
    @Param('milestoneId') milestoneId: string,
    @Body() dto: UpdateMilestoneDto,
    @Req() req: AuthedRequest,
  ): Promise<PathwayMilestoneDto> {
    return this.readiness.patchMilestone(milestoneId, await this.resolveActor(req), dto);
  }

  @Delete('portfolio/milestones/:milestoneId')
  @RequirePermission('ach-003:write')
  @HttpCode(204)
  async removeMilestone(
    @Param('milestoneId') milestoneId: string,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    return this.readiness.removeMilestone(milestoneId, await this.resolveActor(req));
  }

  @Post('portfolio/pathways/:pathwayId/assign')
  @RequirePermission('ach-003:write')
  async assignPathway(
    @Param('pathwayId') pathwayId: string,
    @Body() dto: AssignPathwayDto,
    @Req() req: AuthedRequest,
  ): Promise<PathwayAssignmentDto> {
    return this.readiness.assignToStudent(pathwayId, await this.resolveActor(req), dto);
  }

  @Get('portfolio/readiness/students/:studentId')
  @RequirePermission('ach-003:read')
  async getStudentReadiness(
    @Param('studentId') studentId: string,
    @Req() req: AuthedRequest,
  ): Promise<PathwayAssignmentDto[]> {
    return this.readiness.getStudentReadiness(studentId, await this.resolveActor(req));
  }

  @Get('portfolio/pathway-assignments/:assignmentId')
  @RequirePermission('ach-003:read')
  async getAssignment(
    @Param('assignmentId') assignmentId: string,
    @Req() req: AuthedRequest,
  ): Promise<PathwayAssignmentDto> {
    return this.readiness.getAssignment(assignmentId, await this.resolveActor(req));
  }

  @Patch('portfolio/pathway-assignments/:assignmentId/milestone-status')
  @RequirePermission('ach-003:write')
  async updateMilestoneStatus(
    @Param('assignmentId') assignmentId: string,
    @Body() dto: UpdateMilestoneStatusDto,
    @Req() req: AuthedRequest,
  ): Promise<PathwayAssignmentDto> {
    return this.readiness.updateMilestoneStatus(assignmentId, await this.resolveActor(req), dto);
  }

  @Get('portfolio/readiness/dashboard')
  @RequirePermission('ach-003:read')
  @ApiOperation({
    summary:
      'School-wide readiness dashboard — counsellor + admin only. atRiskOnly=true filters to <50% progress.',
  })
  async readinessDashboard(
    @Query('atRiskOnly') atRiskOnly: string | undefined,
    @Req() req: AuthedRequest,
  ): Promise<ReadinessDashboardRowDto[]> {
    return this.readiness.getDashboard(await this.resolveActor(req), atRiskOnly === 'true');
  }

  // ── College Applications ────────────────────────────────

  @Get('portfolio/college-applications/students/:studentId')
  @RequirePermission('ach-003:read')
  async listCollegeForStudent(
    @Param('studentId') studentId: string,
    @Req() req: AuthedRequest,
  ): Promise<CollegeApplicationDto[]> {
    return this.college.listForStudent(studentId, await this.resolveActor(req));
  }

  @Get('portfolio/college-applications/:applicationId')
  @RequirePermission('ach-003:read')
  async getCollegeApplication(
    @Param('applicationId') applicationId: string,
    @Req() req: AuthedRequest,
  ): Promise<CollegeApplicationDto> {
    return this.college.getById(applicationId, await this.resolveActor(req));
  }

  @Post('portfolio/college-applications')
  @RequirePermission('ach-003:write')
  @StudentOwned({ studentIdBody: 'studentId', allowAdminOverride: true })
  @ApiOperation({
    summary:
      'STUDENT-OWNED (pfl_college_applications) — student authors their own application list; counsellor/admin can override.',
  })
  async createCollegeApplication(
    @Body() dto: CreateCollegeApplicationDto,
    @Req() req: AuthedRequest,
  ): Promise<CollegeApplicationDto> {
    return this.college.create(await this.resolveActor(req), dto);
  }

  @Patch('portfolio/college-applications/:applicationId')
  @RequirePermission('ach-003:write')
  @StudentOwned({ allowAdminOverride: true })
  async patchCollegeApplication(
    @Param('applicationId') applicationId: string,
    @Body() dto: UpdateCollegeApplicationDto,
    @Req() req: AuthedRequest,
  ): Promise<CollegeApplicationDto> {
    return this.college.patch(applicationId, await this.resolveActor(req), dto);
  }

  @Delete('portfolio/college-applications/:applicationId')
  @RequirePermission('ach-003:write')
  @StudentOwned({ allowAdminOverride: true })
  @HttpCode(204)
  async removeCollegeApplication(
    @Param('applicationId') applicationId: string,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    return this.college.remove(applicationId, await this.resolveActor(req));
  }

  @Get('portfolio/college-applications/deadlines')
  @RequirePermission('ach-003:read')
  @ApiOperation({
    summary:
      'School-wide upcoming college application deadlines — counsellor / admin only at the service layer.',
  })
  async listUpcomingDeadlines(@Req() req: AuthedRequest): Promise<CollegeApplicationDto[]> {
    return this.college.listUpcomingDeadlines(await this.resolveActor(req));
  }

  // ── Resume ─────────────────────────────────────────────

  @Get('portfolio/resume/students/:studentId')
  @RequirePermission('ach-003:read')
  async getResume(
    @Param('studentId') studentId: string,
    @Req() req: AuthedRequest,
  ): Promise<ResumeProfileDto> {
    return this.resume.getForStudent(studentId, await this.resolveActor(req));
  }

  @Patch('portfolio/resume/students/:studentId')
  @RequirePermission('ach-003:write')
  @StudentOwned({ studentIdParam: 'studentId', allowAdminOverride: true })
  async patchResume(
    @Param('studentId') studentId: string,
    @Body() dto: UpdateResumeDto,
    @Req() req: AuthedRequest,
  ): Promise<ResumeProfileDto> {
    return this.resume.patch(studentId, await this.resolveActor(req), dto);
  }

  @Post('portfolio/resume/students/:studentId/generate-pdf')
  @RequirePermission('ach-003:write')
  @StudentOwned({ studentIdParam: 'studentId', allowAdminOverride: true })
  @ApiOperation({
    summary:
      'STUDENT-OWNED (pfl_resume_profiles) — assembles the resume PDF from the profile + portfolio data + endorsement skills + service hours + achievements + extracurriculars.',
  })
  async generateResumePdf(
    @Param('studentId') studentId: string,
    @Req() req: AuthedRequest,
  ): Promise<GenerateResumePdfResponseDto> {
    return this.resume.generatePdf(studentId, await this.resolveActor(req));
  }
}
