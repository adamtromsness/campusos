'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { PageHeader, EmptyState } from '@/components/ui';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  useAccActionPlans,
  useAccAdoptions,
  useAccEvidenceByStatus,
  useAccFrameworks,
  useAccSelfStudySummary,
  useAccSiteVisitReadiness,
  useAccSiteVisits,
} from '@/hooks/use-accreditation';
import {
  ACC_RATING_LABEL,
  ACC_RATING_PILL,
  ACC_SITE_VISIT_STATUS_LABEL,
  ACC_SITE_VISIT_STATUS_PILL,
  currentCycleId,
  formatDateOnly,
  readinessToneBar,
  readinessToneText,
} from '@/lib/accreditation-format';

export default function AccreditationDashboardPage() {
  const { user } = useAuthStore();
  const isAdmin = hasAnyPermission(user, ['sch-001:admin']);
  const isStaff = user?.personType === 'STAFF';
  const showStaffSurfaces = isStaff || isAdmin;

  const frameworksQ = useAccFrameworks(showStaffSurfaces);
  const adoptionsQ = useAccAdoptions(showStaffSurfaces);
  const cycleId = currentCycleId();
  const summaryQ = useAccSelfStudySummary(cycleId);
  const overdueQ = useAccActionPlans('OVERDUE');
  const pendingEvidenceQ = useAccEvidenceByStatus('SUBMITTED');
  const visitsQ = useAccSiteVisits();
  const upcomingVisit = useMemo(
    () =>
      (visitsQ.data ?? [])
        .filter((v) => v.status !== 'VISIT_COMPLETE')
        .sort((a, b) => a.visitDate.localeCompare(b.visitDate))[0],
    [visitsQ.data],
  );
  const readinessQ = useAccSiteVisitReadiness(upcomingVisit?.id);

  const adoptionCount = adoptionsQ.data?.length ?? 0;
  const totalRated = summaryQ.data?.totalRated ?? 0;
  const overdueCount = overdueQ.data?.length ?? 0;
  const pendingEvidenceCount = pendingEvidenceQ.data?.length ?? 0;

  if (!showStaffSurfaces) {
    return (
      <div className="mx-auto max-w-3xl space-y-6 p-6">
        <PageHeader title="Accreditation" />
        <EmptyState
          title="Not available"
          description="Accreditation data is restricted to staff and administrators."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <PageHeader
        title="Accreditation"
        description="Self-study, evidence, action plans, and site visit readiness against your adopted accreditation frameworks."
      />

      {/* Quick stats */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Adopted frameworks" value={adoptionCount} />
        <StatCard label={`Rated standards (${cycleId})`} value={totalRated} />
        <StatCard label="Evidence pending review" value={pendingEvidenceCount} tone="amber" />
        <StatCard label="Overdue action plans" value={overdueCount} tone="rose" />
      </div>

      {/* Upcoming site visit + readiness gauge */}
      {upcomingVisit ? (
        <section className="rounded-card border border-gray-200 bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">
                Upcoming site visit — {formatDateOnly(upcomingVisit.visitDate)}
              </h2>
              <p className="text-sm text-gray-500">
                {upcomingVisit.accreditorOrg}
                {upcomingVisit.leadContactName ? ` — ${upcomingVisit.leadContactName}` : ''}
              </p>
            </div>
            <span
              className={
                'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ' +
                ACC_SITE_VISIT_STATUS_PILL[upcomingVisit.status]
              }
            >
              {ACC_SITE_VISIT_STATUS_LABEL[upcomingVisit.status]}
            </span>
          </div>

          {readinessQ.data && (
            <div className="mt-4">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium text-gray-700">Readiness score</span>
                <span
                  className={'font-semibold ' + readinessToneText(readinessQ.data.readinessScore)}
                >
                  {readinessQ.data.readinessScore}/100
                </span>
              </div>
              <div className="mt-2 h-3 w-full overflow-hidden rounded-full bg-gray-100">
                <div
                  className={'h-full ' + readinessToneBar(readinessQ.data.readinessScore)}
                  style={{ width: `${readinessQ.data.readinessScore}%` }}
                />
              </div>
              <div className="mt-2 grid grid-cols-1 gap-1 text-xs text-gray-500 sm:grid-cols-3">
                <div>
                  Standards rated:{' '}
                  <span className="font-medium text-gray-700">
                    {readinessQ.data.standardsWithRating} of {readinessQ.data.totalAdoptedStandards}
                  </span>
                </div>
                <div>
                  Approved evidence:{' '}
                  <span className="font-medium text-gray-700">
                    {readinessQ.data.standardsWithApprovedEvidence} of{' '}
                    {readinessQ.data.totalAdoptedStandards}
                  </span>
                </div>
                <div>
                  Ready (rating + evidence):{' '}
                  <span className="font-medium text-gray-700">
                    {readinessQ.data.standardsReady} of {readinessQ.data.totalAdoptedStandards}
                  </span>
                </div>
              </div>
            </div>
          )}

          <div className="mt-4">
            <Link
              href="/accreditation/site-visit"
              className="text-sm font-medium text-campus-600 hover:text-campus-700"
            >
              Manage site visits →
            </Link>
          </div>
        </section>
      ) : (
        <section className="rounded-card border border-dashed border-gray-200 bg-white p-5 text-center text-sm text-gray-500">
          No site visit scheduled.{' '}
          <Link href="/accreditation/site-visit" className="text-campus-600 hover:text-campus-700">
            Schedule one →
          </Link>
        </section>
      )}

      {/* Self-study rating distribution */}
      {summaryQ.data && summaryQ.data.totalRated > 0 ? (
        <section className="rounded-card border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold text-gray-900">
            Self-study summary — {summaryQ.data.cycleId}
          </h2>
          <div className="mt-3 flex flex-wrap gap-3">
            {(['EXEMPLARY', 'ACCOMPLISHED', 'DEVELOPING', 'NOT_MET'] as const).map((r) => {
              const n = summaryQ.data!.totals[r];
              return (
                <div
                  key={r}
                  className={
                    'inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm ' +
                    ACC_RATING_PILL[r]
                  }
                >
                  <span>{ACC_RATING_LABEL[r]}</span>
                  <span className="font-semibold">{n}</span>
                </div>
              );
            })}
          </div>
          {summaryQ.data.byDomain.length > 0 && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="py-2 pr-4">Domain</th>
                    <th className="py-2 pr-4">Exemplary</th>
                    <th className="py-2 pr-4">Accomplished</th>
                    <th className="py-2 pr-4">Developing</th>
                    <th className="py-2 pr-4">Not Met</th>
                  </tr>
                </thead>
                <tbody>
                  {summaryQ.data.byDomain.map((row) => (
                    <tr key={row.domain} className="border-b border-gray-100">
                      <td className="py-2 pr-4 font-medium text-gray-700">{row.domain}</td>
                      <td className="py-2 pr-4 text-emerald-700">{row.EXEMPLARY}</td>
                      <td className="py-2 pr-4 text-sky-700">{row.ACCOMPLISHED}</td>
                      <td className="py-2 pr-4 text-amber-700">{row.DEVELOPING}</td>
                      <td className="py-2 pr-4 text-rose-700">{row.NOT_MET}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="mt-3 text-right">
            <Link
              href="/accreditation/self-study"
              className="text-sm font-medium text-campus-600 hover:text-campus-700"
            >
              Open self-study report →
            </Link>
          </div>
        </section>
      ) : null}

      {/* Adopted frameworks */}
      <section className="rounded-card border border-gray-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">Adopted frameworks</h2>
          <Link
            href="/accreditation/standards"
            className="text-sm font-medium text-campus-600 hover:text-campus-700"
          >
            Browse standards →
          </Link>
        </div>
        {(frameworksQ.data ?? []).filter((f) => f.isAdopted).length === 0 ? (
          <p className="mt-3 text-sm text-gray-500">
            No frameworks adopted yet. Visit Standards to adopt one of AdvancED, IB MYP, or CIS.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {(frameworksQ.data ?? [])
              .filter((f) => f.isAdopted)
              .map((f) => (
                <li
                  key={f.id}
                  className="flex items-center justify-between rounded-md border border-gray-100 bg-gray-50 px-3 py-2 text-sm"
                >
                  <div>
                    <span className="font-medium text-gray-800">{f.name}</span>
                    {f.abbreviation ? (
                      <span className="ml-2 text-xs text-gray-500">({f.abbreviation})</span>
                    ) : null}
                  </div>
                  <span className="text-xs text-gray-500">
                    {f.standardCount} standard{f.standardCount === 1 ? '' : 's'} ·{' '}
                    <span className="capitalize">{f.source.toLowerCase()}</span>
                  </span>
                </li>
              ))}
          </ul>
        )}
      </section>

      {/* Module nav */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <NavCard
          href="/accreditation/evidence"
          label="Evidence Manager"
          description={`${pendingEvidenceCount} pending review`}
        />
        <NavCard
          href="/accreditation/self-study"
          label="Self-Study Report"
          description={`${totalRated} rated this cycle`}
        />
        <NavCard
          href="/accreditation/action-plans"
          label="Action Plans"
          description={overdueCount > 0 ? `${overdueCount} overdue` : 'On track'}
        />
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'amber' | 'rose';
}) {
  const valueClass =
    tone === 'rose' && value > 0
      ? 'text-rose-700'
      : tone === 'amber' && value > 0
        ? 'text-amber-700'
        : 'text-gray-900';
  return (
    <div className="rounded-card border border-gray-200 bg-white p-4 shadow-sm">
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className={'mt-1 text-2xl font-semibold ' + valueClass}>{value}</div>
    </div>
  );
}

function NavCard({
  href,
  label,
  description,
}: {
  href: string;
  label: string;
  description: string;
}) {
  return (
    <Link
      href={href}
      className="block rounded-card border border-gray-200 bg-white p-4 shadow-sm hover:border-campus-300 hover:shadow-md"
    >
      <div className="text-sm font-semibold text-gray-900">{label}</div>
      <div className="mt-1 text-xs text-gray-500">{description}</div>
    </Link>
  );
}
