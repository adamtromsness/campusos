'use client';

import Link from 'next/link';
import { useMyStudent, useStudentGradebook } from '@/hooks/use-classroom';
import { PageHeader } from '@/components/ui/PageHeader';
import { PageLoader } from '@/components/ui/LoadingSpinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { useAuthStore } from '@/lib/auth-store';

export default function StudentGradesPage() {
  const user = useAuthStore((s) => s.user);
  const me = useMyStudent();
  const studentId = me.data?.id;
  const gradebook = useStudentGradebook(studentId);

  if (!user) return null;
  if (user.personType !== 'STUDENT') {
    return (
      <EmptyState
        title="Not available"
        description="The grades view is only available to students. Parents see their child's grades from the dashboard."
      />
    );
  }
  if (me.isLoading || gradebook.isLoading) return <PageLoader />;
  const rows = gradebook.data?.rows ?? [];

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="My grades"
        description="Your current average per class. Click a class for the assignment-by-assignment breakdown."
      />
      {rows.length === 0 ? (
        <EmptyState
          title="No grades yet"
          description="Once your teacher publishes a grade, your average will appear here."
        />
      ) : (
        <ul className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-card">
          {rows.map((row, idx) => {
            const avg = row.snapshot?.currentAverage;
            const letter = row.snapshot?.letterGrade;
            return (
              <li key={row.class.id}>
                <Link
                  href={`/grades/${row.class.id}`}
                  className={
                    'flex items-center justify-between px-5 py-4 hover:bg-gray-50 ' +
                    (idx > 0 ? 'border-t border-gray-100' : '')
                  }
                >
                  <div className="min-w-0">
                    <p className="text-xs uppercase tracking-wide text-gray-500">
                      {row.class.courseCode}
                    </p>
                    <p className="truncate font-medium text-gray-900">{row.class.courseName}</p>
                    <p className="text-xs text-gray-500">{row.class.sectionCode}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-2xl font-semibold text-campus-700">
                      {avg != null ? `${Math.round(avg)}%` : '—'}
                    </p>
                    <p className="text-xs text-gray-500">
                      {letter ?? '—'}
                      {row.snapshot
                        ? ` · ${row.snapshot.assignmentsGraded}/${row.snapshot.assignmentsTotal} graded`
                        : ''}
                    </p>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
