'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { cn } from '@/components/ui/cn';
import { useCoverageRequests } from '@/hooks/use-scheduling';
import { useAuthStore } from '@/lib/auth-store';
import {
  addDaysIso,
  coverageStatusLabel,
  coverageStatusPillClasses,
  todayIso,
} from '@/lib/scheduling-format';
import type { CoverageRequestDto, CoverageStatus } from '@/lib/types';

const STATUSES: CoverageStatus[] = ['OPEN', 'ASSIGNED', 'COVERED', 'CANCELLED'];

export default function CoverageHistoryPage() {
  const user = useAuthStore((s) => s.user);

  const [fromDate, setFromDate] = useState<string>(() => addDaysIso(todayIso(), -30));
  const [toDate, setToDate] = useState<string>(() => addDaysIso(todayIso(), 30));
  const [statusFilter, setStatusFilter] = useState<CoverageStatus | ''>('');
  const [teacherFilter, setTeacherFilter] = useState('');
  const [subFilter, setSubFilter] = useState('');

  const requests = useCoverageRequests(
    {
      fromDate,
      toDate,
      ...(statusFilter ? { status: statusFilter } : {}),
    },
    !!user,
  );

  const filtered = useMemo(() => {
    const teacher = teacherFilter.trim().toLowerCase();
    const sub = subFilter.trim().toLowerCase();
    return (requests.data ?? []).filter((r) => {
      if (teacher && !r.absentTeacherName.toLowerCase().includes(teacher)) return false;
      if (sub) {
        const subName = r.assignedSubstituteName?.toLowerCase() ?? '';
        if (!subName.includes(sub)) return false;
      }
      return true;
    });
  }, [requests.data, teacherFilter, subFilter]);

  const grouped = useMemo(() => {
    const map = new Map<string, CoverageRequestDto[]>();
    for (const r of filtered) {
      const arr = map.get(r.coverageDate);
      if (arr) arr.push(r);
      else map.set(r.coverageDate, [r]);
    }
    return Array.from(map.entries()).sort((a, b) => b[0].localeCompare(a[0])); // newest first
  }, [filtered]);

  if (!user) return null;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Coverage History"
        description="Past and upcoming coverage assignments. Filter by date, teacher, or substitute."
        actions={
          <Link
            href="/schedule/coverage"
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100"
          >
            Today&apos;s board
          </Link>
        }
      />

      <div className="mb-4 grid grid-cols-1 gap-3 rounded-xl border border-gray-200 bg-white p-3 shadow-sm sm:grid-cols-2 lg:grid-cols-5">
        <label className="text-sm">
          <span className="text-gray-700">From</span>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1 text-sm"
          />
        </label>
        <label className="text-sm">
          <span className="text-gray-700">To</span>
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1 text-sm"
          />
        </label>
        <label className="text-sm">
          <span className="text-gray-700">Status</span>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as CoverageStatus | '')}
            className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1 text-sm"
          >
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {coverageStatusLabel(s)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="text-gray-700">Absent teacher</span>
          <input
            type="search"
            value={teacherFilter}
            onChange={(e) => setTeacherFilter(e.target.value)}
            placeholder="Name contains…"
            className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1 text-sm"
          />
        </label>
        <label className="text-sm">
          <span className="text-gray-700">Substitute</span>
          <input
            type="search"
            value={subFilter}
            onChange={(e) => setSubFilter(e.target.value)}
            placeholder="Name contains…"
            className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1 text-sm"
          />
        </label>
      </div>

      {requests.isLoading ? (
        <div className="py-16 text-center">
          <LoadingSpinner />
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          title="No matching coverage rows"
          description="Try widening the date range or clearing the search filters."
        />
      ) : (
        <div className="space-y-5">
          {grouped.map(([day, items]) => (
            <section
              key={day}
              className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm"
            >
              <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                {new Date(day + 'T00:00:00Z').toLocaleDateString(undefined, {
                  weekday: 'long',
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })}
              </h3>
              <ul className="mt-2 divide-y divide-gray-100">
                {items.map((r) => (
                  <li
                    key={r.id}
                    className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm"
                  >
                    <div className="min-w-0">
                      <p className="font-medium text-gray-900">
                        {r.periodName} · {r.classSectionCode} · {r.courseName}
                      </p>
                      <p className="text-xs text-gray-500">
                        Absent: {r.absentTeacherName} · Room {r.roomName}
                        {r.assignedSubstituteName && ` · Sub: ${r.assignedSubstituteName}`}
                        {r.assignedAt &&
                          ` · assigned ${new Date(r.assignedAt).toLocaleString()}`}
                      </p>
                      {r.notes && (
                        <p className="mt-1 text-xs italic text-gray-500">{r.notes}</p>
                      )}
                    </div>
                    <span
                      className={cn(
                        'inline-flex rounded-full px-2 py-0.5 text-xs font-medium',
                        coverageStatusPillClasses(r.status),
                      )}
                    >
                      {coverageStatusLabel(r.status)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
