import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { ConsumedMessage, KafkaConsumerService } from '@shared/kafka/kafka-consumer.service';
import { IdempotencyService } from '@shared/kafka/idempotency.service';
import { prefixedTopic } from '@shared/kafka/event-envelope';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { CheckpointService } from '../workers.service';
import {
  assertPayloadSchoolMatchesEnvelope,
  claimReadModelContribution,
  dispatchOperationsEvent,
  monthAnchor,
} from '../operations/operations-worker-base';
import type { UnwrappedEvent } from '@modules/m40-communications/notifications/consumers/notification-consumer-base';

/* =========================================================================
   P2-15b Engagement + Performance Read-Model Workers (M110 Analytics .1).

   8 workers (7 LIVE Kafka consumers + 1 WEEKLY BATCH) wired to the 9 new
   rpt_* tables landed by migration 147. AthleticsReadModelWorker is the
   single writer to BOTH rpt_ath_season_summary AND rpt_game_results —
   one worker, two target tables, still single-writer per table.

   Source-module → consumer-group mapping (single-writer guarantee):

     EnrolmentReadModelWorker      →  enrolment-readmodel-worker
     AthleticsReadModelWorker      →  athletics-readmodel-worker
     OfficialsReadModelWorker      →  officials-readmodel-worker (WEEKLY BATCH)
     GroupsReadModelWorker         →  groups-readmodel-worker
     PublicationsReadModelWorker   →  publications-readmodel-worker
     ClubsReadModelWorker          →  clubs-readmodel-worker
     CommsReadModelWorker          →  comms-readmodel-worker
     WellbeingReadModelWorker      →  wellbeing-readmodel-worker

   OfficialsReadModelWorker is the only weekly batch in P2-15b — assignment
   volume is small, official ratings settle after the game, and a weekly
   roll-up avoids unnecessary write churn (Architecture Review §19).

   WellbeingReadModelWorker aggregates by (school, period, grade_level,
   domain). NO individual student attribution — the schema enforces this
   (rpt_wellbeing_domain_trends has no student_id column), and the worker
   joins through sis_students.grade_level on read but never persists the
   student_id back to rpt_*.
   ========================================================================= */

/* ---- 1. Enrolment Funnel: enr.application.*, enr.offer.*, enr.tour.booked --- */

interface ApplicationSubmittedPayload {
  applicationId: string;
  schoolId: string;
  academicYearName?: string;
  academicYear?: string;
  submittedAt?: string;
}

interface ApplicationReviewedPayload {
  applicationId: string;
  schoolId: string;
  academicYearName?: string;
  academicYear?: string;
  status?: 'WAITLISTED' | string;
}

interface OfferIssuedPayload {
  offerId: string;
  schoolId: string;
  academicYearName?: string;
  academicYear?: string;
}

interface OfferRespondedPayload {
  offerId: string;
  schoolId: string;
  familyResponse?: 'ACCEPTED' | 'DECLINED' | 'DEFERRED';
  status?: string;
  academicYearName?: string;
  academicYear?: string;
}

interface StudentEnrolledPayload {
  applicationId: string;
  schoolId: string;
  academicYearName?: string;
  academicYear?: string;
}

interface TourBookedPayload {
  bookingId: string;
  schoolId: string;
  academicYear?: string;
}

type EnrolmentEventPayload =
  | ApplicationSubmittedPayload
  | ApplicationReviewedPayload
  | OfferIssuedPayload
  | OfferRespondedPayload
  | StudentEnrolledPayload
  | TourBookedPayload;

