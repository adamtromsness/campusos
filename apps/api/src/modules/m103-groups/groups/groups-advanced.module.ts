import { Module } from '@nestjs/common';
import { TenantModule } from '@modules/m00-platform';
import { IamModule } from '@modules/m00-platform';
import { KafkaModule } from '@shared/kafka';
import { GroupsModule } from './groups.module';
import { PollService } from '../polls/poll.service';
import { GroupMeetupService } from '../events/meetup.service';
import { ResourceLibraryService } from '../resources/resource-library.service';
import { InvitationService } from './invitation.service';
import { GroupAnalyticsService } from './analytics.service';
import { GroupsAdvancedController } from './groups-advanced.controller';

/**
 * Groups Advanced Module — P2-28a (Phase 2 Cycle 28 sub-cycle a).
 *
 * 5 services + 1 controller + ~18 endpoints completing the M103
 * Groups and Communities deferred surface from Cycle 18.
 *
 * Five structural keystones:
 *   1. Atomic poll vote_count INCREMENT inside one tenant tx with
 *      SELECT ... FOR UPDATE on the parent poll. Anonymous polls
 *      write grp_poll_votes with voter_id=NULL — anonymity is
 *      structural at the schema layer. Non-anonymous polls are
 *      protected from double-vote via partial UNIQUE INDEX
 *      (poll_id, voter_id, option_id) WHERE voter_id IS NOT NULL.
 *   2. Meetup RSVP cap check inside locked tx — CONFIRMED count is
 *      recomputed under the lock so two concurrent confirms cannot
 *      both pass max_attendees.
 *   3. Resource library versioning: new-version INSERT and parent
 *      version increment run together in one tenant tx.
 *   4. Invitation ACCEPTED auto-creates grp_members row inside the
 *      same tx — invitation flip and member row land together or
 *      not at all. Pre-existing member is treated as a no-op via
 *      service-side existence check (idempotent) AND the schema's
 *      partial UNIQUE catches a concurrent race.
 *   5. Monthly analytics UPSERT — recompute is idempotent on
 *      (group_id, period). engagement_rate = active_members /
 *      total_members clamped to 0 on empty groups.
 *
 * Imports GroupsModule to reuse GroupService (assertCanManageGroup +
 * row-scope checks). 0 cross-schema FKs in the schema — every
 * cross-table ref is intra-tenant DB-enforced.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule, GroupsModule],
  providers: [
    PollService,
    GroupMeetupService,
    ResourceLibraryService,
    InvitationService,
    GroupAnalyticsService,
  ],
  controllers: [GroupsAdvancedController],
  exports: [
    PollService,
    GroupMeetupService,
    ResourceLibraryService,
    InvitationService,
    GroupAnalyticsService,
  ],
})
export class GroupsAdvancedModule {}
