import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { IamModule } from '../iam/iam.module';
import { KafkaModule } from '../kafka/kafka.module';
import { AgencyReferralService } from './agency-referral.service';
import { CaseloadDashboardService } from './caseload-dashboard.service';
import { CrisisEscalationService } from './crisis-escalation.service';
import { MtssTeamMeetingService } from './mtss-team-meeting.service';
import { WellbeingLongitudinalService } from './wellbeing-longitudinal.service';
import { StudentServicesAdvancedController } from './student-services-advanced.controller';

/**
 * StudentServicesAdvancedModule — P2-28c (Phase 2 Cycle 28 sub-cycle c).
 *
 * 5 services + 1 controller + ~15 endpoints completing the M27 Student
 * Services deferred surface from Cycle 11.
 *
 * Note on the plan vs reality: the P2-28c plan headers list 8 tables.
 * Six of those (svc_caseloads, svc_referral_types, svc_referrals,
 * svc_referral_activity, svc_mtss_team_meetings, svc_mtss_team
 * _meeting_students) already shipped in Cycle 11 migrations 036 + 037
 * together with the matching CaseloadService / ReferralService /
 * ReferralActivityService / MTSS-Tier service. Including the IMMUTABLE
 * KEYSTONE on svc_referral_activity (no UPDATE, no DELETE, CASCADE on
 * parent referral so an emergency hard-delete takes the audit with
 * it). P2-28c only ships the 2 truly-new tables here:
 *
 *   svc_agency_referrals          External agency referral attached
 *                                 to a parent svc_referrals row.
 *                                 4-value status CHECK REFERRED /
 *                                 CONTACTED / ACTIVE_SERVICE /
 *                                 DISCHARGED with CONSENT GATE before
 *                                 ACTIVE_SERVICE — schools cannot
 *                                 release student information to an
 *                                 outside agency without parent
 *                                 consent.
 *   svc_wellbeing_longitudinal    Per-(student, academic_year,
 *                                 domain) annual aggregate from svc
 *                                 _wellbeing_responses. NO individual
 *                                 check-in data — only aggregated
 *                                 domain scores and trend per
 *                                 academic year.
 *
 * Plus additive columns on Cycle 11 tables (svc_referral_types
 * .referral_category, svc_referrals.concern_description, svc
 * _referrals.source_incident_id).
 *
 * Five structural keystones:
 *
 *   1. IMMUTABLE referral activity log (Cycle 11 invariant we surface
 *      from the CrisisEscalationService). ESCALATED rows write an
 *      append-only audit entry inside the same tx as the referral
 *      priority + status flip. No UPDATE on svc_referral_activity. No
 *      DELETE. CASCADE on parent referral hard-delete only.
 *
 *   2. CRISIS auto-escalation. CrisisEscalationService.escalate
 *      locks the parent svc_referrals row FOR UPDATE, flips priority
 *      to URGENT, advances SUBMITTED / TRIAGED status to ACCEPTED,
 *      writes the ESCALATED activity row, and emits svc.referral
 *      .escalated outside the tx — all idempotent on already-URGENT-
 *      and-ACCEPTED rows (rejected with 400 to surface the no-op).
 *      Plan-level auto-escalation on svc_referral_types.referral
 *      _category=CRISIS is the future bridge into the Cycle 11
 *      ReferralService.create path — the manual endpoint is the
 *      counsellor's queue-driven safety net.
 *
 *   3. Consent gate on external agency referrals. The CONTACTED to
 *      ACTIVE_SERVICE transition requires consent_obtained=true.
 *      Service refuses the transition until the flag is flipped.
 *      Schools cannot release student information to outside agencies
 *      without parent consent.
 *
 *   4. Wellbeing longitudinal aggregation. Annual UPSERT on (student,
 *      academic_year, domain) materialised from svc_wellbeing
 *      _responses. NO individual check-in data — only domain averages,
 *      trend direction (IMPROVING / STABLE / DECLINING relative to
 *      prior year), and flagged counts. Read-only surface for staff;
 *      students and guardians 403 at the service layer. Idempotent —
 *      re-running overwrites the same row.
 *
 *   5. MTSS team meeting coordination. 3-value recommendation token
 *      (MAINTAIN / ESCALATE / DE_ESCALATE) maps onto the Cycle 11
 *      5-value outcome enum (NO_CHANGE / TIER_UP / TIER_DOWN) at the
 *      service layer so the new surface and the legacy Cycle 11 MTSS
 *      controller coexist on the same row without a schema change.
 *
 * Refuses STUDENT and GUARDIAN at the service layer on every surface
 * — student services advanced is staff-only. 0 cross-schema FKs in
 * the schema.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [
    CaseloadDashboardService,
    AgencyReferralService,
    WellbeingLongitudinalService,
    MtssTeamMeetingService,
    CrisisEscalationService,
  ],
  controllers: [StudentServicesAdvancedController],
  exports: [
    CaseloadDashboardService,
    AgencyReferralService,
    WellbeingLongitudinalService,
    MtssTeamMeetingService,
    CrisisEscalationService,
  ],
})
export class StudentServicesAdvancedModule {}
