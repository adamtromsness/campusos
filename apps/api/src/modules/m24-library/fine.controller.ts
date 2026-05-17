import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth/require-permission.decorator';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { FineService } from './fine.service';
import { FINE_STATUSES, FineResponseDto, FineStatus, WaiveFineDto } from './dto/library.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Library — Fines')
@ApiBearerAuth()
@Controller('library/fines')
export class FineController {
  constructor(
    private readonly fines: FineService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('lib-002:read')
  @ApiOperation({
    summary:
      'List fines. Patron sees own (row-scoped at the service layer); librarian / admin see all (default OUTSTANDING-first sort). Optional ?status= filter; librarians can pass ?patronId= to inspect another patron’s history.',
  })
  async list(
    @Query('status') statusRaw: string | undefined,
    @Query('patronId') patronId: string | undefined,
    @Req() req: AuthedRequest,
  ): Promise<FineResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    const status =
      statusRaw && (FINE_STATUSES as readonly string[]).includes(statusRaw)
        ? (statusRaw as FineStatus)
        : undefined;
    return this.fines.list(actor, { status, patronId });
  }

  @Get(':id')
  @RequirePermission('lib-002:read')
  @ApiOperation({
    summary:
      "Fetch a single fine. Patron can read their own only — non-owner patrons get 404 (don't-leak-existence).",
  })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<FineResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.fines.getById(id, actor);
  }

  @Patch(':id/pay')
  @RequirePermission('lib-002:write')
  @ApiOperation({
    summary:
      'Mark a fine PAID. Librarian / admin only. Refused on non-OUTSTANDING fines. The future Cycle 6 payment integration consumer will materialise the matching pay_invoices row and flip via the same endpoint.',
  })
  async pay(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<FineResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.fines.pay(id, actor);
  }

  @Patch(':id/waive')
  @RequirePermission('lib-002:admin')
  @ApiOperation({
    summary:
      'Waive a fine. School admin only — the librarian cannot waive a fine because the financial-write-off decision belongs to admin authority. Reason is required.',
  })
  async waive(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: WaiveFineDto,
    @Req() req: AuthedRequest,
  ): Promise<FineResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.fines.waive(id, body, actor);
  }
}
