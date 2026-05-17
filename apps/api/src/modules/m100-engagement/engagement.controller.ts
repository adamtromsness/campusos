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
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '@shared/auth';
import { ActorContextService, type ResolvedActor } from '@modules/m00-platform';
import type { Request } from 'express';
import {
  BookSlotDto,
  CancelBookingDto,
  CreateConferenceEventDto,
  CreateSurveyDto,
  GenerateSlotsDto,
  SubmitSurveyResponseDto,
  UpdateBookingDto,
  UpdateConferenceEventDto,
  UpdateScoreConfigDto,
  UpdateSlotDto,
  UpdateSurveyDto,
  type EngagementLevel,
} from './dto/engagement.dto';
import { ConferenceEventService } from './conference-event.service';
import { ConferenceSlotService } from './conference-slot.service';
import { ConferenceBookingService } from './conference-booking.service';
import { EngagementScoreService } from './engagement-score.service';
import { ParentSurveyService } from './parent-survey.service';

interface AuthRequest extends Request {
  user?: { accountId: string; personId: string };
}

@ApiTags('Parent Engagement')
@Controller('engagement')
export class EngagementController {
  constructor(
    private readonly actorContext: ActorContextService,
    private readonly events: ConferenceEventService,
    private readonly slots: ConferenceSlotService,
    private readonly bookings: ConferenceBookingService,
    private readonly scores: EngagementScoreService,
    private readonly surveys: ParentSurveyService,
  ) {}

  private async resolve(req: AuthRequest): Promise<ResolvedActor> {
    return this.actorContext.resolveActor(req.user!.accountId, req.user!.personId);
  }

  // ── Conference Events ──────────────────────────────────────────

  @Get('conferences')
  @RequirePermission('mtg-002:read')
  @ApiOperation({ summary: 'List conference events (parents see published only)' })
  async listConferences(@Req() req: AuthRequest, @Query('status') status?: string) {
    return this.events.list(await this.resolve(req), status);
  }

  @Get('conferences/:id')
  @RequirePermission('mtg-002:read')
  @ApiOperation({ summary: 'Read a conference event' })
  async getConference(@Req() req: AuthRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.events.getById(await this.resolve(req), id);
  }

  @Post('conferences')
  @RequirePermission('mtg-002:write')
  @ApiOperation({ summary: 'Create a conference event (DRAFT)' })
  async createConference(@Req() req: AuthRequest, @Body() body: CreateConferenceEventDto) {
    return this.events.create(await this.resolve(req), body);
  }

  @Patch('conferences/:id')
  @RequirePermission('mtg-002:write')
  @ApiOperation({
    summary:
      'Update a conference event. Status transitions follow DRAFT→BOOKING_OPEN→IN_PROGRESS→COMPLETED.',
  })
  async patchConference(
    @Req() req: AuthRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateConferenceEventDto,
  ) {
    return this.events.patch(await this.resolve(req), id, body);
  }

  // ── Conference Slots ──────────────────────────────────────────

  @Get('conferences/:id/slots')
  @RequirePermission('mtg-002:read')
  @ApiOperation({
    summary:
      'List slots for a conference event. Filter by teacherId; availableOnly=true for parent booking views.',
  })
  async listSlots(
    @Req() req: AuthRequest,
    @Param('id', new ParseUUIDPipe()) eventId: string,
    @Query('teacherId') teacherId?: string,
    @Query('availableOnly') availableOnly?: string,
  ) {
    return this.slots.listForEvent(await this.resolve(req), eventId, {
      teacherId,
      availableOnly: availableOnly === 'true',
    });
  }

  @Get('slots/:id')
  @RequirePermission('mtg-002:read')
  @ApiOperation({ summary: 'Read a single conference slot' })
  async getSlot(@Req() req: AuthRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.slots.getById(await this.resolve(req), id);
  }

  @Post('conferences/:id/slots/generate')
  @RequirePermission('mtg-002:write')
  @ApiOperation({
    summary:
      'Auto-generate slots for a teacher across a time window. Idempotent on (event, teacher, date, start_time).',
  })
  async generateSlots(
    @Req() req: AuthRequest,
    @Param('id', new ParseUUIDPipe()) eventId: string,
    @Body() body: GenerateSlotsDto,
  ) {
    return this.slots.generateSlots(await this.resolve(req), eventId, body);
  }

  @Patch('slots/:id')
  @RequirePermission('mtg-002:write')
  @ApiOperation({ summary: 'Update a slot (BLOCK/unblock, edit location/url/notes)' })
  async patchSlot(
    @Req() req: AuthRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateSlotDto,
  ) {
    return this.slots.patch(await this.resolve(req), id, body);
  }

  // ── Conference Bookings ───────────────────────────────────────

  @Get('bookings/my')
  @RequirePermission('mtg-002:read')
  @ApiOperation({ summary: 'Parent: list own bookings (row-scoped to actor.accountId)' })
  async myBookings(@Req() req: AuthRequest) {
    return this.bookings.listMine(await this.resolve(req));
  }

  @Get('bookings')
  @RequirePermission('mtg-002:write')
  @ApiOperation({
    summary:
      'Staff/admin: list bookings filtered by slotId / parentId / studentId. Parents must use /bookings/my.',
  })
  async listBookings(
    @Req() req: AuthRequest,
    @Query('slotId') slotId?: string,
    @Query('parentId') parentId?: string,
    @Query('studentId') studentId?: string,
  ) {
    return this.bookings.list(await this.resolve(req), { slotId, parentId, studentId });
  }

