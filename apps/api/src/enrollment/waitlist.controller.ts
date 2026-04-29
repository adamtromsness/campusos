import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { WaitlistService } from './waitlist.service';
import {
  ListWaitlistQueryDto,
  OfferFromWaitlistDto,
  WaitlistEntryResponseDto,
} from './dto/waitlist.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Enrollment Waitlist')
@ApiBearerAuth()
@Controller('waitlist')
export class WaitlistController {
  constructor(
    private readonly waitlist: WaitlistService,
    private readonly actors: ActorContextService,
  ) {}

  @Get()
  @RequirePermission('stu-003:read')
  @ApiOperation({ summary: 'List waitlist entries (admin-only at service layer)' })
  async list(
    @Query() query: ListWaitlistQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<WaitlistEntryResponseDto[]> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.waitlist.list(query, actor);
  }

  @Patch(':id/offer')
  @RequirePermission('stu-003:admin')
  @ApiOperation({ summary: 'Promote a waitlisted applicant to an offer (admin only)' })
  async offerFromWaitlist(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: OfferFromWaitlistDto,
    @Req() req: AuthedRequest,
  ): Promise<WaitlistEntryResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.waitlist.offerFromWaitlist(id, body, actor);
  }
}
