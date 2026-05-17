import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth';
import { ActorContextService } from '@modules/m00-platform';
import { CheckinService } from './checkin.service';
import { CheckinResponseDto, ListCheckinsQueryDto, SubmitCheckinDto } from './dto/wellbeing.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Wellbeing Check-Ins')
@ApiBearerAuth()
@Controller('counselling/wellbeing')
export class CheckinController {
  constructor(
    private readonly checkins: CheckinService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('checkins')
  @RequirePermission('cou-004:read')
  @ApiOperation({
    summary:
      'List check-ins with row-scope per persona. Admin sees all; counsellor sees caseload-linked students; student sees own; teacher sees the same rows but with student identity + assigned counsellor + flagged status stripped (the aggregated trends contract). Filters: pending=true|false, flagged=true, deploymentId, studentId.',
  })
  async list(
    @Query() query: ListCheckinsQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<CheckinResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.checkins.list(query, actor);
  }

  @Get('checkins/:id')
  @RequirePermission('cou-004:read')
  @ApiOperation({
    summary:
      'Fetch a check-in with responses inlined. Admin / counsellor / student paths only — teachers 403 at the service layer with a redirect to the aggregated-trends surface.',
  })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<CheckinResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.checkins.getById(id, actor);
  }

  @Post('checkins/:id/submit')
  @RequirePermission('cou-004:read')
  @ApiOperation({
    summary:
      'STUDENT-FACING KEYSTONE — submit responses to a PENDING check-in. The student answers every template question (the service refuses partial submissions). Bulk-INSERTs responses inside one tenant tx, stamps completed_at, runs alert evaluation (SELF_HARM_INDICATOR / FEELS_UNSAFE / WANTS_TO_TALK), inserts alert rows, bumps the deployment total_completed counter, then emits svc.wellbeing.alert.created per fired alert. Row scope: students may only submit their own check-ins; admins may submit on behalf for testing. Counsellors are NOT a submitter — they triage alerts but do not answer questions on a student behalf.',
  })
  async submit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SubmitCheckinDto,
    @Req() req: AuthedRequest,
  ): Promise<CheckinResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.checkins.submit(id, body, actor);
  }
}
