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
import { RequirePermission } from '@shared/auth';
import { ActorContextService } from '@modules/m00-platform';
import { HoldService } from './hold.service';
import { CreateHoldDto, HOLD_STATUSES, HoldResponseDto, HoldStatus } from './dto/library.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Library — Holds')
@ApiBearerAuth()
@Controller('library/holds')
export class HoldController {
  constructor(
    private readonly holds: HoldService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('lib-002:read')
  @ApiOperation({
    summary:
      'List holds. Patron sees own (row-scoped at the service layer); librarian / admin see all. Optional ?status= filter; librarians can pass ?patronId= to inspect another patron’s queue.',
  })
  async list(
    @Query('status') statusRaw: string | undefined,
    @Query('patronId') patronId: string | undefined,
    @Req() req: AuthedRequest,
  ): Promise<HoldResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    const status =
      statusRaw && (HOLD_STATUSES as readonly string[]).includes(statusRaw)
        ? (statusRaw as HoldStatus)
        : undefined;
    return this.holds.list(actor, { status, patronId });
  }

  @Get(':id')
  @RequirePermission('lib-002:read')
  @ApiOperation({
    summary:
      "Fetch a single hold with its queue position when status=PENDING. Row-scoped at the service layer: librarians and admins see any hold in tenant; patrons see only their own; non-owners get a 404 (don't-leak-existence per REVIEW-CYCLE12 BLOCKING 2).",
  })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<HoldResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.holds.getById(id, actor);
  }

  @Post()
  @RequirePermission('lib-002:read')
  @ApiOperation({
    summary:
      'Place a hold. SELF-SERVICE — gated on lib-002:read because hold placement is the patron-driven flow ("I want this book when it returns"). Defaults patronId to actor.personId; librarians can pass an explicit patronId to place a hold on behalf of a patron and the service-layer hasLibrarianScope check is the actual gate for that branch. Validates the catalogue item exists + has at least one copy; refuses to stack a duplicate PENDING/READY hold from the same patron.',
  })
  async create(@Body() body: CreateHoldDto, @Req() req: AuthedRequest): Promise<HoldResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.holds.placeHold(body, actor);
  }

  @Patch(':id/cancel')
  @RequirePermission('lib-002:read')
  @ApiOperation({
    summary:
      'Cancel a hold. Gated on lib-002:read because patrons cancel their own holds (self-service); librarians / admins cancel any via the service-layer hasLibrarianScope branch. Service-layer row-scope refuses non-librarian non-owner with 403. Refused on terminal-state rows (COLLECTED / EXPIRED / CANCELLED).',
  })
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<HoldResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.holds.cancel(id, actor);
  }

  @Patch(':id/collect')
  @RequirePermission('lib-002:write')
  @ApiOperation({
    summary:
      'Mark a hold COLLECTED. Librarian / admin only. Hold must be in status READY (the patron has been notified). Does not auto-create a checkout — the librarian creates the checkout via POST /library/checkouts as a separate explicit step.',
  })
  async collect(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<HoldResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.holds.collect(id, actor);
  }
}
