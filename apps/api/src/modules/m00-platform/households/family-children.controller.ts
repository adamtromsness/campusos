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
  AddChildEmergencyContactDto,
  AddFamilyEmergencyContactDto,
  AddFamilyMemberDto,
  ChildDietaryInfoDto,
  ChildEmergencyContactDto,
  ChildMedicalInfoDto,
  CreateChildAccountDto,
  CreateFamilyChildDto,
  CreateMemberAccountDto,
  FamilyChildDto,
  FamilyContactPreferenceDto,
  FamilyEmergencyContactDto,
  FamilyLinkResultDto,
  FamilyMemberDto,
  FamilySettingsDto,
  FamilyViewDto,
  GenerateFamilyCodeDto,
  GenerateLinkCodeDto,
  InviteGuardianDto,
  SendChildLinkDto,
  SendMemberInviteDto,
  ReorderFamilyEmergencyContactsDto,
  UpdateChildDietaryInfoDto,
  UpdateChildEmergencyContactDto,
  UpdateChildMedicalInfoDto,
  UpdateFamilyChildDto,
  UpdateFamilyContactPreferencesDto,
  UpdateFamilyEmergencyContactDto,
  UpdateFamilyMemberDto,
  UpdateFamilySettingsDto,
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

  // ─── Family settings (shared attributes) ────────────────────

  /**
   * Note: /family/settings MUST be declared before any /family/:id-style
   * route. Nest matches in registration order, so a later wildcard
   * would otherwise consume "settings" as an id. Same trap that bit
   * the /family/link route on Cycle 6.
   */
  @Get('settings')
  @ApiOperation({
    summary:
      'Read family-level shared attributes (display name, address, doctor, insurance, primary contact)',
  })
  async getSettings(@Req() req: AuthedRequest): Promise<FamilySettingsDto | null> {
    return this.children.getFamilySettings(req.user!.personId);
  }

  @Patch('settings')
  @ApiOperation({
    summary: 'Update family-level shared attributes — parents/guardians only',
  })
  async patchSettings(
    @Req() req: AuthedRequest,
    @Body() dto: UpdateFamilySettingsDto,
  ): Promise<FamilySettingsDto> {
    return this.children.updateFamilySettings(req.user!.personId, dto);
  }

  // ─── Family contact preferences (per-category routing) ────

  @Get('contact-preferences')
  @ApiOperation({
    summary:
      'Per-category primary-contact routing. Lazily seeds 8 defaults from the family primary contact on first read.',
  })
  async getFamilyContactPreferences(
    @Req() req: AuthedRequest,
  ): Promise<FamilyContactPreferenceDto[]> {
    return this.children.getFamilyContactPreferences(req.user!.personId);
  }

  @Patch('contact-preferences')
  @ApiOperation({
    summary:
      'Bulk upsert per-category routing. GENERAL changes also flip platform_family_members.is_primary_contact.',
  })
  async patchFamilyContactPreferences(
    @Req() req: AuthedRequest,
    @Body() dto: UpdateFamilyContactPreferencesDto,
  ): Promise<FamilyContactPreferenceDto[]> {
    return this.children.updateFamilyContactPreferences(req.user!.personId, dto);
  }

  // ─── Family emergency contacts ─────────────────────────────

  @Get('settings/emergency-contacts')
  @ApiOperation({
    summary: 'List family-level emergency contacts (shared default for all children)',
  })
  async listFamilyEmergencyContacts(
    @Req() req: AuthedRequest,
  ): Promise<FamilyEmergencyContactDto[]> {
    return this.children.listFamilyEmergencyContacts(req.user!.personId);
  }

  @Post('settings/emergency-contacts')
  @ApiOperation({ summary: 'Add a family-level emergency contact — parents/guardians only' })
  async addFamilyEmergencyContact(
    @Req() req: AuthedRequest,
    @Body() dto: AddFamilyEmergencyContactDto,
  ): Promise<FamilyEmergencyContactDto> {
    return this.children.addFamilyEmergencyContact(req.user!.personId, dto);
  }

  /**
   * MUST be declared before /settings/emergency-contacts/:contactId
   * — same Nest route-ordering trap as /family/settings.
   */
  @Patch('settings/emergency-contacts/reorder')
  @ApiOperation({
    summary: 'Bulk reorder family emergency contacts by id — priority_order = position in array',
  })
  async reorderFamilyEmergencyContacts(
    @Req() req: AuthedRequest,
    @Body() dto: ReorderFamilyEmergencyContactsDto,
  ): Promise<FamilyEmergencyContactDto[]> {
    return this.children.reorderFamilyEmergencyContacts(req.user!.personId, dto.orderedIds);
  }

  @Patch('settings/emergency-contacts/:contactId')
  @ApiOperation({ summary: 'Update a family-level emergency contact' })
  async updateFamilyEmergencyContact(
    @Req() req: AuthedRequest,
    @Param('contactId', ParseUUIDPipe) contactId: string,
    @Body() dto: UpdateFamilyEmergencyContactDto,
  ): Promise<FamilyEmergencyContactDto> {
    return this.children.updateFamilyEmergencyContact(req.user!.personId, contactId, dto);
  }

  @Delete('settings/emergency-contacts/:contactId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a family-level emergency contact' })
  async removeFamilyEmergencyContact(
    @Req() req: AuthedRequest,
    @Param('contactId', ParseUUIDPipe) contactId: string,
  ): Promise<void> {
    await this.children.removeFamilyEmergencyContact(req.user!.personId, contactId);
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

  // ─── Child profile sections — parent-only ─────────────────
  //
  // Pre-enrolment medical / emergency-contact / dietary data lives
  // on platform tables (see migration
  // 20260525110000_platform_child_health_dietary_emergency).
  // Every endpoint here is gated by requireOwnedRow inside the
  // service so a CHILD viewer or a cross-family attacker can't read
  // or write another family's records.

  @Get('children/:id/medical')
  @ApiOperation({
    summary: 'Read a LINKED child\'s medical record. Returns an empty shape if none stored yet.',
  })
  async getMedical(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ChildMedicalInfoDto> {
    return this.children.getChildMedical(req.user!.personId, id);
  }

  @Patch('children/:id/medical')
  @ApiOperation({ summary: 'Upsert a LINKED child\'s medical record (whole-list replace).' })
  async updateMedical(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateChildMedicalInfoDto,
  ): Promise<ChildMedicalInfoDto> {
    return this.children.updateChildMedical(req.user!.personId, id, dto);
  }

  @Get('children/:id/emergency-contacts')
  @ApiOperation({ summary: 'List emergency contacts for a LINKED child.' })
  async listEmergencyContacts(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ChildEmergencyContactDto[]> {
    return this.children.listChildEmergencyContacts(req.user!.personId, id);
  }

  @Post('children/:id/emergency-contacts')
  @ApiOperation({ summary: 'Add an emergency contact for a LINKED child.' })
  async addEmergencyContact(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddChildEmergencyContactDto,
  ): Promise<ChildEmergencyContactDto> {
    return this.children.addChildEmergencyContact(req.user!.personId, id, dto);
  }

  @Patch('children/:id/emergency-contacts/:contactId')
  @ApiOperation({ summary: 'Update an emergency contact.' })
  async updateEmergencyContact(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('contactId', ParseUUIDPipe) contactId: string,
    @Body() dto: UpdateChildEmergencyContactDto,
  ): Promise<ChildEmergencyContactDto> {
    return this.children.updateChildEmergencyContact(req.user!.personId, id, contactId, dto);
  }

  @Delete('children/:id/emergency-contacts/:contactId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove an emergency contact.' })
  async removeEmergencyContact(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('contactId', ParseUUIDPipe) contactId: string,
  ): Promise<void> {
    await this.children.removeChildEmergencyContact(req.user!.personId, id, contactId);
  }

  @Get('children/:id/dietary')
  @ApiOperation({ summary: 'Read dietary info for a LINKED child.' })
  async getDietary(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ChildDietaryInfoDto> {
    return this.children.getChildDietary(req.user!.personId, id);
  }

  @Patch('children/:id/dietary')
  @ApiOperation({ summary: 'Upsert dietary info for a LINKED child.' })
  async updateDietary(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateChildDietaryInfoDto,
  ): Promise<ChildDietaryInfoDto> {
    return this.children.updateChildDietary(req.user!.personId, id, dto);
  }
}
