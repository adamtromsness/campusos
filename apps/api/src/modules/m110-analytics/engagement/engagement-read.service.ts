import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';

/**
 * Read-only service for the P2-15b engagement + performance read models.
 *
 * Same replica-routed semantics as P2-15a's OperationsReadService — every
 * read is school-scoped from the resolved tenant context and runs through
 * TenantPrismaService.executeInTenantContext. Production deployments swap
 * in a read-replica client; in dev this stays on the primary so the
 * worker upserts are immediately visible.
 */

export interface DateRangeArgs {
  fromDate?: string;
  toDate?: string;
}

export interface EnrolmentFunnelRowDto {
  id: string;
  schoolId: string;
  academicYear: string;
  applicationsReceived: number;
  toursBooked: number;
  offersMade: number;
  offersAccepted: number;
  enrolled: number;
  waitlisted: number;
  conversionRate: number | null;
  generatedAt: string;
}

export interface AthSeasonRowDto {
  id: string;
  schoolId: string;
  seasonId: string;
  programmeId: string;
  gamesPlayed: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number | null;
  totalRosterSize: number;
  injuryCount: number;
  generatedAt: string;
}

export interface OfficialsMarketplaceRowDto {
  id: string;
  schoolId: string;
  period: string;
  totalAssignments: number;
  fillRate: number | null;
  avgCostPerGame: number | null;
  avgOfficialRating: number | null;
  avgSchoolRating: number | null;
  generatedAt: string;
}

export interface GameResultRowDto {
  id: string;
  schoolId: string;
  gameId: string;
  sport: string;
  homeScore: number;
  awayScore: number;
  result: string;
  seasonId: string;
  statisticalLeaders: unknown;
  generatedAt: string;
}

export interface GroupsEngagementRowDto {
  id: string;
  schoolId: string;
  groupId: string;
  period: string;
  totalMembers: number;
  activeMembers: number;
  postsCount: number;
  commentsCount: number;
  engagementRate: number | null;
  generatedAt: string;
}

export interface PublicationsRowDto {
  id: string;
  schoolId: string;
  period: string;
  publicationsCount: number;
  totalViews: number;
  totalDownloads: number;
  avgTimeToPublishDays: number | null;
  generatedAt: string;
}

export interface ClubsServiceRowDto {
  id: string;
  schoolId: string;
  academicYear: string;
  clubId: string;
  totalMembers: number;
  attendanceRate: number | null;
  eventsHeld: number;
  budgetSpent: number;
  generatedAt: string;
}

export interface CommsMetricsRowDto {
  id: string;
  schoolId: string;
  period: string;
  messagesSent: number;
  broadcastsSent: number;
  deliveryRate: number | null;
  readRate: number | null;
  avgResponseTimeHours: number | null;
  generatedAt: string;
}

export interface WellbeingDomainTrendRowDto {
  id: string;
  schoolId: string;
  period: string;
  gradeLevel: string;
  domain: string;
  avgScore: number | null;
  responseCount: number;
  belowThresholdCount: number;
  generatedAt: string;
}

