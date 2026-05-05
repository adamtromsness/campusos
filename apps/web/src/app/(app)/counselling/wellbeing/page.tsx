'use client';

import Link from 'next/link';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { cn } from '@/components/ui/cn';
import {
  useWellbeingAlerts,
  useWellbeingCheckins,
  useWellbeingDeployments,
  useWellbeingTemplates,
} from '@/hooks/use-wellbeing';
import {
  ALERT_STATUS_LABELS,
  ALERT_STATUS_PILL,
  ALERT_TYPE_LABELS,
  ALERT_TYPE_PILL,
  DEPLOYMENT_STATUS_LABELS,
  DEPLOYMENT_STATUS_PILL,
  alertSeverityRank,
  formatRelative,
} from '@/lib/wellbeing-format';

/**
 * /counselling/wellbeing — Counsellor wellbeing dashboard.
 *
 * Three panels per the Step 6 plan:
 *   1. Active deployments with completion progress bars.
 *   2. Open alerts queue (NEW + ACKNOWLEDGED + IN_PROGRESS), severity-
 *      sorted (SHI first).
 *   3. Recent completed check-ins with flagged/unflagged pills.
 *
 * The Counselling app tile is reused — this is the wellbeing nested
 * area inside the existing /counselling routes.
 */
export default function WellbeingDashboardPage() {
  const tplQ = useWellbeingTemplates(false);
  const depQ = useWellbeingDeployments({ status: 'ACTIVE' });
  const alertQ = useWellbeingAlerts({});
  const completedQ = useWellbeingCheckins({ pending: false });

  const openAlerts = (alertQ.data ?? [])
    .filter((a) => a.status !== 'RESOLVED')
    .sort((a, b) => alertSeverityRank(a.alertType) - alertSeverityRank(b.alertType))
    .slice(0, 8);
  const recentCheckins = (completedQ.data ?? []).slice(0, 8);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Wellbeing"
        description="Survey templates, deployments, and the open-alerts queue for the counselling team."
      />

      <div className="flex flex-wrap gap-2">
        <Link
          href="/counselling/wellbeing/alerts"
          className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-700"
        >
          Alert queue ({openAlerts.length})
        </Link>
        <Link
          href="#templates"
          className="rounded-md bg-campus-50 px-3 py-1.5 text-sm font-medium text-campus-800 ring-1 ring-campus-200 hover:bg-campus-100"
        >
          Templates ({tplQ.data?.length ?? 0})
        </Link>
      </div>

      {/* Active deployments */}
      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-gray-900">Active deployments</h3>
        {depQ.isLoading ? (
          <LoadingSpinner />
        ) : (depQ.data ?? []).length === 0 ? (
          <p className="mt-2 text-sm text-gray-500">No active deployments.</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {(depQ.data ?? []).map((d) => {
              const t = d.totalTargeted ?? 0;
              const c = d.totalCompleted ?? 0;
              const pct = t > 0 ? Math.round((c / t) * 100) : 0;
              return (
                <li
                  key={d.id}
                  className="rounded-md border border-gray-200 p-3 transition hover:border-campus-300"
                >
                  <Link href={'/counselling/wellbeing/deployments/' + d.id} className="block">
                    <div className="flex items-baseline justify-between">
                      <div className="text-sm font-medium text-gray-900">
                        {d.templateName ?? '—'}
                      </div>
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 text-[11px] font-medium',
                          DEPLOYMENT_STATUS_PILL[d.status],
                        )}
                      >
                        {DEPLOYMENT_STATUS_LABELS[d.status]}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-gray-500">
                      Deployed by {d.deployedByName ?? '—'} · {formatRelative(d.deployAt)}
                    </div>
                    <div className="mt-2 flex items-center gap-3">
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100">
                        <div
                          className="h-full bg-emerald-500 transition-all"
                          style={{ width: pct + '%' }}
                        />
                      </div>
                      <div className="text-xs font-medium text-gray-700">
                        {c} / {t} completed
                      </div>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Open alerts queue */}
      <section className="rounded-lg border border-rose-200 bg-rose-50/40 p-4">
        <h3 className="text-sm font-semibold text-rose-900">Open alerts ({openAlerts.length})</h3>
        {alertQ.isLoading ? (
          <LoadingSpinner />
        ) : openAlerts.length === 0 ? (
          <EmptyState
            title="No open alerts"
            description="The counselling team is fully caught up."
          />
        ) : (
          <ul className="mt-3 space-y-2">
            {openAlerts.map((a) => (
              <li key={a.id}>
                <Link
                  href={'/counselling/wellbeing/alerts?focus=' + a.id}
                  className="flex items-baseline justify-between rounded-md border border-rose-100 bg-white p-3 transition hover:border-rose-300"
                >
                  <div className="flex flex-1 items-center gap-2">
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-[11px] font-medium',
                        ALERT_TYPE_PILL[a.alertType],
                      )}
                    >
                      {ALERT_TYPE_LABELS[a.alertType]}
                    </span>
                    <span className="text-sm font-medium text-gray-900">
                      {a.studentName ?? '—'}
                    </span>
                    <span className="text-xs text-gray-500 line-clamp-1">
                      {a.questionText ?? ''}
                    </span>
                  </div>
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-[11px] font-medium',
                      ALERT_STATUS_PILL[a.status],
                    )}
                  >
                    {ALERT_STATUS_LABELS[a.status]}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Templates */}
      <section id="templates" className="rounded-lg border border-gray-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-gray-900">Survey templates</h3>
        {tplQ.isLoading ? (
          <LoadingSpinner />
        ) : (tplQ.data ?? []).length === 0 ? (
          <p className="mt-2 text-sm text-gray-500">No templates yet.</p>
        ) : (
          <ul className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {(tplQ.data ?? []).map((t) => (
              <li key={t.id}>
                <Link
                  href={'/counselling/wellbeing/templates/' + t.id}
                  className="block rounded-md border border-gray-200 p-3 transition hover:border-campus-300"
                >
                  <div className="text-sm font-medium text-gray-900">{t.name}</div>
                  {t.description ? (
                    <div className="mt-1 line-clamp-2 text-xs text-gray-500">{t.description}</div>
                  ) : null}
                  <div className="mt-2 text-xs text-gray-500">
                    {t.frequencyRecommendation} · {t.createdByName ?? '—'}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Recent completed check-ins */}
      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-gray-900">Recent completed check-ins</h3>
        {completedQ.isLoading ? (
          <LoadingSpinner />
        ) : recentCheckins.length === 0 ? (
          <p className="mt-2 text-sm text-gray-500">No completed check-ins yet.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {recentCheckins.map((c) => (
              <li
                key={c.id}
                className="flex items-baseline justify-between rounded-md border border-gray-200 p-3"
              >
                <div className="flex items-center gap-3">
                  <div className="text-sm font-medium text-gray-900">{c.studentName ?? '—'}</div>
                  <div className="text-xs text-gray-500">{c.templateName}</div>
                </div>
                <div className="flex items-center gap-2">
                  {c.flaggedForFollowUp ? (
                    <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-medium text-rose-800 ring-1 ring-rose-200">
                      Flagged
                    </span>
                  ) : (
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-800 ring-1 ring-emerald-200">
                      OK
                    </span>
                  )}
                  <span className="text-xs text-gray-500">{formatRelative(c.completedAt)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