@Injectable()
export class EnrolmentReadModelWorker implements OnModuleInit {
  private readonly logger = new Logger(EnrolmentReadModelWorker.name);
  private static readonly CONSUMER_GROUP = 'enrolment-readmodel-worker';
  private static readonly SOURCE_TOPICS = [
    'enr.application.submitted',
    'enr.application.status_changed',
    'enr.offer.issued',
    'enr.offer.responded',
    'enr.student.enrolled',
    'enr.tour.booked',
  ];

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly checkpoints: CheckpointService,
  ) {}

  async onModuleInit(): Promise<void> {
    const self = this;
    await this.consumer.subscribe({
      topics: EnrolmentReadModelWorker.SOURCE_TOPICS.map(prefixedTopic),
      groupId: EnrolmentReadModelWorker.CONSUMER_GROUP,
      handler: function (msg: ConsumedMessage): Promise<void> {
        return self.handle(msg);
      },
    });
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    await dispatchOperationsEvent<EnrolmentEventPayload>(
      msg,
      EnrolmentReadModelWorker.CONSUMER_GROUP,
      this.idempotency,
      this.logger,
      async (event) => {
        await this.upsert(event, msg.topic);
        await this.checkpoints.record(
          EnrolmentReadModelWorker.CONSUMER_GROUP,
          msg.topic,
          msg.partition ?? 0,
          msg.offset !== undefined ? Number(msg.offset) : 0,
        );
      },
    );
  }

  async upsert(event: UnwrappedEvent<EnrolmentEventPayload>, topic: string): Promise<void> {
    const p = event.payload as unknown as Record<string, unknown>;
    const schoolId = typeof p.schoolId === 'string' ? p.schoolId : null;
    if (!schoolId) {
      this.logger.warn('[' + EnrolmentReadModelWorker.CONSUMER_GROUP + '] missing schoolId — drop');
      return;
    }
    if (
      !assertPayloadSchoolMatchesEnvelope(
        event,
        schoolId,
        EnrolmentReadModelWorker.CONSUMER_GROUP,
        topic,
        this.logger,
      )
    ) {
      return;
    }
    const academicYear =
      (typeof p.academicYearName === 'string' && p.academicYearName) ||
      (typeof p.academicYear === 'string' && p.academicYear) ||
      'UNKNOWN';

    let appsDelta = 0;
    let toursDelta = 0;
    let offersMadeDelta = 0;
    let offersAcceptedDelta = 0;
    let enrolledDelta = 0;
    let waitlistedDelta = 0;

    if (topic.endsWith('enr.application.submitted')) appsDelta = 1;
    else if (topic.endsWith('enr.application.status_changed')) {
      const status = typeof p.status === 'string' ? p.status : null;
      if (status === 'WAITLISTED') waitlistedDelta = 1;
    } else if (topic.endsWith('enr.offer.issued')) offersMadeDelta = 1;
    else if (topic.endsWith('enr.offer.responded')) {
      const resp = typeof p.familyResponse === 'string' ? p.familyResponse : null;
      if (resp === 'ACCEPTED') offersAcceptedDelta = 1;
    } else if (topic.endsWith('enr.student.enrolled')) enrolledDelta = 1;
    else if (topic.endsWith('enr.tour.booked')) toursDelta = 1;

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const claimed = await claimReadModelContribution(
        tx,
        EnrolmentReadModelWorker.CONSUMER_GROUP,
        event.eventId,
        'rpt_enr_funnel_summary',
      );
      if (!claimed) return;
      await tx.$executeRawUnsafe(
        `INSERT INTO rpt_enr_funnel_summary
          (id, school_id, academic_year, applications_received, tours_booked, offers_made,
           offers_accepted, enrolled, waitlisted, conversion_rate, generated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, NULL, now())
         ON CONFLICT (school_id, academic_year) DO UPDATE
           SET applications_received = rpt_enr_funnel_summary.applications_received + EXCLUDED.applications_received,
               tours_booked = rpt_enr_funnel_summary.tours_booked + EXCLUDED.tours_booked,
               offers_made = rpt_enr_funnel_summary.offers_made + EXCLUDED.offers_made,
               offers_accepted = rpt_enr_funnel_summary.offers_accepted + EXCLUDED.offers_accepted,
               enrolled = rpt_enr_funnel_summary.enrolled + EXCLUDED.enrolled,
               waitlisted = rpt_enr_funnel_summary.waitlisted + EXCLUDED.waitlisted,
               conversion_rate = CASE
                 WHEN (rpt_enr_funnel_summary.applications_received + EXCLUDED.applications_received) > 0
                 THEN LEAST(((rpt_enr_funnel_summary.enrolled + EXCLUDED.enrolled)::numeric
                       / (rpt_enr_funnel_summary.applications_received + EXCLUDED.applications_received)), 1)
                 ELSE NULL
               END,
               generated_at = now()`,
        generateId(),
        schoolId,
        academicYear,
        appsDelta,
        toursDelta,
        offersMadeDelta,
        offersAcceptedDelta,
        enrolledDelta,
        waitlistedDelta,
      );
    });
  }
}

/* ---- 2. Athletics: ath.game.completed (writes BOTH season_summary + game_results) --- */

interface GameCompletedPayload {
  gameId: string;
  schoolId: string;
  seasonId: string;
  programmeId: string;
  sport: string;
  homeScore: number;
  awayScore: number;
  result: 'WIN' | 'LOSS' | 'DRAW';
  rosterSize?: number;
  injuriesThisGame?: number;
  statisticalLeaders?: Array<{ playerId: string; name: string; statType: string; value: number }>;
  completedAt: string;
}

