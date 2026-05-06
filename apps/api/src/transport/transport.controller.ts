import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { RouteService } from './route.service';
import { StopService } from './stop.service';
import { AssignmentService } from './assignment.service';
import { RouteChangeRequestService } from './route-change-request.service';
import { RouteChangeLogService } from './route-change-log.service';
import { VehicleService } from './vehicle.service';
import { InspectionService } from './inspection.service';
import { DriverCredentialService } from './driver-credential.service';
import { BusPassService } from './bus-pass.service';
import { RidershipService } from './ridership.service';
import { RunLogService } from './run-log.service';
import { NoShowService } from './no-show.service';
import { DelayReportService } from './delay-report.service';
import {
  ApproveChangeRequestDto,
  BusPassResponseDto,
  CompleteRunLogDto,
  CreateBusPassDto,
  CreateDelayReportDto,
  CreateDriverCredentialDto,
  CreateInspectionDto,
  CreateRouteChangeRequestDto,
  CreateRouteDto,
  CreateRunLogDto,
  CreateStopDto,
  CreateStudentAssignmentDto,
  CreateVehicleDocumentDto,
  CreateVehicleDto,
  DelayReportResponseDto,
  DriverCredentialResponseDto,
  DriverResponseDto,
  InspectionResponseDto,
  NoShowAlertResponseDto,
  RejectChangeRequestDto,
  ReorderStopsDto,
  ResolveNoShowDto,
  RidershipResponseDto,
  RouteChangeLogResponseDto,
  RouteChangeRequestResponseDto,
  RouteDirection,
  RouteResponseDto,
  RouteStatus,
  RunLogResponseDto,
  ScanRidershipDto,
  StopResponseDto,
  StudentAssignmentResponseDto,
  UpdateBusPassDto,
  UpdateDriverCredentialDto,
  UpdateRouteDto,
  UpdateStopDto,
  UpdateVehicleDto,
  VehicleDocumentResponseDto,
  VehicleResponseDto,
  VehicleStatus,
} from './dto/transport.dto';

interface AuthedRequest extends Request {
  user?: {
    sub: string;
    personId: string;
    email: string;
    displayName: string;
    sessionId: string;
  };
}

@ApiTags('Transportation')
@Controller()
export class TransportController {
  constructor(
    private readonly routes: RouteService,
    private readonly stops: StopService,
    private readonly assignments: AssignmentService,
    private readonly changeRequests: RouteChangeRequestService,
    private readonly changeLog: RouteChangeLogService,
    private readonly vehicles: VehicleService,
    private readonly inspections: InspectionService,
    private readonly driverCreds: DriverCredentialService,
    private readonly busPasses: BusPassService,
    private readonly ridership: RidershipService,
    private readonly runLogs: RunLogService,
    private readonly noShows: NoShowService,
    private readonly delays: DelayReportService,
    private readonly actors: ActorContextService,
  ) {}

  // ── Routes ──

