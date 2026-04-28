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
import { LeaveService } from './leave.service';
import {
  LeaveBalanceDto,
  LeaveRequestResponseDto,
  LeaveTypeResponseDto,
  ListLeaveRequestsQueryDto,
  ReviewLeaveRequestDto,
  SubmitLeaveRequestDto,
} from './dto/leave.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Leave')
@ApiBearerAuth()
@Controller()
export class LeaveController {
  constructor(
    private readonly leave: LeaveService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('leave-types')
  @RequirePermission('hr-003:read')
  @ApiOperation({ summary: 'List leave types in the current tenant' })
  async listLeaveTypes(): Promise<LeaveTypeResponseDto[]> {
    return this.leave.listLeaveTypes();
  }

  @Get('leave/me/balances')
  @RequirePermission('hr-003:read')
  @ApiOperation({ summary: "Resolve the calling user's per-leave-type balances" })
  async myBalances(@Req() req: AuthedRequest): Promise<LeaveBalanceDto[]> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    if (!actor.employeeId) return [];
    return this.leave.listBalancesForEmployee(actor.employeeId);
  }

  @Get('leave-requests')
  @RequirePermission('hr-003:read')
  @ApiOperation({ summary: "List leave requests — own history for non-admins, full queue for admins" })
  async listRequests(
    @Query() query: ListLeaveRequestsQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<LeaveRequestResponseDto[]> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.leave.list(query, actor);
  }

  @Get('leave-requests/:id')
  @RequirePermission('hr-003:read')
  @ApiOperation({ summary: 'Get a leave request by id (own or admin only)' })
  async getRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<LeaveRequestResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.leave.getById(id, actor);
  }

  @Post('leave-requests')
  @RequirePermission('hr-003:write')
  @ApiOperation({ summary: 'Submit a leave request (employee self-service)' })
  async submit(
    @Body() body: SubmitLeaveRequestDto,
    @Req() req: AuthedRequest,
  ): Promise<LeaveRequestResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.leave.submit(body, actor);
  }

  @Patch('leave-requests/:id/approve')
  @RequirePermission('hr-003:write')
  @ApiOperation({ summary: 'Approve a PENDING leave request (admin only)' })
  async approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReviewLeaveRequestDto,
    @Req() req: AuthedRequest,
  ): Promise<LeaveRequestResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.leave.approve(id, body, actor);
  }

  @Patch('leave-requests/:id/reject')
  @RequirePermission('hr-003:write')
  @ApiOperation({ summary: 'Reject a PENDING leave request (admin only)' })
  async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReviewLeaveRequestDto,
    @Req() req: AuthedRequest,
  ): Promise<LeaveRequestResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.leave.reject(id, body, actor);
  }

  @Patch('leave-requests/:id/cancel')
  @RequirePermission('hr-003:write')
  @ApiOperation({ summary: 'Cancel an own leave request (or admin)' })
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<LeaveRequestResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.leave.cancel(id, actor);
  }
}
