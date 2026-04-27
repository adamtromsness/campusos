'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQueries } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { useMyStudent, useStudentGradebook } from '@/hooks/use-classroom';
import { PageHeader } from '@/components/ui/PageHeader';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { useAuthStore } from '@/lib/auth-store';
import type { AssignmentDto, GradebookStudentRowDto } from '@/lib/types';

type StatusFilter = 'ALL' | 'UPCOMING' | 'OVERDUE';

export default function StudentAssignmentsPage() {
  const user = useAuthStore((s) => s.user);
  const me = useMyStudent();
  const studentId = me.data?.id;
  const gradebook = useStudentGradebook(studentId);
  const classes = gradebook.data?.rows ?? [];

  const [classFilter, setClassFilter] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');

  if (!user) return null;
  if (user.personType !== 'STUDENT') {
    return (
      <EmptyState
        title="Not available"
        description="The assignments inbox is only available to students."
      />
    );
  }

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="My assignments"
        description="Everything across all your classes, sorted by due date."
      />

      {me.isLoading || gradebook.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <LoadingSpinner size="sm" /> Loading…
        </div>
      ) : (
        <>
          <Filters
            classes={classes}
            classFilter={classFilter}
            statusFilter={statusFilter}
            onClassChange={setClassFilter}
            onStatusChange={setStatusFilter}
          />
          <AssignmentList
            classes={classes}
            classFilter={classFilter}
            statusFilter={statusFilter}
          />
        </>
      )}
    </div>
  );
}

function Filters({
  classes,
  classFilter,
  statusFilter,
  onClassChange,
  onStatusChange,
}: {
  classes: GradebookStudentRowDto[];
  classFilter: string;
  statusFilter: StatusFilter;
  onClassChange: (v: string) => void;
  onStatusChange: (v: StatusFilter) => void;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-card border border-gray-200 bg-white p-3 shadow-card">
      <label className="text-sm text-gray-700">
        Class
        <select
          value={classFilter}
          onChange={(e) => onClassChange(e.target.value)}
          className="ml-2 rounded-md border border-gray-300 bg-white px-2 py-1 text-sm"
        >
          <option value="ALL">All classes</option>
          {classes.map((c) => (
            <option key={c.class.id} value={c.class.id}>
              {c.class.courseCode} · {c.class.sectionCode}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm text-gray-700">
        Status
        <select
          value={statusFilter}
          onChange={(e) => onStatusChange(e.target.value as StatusFilter)}
          className="ml-2 rounded-md border border-gray-300 bg-white px-2 py-1 text-sm"
        >
          <option value="ALL">All</option>
          <option value="UPCOMING">Upcoming (next 14 days)</option>
          <option value="OVERDUE">Overdue</option>
        </select>
      </label>
    </div>
  );
}

interface FlattenedAssignmentRow {
  assignment: AssignmentDto;
  classRow: GradebookStudentRowDto;
}

function AssignmentList({
  classes,
  classFilter,
  statusFilter,
}: {
  classes: GradebookStudentRowDto[];
  classFilter: string;
  statusFilter: StatusFilter;
}) {
  const queries = useQueries({
    queries: classes.map((row) => ({
      queryKey: ['classroom', 'assignments', 'class', row.class.id, false],
      queryFn: () => apiFetch<AssignmentDto[]>(`/api/v1/classes/${row.class.id}/assignments`),
    })),
  });

  const allRows: FlattenedAssignmentRow[] = useMemo(() => {
    const out: FlattenedAssignmentRow[] = [];
    for (let i = 0; i < classes.length; i++) {
      const data = queries[i]?.data ?? [];
      for (const a of data) out.push({ assignment: a, classRow: classes[i]! });
    }
    return out;
  }, [classes, queries]);

  const filtered = useMemo(() => {
    const now = Date.now();
    const horizon = now + 14 * 24 * 3600 * 1000;
    let rows = allRows;
    if (classFilter !== 'ALL') {
      rows = rows.filter((r) => r.classRow.class.id === classFilter);
    }
    if (statusFilter === 'UPCOMING') {
      rows = rows.filter((r) => {
        if (!r.assignment.dueDate) return false;
        const due = Date.parse(r.assignment.dueDate);
        return due >= now && due <= horizon;
      });
    } else if (statusFilter === 'OVERDUE') {
      rows = rows.filter((r) => {
        if (!r.assignment.dueDate) return false;
        return Date.parse(r.assignment.dueDate) < now;
      });
    }
    return rows.sort(byDueDate);
  }, [allRows, classFilter, statusFilter]);

  if (queries.some((q) => q.isLoading)) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <LoadingSpinner size="sm" /> Loading assignments…
      </div>
    );
  }
  if (filtered.length === 0) {
    return (
      <EmptyState
        title="No assignments match"
        description="Try changing the filters or check back when your teachers post new work."
      />
    );
  }

  return (
    <ul className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-card">
      {filtered.map((row, idx) => (
        <li key={row.assignment.id}>
          <Link
            href={`/assignments/${row.assignment.id}`}
            className={
              'flex items-center justify-between px-5 py-3 text-sm hover:bg-gray-50 ' +
              (idx > 0 ? 'border-t border-gray-100' : '')
            }
          >
            <div className="min-w-0">
              <p className="truncate font-medium text-gray-900">{row.assignment.title}</p>
              <p className="text-xs text-gray-500">
                {row.classRow.class.courseCode} · {row.classRow.class.sectionCode} ·{' '}
                {row.assignment.assignmentType.name}
              </p>
            </div>
            <DueLabel dueDate={row.assignment.dueDate} />
          </Link>
        </li>
      ))}
    </ul>
  );
}

function byDueDate(a: FlattenedAssignmentRow, b: FlattenedAssignmentRow): number {
  const ad = a.assignment.dueDate ? Date.parse(a.assignment.dueDate) : Infinity;
  const bd = b.assignment.dueDate ? Date.parse(b.assignment.dueDate) : Infinity;
  return ad - bd;
}

function DueLabel({ dueDate }: { dueDate: string | null }) {
  if (!dueDate) return <span className="text-xs text-gray-400">No due date</span>;
  const due = Date.parse(dueDate);
  const now = Date.now();
  const overdue = due < now;
  const formatted = new Date(due).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: now < due - 365 * 24 * 3600 * 1000 ? 'numeric' : undefined,
  });
  return (
    <span
      className={
        'whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ' +
        (overdue
          ? 'bg-status-absent-soft text-status-absent-text'
          : 'bg-gray-100 text-gray-700')
      }
    >
      {overdue ? 'Overdue · ' : 'Due '}
      {formatted}
    </span>
  );
}