@Injectable()
export class AthleticsReadModelWorker implements OnModuleInit {
  private readonly logger = new Logger(AthleticsReadModelWorker.name);
  private static readonly CONSUMER_GROUP = 'athletics-readmodel-worker';
  private static readonly SOURCE_TOPIC = 'ath.game.completed';

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly checkpoints: CheckpointService,
  ) {}

  async onModuleInit(): Promise<void> {
    const self = this;
    await this.consumer.subscribe({
      topics: [prefixedTopic(AthleticsReadModelWorker.SOURCE_TOPIC)],
      groupId: AthleticsReadModelWorker.CONSUMER_GROUP,
      handler: function (msg: ConsumedMessage): Promise<void> {
        return self.handle(msg);
      },
    });
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    await dispatchOperationsEvent<GameCompletedPayload>(
      msg,
      AthleticsReadModelWorker.CONSUMER_GROUP,
      this.idempotency,
      this.logger,
      async (event) => {
        await this.upsert(event);
        await this.checkpoints.record(
          AthleticsReadModelWorker.CONSUMER_GROUP,
          msg.topic,
          msg.partition ?? 0,
          msg.offset !== undefined ? Number(msg.offset) : 0,
        );
      },
    );
  }

  async upsert(event: UnwrappedEvent<GameCompletedPayload>): Promise<void> {
    const p = event.payload;
    if (!p.schoolId || !p.seasonId || !p.programmeId || !p.gameId) {
      this.logger.warn(
        '[' +
          AthleticsReadModelWorker.CONSUMER_GROUP +
          '] missing schoolId/seasonId/programmeId/gameId — drop',
      );
      return;
    }
    if (
      !assertPayloadSchoolMatchesEnvelope(
        event,
        p.schoolId,
        AthleticsReadModelWorker.CONSUMER_GROUP,
        event.topic,
        this.logger,
      )
    ) {
      return;
    }
    const winDelta = p.result === 'WIN' ? 1 : 0;
    const lossDelta = p.result === 'LOSS' ? 1 : 0;
    const drawDelta = p.result === 'DRAW' ? 1 : 0;
    const injuries = Number(p.injuriesThisGame ?? 0);
    const rosterSize = Number(p.rosterSize ?? 0);
    const leaders = JSON.stringify(p.statisticalLeaders ?? []);

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // 2a. Per-game grain → rpt_game_results
      const gameClaimed = await claimReadModelContribution(
        tx,
        AthleticsReadModelWorker.CONSUMER_GROUP,
        event.eventId,
        'rpt_game_results',
      );
      if (gameClaimed) {
        await tx.$executeRawUnsafe(
          `INSERT INTO rpt_game_results
            (id, school_id, game_id, sport, home_score, away_score, result, season_id, statistical_leaders, generated_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::uuid, $9::jsonb, now())
           ON CONFLICT (school_id, game_id) DO UPDATE
             SET sport = EXCLUDED.sport,
                 home_score = EXCLUDED.home_score,
                 away_score = EXCLUDED.away_score,
                 result = EXCLUDED.result,
                 season_id = EXCLUDED.season_id,
                 statistical_leaders = EXCLUDED.statistical_leaders,
                 generated_at = now()`,
          generateId(),
          p.schoolId,
          p.gameId,
          p.sport,
          p.homeScore,
          p.awayScore,
          p.result,
          p.seasonId,
          leaders,
        );
      }

      // 2b. Per-(school, season, programme) rollup → rpt_ath_season_summary
      const seasonClaimed = await claimReadModelContribution(
        tx,
        AthleticsReadModelWorker.CONSUMER_GROUP,
        event.eventId,
        'rpt_ath_season_summary',
      );
      if (seasonClaimed) {
        await tx.$executeRawUnsafe(
          `INSERT INTO rpt_ath_season_summary
            (id, school_id, season_id, programme_id, games_played, wins, losses, draws,
             win_rate, total_roster_size, injury_count, generated_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, $5, $6, $7, NULL, $8, $9, now())
           ON CONFLICT (school_id, season_id, programme_id) DO UPDATE
             SET games_played = rpt_ath_season_summary.games_played + 1,
                 wins = rpt_ath_season_summary.wins + EXCLUDED.wins,
                 losses = rpt_ath_season_summary.losses + EXCLUDED.losses,
                 draws = rpt_ath_season_summary.draws + EXCLUDED.draws,
                 win_rate = CASE
                   WHEN (rpt_ath_season_summary.games_played + 1) > 0
                   THEN ((rpt_ath_season_summary.wins + EXCLUDED.wins)::numeric
                         / (rpt_ath_season_summary.games_played + 1))
                   ELSE NULL
                 END,
                 total_roster_size = GREATEST(rpt_ath_season_summary.total_roster_size, EXCLUDED.total_roster_size),
                 injury_count = rpt_ath_season_summary.injury_count + EXCLUDED.injury_count,
                 generated_at = now()`,
          generateId(),
          p.schoolId,
          p.seasonId,
          p.programmeId,
          winDelta,
          lossDelta,
          drawDelta,
          rosterSize,
          injuries,
        );
      }
    });
  }
}

/* ---- 3. Officials: WEEKLY BATCH (ath_official_assignments aggregate) --- */

