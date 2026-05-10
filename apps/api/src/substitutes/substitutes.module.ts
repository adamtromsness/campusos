import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { IamModule } from '../iam/iam.module';
import { KafkaModule } from '../kafka/kafka.module';
import { SubstituteProfileService } from './substitute-profile.service';
import { SchoolPoolService } from './school-pool.service';
import { JobPostingService } from './job-posting.service';
import { SubstitutesController } from './substitutes.controller';

/**
 * SubstitutesModule — Phase 2 Cycle 9 sub-cycle a (P2-9a).
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
 * P2-9a scope (this commit):
 *   - SubstituteProfileService — profile CRUD, matching engine search,
 *     availability resolver (BLOCKED overrides RECURRING).
 *   - SchoolPoolService — list / add / suspend / remove pool members.
 *   - JobPostingService — post job, list, accept, decline. Tier 1 POOL
 *     fan-out fires inline on post(); tier 2 MARKETPLACE escalation +
 *     PENDING-to-EXPIRED sweep are P2-9b workers.
 *   - 1 Kafka emit topic via outbox: sub.job.posted, sub.assignment.confirmed.
 *
 * P2-9b carry-overs (next session):
 *   - Availability + Preference services (POST / DELETE endpoints; the
 *     read paths are exposed implicitly through the search/availability
 *     resolver).
 *   - JobNotificationWorker (tier 2 escalation on
 *     escalate_to_marketplace_at).
 *   - AcceptanceExpiryWorker (PENDING -> EXPIRED on window timeout).
 *   - AssignmentService (check-in / check-out / cancel + late-cancel
 *     policy worker + sub.assignment.late_cancelled emit).
 *   - RatingService (bidirectional ratings + overall_rating
 *     re-materialisation).
 *   - SessionNoteService (handover notes + returning-teacher
 *     notification).
 *   - PayRateService (compute pay for an assignment + EXCLUDE-gist
 *     date-range mutation surface).
 *   - CancellationPolicyService.
 *   - 6 web routes.
 *   - vitest unit + integration tests.
 *   - Cover arrangement consumer (Cycle 5 sch_cover_arrangements link).
 *
 * Authorisation contract (P2-9a):
 *   SCH-004:read   — Teacher (read own coverage), Staff, Admin
 *   SCH-004:write  — Staff (operator persona), Admin (post jobs, manage pool)
 *   SUB-001:read   — Teacher (returning teacher session-notes view), Staff, Admin
 *   SUB-001:write  — Staff (substitute self-service stand-in), Admin
 *
 * Note — a dedicated Substitute role is on the Wave 2 Phase 2 punch list
 * alongside the Counsellor / Nurse / Librarian / AD / EO splits. For
 * P2-9a the substitute self-service path runs through Staff, with the
 * platform_substitute_profiles.person_id = actor.personId match as the
 * actual access boundary.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [SubstituteProfileService, SchoolPoolService, JobPostingService],
  controllers: [SubstitutesController],
  exports: [SubstituteProfileService, SchoolPoolService, JobPostingService],
})
export class SubstitutesModule {}
