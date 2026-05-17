import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth';
import { ActorContextService } from '@modules/m00-platform';
import { MedicalClearanceService } from './medical-clearance.service';
import {
  MedicalClearanceResponseDto,
  ReviewClearanceDto,
  UploadClearanceDto,
} from './dto/athletics.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string };
}

@ApiTags('Athletics — Medical Clearances')
@ApiBearerAuth()
@Controller('athletics')
export class MedicalClearanceController {
  constructor(
    private readonly clearances: MedicalClearanceService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('injuries/:id/clearances')
  @RequirePermission('ath-005:read')
  async list(@Param('id', ParseUUIDPipe) id: string): Promise<MedicalClearanceResponseDto[]> {
    return this.clearances.listForInjury(id);
  }

  @Post('injuries/:id/clearances')
  @RequirePermission('ath-005:write')
  @ApiOperation({
    summary:
      'Upload a physician clearance document. Status defaults to PENDING — the AD then reviews and accepts via PATCH /medical-clearances/:id/review.',
  })
  async upload(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UploadClearanceDto,
  ): Promise<MedicalClearanceResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.clearances.upload(id, body, actor);
  }

  @Patch('medical-clearances/:id/review')
  @RequirePermission('ath-005:write')
  @ApiOperation({
    summary:
      'Accept or reject a clearance. On ACCEPTED, the parent injury flips to CLEARED only when (for CONCUSSION_PROTOCOL injuries) all 6 protocol steps are completed. The roster member eligibility is restored to ELIGIBLE atomically.',
  })
  async review(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReviewClearanceDto,
  ): Promise<MedicalClearanceResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.clearances.review(id, body, actor);
  }
}
