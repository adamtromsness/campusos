'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useAssignment, useMySubmission, useSubmitAssignment } from '@/hooks/use-classroom';
import { PageHeader } from '@/components/ui/PageHeader';
import { PageLoader } from '@/components/ui/LoadingSpinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';
import { useAuthStore } from '@/lib/auth-store';
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
  RETURNED: 'bg-status-tardy-soft text-status-tardy-text',
};

export default function AssignmentDetailPage() {
  const params = useParams<{ assignmentId: string }>();
  const assignmentId = params?.assignmentId ?? '';
  const user = useAuthStore((s) => s.user);
  const isStudent = user?.personType === 'STUDENT';

  const assignment = useAssignment(assignmentId);
  const mySub = useMySubmission(isStudent ? assignmentId : undefined);

  if (assignment.isLoading) return <PageLoader />;
  if (assignment.isError || !assignment.data) {
    return (
      <EmptyState
        title="Assignment not found"
        description="It may have been removed, or you might not have access."
      />
    );
  }

  const a = assignment.data;
  const due = a.dueDate ? new Date(a.dueDate) : null;
  const dueText = due ? due.toLocaleString() : 'No due date';

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title={a.title}
        description={`${a.assignmentType.name} · Worth ${a.maxPoints} points · ${dueText}`}
      />

      <section className="rounded-card border border-gray-200 bg-white p-5 shadow-card">
        <h2 className="text-sm font-semibold text-gray-900">Instructions</h2>
        {a.instructions ? (
          <p className="mt-2 whitespace-pre-wrap text-sm text-gray-700">{a.instructions}</p>
        ) : (
          <p className="mt-2 text-sm text-gray-500">No instructions provided.</p>
        )}
      </section>

      {isStudent ? (
        <StudentSubmitPanel
          assignmentId={assignmentId}
          maxPoints={a.maxPoints}
          submission={mySub.data ?? null}
          loading={mySub.isLoading}
        />
      ) : (
        <NonStudentNotice />
      )}
    </div>
  );
}

function StudentSubmitPanel({
  assignmentId,
  maxPoints,
  submission,
  loading,
}: {
  assignmentId: string;
  maxPoints: number;
  submission: SubmissionDto | null;
  loading: boolean;
}) {
  const toast = useToast();
  const submit = useSubmitAssignment(assignmentId);
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (submission && submission.submissionText && !editing) {
      setText(submission.submissionText);
    }
  }, [submission, editing]);

  if (loading) {
    return (
      <section className="mt-6 rounded-card border border-gray-200 bg-white p-5 shadow-card">
        <p className="text-sm text-gray-500">Loading your submission…</p>
      </section>
    );
  }

  const status = submission?.status ?? 'NOT_STARTED';
  const grade = submission?.grade ?? null;
  const submittedAt = submission?.submittedAt
    ? new Date(submission.submittedAt).toLocaleString()
    : null;

  function handleSubmit() {
    submit.mutate(
      { submissionText: text },
      {
        onSuccess: () => {
          toast.toast('Your work was submitted to the teacher.', 'success');
          setEditing(false);
        },
        onError: (err: unknown) => {
          toast.toast(
            err instanceof Error ? `Submit failed: ${err.message}` : 'Submit failed',
            'error',
          );
        },
      },
    );
  }

  const showForm = !submission || editing;

  return (
    <>
      <section className="mt-6 rounded-card border border-gray-200 bg-white p-5 shadow-card">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-900">Your submission</h2>
          <span className={'rounded-full px-2.5 py-0.5 text-xs font-medium ' + STATUS_TONE[status]}>
            {STATUS_LABEL[status]}
          </span>
        </div>

        {submission && submittedAt && (
          <p className="mt-1 text-xs text-gray-500">Submitted {submittedAt}</p>
        )}

        {showForm ? (
          <>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={8}
              className="mt-3 w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
              placeholder="Type your response here…"
            />
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={handleSubmit}
                disabled={submit.isPending || text.trim().length === 0}
                className="rounded-lg bg-campus-700 px-4 py-2 text-sm font-medium text-white shadow-card hover:bg-campus-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submit.isPending ? 'Submitting…' : submission ? 'Resubmit' : 'Submit'}
              </button>
              {submission && editing && (
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setText(submission.submissionText ?? '');
                  }}
                  className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            {submission?.submissionText ? (
              <p className="mt-3 whitespace-pre-wrap rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-800">
                {submission.submissionText}
              </p>
            ) : (
              <p className="mt-3 text-sm text-gray-500">No text submitted.</p>
            )}
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="mt-3 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Edit and resubmit
            </button>
          </>
        )}
      </section>

      {grade && grade.isPublished && (
        <section className="mt-6 rounded-card border border-gray-200 bg-white p-5 shadow-card">
          <h2 className="text-sm font-semibold text-gray-900">Grade</h2>
          <p className="mt-2 text-3xl font-semibold text-campus-700">
            {grade.gradeValue}
            <span className="ml-1 text-base font-normal text-gray-500">/ {maxPoints}</span>
            {grade.letterGrade && (
              <span className="ml-3 text-base font-medium text-gray-700">{grade.letterGrade}</span>
            )}
          </p>
          {grade.feedback ? (
            <div className="mt-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                Feedback
              </p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-gray-700">{grade.feedback}</p>
            </div>
          ) : null}
        </section>
      )}
    </>
  );
}

function NonStudentNotice() {
  const params = useParams<{ assignmentId: string }>();
  return (
    <section className="mt-6 rounded-card border border-gray-200 bg-white p-5 shadow-card">
      <p className="text-sm text-gray-600">
        Only enrolled students can submit work for this assignment. Teachers can review the
        submissions queue from the{' '}
        <Link
          href={`/assignments/${params?.assignmentId ?? ''}/submissions`}
          className="text-campus-700 underline"
        >
          submissions page
        </Link>
        .
      </p>
    </section>
  );
}
