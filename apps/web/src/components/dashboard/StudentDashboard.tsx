'use client';

import Link from 'next/link';
import { useQueries } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { useMyStudent, useStudentGradebook } from '@/hooks/use-classroom';
import { PageHeader } from '@/components/ui/PageHeader';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { EmptyState } from '@/components/ui/EmptyState';
import type { AuthUser } from '@/lib/auth-store';
import type { AssignmentDto, GradebookStudentRowDto } from '@/lib/types';

interface StudentDashboardProps {
  user: AuthUser;
}

export function StudentDashboard({ user }: StudentDashboardProps) {
  const me = useMyStudent();
  const studentId = me.data?.id;
  const gradebook = useStudentGradebook(studentId);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title={`Welcome, ${user.preferredName || user.firstName || user.displayName}`}
        description={formatToday()}
      />

      {me.isLoading || gradebook.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <LoadingSpinner size="sm" /> Loading your dashboard…
        </div>
      ) : me.isError ? (
        <EmptyState
          title="Couldn't load your student record"
          description="If this is unexpected, ask the school office to confirm your account."
        />
      ) : (
        <>
          <UpcomingAssignmentsCard classes={gradebook.data?.rows ?? []} />
          <ClassesGrid classes={gradebook.data?.rows ?? []} />
        </>
      )}
    </div>
  );
}

function UpcomingAssignmentsCard({ classes }: { classes: GradebookStudentRowDto[] }) {
  const queries = useQueries({
    queries: classes.map((row) => ({
      queryKey: ['classroom', 'assignments', 'class', row.class.id, false],
      queryFn: () => apiFetch<AssignmentDto[]>(`/api/v1/classes/${row.class.id}/assignments`),
    })),
  });
  const all = queries.flatMap((q) => q.data ?? []);
  const now = Date.now();
  const upcoming = all
    .filter((a) => a.dueDate !== null)
    .map((a) => ({ a, due: Date.parse(a.dueDate as string) }))
    .filter(({ due }) => Number.isFinite(due) && due >= now - 24 * 3600 * 1000)
    .sort((x, y) => x.due - y.due)
    .slice(0, 5);

  return (
    <section className="mb-6 rounded-card border border-gray-200 bg-white p-5 shadow-card">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-gray-900">Upcoming assignments</h2>
        <Link href="/assignments" className="text-sm text-campus-700 underline">
          View all
        </Link>
      </div>
      {queries.some((q) => q.isLoading) ? (
        <p className="mt-3 text-sm text-gray-500">Loading…</p>
      ) : upcoming.length === 0 ? (
        <p className="mt-3 text-sm text-gray-500">Nothing due soon. Nice.</p>
      ) : (
        <ul className="mt-3 divide-y divide-gray-100">
          {upcoming.map(({ a, due }) => {
            const overdue = due < now;
            return (
              <li key={a.id} className="flex items-center justify-between py-2 text-sm">
                <Link
                  href={`/assignments/${a.id}`}
                  className="truncate font-medium text-gray-900 hover:text-campus-700"
                >
                  {a.title}
                </Link>
                <span className={overdue ? 'text-status-absent-text' : 'text-gray-500'}>
                  {new Date(due).toLocaleDateString(undefined, {
                    month: 'short',
                    day: 'numeric',
                  })}
                  {overdue ? ' · overdue' : ''}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function ClassesGrid({ classes }: { classes: GradebookStudentRowDto[] }) {
  if (classes.length === 0) {
    return (
      <EmptyState
        title="No classes yet"
        description="Once you're enrolled, your classes will appear here."
      />
    );
  }
  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-semibold text-gray-900">Your classes</h2>
        <Link href="/grades" className="text-sm text-campus-700 underline">
          Full grades
        </Link>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {classes.map((row) => {
          const avg = row.snapshot?.currentAverage;
          const letter = row.snapshot?.letterGrade;
          return (
            <Link
              key={row.class.id}
              href={`/grades/${row.class.id}`}
              className="block rounded-card border border-gray-200 bg-white p-5 shadow-card transition-shadow hover:shadow-card-hover"
            >
              <p className="text-xs uppercase tracking-wide text-gray-500">
                {row.class.courseCode}
              </p>
              <h3 className="mt-1 truncate text-base font-semibold text-gray-900">
                {row.class.courseName}
              </h3>
              <p className="text-xs text-gray-500">{row.class.sectionCode}</p>
              <div className="mt-3 flex items-end gap-2">
                <span className="text-3xl font-semibold text-campus-700">
                  {avg != null ? `${Math.round(avg)}%` : '—'}
                </span>
                {letter && <span className="text-base font-medium text-gray-700">{letter}</span>}
              </div>
              <p className="mt-1 text-xs text-gray-500">
                {row.snapshot
                  ? `${row.snapshot.assignmentsGraded} of ${row.snapshot.assignmentsTotal} graded`
                  : 'No grades yet'}
              </p>
            </Link>
          );
        })}
      </div>
    </section>
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
