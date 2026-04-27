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
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { AssignmentService } from './assignment.service';
import {
  AssignmentResponseDto,
  CreateAssignmentDto,
  ListAssignmentsQueryDto,
  UpdateAssignmentDto,
} from './dto/assignment.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Classroom — Assignments')
@ApiBearerAuth()
@Controller()
export class AssignmentController {
  constructor(
    private readonly assignments: AssignmentService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('assignment-types')
  @RequirePermission('tch-002:read')
  @ApiOperation({
    summary:
      'List the school-wide assignment types (Homework, Quiz, Test, Project, Classwork). Used by ' +
      'the create-assignment form to populate the type dropdown.',
  })
  async listTypes(): Promise<
    Array<{ id: string; name: string; category: string; weightInCategory: number }>
  > {
    return this.assignments.listAssignmentTypes();
  }

  @Get('classes/:classId/assignments')
  @RequirePermission('tch-002:read')
  @ApiOperation({
    summary:
      'List assignments for a class. Teachers / admins see drafts when ?includeUnpublished=true; ' +
      'students/parents always see only published rows. Soft-deleted rows are hidden for everyone.',
  })
  async listForClass(
    @Param('classId', ParseUUIDPipe) classId: string,
    @Query() query: ListAssignmentsQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<AssignmentResponseDto[]> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.assignments.list(classId, query, actor);
  }

  @Get('assignments/:id')
  @RequirePermission('tch-002:read')
  @ApiOperation({ summary: 'Get a single assignment by id (row-scoped to the caller)' })
  async getOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<AssignmentResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.assignments.getById(id, actor);
  }

  @Post('classes/:classId/assignments')
  @RequirePermission('tch-002:write')
  @ApiOperation({
    summary:
      'Create an assignment in a class. Caller must be a teacher of the class or a school admin.',
  })
  async create(
    @Param('classId', ParseUUIDPipe) classId: string,
    @Body() body: CreateAssignmentDto,
    @Req() req: AuthedRequest,
  ): Promise<AssignmentResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.assignments.create(classId, body, actor);
  }

  @Patch('assignments/:id')
  @RequirePermission('tch-002:write')
  @ApiOperation({ summary: 'Update assignment fields (teacher-of-class or admin)' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateAssignmentDto,
    @Req() req: AuthedRequest,
  ): Promise<AssignmentResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.assignments.update(id, body, actor);
  }

  @Delete('assignments/:id')
  @RequirePermission('tch-002:write')
  @HttpCode(204)
  @ApiOperation({
    summary:
      'Soft-delete an assignment (sets deleted_at). Existing grades and submissions retain ' +
      'their FK target; list endpoints hide the row.',
  })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    await this.assignments.softDelete(id, actor);
  }
}
