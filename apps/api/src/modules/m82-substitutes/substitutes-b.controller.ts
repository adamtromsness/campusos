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
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { RequirePermission } from '@shared/auth/require-permission.decorator';
import { SubstituteAvailabilityService } from './availability.service';
import { SubstitutePreferenceService } from './preference.service';
import { AssignmentService } from './assignment.service';
import { RatingService } from './rating.service';
import { SessionNoteService } from './session-note.service';
import { PayRateService } from './pay-rate.service';
import { CancellationPolicyService } from './cancellation-policy.service';
import {
  AssignmentPayDto,
  AssignmentResponseDto,
  AvailabilityResponseDto,
  CancelAssignmentDto,
  CancellationPolicyResponseDto,
  CreateAvailabilityDto,
  CreatePayRateDto,
  CreatePreferenceDto,
  CreateRatingDto,
  CreateSessionNoteDto,
  PayRateResponseDto,
  PreferenceResponseDto,
  RatingResponseDto,
  SessionNoteResponseDto,
  UpsertCancellationPolicyDto,
} from './dto/substitutes.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string };
}

/**
 * SubstitutesPostController — P2-9b.
 *
 * Owns the request-path surface for the second wave of P2-9 services:
 * availability, preferences, assignment lifecycle, ratings, session
 * notes, pay rates and cancellation policy management. Split off
 * SubstitutesController to keep each controller's responsibilities
 * focused on a single subdomain.
 *
 * Permission gates:
 *   - SUB-001:write — substitute self-service writes (own availability,
 *     own preferences, check in/out, decline, write session note,
 *     SUB_RATES_SCHOOL rating).
 *   - SCH-004:read — admin reads (assignment list, pay rates, policy).
 *   - SCH-004:write — admin writes (pool member updates, pay rate
 *     management, cancellation policy upsert, SCHOOL_RATES_SUB rating,
 *     check in/out on behalf, cancel on behalf).
 */
@ApiTags('substitutes')
@Controller('substitutes')
export class SubstitutesPostController {
  constructor(
    private readonly availability: SubstituteAvailabilityService,
    private readonly preferences: SubstitutePreferenceService,
    private readonly assignments: AssignmentService,
    private readonly ratings: RatingService,
    private readonly notes: SessionNoteService,
    private readonly payRates: PayRateService,
    private readonly policy: CancellationPolicyService,
    private readonly actors: ActorContextService,
  ) {}

  // ── Availability ─────────────────────────────────────────────────

