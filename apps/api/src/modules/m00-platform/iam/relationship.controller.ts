import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { ActorContextService } from './actor-context.service';
import { RelationshipService } from './relationship.service';
import { canEditFamilyStructure } from './relationship.auth';
import {
  CreateRelationshipDto,
  FamilyTreeDto,
  GetRelationshipsResponseDto,
  RelationshipDto,
  UpdateRelationshipDto,
  VerifyRelationshipDto,
} from './dto/relationship.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

/**
 * Family-structure relationships. Auth-only at the guard level; the
 * per-row authorisation is enforced in each handler because the rules
 * depend on the caller's relationship to :personId, not a static
 * permission code.
 *
 * Access model (Family Structure on Profiles spec §1):
 *   - GET     : self, parent/guardian, or school admin (canViewFamilyStructure)
 *   - POST    : parent/guardian only (canEditFamilyStructure)
 *   - PATCH   : parent/guardian only (canEditFamilyStructure)
 *   - DELETE  : parent/guardian only (canEditFamilyStructure)
 *   - verify  : school admin only
 *
 * GET responses carry a `canEdit` flag (same predicate) so the UI never
 * re-implements the rule. The flag is a rendering hint; every mutation
 * re-checks server-side.
 */
@ApiTags('Family Structure')
@ApiBearerAuth()
@Controller('people')
export class RelationshipController {
  constructor(
    private readonly relationships: RelationshipService,
    private readonly actors: ActorContextService,
  ) {}

  @Get(':personId/relationships')
  @ApiOperation({ summary: 'Direct relationships + derived siblings for a person.' })
  async list(
    @Req() req: AuthedRequest,
    @Param('personId') personId: string,
  ): Promise<GetRelationshipsResponseDto> {
    await this.assertCanView(req, personId);
    const resp = await this.relationships.getRelationships(personId);
    return { ...resp, canEdit: await this.computeCanEdit(req, personId) };
  }

  @Post(':personId/relationships')
  @ApiOperation({ summary: 'Add a relationship (auto-creates the reciprocal for CampusOS users).' })
  async create(
    @Req() req: AuthedRequest,
    @Param('personId') personId: string,
    @Body() dto: CreateRelationshipDto,
  ): Promise<RelationshipDto> {
    await this.assertCanEdit(req, personId);
    return this.relationships.addRelationship(personId, dto, req.user!.personId);
  }

  @Patch(':personId/relationships/:id')
  @ApiOperation({ summary: 'Update custody / notes / dates on a relationship and its reciprocal.' })
  async update(
    @Req() req: AuthedRequest,
    @Param('personId') personId: string,
    @Param('id') id: string,
    @Body() dto: UpdateRelationshipDto,
  ): Promise<RelationshipDto> {
    await this.assertCanEdit(req, personId);
    return this.relationships.updateRelationship(personId, id, dto);
  }

  @Delete(':personId/relationships/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a relationship and its reciprocal.' })
  async remove(
    @Req() req: AuthedRequest,
    @Param('personId') personId: string,
    @Param('id') id: string,
  ): Promise<void> {
    await this.assertCanEdit(req, personId);
    await this.relationships.deleteRelationship(personId, id);
  }

  @Get(':personId/family-tree')
  @ApiOperation({ summary: 'Structured family tree (parents, children, grandparents, siblings).' })
  async familyTree(
    @Req() req: AuthedRequest,
    @Param('personId') personId: string,
  ): Promise<FamilyTreeDto> {
    await this.assertCanView(req, personId);
    const tree = await this.relationships.getFamilyTree(personId);
    return { ...tree, canEdit: await this.computeCanEdit(req, personId) };
  }

  @Patch(':personId/relationships/:id/verify')
  @ApiOperation({
    summary: 'School admin marks a relationship as verified (documentation on file).',
  })
  async verify(
    @Req() req: AuthedRequest,
    @Param('personId') personId: string,
    @Param('id') id: string,
    @Body() dto: VerifyRelationshipDto,
  ): Promise<RelationshipDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only school administrators can verify relationships.');
    }
    return this.relationships.verifyRelationship(personId, id, req.user!.personId, dto.verified);
  }

  // ─── Authorisation helpers ────────────────────────────────────

  /** Self, an active guardian of the person, or a school admin. */
  private async assertCanView(req: AuthedRequest, personId: string): Promise<void> {
    const caller = req.user!.personId;
    if (caller === personId) return;
    if (await this.relationships.isActiveGuardianOf(caller, personId)) return;
    const actor = await this.actors.resolveActor(req.user!.sub, caller);
    if (actor.isSchoolAdmin) return;
    throw new ForbiddenException('You are not authorised to view this person’s family structure.');
  }

  /** Parent/guardian-only edit — the canEditFamilyStructure predicate. */
  private async assertCanEdit(req: AuthedRequest, personId: string): Promise<void> {
    if (!(await this.computeCanEdit(req, personId))) {
      throw new ForbiddenException(
        'Only a parent or guardian can edit this person’s family structure.',
      );
    }
  }

  /**
   * Resolve the caller's edit permission for `personId` via the shared
   * canEditFamilyStructure predicate. Used both to gate mutations and to
   * stamp the `canEdit` flag on GET responses, so the two never drift.
   */
  private async computeCanEdit(req: AuthedRequest, personId: string): Promise<boolean> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return canEditFamilyStructure(actor, personId, (caller, target) =>
      this.relationships.isActiveGuardianOf(caller, target),
    );
  }
}
