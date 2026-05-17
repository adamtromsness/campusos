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
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { ActorContextService } from '@modules/m00-platform';
import { RequirePermission } from '@shared/auth';
import { AccountabilityService } from '../reunification/accountability.service';
import { DrillService } from '../drills/drill.service';
import {
  AccountabilityRecordDto,
  AccountabilitySummaryDto,
  BulkUpdateAccountabilityDto,
  CancelDrillDto,
  CompleteDrillDto,
  CorrectReunificationDto,
  CreateDrillDto,
  CreateIncidentTypeDto,
  CreateNonDisciplineDto,
  CreateProcedureDto,
  CreateReunificationDto,
  CreateTimelineEntryDto,
  DeclareIncidentDto,
  DrillDto,
  DrillStatus,
  IncidentDto,
  IncidentTypeDto,
  ListIncidentsQueryDto,
  ListNonDisciplineQueryDto,
  NonDisciplineIncidentDto,
  OverdueDrillDto,
  ProcedureDto,
  ProcedureType,
  ResolveIncidentDto,
  ReunificationCorrectionDto,
  ReunificationRecordDto,
  TimelineEntryDto,
  UpdateAccountabilityDto,
  UpdateIncidentTypeDto,
  UpdateNonDisciplineDto,
  UpdateProcedureDto,
} from '../common/dto/incident.dto';
import { IncidentService } from './incident.service';
import { IncidentTypeService } from './incident-type.service';
import { NonDisciplineIncidentService } from './non-discipline.service';
import { ProcedureService } from '../emergency/procedure.service';
import { ReunificationService } from '../reunification/reunification.service';
import { TimelineService } from './timeline.service';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Incidents')
@Controller('incidents')
export class IncidentsController {
  constructor(
    private readonly actors: ActorContextService,
    private readonly incidents: IncidentService,
    private readonly types: IncidentTypeService,
    private readonly procedures: ProcedureService,
    private readonly timeline: TimelineService,
    private readonly accountability: AccountabilityService,
    private readonly reunification: ReunificationService,
    private readonly drills: DrillService,
    private readonly nonDiscipline: NonDisciplineIncidentService,
  ) {}

  // ---------- Incident lifecycle ------------------------------------------

