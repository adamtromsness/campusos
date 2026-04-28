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
import { CalendarService } from './calendar.service';
import { DayOverrideService } from './day-override.service';
import {
  CalendarDayResolutionDto,
  CalendarEventResponseDto,
  CreateCalendarEventDto,
  CreateDayOverrideDto,
  DayOverrideResponseDto,
  ListCalendarEventsQueryDto,
  ListDayOverridesQueryDto,
  UpdateCalendarEventDto,
} from './dto/calendar.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Calendar')
@ApiBearerAuth()
@Controller('calendar')
export class CalendarController {
  constructor(
    private readonly calendar: CalendarService,
    private readonly overrides: DayOverrideService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('sch-003:read')
  @ApiOperation({ summary: 'List calendar events overlapping a date range' })
  async list(
    @Query() query: ListCalendarEventsQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<CalendarEventResponseDto[]> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.calendar.list(query, actor);
  }

  @Get('overrides')
  @RequirePermission('sch-003:read')
  @ApiOperation({ summary: 'List day overrides' })
  async listOverrides(
    @Query() query: ListDayOverridesQueryDto,
  ): Promise<DayOverrideResponseDto[]> {
    return this.overrides.list(query);
  }

  @Post('overrides')
  @RequirePermission('sch-003:admin')
  @ApiOperation({ summary: 'Create a day override (admin only)' })
  async createOverride(
    @Body() body: CreateDayOverrideDto,
    @Req() req: AuthedRequest,
  ): Promise<DayOverrideResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.overrides.create(body, actor);
  }

  @Delete('overrides/:date')
  @RequirePermission('sch-003:admin')
  @ApiOperation({ summary: 'Delete a day override by date YYYY-MM-DD (admin only)' })
  async deleteOverride(
    @Param('date') date: string,
    @Req() req: AuthedRequest,
  ): Promise<{ deleted: boolean }> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.overrides.deleteByDate(date, actor);
  }

  @Get('day/:date')
  @RequirePermission('sch-003:read')
  @ApiOperation({
    summary:
      'Resolve the effective bell schedule for a specific date (override → event → default).',
  })
  async resolveDay(@Param('date') date: string): Promise<CalendarDayResolutionDto> {
    return this.calendar.resolveDay(date);
  }

  @Get(':id')
  @RequirePermission('sch-003:read')
  @ApiOperation({ summary: 'Get a calendar event by id' })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<CalendarEventResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.calendar.getById(id, actor);
  }

  @Post()
  @RequirePermission('sch-003:write')
  @ApiOperation({ summary: 'Create a calendar event (admin only)' })
  async create(
    @Body() body: CreateCalendarEventDto,
    @Req() req: AuthedRequest,
  ): Promise<CalendarEventResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.calendar.create(body, actor);
  }

  @Patch(':id')
  @RequirePermission('sch-003:write')
  @ApiOperation({ summary: 'Update a calendar event (admin only)' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateCalendarEventDto,
    @Req() req: AuthedRequest,
  ): Promise<CalendarEventResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.calendar.update(id, body, actor);
  }

  @Delete(':id')
  @RequirePermission('sch-003:write')
  @ApiOperation({ summary: 'Delete a calendar event (admin only)' })
  async delete(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<{ deleted: boolean }> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.calendar.delete(id, actor);
  }
}
