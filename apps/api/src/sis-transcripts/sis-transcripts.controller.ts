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
import { LockerService } from './locker.service';
import { MedicalExemptionService } from './medical-exemption.service';
import { ReportingPeriodService } from './reporting-period.service';
import { StudentAwardService } from './student-award.service';
import { TranscriptService } from './transcript.service';
import { TransferService } from './transfer.service';
import {
  AssignLockerDto,
  BulkClearLockersDto,
  BulkHonorRollDto,
  CreateLockerDto,
  CreateMedicalExemptionDto,
  CreateReportingPeriodDto,
  CreateStudentAwardDto,
  CreateTransferRecordDto,
  GenerateTranscriptDto,
  PatchMedicalExemptionDto,
  PatchReportingPeriodStatusDto,
  PatchTranscriptRequestStatusDto,
  PatchTranscriptStatusDto,
  PatchTransferRecordDto,
  SubmitTranscriptRequestDto,
} from './dto/sis-transcripts.dto';

interface AuthedRequest extends Request {
  user?: {
    sub: string;
    personId: string;
    email: string;
    displayName: string;
    sessionId: string;
  };
}

@ApiTags('SIS Transcripts')
@ApiBearerAuth()
@Controller()
export class SisTranscriptsController {
  constructor(
    private readonly transcripts: TranscriptService,
    private readonly transfers: TransferService,
    private readonly lockers: LockerService,
    private readonly reportingPeriods: ReportingPeriodService,
    private readonly awards: StudentAwardService,
    private readonly exemptions: MedicalExemptionService,
    private readonly actors: ActorContextService,
  ) {}

  private async resolveActor(req: AuthedRequest) {
    if (!req.user) throw new Error('Unauthenticated request reached SisTranscripts controller');
    return this.actors.resolveActor(req.user.sub, req.user.personId);
  }

  // ─── Transcripts (STU-005) ───

  @Get('sis/students/:id/transcripts')
  @RequirePermission('stu-005:read')
  @ApiOperation({
    summary: 'List transcripts for a student. Frozen snapshot — never live-joined to cls_grades.',
  })
  async listTranscripts(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    return this.transcripts.listForStudent(id, await this.resolveActor(req));
  }

  @Get('sis/transcripts/:id')
  @RequirePermission('stu-005:read')
  @ApiOperation({ summary: 'Get a transcript with its frozen course snapshot.' })
  async getTranscript(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    return this.transcripts.getById(id, await this.resolveActor(req));
  }

  @Post('sis/students/:id/transcripts/generate')
  @RequirePermission('stu-005:write')
  @ApiOperation({
    summary:
      'Generate a transcript — snapshots every published cls_grades row joined to sis_classes plus sis_courses into sis_transcript_courses. Rows are immutable after generation.',
  })
  async generateTranscript(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: GenerateTranscriptDto,
    @Req() req: AuthedRequest,
  ) {
    return this.transcripts.generate(id, dto, await this.resolveActor(req));
  }

