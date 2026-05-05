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
import { MandatoryReportService } from './mandatory-report.service';
import {
  CreateMandatoryReportDto,
  ListMandatoryReportsQueryDto,
  MandatoryReportResponseDto,
  UpdateMandatoryReportDto,
} from './dto/counselling.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Counselling Mandatory Reports')
@ApiBearerAuth()
@Controller('counselling/mandatory-reports')
export class MandatoryReportController {
  constructor(
    private readonly reports: MandatoryReportService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('cou-006:read')
  @ApiOperation({
    summary:
      'List mandatory reports. Lead counsellor / admin sees all in school; reporter sees only own filed reports.',
  })
  async list(
    @Query() query: ListMandatoryReportsQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<MandatoryReportResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.reports.list(query, actor);
  }

  @Get(':id')
  @RequirePermission('cou-006:read')
  @ApiOperation({ summary: 'Fetch a single report. 404 to non-reporter non-admin.' })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<MandatoryReportResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.reports.getById(id, actor);
  }

  @Post()
  @RequirePermission('cou-006:write')
  @ApiOperation({
    summary:
      'File a new mandatory report. Any employee with cou-006:write can file — every staff member is a mandated reporter. Stamps reporter_person_id from actor.personId. status=FILED on creation.',
  })
  async create(
    @Body() body: CreateMandatoryReportDto,
    @Req() req: AuthedRequest,
  ): Promise<MandatoryReportResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.reports.create(body, actor);
  }

  @Patch(':id')
  @RequirePermission('cou-006:admin')
  @ApiOperation({
    summary:
      'Update mutable fields ONLY (status + cpsResponse). The core fields (description, reportType, reportedToAuthority, reportDate, supportingDocsS3Keys) are IMMUTABLE once filed — service refuses any change with 400.',
  })
  async patch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateMandatoryReportDto,
    @Req() req: AuthedRequest,
  ): Promise<MandatoryReportResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.reports.patch(id, body, actor);
  }
}
