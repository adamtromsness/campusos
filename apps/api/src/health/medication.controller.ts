import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { MedicationService } from './medication.service';
import { CreateMedicationDto, MedicationResponseDto, UpdateMedicationDto } from './dto/health.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Health Medications')
@ApiBearerAuth()
@Controller()
export class MedicationController {
  constructor(
    private readonly medications: MedicationService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('health/students/:studentId/medications')
  @RequirePermission('hlt-001:read')
  @ApiOperation({
    summary:
      'List medications for a student with inlined schedule slots. Nurse / admin / parent only at the service layer; teachers receive 403 because medication info is not classroom-relevant (life-threatening allergies surface via the Step 5 health record stripped DTO instead). Writes a VIEW_MEDICATIONS row to hlth_health_access_log.',
  })
  async list(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Req() req: AuthedRequest,
  ): Promise<MedicationResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.medications.listForStudent(studentId, actor);
  }

  @Post('health/students/:studentId/medications')
  @RequirePermission('hlt-002:write')
  @ApiOperation({
    summary:
      "Add a medication to a student's health record. Nurse / admin only (HLT-002:write — narrower than HLT-001:write so a counsellor or admin assistant who manages records cannot prescribe medications without explicit nurse scope, even though the seed currently grants both to the Staff role).",
  })
  async create(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Body() body: CreateMedicationDto,
    @Req() req: AuthedRequest,
  ): Promise<MedicationResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.medications.create(studentId, body, actor);
  }

  @Patch('health/medications/:id')
  @RequirePermission('hlt-002:write')
  @ApiOperation({
    summary:
      'Update a medication. Nurse / admin only. Set is_active=false to retire a medication while preserving the historical row for the dose log.',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateMedicationDto,
    @Req() req: AuthedRequest,
  ): Promise<MedicationResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.medications.update(id, body, actor);
  }
}
