import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { ActionService } from './action.service';
import { ActionResponseDto, CreateActionDto, UpdateActionDto } from './dto/discipline.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Discipline Actions')
@ApiBearerAuth()
@Controller()
export class ActionController {
  constructor(
    private readonly actions: ActionService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('discipline/incidents/:id/actions')
  @RequirePermission('beh-001:read')
  @ApiOperation({ summary: 'List actions assigned to an incident.' })
  async list(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<ActionResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.actions.listForIncident(id, actor);
  }

  @Post('discipline/incidents/:id/actions')
  @RequirePermission('beh-001:admin')
  @ApiOperation({
    summary:
      'Admin assigns a disciplinary action. Emits beh.action.parent_notification_required when the action type requires_parent_notification=true.',
  })
  async create(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateActionDto,
    @Req() req: AuthedRequest,
  ): Promise<ActionResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.actions.create(id, body, actor);
  }

  @Patch('discipline/actions/:id')
  @RequirePermission('beh-001:admin')
  @ApiOperation({
    summary:
      'Admin updates an action — dates, notes, parent-notified flag. Stamps parent_notified_at on flip to true.',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateActionDto,
    @Req() req: AuthedRequest,
  ): Promise<ActionResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.actions.update(id, body, actor);
  }

  @Delete('discipline/actions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('beh-001:admin')
  @ApiOperation({
    summary:
      'Admin removes a disciplinary action. Refused on RESOLVED incidents — reopen the parent incident first.',
  })
  async remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest): Promise<void> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    await this.actions.remove(id, actor);
  }
}