@Injectable()
export class OfficialsReadModelWorker {
  private static readonly CONSUMER_GROUP = 'officials-readmodel-worker';

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly checkpoints: CheckpointService,
  ) {}

  /**
   * Weekly batch materialisation for the officials marketplace rollup.
   * Caller supplies schoolId + the period anchor (ISO Monday of the week).
   * Aggregates from ath_official_assignments by status, cost, and ratings.
   *
   * Idempotent — replaying for the same (schoolId, period) UPSERTs the row.
   */
  async materialise(
    schoolId: string,
    period: string,
  ): Promise<{ rowsWritten: number; durationMs: number }> {
    const start = Date.now();
    let rowsWritten = 0;
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const tableExists = (await client.$queryRawUnsafe(
        `SELECT 1 FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_name = 'ath_official_assignments' LIMIT 1`,
      )) as Array<unknown>;
      if (tableExists.length === 0) {
        // Domain table not present in this tenant — write a zero row so the
        // dashboard always renders something, then bail.
        await client.$executeRawUnsafe(
          `INSERT INTO rpt_officials_marketplace
            (id, school_id, period, total_assignments, fill_rate, avg_cost_per_game,
             avg_official_rating, avg_school_rating, generated_at)
           VALUES ($1::uuid, $2::uuid, $3::date, 0, NULL, NULL, NULL, NULL, now())
           ON CONFLICT (school_id, period) DO UPDATE
             SET total_assignments = 0,
                 fill_rate = NULL,
                 avg_cost_per_game = NULL,
                 avg_official_rating = NULL,
                 avg_school_rating = NULL,
                 generated_at = now()`,
          generateId(),
          schoolId,
          period,
        );
        rowsWritten = 1;
        return;
      }

      const rows = (await client.$queryRawUnsafe(
        // REVIEW-P2C15 R1 BLOCKING 2 — school-scope the source aggregate so
        // cross-school assignments in a multi-school tenant cannot pollute the
        // current school's marketplace row. ath_official_assignments has no
        // direct school_id column; the chain is
        //   ath_official_assignments.game_id
        //     → ath_games.roster_id → ath_rosters.season_id
        //       → ath_seasons.programme_id → ath_programmes.school_id
        // Cycle 13 documented this lineage.
        //
        // Also fixed: the prior SQL referenced AVG(stipend) but the actual
        // column on ath_official_assignments is `fee`.
        `SELECT COUNT(*)::int AS total_assignments,
                COUNT(*) FILTER (WHERE oa.status = 'CONFIRMED')::int AS filled,
                AVG(oa.fee)::numeric AS avg_cost_per_game
         FROM ath_official_assignments oa
         JOIN ath_games g ON g.id = oa.game_id
         JOIN ath_rosters r ON r.id = g.roster_id
         JOIN ath_seasons s ON s.id = r.season_id
         JOIN ath_programmes pr ON pr.id = s.programme_id
         WHERE pr.school_id = $2::uuid
           AND oa.created_at >= $1::date AND oa.created_at < ($1::date + INTERVAL '7 days')`,
        period,
        schoolId,
      )) as Array<{
        total_assignments: number;
        filled: number;
        avg_cost_per_game: string | number | null;
      }>;
      const row = rows[0] ?? { total_assignments: 0, filled: 0, avg_cost_per_game: null };
      const fillRate =
        row.total_assignments > 0 ? (row.filled / row.total_assignments).toFixed(4) : null;

      await client.$executeRawUnsafe(
        `INSERT INTO rpt_officials_marketplace
          (id, school_id, period, total_assignments, fill_rate, avg_cost_per_game,
           avg_official_rating, avg_school_rating, generated_at)
         VALUES ($1::uuid, $2::uuid, $3::date, $4, $5::numeric, $6::numeric, NULL, NULL, now())
         ON CONFLICT (school_id, period) DO UPDATE
           SET total_assignments = EXCLUDED.total_assignments,
               fill_rate = EXCLUDED.fill_rate,
               avg_cost_per_game = EXCLUDED.avg_cost_per_game,
               generated_at = now()`,
        generateId(),
        schoolId,
        period,
        row.total_assignments,
        fillRate,
        row.avg_cost_per_game === null ? null : Number(row.avg_cost_per_game).toFixed(2),
      );
      rowsWritten = 1;
    });
    await this.checkpoints.record(
      OfficialsReadModelWorker.CONSUMER_GROUP,
      'rpt_officials_marketplace_weekly',
      0,
      rowsWritten,
    );
    return { rowsWritten, durationMs: Date.now() - start };
  }
}

/* ---- 4. Groups: grp.post.created + grp.member.joined --- */

interface GroupEventPayload {
  schoolId: string;
  groupId: string;
  eventType: 'POST_CREATED' | 'MEMBER_JOINED' | 'COMMENT_CREATED';
  occurredAt: string;
}

