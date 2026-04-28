'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { cn } from '@/components/ui/cn';
import { useComplianceDashboard } from '@/hooks/use-hr';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import type { ComplianceUrgency, EmployeeComplianceDto } from '@/lib/types';

type Filter = 'all' | 'gaps' | 'compliant';

export default function ComplianceDashboardPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && hasAnyPermission(user, ['sch-001:admin', 'hr-004:admin']);
  const dashboard = useComplianceDashboard(isAdmin);
  const [filter, setFilter] = useState<Filter>('all');
  const [expanded, setExpanded] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const list = dashboard.data?.employees ?? [];
    if (filter === 'gaps') return list.filter((e) => e.amberCount > 0 || e.redCount > 0);
    if (filter === 'compliant') {
      return list.filter((e) => e.totalRequirements > 0 && e.amberCount === 0 && e.redCount === 0);
    }
    return list;
  }, [dashboard.data, filter]);

  if (!user) return null;
  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Compliance" description="Compliance dashboard is admin-only." />
        <EmptyState
          title="Admin access required"
          description="Ask a school admin to review training compliance."
        />
      </div>
    );
  }

  const totalEmployees = dashboard.data?.totalEmployees ?? 0;
  const employeesWithGaps = dashboard.data?.employeesWithGaps ?? 0;
  const compliantPct =
    totalEmployees > 0
      ? Math.round(((totalEmployees - employeesWithGaps) / totalEmployees) * 100)
      : 0;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Compliance"
        description="School-wide training compliance for active staff."
      />

      <section className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Active employees" value={totalEmployees} />
        <Stat
          label="With gaps"
          value={employeesWithGaps}
          tone={employeesWithGaps > 0 ? 'amber' : 'green'}
        />
        <Stat
          label="Compliant"
          value={`${compliantPct}%`}
          tone={compliantPct === 100 ? 'green' : 'amber'}
        />
      </section>

      <div className="mt-6 flex flex-wrap gap-2">
        <FilterChip current={filter} value="all" onClick={setFilter}>
          All
        </FilterChip>
        <FilterChip current={filter} value="gaps" onClick={setFilter}>
          Has gaps
        </FilterChip>
        <FilterChip current={filter} value="compliant" onClick={setFilter}>
          Fully compliant
        </FilterChip>
      </div>

      <div className="mt-4">
        {dashboard.isLoading ? (
          <div className="py-16 text-center">
            <LoadingSpinner />
          </div>
        ) : dashboard.isError ? (
          <EmptyState title="Couldn’t load the dashboard" />
        ) : filtered.length === 0 ? (
          <EmptyState
            title="No employees match"
            description={
              filter === 'all'
                ? 'No active employees have compliance data yet.'
                : filter === 'gaps'
                  ? 'Every active employee is fully compliant — well done.'
                  : 'No active employees are fully compliant against every requirement yet.'
            }
          />
        ) : (
          <ul className="space-y-3">
            {filtered.map((emp) => (
              <EmployeeCard
                key={emp.employeeId}
                emp={emp}
                expanded={expanded === emp.employeeId}
                onToggle={() =>
                  setExpanded((cur) => (cur === emp.employeeId ? null : emp.employeeId))
                }
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function EmployeeCard({
  emp,
  expanded,
  onToggle,
}: {
  emp: EmployeeComplianceDto;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="rounded-xl border border-gray-200 bg-white shadow-sm">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-3">
          <Avatar name={emp.employeeName} size="md" />
          <div>
            <p className="text-sm font-semibold text-gray-900">{emp.employeeName}</p>
            <p className="text-xs text-gray-500">{emp.primaryPositionTitle ?? '—'}</p>
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-medium text-emerald-800">
            {emp.compliantCount} compliant
          </span>
          <span
            className={cn(
              'rounded-full px-2 py-0.5 font-medium',
              emp.amberCount > 0 ? 'bg-amber-100 text-amber-800' : 'bg-gray-100 text-gray-500',
            )}
          >
            {emp.amberCount} amber
          </span>
          <span
            className={cn(
              'rounded-full px-2 py-0.5 font-medium',
              emp.redCount > 0 ? 'bg-red-100 text-red-800' : 'bg-gray-100 text-gray-500',
            )}
          >
            {emp.redCount} red
          </span>
          <Link
            href={`/staff/${emp.employeeId}`}
            className="text-campus-700 transition-colors hover:underline"
          >
            View profile
          </Link>
          <button
            type="button"
            onClick={onToggle}
            className="rounded-lg border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-100"
          >
            {expanded ? 'Hide' : 'Details'}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-gray-100 bg-gray-50 px-4 py-3">
          {emp.rows.length === 0 ? (
            <p className="text-xs text-gray-500">
              No compliance rows for this employee yet — no training requirements apply, or the
              compliance worker hasn’t materialised any rows.
            </p>
          ) : (
            <ul className="divide-y divide-gray-200 rounded-lg bg-white">
              {emp.rows.map((r) => (
                <li
                  key={r.requirementId}
                  className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                >
                  <div>
                    <p className="font-medium text-gray-900">{r.requirementName}</p>
                    <p className="text-xs text-gray-500">
                      {r.frequency.toLowerCase()}
                      {r.lastCompletedDate
                        ? ` · last ${r.lastCompletedDate}`
                        : ' · never completed'}
                      {r.nextDueDate && ` · due ${r.nextDueDate}`}
                      {r.daysUntilDue !== null && ` · ${r.daysUntilDue}d`}
                    </p>
                  </div>
                  <UrgencyPill urgency={r.urgency} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: 'green' | 'amber' | 'red';
}) {
  const toneClass =
    tone === 'green'
      ? 'text-emerald-700'
      : tone === 'amber'
        ? 'text-amber-700'
        : tone === 'red'
          ? 'text-red-700'
          : 'text-gray-900';
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className={cn('mt-1 text-2xl font-semibold', toneClass)}>{value}</p>
    </div>
  );
}

function FilterChip({
  current,
  value,
  onClick,
  children,
}: {
  current: Filter;
  value: Filter;
  onClick: (v: Filter) => void;
  children: React.ReactNode;
}) {
  const active = current === value;
  return (
    <button
      type="button"
      onClick={() => onClick(value)}
      className={cn(
        'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
        active
          ? 'border-campus-600 bg-campus-700 text-white'
          : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50',
      )}
    >
      {children}
    </button>
  );
}

function UrgencyPill({ urgency }: { urgency: ComplianceUrgency }) {
  const cls =
    urgency === 'green'
      ? 'bg-emerald-100 text-emerald-800'
      : urgency === 'amber'
        ? 'bg-amber-100 text-amber-800'
        : 'bg-red-100 text-red-800';
  const label = urgency === 'green' ? 'Compliant' : urgency === 'amber' ? 'Expiring' : 'Action';
  return (
    <span className={cn('inline-flex rounded-full px-2 py-0.5 text-xs font-medium', cls)}>
      {label}
    </span>
  );
}
