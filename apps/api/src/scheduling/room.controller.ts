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
import { RoomService } from './room.service';
import {
  CreateRoomDto,
  ListRoomsQueryDto,
  RoomAvailabilityDto,
  RoomResponseDto,
  UpdateRoomDto,
} from './dto/room.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Rooms')
@ApiBearerAuth()
@Controller('rooms')
export class RoomController {
  constructor(
    private readonly rooms: RoomService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('sch-005:read')
  @ApiOperation({
    summary:
      'List rooms. Pass availabilityDate + availabilityPeriodId to annotate each row with `available`.',
  })
  async list(@Query() query: ListRoomsQueryDto): Promise<RoomAvailabilityDto[]> {
    return this.rooms.list(query);
  }

  @Get(':id')
  @RequirePermission('sch-005:read')
  @ApiOperation({ summary: 'Get a room by id' })
  async getById(@Param('id', ParseUUIDPipe) id: string): Promise<RoomResponseDto> {
    return this.rooms.getById(id);
  }

  @Post()
  @RequirePermission('sch-005:admin')
  @ApiOperation({ summary: 'Create a room (admin only)' })
  async create(@Body() body: CreateRoomDto, @Req() req: AuthedRequest): Promise<RoomResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.rooms.create(body, actor);
  }

  @Patch(':id')
  @RequirePermission('sch-005:admin')
  @ApiOperation({ summary: 'Update a room (admin only)' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateRoomDto,
    @Req() req: AuthedRequest,
  ): Promise<RoomResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.rooms.update(id, body, actor);
  }
}
