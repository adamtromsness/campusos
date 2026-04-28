import {
  Body,
  Controller,
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
import { RoomBookingService } from './room-booking.service';
import {
  CancelRoomBookingDto,
  CreateRoomBookingDto,
  ListRoomBookingsQueryDto,
  RoomBookingResponseDto,
} from './dto/room-booking.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Room Bookings')
@ApiBearerAuth()
@Controller('room-bookings')
export class RoomBookingController {
  constructor(
    private readonly bookings: RoomBookingService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('sch-005:read')
  @ApiOperation({ summary: 'List room bookings — filterable by room, status, date range' })
  async list(@Query() query: ListRoomBookingsQueryDto): Promise<RoomBookingResponseDto[]> {
    return this.bookings.list(query);
  }

  @Get(':id')
  @RequirePermission('sch-005:read')
  @ApiOperation({ summary: 'Get a booking by id' })
  async getById(@Param('id', ParseUUIDPipe) id: string): Promise<RoomBookingResponseDto> {
    return this.bookings.getById(id);
  }

  @Post()
  @RequirePermission('sch-005:write')
  @ApiOperation({
    summary:
      'Create a CONFIRMED booking. 409 Conflict if the window overlaps an existing booking or an active timetable slot.',
  })
  async create(
    @Body() body: CreateRoomBookingDto,
    @Req() req: AuthedRequest,
  ): Promise<RoomBookingResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.bookings.create(body, actor);
  }

  @Patch(':id/cancel')
  @RequirePermission('sch-005:write')
  @ApiOperation({ summary: 'Cancel a booking (owner or admin)' })
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CancelRoomBookingDto,
    @Req() req: AuthedRequest,
  ): Promise<RoomBookingResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.bookings.cancel(id, body, actor);
  }
}
