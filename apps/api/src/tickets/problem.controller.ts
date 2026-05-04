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
import { ProblemService } from './problem.service';
import {
  CreateProblemDto,
  LinkTicketsDto,
  ListProblemsQueryDto,
  ProblemResponseDto,
  ResolveProblemDto,
  UpdateProblemDto,
} from './dto/ticket.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Ticket Problems')
@ApiBearerAuth()
@Controller('problems')
export class ProblemController {
  constructor(
    private readonly problems: ProblemService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('it-001:read')
  @ApiOperation({
    summary: 'Admin-only list of problems with linked-ticket counts inline. Service-layer 403 for non-admins.',
  })
  async list(
    @Query() query: ListProblemsQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<ProblemResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.problems.list(query, actor);
  }

  @Get(':id')
  @RequirePermission('it-001:read')
  @ApiOperation({ summary: 'Problem detail with linked ticket ids inline. Admin-only.' })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<ProblemResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.problems.getById(id, actor);
  }

  @Post()
  @RequirePermission('it-001:admin')
  @ApiOperation({
    summary:
      'Create a problem optionally seeded with a list of ticket ids. Admin-only. Status defaults to OPEN.',
  })
  async create(
    @Body() body: CreateProblemDto,
    @Req() req: AuthedRequest,
  ): Promise<ProblemResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.problems.create(body, actor);
  }

  @Patch(':id')
  @RequirePermission('it-001:admin')
  @ApiOperation({
    summary:
      'Patch problem fields. Status RESOLVED is rejected here — use POST /:id/resolve which runs the batch ticket-flip in one tx.',
  })
  async patch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateProblemDto,
    @Req() req: AuthedRequest,
  ): Promise<ProblemResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.problems.patch(id, body, actor);
  }

  @Post(':id/link')
  @RequirePermission('it-001:admin')
  @ApiOperation({ summary: 'Link additional tickets to this problem. Skips already-linked ids.' })
  async link(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: LinkTicketsDto,
    @Req() req: AuthedRequest,
  ): Promise<ProblemResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.problems.link(id, body, actor);
  }

  @Patch(':id/resolve')
  @RequirePermission('it-001:admin')
  @ApiOperation({
    summary:
      'Resolve a problem. Locks the problem row + every linked active ticket FOR UPDATE in one tx. Batch-flips matching tickets to RESOLVED, emits one tkt.ticket.resolved per flipped ticket, and writes a STATUS_CHANGE activity row per ticket.',
  })
  async resolve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ResolveProblemDto,
    @Req() req: AuthedRequest,
  ): Promise<{ problem: ProblemResponseDto; ticketsFlipped: string[] }> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.problems.resolveBatch(id, body, actor);
  }
}
