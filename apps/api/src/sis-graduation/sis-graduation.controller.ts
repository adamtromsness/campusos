import {
  Body,
  Controller,
  Delete,
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
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { GraduationService } from './graduation.service';
import { GraduationAuditWorker } from './graduation-audit.worker';
import { GpaService } from './gpa.service';
import { GpaWorker } from './gpa.worker';
import { ServiceLearningService } from './service-learning.service';
import { PrerequisiteService } from './prerequisite.service';
import {
  CreateCoursePrerequisiteDto,
  CreateGpaConfigDto,
  CreateGraduationRequirementDto,
  CreateServiceLearningRequirementDto,
  ReviewServiceLearningHoursDto,
  SubmitServiceLearningHoursDto,
  UpdateGpaConfigDto,
  UpdateGraduationRequirementDto,
  ValidateCourseRegistrationDto,
} from './dto/sis-graduation.dto';

interface AuthedRequest extends Request {
  user?: {
    sub: string;
    personId: string;
    email: string;
    displayName: string;
    sessionId: string;
  };
}

@ApiTags('SIS Graduation')
@ApiBearerAuth()
@Controller()
export class SisGraduationController {
  constructor(
    private readonly graduation: GraduationService,
    private readonly auditWorker: GraduationAuditWorker,
    private readonly gpa: GpaService,
    private readonly gpaWorker: GpaWorker,
    private readonly serviceLearning: ServiceLearningService,
    private readonly prereqs: PrerequisiteService,
    private readonly actors: ActorContextService,
  ) {}

  private async resolveActor(req: AuthedRequest) {
    if (!req.user) throw new Error('Unauthenticated request reached SisGraduation controller');
    return this.actors.resolveActor(req.user.sub, req.user.personId);
  }

  // ─── Graduation Requirements (STU-005) ───

  @Get('sis/graduation-requirements')
  @RequirePermission('stu-005:read')
  @ApiOperation({ summary: 'List graduation requirements for the school.' })
  async listRequirements(@Query('includeInactive') includeInactive?: string) {
    return this.graduation.listRequirements({ includeInactive: includeInactive === 'true' });
  }

  @Get('sis/graduation-requirements/:id')
  @RequirePermission('stu-005:read')
  @ApiOperation({ summary: 'Get a single graduation requirement.' })
  async getRequirement(@Param('id', ParseUUIDPipe) id: string) {
    return this.graduation.getRequirement(id);
  }

  @Post('sis/graduation-requirements')
  @RequirePermission('stu-005:admin')
  @ApiOperation({ summary: 'Admin — define a graduation requirement.' })
  async createRequirement(@Body() dto: CreateGraduationRequirementDto, @Req() req: AuthedRequest) {
    return this.graduation.createRequirement(dto, await this.resolveActor(req));
  }

  @Patch('sis/graduation-requirements/:id')
  @RequirePermission('stu-005:admin')
  @ApiOperation({ summary: 'Admin — update a graduation requirement.' })
  async patchRequirement(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateGraduationRequirementDto,
    @Req() req: AuthedRequest,
  ) {
    return this.graduation.patchRequirement(id, dto, await this.resolveActor(req));
  }

  @Delete('sis/graduation-requirements/:id')
  @RequirePermission('stu-005:admin')
  @ApiOperation({ summary: 'Admin — delete a graduation requirement.' })
  async deleteRequirement(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    await this.graduation.deleteRequirement(id, await this.resolveActor(req));
    return { deleted: true };
  }

  // ─── Graduation Audit (read + manual run) ───

  @Get('sis/students/:id/graduation-audit')
  @RequirePermission('stu-005:read')
  @ApiOperation({
    summary:
      'Per-student graduation audit. Admin all; STAFF broad; STUDENT own; GUARDIAN linked children only.',
  })
  async getStudentAudit(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    return this.graduation.getAuditForStudent(id, await this.resolveActor(req));
  }

  @Get('sis/graduation/at-risk')
  @RequirePermission('stu-005:read')
  @ApiOperation({
    summary:
      'Admin / staff — list every student with any NOT_MET audit row. Hits the partial INDEX for NOT_MET.',
  })
  async listAtRisk(@Req() req: AuthedRequest) {
    return this.graduation.listAtRiskStudents(await this.resolveActor(req));
  }

  @Post('sis/graduation/audit/run')
  @RequirePermission('stu-005:admin')
  @ApiOperation({
    summary:
      'Admin — manually trigger the graduation audit worker for every student in the school. Emits sis.graduation.at_risk for each senior with NOT_MET requirements.',
  })
  async runAudit() {
    return this.auditWorker.runForCurrentTenant();
  }

  @Post('sis/students/:id/graduation-audit/run')
  @RequirePermission('stu-005:admin')
  @ApiOperation({
    summary: 'Admin — re-audit a single student. Does NOT emit at-risk; reads only.',
  })
  async runAuditForStudent(@Param('id', ParseUUIDPipe) id: string) {
    return this.auditWorker.runForStudent(id);
  }

  // ─── Service Learning ───

  @Get('sis/service-learning-requirements')
  @RequirePermission('stu-005:read')
  @ApiOperation({ summary: 'List service learning requirements.' })
  async listServiceLearningRequirements() {
    return this.serviceLearning.listRequirements();
  }

  @Post('sis/service-learning-requirements')
  @RequirePermission('stu-005:admin')
  @ApiOperation({ summary: 'Admin — define a service learning requirement.' })
  async createServiceLearningRequirement(
    @Body() dto: CreateServiceLearningRequirementDto,
    @Req() req: AuthedRequest,
  ) {
    return this.serviceLearning.createRequirement(dto, await this.resolveActor(req));
  }

  @Post('sis/service-learning')
  @RequirePermission('stu-005:write')
  @ApiOperation({
    summary:
      'Submit service learning hours. STUDENT can submit for self; STAFF / admin can submit on behalf.',
  })
  async submitServiceLearningHours(
    @Body() dto: SubmitServiceLearningHoursDto,
    @Req() req: AuthedRequest,
  ) {
    return this.serviceLearning.submitHours(dto, await this.resolveActor(req));
  }

  @Get('sis/service-learning/pending')
  @RequirePermission('stu-005:write')
  @ApiOperation({
    summary: 'Staff / admin — list PENDING service learning hours waiting for review.',
  })
  async listPendingServiceLearningHours(@Req() req: AuthedRequest) {
    return this.serviceLearning.listPendingForReview(await this.resolveActor(req));
  }

  @Get('sis/students/:id/service-learning')
  @RequirePermission('stu-005:read')
  @ApiOperation({ summary: 'Per-student service learning hours list.' })
  async listStudentServiceLearning(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ) {
    return this.serviceLearning.listForStudent(id, await this.resolveActor(req));
  }

  @Get('sis/students/:id/service-learning/progress')
  @RequirePermission('stu-005:read')
  @ApiOperation({
    summary: 'Per-student service learning progress — approved + pending + required + remaining.',
  })
  async studentServiceLearningProgress(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ) {
    return this.serviceLearning.progressForStudent(id, await this.resolveActor(req));
  }

  @Patch('sis/service-learning/:id')
  @RequirePermission('stu-005:write')
  @ApiOperation({
    summary: 'Staff / admin — APPROVE or REJECT a PENDING service learning hours row.',
  })
  async reviewServiceLearningHours(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewServiceLearningHoursDto,
    @Req() req: AuthedRequest,
  ) {
    return this.serviceLearning.reviewHours(id, dto, await this.resolveActor(req));
  }

  // ─── GPA Configurations + Snapshots ───

  @Get('sis/gpa-configurations')
  @RequirePermission('stu-005:read')
  @ApiOperation({ summary: 'List GPA configurations.' })
  async listGpaConfigs() {
    return this.gpa.listConfigs();
  }

  @Post('sis/gpa-configurations')
  @RequirePermission('stu-005:admin')
  @ApiOperation({ summary: 'Admin — define a GPA configuration.' })
  async createGpaConfig(@Body() dto: CreateGpaConfigDto, @Req() req: AuthedRequest) {
    return this.gpa.createConfig(dto, await this.resolveActor(req));
  }

  @Patch('sis/gpa-configurations/:id')
  @RequirePermission('stu-005:admin')
  @ApiOperation({ summary: 'Admin — update a GPA configuration.' })
  async patchGpaConfig(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateGpaConfigDto,
    @Req() req: AuthedRequest,
  ) {
    return this.gpa.patchConfig(id, dto, await this.resolveActor(req));
  }

  @Get('sis/students/:id/gpa')
  @RequirePermission('stu-005:read')
  @ApiOperation({ summary: 'Per-student GPA snapshots (cumulative + term).' })
  async getStudentGpa(@Param('id', ParseUUIDPipe) id: string) {
    return this.gpa.listSnapshotsForStudent(id);
  }

  @Post('sis/gpa/run')
  @RequirePermission('stu-005:admin')
  @ApiOperation({
    summary:
      'Admin — manually trigger the GPA worker for every active student. Optional termId + academicYearId narrow the term_gpa snapshot.',
  })
  async runGpa(
    @Query('termId') termId?: string,
    @Query('academicYearId') academicYearId?: string,
    @Query('configId') configId?: string,
  ) {
    return this.gpaWorker.runForCurrentTenant({ termId, academicYearId, configId });
  }

  @Post('sis/students/:id/gpa/run')
  @RequirePermission('stu-005:admin')
  @ApiOperation({ summary: 'Admin — re-compute GPA snapshots for a single student.' })
  async runGpaForStudent(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('termId') termId?: string,
    @Query('academicYearId') academicYearId?: string,
    @Query('configId') configId?: string,
  ) {
    return this.gpaWorker.runForStudent(id, { termId, academicYearId, configId });
  }

  // ─── Course Prerequisites ───

  @Get('sis/courses/:id/prerequisites')
  @RequirePermission('stu-005:read')
  @ApiOperation({ summary: 'List prerequisites for a course.' })
  async listPrerequisitesForCourse(@Param('id', ParseUUIDPipe) id: string) {
    return this.prereqs.listForCourse(id);
  }

  @Post('sis/course-prerequisites')
  @RequirePermission('stu-005:admin')
  @ApiOperation({ summary: 'Admin — define a course prerequisite.' })
  async createPrerequisite(@Body() dto: CreateCoursePrerequisiteDto, @Req() req: AuthedRequest) {
    return this.prereqs.create(dto, await this.resolveActor(req));
  }

  @Delete('sis/course-prerequisites/:id')
  @RequirePermission('stu-005:admin')
  @ApiOperation({ summary: 'Admin — delete a course prerequisite.' })
  async deletePrerequisite(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    await this.prereqs.delete(id, await this.resolveActor(req));
    return { deleted: true };
  }

  @Post('sis/course-registration/validate')
  @RequirePermission('stu-005:read')
  @ApiOperation({
    summary:
      'Pre-flight: confirm a student has met every mandatory prerequisite (with min_grade) before enrolment.',
  })
  async validateCourseRegistration(@Body() dto: ValidateCourseRegistrationDto) {
    return this.prereqs.validateRegistration(dto.studentId, dto.courseId);
  }
}