@Injectable()
export class EngagementReadService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async listEnrolmentFunnel(): Promise<EnrolmentFunnelRowDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id, academic_year,
                applications_received, tours_booked, offers_made, offers_accepted,
                enrolled, waitlisted, conversion_rate::float AS conversion_rate,
                generated_at::text AS generated_at
         FROM rpt_enr_funnel_summary
         WHERE school_id = $1::uuid
         ORDER BY academic_year DESC`,
        tenant.schoolId,
      )) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        id: String(r.id),
        schoolId: String(r.school_id),
        academicYear: String(r.academic_year),
        applicationsReceived: Number(r.applications_received),
        toursBooked: Number(r.tours_booked),
        offersMade: Number(r.offers_made),
        offersAccepted: Number(r.offers_accepted),
        enrolled: Number(r.enrolled),
        waitlisted: Number(r.waitlisted),
        conversionRate: r.conversion_rate === null ? null : Number(r.conversion_rate),
        generatedAt: String(r.generated_at),
      }));
    });
  }

  async listAthSeasons(): Promise<AthSeasonRowDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id, season_id::text AS season_id,
                programme_id::text AS programme_id, games_played, wins, losses, draws,
                win_rate::float AS win_rate, total_roster_size, injury_count,
                generated_at::text AS generated_at
         FROM rpt_ath_season_summary
         WHERE school_id = $1::uuid
         ORDER BY season_id, programme_id`,
        tenant.schoolId,
      )) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        id: String(r.id),
        schoolId: String(r.school_id),
        seasonId: String(r.season_id),
        programmeId: String(r.programme_id),
        gamesPlayed: Number(r.games_played),
        wins: Number(r.wins),
        losses: Number(r.losses),
        draws: Number(r.draws),
        winRate: r.win_rate === null ? null : Number(r.win_rate),
        totalRosterSize: Number(r.total_roster_size),
        injuryCount: Number(r.injury_count),
        generatedAt: String(r.generated_at),
      }));
    });
  }

  async listOfficialsMarketplace(args: DateRangeArgs = {}): Promise<OfficialsMarketplaceRowDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id, period::text AS period,
                total_assignments, fill_rate::float AS fill_rate,
                avg_cost_per_game::float AS avg_cost_per_game,
                avg_official_rating::float AS avg_official_rating,
                avg_school_rating::float AS avg_school_rating,
                generated_at::text AS generated_at
         FROM rpt_officials_marketplace
         WHERE school_id = $1::uuid
           AND ($2::date IS NULL OR period >= $2::date)
           AND ($3::date IS NULL OR period <= $3::date)
         ORDER BY period DESC`,
        tenant.schoolId,
        args.fromDate ?? null,
        args.toDate ?? null,
      )) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        id: String(r.id),
        schoolId: String(r.school_id),
        period: String(r.period).slice(0, 10),
        totalAssignments: Number(r.total_assignments),
        fillRate: r.fill_rate === null ? null : Number(r.fill_rate),
        avgCostPerGame: r.avg_cost_per_game === null ? null : Number(r.avg_cost_per_game),
        avgOfficialRating: r.avg_official_rating === null ? null : Number(r.avg_official_rating),
        avgSchoolRating: r.avg_school_rating === null ? null : Number(r.avg_school_rating),
        generatedAt: String(r.generated_at),
      }));
    });
  }

  async listGameResults(): Promise<GameResultRowDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id, game_id::text AS game_id,
                sport, home_score, away_score, result, season_id::text AS season_id,
                statistical_leaders,
                generated_at::text AS generated_at
         FROM rpt_game_results
         WHERE school_id = $1::uuid
         ORDER BY generated_at DESC
         LIMIT 200`,
        tenant.schoolId,
      )) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        id: String(r.id),
        schoolId: String(r.school_id),
        gameId: String(r.game_id),
        sport: String(r.sport),
        homeScore: Number(r.home_score),
        awayScore: Number(r.away_score),
        result: String(r.result),
        seasonId: String(r.season_id),
        statisticalLeaders: r.statistical_leaders ?? [],
        generatedAt: String(r.generated_at),
      }));
    });
  }

  async listGroupsEngagement(args: DateRangeArgs = {}): Promise<GroupsEngagementRowDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id, group_id::text AS group_id,
                period::text AS period, total_members, active_members, posts_count,
                comments_count, engagement_rate::float AS engagement_rate,
                generated_at::text AS generated_at
         FROM rpt_grp_engagement_summary
         WHERE school_id = $1::uuid
           AND ($2::date IS NULL OR period >= $2::date)
           AND ($3::date IS NULL OR period <= $3::date)
         ORDER BY period DESC, group_id`,
        tenant.schoolId,
        args.fromDate ?? null,
        args.toDate ?? null,
      )) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        id: String(r.id),
        schoolId: String(r.school_id),
        groupId: String(r.group_id),
        period: String(r.period).slice(0, 10),
        totalMembers: Number(r.total_members),
        activeMembers: Number(r.active_members),
        postsCount: Number(r.posts_count),
        commentsCount: Number(r.comments_count),
        engagementRate: r.engagement_rate === null ? null : Number(r.engagement_rate),
        generatedAt: String(r.generated_at),
      }));
    });
  }

  async listPublications(args: DateRangeArgs = {}): Promise<PublicationsRowDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id, period::text AS period,
                publications_count, total_views, total_downloads,
                avg_time_to_publish_days::float AS avg_time_to_publish_days,
                generated_at::text AS generated_at
         FROM rpt_pub_distribution_summary
         WHERE school_id = $1::uuid
           AND ($2::date IS NULL OR period >= $2::date)
           AND ($3::date IS NULL OR period <= $3::date)
         ORDER BY period DESC`,
        tenant.schoolId,
        args.fromDate ?? null,
        args.toDate ?? null,
      )) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        id: String(r.id),
        schoolId: String(r.school_id),
        period: String(r.period).slice(0, 10),
        publicationsCount: Number(r.publications_count),
        totalViews: Number(r.total_views),
        totalDownloads: Number(r.total_downloads),
        avgTimeToPublishDays:
          r.avg_time_to_publish_days === null ? null : Number(r.avg_time_to_publish_days),
        generatedAt: String(r.generated_at),
      }));
    });
  }

  async listClubsService(): Promise<ClubsServiceRowDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id, academic_year,
                club_id::text AS club_id, total_members,
                attendance_rate::float AS attendance_rate,
                events_held, budget_spent::float AS budget_spent,
                generated_at::text AS generated_at
         FROM rpt_ext_service_summary
         WHERE school_id = $1::uuid
         ORDER BY academic_year DESC, club_id`,
        tenant.schoolId,
      )) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        id: String(r.id),
        schoolId: String(r.school_id),
        academicYear: String(r.academic_year),
        clubId: String(r.club_id),
        totalMembers: Number(r.total_members),
        attendanceRate: r.attendance_rate === null ? null : Number(r.attendance_rate),
        eventsHeld: Number(r.events_held),
        budgetSpent: Number(r.budget_spent),
        generatedAt: String(r.generated_at),
      }));
    });
  }

  async listCommsMetrics(args: DateRangeArgs = {}): Promise<CommsMetricsRowDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id, period::text AS period,
                messages_sent, broadcasts_sent, delivery_rate::float AS delivery_rate,
                read_rate::float AS read_rate, avg_response_time_hours::float AS avg_response_time_hours,
                generated_at::text AS generated_at
         FROM rpt_msg_communication_metrics
         WHERE school_id = $1::uuid
           AND ($2::date IS NULL OR period >= $2::date)
           AND ($3::date IS NULL OR period <= $3::date)
         ORDER BY period DESC`,
        tenant.schoolId,
        args.fromDate ?? null,
        args.toDate ?? null,
      )) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        id: String(r.id),
        schoolId: String(r.school_id),
        period: String(r.period).slice(0, 10),
        messagesSent: Number(r.messages_sent),
        broadcastsSent: Number(r.broadcasts_sent),
        deliveryRate: r.delivery_rate === null ? null : Number(r.delivery_rate),
        readRate: r.read_rate === null ? null : Number(r.read_rate),
        avgResponseTimeHours:
          r.avg_response_time_hours === null ? null : Number(r.avg_response_time_hours),
        generatedAt: String(r.generated_at),
      }));
    });
  }

  /**
   * PRIVACY: returns only the aggregate rollup. No student_id is present
   * on rpt_wellbeing_domain_trends and no join is added on read.
   */
  async listWellbeingDomainTrends(args: DateRangeArgs = {}): Promise<WellbeingDomainTrendRowDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id, period::text AS period,
                grade_level, domain, avg_score::float AS avg_score, response_count,
                below_threshold_count, generated_at::text AS generated_at
         FROM rpt_wellbeing_domain_trends
         WHERE school_id = $1::uuid
           AND ($2::date IS NULL OR period >= $2::date)
           AND ($3::date IS NULL OR period <= $3::date)
         ORDER BY period DESC, grade_level, domain`,
        tenant.schoolId,
        args.fromDate ?? null,
        args.toDate ?? null,
      )) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        id: String(r.id),
        schoolId: String(r.school_id),
        period: String(r.period).slice(0, 10),
        gradeLevel: String(r.grade_level),
        domain: String(r.domain),
        avgScore: r.avg_score === null ? null : Number(r.avg_score),
        responseCount: Number(r.response_count),
        belowThresholdCount: Number(r.below_threshold_count),
        generatedAt: String(r.generated_at),
      }));
    });
  }
}
