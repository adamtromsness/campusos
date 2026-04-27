'use client';

import Link from 'next/link';
import { useMyClasses } from '@/hooks/use-classes';
import { useAbsenceRequests } from '@/hooks/use-absence-requests';
import { PageHeader } from '@/components/ui/PageHeader';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { cn } from '@/components/ui/cn';
import type { AuthUser } from '@/lib/auth-store';
import type { ClassDto, AbsenceRequestDto, TodayAttendanceStatus } from '@/lib/types';

interface TeacherDashboardProps {
  user: AuthUser;
}

export function TeacherDashboard({ user }: TeacherDashboardProps) {
  const classes = useMyClasses();
  const absences = useAbsenceRequests();

  const today = formatToday();
  const greeting = `Good ${timeOfDayGreeting()}, ${user.preferredName || user.firstName || user.displayName}`;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title={greeting} description={today} />

      <QuickStats classes={classes.data ?? []} loading={classes.isLoading} />

      <section className="mt-8">
        <h2 className="mb-3 text-lg font-semibold text-gray-900">Today&rsquo;s classes</h2>
        {classes.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <LoadingSpinner size="sm" />
            Loading your classes…
          </div>
        ) : classes.isError ? (
          <EmptyState
            title="Couldn't load your classes"
            description="The API returned an error. Try refreshing the page."
          />
        ) : (classes.data ?? []).length === 0 ? (
          <EmptyState
            title="No classes assigned"
            description="You aren't listed as a teacher on any class for the current academic year."
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {(classes.data ?? []).map((c) => (
              <ClassCard key={c.id} cls={c} />
            ))}
          </div>
        )}
      </section>

      <section className="mt-8">
        <h2 className="mb-3 text-lg font-semibold text-gray-900">Recent activity</h2>
        <RecentActivity
          requests={absences.data ?? []}
          loading={absences.isLoading}
          error={absences.isError}
        />
      </section>
    </div>
  );
}

// ── QuickStats ─────────────────────────────────────────────────────────────

function QuickStats({ classes, loading }: { classes: ClassDto[]; loading: boolean }) {
  const totalStudents = classes.reduce((sum, c) => sum + c.enrollmentCount, 0);
  let totalRecorded = 0;
  let totalPresent = 0;
  let totalTardy = 0;
  let totalAbsent = 0;
  for (const c of classes) {
    const t = c.todayAttendance;
    if (!t) continue;
    totalRecorded += t.totalRecorded;
    totalPresent += t.present + t.tardy; // tardy still counts as "in attendance"
    totalTardy += t.tardy;
    totalAbsent += t.absent;
  }
  const rate = totalRecorded > 0 ? `${Math.round((totalPresent / totalRecorded) * 100)}%` : '—';

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      <StatCard label="Total students" value={loading ? '…' : totalStudents.toString()} />
      <StatCard
        label="Attendance rate"
        value={loading ? '…' : rate}
        hint={totalRecorded === 0 ? 'No periods marked yet' : `${totalRecorded} marked`}
      />
      <StatCard
        label="Tardies today"
        value={loading ? '…' : totalTardy.toString()}
        accent="tardy"
      />
      <StatCard
        label="Absences today"
        value={loading ? '…' : totalAbsent.toString()}
        accent="absent"
      />
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: 'tardy' | 'absent';
}) {
  const accentClass =
    accent === 'tardy'
      ? 'text-status-tardy-text'
      : accent === 'absent'
        ? 'text-status-absent-text'
        : 'text-campus-700';
  return (
    <div className="rounded-card border border-gray-200 bg-white p-5 shadow-card">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</p>
      <p className={cn('mt-2 text-3xl font-semibold', accentClass)}>{value}</p>
      {hint && <p className="mt-1 text-xs text-gray-400">{hint}</p>}
    </div>
  );
}

// ── ClassCard ──────────────────────────────────────────────────────────────

