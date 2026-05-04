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
import { TicketService } from './ticket.service';
import {
  AssignTicketDto,
  AssignVendorDto,
  CancelTicketDto,
  CreateTicketDto,
  ListTicketsQueryDto,
  ResolveTicketDto,
  TicketResponseDto,
} from './dto/ticket.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Tickets')
@ApiBearerAuth()
@Controller('tickets')
export class TicketController {
  constructor(
    private readonly tickets: TicketService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('it-001:read')
  @ApiOperation({
    summary: 'List tickets visible to the caller (own + assigned by default; full tenant for admins).',
  })
  async list(
    @Query() query: ListTicketsQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<TicketResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.tickets.list(query, actor);
  }

  @Get(':id')
  @RequirePermission('it-001:read')
  @ApiOperation({ summary: 'Fetch a single ticket. 404 to non-requesters and non-assignees.' })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<TicketResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.tickets.getById(id, actor);
  }

  @Post()
  @RequirePermission('it-001:write')
  @ApiOperation({
    summary:
      'Submit a new ticket. Auto-assigns from subcategory.default_assignee_id then auto_assign_to_role; auto-links the matching SLA policy. Emits tkt.ticket.submitted (and tkt.ticket.assigned when an internal assignee resolves).',
  })
  async create(
    @Body() body: CreateTicketDto,
    @Req() req: AuthedRequest,
  ): Promise<TicketResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.tickets.create(body, actor);
  }

  @Patch(':id/assign')
  @RequirePermission('it-001:admin')
  @ApiOperation({
    summary: 'Admin reassigns the ticket to an internal employee. Clears any vendor assignment.',
  })
  async assign(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AssignTicketDto,
    @Req() req: AuthedRequest,
  ): Promise<TicketResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.tickets.assign(id, body, actor);
  }

  @Patch(':id/assign-vendor')
  @RequirePermission('it-001:admin')
  @ApiOperation({
    summary:
      'Admin escalates the ticket to a vendor. Clears the internal assignee; flips status to VENDOR_ASSIGNED.',
  })
  async assignVendor(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AssignVendorDto,
    @Req() req: AuthedRequest,
  ): Promise<TicketResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.tickets.assignVendor(id, body, actor);
  }

  @Patch(':id/resolve')
  @RequirePermission('it-001:write')
  @ApiOperation({
    summary:
      'Resolve the ticket. Allowed by the assignee or any admin. Emits tkt.ticket.resolved.',
  })
  async resolve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ResolveTicketDto,
    @Req() req: AuthedRequest,
  ): Promise<TicketResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.tickets.resolve(id, body, actor);
  }

  @Patch(':id/close')
  @RequirePermission('it-001:write')
  @ApiOperation({
    summary: 'Close a RESOLVED ticket. Requester or admin. Sets closed_at.',
  })
  async close(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<TicketResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.tickets.close(id, actor);
  }

  @Patch(':id/reopen')
  @RequirePermission('it-001:write')
  @ApiOperation({
    summary: 'Reopen a RESOLVED ticket. Requester or admin. Clears resolved_at, status → OPEN.',
  })
  async reopen(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<TicketResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.tickets.reopen(id, actor);
  }

  @Patch(':id/cancel')
  @RequirePermission('it-001:write')
  @ApiOperation({
    summary:
      'Cancel a working-state ticket. Requester or admin. Use close instead on a RESOLVED ticket.',
  })
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CancelTicketDto,
    @Req() req: AuthedRequest,
  ): Promise<TicketResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.tickets.cancel(id, body, actor);
  }
}
