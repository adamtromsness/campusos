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
import { TrainingProgrammeService } from './programme.service';
import { TrainingEventService } from './event.service';
import { CompletionService } from './completion.service';
import { CertificationTypeService, EmployeeCertificationService } from './certification.service';
import {
  CertificationTypeDto,
  CreateCertificationTypeDto,
  CreateEmployeeCertificationDto,
  CreateTrainingEventDto,
  CreateTrainingProgrammeDto,
  EmployeeCertificationDto,
  EventStatus,
  RecordCompletionDto,
  RevokeEmployeeCertificationDto,
  TrainingCompletionDto,
  TrainingEventDto,
  TrainingProgrammeDto,
  UpdateCertificationTypeDto,
  UpdateTrainingEventDto,
  UpdateTrainingProgrammeDto,
} from './dto/training.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('hr-training')
@ApiBearerAuth()
@Controller('hr')
export class TrainingController {
  constructor(
    private readonly programmes: TrainingProgrammeService,
    private readonly events: TrainingEventService,
    private readonly completions: CompletionService,
    private readonly certTypes: CertificationTypeService,
    private readonly employeeCerts: EmployeeCertificationService,
    private readonly actors: ActorContextService,
  ) {}

  // Programme catalogue (admin tier — Staff + Admin)

  @Get('training/programmes')
  @RequirePermission('hr-004:read')
  async listProgrammes(
    @Query('includeInactive') includeInactive?: string,
  ): Promise<TrainingProgrammeDto[]> {
    return this.programmes.list(includeInactive === 'true');
  }

  @Get('training/programmes/:id')
  @RequirePermission('hr-004:read')
  async getProgramme(@Param('id', ParseUUIDPipe) id: string): Promise<TrainingProgrammeDto> {
    return this.programmes.getById(id);
  }

  @Post('training/programmes')
  @RequirePermission('hr-004:write')
  async createProgramme(
    @Req() req: AuthedRequest,
    @Body() input: CreateTrainingProgrammeDto,
  ): Promise<TrainingProgrammeDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.programmes.create(input, actor);
  }

  @Patch('training/programmes/:id')
  @RequirePermission('hr-004:write')
  async patchProgramme(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: UpdateTrainingProgrammeDto,
  ): Promise<TrainingProgrammeDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.programmes.patch(id, input, actor);
  }

  // Events (admin tier — Staff + Admin)

  @Get('training/events')
  @RequirePermission('hr-004:read')
  async listEvents(
    @Query('programmeId') programmeId?: string,
    @Query('status') status?: EventStatus,
  ): Promise<TrainingEventDto[]> {
    return this.events.list({ programmeId, status });
  }

  @Get('training/events/:id')
  @RequirePermission('hr-004:read')
  async getEvent(@Param('id', ParseUUIDPipe) id: string): Promise<TrainingEventDto> {
    return this.events.getById(id);
  }

  @Post('training/events')
  @RequirePermission('hr-004:write')
  async createEvent(
    @Req() req: AuthedRequest,
    @Body() input: CreateTrainingEventDto,
  ): Promise<TrainingEventDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.events.create(input, actor);
  }

  @Patch('training/events/:id')
  @RequirePermission('hr-004:write')
  async patchEvent(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: UpdateTrainingEventDto,
  ): Promise<TrainingEventDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.events.patch(id, input, actor);
  }

  // Completions

  @Get('training/events/:id/completions')
  @RequirePermission('hr-004:read')
  @ApiOperation({
    summary:
      'List completions for a training event. REVIEW-P2-4c BLOCKING 2 — admin (school admin OR hr-004:write/admin) sees the full roster; non-admin actors see only their own completion row. Generic Teachers with hr-004:read CANNOT enumerate other employees’ training history.',
  })
  async listEventCompletions(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TrainingCompletionDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.completions.listForEvent(id, actor);
  }

  @Get('training/employees/:employeeId/completions')
  @RequirePermission('hr-004:read')
  async listEmployeeCompletions(
    @Req() req: AuthedRequest,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
  ): Promise<TrainingCompletionDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.completions.listForEmployee(employeeId, actor);
  }

  @Post('training/events/:id/completions')
  @RequirePermission('hr-004:write')
  @ApiOperation({
    summary:
      'Record a training completion. Auto-issues a matching hr_employee_certifications row when the parent programme is mandatory + has renewal_months + a matching cert type exists. Emits hr.training.completed via OutboxService.enqueueInTx.',
  })
  async recordCompletion(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: RecordCompletionDto,
  ): Promise<TrainingCompletionDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.completions.record(id, input, actor);
  }

  // Certification types catalogue

  @Get('training/certification-types')
  @RequirePermission('hr-004:read')
  async listCertTypes(
    @Query('includeInactive') includeInactive?: string,
  ): Promise<CertificationTypeDto[]> {
    return this.certTypes.list(includeInactive === 'true');
  }

  @Post('training/certification-types')
  @RequirePermission('hr-004:write')
  async createCertType(
    @Req() req: AuthedRequest,
    @Body() input: CreateCertificationTypeDto,
  ): Promise<CertificationTypeDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.certTypes.create(input, actor);
  }

  @Patch('training/certification-types/:id')
  @RequirePermission('hr-004:write')
  async patchCertType(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: UpdateCertificationTypeDto,
  ): Promise<CertificationTypeDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.certTypes.patch(id, input, actor);
  }

  // Employee certifications

  @Get('training/employees/:employeeId/certifications')
  @RequirePermission('hr-004:read')
  async listEmployeeCertifications(
    @Req() req: AuthedRequest,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
  ): Promise<EmployeeCertificationDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.employeeCerts.listForEmployee(employeeId, actor);
  }

  @Get('training/certifications-expiring')
  @RequirePermission('hr-004:read')
  @ApiOperation({
    summary:
      'Admin dashboard — every active certification across the school sorted by nearest expiry first. ?daysAhead=N (default 60) filters to certs expiring within the window.',
  })
  async listExpiring(
    @Req() req: AuthedRequest,
    @Query('daysAhead') daysAhead?: string,
  ): Promise<EmployeeCertificationDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    const days = daysAhead ? Number(daysAhead) : 60;
    return this.employeeCerts.listExpiringSoon(isNaN(days) ? 60 : days, actor);
  }

  @Post('training/employee-certifications')
  @RequirePermission('hr-004:write')
  async createEmployeeCertification(
    @Req() req: AuthedRequest,
    @Body() input: CreateEmployeeCertificationDto,
  ): Promise<EmployeeCertificationDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.employeeCerts.create(input, actor);
  }

  @Patch('training/employee-certifications/:id/revoke')
  @RequirePermission('hr-004:write')
  async revokeEmployeeCertification(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: RevokeEmployeeCertificationDto,
  ): Promise<EmployeeCertificationDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.employeeCerts.revoke(id, input, actor);
  }
}
