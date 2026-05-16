import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { IamModule } from '../iam/iam.module';
import { ClubBudgetService } from './club-budget.service';
import { FieldTripEvalService } from './field-trip-eval.service';
import { ServicePartnerService } from './service-partner.service';
import { MeetingTemplateService } from './meeting-template.service';
import { AIMinutesService } from './ai-minutes.service';
import { ClubsMeetingsAdvancedController } from './clubs-meetings-advanced.controller';

/**
 * ClubsMeetingsAdvancedModule — P2-28b (Phase 2 Cycle 28 sub-cycle b).
 *
 * 5 services + 1 controller + ~22 endpoints completing the M64
 * Clubs and Student Life deferred surface from Cycle 17 plus the
 * M41 Meetings deferred surface from Cycle 7.
 *
 * Note on elections (CLB-002): the P2-28b plan headers list
 * ext_elections, ext_candidates, ext_votes, and ext_election_voter
 * _check among the 10 tables but those 4 already shipped in Cycle
 * 17 (migration 060_ext_elections_service.sql) with the matching
 * ElectionService and VoteService — including the STRUCTURAL
 * ANONYMITY KEYSTONE on ext_votes (zero voter_id columns anywhere)
 * and the double-vote prevention via ext_election_voter_check PK.
 * P2-28b only ships the 6 truly-new tables and the 5 services
 * needed to drive them.
 *
 * Six structural keystones:
 *   1. Atomic spent_amount adjustment on ext_club_budgets inside the
 *      same tenant tx as the ext_budget_transactions INSERT. EXPENSE
 *      bumps spent up, REFUND bumps spent down, ALLOCATION bumps
 *      allocated, ADJUSTMENT carries rationale only. Refuses EXPENSE
 *      that would exceed allocated and REFUND that would drive spent
 *      below zero. remaining_amount = allocated - spent computed at
 *      read time.
 *   2. Field trip evaluations 1..5 rating bounds enforced at the
 *      schema layer (CHECK on overall + 3 subscales). UNIQUE per
 *      (trip, evaluator) caps each evaluator at one row — second
 *      attempt PATCH-redirects via a friendly 400.
 *   3. Service partner orgs UNIQUE(school, name). is_active gates
 *      visibility in the future student-volunteer placement picker.
 *   4. Meeting templates UNIQUE(school, name). default_agenda JSONB
 *      drives the createMeetingFromTemplate keystone — INSERT one
 *      mtg_meetings row plus N mtg_agenda_items rows inside one
 *      tenant tx.
 *   5. AI minutes UNIQUE(meeting_id). Multi-column status /
 *      generated_chk / approved_chk lockstep enforces the lifecycle
 *      PENDING -> GENERATED -> APPROVED at the schema layer.
 *      Regenerate is refused on APPROVED minutes — approved minutes
 *      are the canonical record.
 *   6. AI Inference stub writes model_version='STUB_VERSION_0' so
 *      P3-A1 swaps the stub for a real model call without changing
 *      the surface — future model upgrades preserve audit
 *      traceability via the column.
 *
 * Refuses STUDENT and GUARDIAN at the service layer on every write
 * path — these surfaces are staff-only. 0 cross-schema FKs in the
 * schema — every cross-table ref is intra-tenant DB-enforced.
 */
@Module({
  imports: [TenantModule, IamModule],
  providers: [
    ClubBudgetService,
    FieldTripEvalService,
    ServicePartnerService,
    MeetingTemplateService,
    AIMinutesService,
  ],
  controllers: [ClubsMeetingsAdvancedController],
  exports: [
    ClubBudgetService,
    FieldTripEvalService,
    ServicePartnerService,
    MeetingTemplateService,
    AIMinutesService,
  ],
})
export class ClubsMeetingsAdvancedModule {}
