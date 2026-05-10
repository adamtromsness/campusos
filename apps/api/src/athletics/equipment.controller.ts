import {
  Body,
  Controller,
  Get,
  Param,
  ParseBoolPipe,
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
import { EquipmentService } from './equipment.service';
import {
  CheckoutEquipmentDto,
  CreateEquipmentDto,
  CreateMaintenanceDto,
  EquipmentCheckoutResponseDto,
  EquipmentCondition,
  EquipmentItemType,
  EquipmentResponseDto,
  MaintenanceResponseDto,
  ReturnEquipmentDto,
  UpdateEquipmentDto,
} from './dto/athletics-advanced.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string };
}

@ApiTags('Athletics Advanced — Equipment')
@ApiBearerAuth()
@Controller('athletics')
export class EquipmentController {
  constructor(
    private readonly equipment: EquipmentService,
    private readonly actors: ActorContextService,
  ) {}

  // ── Equipment CRUD ──────────────────────────────────────────────

  @Get('equipment')
  @RequirePermission('ath-004:read')
  @ApiOperation({ summary: 'List equipment inventory for this school.' })
  async list(
    @Query('programmeId') programmeId?: string,
    @Query('itemType') itemType?: string,
    @Query('condition') condition?: string,
  ): Promise<EquipmentResponseDto[]> {
    return this.equipment.list({
      programmeId,
      itemType: (itemType as EquipmentItemType) ?? undefined,
      condition: (condition as EquipmentCondition) ?? undefined,
    });
  }

  @Get('equipment/overdue')
  @RequirePermission('ath-004:read')
  @ApiOperation({ summary: 'List active equipment checkouts past their expected return date.' })
  async listOverdue(): Promise<EquipmentCheckoutResponseDto[]> {
    return this.equipment.listOverdue();
  }

  @Get('equipment/:id')
  @RequirePermission('ath-004:read')
  async getById(@Param('id', ParseUUIDPipe) id: string): Promise<EquipmentResponseDto> {
    return this.equipment.getById(id);
  }

  @Post('equipment')
  @RequirePermission('ath-004:write')
  async create(
    @Req() req: AuthedRequest,
    @Body() body: CreateEquipmentDto,
  ): Promise<EquipmentResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.equipment.create(body, actor);
  }

  @Patch('equipment/:id')
  @RequirePermission('ath-004:write')
  async patch(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateEquipmentDto,
  ): Promise<EquipmentResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.equipment.patch(id, body, actor);
  }

  // ── Checkouts ───────────────────────────────────────────────────

  @Get('equipment-checkouts')
  @RequirePermission('ath-004:read')
  async listCheckouts(
    @Query('equipmentId') equipmentId?: string,
    @Query('assignedToPersonId') assignedToPersonId?: string,
    @Query('activeOnly', new ParseBoolPipe({ optional: true })) activeOnly?: boolean,
  ): Promise<EquipmentCheckoutResponseDto[]> {
    return this.equipment.listCheckouts({ equipmentId, assignedToPersonId, activeOnly });
  }

  @Post('equipment/:id/checkout')
  @RequirePermission('ath-004:write')
  @ApiOperation({ summary: 'Issue an equipment checkout to a student or staff member.' })
  async checkout(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CheckoutEquipmentDto,
  ): Promise<EquipmentCheckoutResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.equipment.checkout(id, body, actor);
  }

  @Post('equipment-checkouts/:id/return')
  @RequirePermission('ath-004:write')
  @ApiOperation({
    summary:
      'Record return + condition on an active checkout. DAMAGED or LOST emits ath.equipment.replacement_charge so the family billing engine raises an invoice.',
  })
  async returnCheckout(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReturnEquipmentDto,
  ): Promise<EquipmentCheckoutResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.equipment.returnCheckout(id, body, actor);
  }

  // ── Maintenance ─────────────────────────────────────────────────

  @Get('equipment/:id/maintenance')
  @RequirePermission('ath-004:read')
  async listMaintenance(@Param('id', ParseUUIDPipe) id: string): Promise<MaintenanceResponseDto[]> {
    return this.equipment.listMaintenance(id);
  }

  @Post('equipment/:id/maintenance')
  @RequirePermission('ath-004:write')
  async addMaintenance(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateMaintenanceDto,
  ): Promise<MaintenanceResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.equipment.addMaintenance(id, body, actor);
  }
}
