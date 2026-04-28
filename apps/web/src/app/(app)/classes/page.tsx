'use client';

import Link from 'next/link';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { useClasses, useMyClasses } from '@/hooks/use-classes';
import { useMyStudent, useStudentGradebook } from '@/hooks/use-classroom';
import { PageHeader } from '@/components/ui/PageHeader';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { cn } from '@/components/ui/cn';
import type { ClassDto, GradebookStudentRowDto, TodayAttendanceStatus } from '@/lib/types';

export default function ClassesPage() {
  const user = useAuthStore((s) => s.user);
  if (!user) return null;

  const isAdmin = hasAnyPermission(user, ['sch-001:admin']);
  const isStudent = user.personType === 'STUDENT';
  const isStaff = user.personType === 'STAFF';

  if (isStudent) return <StudentClassesView />;
  if (isAdmin) return <SchoolClassesView />;
  if (isStaff) return <TeacherClassesView />;

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Classes" />
      <EmptyState
        title="No classes available"
        description="This account does not have access to a class list."
      />
    </div>
  );
}

// ── Teacher ──────────────────────────────────────────────────────────────

function TeacherClassesView() {
  const classes = useMyClasses();
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Classes" description="Your assigned classes for the current term." />
      <ClassListBody
        classes={classes.data ?? []}
        loading={classes.isLoading}
        error={classes.isError}
        hrefFor={(c) => `/classes/${c.id}/attendance`}
        emptyTitle="No classes assigned"
        emptyDescription="You aren't listed as a teacher on any class for the current academic year."
      />
    </div>
  );
}

// ── Admin ────────────────────────────────────────────────────────────────

function SchoolClassesView() {
  const classes = useClasses();
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Classes" description="Every class in the current academic year." />
      <ClassListBody
        classes={classes.data ?? []}
        loading={classes.isLoading}
        error={classes.isError}
        hrefFor={(c) => `/classes/${c.id}/attendance`}
        emptyTitle="No classes scheduled"
        emptyDescription="The current academic year has no scheduled classes yet."
      />
    </div>
  );
}

function ClassListBody({
  classes,
  loading,
  error,
  hrefFor,
  emptyTitle,
  emptyDescription,
}: {
  classes: ClassDto[];
  loading: boolean;
  error: boolean;
  hrefFor: (c: ClassDto) => string;
  emptyTitle: string;
  emptyDescription: string;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <LoadingSpinner size="sm" />
        Loading classes…
      </div>
    );
  }
  if (error) {
    return (
      <EmptyState
        title="Couldn't load classes"
        description="The API returned an error. Try refreshing the page."
      />
    );
  }
  if (classes.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {classes.map((c) => (
        <ClassCard key={c.id} cls={c} href={hrefFor(c)} />
      ))}
    </div>
  );
}

function ClassCard({ cls, href }: { cls: ClassDto; href: string }) {
  const summary = cls.todayAttendance;
  return (
    <Link
      href={href}
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
        {summary && <ClassStatusPill status={summary.status} />}
      </div>
      <p className="mt-4 text-xs text-gray-500">
        {cls.enrollmentCount} students
        {cls.room ? ` · Room ${cls.room}` : ''}
      </p>
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

// ── Student ──────────────────────────────────────────────────────────────

function StudentClassesView() {
  const me = useMyStudent();
  const gradebook = useStudentGradebook(me.data?.id);
  const rows = gradebook.data?.rows ?? [];

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="My Classes" description="Your enrolled classes and current grades." />
      {me.isLoading || gradebook.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <LoadingSpinner size="sm" /> Loading your classes…
        </div>
      ) : me.isError ? (
        <EmptyState
          title="Couldn't load your student record"
          description="If this is unexpected, ask the school office to confirm your account."
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No classes yet"
          description="Once you're enrolled, your classes will appear here."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((row) => (
            <StudentClassCard key={row.class.id} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}

function StudentClassCard({ row }: { row: GradebookStudentRowDto }) {
  const avg = row.snapshot?.currentAverage;
  const letter = row.snapshot?.letterGrade;
  return (
    <Link
      href={`/grades/${row.class.id}`}
      className="block rounded-card border border-gray-200 bg-white p-5 shadow-card transition hover:border-campus-300 hover:shadow-elevated"
    >
      <p className="text-xs uppercase tracking-wide text-gray-500">{row.class.courseCode}</p>
      <h3 className="mt-1 truncate text-base font-semibold text-gray-900">{row.class.courseName}</h3>
      <p className="text-xs text-gray-500">{row.class.sectionCode}</p>
      <div className="mt-3 flex items-end gap-2">
        <span className="text-3xl font-semibold text-campus-700">
          {avg != null ? `${Math.round(avg)}%` : '—'}
        </span>
        {letter && <span className="text-base font-medium text-gray-700">{letter}</span>}
      </div>
    </Link>
  );
}
