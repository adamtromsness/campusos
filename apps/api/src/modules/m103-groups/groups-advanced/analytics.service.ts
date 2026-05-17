import { Injectable, NotFoundException } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { GroupService } from '@modules/m103-groups/groups/group.service';
import { assertGroupInCurrentSchool } from './access';
import { GroupAnalyticsRowDto, RecomputeAnalyticsDto } from './dto/groups-advanced.dto';

interface AnalyticsRow {
  id: string;
  group_id: string;
  period: Date;
  total_members: number;
  active_members: number;
  posts_count: number;
  comments_count: number;
  polls_created: number;
  events_held: number;
  resources_shared: number;
  engagement_rate: string;
  computed_at: Date;
}

/**
 * GroupAnalyticsService — P2-28a Step 2.
 *
 * Monthly engagement read model. The future GroupAnalyticsWorker
 * will run materialise() in a batch loop; for this cycle the
 * recompute endpoint is admin/manager-callable on demand.
 *
 * engagement_rate = active_members / total_members (clamped to 0 if
 * total_members is 0).
 */
@Injectable()
export class GroupAnalyticsService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly groups: GroupService,
  ) {}

  async listForGroup(groupId: string, actor: ResolvedActor): Promise<GroupAnalyticsRowDto[]> {
    // REVIEW-P2C28 BLOCKING 2 — school admins must still validate the
    // target group belongs to the current school.
    await assertGroupInCurrentSchool(this.tenantPrisma, groupId);
    if (!actor.isSchoolAdmin) {
      await this.groups.assertCanManageGroup(groupId, actor);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, group_id::text AS group_id, period, total_members, active_members, ' +
          'posts_count, comments_count, polls_created, events_held, resources_shared, ' +
          'engagement_rate::text AS engagement_rate, computed_at ' +
          'FROM grp_group_analytics WHERE group_id = $1::uuid ORDER BY period DESC LIMIT 24',
        groupId,
      );
    })) as AnalyticsRow[];
    return rows.map((r) => this.rowToDto(r));
  }

  /**
   * Recompute analytics for a single group/period. Idempotent —
   * UPSERTs the row via INSERT ... ON CONFLICT DO UPDATE.
   */
  async recompute(
    groupId: string,
    input: RecomputeAnalyticsDto,
    actor: ResolvedActor,
  ): Promise<GroupAnalyticsRowDto> {
    // REVIEW-P2C28 BLOCKING 2 — even school admins must validate the
    // target group belongs to the current school. The recompute path
    // aggregates membership and engagement counts — cross-school
    // recompute could pollute another school's analytics.
    await assertGroupInCurrentSchool(this.tenantPrisma, groupId);
    if (!actor.isSchoolAdmin) {
      await this.groups.assertCanManageGroup(groupId, actor);
    }
    const period = this.normalisePeriod(input.period);

    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // 1. Verify the group exists
      const grp = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id FROM grp_groups WHERE id = $1::uuid LIMIT 1',
        groupId,
      )) as Array<{ id: string }>;
      if (grp.length === 0) throw new NotFoundException('Group not found');

      // 2. Aggregate metrics
      // Active members are those with status='ACTIVE' on grp_members at recompute time.
      const memberAgg = (await tx.$queryRawUnsafe(
        "SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active " +
          "FROM grp_members WHERE group_id = $1::uuid AND status <> 'LEFT'",
        groupId,
      )) as Array<{ total: number; active: number }>;

      // Period range: [period, period + 1 month)
      const pollAgg = (await tx.$queryRawUnsafe(
        'SELECT COUNT(*)::int AS n FROM grp_group_polls ' +
          "WHERE group_id = $1::uuid AND created_at >= $2::date AND created_at < ($2::date + INTERVAL '1 month')",
        groupId,
        period,
      )) as Array<{ n: number }>;

      const eventAgg = (await tx.$queryRawUnsafe(
        'SELECT COUNT(*)::int AS n FROM grp_group_events ' +
          "WHERE group_id = $1::uuid AND created_at >= $2::date AND created_at < ($2::date + INTERVAL '1 month')",
        groupId,
        period,
      )) as Array<{ n: number }>;

      const resourceAgg = (await tx.$queryRawUnsafe(
        'SELECT COUNT(*)::int AS n FROM grp_resource_library ' +
          "WHERE group_id = $1::uuid AND created_at >= $2::date AND created_at < ($2::date + INTERVAL '1 month')",
        groupId,
        period,
      )) as Array<{ n: number }>;

      // Posts + comments — leverage grp_announcements which already
      // exists from Cycle 18. comments_count is currently 0 because
      // no comment table exists for groups.
      const postAgg = (await tx.$queryRawUnsafe(
        'SELECT COUNT(*)::int AS n FROM grp_announcements ' +
          "WHERE group_id = $1::uuid AND created_at >= $2::date AND created_at < ($2::date + INTERVAL '1 month')",
        groupId,
        period,
      )) as Array<{ n: number }>;

      const totalMembers = memberAgg[0]!.total;
      const activeMembers = memberAgg[0]!.active;
      const engagementRate = totalMembers > 0 ? Math.min(activeMembers / totalMembers, 9.9999) : 0;

      // 3. UPSERT
      const existing = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id FROM grp_group_analytics WHERE group_id = $1::uuid AND period = $2::date LIMIT 1',
        groupId,
        period,
      )) as Array<{ id: string }>;
      let id: string;
      if (existing.length === 0) {
        id = generateId();
        await tx.$executeRawUnsafe(
          'INSERT INTO grp_group_analytics (id, group_id, period, total_members, active_members, ' +
            'posts_count, comments_count, polls_created, events_held, resources_shared, ' +
            'engagement_rate, computed_at) ' +
            'VALUES ($1::uuid, $2::uuid, $3::date, $4, $5, $6, 0, $7, $8, $9, $10, now())',
          id,
          groupId,
          period,
          totalMembers,
          activeMembers,
          postAgg[0]!.n,
          pollAgg[0]!.n,
          eventAgg[0]!.n,
          resourceAgg[0]!.n,
          engagementRate.toFixed(4),
        );
      } else {
        id = existing[0]!.id;
        await tx.$executeRawUnsafe(
          'UPDATE grp_group_analytics SET total_members = $1, active_members = $2, ' +
            'posts_count = $3, polls_created = $4, events_held = $5, resources_shared = $6, ' +
            'engagement_rate = $7, computed_at = now() WHERE id = $8::uuid',
          totalMembers,
          activeMembers,
          postAgg[0]!.n,
          pollAgg[0]!.n,
          eventAgg[0]!.n,
          resourceAgg[0]!.n,
          engagementRate.toFixed(4),
          id,
        );
      }

      const reloaded = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, group_id::text AS group_id, period, total_members, active_members, ' +
          'posts_count, comments_count, polls_created, events_held, resources_shared, ' +
          'engagement_rate::text AS engagement_rate, computed_at ' +
          'FROM grp_group_analytics WHERE id = $1::uuid LIMIT 1',
        id,
      )) as AnalyticsRow[];
      return this.rowToDto(reloaded[0]!);
    });
  }

  private normalisePeriod(periodInput?: string): string {
    const d = periodInput ? new Date(periodInput) : new Date();
    if (Number.isNaN(d.getTime())) {
      const now = new Date();
      const y = now.getUTCFullYear();
      const m = String(now.getUTCMonth() + 1).padStart(2, '0');
      return `${y}-${m}-01`;
    }
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    return `${y}-${m}-01`;
  }

  private rowToDto(r: AnalyticsRow): GroupAnalyticsRowDto {
    return {
      id: r.id,
      groupId: r.group_id,
      period: r.period.toISOString().slice(0, 10),
      totalMembers: r.total_members,
      activeMembers: r.active_members,
      postsCount: r.posts_count,
      commentsCount: r.comments_count,
      pollsCreated: r.polls_created,
      eventsHeld: r.events_held,
      resourcesShared: r.resources_shared,
      engagementRate: Number(r.engagement_rate),
      computedAt: r.computed_at.toISOString(),
    };
  }
}