  @Get('availability/me')
  @RequirePermission('sub-001:read')
  @ApiOperation({ summary: 'List my own availability rows.' })
  async myAvailability(@Req() req: AuthedRequest): Promise<AvailabilityResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.availability.listMine(actor);
  }

  @Post('availability')
  @RequirePermission('sub-001:write')
  @ApiOperation({
    summary:
      'Create an availability row. RECURRING requires dayOfWeek (0-6). SPECIFIC/BLOCKED require specificDate. BLOCKED overrides RECURRING at the matching engine.',
  })
  async createAvailability(
    @Body() input: CreateAvailabilityDto,
    @Req() req: AuthedRequest,
  ): Promise<AvailabilityResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.availability.create(input, actor);
  }

  @Delete('availability/:id')
  @RequirePermission('sub-001:write')
  @ApiOperation({ summary: 'Remove an availability row (own only).' })
  async deleteAvailability(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<{ deleted: true }> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.availability.remove(id, actor);
  }

  // ── Preferences ──────────────────────────────────────────────────

  @Get('preferences/me')
  @RequirePermission('sub-001:read')
  @ApiOperation({ summary: 'List my own school preferences.' })
  async myPreferences(@Req() req: AuthedRequest): Promise<PreferenceResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.preferences.listMine(actor);
  }

  @Post('preferences')
  @RequirePermission('sub-001:write')
  @ApiOperation({
    summary:
      'Create a school preference (PREFERRED or BLOCKED). reason is private to the substitute.',
  })
  async createPreference(
    @Body() input: CreatePreferenceDto,
    @Req() req: AuthedRequest,
  ): Promise<PreferenceResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.preferences.create(input, actor);
  }

  @Delete('preferences/:id')
  @RequirePermission('sub-001:write')
  @ApiOperation({ summary: 'Remove a school preference (own only).' })
  async deletePreference(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<{ deleted: true }> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.preferences.remove(id, actor);
  }

  // ── Assignments ──────────────────────────────────────────────────

  @Get('assignments')
  @RequirePermission('sch-004:read')
  @ApiOperation({
    summary: 'List assignments. Admin sees all; substitute sees own; status filter optional.',
  })
  async listAssignments(
    @Req() req: AuthedRequest,
    @Query('status') status?: string,
  ): Promise<AssignmentResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.assignments.list(actor, status);
  }

  @Get('assignments/:id')
  @RequirePermission('sch-004:read')
  @ApiOperation({ summary: 'Get an assignment by id.' })
  async getAssignment(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<AssignmentResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.assignments.getById(id, actor);
  }

  @Post('assignments/:id/check-in')
  @RequirePermission('sub-001:write')
  @ApiOperation({
    summary:
      'Check in to an assignment. Only the assigned substitute (or admin) — assignment must be CONFIRMED.',
  })
  async checkIn(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<AssignmentResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.assignments.checkIn(id, actor);
  }

  @Post('assignments/:id/check-out')
  @RequirePermission('sub-001:write')
  @ApiOperation({
    summary:
      'Check out of an assignment. Only the assigned substitute (or admin) — assignment must be CHECKED_IN. Bumps platform total_assignments counter.',
  })
  async checkOut(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<AssignmentResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.assignments.checkOut(id, actor);
  }

  @Post('assignments/:id/cancel')
  @RequirePermission('sub-001:write')
  @ApiOperation({
    summary:
      'Cancel an assignment. cancelledByType=SUBSTITUTE requires owning substitute; cancelledByType=SCHOOL requires admin. Computes is_late_cancellation against school policy + emits sub.assignment.late_cancelled when within the late window.',
  })
  async cancelAssignment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: CancelAssignmentDto,
    @Req() req: AuthedRequest,
  ): Promise<AssignmentResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.assignments.cancel(id, input, actor);
  }

  // ── Ratings ──────────────────────────────────────────────────────

  @Get('assignments/:id/ratings')
  @RequirePermission('sch-004:read')
  @ApiOperation({ summary: 'List ratings for an assignment.' })
  async listRatings(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<RatingResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.ratings.listForAssignment(id, actor);
  }

  @Post('assignments/:id/ratings')
  @RequirePermission('sch-004:read')
  @ApiOperation({
    summary:
      'Submit a bidirectional rating. raterType=SCHOOL_RATES_SUB requires admin; SUB_RATES_SCHOOL requires the assigned substitute. UNIQUE(assignment, rater_type) catches duplicates. SCHOOL_RATES_SUB inserts trigger overall_rating re-materialisation.',
  })
  async submitRating(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: CreateRatingDto,
    @Req() req: AuthedRequest,
  ): Promise<RatingResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.ratings.create(id, input, actor);
  }

  // ── Session Notes ────────────────────────────────────────────────

  @Get('assignments/:id/session-note')
  @RequirePermission('sub-001:read')
  @ApiOperation({
    summary:
      'Get the handover session note for an assignment. Visibility: admin / writing substitute / returning teacher (when is_visible_to_teacher=true).',
  })
  async getSessionNote(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<SessionNoteResponseDto | null> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.notes.getForAssignment(id, actor);
  }

  @Post('assignments/:id/session-note')
  @RequirePermission('sub-001:write')
  @ApiOperation({
    summary:
      'Write a handover note for an assignment (one per assignment). Only the assigned substitute (or admin) — UNIQUE(assignment_id) catches a second insert.',
  })
  async createSessionNote(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: CreateSessionNoteDto,
    @Req() req: AuthedRequest,
  ): Promise<SessionNoteResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.notes.create(id, input, actor);
  }

  // ── Pay Rates ────────────────────────────────────────────────────

  @Get('pay-rates')
  @RequirePermission('sch-004:read')
  @ApiOperation({ summary: 'List pay rates configured for this school.' })
  async listPayRates(): Promise<PayRateResponseDto[]> {
    return this.payRates.list();
  }

  @Post('pay-rates')
  @RequirePermission('sch-004:write')
  @ApiOperation({
    summary:
      'Configure a pay rate. EXCLUDE-gist on (school, substitute, job_type, daterange) rejects overlapping date ranges (409 Conflict on 23P01). Omit substituteId for the school default.',
  })
  async createPayRate(
    @Body() input: CreatePayRateDto,
    @Req() req: AuthedRequest,
  ): Promise<PayRateResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.payRates.create(input, actor);
  }

  @Patch('pay-rates/:id/close')
  @RequirePermission('sch-004:write')
  @ApiOperation({ summary: 'Close an open-ended pay rate by stamping effectiveTo.' })
  async closePayRate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { effectiveTo: string },
    @Req() req: AuthedRequest,
  ): Promise<PayRateResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.payRates.close(id, body.effectiveTo, actor);
  }

  @Get('assignments/:id/pay')
  @RequirePermission('sch-004:read')
  @ApiOperation({
    summary:
      'Compute pay for an assignment. Per-substitute rate first, falling back to school default (sentinel substitute_id).',
  })
  async computePay(@Param('id', ParseUUIDPipe) id: string): Promise<AssignmentPayDto> {
    return this.payRates.computePay(id);
  }

  // ── Cancellation Policy ──────────────────────────────────────────

  @Get('cancellation-policy')
  @RequirePermission('sch-004:read')
  @ApiOperation({ summary: 'Get the current school cancellation policy (or null if not set).' })
  async getPolicy(): Promise<CancellationPolicyResponseDto | null> {
    return this.policy.get();
  }

  @HttpCode(200)
  @Patch('cancellation-policy')
  @RequirePermission('sch-004:write')
  @ApiOperation({
    summary:
      'Upsert the school cancellation policy. PATCH semantics merge with current row. TEMPORARY_POOL_SUSPENSION requires suspensionDurationDays. RATING_PENALTY requires ratingPenaltyAmount.',
  })
  async upsertPolicy(
    @Body() input: UpsertCancellationPolicyDto,
    @Req() req: AuthedRequest,
  ): Promise<CancellationPolicyResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.policy.upsert(input, actor);
  }
}
