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
import { RequirePermission } from '@shared/auth';
import { ActorContextService } from '@modules/m00-platform';
import { ExamSchedulingService } from './exam-scheduling.service';
import { CoTeachingService } from './coteaching.service';
import { PullOutService } from './pull-out.service';
import { CrossSchoolStaffService } from './cross-school-staff.service';
import { CoverArrangementService } from './cover-arrangement.service';
import {
  AddCoverClassDto,
  AddCoverSplitStudentsDto,
  AddExamRoomDto,
  AssignInvigilatorDto,
  AssignSeatDto,
  CoteachingResponseDto,
  CoverArrangementClassResponseDto,
  CoverArrangementResponseDto,
  CoverSplitStudentResponseDto,
  CreateCoteachingDto,
  CreateCoverArrangementDto,
  CreateCrossSchoolStaffDto,
  CreateExamSessionDto,
  CreatePullOutDto,
  CrossSchoolStaffResponseDto,
  ExamInvigilatorResponseDto,
  ExamRoomConflictDto,
  ExamRoomResponseDto,
  ExamSeatingResponseDto,
  ExamSessionResponseDto,
  PullOutResponseDto,
  UpdateCoteachingDto,
  UpdateCoverArrangementStatusDto,
  UpdateCrossSchoolStaffDto,
  UpdatePullOutDto,
} from './dto/scheduling-advanced-b.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

// ──────────────────────────────────────────────────────────────
// Exam scheduling
// ──────────────────────────────────────────────────────────────

@ApiTags('Scheduling — Exams')
@ApiBearerAuth()
@Controller('scheduling/exams')
export class ExamSchedulingController {
  constructor(
    private readonly service: ExamSchedulingService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('sch-001:read')
  @ApiOperation({ summary: 'List exam sessions for the current school.' })
  async list(): Promise<ExamSessionResponseDto[]> {
    return this.service.listSessions();
  }

  @Get(':id')
  @RequirePermission('sch-001:read')
  @ApiOperation({ summary: 'Get one exam session with inlined rooms + seatings + invigilators.' })
  async getOne(@Param('id', ParseUUIDPipe) id: string): Promise<ExamSessionResponseDto> {
    return this.service.getSession(id);
  }

  @Post()
  @RequirePermission('sch-001:admin')
  @ApiOperation({ summary: 'Create an exam session (admin only).' })
  async create(
    @Body() body: CreateExamSessionDto,
    @Req() req: AuthedRequest,
  ): Promise<ExamSessionResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.service.createSession(body, actor);
  }

  @Post(':id/rooms')
  @RequirePermission('sch-001:admin')
  @ApiOperation({ summary: 'Assign a room (with capacity) to the exam session.' })
  async addRoom(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AddExamRoomDto,
    @Req() req: AuthedRequest,
  ): Promise<ExamRoomResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.service.addRoom(id, body, actor);
  }

  @Get(':id/conflicts')
  @RequirePermission('sch-001:read')
  @ApiOperation({
    summary:
      'Detect room conflicts for the exam session via tstzrange overlap against active sch_timetable_slots plus CONFIRMED sch_room_bookings.',
  })
  async conflicts(@Param('id', ParseUUIDPipe) id: string): Promise<ExamRoomConflictDto[]> {
    return this.service.findRoomConflicts(id);
  }

  @Post(':id/seat')
  @RequirePermission('sch-001:admin')
  @ApiOperation({
    summary:
      'Assign a student to a seat. Auto-populates extra_time_minutes, separate_room, reader_required, scribe_required from sis_student_active_accommodations on accommodation_type strings EXTENDED_TIME, SEPARATE_LOCATION, READ_ALOUD, SCRIBE. Admin can override via explicit body fields.',
  })
  async seat(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AssignSeatDto,
    @Req() req: AuthedRequest,
  ): Promise<ExamSeatingResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.service.assignSeat(id, body, actor);
  }

  @Post(':id/invigilators')
  @RequirePermission('sch-001:admin')
  @ApiOperation({ summary: 'Assign an invigilator to a room within the exam session.' })
  async invigilator(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AssignInvigilatorDto,
    @Req() req: AuthedRequest,
  ): Promise<ExamInvigilatorResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.service.assignInvigilator(id, body, actor);
  }
}

// ──────────────────────────────────────────────────────────────
// Co-teaching
// ──────────────────────────────────────────────────────────────

@ApiTags('Scheduling — Co-Teaching')
@ApiBearerAuth()
@Controller('scheduling/co-teaching')
export class CoTeachingController {
  constructor(
    private readonly service: CoTeachingService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('sch-001:read')
  @ApiOperation({
    summary: 'List co-teaching arrangements. Optional ?slotId filters to a single timetable slot.',
  })
  async list(@Query('slotId') slotId?: string): Promise<CoteachingResponseDto[]> {
    return this.service.list(slotId);
  }

  @Get(':id')
  @RequirePermission('sch-001:read')
  async getOne(@Param('id', ParseUUIDPipe) id: string): Promise<CoteachingResponseDto> {
    return this.service.getById(id);
  }

  @Post()
  @RequirePermission('sch-001:admin')
  @ApiOperation({
    summary:
      'Create a co-teaching arrangement (admin only). Secondary teachers double-booking is service-layer relaxed for the matching slot — the primary teacher EXCLUSION on sch_timetable_slots is unchanged.',
  })
  async create(
    @Body() body: CreateCoteachingDto,
    @Req() req: AuthedRequest,
  ): Promise<CoteachingResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.service.create(body, actor);
  }