@Injectable()
export class GroupsReadModelWorker implements OnModuleInit {
  private readonly logger = new Logger(GroupsReadModelWorker.name);
  private static readonly CONSUMER_GROUP = 'groups-readmodel-worker';
  private static readonly SOURCE_TOPICS = [
    'grp.post.created',
    'grp.member.joined',
    'grp.comment.created',
  ];

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly checkpoints: CheckpointService,
  ) {}

  async onModuleInit(): Promise<void> {
    const self = this;
    await this.consumer.subscribe({
      topics: GroupsReadModelWorker.SOURCE_TOPICS.map(prefixedTopic),
      groupId: GroupsReadModelWorker.CONSUMER_GROUP,
      handler: function (msg: ConsumedMessage): Promise<void> {
        return self.handle(msg);
      },
    });
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    await dispatchOperationsEvent<GroupEventPayload>(
      msg,
      GroupsReadModelWorker.CONSUMER_GROUP,
      this.idempotency,
      this.logger,
      async (event) => {
        await this.upsert(event, msg.topic);
        await this.checkpoints.record(
          GroupsReadModelWorker.CONSUMER_GROUP,
          msg.topic,
          msg.partition ?? 0,
          msg.offset !== undefined ? Number(msg.offset) : 0,
        );
      },
    );
  }

  async upsert(event: UnwrappedEvent<GroupEventPayload>, topic: string): Promise<void> {
    const p = event.payload;
    if (!p.schoolId || !p.groupId || !p.occurredAt) {
      this.logger.warn('[' + GroupsReadModelWorker.CONSUMER_GROUP + '] missing fields — drop');
      return;
    }
    if (
      !assertPayloadSchoolMatchesEnvelope(
        event,
        p.schoolId,
        GroupsReadModelWorker.CONSUMER_GROUP,
        topic,
        this.logger,
      )
    ) {
      return;
    }
    const period = monthAnchor(p.occurredAt);
    let postsDelta = 0;
    let commentsDelta = 0;
    let memberDelta = 0;
    if (topic.endsWith('grp.post.created')) postsDelta = 1;
    else if (topic.endsWith('grp.comment.created')) commentsDelta = 1;
    else if (topic.endsWith('grp.member.joined')) memberDelta = 1;

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const claimed = await claimReadModelContribution(
        tx,
        GroupsReadModelWorker.CONSUMER_GROUP,
        event.eventId,
        'rpt_grp_engagement_summary',
      );
      if (!claimed) return;
      await tx.$executeRawUnsafe(
        `INSERT INTO rpt_grp_engagement_summary
          (id, school_id, group_id, period, total_members, active_members,
           posts_count, comments_count, engagement_rate, generated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5, $5, $6, $7, NULL, now())
         ON CONFLICT (school_id, group_id, period) DO UPDATE
           SET total_members = rpt_grp_engagement_summary.total_members + EXCLUDED.total_members,
               active_members = LEAST(
                 rpt_grp_engagement_summary.total_members + EXCLUDED.total_members,
                 rpt_grp_engagement_summary.active_members + GREATEST(EXCLUDED.posts_count, EXCLUDED.comments_count, EXCLUDED.total_members)
               ),
               posts_count = rpt_grp_engagement_summary.posts_count + EXCLUDED.posts_count,
               comments_count = rpt_grp_engagement_summary.comments_count + EXCLUDED.comments_count,
               engagement_rate = CASE
                 WHEN (rpt_grp_engagement_summary.total_members + EXCLUDED.total_members) > 0
                 THEN LEAST((rpt_grp_engagement_summary.active_members + EXCLUDED.total_members)::numeric
                            / (rpt_grp_engagement_summary.total_members + EXCLUDED.total_members), 1)
                 ELSE NULL
               END,
               generated_at = now()`,
        generateId(),
        p.schoolId,
        p.groupId,
        period,
        memberDelta,
        postsDelta,
        commentsDelta,
      );
    });
  }
}

/* ---- 5. Publications: pub.publication.published --- */

interface PublicationPublishedPayload {
  publicationId: string;
  schoolId: string;
  timeToPublishDays?: number;
  views?: number;
  downloads?: number;
  publishedAt: string;
}

@Injectable()
export class PublicationsReadModelWorker implements OnModuleInit {
  private readonly logger = new Logger(PublicationsReadModelWorker.name);
  private static readonly CONSUMER_GROUP = 'publications-readmodel-worker';
  private static readonly SOURCE_TOPIC = 'pub.publication.published';

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly checkpoints: CheckpointService,
  ) {}

  async onModuleInit(): Promise<void> {
    const self = this;
    await this.consumer.subscribe({
      topics: [prefixedTopic(PublicationsReadModelWorker.SOURCE_TOPIC)],
      groupId: PublicationsReadModelWorker.CONSUMER_GROUP,
      handler: function (msg: ConsumedMessage): Promise<void> {
        return self.handle(msg);
      },
    });
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    await dispatchOperationsEvent<PublicationPublishedPayload>(
      msg,
      PublicationsReadModelWorker.CONSUMER_GROUP,
      this.idempotency,
      this.logger,
      async (event) => {
        await this.upsert(event);
        await this.checkpoints.record(
          PublicationsReadModelWorker.CONSUMER_GROUP,
          msg.topic,
          msg.partition ?? 0,
          msg.offset !== undefined ? Number(msg.offset) : 0,
        );
      },
    );
  }

  async upsert(event: UnwrappedEvent<PublicationPublishedPayload>): Promise<void> {
    const p = event.payload;
    if (!p.schoolId || !p.publishedAt) {
      this.logger.warn(
        '[' + PublicationsReadModelWorker.CONSUMER_GROUP + '] missing schoolId/publishedAt — drop',
      );
      return;
    }
    if (
      !assertPayloadSchoolMatchesEnvelope(
        event,
        p.schoolId,
        PublicationsReadModelWorker.CONSUMER_GROUP,
        event.topic,
        this.logger,
      )
    ) {
      return;
    }
    const period = monthAnchor(p.publishedAt);
    const ttp = Number(p.timeToPublishDays ?? 0);
    const views = Math.max(0, Number(p.views ?? 0));
    const downloads = Math.max(0, Number(p.downloads ?? 0));

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const claimed = await claimReadModelContribution(
        tx,
        PublicationsReadModelWorker.CONSUMER_GROUP,
        event.eventId,
        'rpt_pub_distribution_summary',
      );
      if (!claimed) return;
      await tx.$executeRawUnsafe(
        `INSERT INTO rpt_pub_distribution_summary
          (id, school_id, period, publications_count, total_views, total_downloads,
           avg_time_to_publish_days, generated_at)
         VALUES ($1::uuid, $2::uuid, $3::date, 1, $4, $5, $6::numeric, now())
         ON CONFLICT (school_id, period) DO UPDATE
           SET publications_count = rpt_pub_distribution_summary.publications_count + 1,
               total_views = rpt_pub_distribution_summary.total_views + EXCLUDED.total_views,
               total_downloads = rpt_pub_distribution_summary.total_downloads + EXCLUDED.total_downloads,
               avg_time_to_publish_days = CASE
                 WHEN $7::numeric IS NULL OR $7::numeric = 0 THEN rpt_pub_distribution_summary.avg_time_to_publish_days
                 WHEN rpt_pub_distribution_summary.avg_time_to_publish_days IS NULL THEN $7::numeric
                 ELSE (((rpt_pub_distribution_summary.avg_time_to_publish_days * rpt_pub_distribution_summary.publications_count) + $7::numeric)::numeric
                       / (rpt_pub_distribution_summary.publications_count + 1))
               END,
               generated_at = now()`,
        generateId(),
        p.schoolId,
        period,
        views,
        downloads,
        ttp > 0 ? ttp.toFixed(2) : null,
        ttp > 0 ? ttp.toFixed(2) : null,
      );
    });
  }
}

