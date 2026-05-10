import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { SafetyEquipmentService } from './safety-equipment.service';
import {
  CreateSafetyEquipmentDto,
  SafetyEquipmentResponseDto,
  UpdateSafetyEquipmentDto,
} from './dto/athletics-advanced.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string };
}

@ApiTags('Athletics Advanced — Safety Equipment')
@ApiBearerAuth()
@Controller('athletics')
export class SafetyEquipmentController {
  constructor(
    private readonly safety: SafetyEquipmentService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('rosters/:id/safety')
  @RequirePermission('ath-004:read')
  @ApiOperation({ summary: 'Per-roster safety compliance checklist.' })
  async listForRoster(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SafetyEquipmentResponseDto[]> {
    return this.safety.listForRoster(id);
  }

  @Get('safety-equipment/expired')
  @RequirePermission('ath-004:read')
  @ApiOperation({ summary: 'List safety equipment rows whose certification has expired.' })
  async listExpired(): Promise<SafetyEquipmentResponseDto[]> {
    return this.safety.listExpired();
  }

  @Get('safety-equipment/:id')
  @RequirePermission('ath-004:read')
  async getById(@Param('id', ParseUUIDPipe) id: string): Promise<SafetyEquipmentResponseDto> {
    return this.safety.getById(id);
  }

  @Post('safety-equipment')
  @RequirePermission('ath-004:write')
  async create(
    @Req() req: AuthedRequest,
    @Body() body: CreateSafetyEquipmentDto,
  ): Promise<SafetyEquipmentResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.safety.create(body, actor);
  }

  @Patch('safety-equipment/:id')
  @RequirePermission('ath-004:write')
  async patch(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateSafetyEquipmentDto,
  ): Promise<SafetyEquipmentResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.safety.patch(id, body, actor);
  }
}
