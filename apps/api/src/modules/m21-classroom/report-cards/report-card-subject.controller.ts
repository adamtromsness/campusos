import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth';
import { ActorContextService } from '@modules/m00-platform';
import { ReportCardSubjectService } from './report-card-subject.service';
import {
  CreateReportCardSubjectDto,
  ReportCardSubjectResponseDto,
  UpdateReportCardSubjectDto,
} from './dto/report-card-subject.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Classroom Advanced — Report Card Subjects')
@ApiBearerAuth()
@Controller('classroom')
export class ReportCardSubjectController {
  constructor(
    private readonly subjects: ReportCardSubjectService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('report-cards/:id/subjects')
  @RequirePermission('tch-003:read')
  @ApiOperation({ summary: 'List subjects under a report card.' })
  async listForReportCard(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ReportCardSubjectResponseDto[]> {
    return this.subjects.listForReportCard(id);
  }

  @Post('report-cards/:id/subjects')
  @RequirePermission('tch-003:write')
  @ApiOperation({
    summary:
      'Add a subject to a report card. course_id is a soft FK to sis_courses — subject_label is the snapshot of record.',
  })
  async create(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateReportCardSubjectDto,
    @Req() req: AuthedRequest,
  ): Promise<ReportCardSubjectResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.subjects.create(id, body, actor);
  }

  @Get('report-card-subjects/:id')
  @RequirePermission('tch-003:read')
  @ApiOperation({ summary: 'Fetch a single report card subject row.' })
  async getById(@Param('id', ParseUUIDPipe) id: string): Promise<ReportCardSubjectResponseDto> {
    return this.subjects.getById(id);
  }

  @Patch('report-card-subjects/:id')
  @RequirePermission('tch-003:write')
  @ApiOperation({ summary: 'Update a report card subject row.' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateReportCardSubjectDto,
    @Req() req: AuthedRequest,
  ): Promise<ReportCardSubjectResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.subjects.update(id, body, actor);
  }

  @Delete('report-card-subjects/:id')
  @HttpCode(204)
  @RequirePermission('tch-003:write')
  @ApiOperation({ summary: 'Delete a report card subject row.' })
  async delete(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest): Promise<void> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.subjects.delete(id, actor);
  }
}