/* ---- 6. Clubs/Extracurricular: ext.activity.completed --- */

interface ExtActivityCompletedPayload {
  activityId: string;
  schoolId: string;
  clubId: string;
  academicYear: string;
  attendees?: number;
  totalRegistered?: number;
  budgetSpent?: number | string;
  completedAt: string;
}

@Injectable()
export class ClubsReadModelWorker implements OnModuleInit {
  private readonly logger = new Logger(ClubsReadModelWorker.name);
  private static readonly CONSUMER_GROUP = 'clubs-readmodel-worker';
  private static readonly SOURCE_TOPIC = 'ext.activity.completed';

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly checkpoints: CheckpointService,
  ) {}

  async onModuleInit(): Promise<void> {
    const self = this;
    await this.consumer.subscribe({
      topics: [prefixedTopic(ClubsReadModelWorker.SOURCE_TOPIC)],
      groupId: ClubsReadModelWorker.CONSUMER_GROUP,
      handler: function (msg: ConsumedMessage): Promise<void> {
        return self.handle(msg);
      },
    });
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    await dispatchOperationsEvent<ExtActivityCompletedPayload>(
      msg,
      ClubsReadModelWorker.CONSUMER_GROUP,
      this.idempotency,
      this.logger,
      async (event) => {
        await this.upsert(event);
        await this.checkpoints.record(
          ClubsReadModelWorker.CONSUMER_GROUP,
          msg.topic,
          msg.partition ?? 0,
          msg.offset !== undefined ? Number(msg.offset) : 0,
        );
      },
    );
  }

  async upsert(event: UnwrappedEvent<ExtActivityCompletedPayload>): Promise<void> {
    const p = event.payload;
    if (!p.schoolId || !p.clubId || !p.academicYear) {
      this.logger.warn('[' + ClubsReadModelWorker.CONSUMER_GROUP + '] missing fields — drop');
      return;
    }
    if (
      !assertPayloadSchoolMatchesEnvelope(
        event,
        p.schoolId,
        ClubsReadModelWorker.CONSUMER_GROUP,
        event.topic,
        this.logger,
      )
    ) {
      return;
    }
    const attendees = Math.max(0, Number(p.attendees ?? 0));
    const registered = Math.max(0, Number(p.totalRegistered ?? attendees));
    const attRate = registered > 0 ? Math.min(attendees / registered, 1).toFixed(4) : null;
    const budget = Number(p.budgetSpent ?? 0);

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const claimed = await claimReadModelContribution(
        tx,
        ClubsReadModelWorker.CONSUMER_GROUP,
        event.eventId,
        'rpt_ext_service_summary',
      );
      if (!claimed) return;
      await tx.$executeRawUnsafe(
        `INSERT INTO rpt_ext_service_summary
          (id, school_id, academic_year, club_id, total_members, attendance_rate,
           events_held, budget_spent, generated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6::numeric, 1, $7::numeric, now())
         ON CONFLICT (school_id, academic_year, club_id) DO UPDATE
           SET total_members = GREATEST(rpt_ext_service_summary.total_members, EXCLUDED.total_members),
               attendance_rate = CASE
                 WHEN $8::numeric IS NULL THEN rpt_ext_service_summary.attendance_rate
                 WHEN rpt_ext_service_summary.attendance_rate IS NULL THEN $8::numeric
                 ELSE (((rpt_ext_service_summary.attendance_rate * rpt_ext_service_summary.events_held) + $8::numeric)::numeric
                       / (rpt_ext_service_summary.events_held + 1))
               END,
               events_held = rpt_ext_service_summary.events_held + 1,
               budget_spent = rpt_ext_service_summary.budget_spent + EXCLUDED.budget_spent,
               generated_at = now()`,
        generateId(),
        p.schoolId,
        p.academicYear,
        p.clubId,
        registered,
        attRate,
        budget.toFixed(2),
        attRate,
      );
    });
  }
}

/* ---- 7. Communications: msg.message.sent + msg.broadcast.sent --- */

interface CommsEventPayload {
  schoolId: string;
  delivered?: boolean;
  read?: boolean;
  responseTimeHours?: number | null;
  sentAt: string;
}

