import { Module } from '@nestjs/common';
import { TenantModule } from '@modules/m00-platform/tenant/tenant.module';
import { IamModule } from '@modules/m00-platform/iam/iam.module';
import { KafkaModule } from '@shared/kafka/kafka.module';
import { CaseloadService } from './caseload.service';
import { CaseloadController } from './caseload.controller';
import { ReferralService } from './referral.service';
import { ReferralController } from './referral.controller';
import { ReferralActivityService } from './referral-activity.service';
import { ReferralTypeService } from './referral-type.service';
import { ReferralTypeController } from './referral-type.controller';
import { SessionService } from './session.service';
import { SessionController } from './session.controller';
import { SessionNoteService } from './session-note.service';
import { SessionNoteController } from './session-note.controller';
import { MtssTierService } from './mtss-tier.service';
import { InterventionService } from './intervention.service';
import { MtssController } from './mtss.controller';
import { CoordinatedCareService } from './coordinated-care.service';
import { CoordinatedCareController } from './coordinated-care.controller';
import { MandatoryReportService } from './mandatory-report.service';
import { MandatoryReportController } from './mandatory-report.controller';

/**
 * Counselling Module — Cycle 11 Step 5.
 *
 * Wires the M27 Student Services counselling caseload + referral schema
 * (Step 1 migration, Step 4 seed) into a request-path API surface. Four
 * services + 16 endpoints + 1 Kafka emit topic (svc.referral.created).
 * Step 6 will add SessionService + SessionNoteService (FERPA gate);
 * Step 7 will add MtssTierService + InterventionService +
 * CoordinatedCareService + MandatoryReportService.
 *
 * Services:
 *   - CaseloadService            — svc_caseloads CRUD with the partial
 *                                  UNIQUE keystone pre-flight on
 *                                  (student, year) WHERE status='ACTIVE'
 *                                  AND is_primary_counselor=true.
 *                                  Row-scope: counsellors see own;
 *                                  teachers see class-scoped students;
 *                                  parents see own children with notes
 *                                  stripped; students/unknown 403 at
 *                                  the cou-001:read gate.
 *   - ReferralService            — svc_referrals lifecycle. POST stamps
 *                                  referred_by from actor.employeeId,
 *                                  copies default_priority from the
 *                                  chosen referral_type, writes the
 *                                  initial STATUS_CHANGE activity row
 *                                  inside the same tenant tx, emits
 *                                  svc.referral.created. PATCH
 *                                  /triage, /accept, /start, /complete,
 *                                  /decline all use SELECT FOR UPDATE
 *                                  inside an executeInTenantTransaction
 *                                  per the convention. /accept with
 *                                  openCaseload=true auto-opens a
 *                                  caseload via CaseloadService.createInternal.
 *   - ReferralActivityService    — IMMUTABLE per ADR-010. Sole writer
 *                                  to svc_referral_activity is
 *                                  recordActivity(tx, ...) called by
 *                                  every ReferralService status
 *                                  mutation in the same locked tx.
 *                                  Read-only chronological audit at
 *                                  GET /counselling/referrals/:id/activity.
 *   - ReferralTypeService        — svc_referral_types CRUD. Reads on
 *                                  cou-002:read (every persona that can
 *                                  submit or track referrals); writes
 *                                  on cou-002:admin (admin-only via
 *                                  everyFunction). assertActive() is
 *                                  used by ReferralService.create to
 *                                  copy default_priority and read the
 *                                  requires_parent_notification flag.
 *
 * Authorisation contract:
 *   - cou-001:read     — list + read caseloads.
 *                        Row-scoped at the service layer.
 *   - cou-001:write    — open / patch / close caseloads. Counsellor or
 *                        admin only at the service layer.
 *   - cou-002:read     — list + read referrals + activity.
 *                        Row-scoped (own submitted + assigned +
 *                        unassigned-triage queue for counsellors).
 *   - cou-002:write    — submit referrals (any staff with employeeId)
 *                        + triage / accept / start / complete /
 *                        decline (counsellor or admin only).
 *   - cou-002:admin    — referral_types catalogue CRUD.
 *                        School Admin / Platform Admin only via the
 *                        everyFunction grant.
 *
 * Future Step 6 + 7 services will live in this same module and join
 * the Kafka emits + DTO surface. Session notes (Step 6) introduce the
 * student_counseling_record:read FERPA gate that teachers and parents
 * NEVER hold.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [
    CaseloadService,
    ReferralService,
    ReferralActivityService,
    ReferralTypeService,
    SessionService,
    SessionNoteService,
    MtssTierService,
    InterventionService,
    CoordinatedCareService,
    MandatoryReportService,
  ],
  controllers: [
    CaseloadController,
    ReferralController,
    ReferralTypeController,
    SessionController,
    SessionNoteController,
    MtssController,
    CoordinatedCareController,
    MandatoryReportController,
  ],
  exports: [
    CaseloadService,
    ReferralService,
    ReferralActivityService,
    ReferralTypeService,
    SessionService,
    SessionNoteService,
    MtssTierService,
    InterventionService,
    CoordinatedCareService,
    MandatoryReportService,
  ],
})
export class CounsellingModule {}
