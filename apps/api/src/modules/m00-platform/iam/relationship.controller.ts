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
import { PrismaClient } from '@prisma/client';
import { ActorContextService } from './actor-context.service';
import { RelationshipService } from './relationship.service';
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

// Age (whole years) at or above which a person may edit their OWN
// relationships. Below this, only a parent/guardian or school admin can.
const SELF_EDIT_MIN_AGE = 18;

/**
 * Family-structure relationships (Step 3). Auth-only at the guard level;
 * the per-row authorisation (self / parent-guardian / school-admin)
 * is enforced in each handler because the rules depend on the
 * caller's relationship to :personId, not a static permission code.
 *
 * Access model (design §9):
 *   - GET     : self, parent/guardian, or school admin
 *   - POST    : parent/guardian, or self if an adult
 *   - PATCH   : parent/guardian, self (if adult), or school admin
 *   - DELETE  : parent/guardian, or self if an adult
 *   - verify  : school admin only
 */
@ApiTags('Family Structure')
@ApiBearerAuth()
@Controller('people')
export class RelationshipController {
  constructor(
    private readonly relationships: RelationshipService,
    private readonly actors: ActorContextService,
    private readonly prisma: PrismaClient,
  ) {}

  @Get(':personId/relationships')
  @ApiOperation({ summary: 'Direct relationships + derived siblings for a person.' })
  async list(
    @Req() req: AuthedRequest,
    @Param('personId') personId: string,
  ): Promise<GetRelationshipsResponseDto> {
    await this.assertCanView(req, personId);
    return this.relationships.getRelationships(personId);
  }

  @Post(':personId/relationships')
  @ApiOperation({ summary: 'Add a relationship (auto-creates the reciprocal for CampusOS users).' })
  async create(
    @Req() req: AuthedRequest,
    @Param('personId') personId: string,
    @Body() dto: CreateRelationshipDto,
  ): Promise<RelationshipDto> {
    await this.assertCanManage(req, personId);
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
    await this.assertCanManage(req, personId, { allowSchoolAdmin: true });
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
    await this.assertCanManage(req, personId);
    await this.relationships.deleteRelationship(personId, id);
  }

  @Get(':personId/family-tree')
  @ApiOperation({ summary: 'Structured family tree (parents, children, grandparents, siblings).' })
  async familyTree(
    @Req() req: AuthedRequest,
    @Param('personId') personId: string,
  ): Promise<FamilyTreeDto> {
    await this.assertCanView(req, personId);
    return this.relationships.getFamilyTree(personId);
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

  private async assertCanView(req: AuthedRequest, personId: string): Promise<void> {
    const caller = req.user!.personId;
    if (caller === personId) return;
    if (await this.relationships.isGuardianOf(caller, personId)) return;
    const actor = await this.actors.resolveActor(req.user!.sub, caller);
    if (actor.isSchoolAdmin) return;
    throw new ForbiddenException('You are not authorised to view this person’s family structure.');
  }

  private async assertCanManage(
    req: AuthedRequest,
    personId: string,
    opts: { allowSchoolAdmin?: boolean } = {},
  ): Promise<void> {
    const caller = req.user!.personId;
    if (await this.relationships.isGuardianOf(caller, personId)) return;
    if (caller === personId && (await this.isAdult(personId))) return;
    if (opts.allowSchoolAdmin) {
      const actor = await this.actors.resolveActor(req.user!.sub, caller);
      if (actor.isSchoolAdmin) return;
    }
    throw new ForbiddenException(
      'You are not authorised to manage this person’s family structure.',
    );
  }

  /**
   * A caller may edit their OWN relationships only if they're an adult.
   * Unknown DOB is treated as adult — adults (guardians/staff) frequently
   * have no DOB on file, whereas enrolled students are seeded with one.
   */
  private async isAdult(personId: string): Promise<boolean> {
    const person = await this.prisma.iamPerson.findUnique({
      where: { id: personId },
      select: { dateOfBirth: true },
    });
    const dob = person?.dateOfBirth;
    if (!dob) return true;
    const now = new Date();
    let age = now.getUTCFullYear() - dob.getUTCFullYear();
    const m = now.getUTCMonth() - dob.getUTCMonth();
    if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) age--;
    return age >= SELF_EDIT_MIN_AGE;
  }
}
