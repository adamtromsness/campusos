import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { DietaryProfileService } from './dietary-profile.service';
import {
  CreateDietaryProfileDto,
  DietaryProfileResponseDto,
  UpdateDietaryProfileDto,
} from './dto/health.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Health Dietary Profiles')
@ApiBearerAuth()
@Controller()
export class DietaryProfileController {
  constructor(
    private readonly dietary: DietaryProfileService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('health/allergen-alerts')
  @RequirePermission('hlt-005:read')
  @ApiOperation({
    summary:
      'Allergen alerts — every student in the school with pos_allergen_alert=true. Hits the Step 3 partial INDEX. The future POS / cafeteria integration polls this endpoint. Nurse / counsellor / admin only at the service layer.',
  })
  async allergenAlerts(@Req() req: AuthedRequest): Promise<DietaryProfileResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.dietary.listAllergenAlerts(actor);
  }

  @Get('health/students/:studentId/dietary')
  @RequirePermission('hlt-001:read')
  @ApiOperation({
    summary:
      "Get a student's dietary profile. Returns 200 with null body when no profile exists. Service-layer row scope mirrors the Step 5 health record (admin/nurse all; parent own children; teacher own-class students — teachers DO see allergen lists for classroom safety on snacks/parties). Writes a VIEW_DIETARY audit row.",
  })
  async get(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Req() req: AuthedRequest,
  ): Promise<DietaryProfileResponseDto | null> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.dietary.getForStudent(studentId, actor);
  }

  @Post('health/students/:studentId/dietary')
  @RequirePermission('hlt-005:write')
  @ApiOperation({
    summary:
      "Create a student's dietary profile. Nurse / counsellor / admin only. UNIQUE on student_id rejects duplicates with a friendly 400.",
  })
  async create(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Body() body: CreateDietaryProfileDto,
    @Req() req: AuthedRequest,
  ): Promise<DietaryProfileResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.dietary.create(studentId, body, actor);
  }

  @Patch('health/dietary-profiles/:id')
  @RequirePermission('hlt-005:write')
  @ApiOperation({
    summary:
      'Update a dietary profile. Nurse / counsellor / admin only. Stamps updated_by from actor.accountId.',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateDietaryProfileDto,
    @Req() req: AuthedRequest,
  ): Promise<DietaryProfileResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.dietary.update(id, body, actor);
  }
}
