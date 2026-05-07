'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/ui';
import { useComplianceDashboard, useBreaches, useSars } from '@/hooks/use-governance';
import { formatBreachCountdown, tonePill } from '@/lib/governance-format';

/**
 * Cycle 30 Data Governance landing — DPO compliance command centre.
 *
 * Surfaces the six structural keystones at a glance:
 *   - 72-hour breach countdown (rose stat card if active)
 *   - DPIA gap count (high_risk_processing without DPIA)
 *   - DPA gap count (processors with no active DPA)
 *   - SAR pipeline (pending + overdue)
 *   - Pseudonymisations done in the last 30 days
 *   - Current published privacy notice version
 */
export default function GovernanceLandingPage() {
  const dashboard = useComplianceDashboard();
  const breaches = useBreaches({ pendingNotificationOnly: true });
  const sars = useSars({ overdueOnly: true });
  const d = dashboard.data;

  return (
    <div>
      <PageHeader
        title="Data Governance & Compliance"
        description="GDPR Article 30 ROPA, DPIA register, processor DPAs, breach 72-hour countdown, subject access requests, and audit pseudonymisation."
      />

      {dashboard.isLoading || !d ? (
        <p className="text-sm text-gray-500">Loading dashboard…</p>
      ) : (
        <>
          <section className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="ROPA entries"
              value={d.ropaCount.toLocaleString()}
              hint={`${d.highRiskActivities} high-risk`}
            />
            <StatCard
              label="DPIA gaps"
              value={d.dpiaGaps.toLocaleString()}
              tone={d.dpiaGaps > 0 ? 'bg-rose-50 text-rose-700' : undefined}
              hint={
                d.dpiaGaps > 0
                  ? 'High-risk processing without DPIA'
                  : 'Every high-risk activity has a DPIA'
              }
            />
            <StatCard
              label="Processors / DPA gaps"
              value={`${d.processors} / ${d.dpaGaps}`}
              tone={d.dpaGaps > 0 ? 'bg-rose-50 text-rose-700' : undefined}
              hint={
                d.dpaGaps > 0
                  ? 'Processors with no active DPA'
                  : 'Every processor has an active DPA'
              }
            />
            <StatCard
              label="Active breaches"
              value={d.activeBreaches.toLocaleString()}
              tone={
                d.breachOverdueCount > 0
                  ? 'bg-rose-50 text-rose-700'
                  : d.breachesAwaitingNotification > 0
                    ? 'bg-amber-50 text-amber-700'
                    : undefined
              }
              hint={
                d.breachOverdueCount > 0
                  ? `${d.breachOverdueCount} past 72-hour deadline`
                  : d.breachesAwaitingNotification > 0
                    ? `${d.breachesAwaitingNotification} awaiting SA notification`
                    : 'No live breach response work'
              }
            />
            <StatCard
              label="Pending SARs"
              value={d.pendingSars.toLocaleString()}
              tone={d.overdueSars > 0 ? 'bg-rose-50 text-rose-700' : undefined}
              hint={d.overdueSars > 0 ? `${d.overdueSars} overdue` : 'On schedule'}
            />
            <StatCard
              label="Pending erasures"
              value={d.pendingErasures.toLocaleString()}
              hint={`${d.pseudonymisationsLast30Days} pseudonymisations (30d)`}
            />
            <StatCard
              label="Active consents"
              value={d.activeConsents.toLocaleString()}
              hint={`${d.withdrawnConsents} withdrawn`}
            />
            <StatCard
              label="Privacy notice"
              value={d.currentPrivacyNoticeVersion ?? '—'}
              hint={d.currentPrivacyNoticeVersion ? 'Currently published' : 'Not published yet'}
            />
          </section>

          {/* Breach countdown — keystone surface */}
          {breaches.data && breaches.data.length > 0 && (
            <section className="mb-6 rounded-card border-2 border-rose-200 bg-rose-50 p-4">
              <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-rose-800">
                72-hour breach notification countdown
              </h2>
              <ul className="space-y-2">
                {breaches.data.map((b) => {
                  const cd = formatBreachCountdown(b.hoursRemainingTo72);
                  return (
                    <li
                      key={b.id}
                      className="flex items-center justify-between rounded-md bg-white p-3 shadow-sm"
                    >
                      <div className="min-w-0">
                        <Link
                          href={`/governance/breaches/${b.id}`}
                          className="block truncate text-sm font-semibold text-gray-900 hover:text-rose-700"
                        >
                          {b.breachTitle}
                        </Link>
                        <div className="mt-1 text-xs text-gray-600">
                          {b.hoursSinceDiscovery}h since discovery — risk {b.riskLevel}
                        </div>
                      </div>
                      <span
                        className={`rounded-full px-3 py-1 text-xs font-semibold ${tonePill(cd.tone)}`}
                      >
                        {cd.label}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {/* Overdue SARs */}
          {sars.data && sars.data.length > 0 && (
            <section className="mb-6 rounded-card border border-rose-200 bg-rose-50 p-4">
              <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-rose-800">
                Overdue Subject Access Requests
              </h2>
              <ul className="space-y-2">
                {sars.data.map((s) => (
                  <li
                    key={s.id}
                    className="flex items-center justify-between rounded-md bg-white p-3 shadow-sm"
                  >
                    <div>
                      <Link
                        href={`/governance/sars/${s.id}`}
                        className="text-sm font-semibold text-gray-900 hover:text-rose-700"
                      >
                        {s.dataSubjectName ?? 'Unknown subject'} — {s.requestType}
                      </Link>
                      <div className="text-xs text-gray-600">
                        Deadline {s.deadlineDate} ({s.daysUntilDeadline} days)
                      </div>
                    </div>
                    <span className="rounded-full bg-rose-100 px-3 py-1 text-xs font-semibold text-rose-700">
                      Overdue
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="mb-2">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-600">
              Compliance modules
            </h2>
            <div className="flex flex-wrap gap-2">
              <NavChip href="/governance/processing-activities" label="ROPA" />
              <NavChip href="/governance/retention" label="Retention policies" />
              <NavChip href="/governance/processors" label="Processors & DPAs" />
              <NavChip href="/governance/breaches" label="Breach register" />
              <NavChip href="/governance/sars" label="SARs" />
              <NavChip href="/governance/erasures" label="Erasure & pseudonymisation" />
              <NavChip href="/governance/consents" label="Consent records" />
              <NavChip href="/governance/privacy-notices" label="Privacy notices" />
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone?: string;
  hint?: string;
}) {
  return (
    <div className={`rounded-card border border-gray-200 bg-white p-4 shadow-sm ${tone ?? ''}`}>
      <div className="text-xs font-semibold uppercase tracking-wide text-gray-600">{label}</div>
      <div className="mt-1 text-2xl font-bold text-gray-900">{value}</div>
      {hint && <div className="mt-1 text-xs text-gray-500">{hint}</div>}
    </div>
  );
}

function NavChip({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="rounded-full border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 hover:border-campus-400 hover:text-campus-700"
    >
      {label}
    </Link>
  );
}
