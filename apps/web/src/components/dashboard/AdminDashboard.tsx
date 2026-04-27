'use client';

import Link from 'next/link';
import { useClasses } from '@/hooks/use-classes';
import { useAbsenceRequests } from '@/hooks/use-absence-requests';
import { PageHeader } from '@/components/ui/PageHeader';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { cn } from '@/components/ui/cn';
import type { AuthUser } from '@/lib/auth-store';
import type { AbsenceRequestDto, ClassDto, TodayAttendanceStatus } from '@/lib/types';

interface AdminDashboardProps {
  user: AuthUser;
}

export function AdminDashboard({ user }: AdminDashboardProps) {
  const classes = useClasses();
  const pending = useAbsenceRequests({ status: 'PENDING' });

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title={`Welcome, ${user.preferredName || user.firstName || user.displayName}`}
        description={`${formatToday()} · School-wide overview`}
      />

      <SchoolStats classes={classes.data ?? []} loading={classes.isLoading} />

      <section className="mt-8">
        <h2 className="mb-3 text-lg font-semibold text-gray-900">Today's classes</h2>
        {classes.isLoading ? (
          <Loading label="Loading classes…" />
        ) : (classes.data ?? []).length === 0 ? (
          <EmptyState
            title="No classes in the current term"
            description="The current academic year has no scheduled classes yet."
          />
        ) : (
          <ClassesTable classes={classes.data ?? []} />
        )}
      </section>

      <section className="mt-8">
        <h2 className="mb-3 text-lg font-semibold text-gray-900">Pending absence requests</h2>
        {pending.isLoading ? (
          <Loading label="Loading queue…" />
        ) : (pending.data ?? []).length === 0 ? (
          <EmptyState
            title="No pending requests"
            description="Advance absence requests submitted by parents will appear here for review."
          />
        ) : (
          <PendingTable requests={pending.data ?? []} />
        )}
      </section>
    </div>
  );
}

// ── Stats row ────────────────────────────────────────────────────────────

function SchoolStats({ classes, loading }: { classes: ClassDto[]; loading: boolean }) {
  let totalEnrolled = 0;
  let totalRecorded = 0;
  let totalPresent = 0;
  let totalTardy = 0;
  let totalAbsent = 0;
  let submitted = 0;

  for (const c of classes) {
    totalEnrolled += c.enrollmentCount;
    const t = c.todayAttendance;
    if (!t) continue;
    if (t.status === 'SUBMITTED') submitted += 1;
    totalRecorded += t.totalRecorded;
    totalPresent += t.present + t.tardy;
    totalTardy += t.tardy;
    totalAbsent += t.absent;
  }
  const rate = totalRecorded > 0 ? `${Math.round((totalPresent / totalRecorded) * 100)}%` : '—';
  const submittedLabel = `${submitted}/${classes.length}`;

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      <StatCard
        label="Classes submitted"
        value={loading ? '…' : submittedLabel}
        hint="Today's attendance confirmed"
      />
      <StatCard
        label="Attendance rate"
        value={loading ? '…' : rate}
        hint={totalRecorded === 0 ? 'No periods marked yet' : `${totalRecorded} periods marked`}
      />
      <StatCard label="Tardies today" value={loading ? '…' : String(totalTardy)} accent="tardy" />
      <StatCard
        label="Absences today"
        value={loading ? '…' : String(totalAbsent)}
        accent="absent"
        hint={`${totalEnrolled} students enrolled`}
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

// ── Classes table ───────────────────────────────────────────────────────

function ClassesTable({ classes }: { classes: ClassDto[] }) {
  return (
    <div className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-card">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <Th>Period</Th>
            <Th>Course</Th>
            <Th>Teacher</Th>
            <Th align="right">Enrolled</Th>
            <Th align="right">Marked</Th>
            <Th align="right">Tardy</Th>
            <Th align="right">Absent</Th>
            <Th>Status</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {classes.map((c) => {
            const t = c.todayAttendance;
            const teacher = c.teachers[0]?.fullName ?? '—';
            return (
              <tr key={c.id} className="bg-white">
                <Td>
                  <span className="font-medium text-gray-900">P{c.sectionCode}</span>
                </Td>
                <Td>
                  <Link
                    href={`/classes/${c.id}/attendance`}
                    className="text-campus-700 hover:underline"
                  >
                    {c.course.name}
                  </Link>
                  <span className="ml-2 text-xs text-gray-400">{c.course.code}</span>
                </Td>
                <Td>{teacher}</Td>
                <Td align="right">{c.enrollmentCount}</Td>
                <Td align="right">{t?.totalRecorded ?? 0}</Td>
                <Td align="right">{t?.tardy ?? 0}</Td>
                <Td align="right">{t?.absent ?? 0}</Td>
                <Td>
                  <ClassStatusPill status={t?.status ?? 'NOT_STARTED'} />
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      scope="col"
      className={cn(
        'px-4 py-3 text-xs font-medium uppercase tracking-wide text-gray-500',
        align === 'right' ? 'text-right' : 'text-left',
      )}
    >
      {children}
    </th>
  );
}

function Td({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <td
      className={cn(
        'px-4 py-3 text-sm text-gray-700',
        align === 'right' ? 'text-right' : 'text-left',
      )}
    >
      {children}
    </td>
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

// ── Pending absence requests ────────────────────────────────────────────

function PendingTable({ requests }: { requests: AbsenceRequestDto[] }) {
  return (
    <div className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-card">
      <ul className="divide-y divide-gray-100">
        {requests.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-3 px-5 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-gray-900">
                {r.studentName} · {r.reasonCategory.replaceAll('_', ' ').toLowerCase()}
              </p>
              <p className="text-xs text-gray-500">
                {r.absenceDateFrom}
                {r.absenceDateTo !== r.absenceDateFrom ? ` → ${r.absenceDateTo}` : ''}
                {r.reasonText ? ` — ${r.reasonText}` : ''}
              </p>
            </div>
            <span className="whitespace-nowrap rounded-full bg-status-tardy-soft px-2.5 py-0.5 text-xs font-medium text-status-tardy-text">
              pending
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── helpers ─────────────────────────────────────────────────────────────

function Loading({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-gray-500">
      <LoadingSpinner size="sm" /> {label}
    </div>
  );
}

function formatToday(): string {
  return new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}
