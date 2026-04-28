import {
  Body,
  Controller,
  Delete,
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
import { TimetableService } from './timetable.service';
import {
  CreateTimetableSlotDto,
  ListTimetableQueryDto,
  TimetableSlotResponseDto,
  UpdateTimetableSlotDto,
} from './dto/timetable.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Timetable')
@ApiBearerAuth()
@Controller('timetable')
export class TimetableController {
  constructor(
    private readonly timetable: TimetableService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('sch-001:read')
  @ApiOperation({ summary: 'List timetable slots — filterable by class, teacher, room, date' })
  async list(@Query() query: ListTimetableQueryDto): Promise<TimetableSlotResponseDto[]> {
    return this.timetable.list(query);
  }

  @Get('teacher/:employeeId')
  @RequirePermission('sch-001:read')
  @ApiOperation({ summary: "A teacher's timetable" })
  async forTeacher(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
  ): Promise<TimetableSlotResponseDto[]> {
    return this.timetable.listForTeacher(employeeId);
  }

  @Get('class/:classId')
  @RequirePermission('sch-001:read')
  @ApiOperation({ summary: "A class's schedule" })
  async forClass(
    @Param('classId', ParseUUIDPipe) classId: string,
  ): Promise<TimetableSlotResponseDto[]> {
    return this.timetable.listForClass(classId);
  }

  @Get('room/:roomId')
  @RequirePermission('sch-001:read')
  @ApiOperation({ summary: "A room's schedule" })
  async forRoom(
    @Param('roomId', ParseUUIDPipe) roomId: string,
  ): Promise<TimetableSlotResponseDto[]> {
    return this.timetable.listForRoom(roomId);
  }

  @Get('student/:studentId')
  @RequirePermission('stu-001:read')
  @ApiOperation({
    summary:
      "A student's weekly schedule. Row-scoped: caller must be admin, the student, " +
      "the student's guardian, or an assigned class teacher.",
  })
  async forStudent(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Req() req: AuthedRequest,
  ): Promise<TimetableSlotResponseDto[]> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.timetable.listForStudent(studentId, actor);
  }

  @Post('slots')
  @RequirePermission('sch-001:admin')
  @ApiOperation({
    summary:
      'Create a timetable slot (admin only). 409 Conflict on EXCLUSION violation; 400 on FK / dates failure.',
  })
  async create(
    @Body() body: CreateTimetableSlotDto,
    @Req() req: AuthedRequest,
  ): Promise<TimetableSlotResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.timetable.create(body, actor);
  }

  @Patch('slots/:id')
  @RequirePermission('sch-001:admin')
  @ApiOperation({ summary: 'Update a timetable slot (admin only)' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateTimetableSlotDto,
    @Req() req: AuthedRequest,
  ): Promise<TimetableSlotResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.timetable.update(id, body, actor);
  }

  @Delete('slots/:id')
  @RequirePermission('sch-001:admin')
  @ApiOperation({ summary: 'Delete a timetable slot (admin only)' })
  async delete(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<{ deleted: boolean }> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.timetable.delete(id, actor);
  }
}
