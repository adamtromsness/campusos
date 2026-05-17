import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth/require-permission.decorator';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { ReviewService } from './review.service';
import { CreateReviewDto, ReviewResponseDto, UpdateReviewDto } from './dto/library.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Library — Reviews')
@ApiBearerAuth()
@Controller()
export class ReviewController {
  constructor(
    private readonly reviews: ReviewService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('library/catalogue/:id/reviews')
  @RequirePermission('lib-001:read')
  @ApiOperation({
    summary:
      "List reviews for a catalogue item. Conceptually a catalogue-read surface so it is gated on lib-001:read (held by Teacher / Parent / Student / Staff / Admin) — readers see their book's reviews on the catalogue page. Only is_approved=true rows are returned for non-moderator readers (the librarian soft-hide path). Sorted by created_at DESC.",
  })
  async listForItem(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<ReviewResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.reviews.listForItem(id, actor);
  }

  @Post('library/catalogue/:id/reviews')
  @RequirePermission('lib-003:write')
  @ApiOperation({
    summary:
      'STUDENT-INPUT — student submits a book review. UNIQUE(item_id, student_id) means each student gets exactly one review per item; duplicate POST returns a friendly 400 telling the caller to PATCH instead. The review is is_approved=true on creation; the librarian uses the /hide endpoint to soft-hide inappropriate reviews.',
  })
  async create(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateReviewDto,
    @Req() req: AuthedRequest,
  ): Promise<ReviewResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.reviews.create(id, body, actor);
  }

  @Patch('library/reviews/:id')
  @RequirePermission('lib-003:write')
  @ApiOperation({
    summary:
      'Edit a review. Student edits own only (row-scope inside the tx). Moderator can edit anyone but the common moderator action is the dedicated /hide endpoint below.',
  })
  async patch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateReviewDto,
    @Req() req: AuthedRequest,
  ): Promise<ReviewResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.reviews.patch(id, body, actor);
  }

  @Patch('library/reviews/:id/hide')
  @RequirePermission('lib-003:write')
  @ApiOperation({
    summary:
      'Librarian / teacher / admin hides an inappropriate review (sets is_approved=false). The row is preserved for audit; non-moderator readers no longer see the review on the public catalogue page.',
  })
  async hide(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<ReviewResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.reviews.setApproval(id, false, actor);
  }

  @Patch('library/reviews/:id/unhide')
  @RequirePermission('lib-003:write')
  @ApiOperation({
    summary:
      'Restore a previously-hidden review (sets is_approved=true). The librarian / admin reviews the row content and decides to re-show.',
  })
  async unhide(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<ReviewResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.reviews.setApproval(id, true, actor);
  }
}
