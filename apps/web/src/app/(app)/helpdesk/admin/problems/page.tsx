'use client';

import Link from 'next/link';
import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { cn } from '@/components/ui/cn';
import { useProblems } from '@/hooks/use-tickets';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { PROBLEM_STATUS_LABELS, PROBLEM_STATUS_PILL, formatTicketAge } from '@/lib/tickets-format';
import type { ProblemStatus } from '@/lib/types';

type FilterChip = ProblemStatus | 'ALL';

const FILTER_CHIPS: FilterChip[] = ['ALL', 'OPEN', 'INVESTIGATING', 'KNOWN_ERROR', 'RESOLVED'];

export default function ProblemsListPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && hasAnyPermission(user, ['it-001:admin', 'sch-001:admin']);
  const [filter, setFilter] = useState<FilterChip>('ALL');

  const problems = useProblems(
    filter === 'ALL' ? {} : { status: filter as ProblemStatus },
    isAdmin,
  );

  if (!user) return null;
  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Problems" />
        <EmptyState
          title="Admin only"
          description="Problem management is visible to school administrators only."
        />
      </div>
    );
  }

  const list = problems.data ?? [];
  const openCount = list.filter(
    (p) => p.status === 'OPEN' || p.status === 'INVESTIGATING' || p.status === 'KNOWN_ERROR',
  ).length;

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader
        title="Problems"
        description={
          openCount === 0
            ? 'No open problems. Group related tickets to track a root cause.'
            : openCount === 1
              ? '1 open problem'
              : openCount + ' open problems'
        }
        actions={
          <div className="flex items-center gap-2">
            <Link href="/helpdesk/admin" className="text-sm text-campus-700 hover:underline">
              ← Back to queue
            </Link>
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        {FILTER_CHIPS.map((chip) => (
          <button
            key={chip}
            type="button"
            onClick={() => setFilter(chip)}
            className={cn(
              'rounded-full px-3 py-1 text-sm transition',
              filter === chip
                ? 'bg-campus-700 text-white'
                : 'bg-white text-gray-700 ring-1 ring-gray-200 hover:bg-gray-50',
            )}
          >
            {chip === 'ALL' ? 'All' : PROBLEM_STATUS_LABELS[chip]}
          </button>
        ))}
      </div>

      {problems.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <LoadingSpinner size="sm" /> Loading…
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          title="No problems to show"
          description={
            filter === 'ALL'
              ? 'Create a problem from a ticket detail page when multiple tickets share a root cause.'
              : 'Nothing matches this filter.'
          }
        />
      ) : (
        <ul className="space-y-2">
          {list.map((p) => (
            <li key={p.id}>
              <Link
                href={'/helpdesk/admin/problems/' + p.id}
                className="block rounded-lg border border-gray-200 bg-white p-4 transition hover:border-campus-300 hover:bg-campus-50/40"
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                          PROBLEM_STATUS_PILL[p.status],
                        )}
                      >
                        {PROBLEM_STATUS_LABELS[p.status]}
                      </span>
                      <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
                        {p.categoryName}
                      </span>
                      <span className="text-xs text-gray-500">
                        {p.ticketIds.length} linked ticket{p.ticketIds.length === 1 ? '' : 's'}
                      </span>
                    </div>
                    <p className="mt-1 truncate font-medium text-gray-900">{p.title}</p>
                    <p className="mt-0.5 line-clamp-2 text-sm text-gray-600">{p.description}</p>
                    <p className="mt-1 text-xs text-gray-500">
                      {p.assignedToName
                        ? 'Assigned to ' + p.assignedToName
                        : p.vendorName
                          ? 'Vendor: ' + p.vendorName
                          : 'Unassigned'}
                      {' · ' + formatTicketAge(p.createdAt)}
                    </p>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
