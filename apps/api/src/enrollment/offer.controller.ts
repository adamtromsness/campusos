import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { OfferService } from './offer.service';
import {
  CreateOfferDto,
  OfferResponseDto,
  RespondToOfferDto,
  UpdateOfferConditionsMetDto,
} from './dto/offer.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Enrollment Offers')
@ApiBearerAuth()
@Controller()
export class OfferController {
  constructor(
    private readonly offers: OfferService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('offers')
  @RequirePermission('stu-003:read')
  @ApiOperation({ summary: 'List offers (admin: all; parent: own)' })
  async list(@Req() req: AuthedRequest): Promise<OfferResponseDto[]> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.offers.list(actor);
  }

  @Get('offers/:id')
  @RequirePermission('stu-003:read')
  @ApiOperation({ summary: 'Get an offer (row-scoped to admin or owning parent)' })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<OfferResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.offers.getById(id, actor);
  }

  @Post('applications/:id/offer')
  @RequirePermission('stu-003:admin')
  @ApiOperation({ summary: 'Issue an offer on an application (admin only)' })
  async issue(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateOfferDto,
    @Req() req: AuthedRequest,
  ): Promise<OfferResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.offers.issue(id, body, actor);
  }

  @Patch('offers/:id/conditions-met')
  @RequirePermission('stu-003:admin')
  @ApiOperation({ summary: 'Verify or fail conditions on a CONDITIONAL offer (admin only)' })
  async setConditionsMet(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateOfferConditionsMetDto,
    @Req() req: AuthedRequest,
  ): Promise<OfferResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.offers.setConditionsMet(id, body, actor);
  }

  @Patch('offers/:id/respond')
  @RequirePermission('stu-003:write')
  @ApiOperation({
    summary:
      "Respond to an offer (parent or admin). On ACCEPT, application status flips to ENROLLED and enr.student.enrolled fires.",
  })
  async respond(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RespondToOfferDto,
    @Req() req: AuthedRequest,
  ): Promise<OfferResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.offers.respond(id, body, actor);
  }
}
