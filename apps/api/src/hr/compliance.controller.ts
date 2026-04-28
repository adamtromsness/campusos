import { Controller, Get, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { TrainingComplianceService } from './training-compliance.service';
import { ComplianceDashboardDto } from './dto/compliance.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Compliance')
@ApiBearerAuth()
@Controller('compliance')
export class ComplianceController {
  constructor(
    private readonly compliance: TrainingComplianceService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('dashboard')
  @RequirePermission('hr-004:read')
  @ApiOperation({ summary: 'School-wide training compliance dashboard (admin only)' })
  async dashboard(@Req() req: AuthedRequest): Promise<ComplianceDashboardDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.compliance.getDashboard(actor);
  }
}
