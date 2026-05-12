'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  ACCOUNT_STATUSES,
  AccountStatus,
  RENEWAL_STAGES,
  RenewalStage,
  STAGE_PILL,
  STATUS_PILL,
  formatCents,
  useCrmAccounts,
  useCrmAtRiskAccounts,
  useCrmMrrSummary,
  useCrmRenewals,
} from '@/hooks/use-crm';

/**
 * P2-21a — Internal CRM dashboard.
 *
 * Platform Admin only. The endpoints under /api/v1/internal/crm/* are
 * gated CRM-001..006 read; only Platform Admin holds the catalogue
 * tier at PLATFORM scope. Schools (the tenants) cannot reach this
 * surface even with sch-001:admin.
 *
 * Surfaces:
 *   - 4-stat header (Total MRR, Active subs, Past-due subs, At-risk)
 *   - Account list with status pills + health-score column
 *   - Renewal pipeline Kanban grouped by stage
 *   - At-risk accounts callout (CRITICAL + AT_RISK from latest health
 *     score, severity-sorted)
 */
export default function CrmDashboardPage() {
  const user = useAuthStore((s) => s.user);
  const canRead = !!user && hasAnyPermission(user, ['crm-001:read']);
  const [statusFilter, setStatusFilter] = useState<AccountStatus | 'ALL'>('ALL');

  const accounts = useCrmAccounts(statusFilter !== 'ALL' ? { status: statusFilter } : undefined);
  const mrr = useCrmMrrSummary();
  const atRisk = useCrmAtRiskAccounts();
  const renewals = useCrmRenewals();

  const renewalsByStage = useMemo(() => {
    const map: Record<RenewalStage, NonNullable<ReturnType<typeof useCrmRenewals>['data']>> = {
      UPCOMING: [],
      IN_DISCUSSION: [],
      PROPOSAL_SENT: [],
      COMMITTED: [],
      CHURNING: [],
    };
    for (const r of renewals.data ?? []) {
      map[r.stage].push(r);
    }
    return map;
  }, [renewals.data]);

  if (!user) return null;
  if (!canRead) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="CRM" />
        <EmptyState
          title="Internal CRM — Platform Admin only"
          description="This dashboard is the CampusOS-the-company customer-management surface. School users cannot reach it."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title="CRM"
        description="Customer accounts, subscriptions, onboarding, health, renewals. Internal CampusOS view."
      />

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Total MRR"
          value={mrr.data ? formatCents(mrr.data.totalMrrCents) : '…'}
          tone="emerald"
          loading={mrr.isLoading}
        />
        <StatCard
          label="Active subs"
          value={mrr.data?.activeSubscriptions ?? '…'}
          loading={mrr.isLoading}
        />
        <StatCard
          label="Past due"
          value={mrr.data?.pastDueSubscriptions ?? '…'}
          tone={(mrr.data?.pastDueSubscriptions ?? 0) > 0 ? 'amber' : 'neutral'}
          loading={mrr.isLoading}
        />
        <StatCard
          label="At-risk accounts"
          value={atRisk.data?.length ?? '…'}
          tone={(atRisk.data?.length ?? 0) > 0 ? 'rose' : 'neutral'}
          loading={atRisk.isLoading}
        />
      </section>

      {atRisk.data && atRisk.data.length > 0 && (
        <section className="rounded-card border border-rose-200 bg-rose-50 p-4">
          <h2 className="mb-3 text-sm font-semibold text-rose-900">At-risk accounts</h2>
          <ul className="space-y-2 text-sm text-rose-900">
            {atRisk.data.map((entry) => (
              <li key={entry.account.id} className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded px-2 py-0.5 text-xs font-medium ${entry.score.riskLevel === 'CRITICAL' ? 'bg-rose-200 text-rose-900' : 'bg-amber-200 text-amber-900'}`}
                  >
                    {entry.score.riskLevel}
                  </span>
                  <Link
                    href={`/internal/crm/${entry.account.id}`}
                    className="font-medium underline-offset-2 hover:underline"
                  >
                    {entry.account.accountName}
                  </Link>
                  <span className="text-rose-700">score {entry.score.overallScore}/100</span>
                </div>
                <span className="text-xs text-rose-700">
                  last scored {new Date(entry.score.scoreDate).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="rounded-card border bg-white p-4">
        <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-gray-900">Accounts</h2>
          <div className="flex flex-wrap gap-1">
            <FilterChip
              label="All"
              active={statusFilter === 'ALL'}
              onClick={() => setStatusFilter('ALL')}
            />
            {ACCOUNT_STATUSES.map((s) => (
              <FilterChip
                key={s}
                label={s}
                active={statusFilter === s}
                onClick={() => setStatusFilter(s)}
              />
            ))}
          </div>
        </header>
        {accounts.isLoading ? (
          <LoadingSpinner />
        ) : (accounts.data ?? []).length === 0 ? (
          <EmptyState
            title="No accounts match this filter."
            description="Adjust the filter chips to see other lifecycle stages."
          />
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b text-left text-xs uppercase text-gray-500">
              <tr>
                <th className="pb-2">Account</th>
                <th className="pb-2">Status</th>
                <th className="pb-2">Billing email</th>
                <th className="pb-2">Renewal</th>
                <th className="pb-2"></th>
              </tr>
            </thead>
            <tbody>
              {(accounts.data ?? []).map((a) => (
                <tr key={a.id} className="border-b border-gray-100">
                  <td className="py-2 font-medium text-gray-900">
                    <Link
                      href={`/internal/crm/${a.id}`}
                      className="underline-offset-2 hover:underline"
                    >
                      {a.accountName}
                    </Link>
                  </td>
                  <td className="py-2">
                    <span
                      className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_PILL[a.status]}`}
                    >
                      {a.status}
                    </span>
                  </td>
                  <td className="py-2 text-gray-600">{a.billingEmail}</td>
                  <td className="py-2 text-gray-600">
                    {a.renewalDate ? new Date(a.renewalDate).toLocaleDateString() : '—'}
                  </td>
                  <td className="py-2 text-right">
                    <Link
                      href={`/internal/crm/${a.id}`}
                      className="text-xs text-campus-700 underline-offset-2 hover:underline"
                    >
                      Open →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="rounded-card border bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-gray-900">Renewal pipeline</h2>
        {renewals.isLoading ? (
          <LoadingSpinner />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {RENEWAL_STAGES.map((stage) => {
              const rows = renewalsByStage[stage] ?? [];
              return (
                <div key={stage} className="rounded border border-gray-200 bg-gray-50 p-3">
                  <header className="mb-2 flex items-center justify-between">
                    <span
                      className={`rounded px-2 py-0.5 text-xs font-medium ${STAGE_PILL[stage]}`}
                    >
                      {stage}
                    </span>
                    <span className="text-xs text-gray-500">{rows.length}</span>
                  </header>
                  <ul className="space-y-2 text-xs text-gray-700">
                    {rows.length === 0 ? (
                      <li className="italic text-gray-400">No renewals</li>
                    ) : (
                      rows.map((r) => (
                        <li key={r.id} className="rounded border border-gray-100 bg-white p-2">
                          <Link
                            href={`/internal/crm/${r.accountId}`}
                            className="font-medium text-gray-900 underline-offset-2 hover:underline"
                          >
                            {(accounts.data ?? []).find((a) => a.id === r.accountId)?.accountName ??
                              r.accountId.slice(0, 8)}
                          </Link>
                          <div className="mt-1 text-gray-500">
                            {formatCents(r.currentMrrCents)} →{' '}
                            {formatCents(r.proposedMrrCents ?? r.currentMrrCents)}
                          </div>
                          <div className="mt-0.5 text-gray-400">
                            due {new Date(r.renewalDate).toLocaleDateString()}
                          </div>
                        </li>
                      ))
                    )}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

// ── Local UI helpers ─────────────────────────────────────────────

function StatCard({
  label,
  value,
  loading = false,
  tone = 'neutral',
}: {
  label: string;
  value: string | number;
  loading?: boolean;
  tone?: 'neutral' | 'amber' | 'rose' | 'emerald';
}) {
  const toneClass =
    tone === 'rose'
      ? 'border-rose-200 bg-rose-50 text-rose-900'
      : tone === 'amber'
        ? 'border-amber-200 bg-amber-50 text-amber-900'
        : tone === 'emerald'
          ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
          : 'border-gray-200 bg-white text-gray-900';
  return (
    <div className={`rounded-card border p-3 ${toneClass}`}>
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{loading ? '…' : value}</div>
    </div>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-2.5 py-0.5 text-xs font-medium transition ${
        active
          ? 'border-campus-700 bg-campus-700 text-white'
          : 'border-gray-200 bg-white text-gray-600 hover:border-campus-700 hover:text-campus-700'
      }`}
    >
      {label}
    </button>
  );
}
