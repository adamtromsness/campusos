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
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { HallPassService } from './hall-pass.service';
import {
  CreateHallPassDto,
  HallPassResponseDto,
  HallPassSettingsResponseDto,
  RecallHallPassDto,
  ReturnHallPassDto,
  UpdateHallPassSettingsDto,
} from './dto/hall-pass.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Classroom Advanced — Hall Passes')
@ApiBearerAuth()
@Controller('classroom')
export class HallPassController {
  constructor(
    private readonly passes: HallPassService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('hall-pass-settings')
  @RequirePermission('att-005:read')
  @ApiOperation({
    summary:
      'Read the per-school hall pass configuration. Lazy-initialised on first read with the schema defaults.',
  })
  async getSettings(): Promise<HallPassSettingsResponseDto> {
    return this.passes.getSettings();
  }

  @Patch('hall-pass-settings')
  @RequirePermission('att-005:admin')
  @ApiOperation({
    summary:
      'Update hall pass settings. Admin-only. The HallPassService.assertWithinLimits gate consults this row before issuing every new pass.',
  })
  async updateSettings(
    @Body() body: UpdateHallPassSettingsDto,
    @Req() req: AuthedRequest,
  ): Promise<HallPassSettingsResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.passes.updateSettings(body, actor);
  }

  @Get('hall-passes')
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['ACTIVE', 'RETURNED', 'OVERDUE', 'RECALLED'],
  })
  @RequirePermission('att-005:read')
  @ApiOperation({
    summary:
      'List hall passes. Row-scoped: admins see school-wide; teachers see passes for classes they teach; students see only their own. Parents and other personas see an empty list.',
  })
  async list(
    @Query('status') status: string | undefined,
    @Req() req: AuthedRequest,
  ): Promise<HallPassResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.passes.list(actor, status);
  }

  @Get('hall-passes/active')
  @RequirePermission('att-005:read')
  @ApiOperation({
    summary:
      'Convenience: same row scope as GET /hall-passes but pinned to status=ACTIVE for the daily roster card.',
  })
  async listActive(@Req() req: AuthedRequest): Promise<HallPassResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.passes.listActive(actor);
  }

  @Get('hall-passes/:id')
  @RequirePermission('att-005:read')
  @ApiOperation({ summary: 'Fetch a single hall pass with student + class + issuer joined.' })
  async getById(@Param('id', ParseUUIDPipe) id: string): Promise<HallPassResponseDto> {
    return this.passes.getById(id);
  }

  @Post('hall-passes')
  @RequirePermission('att-005:write')
  @ApiOperation({
    summary:
      'Issue a hall pass. Validates concurrent + daily limits inside a tenant tx with a per-class advisory lock so concurrent issues serialise. Emits cls.hall_pass.issued.',
  })
  async issue(
    @Body() body: CreateHallPassDto,
    @Req() req: AuthedRequest,
  ): Promise<HallPassResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.passes.issue(body, actor);
  }

  @Patch('hall-passes/:id/return')
  @RequirePermission('att-005:write')
  @ApiOperation({
    summary:
      'Mark a pass returned. Caller must be admin or the issuing class teacher. Locked-row state transition inside the tenant tx.',
  })
  async returnPass(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReturnHallPassDto,
    @Req() req: AuthedRequest,
  ): Promise<HallPassResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.passes.returnPass(id, body, actor);
  }

  @Patch('hall-passes/:id/recall')
  @RequirePermission('att-005:write')
  @ApiOperation({
    summary:
      'Recall a pass. Caller must be admin or the issuing teacher. Reason is required and appended to notes.',
  })
  async recall(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RecallHallPassDto,
    @Req() req: AuthedRequest,
  ): Promise<HallPassResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.passes.recall(id, body, actor);
  }
}
