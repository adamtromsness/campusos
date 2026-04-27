'use client';

import Link from 'next/link';
import { useStudentClassGrades } from '@/hooks/use-classroom';
import { PageHeader } from '@/components/ui/PageHeader';
import { PageLoader } from '@/components/ui/LoadingSpinner';
import { EmptyState } from '@/components/ui/EmptyState';
import type { StudentClassAssignmentRowDto } from '@/lib/types';

interface StudentClassGradesViewProps {
  studentId: string | undefined;
  classId: string;
  /** Where the back-link points — different for student vs parent views. */
  backHref: string;
  backLabel: string;
}

export function StudentClassGradesView({
  studentId,
  classId,
  backHref,
  backLabel,
}: StudentClassGradesViewProps) {
  const data = useStudentClassGrades(studentId, classId);

  if (data.isLoading) return <PageLoader />;
  if (data.isError || !data.data) {
    return (
      <EmptyState
        title="Couldn't load grades"
        description="The class might not be available, or you may not have access."
      />
    );
  }

  const payload = data.data;
  const avg = payload.snapshot?.currentAverage;
  const letter = payload.snapshot?.letterGrade;

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        href={backHref}
        className="mb-3 inline-block text-sm text-campus-700 underline"
      >
        ← {backLabel}
      </Link>
      <PageHeader
        title={payload.class.courseName ?? payload.class.courseCode ?? 'Class grades'}
        description={`${payload.student.fullName} · ${payload.class.sectionCode ?? ''}`}
      />

      <section className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Current average" value={avg != null ? `${Math.round(avg)}%` : '—'} />
        <Stat label="Letter grade" value={letter ?? '—'} />
        <Stat
          label="Graded"
          value={
            payload.snapshot
              ? `${payload.snapshot.assignmentsGraded} / ${payload.snapshot.assignmentsTotal}`
              : '—'
          }
        />
      </section>

      <h2 className="mb-3 text-base font-semibold text-gray-900">Assignments</h2>
      {payload.assignments.length === 0 ? (
        <EmptyState
          title="No published assignments yet"
          description="Once your teacher posts and grades work, it'll show up here."
        />
      ) : (
        <ul className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-card">
          {payload.assignments.map((row, idx) => (
            <AssignmentRow key={row.assignment.id} row={row} divider={idx > 0} />
          ))}
        </ul>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-card border border-gray-200 bg-white p-4 shadow-card">
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-campus-700">{value}</p>
    </div>
  );
}

function AssignmentRow({
  row,
  divider,
}: {
  row: StudentClassAssignmentRowDto;
  divider: boolean;
}) {
  const a = row.assignment;
  const grade = row.grade;
  const submission = row.submission;
  const due = a.dueDate ? new Date(a.dueDate) : null;

  return (
    <li
      className={
        'flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between ' +
        (divider ? 'border-t border-gray-100' : '')
      }
    >
      <div className="min-w-0">
        <Link
          href={`/assignments/${a.id}`}
          className="truncate font-medium text-gray-900 hover:text-campus-700"
        >
          {a.title}
        </Link>
        <p className="text-xs text-gray-500">
          {a.assignmentType.name}
          {a.category ? ` · ${a.category.name}` : ''}
          {due ? ` · Due ${due.toLocaleDateString()}` : ''}
          {submission?.submittedAt
            ? ` · Submitted ${new Date(submission.submittedAt).toLocaleDateString()}`
            : ''}
        </p>
      </div>
      <GradeCell grade={grade} maxPoints={a.maxPoints} />
    </li>
  );
}

function GradeCell({
  grade,
  maxPoints,
}: {
  grade: StudentClassAssignmentRowDto['grade'];
  maxPoints: number;
}) {
  if (!grade) {
    return <span className="text-sm text-gray-400">Not graded yet</span>;
  }
  return (
    <div className="text-right">
      <p className="text-base font-semibold text-gray-900">
        {grade.gradeValue}
        <span className="ml-1 text-sm font-normal text-gray-500">/ {maxPoints}</span>
      </p>
      <p className="text-xs text-gray-500">
        {grade.percentage}%
        {grade.letterGrade ? ` · ${grade.letterGrade}` : ''}
      </p>
    </div>
  );
}
