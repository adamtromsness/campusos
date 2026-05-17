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
import { InterlibraryLoanService } from './interlibrary-loan.service';
import {
  CreateInterlibraryLoanDto,
  InterlibraryLoanResponseDto,
  ListIllArgsDto,
  UpdateInterlibraryLoanDto,
} from './dto/library-advanced.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Library Advanced — Interlibrary Loans')
@ApiBearerAuth()
@Controller()
export class InterlibraryLoanController {
  constructor(
    private readonly ills: InterlibraryLoanService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('library/ill')
  @RequirePermission('lib-002:read')
  @ApiOperation({
    summary:
      'List interlibrary loan records. Filters by status (REQUESTED / IN_TRANSIT / ACTIVE / RETURNED / OVERDUE / LOST) and loanDirection (BORROWED / LENT).',
  })
  async list(@Query() args: ListIllArgsDto): Promise<InterlibraryLoanResponseDto[]> {
    return this.ills.list(args);
  }

  @Get('library/ill/overdue')
  @RequirePermission('lib-002:read')
  @ApiOperation({
    summary:
      'List OVERDUE interlibrary loans (admin / librarian only at the service layer). Drives the overdue dashboard widget on the ILL admin page.',
  })
  async listOverdue(@Req() req: AuthedRequest): Promise<InterlibraryLoanResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.ills.listOverdue(actor);
  }

  @Get('library/ill/:id')
  @RequirePermission('lib-002:read')
  async getById(@Param('id', ParseUUIDPipe) id: string): Promise<InterlibraryLoanResponseDto> {
    return this.ills.getById(id);
  }

  @Post('library/ill')
  @RequirePermission('lib-002:write')
  @ApiOperation({
    summary:
      'Librarian or admin creates an interlibrary loan record. BORROWED rows may omit catalogueItemId (the title is not in our catalogue). LENT rows require catalogueItemId per the schema direction_chk.',
  })
  async create(
    @Body() body: CreateInterlibraryLoanDto,
    @Req() req: AuthedRequest,
  ): Promise<InterlibraryLoanResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.ills.create(body, actor);
  }

  @Patch('library/ill/:id')
  @RequirePermission('lib-002:write')
  @ApiOperation({
    summary:
      'Librarian or admin updates an interlibrary loan record. Status transitions are gated by the service-layer ALLOWED_TRANSITIONS map — REQUESTED → IN_TRANSIT/ACTIVE/LOST, IN_TRANSIT → ACTIVE/LOST/RETURNED, ACTIVE → RETURNED/OVERDUE/LOST, OVERDUE → RETURNED/LOST. RETURNED + LOST are terminal.',
  })
  async patch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateInterlibraryLoanDto,
    @Req() req: AuthedRequest,
  ): Promise<InterlibraryLoanResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.ills.patch(id, body, actor);
  }
}
