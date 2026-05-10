import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';
import { Public } from '../auth/public.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import {
  CreateTourBookingDto,
  CreateTourSlotDto,
  LinkApplicationDto,
  TourBookingResponseDto,
  TourSlotResponseDto,
  UpdateTourBookingDto,
  UpdateTourSlotDto,
} from './dto/tour.dto';
import { TourSlotService } from './tour-slot.service';
import { TourBookingService } from './tour-booking.service';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

class PublicBookingDto extends CreateTourBookingDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  firstName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  lastName!: string;

  @IsEmail()
  @MaxLength(255)
  declare contactEmail: string;
}

@ApiTags('Enrolment Tours')
@Controller('enrolment')
export class TourController {
  constructor(
    private readonly slots: TourSlotService,
    private readonly bookings: TourBookingService,
    private readonly actors: ActorContextService,
  ) {}

  // ============================================================
  // Public surface — browse + book without auth
  // ============================================================

  @Public()
  @Get('tours/public')
  @ApiOperation({
    summary: 'Public — browse published, future, non-cancelled tour slots with availability.',
  })
  async listPublic(): Promise<TourSlotResponseDto[]> {
    return this.slots.listPublic();
  }

  @Public()
  @Post('tours/:slotId/book')
  @ApiOperation({
    summary:
      'Public — book a tour slot. Creates an iam_person at booking per ADR-055 if the family contact_email does not yet match a CampusOS account.',
  })
  async bookPublic(
    @Param('slotId', ParseUUIDPipe) slotId: string,
    @Body() body: PublicBookingDto,
  ): Promise<TourBookingResponseDto> {
    return this.bookings.bookPublic(slotId, {
      firstName: body.firstName,
      lastName: body.lastName,
      familyName: body.familyName,
      contactEmail: body.contactEmail,
      contactPhone: body.contactPhone ?? null,
      notes: body.notes ?? null,
      guests: body.guests ?? [],
    });
  }

  // ============================================================
  // Admin surface — slot management
  // ============================================================

  @ApiBearerAuth()
  @Get('tours')
  @RequirePermission('stu-003:read')
  @ApiOperation({ summary: 'Admin — list every tour slot incl. drafts and cancelled.' })
  async listAdmin(@Req() req: AuthedRequest): Promise<TourSlotResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.slots.listAdmin(actor);
  }

  @ApiBearerAuth()
  @Get('tours/:id')
  @RequirePermission('stu-003:read')
  @ApiOperation({ summary: 'Get a single tour slot by id.' })
  async getSlot(@Param('id', ParseUUIDPipe) id: string): Promise<TourSlotResponseDto> {
    return this.slots.getById(id);
  }

  @ApiBearerAuth()
  @Post('tours')
  @RequirePermission('stu-003:admin')
  @ApiOperation({ summary: 'Admin — create a new tour slot.' })
  async createSlot(
    @Body() body: CreateTourSlotDto,
    @Req() req: AuthedRequest,
  ): Promise<TourSlotResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.slots.create(body, actor);
  }

  @ApiBearerAuth()
  @Patch('tours/:id')
  @RequirePermission('stu-003:admin')
  @ApiOperation({ summary: 'Admin — publish, cancel, or update a tour slot.' })
  async patchSlot(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateTourSlotDto,
    @Req() req: AuthedRequest,
  ): Promise<TourSlotResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.slots.patch(id, body, actor);
  }

  // ============================================================
  // Admin surface — booking management
  // ============================================================

  @ApiBearerAuth()
  @Get('tour-bookings')
  @RequirePermission('stu-003:read')
  @ApiOperation({ summary: 'Admin — list tour bookings (most recent first).' })
  async listBookings(@Req() req: AuthedRequest): Promise<TourBookingResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.bookings.listAdmin(actor);
  }

  @ApiBearerAuth()
  @Get('tour-bookings/:id')
  @RequirePermission('stu-003:read')
  @ApiOperation({
    summary:
      'Get a single booking. Row-scoped — admins and stu-003:write holders see all; the booking owner sees own.',
  })
  async getBooking(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<TourBookingResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.bookings.getById(id, actor);
  }

  @ApiBearerAuth()
  @Patch('tour-bookings/:id')
  @RequirePermission('stu-003:write')
  @ApiOperation({
    summary:
      'Admin lifecycle — cancel (decrements slot.current_bookings), no-show, or complete a booking.',
  })
  async patchBooking(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateTourBookingDto,
    @Req() req: AuthedRequest,
  ): Promise<TourBookingResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.bookings.patch(id, body, actor);
  }

  @ApiBearerAuth()
  @Post('tour-bookings/:id/link-application')
  @RequirePermission('stu-003:write')
  @ApiOperation({
    summary: 'EO links a tour booking to a later admission application from the Cycle 16 pipeline.',
  })
  async linkApplication(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: LinkApplicationDto,
    @Req() req: AuthedRequest,
  ): Promise<TourBookingResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.bookings.linkApplication(id, body, actor);
  }
}
