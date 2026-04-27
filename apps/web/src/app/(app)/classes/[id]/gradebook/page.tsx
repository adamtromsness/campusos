'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { useClass } from '@/hooks/use-attendance';
import {
  useAssignments,
  useClassGradebook,
  useGradeSubmission,
  usePublishAllGrades,
  usePublishGrade,
  useUnpublishGrade,
} from '@/hooks/use-classroom';
import { ClassTabs } from '@/components/classroom/ClassTabs';
import {
  GradeCellEditor,
  deriveLetter,
  gradeTier,
  type GradeCellState,
} from '@/components/classroom/GradeCellEditor';
import { ProgressNoteModal } from '@/components/classroom/ProgressNoteModal';
import { PageHeader } from '@/components/ui/PageHeader';
import { LoadingSpinner, PageLoader } from '@/components/ui/LoadingSpinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import type {
  AssignmentDto,
  GradebookClassRowDto,
  SubmissionDto,
  TeacherSubmissionListDto,
} from '@/lib/types';

type SubmissionByStudent = Map<string, SubmissionDto>;
// Map<assignmentId, Map<studentId, submission>>
type SubmissionLookup = Map<string, SubmissionByStudent>;

export default function ClassGradebookPage() {
  const params = useParams<{ id: string }>();
  const classId = params?.id ?? '';
  const { toast } = useToast();

  const classQuery = useClass(classId);
  const assignmentsQuery = useAssignments(classId, { includeUnpublished: true });
  const gradebookQuery = useClassGradebook(classId);

  const assignments = useMemo(
    () => (assignmentsQuery.data ?? []).filter((a) => a.isPublished),
    [assignmentsQuery.data],
  );

  const [activeCell, setActiveCell] = useState<{ studentId: string; assignmentId: string } | null>(
    null,
  );
  const [progressNoteStudentId, setProgressNoteStudentId] = useState<string | null>(null);

  // Close the editor on Escape, even if focus is outside the input.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setActiveCell(null);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  if (classQuery.isLoading || !classQuery.data) {
    return <PageLoader label="Loading class…" />;
  }
  const cls = classQuery.data;
  const teacherName = cls.teachers[0]?.fullName ?? 'Unassigned';

  return (
    <div className="mx-auto max-w-6xl">
      <Link
        href="/dashboard"
        className="mb-3 inline-flex items-center gap-1 text-sm text-campus-600 hover:text-campus-700"
      >
        ← Back to dashboard
      </Link>

      <PageHeader
        title={cls.course.name}
        description={`Period ${cls.sectionCode} · ${teacherName}${cls.room ? ` · Room ${cls.room}` : ''}`}
      />

      <ClassTabs classId={classId} active="gradebook" />

      <p className="mb-3 text-xs text-gray-500">
        Click a cell to enter or edit a grade. Snapshots refresh asynchronously after each
        publish.
      </p>

      {assignmentsQuery.isLoading || gradebookQuery.isLoading ? (
        <div className="flex items-center gap-2 px-1 py-6 text-sm text-gray-500">
          <LoadingSpinner size="sm" />
          Loading gradebook…
        </div>
      ) : assignments.length === 0 ? (
        <EmptyState
          title="No published assignments"
          description="Publish an assignment to start grading."
        />
      ) : (
        <GradebookGrid
          classId={classId}
          assignments={assignments}
          rows={gradebookQuery.data?.rows ?? []}
          activeCell={activeCell}
          onActivate={setActiveCell}
          onClearActive={() => setActiveCell(null)}
          onOpenProgressNote={setProgressNoteStudentId}
          onToast={toast}
        />
      )}

      <ProgressNoteModal
        classId={classId}
        termId={cls.term?.id ?? null}
        studentId={progressNoteStudentId}
        students={(gradebookQuery.data?.rows ?? []).map((r) => r.student)}
        onClose={() => setProgressNoteStudentId(null)}
      />
    </div>
  );
}

interface GradebookGridProps {
  classId: string;
  assignments: AssignmentDto[];
  rows: GradebookClassRowDto[];
  activeCell: { studentId: string; assignmentId: string } | null;
  onActivate: (cell: { studentId: string; assignmentId: string }) => void;
  onClearActive: () => void;
  onOpenProgressNote: (studentId: string) => void;
  onToast: (msg: string, kind?: 'success' | 'error') => void;
}