  @Patch('sis/transcripts/:id/status')
  @RequirePermission('stu-005:write')
  @ApiOperation({ summary: 'Advance the transcript lifecycle GENERATED -> SENT -> REVOKED.' })
  async patchTranscriptStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PatchTranscriptStatusDto,
    @Req() req: AuthedRequest,
  ) {
    return this.transcripts.patchStatus(id, dto, await this.resolveActor(req));
  }

  @Post('sis/transcript-requests')
  @RequirePermission('stu-005:read')
  @ApiOperation({
    summary:
      'Parent or student submits a transcript request. When feeAmount is set TranscriptService creates a matching pay_invoice for the family account so the family pays through the standard billing flow.',
  })
  async submitTranscriptRequest(
    @Body() dto: SubmitTranscriptRequestDto,
    @Req() req: AuthedRequest,
  ) {
    return this.transcripts.submitRequest(dto, await this.resolveActor(req));
  }

  @Get('sis/transcript-requests')
  @RequirePermission('stu-005:read')
  @ApiOperation({
    summary:
      'List transcript requests. Admin / staff sees the school queue. Parent / student sees own scope only.',
  })
  async listTranscriptRequests(
    @Req() req: AuthedRequest,
    @Query('studentId') studentId?: string,
    @Query('status') status?: string,
  ) {
    return this.transcripts.listRequests({ studentId, status }, await this.resolveActor(req));
  }

  @Get('sis/transcript-requests/:id')
  @RequirePermission('stu-005:read')
  @ApiOperation({ summary: 'Get a single transcript request.' })
  async getTranscriptRequest(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    return this.transcripts.getRequestById(id, await this.resolveActor(req));
  }

  @Patch('sis/transcript-requests/:id/status')
  @RequirePermission('stu-005:write')
  @ApiOperation({
    summary:
      'Advance a transcript request through the SUBMITTED -> PROCESSING -> SENT / PICKED_UP -> CANCELLED graph. Cancellations require a cancelReason.',
  })
  async patchTranscriptRequestStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PatchTranscriptRequestStatusDto,
    @Req() req: AuthedRequest,
  ) {
    return this.transcripts.patchRequestStatus(id, dto, await this.resolveActor(req));
  }

  // ─── Transfers (STU-004) ───

  @Get('sis/students/:id/transfers')
  @RequirePermission('stu-004:read')
  @ApiOperation({ summary: 'List transfer records for a student.' })
  async listStudentTransfers(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    return this.transfers.listForStudent(id, await this.resolveActor(req));
  }

  @Get('sis/transfers')
  @RequirePermission('stu-004:read')
  @ApiOperation({ summary: 'School-wide transfer records — admin / staff only.' })
  async listTransfers(
    @Req() req: AuthedRequest,
    @Query('direction') direction?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ) {
    return this.transfers.list({ direction, fromDate, toDate }, await this.resolveActor(req));
  }

  @Get('sis/transfers/:id')
  @RequirePermission('stu-004:read')
  @ApiOperation({ summary: 'Get a transfer record.' })
  async getTransfer(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    return this.transfers.getById(id, await this.resolveActor(req));
  }

  @Post('sis/transfers')
  @RequirePermission('stu-004:write')
  @ApiOperation({ summary: 'Record an incoming or outgoing transfer.' })
  async createTransfer(@Body() dto: CreateTransferRecordDto, @Req() req: AuthedRequest) {
    return this.transfers.create(dto, await this.resolveActor(req));
  }

  @Patch('sis/transfers/:id')
  @RequirePermission('stu-004:write')
  @ApiOperation({
    summary:
      'Update a transfer record — typically used to flip records_received / records_sent and attach the records package S3 key.',
  })
  async patchTransfer(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PatchTransferRecordDto,
    @Req() req: AuthedRequest,
  ) {
    return this.transfers.patch(id, dto, await this.resolveActor(req));
  }

  // ─── Lockers (STU-007) ───

  @Get('sis/lockers')
  @RequirePermission('stu-007:read')
  @ApiOperation({
    summary:
      'Admin / staff list of every locker. Combinations are never returned on the list view — hasCombination flag tells the UI whether a combination is on file.',
  })
  async listLockers(@Req() req: AuthedRequest, @Query('status') status?: string) {
    return this.lockers.list({ status }, await this.resolveActor(req));
  }

  @Post('sis/lockers')
  @RequirePermission('stu-007:write')
  @ApiOperation({ summary: 'Create a locker in AVAILABLE status.' })
  async createLocker(@Body() dto: CreateLockerDto, @Req() req: AuthedRequest) {
    return this.lockers.create(dto, await this.resolveActor(req));
  }

  @Post('sis/lockers/assign')
  @RequirePermission('stu-007:write')
  @ApiOperation({
    summary:
      'Assign a locker to a student. Generates the combination when not supplied. Returns the plaintext combination once — the DB only stores AES-256-GCM ciphertext.',
  })
  async assignLocker(@Body() dto: AssignLockerDto, @Req() req: AuthedRequest) {
    return this.lockers.assign(dto, await this.resolveActor(req));
  }

  @Post('sis/lockers/:id/release')
  @RequirePermission('stu-007:write')
  @ApiOperation({
    summary:
      'Release an ASSIGNED locker. Clears assigned_to_student_id + assigned_at + academic_year + combination_encrypted atomically.',
  })
  async releaseLocker(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    return this.lockers.release(id, await this.resolveActor(req));
  }

  @Post('sis/lockers/bulk-clear')
  @RequirePermission('stu-007:admin')
  @ApiOperation({
    summary:
      'Year-end bulk clear — release every ASSIGNED locker in the school in one transaction. Pass academicYear to scope the clear to a single year.',
  })
  async bulkClearLockers(@Body() dto: BulkClearLockersDto, @Req() req: AuthedRequest) {
    return this.lockers.bulkClear(dto, await this.resolveActor(req));
  }

  @Post('sis/lockers/:id/out-of-service')
  @RequirePermission('stu-007:write')
  @ApiOperation({ summary: 'Mark a locker OUT_OF_SERVICE.' })
  async outOfService(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    return this.lockers.markOutOfService(id, await this.resolveActor(req));
  }

  @Post('sis/lockers/:id/available')
  @RequirePermission('stu-007:write')
  @ApiOperation({ summary: 'Flip an OUT_OF_SERVICE locker back to AVAILABLE.' })
  async backInService(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    return this.lockers.markAvailable(id, await this.resolveActor(req));
  }

  @Get('sis/students/:id/locker')
  @RequirePermission('stu-007:read')
  @ApiOperation({
    summary:
      'Own-locker view for a student. Returns the decrypted combination. Row scope — only the owning student, linked guardian, or staff / admin may resolve.',
  })
  async getStudentLocker(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    return this.lockers.getStudentLocker(id, await this.resolveActor(req));
  }

  // ─── Reporting Periods (STU-005) ───

  @Get('sis/reporting-periods')
  @RequirePermission('stu-005:read')
  @ApiOperation({ summary: 'List reporting periods.' })
  async listReportingPeriods() {
    return this.reportingPeriods.list();
  }

  @Get('sis/reporting-periods/current')
  @RequirePermission('stu-005:read')
  @ApiOperation({
    summary: 'Current OPEN reporting period for the school. Null when none is OPEN.',
  })
  async currentReportingPeriod() {
    return this.reportingPeriods.current();
  }

  @Get('sis/reporting-periods/:id')
  @RequirePermission('stu-005:read')
  @ApiOperation({ summary: 'Get a reporting period.' })
  async getReportingPeriod(@Param('id', ParseUUIDPipe) id: string) {
    return this.reportingPeriods.getById(id);
  }

  @Post('sis/reporting-periods')
  @RequirePermission('stu-005:admin')
  @ApiOperation({ summary: 'Admin — create a reporting period in UPCOMING status.' })
  async createReportingPeriod(@Body() dto: CreateReportingPeriodDto, @Req() req: AuthedRequest) {
    return this.reportingPeriods.create(dto, await this.resolveActor(req));
  }

  @Patch('sis/reporting-periods/:id/status')
  @RequirePermission('stu-005:admin')
  @ApiOperation({
    summary:
      'Admin — advance the reporting period status. Strict transition graph UPCOMING -> OPEN -> GRADING_CLOSED -> PUBLISHED. No skipping forward, no walking backward.',
  })
  async patchReportingPeriodStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PatchReportingPeriodStatusDto,
    @Req() req: AuthedRequest,
  ) {
    return this.reportingPeriods.patchStatus(id, dto, await this.resolveActor(req));
  }

  // ─── Awards (STU-005) ───

  @Get('sis/students/:id/awards')
  @RequirePermission('stu-005:read')
  @ApiOperation({ summary: 'List awards for a student.' })
  async listStudentAwards(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    return this.awards.listForStudent(id, await this.resolveActor(req));
  }

  @Post('sis/awards')
  @RequirePermission('stu-005:write')
  @ApiOperation({ summary: 'Award a student.' })
  async createAward(@Body() dto: CreateStudentAwardDto, @Req() req: AuthedRequest) {
    return this.awards.create(dto, await this.resolveActor(req));
  }

  @Post('sis/awards/bulk-honor-roll')
  @RequirePermission('stu-005:write')
  @ApiOperation({
    summary:
      'Auto-generate Honor Roll awards for every student in the school whose GPA snapshot meets the threshold. Idempotent — students already holding the matching Honor Roll for (academic_year, term) are skipped.',
  })
  async bulkHonorRoll(@Body() dto: BulkHonorRollDto, @Req() req: AuthedRequest) {
    return this.awards.bulkHonorRoll(dto, await this.resolveActor(req));
  }

  @Delete('sis/awards/:id')
  @RequirePermission('stu-005:write')
  @ApiOperation({ summary: 'Delete an award.' })
  async deleteAward(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    await this.awards.delete(id, await this.resolveActor(req));
    return { deleted: true };
  }

  // ─── Medical Exemptions (STU-001) ───

  @Get('sis/students/:id/medical-exemptions')
  @RequirePermission('stu-001:read')
  @ApiOperation({ summary: 'List medical exemptions for a student.' })
  async listStudentExemptions(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    return this.exemptions.listForStudent(id, await this.resolveActor(req));
  }

  @Post('sis/medical-exemptions')
  @RequirePermission('stu-001:write')
  @ApiOperation({ summary: 'Record a medical exemption.' })
  async createExemption(@Body() dto: CreateMedicalExemptionDto, @Req() req: AuthedRequest) {
    return this.exemptions.create(dto, await this.resolveActor(req));
  }

  @Patch('sis/medical-exemptions/:id')
  @RequirePermission('stu-001:write')
  @ApiOperation({ summary: 'Update a medical exemption.' })
  async patchExemption(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PatchMedicalExemptionDto,
    @Req() req: AuthedRequest,
  ) {
    return this.exemptions.patch(id, dto, await this.resolveActor(req));
  }

  @Delete('sis/medical-exemptions/:id')
  @RequirePermission('stu-001:write')
  @ApiOperation({ summary: 'Delete a medical exemption.' })
  async deleteExemption(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    await this.exemptions.delete(id, await this.resolveActor(req));
    return { deleted: true };
  }
}
