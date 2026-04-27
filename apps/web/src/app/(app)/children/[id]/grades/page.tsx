'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useStudent } from '@/hooks/use-children';
import { useStudentGradebook, useStudentProgressNotes } from '@/hooks/use-classroom';
import { PageHeader } from '@/components/ui/PageHeader';
import { PageLoader } from '@/components/ui/LoadingSpinner';
import { EmptyState } from '@/components/ui/EmptyState';
import type { ProgressNoteDto } from '@/lib/types';

export default function ChildGradesPage() {
  const params = useParams<{ id: string }>();
  const childId = params?.id ?? '';

  const child = useStudent(childId);
  const gradebook = useStudentGradebook(childId);
  const notes = useStudentProgressNotes(childId);

  if (child.isLoading || gradebook.isLoading) return <PageLoader />;
  if (child.isError || !child.data) {
    return (
      <EmptyState
        title="Child not found"
        description="If this is unexpected, contact the school office."
      />
    );
  }

  const rows = gradebook.data?.rows ?? [];

  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/dashboard" className="mb-3 inline-block text-sm text-campus-700 underline">
        ← Back to dashboard
      </Link>
      <PageHeader
        title={`${child.data.fullName}'s grades`}
        description="Current average per class. Click a class for the assignment-by-assignment breakdown."
      />

      {rows.length === 0 ? (
        <EmptyState
          title="No grades yet"
          description="Once teachers publish grades, they'll appear here."
        />
      ) : (
        <ul className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-card">
          {rows.map((row, idx) => {
            const avg = row.snapshot?.currentAverage;
            const letter = row.snapshot?.letterGrade;
            return (
              <li key={row.class.id}>
                <Link
                  href={`/children/${childId}/grades/${row.class.id}`}
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

      <ProgressNotesSection notes={notes.data ?? []} loading={notes.isLoading} />
    </div>
  );
}

function ProgressNotesSection({ notes, loading }: { notes: ProgressNoteDto[]; loading: boolean }) {
  if (loading) return null;
  const visible = notes.filter((n) => n.isParentVisible && n.publishedAt !== null);
  if (visible.length === 0) return null;
  return (
    <section className="mt-8">
      <h2 className="mb-3 text-base font-semibold text-gray-900">Teacher progress notes</h2>
      <ul className="space-y-3">
        {visible.map((n) => (
          <li key={n.id} className="rounded-card border border-gray-200 bg-white p-4 shadow-card">
            <div className="flex items-center justify-between text-xs text-gray-500">
              <span>
                {n.overallEffortRating ? n.overallEffortRating.replace('_', ' ') : 'Note'}
              </span>
              {n.publishedAt && <span>{new Date(n.publishedAt).toLocaleDateString()}</span>}
            </div>
            <p className="mt-2 whitespace-pre-wrap text-sm text-gray-700">{n.noteText}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