function GradebookGrid({
  classId,
  assignments,
  rows,
  activeCell,
  onActivate,
  onClearActive,
  onOpenProgressNote,
  onToast,
}: GradebookGridProps) {
  // One submissions query per assignment via useQueries — works with a
  // dynamic-length array of queries without violating rules-of-hooks.
  const submissionResults = useQueries({
    queries: assignments.map((a) => ({
      queryKey: ['classroom', 'submissions', 'assignment', a.id] as const,
      queryFn: () =>
        apiFetch<TeacherSubmissionListDto>(`/api/v1/assignments/${a.id}/submissions`),
      enabled: !!a.id,
    })),
  });
  const lookup: SubmissionLookup = new Map();
  for (let i = 0; i < assignments.length; i++) {
    const list = submissionResults[i]?.data;
    if (!list) continue;
    const inner: SubmissionByStudent = new Map();
    for (const s of list.submissions) inner.set(s.student.id, s);
    lookup.set(assignments[i]!.id, inner);
  }
  const stats: Record<string, TeacherSubmissionListDto | null> = {};
  for (let i = 0; i < assignments.length; i++) {
    stats[assignments[i]!.id] = submissionResults[i]?.data ?? null;
  }

  const publishAll = usePublishAllGrades(classId);

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No students enrolled"
        description="Enroll students in this class to see them in the gradebook."
      />
    );
  }

  return (
    <div className="overflow-x-auto rounded-card border border-gray-200 bg-white shadow-card">
      <table className="min-w-full text-sm">
        <thead className="bg-gray-50 text-xs">
          <tr>
            <th
              scope="col"
              className="sticky left-0 z-10 bg-gray-50 px-4 py-3 text-left font-medium uppercase tracking-wide text-gray-500"
            >
              Student
            </th>
            {assignments.map((a) => {
              const stat = stats[a.id];
              return (
                <th
                  key={a.id}
                  scope="col"
                  className="min-w-[160px] border-l border-gray-100 px-3 py-2 text-left align-top"
                >
                  <Link
                    href={`/assignments/${a.id}/submissions`}
                    className="block text-xs font-semibold text-gray-900 hover:text-campus-700"
                    title={a.title}
                  >
                    <span className="line-clamp-2">{a.title}</span>
                  </Link>
                  <p className="mt-0.5 text-[11px] font-normal text-gray-500">
                    {a.assignmentType.name} · {a.maxPoints} pts
                    {a.category ? ` · ${a.category.name}` : ''}
                  </p>
                  <div className="mt-1 flex items-center gap-2 text-[11px] font-normal text-gray-500">
                    {stat ? (
                      <span>
                        {stat.publishedCount}/{stat.gradedCount} pub · {stat.submittedCount}/
                        {stat.rosterSize} sub
                      </span>
                    ) : (
                      <span>—</span>
                    )}
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          const result = await publishAll.mutateAsync(a.id);
                          onToast(
                            `Published ${result.publishedCount} grade${result.publishedCount === 1 ? '' : 's'}`,
                            'success',
                          );
                        } catch (e) {
                          onToast(e instanceof Error ? e.message : 'Failed', 'error');
                        }
                      }}
                      disabled={publishAll.isPending}
                      className="rounded-md bg-campus-50 px-1.5 py-0.5 text-[11px] font-medium text-campus-700 hover:bg-campus-100 disabled:opacity-50"
                      title="Publish every drafted grade for this assignment"
                    >
                      Publish all
                    </button>
                  </div>
                </th>
              );
            })}
            <th
              scope="col"
              className="min-w-[120px] border-l border-gray-100 px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500"
            >
              Average
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.student.id} className="border-t border-gray-100 hover:bg-gray-50/40">
              <td className="sticky left-0 z-[5] bg-white px-4 py-2 align-top">
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-gray-900">{row.student.fullName}</span>
                  {row.student.studentNumber && (
                    <span className="text-[11px] text-gray-400">#{row.student.studentNumber}</span>
                  )}
                  <button
                    type="button"
                    onClick={() => onOpenProgressNote(row.student.id)}
                    className="mt-1 self-start text-[11px] font-medium text-campus-600 hover:text-campus-700"
                  >
                    Progress note…
                  </button>
                </div>
              </td>
              {assignments.map((a) => {
                const sub = lookup.get(a.id)?.get(row.student.id) ?? null;
                const isActive =
                  activeCell?.assignmentId === a.id && activeCell?.studentId === row.student.id;
                return (
                  <GradeCell
                    key={a.id + '|' + row.student.id}
                    classId={classId}
                    assignment={a}
                    submission={sub}
                    isActive={isActive}
                    onActivate={() => onActivate({ studentId: row.student.id, assignmentId: a.id })}
                    onClose={onClearActive}
                    onToast={onToast}
                  />
                );
              })}
              <td className="border-l border-gray-100 px-4 py-2 align-top text-right">
                <SnapshotCell row={row} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SnapshotCell({ row }: { row: GradebookClassRowDto }) {
  const snap = row.snapshot;
  if (!snap || snap.currentAverage === null) {
    return <span className="text-xs text-gray-400">—</span>;
  }
  return (
    <div className="flex flex-col items-end">
      <span className="text-sm font-semibold tabular-nums text-gray-900">
        {snap.currentAverage.toFixed(2)}%
      </span>
      <span className="text-[11px] text-gray-500">
        {snap.letterGrade ?? deriveLetter(snap.currentAverage)} · {snap.assignmentsGraded}/
        {snap.assignmentsTotal}
      </span>
    </div>
  );
}

