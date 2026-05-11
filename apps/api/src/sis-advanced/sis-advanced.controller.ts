import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { StudentProfileService } from './student-profile.service';
import { CustomFieldService } from './custom-field.service';
import { ParentUpdateService } from './parent-update.service';
import { StudentNoteService } from './student-note.service';
import { FamilyRelationshipService } from './family-relationship.service';
import {
  CreateCustomFieldDefinitionDto,
  CreateFamilyRelationshipDto,
  CreateStudentNoteDto,
  ReviewAvatarDto,
  ReviewParentUpdateDto,
  SubmitParentUpdateDto,
  UpdateCustomFieldDefinitionDto,
  UpdateFamilyRelationshipDto,
  UpdateStudentProfileDto,
  UploadAvatarDto,
  UpsertAutoApprovalRuleDto,
  UpsertCustomFieldValuesDto,
} from './dto/sis-advanced.dto';

interface AuthedRequest extends Request {
  user?: {
    sub: string;
    personId: string;
    email: string;
    displayName: string;
    sessionId: string;
  };
}

@ApiTags('SIS Advanced')
@ApiBearerAuth()
@Controller()
export class SisAdvancedController {
  constructor(
    private readonly profiles: StudentProfileService,
    private readonly customFields: CustomFieldService,
    private readonly parentUpdates: ParentUpdateService,
    private readonly notes: StudentNoteService,
    private readonly familyRels: FamilyRelationshipService,
    private readonly actors: ActorContextService,
  ) {}

  private async resolveActor(req: AuthedRequest) {
    if (!req.user) throw new Error('Unauthenticated request reached SisAdvanced controller');
    return this.actors.resolveActor(req.user.sub, req.user.personId);
  }

  // ─── Student Profile (STU-002) ───

  @Get('sis/students/:id/profile')
  @RequirePermission('stu-001:read')
  @ApiOperation({ summary: 'Get the student profile — creates an empty profile on first read.' })
  async getProfile(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    return this.profiles.getOrCreateProfile(id, await this.resolveActor(req));
  }

  @Patch('sis/students/:id/profile')
  @RequirePermission('stu-002:write')
  @ApiOperation({
    summary:
      'Update bio + interests + motto. Student-owned: only the owning student or an admin may edit.',
  })
  async updateProfile(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStudentProfileDto,
    @Req() req: AuthedRequest,
  ) {
    return this.profiles.updateProfile(id, dto, await this.resolveActor(req));
  }

