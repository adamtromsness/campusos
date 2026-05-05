'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { cn } from '@/components/ui/cn';
import { useMtssDashboard, useMtssTiers } from '@/hooks/use-counselling';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  MTSS_DOMAIN_LABELS,
  MTSS_DOMAIN_PILL,
  MTSS_DOMAINS,
  MTSS_TIER_LABELS,
  MTSS_TIER_PILL,
  MTSS_TIER_STATUS_LABELS,
  MTSS_TIER_STATUS_PILL,
  MTSS_TIER_STATUSES,
  MTSS_TIERS,
  formatDateOnly,
  studentDisplay,
} from '@/lib/counselling-format';
import type { MtssDomain, MtssTier, MtssTierStatus } from '@/lib/types';

export default function MtssDashboardPage() {
  const { user } = useAuthStore();
  const isAdmin = hasAnyPermission(user, ['cou-003:admin']);
  const [tier, setTier] = useState<MtssTier | 'ALL'>('ALL');
  const [domain, setDomain] = useState<MtssDomain | 'ALL'>('ALL');
  const [status, setStatus] = useState<MtssTierStatus | 'ALL'>('ACTIVE');

  const tiersQ = useMtssTiers({});
  const dashboardQ = useMtssDashboard(isAdmin);

  const sorted = useMemo(() => {
    let list = tiersQ.data ?? [];
    if (tier !== 'ALL') list = list.filter((t) => t.tier === tier);
    if (domain !== 'ALL') list = list.filter((t) => t.domain === domain);
    if (status !== 'ALL') list = list.filter((t) => t.status === status);
    return [...list].sort((a, b) => b.assignedAt.localeCompare(a.assignedAt));
  }, [tiersQ.data, tier, domain, status]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="MTSS / RTI"
        description={
          isAdmin
            ? 'School-wide tier distribution and intervention monitoring.'
            : 'Tiered interventions for students on your caseload.'
        }
      />

      {isAdmin ? <MtssDashboardPanel q={dashboardQ} /> : null}

      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <span className="text-xs font-medium text-gray-500">Tier:</span>
          <FilterChip onClick={() => setTier('ALL')} active={tier === 'ALL'}>
            All
          </FilterChip>
          {MTSS_TIERS.map((t) => (
            <FilterChip key={t} onClick={() => setTier(t)} active={tier === t}>
              {MTSS_TIER_LABELS[t]}
            </FilterChip>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="text-xs font-medium text-gray-500">Domain:</span>
          <FilterChip onClick={() => setDomain('ALL')} active={domain === 'ALL'}>
            All
          </FilterChip>
          {MTSS_DOMAINS.map((d) => (
            <FilterChip key={d} onClick={() => setDomain(d)} active={domain === d}>
              {MTSS_DOMAIN_LABELS[d]}
            </FilterChip>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="text-xs font-medium text-gray-500">Status:</span>
          <FilterChip onClick={() => setStatus('ALL')} active={status === 'ALL'}>
            All
          </FilterChip>
          {MTSS_TIER_STATUSES.map((s) => (
            <FilterChip key={s} onClick={() => setStatus(s)} active={status === s}>
              {MTSS_TIER_STATUS_LABELS[s]}
            </FilterChip>
          ))}
        </div>
      </div>

      {tiersQ.isLoading ? (
        <LoadingSpinner />
      ) : sorted.length === 0 ? (
        <EmptyState title="No tiers" description="Nothing to show for the selected filters." />
      ) : (
        <ul className="space-y-2">
          {sorted.map((t) => (
            <li key={t.id}>
              <Link
                href={'/counselling/mtss/tiers/' + t.id}
                className="block rounded-lg border border-gray-200 bg-white p-3 hover:border-campus-300 hover:shadow-sm"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="text-sm font-medium text-gray-900">
                    {studentDisplay(t.studentFirstName, t.studentLastName)}
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-[11px] font-medium',
                        MTSS_TIER_PILL[t.tier],
                      )}
                    >
                      {MTSS_TIER_LABELS[t.tier]}
                    </span>
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-[11px] font-medium',
                        MTSS_DOMAIN_PILL[t.domain],
                      )}
                    >
                      {MTSS_DOMAIN_LABELS[t.domain]}
                    </span>
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-[11px] font-medium',
                        MTSS_TIER_STATUS_PILL[t.status],
                      )}
                    >
                      {MTSS_TIER_STATUS_LABELS[t.status]}
                    </span>
                  </div>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                  <span>Assigned {formatDateOnly(t.assignedAt)}</span>
                  <span>· Review {formatDateOnly(t.reviewDate)}</span>
                  {t.assignedByName ? <span>· {t.assignedByName}</span> : null}
                  {t.exitDate ? <span>· Exited {formatDateOnly(t.exitDate)}</span> : null}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FilterChip({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-full border px-3 py-1 text-xs font-medium',
        active
          ? 'border-campus-300 bg-campus-100 text-campus-900'
          : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50',
      )}
    >
      {children}
    </button>
  );
}

function MtssDashboardPanel({ q }: { q: ReturnType<typeof useMtssDashboard> }) {
  if (q.isLoading) return <LoadingSpinner />;
  if (q.isError || !q.data) {
    return (
      <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        Could not load the dashboard rollup. (Admin-only — verify cou-003:admin.)
      </div>
    );
  }
  const dashboard = q.data;
  const grid: Record<MtssTier, Record<MtssDomain, number>> = {
    TIER_1: { ACADEMIC: 0, BEHAVIORAL: 0, SOCIAL_EMOTIONAL: 0, ATTENDANCE: 0 },
    TIER_2: { ACADEMIC: 0, BEHAVIORAL: 0, SOCIAL_EMOTIONAL: 0, ATTENDANCE: 0 },
    TIER_3: { ACADEMIC: 0, BEHAVIORAL: 0, SOCIAL_EMOTIONAL: 0, ATTENDANCE: 0 },
  };
  for (const cell of dashboard.cells) {
    grid[cell.tier][cell.domain] = cell.count;
  }
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-base font-semibold text-gray-900">Active tier distribution</h2>
        <span className="text-xs text-gray-500">{dashboard.totalActive} active</span>
      </div>
      <table className="mt-3 w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase text-gray-500">
            <th className="px-2 py-1"></th>
            {MTSS_DOMAINS.map((d) => (
              <th key={d} className="px-2 py-1">
                {MTSS_DOMAIN_LABELS[d]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {MTSS_TIERS.map((t) => (
            <tr key={t} className="border-t border-gray-100">
              <td className="px-2 py-1.5">
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 text-[11px] font-medium',
                    MTSS_TIER_PILL[t],
                  )}
                >
                  {MTSS_TIER_LABELS[t]}
                </span>
              </td>
              {MTSS_DOMAINS.map((d) => (
                <td key={d} className="px-2 py-1.5 font-mono text-xs text-gray-700">
                  {grid[t][d]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
