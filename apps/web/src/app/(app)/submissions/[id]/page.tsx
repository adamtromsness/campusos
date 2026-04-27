'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  useAssignment,
  useGradeSubmission,
  usePublishGrade,
  useSubmission,
  useUnpublishGrade,
} from '@/hooks/use-classroom';
import { PageHeader } from '@/components/ui/PageHeader';
import { LoadingSpinner, PageLoader } from '@/components/ui/LoadingSpinner';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import { deriveLetter } from '@/components/classroom/GradeCellEditor';

export default function SubmissionDetailPage() {
  const params = useParams<{ id: string }>();
  const submissionId = params?.id ?? '';
  const router = useRouter();
  const { toast } = useToast();

  const submissionQuery = useSubmission(submissionId);
  const assignmentId = submissionQuery.data?.assignmentId;
  const assignmentQuery = useAssignment(assignmentId);
  const grade = useGradeSubmission();
  const publish = usePublishGrade();
  const unpublish = useUnpublishGrade();

  const [gradeValueStr, setGradeValueStr] = useState('');
  const [feedback, setFeedback] = useState('');

  // Re-seed inputs when the submission loads.
  useEffect(() => {
    const sub = submissionQuery.data;
    if (!sub) return;
    setGradeValueStr(sub.grade ? String(sub.grade.gradeValue) : '');
    setFeedback(sub.grade?.feedback ?? '');
  }, [submissionQuery.data?.id, submissionQuery.data?.grade?.id]);

  if (submissionQuery.isLoading || !submissionQuery.data) {
    return <PageLoader label="Loading submission…" />;
  }
  const sub = submissionQuery.data;
  const assignment = assignmentQuery.data ?? null;
  const maxPoints = assignment?.maxPoints ?? null;
  const numeric = Number(gradeValueStr);
  const isNumber = gradeValueStr !== '' && Number.isFinite(numeric);
  const overMax =
    isNumber && maxPoints !== null && numeric > maxPoints && !assignment?.isExtraCredit;
  const negative = isNumber && numeric < 0;
  const canSave = isNumber && !overMax && !negative && !grade.isPending;
  const pct = isNumber && maxPoints !== null && maxPoints > 0 ? (numeric / maxPoints) * 100 : null;

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href={assignmentId ? `/assignments/${assignmentId}/submissions` : '/dashboard'}
        className="mb-3 inline-flex items-center gap-1 text-sm text-campus-600 hover:text-campus-700"
      >
        ← Back to submissions
      </Link>

      <PageHeader
        title={assignment?.title ?? 'Submission'}
        description={`${sub.student.fullName}${sub.student.studentNumber ? ' · #' + sub.student.studentNumber : ''}${assignment ? ' · ' + assignment.assignmentType.name + ' · ' + assignment.maxPoints + ' pts' : ''}`}
      />

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="rounded-card border border-gray-200 bg-white p-4 shadow-card">
          <h2 className="text-sm font-semibold text-gray-900">Student work</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            Status: <span className="font-medium">{sub.status}</span>
            {sub.submittedAt && (
              <>
                {' '}
                · submitted{' '}
                {new Date(sub.submittedAt).toLocaleString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </>
            )}
          </p>
          <div className="mt-3 whitespace-pre-wrap rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-700">
            {sub.submissionText || <span className="italic text-gray-400">No text content.</span>}
          </div>
          {sub.attachments && sub.attachments.length > 0 && (
            <div className="mt-3 text-xs text-gray-500">
              {sub.attachments.length} attachment{sub.attachments.length === 1 ? '' : 's'} on this
              submission. Attachment preview UX is post-Cycle 2.
            </div>
          )}
        </section>

        <section className="rounded-card border border-gray-200 bg-white p-4 shadow-card">
          <h2 className="text-sm font-semibold text-gray-900">Grade</h2>

          <div className="mt-3 space-y-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500">
                Awarded points{' '}
                {maxPoints !== null && <span className="text-gray-400">/ {maxPoints}</span>}
              </span>
              <input
                type="number"
                min={0}
                step={0.01}
                value={gradeValueStr}
                disabled={grade.isPending}
                onChange={(e) => setGradeValueStr(e.target.value)}
                className={cn(
                  'w-full rounded-lg border px-3 py-2 text-sm focus:outline-none',
                  overMax || negative
                    ? 'border-red-300 focus:border-red-400'
                    : 'border-gray-200 focus:border-campus-400',
                )}
              />
              <span className="mt-1 block text-xs text-gray-500">
                {pct !== null ? `${pct.toFixed(2)}% · ${deriveLetter(pct)}` : '—'}
                {(overMax || negative) && (
                  <span className="ml-2 text-red-600">
                    {negative ? 'Cannot be negative' : `Exceeds max (${maxPoints})`}
                  </span>
                )}
              </span>
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500">
                Feedback
              </span>
              <textarea
                value={feedback}
                disabled={grade.isPending}
                onChange={(e) => setFeedback(e.target.value)}
                rows={4}
                maxLength={8000}
                placeholder="Comments visible to the student / parent on publish."
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-campus-400 focus:outline-none"
              />
            </label>

            {sub.grade && (
              <div className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600">
                Graded{' '}
                {new Date(sub.grade.gradedAt).toLocaleString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
                {sub.grade.isPublished
                  ? sub.grade.publishedAt &&
                    ' · published ' +
                      new Date(sub.grade.publishedAt).toLocaleString(undefined, {
                        month: 'short',
                        day: 'numeric',
                      })
                  : ' · not yet published'}
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              {sub.grade && (
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      if (sub.grade!.isPublished) {
                        await unpublish.mutateAsync({
                          gradeId: sub.grade!.id,
                          assignmentId,
                          classId: sub.classId,
                          submissionId: sub.id,
                        });
                        toast('Grade unpublished', 'success');
                      } else {
                        await publish.mutateAsync({
                          gradeId: sub.grade!.id,
                          assignmentId,
                          classId: sub.classId,
                          submissionId: sub.id,
                        });
                        toast('Grade published', 'success');
                      }
                    } catch (e) {
                      toast(e instanceof Error ? e.message : 'Failed', 'error');
                    }
                  }}
                  disabled={publish.isPending || unpublish.isPending || grade.isPending}
                  className={cn(
                    'rounded-lg px-3 py-2 text-sm font-medium',
                    sub.grade.isPublished
                      ? 'border border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
                      : 'bg-campus-50 text-campus-700 hover:bg-campus-100',
                    'disabled:cursor-not-allowed disabled:opacity-60',
                  )}
                >
                  {(publish.isPending || unpublish.isPending) && (
                    <LoadingSpinner size="sm" className="mr-2 inline-block" />
                  )}
                  {sub.grade.isPublished ? 'Unpublish' : 'Publish'}
                </button>
              )}
              <button
                type="button"
                disabled={!canSave}
                onClick={async () => {
                  if (!canSave) return;
                  try {
                    await grade.mutateAsync({
                      submissionId: sub.id,
                      payload: {
                        gradeValue: numeric,
                        feedback: feedback.trim() || undefined,
                        publish: sub.grade?.isPublished === true ? true : undefined,
                      },
                      assignmentId,
                      classId: sub.classId,
                    });
                    toast('Grade saved', 'success');
                    if (assignmentId) router.push(`/assignments/${assignmentId}/submissions`);
                  } catch (e) {
                    toast(e instanceof Error ? e.message : 'Failed to save', 'error');
                  }
                }}
                className="inline-flex items-center gap-2 rounded-lg bg-campus-700 px-4 py-2 text-sm font-semibold text-white shadow-card hover:bg-campus-600 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {grade.isPending && (
                  <LoadingSpinner size="sm" className="border-white/40 border-t-white" />
                )}
                {sub.grade ? 'Update grade' : 'Save grade'}
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