@Injectable()
export class CommsReadModelWorker implements OnModuleInit {
  private readonly logger = new Logger(CommsReadModelWorker.name);
  private static readonly CONSUMER_GROUP = 'comms-readmodel-worker';
  private static readonly SOURCE_TOPICS = ['msg.message.sent', 'msg.broadcast.sent'];

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly checkpoints: CheckpointService,
  ) {}

  async onModuleInit(): Promise<void> {
    const self = this;
    await this.consumer.subscribe({
      topics: CommsReadModelWorker.SOURCE_TOPICS.map(prefixedTopic),
      groupId: CommsReadModelWorker.CONSUMER_GROUP,
      handler: function (msg: ConsumedMessage): Promise<void> {
        return self.handle(msg);
      },
    });
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    await dispatchOperationsEvent<CommsEventPayload>(
      msg,
      CommsReadModelWorker.CONSUMER_GROUP,
      this.idempotency,
      this.logger,
      async (event) => {
        await this.upsert(event, msg.topic);
        await this.checkpoints.record(
          CommsReadModelWorker.CONSUMER_GROUP,
          msg.topic,
          msg.partition ?? 0,
          msg.offset !== undefined ? Number(msg.offset) : 0,
        );
      },
    );
  }

  async upsert(event: UnwrappedEvent<CommsEventPayload>, topic: string): Promise<void> {
    const p = event.payload;
    if (!p.schoolId || !p.sentAt) {
      this.logger.warn('[' + CommsReadModelWorker.CONSUMER_GROUP + '] missing fields — drop');
      return;
    }
    if (
      !assertPayloadSchoolMatchesEnvelope(
        event,
        p.schoolId,
        CommsReadModelWorker.CONSUMER_GROUP,
        topic,
        this.logger,
      )
    ) {
      return;
    }
    const period = monthAnchor(p.sentAt);
    const isBroadcast = topic.endsWith('msg.broadcast.sent');
    const messagesDelta = isBroadcast ? 0 : 1;
    const broadcastsDelta = isBroadcast ? 1 : 0;
    const deliveredDelta = p.delivered === false ? 0 : 1;
    const readDelta = p.read === true ? 1 : 0;
    const respTimeHours =
      p.responseTimeHours === null || p.responseTimeHours === undefined
        ? null
        : Math.max(0, Number(p.responseTimeHours));

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const claimed = await claimReadModelContribution(
        tx,
        CommsReadModelWorker.CONSUMER_GROUP,
        event.eventId,
        'rpt_msg_communication_metrics',
      );
      if (!claimed) return;
      await tx.$executeRawUnsafe(
        `INSERT INTO rpt_msg_communication_metrics
          (id, school_id, period, messages_sent, broadcasts_sent, delivery_rate,
           read_rate, avg_response_time_hours, generated_at)
         VALUES ($1::uuid, $2::uuid, $3::date, $4, $5, $6::numeric, $7::numeric, $8::numeric, now())
         ON CONFLICT (school_id, period) DO UPDATE
           SET messages_sent = rpt_msg_communication_metrics.messages_sent + EXCLUDED.messages_sent,
               broadcasts_sent = rpt_msg_communication_metrics.broadcasts_sent + EXCLUDED.broadcasts_sent,
               delivery_rate = CASE
                 WHEN (rpt_msg_communication_metrics.messages_sent + EXCLUDED.messages_sent
                       + rpt_msg_communication_metrics.broadcasts_sent + EXCLUDED.broadcasts_sent) > 0
                 THEN LEAST(
                   ((COALESCE(rpt_msg_communication_metrics.delivery_rate, 0)
                     * (rpt_msg_communication_metrics.messages_sent + rpt_msg_communication_metrics.broadcasts_sent))
                    + $9)::numeric
                   / (rpt_msg_communication_metrics.messages_sent + EXCLUDED.messages_sent
                      + rpt_msg_communication_metrics.broadcasts_sent + EXCLUDED.broadcasts_sent), 1)
                 ELSE NULL
               END,
               read_rate = CASE
                 WHEN (rpt_msg_communication_metrics.messages_sent + EXCLUDED.messages_sent
                       + rpt_msg_communication_metrics.broadcasts_sent + EXCLUDED.broadcasts_sent) > 0
                 THEN LEAST(
                   ((COALESCE(rpt_msg_communication_metrics.read_rate, 0)
                     * (rpt_msg_communication_metrics.messages_sent + rpt_msg_communication_metrics.broadcasts_sent))
                    + $10)::numeric
                   / (rpt_msg_communication_metrics.messages_sent + EXCLUDED.messages_sent
                      + rpt_msg_communication_metrics.broadcasts_sent + EXCLUDED.broadcasts_sent), 1)
                 ELSE NULL
               END,
               avg_response_time_hours = CASE
                 WHEN $11::numeric IS NULL THEN rpt_msg_communication_metrics.avg_response_time_hours
                 WHEN rpt_msg_communication_metrics.avg_response_time_hours IS NULL THEN $11::numeric
                 ELSE ((rpt_msg_communication_metrics.avg_response_time_hours + $11::numeric) / 2)
               END,
               generated_at = now()`,
        generateId(),
        p.schoolId,
        period,
        messagesDelta,
        broadcastsDelta,
        deliveredDelta,
        readDelta,
        respTimeHours !== null ? respTimeHours.toFixed(2) : null,
        deliveredDelta,
        readDelta,
        respTimeHours !== null ? respTimeHours.toFixed(2) : null,
      );
    });
  }
}

