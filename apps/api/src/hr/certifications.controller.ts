import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { CertificationService } from './certification.service';
import { CertificationResponseDto, VerifyCertificationDto } from './dto/certification.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Certifications')
@ApiBearerAuth()
@Controller('certifications')
export class CertificationsController {
  constructor(
    private readonly certifications: CertificationService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('expiring-soon')
  @RequirePermission('hr-004:read')
  @ApiOperation({
    summary: 'List certifications expiring within 90 days (or overdue) — admin sweep',
  })
  async listExpiringSoon(): Promise<CertificationResponseDto[]> {
    return this.certifications.listExpiringSoon();
  }

  @Get(':id')
  @RequirePermission('hr-004:read')
  @ApiOperation({ summary: 'Get a certification by id' })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<CertificationResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.certifications.getById(id, actor);
  }

  @Patch(':id/verify')
  @RequirePermission('hr-004:write')
  @ApiOperation({ summary: 'Set the verification status of a certification (admin only)' })
  async verify(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: VerifyCertificationDto,
    @Req() req: AuthedRequest,
  ): Promise<CertificationResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.certifications.verify(id, body, actor);
  }
}
