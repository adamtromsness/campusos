import { Module } from '@nestjs/common';
import { TenantModule } from '@modules/m00-platform/tenant/tenant.module';
import { IamModule } from '@modules/m00-platform/iam/iam.module';
import { KafkaModule } from '@shared/kafka/kafka.module';
import { OutboxService } from '@shared/kafka/outbox.service';
import { StudentProfileService } from './student-profile.service';
import { CustomFieldService } from '../custom-fields/custom-field.service';
import { ParentUpdateService } from '../guardians/parent-update.service';
import { StudentNoteService } from '../notes/student-note.service';
import { FamilyRelationshipService } from '../family/family-relationship.service';
import { SisAdvancedController } from './sis-advanced.controller';

/**
 * SIS Advanced Module — Phase 2 Cycle 13 sub-cycle a (P2-13a).
 *
 * Ships 5 services + 1 controller + ~22 endpoints + 3 Kafka emits
 * (sis.avatar.reviewed, sis.parent_update.submitted,
 * sis.parent_update.reviewed) under STU-001 + STU-002.
 *
 * Three structural keystones:
 *   1. STUDENT-OWNED PROFILE — only the owning STUDENT actor (or
 *      admin) can edit bio + interests + motto + avatar upload.
 *      Avatar upload always lands as PENDING_APPROVAL and requires
 *      homeroom-teacher review before becoming visible.
 *   2. TYPED CUSTOM FIELD VALUES — schools define their own fields
 *      via sis_custom_field_definitions without schema changes.
 *      sis_custom_field_values stores one value_* column per row
 *      based on the matching definition.field_type. Service-layer
 *      validation enforces the value type at write time and
 *      enum_options inclusion for ENUM / MULTI_SELECT fields.
 *   3. PARENT UPDATE AUTO-APPROVAL — sis_auto_approval_rules
 *      configures per-field auto-approval; ParentUpdateService
 *      checks every field in proposed_changes against the rule
 *      catalogue and either lands AUTO_APPROVED (every field has
 *      auto_approve=true) or PENDING (any field lacks a true
 *      rule). Manual review by an admin transitions PENDING to
 *      APPROVED or REJECTED with multi-column reviewed_chk plus
 *      applied_chk lockstep on the schema.
 *
 * Cross-cycle integration: sis_student_notes is extended in this
 * cycle by widening the note_type CHECK to include ADMINISTRATIVE
 * plus CONFIDENTIAL on top of the original Cycle 1 values
 * (PASTORAL / ACADEMIC / BEHAVIOURAL / WELLBEING / GENERAL).
 * StudentNoteService row-scopes CONFIDENTIAL rows to the author
 * plus admin.
 *
 * Permission codes (already in catalogue):
 *   - STU-001 Student Profiles (read across personas)
 *   - STU-002 Student Profile Customisation (write for student
 *     self-service + parent updates + staff notes; admin tier for
 *     custom field definitions + parent-update review + family
 *     relationships + auto-approval rules)
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [
    OutboxService,
    StudentProfileService,
    CustomFieldService,
    ParentUpdateService,
    StudentNoteService,
    FamilyRelationshipService,
  ],
  controllers: [SisAdvancedController],
  exports: [
    StudentProfileService,
    CustomFieldService,
    ParentUpdateService,
    StudentNoteService,
    FamilyRelationshipService,
  ],
})
export class SisAdvancedModule {}