/* ---- 8. Wellbeing: svc.wellbeing.response.submitted (PRIVACY KEYSTONE) --- */

interface WellbeingResponseSubmittedPayload {
  responseId: string;
  schoolId: string;
  gradeLevel: string;
  domain: 'ACADEMIC' | 'SOCIAL' | 'EMOTIONAL' | 'PHYSICAL' | 'SAFETY';
  numericResponse?: number | null;
  questionType?: 'SCALE_1_5' | 'SCALE_1_10' | string;
  submittedAt: string;
}

@Injectable()
export class WellbeingReadModelWorker implements OnModuleInit {
  private readonly logger = new Logger(WellbeingReadModelWorker.name);
  private static readonly CONSUMER_GROUP = 'wellbeing-readmodel-worker';
  private static readonly SOURCE_TOPIC = 'svc.wellbeing.response.submitted';

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly checkpoints: CheckpointService,
  ) {}

  async onModuleInit(): Promise<void> {
    const self = this;
    await this.consumer.subscribe({
      topics: [prefixedTopic(WellbeingReadModelWorker.SOURCE_TOPIC)],
      groupId: WellbeingReadModelWorker.CONSUMER_GROUP,
      handler: function (msg: ConsumedMessage): Promise<void> {
        return self.handle(msg);
      },
    });
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    await dispatchOperationsEvent<WellbeingResponseSubmittedPayload>(
      msg,
      WellbeingReadModelWorker.CONSUMER_GROUP,
      this.idempotency,
      this.logger,
      async (event) => {
        await this.upsert(event);
        await this.checkpoints.record(
          WellbeingReadModelWorker.CONSUMER_GROUP,
          msg.topic,
          msg.partition ?? 0,
          msg.offset !== undefined ? Number(msg.offset) : 0,
        );
      },
    );
  }

  /**
   * PRIVACY INVARIANT: this worker writes ONLY (school_id, period,
   * grade_level, domain) — never the response_id, student_id, or any
   * other individual attribution. The schema lacks a student_id column
   * on rpt_wellbeing_domain_trends as the wire-level backstop.
   */
  async upsert(event: UnwrappedEvent<WellbeingResponseSubmittedPayload>): Promise<void> {
    const p = event.payload;
    if (!p.schoolId || !p.gradeLevel || !p.domain) {
      this.logger.warn('[' + WellbeingReadModelWorker.CONSUMER_GROUP + '] missing fields — drop');
      return;
    }
    if (
      !assertPayloadSchoolMatchesEnvelope(
        event,
        p.schoolId,
        WellbeingReadModelWorker.CONSUMER_GROUP,
        event.topic,
        this.logger,
      )
    ) {
      return;
    }
    const period = monthAnchor(p.submittedAt);
    const score =
      p.numericResponse === null || p.numericResponse === undefined
        ? null
        : Number(p.numericResponse);

    // Below threshold heuristic: 1 on SCALE_1_5 or <=2 on SCALE_1_10
    const isSafetyLow =
      p.domain === 'SAFETY' &&
      score !== null &&
      ((p.questionType === 'SCALE_1_5' && score === 1) ||
        (p.questionType === 'SCALE_1_10' && score <= 2));
    const belowThresholdDelta = isSafetyLow ? 1 : 0;

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const claimed = await claimReadModelContribution(
        tx,
        WellbeingReadModelWorker.CONSUMER_GROUP,
        event.eventId,
        'rpt_wellbeing_domain_trends',
      );
      if (!claimed) return;
      await tx.$executeRawUnsafe(
        `INSERT INTO rpt_wellbeing_domain_trends
          (id, school_id, period, grade_level, domain, avg_score, response_count, below_threshold_count, generated_at)
         VALUES ($1::uuid, $2::uuid, $3::date, $4, $5, $6::numeric, 1, $7, now())
         ON CONFLICT (school_id, period, grade_level, domain) DO UPDATE
           SET avg_score = CASE
                 WHEN $8::numeric IS NULL THEN rpt_wellbeing_domain_trends.avg_score
                 WHEN rpt_wellbeing_domain_trends.avg_score IS NULL THEN $8::numeric
                 ELSE (((rpt_wellbeing_domain_trends.avg_score * rpt_wellbeing_domain_trends.response_count)
                        + $8::numeric)::numeric
                       / (rpt_wellbeing_domain_trends.response_count + 1))
               END,
               response_count = rpt_wellbeing_domain_trends.response_count + 1,
               below_threshold_count = rpt_wellbeing_domain_trends.below_threshold_count + EXCLUDED.below_threshold_count,
               generated_at = now()`,
        generateId(),
        p.schoolId,
        period,
        p.gradeLevel,
        p.domain,
        score !== null ? score.toFixed(1) : null,
        belowThresholdDelta,
        score !== null ? score.toFixed(1) : null,
      );
    });
  }
}
