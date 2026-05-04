import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { HealthRecordService } from './health-record.service';
import {
  CreateHealthRecordDto,
  HealthRecordResponseDto,
  ImmunisationComplianceRowDto,
  UpdateHealthRecordDto,
} from './dto/health.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Health Records')
@ApiBearerAuth()
@Controller()
export class HealthRecordController {
  constructor(
    private readonly records: HealthRecordService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('health/students/:studentId')
  @RequirePermission('hlt-001:read')
  @ApiOperation({
    summary:
      'Full health record for a student with inlined conditions and immunisations. Row-scoped: nurse/admin see all + every field; teachers (STAFF non-manager) see students in their classes with management_plan, physician contact, and immunisations stripped; parents see own children with management_plan and emergency_medical_notes stripped; students 403 at the gate. Writes a VIEW_RECORD row to hlth_health_access_log before returning.',
  })
  async getRecord(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Req() req: AuthedRequest,
  ): Promise<HealthRecordResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.records.getFullRecord(studentId, actor);
  }

  @Post('health/students/:studentId')
  @RequirePermission('hlt-001:write')
  @ApiOperation({
    summary:
      'Create a new health record for a student. Nurse / admin only at the service layer (isSchoolAdmin OR holds hlt-001:write). UNIQUE on student_id rejects duplicates with a friendly 400.',
  })
  async create(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Body() body: CreateHealthRecordDto,
    @Req() req: AuthedRequest,
  ): Promise<HealthRecordResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.records.create(studentId, body, actor);
  }

  @Patch('health/students/:studentId')
  @RequirePermission('hlt-001:write')
  @ApiOperation({
    summary:
      'Update an existing health record by student id. Field-by-field — non-supplied fields are left untouched. Nurse / admin only.',
  })
  async update(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Body() body: UpdateHealthRecordDto,
    @Req() req: AuthedRequest,
  ): Promise<HealthRecordResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.records.update(studentId, body, actor);
  }

  @Get('health/immunisation-compliance')
  @RequirePermission('hlt-001:admin')
  @ApiOperation({
    summary:
      'School-wide immunisation compliance dashboard. Admin-only. Returns one row per vaccine_name with CURRENT / OVERDUE / WAIVED counts across the school. Sorted by overdue_count DESC so the admin queue surfaces the most-overdue vaccines first.',
  })
  async compliance(@Req() req: AuthedRequest): Promise<ImmunisationComplianceRowDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.records.getImmunisationCompliance(actor);
  }
}
