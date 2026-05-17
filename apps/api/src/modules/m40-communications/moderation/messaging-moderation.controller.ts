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
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth/require-permission.decorator';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import {
  ModerationPolicyDto,
  ModerationQueueRowDto,
  ModerationService,
} from './messaging-moderation.service';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string };
}

const POLICY_ACTIONS = ['BLOCK', 'FLAG_FOR_REVIEW', 'ESCALATE_TO_COUNSELLOR'] as const;
const REVIEW_OUTCOMES = ['CONFIRMED_BLOCK', 'RELEASED', 'ESCALATED'] as const;

class CreatePolicyBodyDto {
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsArray() @ArrayNotEmpty() @IsString({ each: true }) keywords!: string[];
  @IsIn(POLICY_ACTIONS as unknown as string[]) keywordAction!:
    | 'BLOCK'
    | 'FLAG_FOR_REVIEW'
    | 'ESCALATE_TO_COUNSELLOR';
}

class UpdatePolicyBodyDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsArray() @ArrayNotEmpty() @IsString({ each: true }) keywords?: string[];
  @IsOptional() @IsIn(POLICY_ACTIONS as unknown as string[]) keywordAction?:
    | 'BLOCK'
    | 'FLAG_FOR_REVIEW'
    | 'ESCALATE_TO_COUNSELLOR';
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class ReviewBodyDto {
  @IsIn(REVIEW_OUTCOMES as unknown as string[]) outcome!:
    | 'CONFIRMED_BLOCK'
    | 'RELEASED'
    | 'ESCALATED';
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

class ListLogQueryDto {
  @IsOptional() @IsString() flagType?: string;
  @IsOptional() @IsString() fromDate?: string;
  @IsOptional() @IsString() toDate?: string;
  @IsOptional() @IsUUID() policyId?: string;
  @IsOptional() @IsInt() @Min(1) @Max(500) limit?: number;
}

@ApiTags('Communications — Moderation')
@ApiBearerAuth()
@Controller('messaging/moderation')
export class ModerationController {
  constructor(
    private readonly moderation: ModerationService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('policies')
  @RequirePermission('com-004:read')
  @ApiOperation({
    summary: 'Admin only — list every moderation policy across PLATFORM/DISTRICT/BUILDING tiers.',
  })
  async listPolicies(
    @Req() req: AuthedRequest,
    @Query('includeInactive') includeInactive?: string,
  ): Promise<ModerationPolicyDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.moderation.listPolicies(includeInactive === 'true', actor);
  }

  @Post('policies')
  @RequirePermission('com-004:write')
  @ApiOperation({
    summary:
      'Admin only — create a BUILDING-tier moderation policy. PLATFORM and DISTRICT tiers are seed-only.',
  })
  async createPolicy(
    @Req() req: AuthedRequest,
    @Body() body: CreatePolicyBodyDto,
  ): Promise<ModerationPolicyDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.moderation.createPolicy(body, actor);
  }

  @Patch('policies/:id')
  @RequirePermission('com-004:write')
  @ApiOperation({
    summary: 'Admin only — update a BUILDING-tier policy. Refuses edits on PLATFORM/DISTRICT.',
  })
  async patchPolicy(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdatePolicyBodyDto,
  ): Promise<ModerationPolicyDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.moderation.patchPolicy(id, body, actor);
  }

  @Get('queue')
  @RequirePermission('com-004:read')
  @ApiOperation({
    summary:
      'Admin only — flagged-message queue. Lists every msg_moderation_log row whose review_outcome is NULL or PENDING.',
  })
  async listQueue(@Req() req: AuthedRequest): Promise<ModerationQueueRowDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.moderation.listQueue(actor);
  }

  @Patch('log/:id/review')
  @RequirePermission('com-004:write')
  @ApiOperation({
    summary:
      'Admin only — review a moderation log entry. RELEASED flips the parent message back to APPROVED. CONFIRMED_BLOCK keeps the BLOCKED state.',
  })
  async review(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReviewBodyDto,
  ): Promise<{ logId: string; messageId: string; outcome: string }> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.moderation.reviewLogEntry(id, body.outcome, body.notes ?? null, actor);
  }

  @Get('log')
  @RequirePermission('com-004:read')
  @ApiOperation({
    summary: 'Admin only — paginated audit trail with optional flag_type / date / policy filters.',
  })
  async listLog(
    @Req() req: AuthedRequest,
    @Query() query: ListLogQueryDto,
  ): Promise<ModerationQueueRowDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.moderation.listLog(query, actor);
  }
}
