import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { PermissionCheckService } from '../iam/permission-check.service';
import { AttendanceService } from './attendance.service';
import { AbsenceRequestService } from './absence-request.service';
import {
  AttendanceRecordDto,
  BatchSubmitAttendanceDto,
  BatchSubmitResultDto,
  GetClassAttendanceQueryDto,
  GetStudentAttendanceQueryDto,
  MarkAttendanceDto,
} from './dto/attendance.dto';
import {
  AbsenceRequestResponseDto,
  CreateAbsenceRequestDto,
  ListAbsenceRequestsQueryDto,
  ReviewAbsenceRequestDto,
} from './dto/absence-request.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Attendance')
@ApiBearerAuth()
@Controller()
export class AttendanceController {
  constructor(
    private readonly attendance: AttendanceService,
    private readonly absences: AbsenceRequestService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  // ── Class attendance (read + mark + submit) ──────────────────────

  @Get('classes/:id/attendance/:date')
  @RequirePermission('att-001:read')
  @ApiOperation({ summary: "Class roster + attendance for a date. Lazily pre-populates PRESENT/PRE_POPULATED rows when 'period' is supplied." })
  async classAttendance(
    @Param('id', ParseUUIDPipe) classId: string,
    @Param('date') date: string,
    @Query() query: GetClassAttendanceQueryDto,
  ): Promise<AttendanceRecordDto[]> {
    return this.attendance.getClassAttendance(classId, date, query.period);
  }

  @Patch('attendance/:id')
  @RequirePermission('att-001:write')
  @ApiOperation({ summary: 'Mark a single attendance record (status + optional note). Emits att.attendance.marked and, on TARDY/ABSENT, the corresponding student-marked event.' })
  async markOne(
    @Param('id', ParseUUIDPipe) recordId: string,
    @Body() body: MarkAttendanceDto,
    @Req() req: AuthedRequest,
  ): Promise<AttendanceRecordDto> {
    return this.attendance.markIndividual(recordId, body, req.user!.sub);
  }

  @Post('classes/:id/attendance/:date/batch')
  @RequirePermission('att-001:write')
  @ApiOperation({ summary: 'Confirm a class period in one shot. Sends exception list (omitted students treated as PRESENT). Emits att.attendance.confirmed.' })
  async batchSubmit(
    @Param('id', ParseUUIDPipe) classId: string,
    @Param('date') date: string,
    @Body() body: BatchSubmitAttendanceDto,
    @Req() req: AuthedRequest,
  ): Promise<BatchSubmitResultDto> {
    return this.attendance.batchSubmit(classId, date, body.period, body.records, req.user!.sub);
  }

  // ── Student attendance history ──────────────────────────────────

  @Get('students/:id/attendance')
  @RequirePermission('att-001:read')
  @ApiOperation({ summary: 'Attendance history for a student (defaults to all dates; filterable by fromDate/toDate).' })
  async studentAttendance(
    @Param('id', ParseUUIDPipe) studentId: string,
    @Query() query: GetStudentAttendanceQueryDto,
  ): Promise<AttendanceRecordDto[]> {
    return this.attendance.getStudentAttendance(studentId, query.fromDate, query.toDate);
  }

  // ── Absence requests ────────────────────────────────────────────

  @Post('absence-requests')
  @RequirePermission('att-004:write')
  @ApiOperation({ summary: 'Submit an absence request. SAME_DAY_REPORT auto-approves; ADVANCE_REQUEST queues for admin review.' })
  async submitAbsence(
    @Body() body: CreateAbsenceRequestDto,
    @Req() req: AuthedRequest,
  ): Promise<AbsenceRequestResponseDto> {
    var isAdmin = await this.callerIsAdmin(req);
    return this.absences.create(req.user!.sub, req.user!.personId, body, isAdmin);
  }

  @Get('absence-requests')
  @RequirePermission('att-004:read')
  @ApiOperation({ summary: 'List absence requests. Non-admin callers see only their own submissions; admins see all (filterable).' })
  async listAbsences(
    @Query() query: ListAbsenceRequestsQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<AbsenceRequestResponseDto[]> {
    var isAdmin = await this.callerIsAdmin(req);
    return this.absences.list(req.user!.sub, query, isAdmin);
  }

  @Get('absence-requests/:id')
  @RequirePermission('att-004:read')
  @ApiOperation({ summary: 'Get a single absence request. Non-admin callers can only view their own submissions.' })
  async getAbsence(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<AbsenceRequestResponseDto> {
    var isAdmin = await this.callerIsAdmin(req);
    return this.absences.getById(id, req.user!.sub, isAdmin);
  }

  @Patch('absence-requests/:id')
  @RequirePermission('att-004:admin')
  @ApiOperation({ summary: 'Review a pending absence request (APPROVE or REJECT). Admin only.' })
  async reviewAbsence(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReviewAbsenceRequestDto,
    @Req() req: AuthedRequest,
  ): Promise<AbsenceRequestResponseDto> {
    return this.absences.review(id, req.user!.sub, body);
  }

  /**
   * "Admin" for absence-request scoping = any user with att-004:admin in the
   * current scope chain. We piggy-back on PermissionCheckService rather than
   * re-walking the cache here. School Admin and Platform Admin both pass.
   */
  private async callerIsAdmin(req: AuthedRequest): Promise<boolean> {
    var account = req.user?.sub;
    if (!account) return false;
    return this.permCheck.hasAnyPermissionAcrossScopes(account, ['att-004:admin']);
  }
}