  @Patch(':id')
  @RequirePermission('sch-001:admin')
  async patch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateCoteachingDto,
    @Req() req: AuthedRequest,
  ): Promise<CoteachingResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.service.patch(id, body, actor);
  }

  @Delete(':id')
  @RequirePermission('sch-001:admin')
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<{ ok: true }> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    await this.service.remove(id, actor);
    return { ok: true };
  }
}

// ──────────────────────────────────────────────────────────────
// Pull-out interventions
// ──────────────────────────────────────────────────────────────

@ApiTags('Scheduling — Pull-Out Interventions')
@ApiBearerAuth()
@Controller('scheduling/pull-outs')
export class PullOutController {
  constructor(
    private readonly service: PullOutService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('sch-001:read')
  @ApiOperation({ summary: 'List pull-out interventions. Optional ?studentId filters.' })
  async list(@Query('studentId') studentId?: string): Promise<PullOutResponseDto[]> {
    return this.service.list(studentId);
  }

  @Get(':id')
  @RequirePermission('sch-001:read')
  async getOne(@Param('id', ParseUUIDPipe) id: string): Promise<PullOutResponseDto> {
    return this.service.getById(id);
  }

  @Post()
  @RequirePermission('sch-001:admin')
  @ApiOperation({
    summary:
      'Create a pull-out intervention (admin only). Pre-marks sis_attendance_records.status = PULL_OUT for every cadence-matching date in [start_date, end_date]. Returns the count in attendancePremarked.',
  })
  async create(
    @Body() body: CreatePullOutDto,
    @Req() req: AuthedRequest,
  ): Promise<PullOutResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.service.create(body, actor);
  }

  @Patch(':id')
  @RequirePermission('sch-001:admin')
  async patch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdatePullOutDto,
    @Req() req: AuthedRequest,
  ): Promise<PullOutResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.service.patch(id, body, actor);
  }
}

// ──────────────────────────────────────────────────────────────
// Cross-school staff
// ──────────────────────────────────────────────────────────────

@ApiTags('Scheduling — Cross-School Staff')
@ApiBearerAuth()
@Controller('scheduling/cross-school-staff')
export class CrossSchoolStaffController {
  constructor(
    private readonly service: CrossSchoolStaffService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('sch-001:read')
  async list(): Promise<CrossSchoolStaffResponseDto[]> {
    return this.service.list();
  }

  @Get(':id')
  @RequirePermission('sch-001:read')
  async getOne(@Param('id', ParseUUIDPipe) id: string): Promise<CrossSchoolStaffResponseDto> {
    return this.service.getById(id);
  }

  @Post()
  @RequirePermission('sch-001:admin')
  @ApiOperation({
    summary:
      'Create a cross-school staff assignment. Person-level EXCLUSION on (person_id daterange) prevents the same iam_person from overlapping cross-school windows in this tenant.',
  })
  async create(
    @Body() body: CreateCrossSchoolStaffDto,
    @Req() req: AuthedRequest,
  ): Promise<CrossSchoolStaffResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.service.create(body, actor);
  }

  @Patch(':id')
  @RequirePermission('sch-001:admin')
  async patch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateCrossSchoolStaffDto,
    @Req() req: AuthedRequest,
  ): Promise<CrossSchoolStaffResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.service.patch(id, body, actor);
  }
}

// ──────────────────────────────────────────────────────────────
// Cover arrangements
// ──────────────────────────────────────────────────────────────

@ApiTags('Scheduling — Cover Arrangements')
@ApiBearerAuth()
@Controller('scheduling/cover')
export class CoverArrangementController {
  constructor(
    private readonly service: CoverArrangementService,
    private readonly actors: ActorContextService,
  ) {}

  @Get(':date/board')
  @RequirePermission('sch-004:read')
  @ApiOperation({
    summary:
      'Cover board for a date — all arrangements grouped under absent teacher with per-class disposition + split assignments.',
  })
  async board(@Param('date') date: string): Promise<CoverArrangementResponseDto[]> {
    return this.service.listForDate(date);
  }

  @Get(':id')
  @RequirePermission('sch-004:read')
  async getOne(@Param('id', ParseUUIDPipe) id: string): Promise<CoverArrangementResponseDto> {
    return this.service.getById(id);
  }

  @Post()
  @RequirePermission('sch-004:write')
  async create(
    @Body() body: CreateCoverArrangementDto,
    @Req() req: AuthedRequest,
  ): Promise<CoverArrangementResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.service.create(body, actor);
  }

  @Patch(':id/status')
  @RequirePermission('sch-004:write')
  async patchStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateCoverArrangementStatusDto,
    @Req() req: AuthedRequest,
  ): Promise<CoverArrangementResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.service.patchStatus(id, body, actor);
  }

  @Post(':id/classes')
  @RequirePermission('sch-004:write')
  async addClass(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AddCoverClassDto,
    @Req() req: AuthedRequest,
  ): Promise<CoverArrangementClassResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.service.addClass(id, body, actor);
  }

  @Post('classes/:id/split-students')
  @RequirePermission('sch-004:write')
  async addSplitStudents(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AddCoverSplitStudentsDto,
    @Req() req: AuthedRequest,
  ): Promise<CoverSplitStudentResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.service.addSplitStudents(id, body, actor);
  }
}
