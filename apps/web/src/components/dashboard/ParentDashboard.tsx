'use client';

import Link from 'next/link';
import { useMyChildren, useStudentAttendance } from '@/hooks/use-children';
import { useStudentGradebook } from '@/hooks/use-classroom';
import { PageHeader } from '@/components/ui/PageHeader';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { Avatar } from '@/components/ui/Avatar';
import { cn } from '@/components/ui/cn';
import type { AuthUser } from '@/lib/auth-store';
import type { AttendanceRecord, StudentDto } from '@/lib/types';

interface ParentDashboardProps {
  user: AuthUser;
}

export function ParentDashboard({ user }: ParentDashboardProps) {
  const children = useMyChildren();
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title={`Welcome, ${user.preferredName || user.firstName || user.displayName}`}
        description={formatToday()}
      />

      {children.isLoading && (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <LoadingSpinner size="sm" /> Loading your children…
        </div>
      )}

      {children.isError && (
        <EmptyState
          title="Couldn't load your children"
          description="The API returned an error. Try refreshing the page."
        />
      )}

      {children.data && children.data.length === 0 && (
        <EmptyState
          title="No children linked to this account"
          description="If this is unexpected, contact the school office to confirm your guardian record."
        />
      )}

      {children.data && children.data.length > 0 && (
        <>
          <TardyBanner childrenList={children.data} today={today} />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {children.data.map((c) => (
              <ChildCard key={c.id} child={c} today={today} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── Tardy banner — aggregates today's tardies/absences across children ───

function TardyBanner({ childrenList, today }: { childrenList: StudentDto[]; today: string }) {
  // Render one query per child; collect results and roll up.
  return (
    <div className="space-y-2">
      {childrenList.map((c) => (
        <ChildTodayBanner key={c.id} child={c} today={today} />
      ))}
    </div>
  );
}

function ChildTodayBanner({ child, today }: { child: StudentDto; today: string }) {
  const att = useStudentAttendance(child.id, today, today);
  const rows = att.data ?? [];
  const tardies = rows.filter((r) => r.status === 'TARDY');
  const absents = rows.filter((r) => r.status === 'ABSENT');
  if (tardies.length === 0 && absents.length === 0) return null;

  const exception = tardies[0] ?? absents[0]!;
  const word = tardies.length > 0 ? 'tardy' : 'absent';
  const timeNote = exception.parentExplanation ? ` (${exception.parentExplanation})` : '';

  return (
    <div className="mb-4 flex items-start gap-3 rounded-card border border-status-tardy-soft bg-status-tardy-soft/40 px-4 py-3 text-sm">
      <span aria-hidden className="mt-0.5">
        🔔
      </span>
      <div>
        <p className="font-medium text-status-tardy-text">
          {child.firstName} was marked {word} in Period {exception.period}
          {timeNote}
        </p>
        <p className="mt-0.5 text-xs text-gray-600">
          Open{' '}
          <Link href={`/children/${child.id}/attendance`} className="text-campus-700 underline">
            today&rsquo;s attendance
          </Link>{' '}
          for the full period detail.
        </p>
      </div>
    </div>
  );
}

// ── Child card ──────────────────────────────────────────────────────────

function ChildCard({ child, today }: { child: StudentDto; today: string }) {
  const all = useStudentAttendance(child.id);
  const records = all.data ?? [];
  const todayRows = records.filter((r) => r.date === today);
  const todayStatus = summariseTodayStatus(todayRows);
  const rate = summariseAttendanceRate(records);

  return (
    <div className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-card">
      <div className="flex items-start gap-3 px-5 py-4">
        <Avatar name={child.fullName} size="lg" />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-semibold text-gray-900">{child.fullName}</h3>
          <p className="text-sm text-gray-500">
            {child.gradeLevel ? `Grade ${child.gradeLevel}` : 'Grade —'}
            {child.studentNumber ? ` · #${child.studentNumber}` : ''}
          </p>
        </div>
        <TodayPill status={todayStatus} loading={all.isLoading} />
      </div>

      <dl className="grid grid-cols-2 gap-4 border-t border-gray-100 px-5 py-3 text-sm">
        <div>
          <dt className="text-xs uppercase tracking-wide text-gray-500">Year-to-date rate</dt>
          <dd className="mt-1 text-2xl font-semibold text-campus-700">
            {all.isLoading ? '…' : rate}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-gray-500">Periods recorded</dt>
          <dd className="mt-1 text-2xl font-semibold text-gray-900">
            {all.isLoading ? '…' : records.length}
          </dd>
        </div>
      </dl>

      <GradesSection child={child} />

      <div className="flex flex-wrap gap-2 border-t border-gray-100 bg-gray-50 px-5 py-3 text-sm">
        <Link
          href={`/children/${child.id}/attendance`}
          className="flex-1 rounded-lg bg-campus-700 px-3 py-2 text-center font-medium text-white shadow-card hover:bg-campus-600"
        >
          View attendance
        </Link>
        <Link
          href={`/children/${child.id}/grades`}
          className="flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-center font-medium text-gray-700 hover:bg-gray-50"
        >
          View grades
        </Link>
        <Link
          href={`/children/${child.id}/absence-request`}
          className="flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-center font-medium text-gray-700 hover:bg-gray-50"
        >
          Report absence
        </Link>
      </div>
    </div>
  );
}

function GradesSection({ child }: { child: StudentDto }) {
  const gradebook = useStudentGradebook(child.id);
  const rows = gradebook.data?.rows ?? [];
  const withSnap = rows.filter((r) => r.snapshot && r.snapshot.currentAverage != null);

  return (
    <div className="border-t border-gray-100 px-5 py-3">
      <p className="text-xs uppercase tracking-wide text-gray-500">Grades</p>
      {gradebook.isLoading ? (
        <p className="mt-1 text-sm text-gray-400">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="mt-1 text-sm text-gray-400">No classes yet.</p>
      ) : withSnap.length === 0 ? (
        <p className="mt-1 text-sm text-gray-500">No published grades yet.</p>
      ) : (
        <ul className="mt-1 space-y-1 text-sm">
          {withSnap.slice(0, 4).map((row) => (
            <li key={row.class.id} className="flex items-center justify-between">
              <Link
                href={`/children/${child.id}/grades/${row.class.id}`}
                className="truncate text-gray-700 hover:text-campus-700"
              >
                {row.class.courseCode ?? row.class.courseName}
              </Link>
              <span className="ml-2 font-semibold text-campus-700">
                {Math.round(row.snapshot!.currentAverage as number)}%
                {row.snapshot!.letterGrade ? ` · ${row.snapshot!.letterGrade}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type TodaySummary = 'NOT_MARKED' | 'PRESENT' | 'TARDY' | 'ABSENT' | 'EXCUSED' | 'MIXED';

function summariseTodayStatus(rows: AttendanceRecord[]): TodaySummary {
  if (rows.length === 0) return 'NOT_MARKED';
  if (rows.some((r) => r.status === 'ABSENT')) return 'ABSENT';
  if (rows.some((r) => r.status === 'TARDY')) return 'TARDY';
  if (rows.some((r) => r.status === 'EXCUSED')) return 'EXCUSED';
  if (rows.every((r) => r.status === 'PRESENT')) return 'PRESENT';
  return 'MIXED';
}

function summariseAttendanceRate(rows: AttendanceRecord[]): string {
  if (rows.length === 0) return '—';
  const inAttendance = rows.filter(
    (r) => r.status === 'PRESENT' || r.status === 'TARDY' || r.status === 'EXCUSED',
  ).length;
  return `${Math.round((inAttendance / rows.length) * 100)}%`;
}

function TodayPill({ status, loading }: { status: TodaySummary; loading: boolean }) {
  if (loading) return <LoadingSpinner size="sm" />;
  const styles: Record<TodaySummary, string> = {
    NOT_MARKED: 'bg-gray-100 text-gray-700',
    PRESENT: 'bg-status-present-soft text-status-present-text',
    TARDY: 'bg-status-tardy-soft text-status-tardy-text',
    ABSENT: 'bg-status-absent-soft text-status-absent-text',
    EXCUSED: 'bg-status-excused-soft text-status-excused-text',
    MIXED: 'bg-status-tardy-soft text-status-tardy-text',
  };
  const labels: Record<TodaySummary, string> = {
    NOT_MARKED: 'Not marked',
    PRESENT: 'Present',
    TARDY: 'Tardy',
    ABSENT: 'Absent',
    EXCUSED: 'Excused',
    MIXED: 'Mixed',
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

function formatToday(): string {
  return new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}