  @Get('bookings/:id')
  @RequirePermission('mtg-002:read')
  @ApiOperation({ summary: 'Read a single booking (row-scoped to owner or staff)' })
  async getBooking(@Req() req: AuthRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.bookings.getById(await this.resolve(req), id);
  }

  @Post('slots/:id/book')
  @RequirePermission('mtg-002:write')
  @ApiOperation({
    summary:
      'ATOMIC slot booking: UPDATE eng_conference_slots SET status=BOOKED WHERE id=$1 AND status=AVAILABLE. 0 rows = 409.',
  })
  async bookSlot(
    @Req() req: AuthRequest,
    @Param('id', new ParseUUIDPipe()) slotId: string,
    @Body() body: BookSlotDto,
  ) {
    return this.bookings.book(await this.resolve(req), slotId, body);
  }

  @Delete('bookings/:id')
  @RequirePermission('mtg-002:write')
  @ApiOperation({
    summary: 'Cancel a booking. Owner OR admin only. Slot reverts to AVAILABLE.',
  })
  async cancelBooking(
    @Req() req: AuthRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: CancelBookingDto,
  ) {
    return this.bookings.cancel(await this.resolve(req), id, body);
  }

  @Patch('bookings/:id')
  @RequirePermission('mtg-002:read')
  @ApiOperation({
    summary:
      'Update a booking. Staff: mark attended, conferenceNotes, followUpActions. Owner: parentFeedbackRating, parentFeedbackComments.',
  })
  async patchBooking(
    @Req() req: AuthRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateBookingDto,
  ) {
    return this.bookings.patch(await this.resolve(req), id, body);
  }

  // ── Engagement Scores ─────────────────────────────────────────

  @Get('scores')
  @RequirePermission('eng-001:read')
  @ApiOperation({
    summary:
      'List engagement scores across families. Default: latest score per family. Filter by ?level and ?scoreDate.',
  })
  async listScores(
    @Req() req: AuthRequest,
    @Query('level') level?: EngagementLevel,
    @Query('scoreDate') scoreDate?: string,
  ) {
    return this.scores.list(await this.resolve(req), { level, scoreDate });
  }

  @Get('scores/summary')
  @RequirePermission('eng-001:read')
  @ApiOperation({ summary: 'School-wide engagement summary (counts per level + average)' })
  async scoreSummary(@Req() req: AuthRequest) {
    return this.scores.summary(await this.resolve(req));
  }

  @Get('scores/:familyId')
  @RequirePermission('eng-001:read')
  @ApiOperation({ summary: 'Engagement score history + component breakdown for one family' })
  async familyScore(
    @Req() req: AuthRequest,
    @Param('familyId', new ParseUUIDPipe()) familyId: string,
  ) {
    return this.scores.getForFamily(await this.resolve(req), familyId);
  }

  @Get('score-config')
  @RequirePermission('eng-001:read')
  @ApiOperation({ summary: 'Read score weights + level thresholds for this school' })
  async getScoreConfig(@Req() req: AuthRequest) {
    return this.scores.getConfig(await this.resolve(req));
  }

  @Patch('score-config')
  @RequirePermission('eng-001:admin')
  @ApiOperation({
    summary:
      'Update score weights + level thresholds (admin-only). Weights must sum to 100. Thresholds must be strictly decreasing.',
  })
  async patchScoreConfig(@Req() req: AuthRequest, @Body() body: UpdateScoreConfigDto) {
    return this.scores.updateConfig(await this.resolve(req), body);
  }

  // ── Parent Surveys ────────────────────────────────────────────

  @Get('surveys')
  @RequirePermission('mtg-002:read')
  @ApiOperation({
    summary:
      'List surveys. Parents see only OPEN surveys. Staff/admin see all (DRAFT/OPEN/CLOSED).',
  })
  async listSurveys(@Req() req: AuthRequest) {
    return this.surveys.list(await this.resolve(req));
  }

  @Get('surveys/:id')
  @RequirePermission('mtg-002:read')
  @ApiOperation({ summary: 'Read a single survey (parents see only OPEN)' })
  async getSurvey(@Req() req: AuthRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.surveys.getById(await this.resolve(req), id);
  }

  @Get('surveys/:id/results')
  @RequirePermission('eng-001:admin')
  @ApiOperation({
    summary: 'Admin: aggregated results. Anonymous surveys never expose individual responses.',
  })
  async surveyResults(@Req() req: AuthRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.surveys.getResults(await this.resolve(req), id);
  }

  @Post('surveys')
  @RequirePermission('eng-001:admin')
  @ApiOperation({ summary: 'Admin: create a survey (DRAFT)' })
  async createSurvey(@Req() req: AuthRequest, @Body() body: CreateSurveyDto) {
    return this.surveys.create(await this.resolve(req), body);
  }

  @Patch('surveys/:id')
  @RequirePermission('eng-001:admin')
  @ApiOperation({
    summary:
      'Admin: update a survey. Status flips DRAFT→OPEN emit eng.survey.opened via the platform outbox.',
  })
  async patchSurvey(
    @Req() req: AuthRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateSurveyDto,
  ) {
    return this.surveys.patch(await this.resolve(req), id, body);
  }

  @Post('surveys/:id/respond')
  @RequirePermission('mtg-002:write')
  @ApiOperation({
    summary: 'Submit a survey response. When is_anonymous=true, respondent_id is NEVER stored.',
  })
  async respondToSurvey(
    @Req() req: AuthRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: SubmitSurveyResponseDto,
  ) {
    return this.surveys.submitResponse(await this.resolve(req), id, body);
  }
}
