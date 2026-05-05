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
import { AlertTypeService } from './alert-type.service';
import {
  AlertTypeResponseDto,
  CreateAlertTypeDto,
  UpdateAlertTypeDto,
} from './dto/emergency-alert.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string };
}

@ApiTags('Communications — Alert Types')
@ApiBearerAuth()
@Controller('messaging/alert-types')
export class AlertTypeController {
  constructor(
    private readonly alertTypes: AlertTypeService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('com-003:read')
  @ApiOperation({ summary: 'List alert types for this school' })
  async list(@Query('includeInactive') includeInactive?: string): Promise<AlertTypeResponseDto[]> {
    return this.alertTypes.list(includeInactive === 'true');
  }

  @Post()
  @RequirePermission('com-004:write')
  @ApiOperation({ summary: 'Admin only — create a new alert type' })
  async create(
    @Req() req: AuthedRequest,
    @Body() body: CreateAlertTypeDto,
  ): Promise<AlertTypeResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.alertTypes.create(body, actor);
  }

  @Patch(':id')
  @RequirePermission('com-004:write')
  @ApiOperation({ summary: 'Admin only — update an alert type' })
  async patch(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateAlertTypeDto,
  ): Promise<AlertTypeResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.alertTypes.patch(id, body, actor);
  }
}
