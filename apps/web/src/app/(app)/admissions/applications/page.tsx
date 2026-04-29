'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useApplications, useEnrollmentPeriods } from '@/hooks/use-enrollment';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  APPLICATION_STATUS_LABELS,
  APPLICATION_STATUS_PILL,
  PIPELINE_GROUPS,
  formatDateOnly,
  formatStudentName,
} from '@/lib/admissions-format';
import type { ApplicationDto, ApplicationStatus } from '@/lib/types';

export default function AdmissionsApplicationsPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && hasAnyPermission(user, ['stu-003:admin']);
  const search = useSearchParams();
  const presetPeriodId = search?.get('enrollmentPeriodId') ?? '';

  const periods = useEnrollmentPeriods(!!user);
  const [periodId, setPeriodId] = useState<string>(presetPeriodId);
  const [grade, setGrade] = useState<string>('');
  const apps = useApplications(
    {
      enrollmentPeriodId: periodId || undefined,
      applyingForGrade: grade || undefined,
    },
    !!user,
  );

  const grouped = useMemo(() => {
    const groups: Record<ApplicationStatus, ApplicationDto[]> = {
      DRAFT: [],
      SUBMITTED: [],
      UNDER_REVIEW: [],
      ACCEPTED: [],
      REJECTED: [],
      WAITLISTED: [],
      WITHDRAWN: [],
      ENROLLED: [],
    };
    for (const a of apps.data ?? []) groups[a.status].push(a);
    return groups;
  }, [apps.data]);

  if (!user) return null;
  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Applications" description="Admissions admin only." />
        <EmptyState title="Admin access required" />
      </div>
    );
  }

  const totalShown = (apps.data ?? []).length;

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Application Pipeline"
        description={`${totalShown} application${totalShown === 1 ? '' : 's'} matching filters.`}
      />

      <nav className="mt-2 flex gap-3 text-sm">
        <span className="font-medium text-campus-700">Applications</span>
        <span className="text-gray-300">·</span>
        <Link href="/admissions/periods" className="text-gray-500 hover:text-campus-700">
          Periods
        </Link>
        <span className="text-gray-300">·</span>
        <Link href="/admissions/waitlist" className="text-gray-500 hover:text-campus-700">
          Waitlist
        </Link>
      </nav>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <select
          value={periodId}
          onChange={(e) => setPeriodId(e.target.value)}
          className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
        >
          <option value="">All periods</option>
          {(periods.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.status.toLowerCase()})
            </option>
          ))}
        </select>
        <input
          value={grade}
          onChange={(e) => setGrade(e.target.value)}
          placeholder="Filter by grade…"
          maxLength={8}
          className="w-40 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
        />
        {(periodId || grade) && (
          <button
            type="button"
            onClick={() => {
              setPeriodId('');
              setGrade('');
            }}
            className="text-sm text-gray-500 hover:text-campus-700"
          >
            Clear filters
          </button>
        )}
      </div>

      <div className="mt-6">
        {apps.isLoading ? (
          <div className="py-16 text-center">
            <LoadingSpinner />
          </div>
        ) : apps.isError ? (
          <EmptyState title="Couldn’t load applications" />
        ) : (apps.data ?? []).length === 0 ? (
          <EmptyState
            title="No applications yet"
            description={
              periodId
                ? 'No applications match the selected period.'
                : 'When parents submit applications, they show up here.'
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 xl:grid-cols-6">
            {PIPELINE_GROUPS.map((status) => (
              <Column key={status} status={status} items={grouped[status]} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Column({ status, items }: { status: ApplicationStatus; items: ApplicationDto[] }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50">
      <header className="flex items-center justify-between border-b border-gray-200 px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-gray-700">
          {APPLICATION_STATUS_LABELS[status]}
        </span>
        <span className="text-xs font-semibold text-gray-500">{items.length}</span>
      </header>
      <ul className="space-y-2 px-2 py-2">
        {items.length === 0 ? (
          <li className="rounded-lg px-2 py-3 text-center text-xs text-gray-400">—</li>
        ) : (
          items.map((a) => (
            <li key={a.id}>
              <Link
                href={`/admissions/applications/${a.id}`}
                className="block rounded-lg border border-gray-200 bg-white px-3 py-2 transition-colors hover:border-campus-300 hover:shadow-sm"
              >
                <p className="text-sm font-semibold text-gray-900">
                  {formatStudentName(a.studentFirstName, a.studentLastName)}
                </p>
                <p className="mt-0.5 text-xs text-gray-500">
                  Grade {a.applyingForGrade}
                  {a.streamName ? ` · ${a.streamName}` : ''}
                </p>
                <div className="mt-1 flex items-center justify-between text-[11px] text-gray-400">
                  <span>{a.enrollmentPeriodName}</span>
                  <span>{a.submittedAt ? formatDateOnly(a.submittedAt) : '—'}</span>
                </div>
                <span
                  className={`mt-2 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                    APPLICATION_STATUS_PILL[a.status]
                  }`}
                >
                  {APPLICATION_STATUS_LABELS[a.status]}
                </span>
              </Link>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
