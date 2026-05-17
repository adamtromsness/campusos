import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth';
import { ActorContextService } from '@modules/m00-platform';
import { PeerReviewService } from './peer-review.service';
import {
  AssignPeerReviewsDto,
  CreatePeerReviewAssignmentDto,
  PeerReviewAssignmentResponseDto,
  PeerReviewResponseDto,
  SubmitPeerReviewDto,
} from './dto/peer-review.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Classroom Advanced — Peer Review')
@ApiBearerAuth()
@Controller('classroom')
export class PeerReviewController {
  constructor(
    private readonly peerReviews: PeerReviewService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('assignments/:id/peer-review')
  @RequirePermission('tch-002:read')
  @ApiOperation({ summary: 'Fetch the peer review config for an assignment if enabled.' })
  async getForAssignment(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PeerReviewAssignmentResponseDto | null> {
    return this.peerReviews.getForAssignment(id);
  }

  @Post('assignments/:id/peer-review')
  @RequirePermission('tch-002:write')
  @ApiOperation({
    summary:
      'Enable peer review on an assignment. UNIQUE(assignment_id) at the schema layer means re-enabling returns 400 — patch the existing config instead.',
  })
  async enable(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreatePeerReviewAssignmentDto,
    @Req() req: AuthedRequest,
  ): Promise<PeerReviewAssignmentResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.peerReviews.enableForAssignment(id, body, actor);
  }

  @Post('peer-review-assignments/:id/assign')
  @RequirePermission('tch-002:write')
  @ApiOperation({
    summary:
      'Distribute submissions for review. RANDOM mode auto-distributes via deterministic rotation. TEACHER_ASSIGNED requires manualAssignments map. Self-review prevented at the service layer; UNIQUE keystone is the schema-side belt-and-braces.',
  })
  async assign(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AssignPeerReviewsDto,
    @Req() req: AuthedRequest,
  ): Promise<PeerReviewResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.peerReviews.assignReviews(id, body, actor);
  }

  @Get('peer-review-assignments/:id/reviews')
  @RequirePermission('tch-002:read')
  @ApiOperation({
    summary:
      'Teacher view of all reviews under a peer review assignment. Reviewer identity is always shown to staff for audit, regardless of is_anonymous.',
  })
  async listForAssignment(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<PeerReviewResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.peerReviews.listForAssignment(id, actor);
  }

  @Get('peer-reviews/my')
  @RequirePermission('tch-002:read')
  @ApiOperation({
    summary:
      'Student review queue — peer reviews I have been assigned. Reviewer (caller) sees their own identity in every row.',
  })
  async listMy(@Req() req: AuthedRequest): Promise<PeerReviewResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.peerReviews.listMy(actor);
  }

  @Get('submissions/:id/peer-reviews')
  @RequirePermission('tch-002:read')
  @ApiOperation({
    summary:
      'Reviews received on a submission. ANONYMISATION KEYSTONE: when the parent peer review assignment is is_anonymous=true and the caller is a student (not staff), the reviewer identity columns are stripped from the response. Teachers and admins always see the full identity for audit.',
  })
  async listForSubmission(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<PeerReviewResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.peerReviews.listForSubmission(id, actor);
  }

  @Patch('peer-reviews/:id')
  @RequirePermission('tch-002:write')
  @ApiOperation({
    summary:
      'Student submits feedback + optional overall rating. Locked-row PATCH inside one tenant tx so concurrent submits serialise. Refuses non-ASSIGNED transitions.',
  })
  async submit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SubmitPeerReviewDto,
    @Req() req: AuthedRequest,
  ): Promise<PeerReviewResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.peerReviews.submit(id, body, actor);
  }

  @Patch('peer-reviews/:id/teacher-review')
  @RequirePermission('tch-002:write')
  @ApiOperation({
    summary:
      'Teacher marks a peer review as reviewed. Stamps teacher_reviewed_by + teacher_reviewed_at and flips status to REVIEWED_BY_TEACHER.',
  })
  async markTeacherReviewed(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<PeerReviewResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.peerReviews.markTeacherReviewed(id, actor);
  }
}
