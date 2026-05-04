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
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { NurseVisitService } from './nurse-visit.service';
import {
  CreateNurseVisitDto,
  ListNurseVisitsQueryDto,
  NurseVisitResponseDto,
  UpdateNurseVisitDto,
} from './dto/health.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Health Nurse Visits')
@ApiBearerAuth()
@Controller()
export class NurseVisitController {
  constructor(
    private readonly visits: NurseVisitService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('health/nurse-visits/roster')
  @RequirePermission('hlt-003:read')
  @ApiOperation({
    summary:
      'Live nurse-office roster — students/staff currently IN_PROGRESS. Hits the partial INDEX on (school_id, status) WHERE status=IN_PROGRESS. Nurse / counsellor / admin only.',
  })
  async roster(@Req() req: AuthedRequest): Promise<NurseVisitResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.visits.roster(actor);
  }

  @Get('health/students/:studentId/visits')
  @RequirePermission('hlt-001:read')
  @ApiOperation({
    summary:
      "Per-student visit history under hlt-001:read so parents (GUARDIAN row scope via assertCanReadStudentExternal) can view their own child's recent visits. Filters STUDENT visits only; STAFF visits live under the broader admin-only /health/nurse-visits path. Writes a VIEW_VISITS HIPAA audit row.",
  })
  async listForStudent(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Req() req: AuthedRequest,
  ): Promise<NurseVisitResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.visits.listForStudent(studentId, actor);
  }

  @Get('health/nurse-visits')
  @RequirePermission('hlt-003:read')
  @ApiOperation({
    summary:
      'List nurse visits with optional status / from / to filters. Newest first, capped at 500. Per-STUDENT visits write a VIEW_VISITS audit row (STAFF visits skip the audit since staff visits are not student PHI).',
  })
  async list(
    @Query() query: ListNurseVisitsQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<NurseVisitResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.visits.list(query, actor);
  }

  @Post('health/nurse-visits')
  @RequirePermission('hlt-003:write')
  @ApiOperation({
    summary:
      'Sign in a student or staff for a nurse visit. visitedPersonType defaults to STUDENT. Validates the soft polymorphic ref against sis_students or hr_employees per type. Stamps nurse_id from actor.employeeId; status starts IN_PROGRESS with signed_in_at = now().',
  })
  async create(
    @Body() body: CreateNurseVisitDto,
    @Req() req: AuthedRequest,
  ): Promise<NurseVisitResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.visits.create(body, actor);
  }

  @Patch('health/nurse-visits/:id')
  @RequirePermission('hlt-003:write')
  @ApiOperation({
    summary:
      'Update a nurse visit — treatment, parent notification, sent home, follow-up, or sign out. Locks the row FOR UPDATE inside a tenant transaction so signed_chk and sent_home_chk lockstep is atomic. signOut=true transitions IN_PROGRESS → COMPLETED stamping signed_out_at; sentHome=true stamps sent_home_at and emits hlth.nurse_visit.sent_home for the future Cycle 3 NotificationConsumer to fan out parent notifications.',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateNurseVisitDto,
    @Req() req: AuthedRequest,
  ): Promise<NurseVisitResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.visits.update(id, body, actor);
  }
}