interface GradeCellProps {
  classId: string;
  assignment: AssignmentDto;
  submission: SubmissionDto | null;
  isActive: boolean;
  onActivate: () => void;
  onClose: () => void;
  onToast: (msg: string, kind?: 'success' | 'error') => void;
}

function GradeCell({
  classId,
  assignment,
  submission,
  isActive,
  onActivate,
  onClose,
  onToast,
}: GradeCellProps) {
  const grade = useGradeSubmission();
  const publish = usePublishGrade();
  const unpublish = useUnpublishGrade();

  const grad = submission?.grade ?? null;
  const pct = grad ? (grad.gradeValue / assignment.maxPoints) * 100 : null;
  const tier = gradeTier(pct);
  const tierClasses: Record<typeof tier, string> = {
    good: 'bg-status-present-soft/60 text-status-present-text',
    ok: 'bg-status-tardy-soft/60 text-status-tardy-text',
    low: 'bg-status-absent-soft/60 text-status-absent-text',
    none: 'bg-gray-50 text-gray-500',
  };

  const cellState: GradeCellState = {
    hasGrade: !!grad,
    gradeValue: grad ? grad.gradeValue : null,
    letterGrade: grad ? grad.letterGrade : null,
    feedback: grad ? grad.feedback : null,
    isPublished: !!grad?.isPublished,
    isSubmitted: !!submission && submission.status !== 'NOT_STARTED',
    maxPoints: assignment.maxPoints,
    isExtraCredit: assignment.isExtraCredit,
  };

  return (
    <td className="relative border-l border-gray-100 px-1 py-1 align-top">
      <button
        type="button"
        onClick={onActivate}
        className={cn(
          'flex w-full flex-col items-stretch rounded-md px-2 py-1.5 text-left transition-colors',
          tierClasses[tier],
          isActive && 'ring-2 ring-campus-400',
          'hover:brightness-95',
        )}
      >
        {grad ? (
          <>
            <span className="text-sm font-semibold tabular-nums">
              {grad.gradeValue}
              <span className="ml-0.5 text-[11px] font-normal opacity-75">/{assignment.maxPoints}</span>
            </span>
            <span className="flex items-center gap-1 text-[11px] font-normal opacity-75">
              {pct !== null ? pct.toFixed(0) + '%' : ''}
              {!grad.isPublished && (
                <span className="rounded-sm bg-white/70 px-1 text-[10px] font-medium text-gray-700">
                  draft
                </span>
              )}
            </span>
          </>
        ) : cellState.isSubmitted ? (
          <>
            <span className="text-sm font-medium">—</span>
            <span className="text-[11px] opacity-75">submitted</span>
          </>
        ) : (
          <>
            <span className="text-sm">—</span>
            <span className="text-[11px] opacity-75">not started</span>
          </>
        )}
      </button>

      {isActive && (
        <GradeCellEditor
          state={cellState}
          saving={grade.isPending}
          publishing={publish.isPending || unpublish.isPending}
          onSave={async (gradeValue, feedback) => {
            // Need a real submissionId to call POST /submissions/:id/grade.
            // The roster placeholder has id='' for students who never submitted.
            // Out-of-scope this step: a "grade without submission" path
            // (would use the batch-grade endpoint for a single student).
            if (!submission || !submission.id) {
              onToast(
                'No submission yet — student must submit before a grade can be entered.',
                'error',
              );
              return;
            }
            try {
              await grade.mutateAsync({
                submissionId: submission.id,
                payload: {
                  gradeValue,
                  feedback: feedback || undefined,
                  // keep the published-state — single grade endpoint supports
                  // optional publish: omit means leave as-is for already-saved grades.
                  publish: grad?.isPublished === true ? true : undefined,
                },
                assignmentId: assignment.id,
                classId,
              });
              onToast('Grade saved', 'success');
              onClose();
            } catch (e) {
              onToast(e instanceof Error ? e.message : 'Failed to save grade', 'error');
            }
          }}
          onTogglePublish={async () => {
            if (!grad) return;
            try {
              if (grad.isPublished) {
                await unpublish.mutateAsync({
                  gradeId: grad.id,
                  assignmentId: assignment.id,
                  classId,
                  submissionId: submission?.id,
                });
                onToast('Grade unpublished', 'success');
              } else {
                await publish.mutateAsync({
                  gradeId: grad.id,
                  assignmentId: assignment.id,
                  classId,
                  submissionId: submission?.id,
                });
                onToast('Grade published', 'success');
              }
            } catch (e) {
              onToast(e instanceof Error ? e.message : 'Failed', 'error');
            }
          }}
          onClose={onClose}
        />
      )}
    </td>
  );
}
