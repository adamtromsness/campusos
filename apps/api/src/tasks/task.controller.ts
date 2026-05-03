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
import { TaskService } from './task.service';
import { CreateTaskDto, ListTasksQueryDto, TaskResponseDto, UpdateTaskDto } from './dto/task.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Tasks')
@ApiBearerAuth()
@Controller('tasks')
export class TaskController {
  constructor(
    private readonly tasks: TaskService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('ops-001:read')
  @ApiOperation({
    summary: 'List tasks visible to the caller (own list by default, full tenant list for admins).',
  })
  async list(
    @Query() query: ListTasksQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<TaskResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.tasks.list(query, actor);
  }

  @Get('assigned')
  @RequirePermission('ops-001:read')
  @ApiOperation({ summary: 'Tasks delegated to me by another user.' })
  async listAssigned(@Req() req: AuthedRequest): Promise<TaskResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.tasks.listAssigned(actor);
  }

  @Get(':id')
  @RequirePermission('ops-001:read')
  @ApiOperation({ summary: 'Fetch a single task by id (own or delegated rows; admin sees all).' })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<TaskResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.tasks.getById(id, actor);
  }

  @Post()
  @RequirePermission('ops-001:write')
  @ApiOperation({
    summary:
      'Create a manual task (source=MANUAL). Optionally delegate to another user (admin only this cycle).',
  })
  async create(@Body() body: CreateTaskDto, @Req() req: AuthedRequest): Promise<TaskResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.tasks.create(body, actor);
  }

  @Patch(':id')
  @RequirePermission('ops-001:write')
  @ApiOperation({ summary: 'Edit a task: status transition, retitle, reschedule.' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateTaskDto,
    @Req() req: AuthedRequest,
  ): Promise<TaskResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.tasks.update(id, body, actor);
  }
}
