import {
  Body,
  Controller,
  Get,
  Param,
  ParseBoolPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth/require-permission.decorator';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { ReferralTypeService } from './referral-type.service';
import {
  CreateReferralTypeDto,
  ReferralTypeResponseDto,
  UpdateReferralTypeDto,
} from './dto/counselling.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Counselling Referral Types')
@ApiBearerAuth()
@Controller('counselling/referral-types')
export class ReferralTypeController {
  constructor(
    private readonly types: ReferralTypeService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('cou-002:read')
  @ApiOperation({
    summary:
      'List active referral types for this school. Drives the referral-form dropdown. Pass includeInactive=true to see deactivated types (admins).',
  })
  async list(
    @Query('includeInactive', new ParseBoolPipe({ optional: true })) includeInactive?: boolean,
  ): Promise<ReferralTypeResponseDto[]> {
    return this.types.list(includeInactive ?? false);
  }

  @Post()
  @RequirePermission('cou-002:admin')
  @ApiOperation({
    summary:
      'Admin creates a referral type. UNIQUE(school_id, name) — duplicate names rejected with a friendly 400.',
  })
  async create(
    @Body() body: CreateReferralTypeDto,
    @Req() req: AuthedRequest,
  ): Promise<ReferralTypeResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.types.create(body, actor);
  }

  @Patch(':id')
  @RequirePermission('cou-002:admin')
  @ApiOperation({
    summary:
      'Admin updates a referral type. is_active=false soft-deactivates the type so historical referrals retain their FK while new submissions are blocked.',
  })
  async patch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateReferralTypeDto,
    @Req() req: AuthedRequest,
  ): Promise<ReferralTypeResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.types.patch(id, body, actor);
  }
}