function ClassCard({ cls }: { cls: ClassDto }) {
  const summary = cls.todayAttendance;
  return (
    <Link
      href={`/classes/${cls.id}/attendance`}
      className="group block rounded-card border border-gray-200 bg-white p-5 shadow-card transition hover:border-campus-300 hover:shadow-elevated"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-campus-600">
            Period {cls.sectionCode}
          </p>
          <h3 className="mt-1 truncate text-base font-semibold text-gray-900">{cls.course.name}</h3>
          <p className="text-xs text-gray-500">
            {cls.course.code}
            {cls.course.gradeLevel ? ` · ${cls.course.gradeLevel}` : ''}
          </p>
        </div>
        <ClassStatusPill status={summary?.status ?? 'NOT_STARTED'} />
      </div>

      <dl className="mt-4 grid grid-cols-3 gap-3 text-sm">
        <div>
          <dt className="text-xs text-gray-500">Students</dt>
          <dd className="font-medium text-gray-900">{cls.enrollmentCount}</dd>
        </div>
        <div>
          <dt className="text-xs text-gray-500">Room</dt>
          <dd className="font-medium text-gray-900">{cls.room ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-gray-500">Marked</dt>
          <dd className="font-medium text-gray-900">{summary?.totalRecorded ?? 0}</dd>
        </div>
      </dl>

      {summary && summary.totalRecorded > 0 && (
        <div className="mt-3 flex gap-2 text-xs">
          {summary.tardy > 0 && (
            <span className="rounded-full bg-status-tardy-soft px-2 py-0.5 text-status-tardy-text">
              {summary.tardy} tardy
            </span>
          )}
          {summary.absent > 0 && (
            <span className="rounded-full bg-status-absent-soft px-2 py-0.5 text-status-absent-text">
              {summary.absent} absent
            </span>
          )}
          {summary.excused > 0 && (
            <span className="rounded-full bg-status-excused-soft px-2 py-0.5 text-status-excused-text">
              {summary.excused} excused
            </span>
          )}
        </div>
      )}
    </Link>
  );
}

function ClassStatusPill({ status }: { status: TodayAttendanceStatus }) {
  const styles: Record<TodayAttendanceStatus, string> = {
    NOT_STARTED: 'bg-gray-100 text-gray-700',
    IN_PROGRESS: 'bg-status-tardy-soft text-status-tardy-text',
    SUBMITTED: 'bg-status-present-soft text-status-present-text',
  };
  const labels: Record<TodayAttendanceStatus, string> = {
    NOT_STARTED: 'Not started',
    IN_PROGRESS: 'In progress',
    SUBMITTED: 'Submitted',
  };
  return (
    <span
      className={cn(
        'whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium',
        styles[status],
      )}
    >
      {labels[status]}
    </span>
  );
}

// ── RecentActivity ─────────────────────────────────────────────────────────

function RecentActivity({
  requests,
  loading,
  error,
}: {
  requests: AbsenceRequestDto[];
  loading: boolean;
  error: boolean;
}) {
  if (loading) {
    return (
      <div className="rounded-card border border-gray-200 bg-white p-5 shadow-card">
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <LoadingSpinner size="sm" />
          Loading activity…
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-card border border-gray-200 bg-white p-5 text-sm text-gray-500 shadow-card">
        Couldn&rsquo;t load recent activity.
      </div>
    );
  }
  const recent = requests.slice(0, 5);
  if (recent.length === 0) {
    return (
      <EmptyState
        title="No recent activity"
        description="Absence requests submitted by parents will show up here."
      />
    );
  }
  return (
    <div className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-card">
      <ul className="divide-y divide-gray-100">
        {recent.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-3 px-5 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-gray-900">
                {r.studentName} · {r.reasonCategory.replaceAll('_', ' ').toLowerCase()}
              </p>
              <p className="text-xs text-gray-500">
                {r.absenceDateFrom}
                {r.absenceDateTo !== r.absenceDateFrom ? ` → ${r.absenceDateTo}` : ''} ·{' '}
                {formatRelative(r.createdAt)}
              </p>
            </div>
            <RequestStatusPill status={r.status} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function RequestStatusPill({ status }: { status: string }) {
  const styles: Record<string, string> = {
    PENDING: 'bg-status-tardy-soft text-status-tardy-text',
    APPROVED: 'bg-status-present-soft text-status-present-text',
    REJECTED: 'bg-status-absent-soft text-status-absent-text',
  };
  return (
    <span
      className={cn(
        'whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium',
        styles[status] || 'bg-gray-100 text-gray-700',
      )}
    >
      {status.toLowerCase()}
    </span>
  );
}

// ── helpers ────────────────────────────────────────────────────────────────

function formatToday(): string {
  return new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function timeOfDayGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  return 'evening';
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diff = Math.max(0, now - then);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