  @Post('sis/students/:id/profile/avatar')
  @RequirePermission('stu-002:write')
  @ApiOperation({
    summary: 'Upload avatar — lands as PENDING_APPROVAL and requires homeroom-teacher review.',
  })
  async uploadAvatar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UploadAvatarDto,
    @Req() req: AuthedRequest,
  ) {
    return this.profiles.uploadAvatar(id, dto, await this.resolveActor(req));
  }

  @Get('sis/student-profiles/pending-avatars')
  @RequirePermission('stu-002:write')
  @ApiOperation({
    summary: 'Admin / teacher queue — every profile with avatar_status=PENDING_APPROVAL.',
  })
  async listPendingAvatars(@Req() req: AuthedRequest) {
    return this.profiles.listPendingAvatars(await this.resolveActor(req));
  }

  @Patch('sis/student-profiles/:id/avatar-review')
  @RequirePermission('stu-002:write')
  @ApiOperation({
    summary:
      'Approve / reject a PENDING_APPROVAL avatar — staff + admin only. Emits sis.avatar.reviewed.',
  })
  async reviewAvatar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewAvatarDto,
    @Req() req: AuthedRequest,
  ) {
    return this.profiles.reviewAvatar(id, dto, await this.resolveActor(req));
  }

  // ─── Custom Fields (STU-002) ───

  @Get('sis/custom-fields/:entityType')
  @RequirePermission('stu-002:read')
  @ApiOperation({ summary: 'List custom field definitions for an entity type.' })
  async listCustomFields(
    @Param('entityType') entityType: string,
    @Query('includeInactive') includeInactive?: string,
  ) {
    return this.customFields.listDefinitions(entityType, {
      includeInactive: includeInactive === 'true',
    });
  }

  @Post('sis/custom-fields')
  @RequirePermission('stu-002:admin')
  @ApiOperation({ summary: 'Admin — define a new custom field.' })
  async createCustomField(@Body() dto: CreateCustomFieldDefinitionDto, @Req() req: AuthedRequest) {
    return this.customFields.createDefinition(dto, await this.resolveActor(req));
  }

  @Patch('sis/custom-fields/:id')
  @RequirePermission('stu-002:admin')
  @ApiOperation({ summary: 'Admin — update a custom field definition.' })
  async patchCustomField(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCustomFieldDefinitionDto,
    @Req() req: AuthedRequest,
  ) {
    return this.customFields.patchDefinition(id, dto, await this.resolveActor(req));
  }

  @Get('sis/custom-field-values/:entityType/:entityId')
  @RequirePermission('stu-002:read')
  @ApiOperation({ summary: 'Get the typed custom field values for a single entity.' })
  async listCustomFieldValues(
    @Param('entityType') entityType: string,
    @Param('entityId', ParseUUIDPipe) entityId: string,
    @Req() req: AuthedRequest,
  ) {
    return this.customFields.listValuesForEntity(
      entityType,
      entityId,
      await this.resolveActor(req),
    );
  }

  @Patch('sis/custom-field-values')
  @RequirePermission('stu-002:write')
  @ApiOperation({
    summary:
      'Bulk upsert custom field values for one entity. Validates each value against the matching definition field_type.',
  })
  async upsertCustomFieldValues(
    @Body() dto: UpsertCustomFieldValuesDto,
    @Req() req: AuthedRequest,
  ) {
    return this.customFields.upsertValues(dto, await this.resolveActor(req));
  }

  // ─── Parent Update Requests (STU-002) ───

  @Post('sis/parent-update-requests')
  @RequirePermission('stu-002:write')
  @ApiOperation({
    summary:
      'Parent submits an info update request. Auto-approves if every field has an active auto_approve=true rule.',
  })
  async submitParentUpdate(@Body() dto: SubmitParentUpdateDto, @Req() req: AuthedRequest) {
    return this.parentUpdates.submitRequest(dto, await this.resolveActor(req));
  }

  @Get('sis/parent-update-requests')
  @RequirePermission('stu-002:read')
  @ApiOperation({
    summary:
      'Admin — list every parent update request in the school. Non-admin (GUARDIAN) sees own submissions only.',
  })
  async listParentUpdates(@Req() req: AuthedRequest, @Query('status') status?: string) {
    return this.parentUpdates.listRequests(await this.resolveActor(req), { status });
  }

  @Get('sis/parent-update-requests/:id')
  @RequirePermission('stu-002:read')
  @ApiOperation({ summary: 'Look up a single parent update request.' })
  async getParentUpdate(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    return this.parentUpdates.getByIdOrFail(id, await this.resolveActor(req));
  }

  @Patch('sis/parent-update-requests/:id')
  @RequirePermission('stu-002:admin')
  @ApiOperation({
    summary: 'Admin reviews a PENDING parent update request — APPROVED or REJECTED.',
  })
  async reviewParentUpdate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewParentUpdateDto,
    @Req() req: AuthedRequest,
  ) {
    return this.parentUpdates.reviewRequest(id, dto, await this.resolveActor(req));
  }

  @Get('sis/auto-approval-rules')
  @RequirePermission('stu-002:read')
  @ApiOperation({ summary: 'List per-field auto-approval configuration.' })
  async listAutoApprovalRules() {
    return this.parentUpdates.listRules();
  }

  @Post('sis/auto-approval-rules')
  @RequirePermission('stu-002:admin')
  @ApiOperation({
    summary: 'Admin — upsert an auto-approval rule for a (target_type, field_name) pair.',
  })
  async upsertAutoApprovalRule(@Body() dto: UpsertAutoApprovalRuleDto, @Req() req: AuthedRequest) {
    return this.parentUpdates.upsertRule(dto, await this.resolveActor(req));
  }

  // ─── Student Notes (STU-002) ───

  @Get('sis/students/:id/notes')
  @RequirePermission('stu-002:read')
  @ApiOperation({
    summary:
      'List student notes — STAFF sees all non-confidential + own confidential. GUARDIAN sees parent-visible only. CONFIDENTIAL notes hide from non-authors and non-admins.',
  })
  async listStudentNotes(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    return this.notes.listForStudent(id, await this.resolveActor(req));
  }

  @Post('sis/students/:id/notes')
  @RequirePermission('stu-002:write')
  @ApiOperation({ summary: 'Staff / admin authors a new note.' })
  async createStudentNote(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateStudentNoteDto,
    @Req() req: AuthedRequest,
  ) {
    return this.notes.createForStudent(id, dto, await this.resolveActor(req));
  }

  @Delete('sis/student-notes/:id')
  @RequirePermission('stu-002:write')
  @ApiOperation({ summary: 'Author or admin deletes a note.' })
  async deleteStudentNote(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    await this.notes.delete(id, await this.resolveActor(req));
    return { deleted: true };
  }

  // ─── Family Relationships (STU-002) ───

  @Get('sis/families/:id/relationships')
  @RequirePermission('stu-002:read')
  @ApiOperation({ summary: 'List the guardian-to-guardian relationships within a family.' })
  async listFamilyRelationships(@Param('id', ParseUUIDPipe) id: string) {
    return this.familyRels.listForFamily(id);
  }

  @Post('sis/family-relationships')
  @RequirePermission('stu-002:admin')
  @ApiOperation({ summary: 'Admin — record a guardian-to-guardian relationship in a family.' })
  async createFamilyRelationship(
    @Body() dto: CreateFamilyRelationshipDto,
    @Req() req: AuthedRequest,
  ) {
    return this.familyRels.create(dto, await this.resolveActor(req));
  }

  @Patch('sis/family-relationships/:id')
  @RequirePermission('stu-002:admin')
  @ApiOperation({ summary: 'Admin — update a family relationship.' })
  async patchFamilyRelationship(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateFamilyRelationshipDto,
    @Req() req: AuthedRequest,
  ) {
    return this.familyRels.patch(id, dto, await this.resolveActor(req));
  }

  @Delete('sis/family-relationships/:id')
  @RequirePermission('stu-002:admin')
  @ApiOperation({ summary: 'Admin — delete a family relationship.' })
  async deleteFamilyRelationship(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ) {
    await this.familyRels.delete(id, await this.resolveActor(req));
    return { deleted: true };
  }
}
