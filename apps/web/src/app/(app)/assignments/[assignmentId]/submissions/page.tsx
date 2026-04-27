'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo } from 'react';
import {
  useAssignment,
  usePublishAllGrades,
  useSubmissionsForAssignment,
} from '@/hooks/use-classroom';
import { PageHeader } from '@/components/ui/PageHeader';
import { LoadingSpinner, PageLoader } from '@/components/ui/LoadingSpinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import type { SubmissionDto, SubmissionStatus } from '@/lib/types';

const STATUS_LABEL: Record<SubmissionStatus, string> = {
  NOT_STARTED: 'Not started',
  IN_PROGRESS: 'In progress',
  SUBMITTED: 'Submitted',
  GRADED: 'Graded',
  RETURNED: 'Returned',
};

const STATUS_TONE: Record<SubmissionStatus, string> = {
  NOT_STARTED: 'bg-gray-100 text-gray-600',
  IN_PROGRESS: 'bg-status-tardy-soft text-status-tardy-text',
  SUBMITTED: 'bg-status-excused-soft text-status-excused-text',
  GRADED: 'bg-status-present-soft text-status-present-text',
  RETURNED: 'bg-status-absent-soft text-status-absent-text',
};

const STATUS_RANK: Record<SubmissionStatus, number> = {
  SUBMITTED: 0,    // grading priority
  IN_PROGRESS: 1,
  NOT_STARTED: 2,
  GRADED: 3,
  RETURNED: 4,
};

export default function AssignmentSubmissionsPage() {
  const params = useParams<{ assignmentId: string }>();
  const assignmentId = params?.assignmentId ?? '';
  const { toast } = useToast();

  const assignmentQuery = useAssignment(assignmentId);
  const submissionsQuery = useSubmissionsForAssignment(assignmentId);
  const publishAll = usePublishAllGrades(assignmentQuery.data?.classId ?? '');

  const sorted = useMemo(() => {
    const list = submissionsQuery.data?.submissions ?? [];
    return [...list].sort((a, b) => {
      const r = STATUS_RANK[a.status] - STATUS_RANK[b.status];
      if (r !== 0) return r;
      return a.student.fullName.localeCompare(b.student.fullName);
    });
  }, [submissionsQuery.data]);

  if (assignmentQuery.isLoading || !assignmentQuery.data) {
    return <PageLoader label="Loading assignment…" />;
  }
  const assignment = assignmentQuery.data;
  const stats = submissionsQuery.data;

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        href={`/classes/${assignment.classId}/gradebook`}
        className="mb-3 inline-flex items-center gap-1 text-sm text-campus-600 hover:text-campus-700"
      >
        ← Back to gradebook
      </Link>

      <PageHeader
        title={assignment.title}
        description={`${assignment.assignmentType.name}${assignment.category ? ` · ${assignment.category.name}` : ''} · ${assignment.maxPoints} pts`}
        actions={
          stats && stats.gradedCount > stats.publishedCount ? (
            <button
              type="button"
              onClick={async () => {
                try {
                  const r = await publishAll.mutateAsync(assignment.id);
                  toast(
                    `Published ${r.publishedCount} grade${r.publishedCount === 1 ? '' : 's'}`,
                    'success',
                  );
                } catch (e) {
                  toast(e instanceof Error ? e.message : 'Failed', 'error');
                }
              }}
              disabled={publishAll.isPending}
              className="inline-flex items-center gap-2 rounded-lg bg-campus-700 px-4 py-2 text-sm font-semibold text-white shadow-card hover:bg-campus-600 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {publishAll.isPending && <LoadingSpinner size="sm" className="border-white/40 border-t-white" />}
              Publish all drafts ({stats.gradedCount - stats.publishedCount})
            </button>
          ) : null
        }
      />

      {stats && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Roster" value={stats.rosterSize} />
          <Stat label="Submitted" value={stats.submittedCount} />
          <Stat label="Graded" value={stats.gradedCount} />
          <Stat label="Published" value={stats.publishedCount} />
        </div>
      )}

      {submissionsQuery.isLoading ? (
        <div className="flex items-center gap-2 px-1 py-6 text-sm text-gray-500">
          <LoadingSpinner size="sm" />
          Loading submissions…
        </div>
      ) : sorted.length === 0 ? (
        <EmptyState title="No students enrolled" description="Roster is empty for this class." />
      ) : (
        <ul className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-card">
          {sorted.map((sub) => (
            <li
              key={sub.id || sub.student.id}
              className="border-b border-gray-100 last:border-b-0"
            >
              <SubmissionRow
                sub={sub}
                maxPoints={assignment.maxPoints}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SubmissionRow({ sub, maxPoints }: { sub: SubmissionDto; maxPoints: number }) {
  const status = sub.status;
  const grade = sub.grade;
  const pct = grade ? (grade.gradeValue / maxPoints) * 100 : null;

  // Submissions for students who never submitted come back with `id: ''`
  // from the API (synthetic placeholder for the roster). Those rows surface
  // here for visibility but aren't clickable into a detail.
  const hasRealSubmission = sub.id !== '';

  const inner = (
    <div className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-gray-50">
      <div className="min-w-0">
        <p className="text-sm font-medium text-gray-900">{sub.student.fullName}</p>
        {sub.student.studentNumber && (
          <p className="text-xs text-gray-400">#{sub.student.studentNumber}</p>
        )}
        {sub.submittedAt && (
          <p className="mt-0.5 text-xs text-gray-500">
            Submitted{' '}
            {new Date(sub.submittedAt).toLocaleString(undefined, {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })}
          </p>
        )}
      </div>
      <div className="flex items-center gap-3">
        {grade && (
          <span className="text-sm tabular-nums text-gray-700">
            <span className="font-semibold">{grade.gradeValue}</span>
            <span className="text-xs text-gray-400"> / {maxPoints}</span>
            {pct !== null && (
              <span className="ml-1 text-xs text-gray-500">({pct.toFixed(0)}%)</span>
            )}
            {!grade.isPublished && (
              <span className="ml-2 rounded-sm bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-700">
                draft
              </span>
            )}
          </span>
        )}
        <span
          className={cn(
            'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
            STATUS_TONE[status],
          )}
        >
          {STATUS_LABEL[status]}
        </span>
        {hasRealSubmission && <span className="text-gray-300">›</span>}
      </div>
    </div>
  );

  if (!hasRealSubmission) return inner;
  return <Link href={`/submissions/${sub.id}`}>{inner}</Link>;
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-card border border-gray-200 bg-white px-4 py-3 shadow-card">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-gray-900">{value}</p>
    </div>
  );
}