  @Post('declare')
  @RequirePermission('saf-001:write')
  @ApiOperation({
    summary:
      'Declare an emergency. Atomic — inc_incidents + inc_declaration_outbox in one tx. ' +
      'inc.emergency.declared emitted after commit. Outbox worker fans out to tasks, muster, alerts.',
  })
  async declare(
    @Req() req: AuthedRequest,
    @Body() input: DeclareIncidentDto,
  ): Promise<IncidentDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.incidents.declare(input, actor);
  }

  @Get()
  @RequirePermission('saf-001:read')
  async list(@Query() query: ListIncidentsQueryDto): Promise<IncidentDto[]> {
    return this.incidents.list(query);
  }

  @Get(':id')
  @RequirePermission('saf-001:read')
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<IncidentDto> {
    return this.incidents.getById(id);
  }

  @Patch(':id/resolve')
  @RequirePermission('saf-001:write')
  @ApiOperation({
    summary: 'Mark an ACTIVE incident RESOLVED. Stamps resolved_at + resolved_by atomically.',
  })
  async resolve(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: ResolveIncidentDto,
  ): Promise<IncidentDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.incidents.resolve(id, input, actor);
  }

  @Patch(':id/cancel')
  @RequirePermission('saf-001:write')
  @ApiOperation({ summary: 'Cancel a declaration made in error. ACTIVE -> CANCELLED.' })
  async cancel(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<IncidentDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.incidents.cancel(id, actor);
  }

  // ---------- Incident types catalogue ------------------------------------

  @Get('types/list')
  @RequirePermission('saf-001:read')
  async listTypes(@Query('includeInactive') includeInactive?: string): Promise<IncidentTypeDto[]> {
    return this.types.list(includeInactive === 'true');
  }

  @Get('types/:id')
  @RequirePermission('saf-001:read')
  async getType(@Param('id', ParseUUIDPipe) id: string): Promise<IncidentTypeDto> {
    return this.types.getById(id);
  }

  @Post('types')
  @RequirePermission('saf-001:admin')
  async createType(
    @Req() req: AuthedRequest,
    @Body() input: CreateIncidentTypeDto,
  ): Promise<IncidentTypeDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.types.create(input, actor);
  }

  @Patch('types/:id')
  @RequirePermission('saf-001:admin')
  async patchType(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: UpdateIncidentTypeDto,
  ): Promise<IncidentTypeDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.types.patch(id, input, actor);
  }

  // ---------- Procedures --------------------------------------------------

  @Get('procedures')
  @RequirePermission('saf-001:read')
  async listProcedures(
    @Query('includeInactive') includeInactive?: string,
  ): Promise<ProcedureDto[]> {
    return this.procedures.list(includeInactive === 'true');
  }

  @Get('procedures/by-type/:procedureType')
  @RequirePermission('saf-001:read')
  async getProcedureByType(
    @Param('procedureType') procedureType: ProcedureType,
  ): Promise<ProcedureDto> {
    return this.procedures.getByType(procedureType);
  }

  @Get('procedures/:id')
  @RequirePermission('saf-001:read')
  async getProcedure(@Param('id', ParseUUIDPipe) id: string): Promise<ProcedureDto> {
    return this.procedures.getById(id);
  }

  @Post('procedures')
  @RequirePermission('saf-001:admin')
  async createProcedure(
    @Req() req: AuthedRequest,
    @Body() input: CreateProcedureDto,
  ): Promise<ProcedureDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.procedures.create(input, actor);
  }

  @Patch('procedures/:id')
  @RequirePermission('saf-001:admin')
  async patchProcedure(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: UpdateProcedureDto,
  ): Promise<ProcedureDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.procedures.patch(id, input, actor);
  }

  // ---------- Timeline (immutable) ----------------------------------------

  @Get(':id/timeline')
  @RequirePermission('saf-001:read')
  async getTimeline(@Param('id', ParseUUIDPipe) id: string): Promise<TimelineEntryDto[]> {
    return this.timeline.listForIncident(id);
  }

  @Post(':id/timeline')
  @RequirePermission('saf-001:write')
  @ApiOperation({
    summary:
      'Append-only — service exposes no PATCH or DELETE for timeline entries (legal record per ADR-010).',
  })
  async appendTimeline(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: CreateTimelineEntryDto,
  ): Promise<TimelineEntryDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.timeline.append(id, input, actor);
  }

  // ---------- Accountability ---------------------------------------------

  @Get(':id/accountability')
  @RequirePermission('saf-001:read')
  async listAccountability(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AccountabilityRecordDto[]> {
    return this.accountability.listForIncident(id);
  }

  @Get(':id/accountability/summary')
  @RequirePermission('saf-001:read')
  async getAccountabilitySummary(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AccountabilitySummaryDto | null> {
    return this.accountability.getSummary(id);
  }

  @Patch('accountability/:recordId')
  @RequirePermission('saf-001:write')
  async patchAccountability(
    @Req() req: AuthedRequest,
    @Param('recordId', ParseUUIDPipe) recordId: string,
    @Body() input: UpdateAccountabilityDto,
  ): Promise<AccountabilityRecordDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.accountability.update(recordId, input, actor);
  }

  @Post(':id/accountability/bulk')
  @RequirePermission('saf-001:write')
  async bulkAccountability(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: BulkUpdateAccountabilityDto,
  ): Promise<{ updated: number }> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.accountability.bulkUpdate(id, input, actor);
  }

  // ---------- Reunification ------------------------------------------------

  @Get(':id/reunification')
  @RequirePermission('saf-001:read')
  async listReunification(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ReunificationRecordDto[]> {
    return this.reunification.listForIncident(id);
  }

  @Post(':id/reunification')
  @RequirePermission('saf-001:write')
  async createReunification(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: CreateReunificationDto,
  ): Promise<ReunificationRecordDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.reunification.create(id, input, actor);
  }

  @Post('reunification/:reunificationId/correct')
  @RequirePermission('saf-001:write')
  async correctReunification(
    @Req() req: AuthedRequest,
    @Param('reunificationId', ParseUUIDPipe) reunificationId: string,
    @Body() input: CorrectReunificationDto,
  ): Promise<ReunificationCorrectionDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.reunification.correct(reunificationId, input, actor);
  }

  // ---------- Drills -------------------------------------------------------

  @Get('drills/list')
  @RequirePermission('saf-004:read')
  async listDrills(@Query('status') status?: DrillStatus): Promise<DrillDto[]> {
    return this.drills.list(status);
  }

  @Get('drills/overdue')
  @RequirePermission('saf-004:read')
  async overdueDrills(): Promise<OverdueDrillDto[]> {
    return this.drills.overdue();
  }

  @Post('drills')
  @RequirePermission('saf-004:write')
  async createDrill(@Req() req: AuthedRequest, @Body() input: CreateDrillDto): Promise<DrillDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.drills.create(input, actor);
  }

  @Patch('drills/:id/complete')
  @RequirePermission('saf-004:write')
  async completeDrill(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: CompleteDrillDto,
  ): Promise<DrillDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.drills.complete(id, input, actor);
  }

  @Patch('drills/:id/cancel')
  @RequirePermission('saf-004:write')
  async cancelDrill(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: CancelDrillDto,
  ): Promise<DrillDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.drills.cancel(id, input, actor);
  }

  // ---------- Non-discipline incident reports -----------------------------

  @Get('reports/list')
  @RequirePermission('saf-003:read')
  async listReports(
    @Req() req: AuthedRequest,
    @Query() query: ListNonDisciplineQueryDto,
  ): Promise<NonDisciplineIncidentDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.nonDiscipline.list(query, actor);
  }

  @Get('reports/:id')
  @RequirePermission('saf-003:read')
  async getReport(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<NonDisciplineIncidentDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.nonDiscipline.getById(id, actor);
  }

  @Post('reports')
  @RequirePermission('saf-003:write')
  async createReport(
    @Req() req: AuthedRequest,
    @Body() input: CreateNonDisciplineDto,
  ): Promise<NonDisciplineIncidentDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.nonDiscipline.create(input, actor);
  }

  @Patch('reports/:id')
  @RequirePermission('saf-003:read')
  async patchReport(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: UpdateNonDisciplineDto,
  ): Promise<NonDisciplineIncidentDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.nonDiscipline.patch(id, input, actor);
  }
}
