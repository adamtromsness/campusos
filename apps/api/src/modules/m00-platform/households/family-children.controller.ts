import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { FamilyChildrenService } from './family-children.service';
import {
  AcceptFamilyLinkDto,
  AddFamilyMemberDto,
  CreateChildAccountDto,
  CreateFamilyChildDto,
  CreateMemberAccountDto,
  FamilyChildDto,
  FamilyLinkResultDto,
  FamilyMemberDto,
  FamilyViewDto,
  GenerateFamilyCodeDto,
  GenerateLinkCodeDto,
  InviteGuardianDto,
  SendChildLinkDto,
  SendMemberInviteDto,
  UpdateFamilyChildDto,
  UpdateFamilyMemberDto,
} from './dto/family-child.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

/**
 * /family — persona-registration Steps 5 + 6.
 *
 * Endpoints gate on authentication only (no @RequirePermission) — every
 * authenticated user manages their own family. Cross-family isolation
 * is enforced inside the service by joining
 * platform_family_children.family_id to the caller's
 * platform_family_members.family_id; mismatches surface as 404 (not
 * 403) so the existence of another family's children isn't leaked.
 */
@ApiTags('Family')
@ApiBearerAuth()
@Controller('family')
export class FamilyChildrenController {
  constructor(private readonly children: FamilyChildrenService) {}

  // ─── Composite view ─────────────────────────────────────────

  @Get()
  @ApiOperation({
    summary:
      'Composite family view — returns family + members + children + viewerRole (PARENT or CHILD) so the client can pick the right render path.',
  })
  async getFamily(@Req() req: AuthedRequest): Promise<FamilyViewDto | null> {
    return this.children.getFamilyView(req.user!.personId);
  }

  // ─── Step 5 — CRUD ──────────────────────────────────────────

  @Get('children')
  @ApiOperation({ summary: 'List children in the current user’s family' })
  async list(@Req() req: AuthedRequest): Promise<FamilyChildDto[]> {
    return this.children.listForUser(req.user!.personId);
  }

  @Post('children')
  @ApiOperation({ summary: 'Add a child to the current user’s family (status=PLACEHOLDER)' })
  async create(
    @Req() req: AuthedRequest,
    @Body() dto: CreateFamilyChildDto,
  ): Promise<FamilyChildDto> {
    return this.children.create(req.user!.personId, dto);
  }

  @Patch('children/:id')
  @ApiOperation({ summary: 'Edit a PLACEHOLDER or PENDING_LINK child (LINKED is read-only)' })
  async update(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateFamilyChildDto,
  ): Promise<FamilyChildDto> {
    return this.children.update(req.user!.personId, id, dto);
  }

  @Delete('children/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a PLACEHOLDER child; revokes a pending invitation' })
  async remove(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.children.remove(req.user!.personId, id);
  }

  // ─── Step 6 — Account creation + linking ────────────────────

  @Post('children/:id/create-account')
  @ApiOperation({
    summary: 'Create a parent-managed minor account for a PLACEHOLDER child',
  })
  async createAccount(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateChildAccountDto,
  ): Promise<FamilyChildDto> {
    return this.children.createAccountForChild(req.user!.personId, id, dto);
  }

  @Post('children/:id/send-link')
  @ApiOperation({
    summary:
      'Generate an 8-char link code + email it to the child. Accepts PLACEHOLDER (first send) and PENDING_LINK (resend); the prior invitation is revoked.',
  })
  async sendLink(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendChildLinkDto,
  ): Promise<FamilyChildDto> {
    return this.children.sendLinkInvitation(req.user!.personId, id, dto);
  }

  @Post('children/:id/cancel-link')
  @ApiOperation({
    summary: 'Revoke the outstanding CHILD_LINK invitation and reset the child to PLACEHOLDER',
  })
  async cancelLink(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<FamilyChildDto> {
    return this.children.cancelLink(req.user!.personId, id);
  }

  @Post('link')
  @ApiOperation({
    summary:
      'Accept an 8-char link code — dispatches on type/metadata. FAMILY_INVITE / CHILD_LINK return { kind: CHILD, child }; GUARDIAN_INVITE returns { kind: GUARDIAN, family, inviterName }.',
  })
  async accept(
    @Req() req: AuthedRequest,
    @Body() dto: AcceptFamilyLinkDto,
  ): Promise<FamilyLinkResultDto> {
    return this.children.acceptLinkCode(req.user!.personId, req.user!.sub, dto);
  }

  // ─── Bidirectional family-link generators ─────────────────

  @Post('generate-code')
  @ApiOperation({
    summary:
      'Generate a FAMILY_INVITE code. Any authenticated user who accepts it joins the caller\'s family as a LINKED child. Optional email lands on target_email for the future send-email worker.',
  })
  async generateCode(
    @Req() req: AuthedRequest,
    @Body() dto: GenerateFamilyCodeDto = {},
  ): Promise<GenerateLinkCodeDto> {
    return this.children.generateFamilyCode(req.user!.personId, dto);
  }

  @Post('generate-child-code')
  @ApiOperation({
    summary:
      'Generate a CHILD_LINK code (no familyChildId metadata). A parent who accepts the code adds the caller as a LINKED child in the parent\'s family — auto-matched against same-name PLACEHOLDER rows.',
  })
  async generateChildCode(@Req() req: AuthedRequest): Promise<GenerateLinkCodeDto> {
    return this.children.generateChildCode(req.user!.personId);
  }

  @Post('invite-guardian')
  @ApiOperation({
    summary:
      'Generate a GUARDIAN_INVITE code. Whoever accepts is added to the caller\'s family as a co-parent with full read/write on every child.',
  })
  async inviteGuardian(
    @Req() req: AuthedRequest,
    @Body() dto: InviteGuardianDto,
  ): Promise<GenerateLinkCodeDto> {
    return this.children.generateGuardianInvite(req.user!.personId, dto);
  }

  // ─── Placeholder guardian members ─────────────────────────

  @Post('members')
  @ApiOperation({ summary: 'Add a placeholder guardian to the current user’s family' })
  async addMember(
    @Req() req: AuthedRequest,
    @Body() dto: AddFamilyMemberDto,
  ): Promise<FamilyMemberDto> {
    return this.children.addPlaceholderMember(req.user!.personId, dto);
  }

  @Patch('members/:id')
  @ApiOperation({
    summary: 'Edit a PLACEHOLDER or PENDING_INVITE guardian. ACTIVE rows reject.',
  })
  async updateMember(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateFamilyMemberDto,
  ): Promise<FamilyMemberDto> {
    return this.children.updateMember(req.user!.personId, id, dto);
  }

  @Delete('members/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Remove a PLACEHOLDER or PENDING_INVITE guardian; revokes a pending invitation. ACTIVE rows reject.',
  })
  async removeMember(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.children.removeMember(req.user!.personId, id);
  }

  @Post('members/:id/create-account')
  @ApiOperation({
    summary:
      'Create an iam_person + platform_users for a PLACEHOLDER guardian and promote the member row to ACTIVE.',
  })
  async createMemberAccount(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateMemberAccountDto,
  ): Promise<FamilyMemberDto> {
    return this.children.createAccountForMember(req.user!.personId, id, dto);
  }

  @Post('members/:id/send-invite')
  @ApiOperation({
    summary:
      'Generate a GUARDIAN_INVITE scoped to this placeholder row. metadata.familyMemberId is set so accept UPDATEs the row in place.',
  })
  async sendMemberInvite(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendMemberInviteDto,
  ): Promise<FamilyMemberDto> {
    return this.children.sendMemberInvite(req.user!.personId, id, dto);
  }
}
