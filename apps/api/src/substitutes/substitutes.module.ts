import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { IamModule } from '../iam/iam.module';
import { KafkaModule } from '../kafka/kafka.module';
// P2-9a
import { SubstituteProfileService } from './substitute-profile.service';
import { SchoolPoolService } from './school-pool.service';
import { JobPostingService } from './job-posting.service';
import { SubstitutesController } from './substitutes.controller';
// P2-9b
import { SubstituteAvailabilityService } from './availability.service';
import { SubstitutePreferenceService } from './preference.service';
import { AssignmentService } from './assignment.service';
import { RatingService } from './rating.service';
import { SessionNoteService } from './session-note.service';
import { PayRateService } from './pay-rate.service';
import { CancellationPolicyService } from './cancellation-policy.service';
import { SubstitutesPostController } from './substitutes-b.controller';
import { AcceptanceExpiryWorker } from './acceptance-expiry.worker';
import { JobNotificationWorker } from './job-notification.worker';
import { CancellationPolicyConsumer } from './cancellation-policy.consumer';
import { CoverArrangementConsumer } from './cover-arrangement.consumer';

/**
 * SubstitutesModule — Phase 2 Cycle 9 (P2-9a + P2-9b).
 *
 * Plan reference — docs/campusos-p2c9-sub-marketplace.html.
 *
 * Wires the M82 Sub Marketplace tenant + platform tables into a request-
 * path API surface under the /substitutes URL prefix. Per ADR-029 the
 * substitute profile (and credentials, availability, preferences) lives
 * in the platform schema; the school pool, job postings, notifications,
 * assignments, ratings, session notes, pay rates and cancellation
 * policies live in the tenant schema and reference the platform-side
 * profile via soft UUID per ADR-001/020.
 *
 * P2-9a (commit 46751c2):
 *   - SubstituteProfileService — profile CRUD, matching engine search,
 *     availability resolver (BLOCKED overrides RECURRING).
 *   - SchoolPoolService — list / add / suspend / remove pool members.
 *   - JobPostingService — post job, list, accept, decline. Tier 1 POOL
 *     fan-out fires inline on post().
 *   - 13 endpoints under /api/v1/substitutes/*.
 *   - 2 Kafka emit topics via outbox: sub.job.posted, sub.assignment.confirmed.
 *
 * P2-9b (this commit):
 *   - SubstituteAvailabilityService — POST/GET/DELETE for RECURRING +
 *     SPECIFIC + BLOCKED availability rows.
 *   - SubstitutePreferenceService — POST/DELETE for PREFERRED + BLOCKED
 *     school preferences.
 *   - AssignmentService — check-in / check-out (bumps platform
 *     total_assignments counter) / cancel with is_late_cancellation
 *     computed against the school cancellation policy. Emits
 *     sub.assignment.late_cancelled via outbox with a deterministic
 *     v5-shaped UUID event_id.
 *   - RatingService — bidirectional ratings with UNIQUE(assignment,
 *     rater_type) catch + overall_rating re-materialisation on
 *     SCHOOL_RATES_SUB inserts.
 *   - SessionNoteService — handover note with returning-teacher
 *     visibility resolver.
 *   - PayRateService — pay rate CRUD with EXCLUDE-gist 23P01 → 409
 *     translation + computePay (per-substitute override beats school
 *     default).
 *   - CancellationPolicyService — get + upsert with multi-column
 *     suspension_chk / penalty_chk lockstep validated app-side.
 *   - AcceptanceExpiryWorker — 60s poll, flips PENDING → EXPIRED on
 *     window timeout.
 *   - JobNotificationWorker — 60s poll, tier-1 POOL → tier-2 MARKETPLACE
 *     escalation with matching-engine candidate query.
 *   - CancellationPolicyConsumer — subscribes to
 *     sub.assignment.late_cancelled, applies configured consequence
 *     (TEMPORARY_POOL_SUSPENSION / PERMANENT_POOL_REMOVAL /
 *     RATING_PENALTY).
 *   - CoverArrangementConsumer — subscribes to sub.assignment.confirmed,
 *     flips matching sch_coverage_requests OPEN → CANCELLED bridging
 *     contract.
 *   - ~25 additional endpoints under /api/v1/substitutes/*.
 *   - 1 new Kafka emit topic via outbox: sub.assignment.late_cancelled.
 *   - 1 internal-only emit via JobNotificationWorker: sub.job.escalated.
 *
 * Carry-overs to P2-9c (UI + tests):
 *   - 6 web routes (substitute profile, dashboard, school pool manager,
 *     job posting form, coverage dashboard, ratings + pay).
 *   - vitest unit + integration tests for the matching engine, EXCLUDE
 *     gist, acceptance window expiry, cancellation policy escalation.
 *   - Shadow hr_employees row for marketplace substitutes (so
 *     sch_coverage_requests can be properly ASSIGNED rather than
 *     CANCELLED on the bridging path).
 *
 * Authorisation contract (P2-9a + P2-9b):
 *   SCH-004:read   — Teacher (read own coverage), Staff, Admin
 *   SCH-004:write  — Staff (operator persona), Admin
 *   SUB-001:read   — Teacher (returning teacher session-notes view),
 *                    Staff, Admin
 *   SUB-001:write  — Staff (substitute self-service stand-in), Admin
 *
 * A dedicated Substitute role is on the Wave 2 Phase 2 punch list
 * alongside the Counsellor / Nurse / Librarian / AD / EO splits.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [
    // P2-9a
    SubstituteProfileService,
    SchoolPoolService,
    JobPostingService,
    // P2-9b
    SubstituteAvailabilityService,
    SubstitutePreferenceService,
    AssignmentService,
    RatingService,
    SessionNoteService,
    PayRateService,
    CancellationPolicyService,
    // P2-9b workers + consumers
    AcceptanceExpiryWorker,
    JobNotificationWorker,
    CancellationPolicyConsumer,
    CoverArrangementConsumer,
  ],
  controllers: [SubstitutesController, SubstitutesPostController],
  exports: [
    SubstituteProfileService,
    SchoolPoolService,
    JobPostingService,
    SubstituteAvailabilityService,
    SubstitutePreferenceService,
    AssignmentService,
    RatingService,
    SessionNoteService,
    PayRateService,
    CancellationPolicyService,
  ],
})
export class SubstitutesModule {}
