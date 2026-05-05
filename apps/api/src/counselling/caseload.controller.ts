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
import { CaseloadService } from './caseload.service';
import {
  CaseloadResponseDto,
  CloseCaseloadDto,
  CreateCaseloadDto,
  ListCaseloadsQueryDto,
  UpdateCaseloadDto,
} from './dto/counselling.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Counselling Caseloads')
@ApiBearerAuth()
@Controller('counselling/caseloads')
export class CaseloadController {
  constructor(
    private readonly caseloads: CaseloadService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('cou-001:read')
  @ApiOperation({
    summary:
      'List caseloads visible to the caller. Admins see all. Counsellors see own assignments + class-scoped students. Parents see own children with notes stripped.',
  })
  async list(
    @Query() query: ListCaseloadsQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<CaseloadResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.caseloads.list(query, actor);
  }

  @Get(':id')
  @RequirePermission('cou-001:read')
  @ApiOperation({
    summary:
      'Fetch a single caseload with inlined session count, last session date, and linked BIP id when set. 404 to non-participants.',
  })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<CaseloadResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.caseloads.getById(id, actor);
  }

  @Post()
  @RequirePermission('cou-001:write')
  @ApiOperation({
    summary:
      'Open a new caseload. Counsellor or admin only. Pre-flights the partial UNIQUE keystone (one primary counsellor per student per year) and surfaces the conflicting caseload id in a friendly 400.',
  })
  async create(
    @Body() body: CreateCaseloadDto,
    @Req() req: AuthedRequest,
  ): Promise<CaseloadResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.caseloads.create(body, actor);
  }

  @Patch(':id')
  @RequirePermission('cou-001:write')
  @ApiOperation({
    summary: 'Update concern and notes on a caseload. Admin or the assigned counsellor only.',
  })
  async patch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateCaseloadDto,
    @Req() req: AuthedRequest,
  ): Promise<CaseloadResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.caseloads.patch(id, body, actor);
  }

  @Patch(':id/close')
  @RequirePermission('cou-001:write')
  @ApiOperation({
    summary:
      'Close a caseload. Stamps closure_reason + closed_at + status=CLOSED in one locked tx so the partial UNIQUE keystone releases atomically.',
  })
  async close(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CloseCaseloadDto,
    @Req() req: AuthedRequest,
  ): Promise<CaseloadResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.caseloads.close(id, body, actor);
  }
}
