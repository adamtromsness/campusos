import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { CoordinatedCareService } from './coordinated-care.service';
import { CoordinatedCareNoteDto, CreateCoordinatedCareNoteDto } from './dto/counselling.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

/**
 * Coordinated Care controller. Both endpoints require the
 * **intersection** of `hlt-001:read` AND `cou-007:read`. The
 * project's PermissionGuard uses OR semantics (`hasAnyPermission`), so
 * we gate at the controller on the narrower of the two codes
 * (`cou-007:read` — held only by Staff + Admin in the IAM seed) and
 * additionally enforce the intersection in the service via
 * `assertIntersectionAccess(actor)`. Effectively: teachers, parents,
 * and students never hold cou-007:read, so they 403 at the gate;
 * Staff + Admin always hold both codes, so they pass both checks.
 */
@ApiTags('Counselling Coordinated Care')
@ApiBearerAuth()
@Controller('counselling/coordinated-care')
export class CoordinatedCareController {
  constructor(
    private readonly care: CoordinatedCareService,
    private readonly actors: ActorContextService,
  ) {}

  @Get(':studentId')
  @RequirePermission('cou-007:read')
  @ApiOperation({
    summary:
      'Read coordinated care notes for a student. INTERSECTION of hlt-001:read AND cou-007:read — nurse + counsellor team members only. Teachers and parents always 403.',
  })
  async listForStudent(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Req() req: AuthedRequest,
  ): Promise<CoordinatedCareNoteDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.care.listForStudent(studentId, actor);
  }

  @Post(':studentId')
  @RequirePermission('cou-007:read')
  @ApiOperation({
    summary:
      'Add a coordinated care note. authorRole must match the calling actor team — NURSE requires hlt-001:write, COUNSELLOR requires cou-001:write or cou-007:write. Admin bypass.',
  })
  async create(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Body() body: CreateCoordinatedCareNoteDto,
    @Req() req: AuthedRequest,
  ): Promise<CoordinatedCareNoteDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.care.create(studentId, body, actor);
  }
}