  @Get('transport/routes')
  @RequirePermission('trn-001:read')
  @ApiOperation({ summary: 'List routes visible to the caller' })
  async listRoutes(
    @Req() req: AuthedRequest,
    @Query('status') status?: string,
    @Query('direction') direction?: string,
  ): Promise<RouteResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.routes.list(actor, {
      status: (status as RouteStatus) || undefined,
      direction: (direction as RouteDirection) || undefined,
    });
  }

  @Get('transport/routes/:id')
  @RequirePermission('trn-001:read')
  async getRoute(@Param('id') id: string, @Req() req: AuthedRequest): Promise<RouteResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.routes.getById(id, actor);
  }

  @Post('transport/routes')
  @RequirePermission('trn-001:write')
  async createRoute(
    @Body() body: CreateRouteDto,
    @Req() req: AuthedRequest,
  ): Promise<RouteResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.routes.create(body, actor);
  }

  @Patch('transport/routes/:id')
  @RequirePermission('trn-001:write')
  async patchRoute(
    @Param('id') id: string,
    @Body() body: UpdateRouteDto,
    @Req() req: AuthedRequest,
  ): Promise<RouteResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.routes.patch(id, body, actor);
  }

  // ── Stops ──

  @Get('transport/routes/:id/stops')
  @RequirePermission('trn-001:read')
  async getStops(@Param('id') id: string, @Req() req: AuthedRequest): Promise<StopResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    await this.routes.assertCanReadRoute(id, actor);
    return this.routes.getStops(id);
  }

  @Post('transport/routes/:id/stops')
  @RequirePermission('trn-001:write')
  async createStop(
    @Param('id') id: string,
    @Body() body: CreateStopDto,
    @Req() req: AuthedRequest,
  ): Promise<StopResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.stops.create(id, body, actor);
  }

  @Patch('transport/stops/:id')
  @RequirePermission('trn-001:write')
  async patchStop(
    @Param('id') id: string,
    @Body() body: UpdateStopDto,
    @Req() req: AuthedRequest,
  ): Promise<StopResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.stops.patch(id, body, actor);
  }

  @Delete('transport/stops/:id')
  @RequirePermission('trn-001:write')
  @HttpCode(204)
  async deleteStop(@Param('id') id: string, @Req() req: AuthedRequest): Promise<void> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    await this.stops.remove(id, actor);
  }

  @Patch('transport/routes/:id/stops/reorder')
  @RequirePermission('trn-001:write')
  async reorderStops(
    @Param('id') id: string,
    @Body() body: ReorderStopsDto,
    @Req() req: AuthedRequest,
  ): Promise<StopResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.stops.reorder(id, body, actor);
  }

  // ── Assignments ──

  @Get('transport/routes/:id/students')
  @RequirePermission('trn-001:read')
  async listAssignments(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<StudentAssignmentResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.assignments.listForRoute(id, actor);
  }

  @Post('transport/routes/:id/students')
  @RequirePermission('trn-001:write')
  async createAssignment(
    @Param('id') id: string,
    @Body() body: CreateStudentAssignmentDto,
    @Req() req: AuthedRequest,
  ): Promise<StudentAssignmentResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.assignments.create(id, body, actor);
  }

  @Delete('transport/student-assignments/:id')
  @RequirePermission('trn-001:write')
  @HttpCode(204)
  async removeAssignment(@Param('id') id: string, @Req() req: AuthedRequest): Promise<void> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    await this.assignments.remove(id, actor);
  }

  @Get('transport/my-route')
  @RequirePermission('trn-001:read')
  async myRoute(@Req() req: AuthedRequest): Promise<StudentAssignmentResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.assignments.myRoute(actor);
  }

  // ── Change Log + Change Requests ──

  @Get('transport/routes/:id/change-log')
  @RequirePermission('trn-001:read')
  @ApiOperation({ summary: 'IMMUTABLE audit trail for the route. Admin/Staff only.' })
  async getChangeLog(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<RouteChangeLogResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    await this.changeLog.assertRouteExists(id);
    return this.changeLog.listForRoute(id, actor);
  }

  @Get('transport/route-changes')
  @RequirePermission('trn-005:read')
  async listChangeRequests(
    @Req() req: AuthedRequest,
    @Query('status') status?: string,
  ): Promise<RouteChangeRequestResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.changeRequests.list(actor, { status: status as never });
  }

  @Get('transport/route-changes/:id')
  @RequirePermission('trn-005:read')
  async getChangeRequest(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<RouteChangeRequestResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.changeRequests.getById(id, actor);
  }

  @Post('transport/route-changes')
  @RequirePermission('trn-005:write')
  async submitChangeRequest(
    @Body() body: CreateRouteChangeRequestDto,
    @Req() req: AuthedRequest,
  ): Promise<RouteChangeRequestResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.changeRequests.submit(body, actor);
  }

  @Patch('transport/route-changes/:id/approve')
  @RequirePermission('trn-001:write')
  async approveChangeRequest(
    @Param('id') id: string,
    @Body() body: ApproveChangeRequestDto,
    @Req() req: AuthedRequest,
  ): Promise<RouteChangeRequestResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.changeRequests.approve(id, body, actor);
  }

  @Patch('transport/route-changes/:id/reject')
  @RequirePermission('trn-001:write')
  async rejectChangeRequest(
    @Param('id') id: string,
    @Body() body: RejectChangeRequestDto,
    @Req() req: AuthedRequest,
  ): Promise<RouteChangeRequestResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.changeRequests.reject(id, body, actor);
  }

  // ── Vehicles + Documents + Inspections ──

  @Get('transport/vehicles')
  @RequirePermission('trn-002:read')
  async listVehicles(
    @Req() req: AuthedRequest,
    @Query('status') status?: string,
  ): Promise<VehicleResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.vehicles.list(actor, { status: (status as VehicleStatus) || undefined });
  }

  @Get('transport/vehicles/:id')
  @RequirePermission('trn-002:read')
  async getVehicle(@Param('id') id: string): Promise<VehicleResponseDto> {
    return this.vehicles.getById(id);
  }

  @Post('transport/vehicles')
  @RequirePermission('trn-002:write')
  async createVehicle(
    @Body() body: CreateVehicleDto,
    @Req() req: AuthedRequest,
  ): Promise<VehicleResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.vehicles.create(body, actor);
  }

  @Patch('transport/vehicles/:id')
  @RequirePermission('trn-002:write')
  async patchVehicle(
    @Param('id') id: string,
    @Body() body: UpdateVehicleDto,
    @Req() req: AuthedRequest,
  ): Promise<VehicleResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.vehicles.patch(id, body, actor);
  }

  @Get('transport/vehicles/:id/documents')
  @RequirePermission('trn-002:read')
  async listVehicleDocs(@Param('id') id: string): Promise<VehicleDocumentResponseDto[]> {
    return this.vehicles.listDocuments(id);
  }

  @Post('transport/vehicles/:id/documents')
  @RequirePermission('trn-002:write')
  async addVehicleDoc(
    @Param('id') id: string,
    @Body() body: CreateVehicleDocumentDto,
    @Req() req: AuthedRequest,
  ): Promise<VehicleDocumentResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.vehicles.addDocument(id, body, actor);
  }

  @Get('transport/vehicles/:id/inspections')
  @RequirePermission('trn-003:read')
  async listInspections(@Param('id') id: string): Promise<InspectionResponseDto[]> {
    return this.inspections.listForVehicle(id);
  }

  @Get('transport/inspections/:id')
  @RequirePermission('trn-003:read')
  async getInspection(@Param('id') id: string): Promise<InspectionResponseDto> {
    return this.inspections.getById(id);
  }

  @Post('transport/vehicles/:id/inspections')
  @RequirePermission('trn-003:write')
  async createInspection(
    @Param('id') id: string,
    @Body() body: CreateInspectionDto,
    @Req() req: AuthedRequest,
  ): Promise<InspectionResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.inspections.create(id, body, actor);
  }

  // ── Drivers ──

  @Get('transport/drivers')
  @RequirePermission('trn-004:read')
  async listDrivers(@Req() req: AuthedRequest): Promise<DriverResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.driverCreds.listDrivers(actor);
  }

  @Get('transport/drivers/:id/credentials')
  @RequirePermission('trn-004:read')
  async listDriverCreds(@Param('id') id: string): Promise<DriverCredentialResponseDto[]> {
    return this.driverCreds.listForDriver(id);
  }

  @Post('transport/drivers/:id/credentials')
  @RequirePermission('trn-004:write')
  async addDriverCred(
    @Param('id') id: string,
    @Body() body: CreateDriverCredentialDto,
    @Req() req: AuthedRequest,
  ): Promise<DriverCredentialResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.driverCreds.create(id, body, actor);
  }

  @Patch('transport/driver-credentials/:id')
  @RequirePermission('trn-004:write')
  async patchDriverCred(
    @Param('id') id: string,
    @Body() body: UpdateDriverCredentialDto,
    @Req() req: AuthedRequest,
  ): Promise<DriverCredentialResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.driverCreds.patch(id, body, actor);
  }

  // ── Bus Passes + Ridership ──

  @Get('transport/bus-passes')
  @RequirePermission('trn-001:write')
  async listBusPasses(@Req() req: AuthedRequest): Promise<BusPassResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.busPasses.list(actor);
  }

  @Post('transport/bus-passes')
  @RequirePermission('trn-001:write')
  async createBusPass(
    @Body() body: CreateBusPassDto,
    @Req() req: AuthedRequest,
  ): Promise<BusPassResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.busPasses.create(body, actor);
  }

  @Patch('transport/bus-passes/:id')
  @RequirePermission('trn-001:write')
  async patchBusPass(
    @Param('id') id: string,
    @Body() body: UpdateBusPassDto,
    @Req() req: AuthedRequest,
  ): Promise<BusPassResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.busPasses.patch(id, body, actor);
  }

  @Get('transport/my-bus-pass')
  @RequirePermission('trn-001:read')
  async myBusPass(@Req() req: AuthedRequest): Promise<BusPassResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.busPasses.myPass(actor);
  }

  @Post('transport/ridership/scan')
  @RequirePermission('trn-003:write')
  async scan(
    @Body() body: ScanRidershipDto,
    @Req() req: AuthedRequest,
  ): Promise<RidershipResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.ridership.scan(body, actor);
  }

  @Get('transport/ridership/route/:id')
  @RequirePermission('trn-003:read')
  async listRouteRidership(
    @Param('id') id: string,
    @Query('date') date: string | undefined,
    @Req() req: AuthedRequest,
  ): Promise<RidershipResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.ridership.listForRoute(id, { date }, actor);
  }

  @Get('transport/my-ridership')
  @RequirePermission('trn-001:read')
  async myRidership(@Req() req: AuthedRequest): Promise<RidershipResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.ridership.myRidership(actor);
  }

  // ── Run Logs ──

  @Post('transport/runs')
  @RequirePermission('trn-003:write')
  async startRun(
    @Body() body: CreateRunLogDto,
    @Req() req: AuthedRequest,
  ): Promise<RunLogResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.runLogs.start(body, actor);
  }

  @Patch('transport/runs/:id')
  @RequirePermission('trn-003:write')
  async completeRun(
    @Param('id') id: string,
    @Body() body: CompleteRunLogDto,
    @Req() req: AuthedRequest,
  ): Promise<RunLogResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.runLogs.complete(id, body, actor);
  }

  // ── No-Show ──

  @Get('transport/no-shows')
  @RequirePermission('trn-001:read')
  async listNoShows(
    @Req() req: AuthedRequest,
    @Query('date') date?: string,
    @Query('resolved') resolved?: string,
  ): Promise<NoShowAlertResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    const resolvedFlag = resolved === undefined ? undefined : resolved === 'true' ? true : false;
    return this.noShows.list(actor, { date, resolved: resolvedFlag });
  }

  @Patch('transport/no-shows/:id/resolve')
  @RequirePermission('trn-001:write')
  async resolveNoShow(
    @Param('id') id: string,
    @Body() body: ResolveNoShowDto,
    @Req() req: AuthedRequest,
  ): Promise<NoShowAlertResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.noShows.resolve(id, body, actor);
  }

  /**
   * Admin-only debug endpoint that runs the no-show worker on demand for
   * the supplied date (or today when omitted). Backs the Step 10 CAT and
   * ops triage. The scheduled cron version of this worker is deferred
   * to Cycle 19.1 ops wiring per the plan's "configurable schedule" note.
   */
  @Post('transport/no-shows/run-once')
  @RequirePermission('trn-001:admin')
  async runNoShowSweep(
    @Body() body: { date?: string },
  ): Promise<{ inserted: number; insertedIds: string[] }> {
    return this.noShows.runOnce({ date: body?.date });
  }

  // ── Delays ──

  @Get('transport/delays')
  @RequirePermission('trn-001:read')
  async listDelays(
    @Req() req: AuthedRequest,
    @Query('routeId') routeId?: string,
    @Query('date') date?: string,
  ): Promise<DelayReportResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.delays.list(actor, { routeId, date });
  }

  @Post('transport/delays')
  @RequirePermission('trn-003:write')
  async reportDelay(
    @Body() body: CreateDelayReportDto,
    @Req() req: AuthedRequest,
  ): Promise<DelayReportResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.delays.create(body, actor);
  }
}
