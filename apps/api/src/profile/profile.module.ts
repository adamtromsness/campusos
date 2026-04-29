import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { IamModule } from '../iam/iam.module';
import { ProfileService } from './profile.service';
import { ProfileController } from './profile.controller';

/**
 * Profile Module — User Profile & Household Mini-Cycle Step 5.
 *
 * Self-service profile editing for every persona + admin override at
 * /profile/:personId. Composes platform iam_person + persona-specific
 * tenant data (sis_student_demographics, sis_guardians employment) +
 * the matching emergency contact table (hr_emergency_contacts for
 * STAFF, sis_emergency_contacts for STUDENT) + household membership.
 *
 * Transactional convention: writes to iam_person use a regular
 * platform Prisma transaction. Writes to sis_student_demographics,
 * sis_guardians, sis_emergency_contacts, hr_emergency_contacts use
 * executeInTenantTransaction. A single PATCH /profile/me may execute
 * both — they're separate transactions, executed in order.
 */
@Module({
  imports: [TenantModule, IamModule],
  providers: [ProfileService],
  controllers: [ProfileController],
  exports: [ProfileService],
})
export class ProfileModule {}
