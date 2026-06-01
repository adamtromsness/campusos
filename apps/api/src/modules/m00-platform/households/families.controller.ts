import { Body, Controller, Param, ParseUUIDPipe, Patch, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { FamilyChildrenService } from './family-children.service';
import { FamilyViewDto, SetPrimaryGuardianDto } from './dto/family-child.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

/**
 * /families/:familyId — family-scoped actions that take an explicit
 * family id (vs the current-user-scoped `/family` surface). Auth-only;
 * the service enforces that the caller is a member of `:familyId`
 * (cross-family → 404) and that the action's target is valid.
 */
@ApiTags('Family')
@ApiBearerAuth()
@Controller('families')
export class FamiliesController {
  constructor(private readonly children: FamilyChildrenService) {}

  @Patch(':familyId/primary-guardian')
  @ApiOperation({
    summary:
      "Reassign the family's primary contact to a different ACTIVE guardian. Atomic demote-old/promote-new (exactly one primary). 'Primary' is a contact label only — it does NOT change guardianship or edit rights. 400 if the target is not an active guardian of this family.",
  })
  async setPrimaryGuardian(
    @Req() req: AuthedRequest,
    @Param('familyId', ParseUUIDPipe) familyId: string,
    @Body() dto: SetPrimaryGuardianDto,
  ): Promise<FamilyViewDto | null> {
    return this.children.setPrimaryGuardian(req.user!.personId, familyId, dto.guardianPersonId);
  }
}
