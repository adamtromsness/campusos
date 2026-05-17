import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '@shared/auth/public.decorator';
import { RequirePermission } from '@shared/auth/require-permission.decorator';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { VehiclePositionService } from './vehicle-position.service';
import { GeofenceService } from './geofence.service';
import { ETAService } from './eta.service';
import { DispatchService } from './dispatch.service';
import { ParentTrackingService } from './parent-tracking.service';
import { FleetStatusService } from './fleet-status.service';
import {
  CreateDispatchEventDto,
  CreateGeofenceDto,
  CreateParentTrackingTokenDto,
  DISPATCH_EVENT_TYPES,
  DispatchEventResponseDto,
  DispatchEventType,
  ETAConfidence,
  ETA_CONFIDENCES,
  FleetStatusRowDto,
  GeofenceEventResponseDto,
  GeofenceResponseDto,
  IngestVehiclePositionDto,
  ParentTrackingTokenResponseDto,
  ParentTrackingViewDto,
  UpdateGeofenceDto,
  VehicleETAResponseDto,
  VehiclePositionResponseDto,
} from './dto/gps-fleet.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

/**
 * GPS Telemetry + Fleet Dashboard Controller — P2-11c.
 *
 * 18 endpoints total across 6 services. Gating model:
 *   TRN-002 (Fleet Management) — vehicle positions, geofences,
 *     dispatch events, fleet status.
 *   TRN-001 (Routes & Schedules) — ETA reads + parent tracking
 *     token CRUD (parents access via the unauthenticated GET).
 *
 * The /transport/tracking/:token GET path is @Public() — the only
 * unauthenticated read in the entire transport module. Token-scoped
 * to a single (student, route) pair; revoked / expired tokens
 * surface 410 Gone via the service.
 */
@ApiTags('transport-gps-fleet')
@Controller({ version: '1' })
export class GpsFleetController {
  constructor(
    private readonly positions: VehiclePositionService,
    private readonly geofences: GeofenceService,
    private readonly etas: ETAService,
    private readonly dispatch: DispatchService,
    private readonly tracking: ParentTrackingService,
    private readonly fleet: FleetStatusService,
    private readonly actors: ActorContextService,
  ) {}

