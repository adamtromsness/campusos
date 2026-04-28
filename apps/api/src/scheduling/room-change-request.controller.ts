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
import { RoomChangeRequestService } from './room-change-request.service';
import {
  CreateRoomChangeRequestDto,
  ListRoomChangeRequestsQueryDto,
  ReviewRoomChangeRequestDto,
  RoomChangeRequestResponseDto,
} from './dto/room-change-request.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Room Change Requests')
@ApiBearerAuth()
@Controller('room-change-requests')
export class RoomChangeRequestController {
  constructor(
    private readonly requests: RoomChangeRequestService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('sch-005:read')
  @ApiOperation({
    summary: 'List room change requests. Non-admins see only their own; admins see all.',
  })
  async list(
    @Query() query: ListRoomChangeRequestsQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<RoomChangeRequestResponseDto[]> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.requests.list(query, actor);
  }

  @Get(':id')
  @RequirePermission('sch-005:read')
  @ApiOperation({ summary: 'Get a room change request' })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<RoomChangeRequestResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.requests.getById(id, actor);
  }

  @Post()
  @RequirePermission('sch-005:write')
  @ApiOperation({ summary: 'Submit a room change request' })
  async create(
    @Body() body: CreateRoomChangeRequestDto,
    @Req() req: AuthedRequest,
  ): Promise<RoomChangeRequestResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.requests.create(body, actor);
  }

  @Patch(':id/approve')
  @RequirePermission('sch-005:write')
  @ApiOperation({ summary: 'Approve a PENDING request (admin only)' })
  async approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReviewRoomChangeRequestDto,
    @Req() req: AuthedRequest,
  ): Promise<RoomChangeRequestResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.requests.approve(id, body, actor);
  }

  @Patch(':id/reject')
  @RequirePermission('sch-005:write')
  @ApiOperation({ summary: 'Reject a PENDING request (admin only)' })
  async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReviewRoomChangeRequestDto,
    @Req() req: AuthedRequest,
  ): Promise<RoomChangeRequestResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.requests.reject(id, body, actor);
  }
}
