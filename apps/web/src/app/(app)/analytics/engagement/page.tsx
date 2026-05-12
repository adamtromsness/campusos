'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/ui';
import { useAuthStore, hasAnyPermission } from '@/lib/auth-store';
import {
  useAthleticsSeason,
  useClubsService,
  useCommunications,
  useEnrolmentFunnel,
  useGameResults,
  useGroupsEngagement,
  useOfficials,
  usePublicationsDistribution,
  useWellbeingDomainTrends,
} from '@/hooks/use-analytics-readmodels';

/**
 * P2-15b Engagement & Performance Read Models dashboard.
 *
 * Consolidates 9 read models into a card grid. Each card shows the
 * headline KPI for its module and links to the upstream domain UI
 * for drill-down. Wellbeing card is intentionally aggregate-only —
 * never any individual student attribution.
 */
export default function EngagementAnalyticsPage() {
  const user = useAuthStore((s) => s.user);
  const canSeeManagerSurfaces = hasAnyPermission(user, ['rpt-002:read']);

  const enrolmentFunnel = useEnrolmentFunnel();
  const athletics = useAthleticsSeason();
  const officials = useOfficials(canSeeManagerSurfaces);
  const games = useGameResults();
  const groups = useGroupsEngagement();
  const publications = usePublicationsDistribution();
  const clubs = useClubsService();
  const comms = useCommunications();
  const wellbeing = useWellbeingDomainTrends(canSeeManagerSurfaces);

  // Headline aggregates
  const latestFunnel = enrolmentFunnel.data?.[0];
  const seasonStats = (athletics.data ?? []).reduce(
    (acc, row) => ({
      games: acc.games + row.gamesPlayed,
      wins: acc.wins + row.wins,
      losses: acc.losses + row.losses,
    }),
    { games: 0, wins: 0, losses: 0 },
  );
  const winRate = seasonStats.games > 0 ? seasonStats.wins / seasonStats.games : null;
  const latestOfficials = officials.data?.[0];
  const recentGames = (games.data ?? []).slice(0, 4);
  const totalGroups = groups.data?.length ?? 0;
  const avgEngagement =
    groups.data && groups.data.length > 0
      ? groups.data.reduce((sum, r) => sum + (r.engagementRate ?? 0), 0) / groups.data.length
      : null;
  const latestPublications = publications.data?.[0];
  const totalClubs = clubs.data?.length ?? 0;
  const latestComms = comms.data?.[0];
  const latestWellbeing = wellbeing.data?.[0];

  return (
    <div>
      <PageHeader
        title="Engagement & performance"
        description="P2-15b live read models from across the platform. All routes hit the read replica."
        actions={
          <Link href="/analytics" className="text-sm text-campus-600 hover:underline">
            ← Analytics
          </Link>
        }
      />

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {/* 1. Enrolment Funnel */}
        <Card title="Enrolment funnel" source="enr.application.* + enr.offer.* + enr.tour.booked">
          {latestFunnel ? (
            <Stats>
              <Stat
                label="Applications"
                value={latestFunnel.applicationsReceived.toLocaleString()}
              />
              <Stat label="Enrolled" value={latestFunnel.enrolled.toLocaleString()} />
              <Stat
                label="Conversion"
                value={
                  latestFunnel.conversionRate === null
                    ? '—'
                    : `${(latestFunnel.conversionRate * 100).toFixed(1)}%`
                }
              />
            </Stats>
          ) : (
            <Empty />
          )}
        </Card>

        {/* 2. Athletics Season */}
        <Card title="Athletics season" source="ath.game.completed">
          {athletics.data && athletics.data.length > 0 ? (
            <Stats>
              <Stat label="Games" value={seasonStats.games.toLocaleString()} />
              <Stat label="Record" value={`${seasonStats.wins}-${seasonStats.losses}`} />
              <Stat
                label="Win rate"
                value={winRate === null ? '—' : `${(winRate * 100).toFixed(1)}%`}
              />
            </Stats>
          ) : (
            <Empty />
          )}
        </Card>

        {/* 3. Officials Marketplace (weekly batch) */}
        {canSeeManagerSurfaces && (
          <Card
            title="Officials marketplace"
            source="ath_official_assignments (weekly batch)"
            badge="Weekly"
          >
            {latestOfficials ? (
              <Stats>
                <Stat
                  label="Assignments"
                  value={latestOfficials.totalAssignments.toLocaleString()}
                />
                <Stat
                  label="Fill rate"
                  value={
                    latestOfficials.fillRate === null
                      ? '—'
                      : `${(latestOfficials.fillRate * 100).toFixed(1)}%`
                  }
                />
                <Stat
                  label="Avg cost"
                  value={
                    latestOfficials.avgCostPerGame === null
                      ? '—'
                      : `$${latestOfficials.avgCostPerGame.toFixed(0)}`
                  }
                />
              </Stats>
            ) : (
              <Empty />
            )}
          </Card>
        )}

        {/* 4. Game Results */}
        <Card title="Recent games" source="ath.game.completed (per-game grain)">
          {recentGames.length > 0 ? (
            <ul className="divide-y divide-gray-100 text-sm">
              {recentGames.map((g) => (
                <li key={g.id} className="flex items-center justify-between py-1.5">
                  <span className="font-medium text-gray-900">{g.sport}</span>
                  <span className="text-xs text-gray-500">
                    {g.homeScore}-{g.awayScore} {g.result}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty />
          )}
        </Card>

        {/* 5. Groups Engagement */}
        <Card title="Groups engagement" source="grp.post.created + grp.member.joined">
          {groups.data && groups.data.length > 0 ? (
            <Stats>
              <Stat label="Groups" value={totalGroups.toLocaleString()} />
              <Stat
                label="Avg engagement"
                value={avgEngagement === null ? '—' : `${(avgEngagement * 100).toFixed(1)}%`}
              />
              <Stat
                label="Posts"
                value={(
                  groups.data.reduce((sum, r) => sum + r.postsCount, 0) ?? 0
                ).toLocaleString()}
              />
            </Stats>
          ) : (
            <Empty />
          )}
        </Card>

        {/* 6. Publications Distribution */}
        <Card title="Publications" source="pub.publication.published">
          {latestPublications ? (
            <Stats>
              <Stat
                label="Published"
                value={latestPublications.publicationsCount.toLocaleString()}
              />
              <Stat label="Views" value={latestPublications.totalViews.toLocaleString()} />
              <Stat
                label="Avg days"
                value={
                  latestPublications.avgTimeToPublishDays === null
                    ? '—'
                    : latestPublications.avgTimeToPublishDays.toFixed(1)
                }
              />
            </Stats>
          ) : (
            <Empty />
          )}
        </Card>

        {/* 7. Clubs / Ext Service */}
        <Card title="Clubs &amp; activities" source="ext.activity.completed">
          {clubs.data && clubs.data.length > 0 ? (
            <Stats>
              <Stat label="Active clubs" value={totalClubs.toLocaleString()} />
              <Stat
                label="Members"
                value={(
                  clubs.data.reduce((sum, r) => sum + r.totalMembers, 0) ?? 0
                ).toLocaleString()}
              />
              <Stat
                label="Avg attendance"
                value={
                  clubs.data[0]?.attendanceRate === null ||
                  clubs.data[0]?.attendanceRate === undefined
                    ? '—'
                    : `${(clubs.data[0].attendanceRate * 100).toFixed(0)}%`
                }
              />
            </Stats>
          ) : (
            <Empty />
          )}
        </Card>

        {/* 8. Communications */}
        <Card title="Communications" source="msg.message.sent + msg.broadcast.sent">
          {latestComms ? (
            <Stats>
              <Stat label="Messages" value={latestComms.messagesSent.toLocaleString()} />
              <Stat
                label="Delivery"
                value={
                  latestComms.deliveryRate === null
                    ? '—'
                    : `${(latestComms.deliveryRate * 100).toFixed(1)}%`
                }
              />
              <Stat
                label="Read"
                value={
                  latestComms.readRate === null
                    ? '—'
                    : `${(latestComms.readRate * 100).toFixed(0)}%`
                }
              />
            </Stats>
          ) : (
            <Empty />
          )}
        </Card>

        {/* 9. Wellbeing Trends — PRIVACY KEYSTONE */}
        {canSeeManagerSurfaces && (
          <Card
            title="Wellbeing trends"
            source="svc.wellbeing.response.submitted"
            badge="Aggregate only"
            badgeTone="violet"
          >
            <div className="mb-2 text-xs text-violet-700">
              No individual student attribution. Aggregated by (grade, domain, period).
            </div>
            {latestWellbeing ? (
              <Stats>
                <Stat
                  label="Avg score"
                  value={
                    latestWellbeing.avgScore === null ? '—' : latestWellbeing.avgScore.toFixed(1)
                  }
                />
                <Stat label="Responses" value={latestWellbeing.responseCount.toLocaleString()} />
                <Stat
                  label="Below threshold"
                  value={latestWellbeing.belowThresholdCount.toLocaleString()}
                />
              </Stats>
            ) : (
              <Empty />
            )}
          </Card>
        )}
      </section>
    </div>
  );
}

function Card({
  title,
  source,
  badge,
  badgeTone = 'gray',
  children,
}: {
  title: string;
  source: string;
  badge?: string;
  badgeTone?: 'gray' | 'violet';
  children: React.ReactNode;
}) {
  const badgeClass =
    badgeTone === 'violet' ? 'bg-violet-100 text-violet-700' : 'bg-gray-100 text-gray-700';
  return (
    <div className="rounded-card border border-gray-200 bg-white p-5 shadow-sm">
      <div className="mb-1 flex items-start justify-between gap-2">
        <h3 className="text-base font-semibold text-gray-900">{title}</h3>
        {badge && (
          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${badgeClass}`}>
            {badge}
          </span>
        )}
      </div>
      <div className="mb-3 text-xs text-gray-500">{source}</div>
      {children}
    </div>
  );
}

function Stats({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-2 sm:grid-cols-3">{children}</div>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-0.5 text-lg font-bold text-gray-900">{value}</div>
    </div>
  );
}

function Empty() {
  return <div className="text-sm text-gray-500">No data yet.</div>;
}