  // ── Vehicle positions ──
  @Post('transport/vehicles/:id/position')
  @RequirePermission('trn-002:write')
  @ApiOperation({ summary: 'Ingest a single GPS position for a vehicle' })
  async ingestPosition(
    @Req() req: AuthedRequest,
    @Param('id') vehicleId: string,
    @Body() body: IngestVehiclePositionDto,
  ): Promise<VehiclePositionResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.positions.ingest(vehicleId, body, actor);
  }

  @Get('transport/vehicles/:id/position/latest')
  @RequirePermission('trn-002:read')
  @ApiOperation({ summary: 'Latest known GPS position for a vehicle' })
  async getLatestPosition(
    @Param('id') vehicleId: string,
  ): Promise<VehiclePositionResponseDto | null> {
    return this.positions.getLatest(vehicleId);
  }

  @Get('transport/vehicles/:id/position/history')
  @RequirePermission('trn-002:read')
  @ApiOperation({ summary: 'Position history for a vehicle (optional date range)' })
  async getPositionHistory(
    @Param('id') vehicleId: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
    @Query('limit') limit?: string,
  ): Promise<VehiclePositionResponseDto[]> {
    return this.positions.listHistory(vehicleId, {
      fromDate,
      toDate,
      limit: limit ? Number(limit) : undefined,
    });
  }

  // ── Geofences ──
  @Get('transport/geofences')
  @RequirePermission('trn-002:read')
  @ApiOperation({ summary: 'List geofences for the calling school' })
  async listGeofences(
    @Query('includeInactive') includeInactive?: string,
  ): Promise<GeofenceResponseDto[]> {
    return this.geofences.list({ includeInactive: includeInactive === 'true' });
  }

  @Get('transport/geofences/:id')
  @RequirePermission('trn-002:read')
  @ApiOperation({ summary: 'Get a geofence by id' })
  async getGeofence(@Param('id') id: string): Promise<GeofenceResponseDto> {
    return this.geofences.getById(id);
  }

  @Post('transport/geofences')
  @RequirePermission('trn-002:write')
  @ApiOperation({ summary: 'Create a geofence (circle or polygon)' })
  async createGeofence(
    @Req() req: AuthedRequest,
    @Body() body: CreateGeofenceDto,
  ): Promise<GeofenceResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.geofences.create(body, actor);
  }

  @Patch('transport/geofences/:id')
  @RequirePermission('trn-002:write')
  @ApiOperation({ summary: 'Update a geofence' })
  async updateGeofence(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: UpdateGeofenceDto,
  ): Promise<GeofenceResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.geofences.update(id, body, actor);
  }

  @Get('transport/geofence-events')
  @RequirePermission('trn-002:read')
  @ApiOperation({ summary: 'List geofence enter / exit events (filterable)' })
  async listGeofenceEvents(
    @Query('geofenceId') geofenceId?: string,
    @Query('vehicleId') vehicleId?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
    @Query('limit') limit?: string,
  ): Promise<GeofenceEventResponseDto[]> {
    return this.geofences.listEvents({
      geofenceId,
      vehicleId,
      fromDate,
      toDate,
      limit: limit ? Number(limit) : undefined,
    });
  }

  // ── ETA ──
  @Get('transport/routes/:id/eta')
  @RequirePermission('trn-001:read')
  @ApiOperation({ summary: 'List ETAs for every stop on a route' })
  async listRouteEtas(@Param('id') routeId: string): Promise<VehicleETAResponseDto[]> {
    return this.etas.listForRoute(routeId);
  }

  @Get('transport/stops/:id/eta')
  @RequirePermission('trn-001:read')
  @ApiOperation({ summary: 'Snapshot ETAs for a single stop (across vehicles)' })
  async getStopEta(@Param('id') stopId: string): Promise<VehicleETAResponseDto[]> {
    return this.etas.getForStop(stopId);
  }

  @Post('transport/vehicles/:vehicleId/stops/:stopId/eta')
  @RequirePermission('trn-002:write')
  @ApiOperation({ summary: 'Upsert an ETA snapshot for a (vehicle, stop) pair' })
  async upsertEta(
    @Req() req: AuthedRequest,
    @Param('vehicleId') vehicleId: string,
    @Param('stopId') stopId: string,
    @Body() body: { eta: string; confidence?: ETAConfidence; distanceMetres?: number },
  ): Promise<VehicleETAResponseDto> {
    if (!body || typeof body.eta !== 'string') {
      throw new BadRequestException('eta is required');
    }
    if (body.confidence && !ETA_CONFIDENCES.includes(body.confidence)) {
      throw new BadRequestException('confidence must be one of ' + ETA_CONFIDENCES.join(', '));
    }
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.etas.upsert(vehicleId, stopId, body, actor);
  }

  // ── Dispatch events ──
  @Get('transport/dispatch/events')
  @RequirePermission('trn-002:read')
  @ApiOperation({ summary: "List today's dispatch events (filterable)" })
  async listDispatchEvents(
    @Query('vehicleId') vehicleId?: string,
    @Query('routeId') routeId?: string,
    @Query('eventType') eventType?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
    @Query('limit') limit?: string,
  ): Promise<DispatchEventResponseDto[]> {
    if (eventType && !DISPATCH_EVENT_TYPES.includes(eventType as DispatchEventType)) {
      throw new BadRequestException('eventType must be one of ' + DISPATCH_EVENT_TYPES.join(', '));
    }
    return this.dispatch.list({
      vehicleId,
      routeId,
      eventType: eventType as DispatchEventType | undefined,
      fromDate,
      toDate,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Post('transport/dispatch/events')
  @RequirePermission('trn-002:write')
  @ApiOperation({ summary: 'Log a dispatch event' })
  async createDispatchEvent(
    @Req() req: AuthedRequest,
    @Body() body: CreateDispatchEventDto,
  ): Promise<DispatchEventResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.dispatch.create(body, actor);
  }

  // ── Parent tracking tokens ──
  @Post('transport/tracking/tokens')
  @RequirePermission('trn-001:write')
  @ApiOperation({ summary: 'Issue a parent tracking token (TC only)' })
  async createTrackingToken(
    @Req() req: AuthedRequest,
    @Body() body: CreateParentTrackingTokenDto,
  ): Promise<ParentTrackingTokenResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.tracking.createToken(body, actor);
  }

  @Patch('transport/tracking/tokens/:id/revoke')
  @RequirePermission('trn-001:write')
  @ApiOperation({ summary: 'Revoke an active parent tracking token' })
  async revokeTrackingToken(
    @Req() req: AuthedRequest,
    @Param('id') tokenId: string,
  ): Promise<ParentTrackingTokenResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.tracking.revokeToken(tokenId, actor);
  }

  @Get('transport/tracking/students/:studentId/tokens')
  @RequirePermission('trn-001:read')
  @ApiOperation({ summary: 'List tracking tokens for a student (TC only)' })
  async listTokensForStudent(
    @Param('studentId') studentId: string,
  ): Promise<ParentTrackingTokenResponseDto[]> {
    return this.tracking.listForStudent(studentId);
  }

  /**
   * UNAUTHENTICATED — token-scoped read. Surfaces the bus position
   * + the child's stop ETA. No student PII leaks. Revoked tokens
   * return 403 Gone via the service.
   */
  @Public()
  @Get('transport/tracking/:token')
  @ApiOperation({
    summary: 'UNAUTHENTICATED — parent live bus tracking by token (revoked / expired → 403)',
  })
  async viewByToken(@Param('token') token: string): Promise<ParentTrackingViewDto> {
    return this.tracking.viewByToken(token);
  }

  // ── Fleet status ──
  @Get('transport/fleet/status')
  @RequirePermission('trn-002:read')
  @ApiOperation({ summary: 'List rpt_fleet_status snapshots (filterable)' })
  async listFleetStatus(
    @Query('maintenanceOverdue') maintenanceOverdue?: string,
    @Query('expiringWithinDays') expiringWithinDays?: string,
  ): Promise<FleetStatusRowDto[]> {
    return this.fleet.list({
      maintenanceOverdue:
        maintenanceOverdue === 'true' ? true : maintenanceOverdue === 'false' ? false : undefined,
      expiringWithinDays: expiringWithinDays ? Number(expiringWithinDays) : undefined,
    });
  }

  @Get('transport/vehicles/:id/fleet-status')
  @RequirePermission('trn-002:read')
  @ApiOperation({ summary: 'rpt_fleet_status snapshot for a single vehicle' })
  async getFleetStatus(@Param('id') vehicleId: string): Promise<FleetStatusRowDto | null> {
    return this.fleet.getForVehicle(vehicleId);
  }

  @Post('transport/vehicles/:id/fleet-status/materialise')
  @RequirePermission('trn-002:write')
  @ApiOperation({
    summary: 'Trigger fleet status materialisation for a single vehicle (TC / admin)',
  })
  async materialiseFleetStatus(
    @Req() req: AuthedRequest,
    @Param('id') vehicleId: string,
  ): Promise<FleetStatusRowDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.fleet.materialiseForVehicle(vehicleId, actor);
  }

  @Post('transport/fleet/status/materialise')
  @RequirePermission('trn-002:admin')
  @ApiOperation({
    summary: 'Trigger fleet-wide rpt_fleet_status materialisation (admin only)',
  })
  async materialiseAll(@Req() req: AuthedRequest): Promise<{ updated: number }> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.fleet.materialiseAll(actor);
  }
}
