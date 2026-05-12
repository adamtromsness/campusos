import { Body, Controller, Get, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { SubjectChoiceService } from './subject-choice.service';
import {
  CreateSubjectChoiceWindowDto,
  SubjectChoiceDemandRowDto,
  SubjectChoiceResponseDto,
  SubjectChoiceWindowResponseDto,
  SubmitSubjectChoiceDto,
} from './dto/scheduling-advanced.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Scheduling — Subject Choices')
@ApiBearerAuth()
@Controller('scheduling/subject-choices')
export class SubjectChoiceController {
  constructor(
    private readonly choices: SubjectChoiceService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('sch-002:read')
  @ApiOperation({
    summary:
      "List subject choices. Admin / STAFF see all. STUDENT / GUARDIAN see own / linked children's choices.",
  })
  async list(
    @Req() req: AuthedRequest,
    @Query('studentId') studentId?: string,
    @Query('academicYearId') academicYearId?: string,
    @Query('courseId') courseId?: string,
  ): Promise<SubjectChoiceResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.choices.list(actor, { studentId, academicYearId, courseId });
  }

  @Post()
  @RequirePermission('sch-002:write')
  @ApiOperation({
    summary:
      'Submit a subject choice. Students submit own; guardians submit for own children; admin/staff override.',
  })
  async submit(
    @Body() body: SubmitSubjectChoiceDto,
    @Req() req: AuthedRequest,
  ): Promise<SubjectChoiceResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.choices.submit(body, actor);
  }

  @Get('demand')
  @RequirePermission('sch-002:read')
  @ApiOperation({
    summary:
      'Demand matrix — course × total students submitted for the supplied academicYearId. Admin / STAFF only.',
  })
  async demand(
    @Query('academicYearId', new ParseUUIDPipe()) academicYearId: string,
    @Req() req: AuthedRequest,
  ): Promise<SubjectChoiceDemandRowDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.choices.demand(academicYearId, actor);
  }
}

@ApiTags('Scheduling — Subject Choice Windows')
@ApiBearerAuth()
@Controller('scheduling/subject-choice-windows')
export class SubjectChoiceWindowController {
  constructor(
    private readonly choices: SubjectChoiceService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('sch-002:read')
  @ApiOperation({ summary: 'List subject choice windows for the current school.' })
  async list(): Promise<SubjectChoiceWindowResponseDto[]> {
    return this.choices.listWindows();
  }

  @Post()
  @RequirePermission('sch-002:admin')
  @ApiOperation({ summary: 'Create a subject choice window (admin only).' })
  async create(
    @Body() body: CreateSubjectChoiceWindowDto,
    @Req() req: AuthedRequest,
  ): Promise<SubjectChoiceWindowResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.choices.createWindow(body, actor);
  }
}
