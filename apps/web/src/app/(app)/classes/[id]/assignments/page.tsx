'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useClass } from '@/hooks/use-attendance';
import {
  useAssignments,
  useDeleteAssignment,
  useUpsertCategories,
  useCategories,
} from '@/hooks/use-classroom';
import { ClassTabs } from '@/components/classroom/ClassTabs';
import { CategoryWeightModal } from '@/components/classroom/CategoryWeightModal';
import { PageHeader } from '@/components/ui/PageHeader';
import { LoadingSpinner, PageLoader } from '@/components/ui/LoadingSpinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import type { AssignmentDto, AssignmentTypeCategory } from '@/lib/types';

const TYPE_FILTERS: { value: 'ALL' | AssignmentTypeCategory; label: string }[] = [
  { value: 'ALL', label: 'All types' },
  { value: 'HOMEWORK', label: 'Homework' },
  { value: 'QUIZ', label: 'Quiz' },
  { value: 'TEST', label: 'Test' },
  { value: 'PROJECT', label: 'Project' },
  { value: 'CLASSWORK', label: 'Classwork' },
];

export default function ClassAssignmentsPage() {
  const params = useParams<{ id: string }>();
  const classId = params?.id ?? '';
  const { toast } = useToast();

  const classQuery = useClass(classId);
  // Teachers/admins want drafts visible alongside published assignments.
  const assignmentsQuery = useAssignments(classId, { includeUnpublished: true });
  const categoriesQuery = useCategories(classId);
  const upsertCategories = useUpsertCategories(classId);

  const [typeFilter, setTypeFilter] = useState<'ALL' | AssignmentTypeCategory>('ALL');
  const [pendingDelete, setPendingDelete] = useState<AssignmentDto | null>(null);
  const [categoryModalOpen, setCategoryModalOpen] = useState(false);

  const assignments = assignmentsQuery.data ?? [];
  const filtered = useMemo(() => {
    if (typeFilter === 'ALL') return assignments;
    return assignments.filter((a) => a.assignmentType.category === typeFilter);
  }, [assignments, typeFilter]);

  if (classQuery.isLoading || !classQuery.data) {
    return <PageLoader label="Loading class…" />;
  }
  const cls = classQuery.data;
  const teacherName = cls.teachers[0]?.fullName ?? 'Unassigned';

  return (
    <div className="mx-auto max-w-5xl">
      <Link
        href="/dashboard"
        className="mb-3 inline-flex items-center gap-1 text-sm text-campus-600 hover:text-campus-700"
      >
        ← Back to dashboard
      </Link>

      <PageHeader
        title={cls.course.name}
        description={`Period ${cls.sectionCode} · ${teacherName}${cls.room ? ` · Room ${cls.room}` : ''}`}
        actions={
          <Link
            href={`/classes/${classId}/assignments/new`}
            className="inline-flex items-center gap-2 rounded-lg bg-campus-700 px-4 py-2 text-sm font-semibold text-white shadow-card transition hover:bg-campus-600"
          >
            + New assignment
          </Link>
        }
      />

      <ClassTabs classId={classId} active="assignments" />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1 rounded-lg border border-gray-200 bg-white p-1">
          {TYPE_FILTERS.map((opt) => {
            const active = opt.value === typeFilter;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setTypeFilter(opt.value)}
                className={cn(
                  'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                  active ? 'bg-campus-600 text-white' : 'text-gray-600 hover:bg-gray-50',
                )}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => setCategoryModalOpen(true)}
          className="text-sm font-medium text-campus-600 hover:text-campus-700"
        >
          Manage categories
        </button>
      </div>

      {assignmentsQuery.isLoading ? (
        <div className="flex items-center gap-2 px-1 py-6 text-sm text-gray-500">
          <LoadingSpinner size="sm" />
          Loading assignments…
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          title={typeFilter === 'ALL' ? 'No assignments yet' : 'No matching assignments'}
          description={
            typeFilter === 'ALL'
              ? 'Create the first assignment to start grading.'
              : 'Try clearing the filter or creating a new assignment.'
          }
        />
      ) : (
        <AssignmentTable rows={filtered} classId={classId} onRequestDelete={setPendingDelete} />
      )}

      <CategoryWeightModal
        open={categoryModalOpen}
        classId={classId}
        categories={categoriesQuery.data ?? []}
        loading={categoriesQuery.isLoading}
        submitting={upsertCategories.isPending}
        onCancel={() => setCategoryModalOpen(false)}
        onSubmit={async (entries) => {
          try {
            await upsertCategories.mutateAsync(entries);
            toast('Category weights updated', 'success');
            setCategoryModalOpen(false);
          } catch (e) {
            const msg = e instanceof Error ? e.message : 'Failed to save weights';
            toast(msg, 'error');
          }
        }}
      />

      <DeleteAssignmentModal
        assignment={pendingDelete}
        classId={classId}
        onClose={() => setPendingDelete(null)}
      />
    </div>
  );
}

interface AssignmentTableProps {
  rows: AssignmentDto[];
  classId: string;
  onRequestDelete: (a: AssignmentDto) => void;
}

function AssignmentTable({ rows, classId, onRequestDelete }: AssignmentTableProps) {
  return (
    <div className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-card">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-xs font-medium uppercase tracking-wide text-gray-500">
          <tr>
            <th className="px-4 py-3 text-left">Title</th>
            <th className="px-4 py-3 text-left">Type</th>
            <th className="px-4 py-3 text-left">Category</th>
            <th className="px-4 py-3 text-left">Due</th>
            <th className="px-4 py-3 text-right">Points</th>
            <th className="px-4 py-3 text-left">Status</th>
            <th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.id} className="border-t border-gray-100 hover:bg-gray-50">
              <td className="px-4 py-3">
                <Link
                  href={`/classes/${classId}/assignments/${a.id}/edit`}
                  className="font-medium text-gray-900 hover:text-campus-700"
                >
                  {a.title}
                </Link>
                {a.isExtraCredit && (
                  <span className="ml-2 inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                    Extra credit
                  </span>
                )}
              </td>
              <td className="px-4 py-3 text-gray-600">{a.assignmentType.name}</td>
              <td className="px-4 py-3 text-gray-600">
                {a.category ? (
                  <>
                    {a.category.name}{' '}
                    <span className="text-xs text-gray-400">({a.category.weight}%)</span>
                  </>
                ) : (
                  <span className="text-xs text-gray-400">— uncategorised</span>
                )}
              </td>
              <td className="px-4 py-3 text-gray-600">{formatDue(a.dueDate)}</td>
              <td className="px-4 py-3 text-right tabular-nums text-gray-700">{a.maxPoints}</td>
              <td className="px-4 py-3">
                <PublishedBadge isPublished={a.isPublished} />
              </td>
              <td className="px-4 py-3 text-right">
                <button
                  type="button"
                  onClick={() => onRequestDelete(a)}
                  className="text-xs font-medium text-red-600 hover:text-red-700"
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PublishedBadge({ isPublished }: { isPublished: boolean }) {
  return isPublished ? (
    <span className="inline-flex items-center rounded-full bg-status-present-soft px-2.5 py-0.5 text-xs font-medium text-status-present-text">
      Published
    </span>
  ) : (
    <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-600">
      Draft
    </span>
  );
}

interface DeleteAssignmentModalProps {
  assignment: AssignmentDto | null;
  classId: string;
  onClose: () => void;
}

function DeleteAssignmentModal({ assignment, classId, onClose }: DeleteAssignmentModalProps) {
  const { toast } = useToast();
  const remove = useDeleteAssignment(assignment?.id ?? '', classId);
  if (!assignment) return null;
  return (
    <Modal
      open={!!assignment}
      onClose={remove.isPending ? () => {} : onClose}
      title="Delete this assignment?"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={remove.isPending}
            className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={remove.isPending}
            onClick={async () => {
              try {
                await remove.mutateAsync();
                toast('Assignment deleted', 'success');
                onClose();
              } catch (e) {
                const msg = e instanceof Error ? e.message : 'Failed to delete';
                toast(msg, 'error');
              }
            }}
            className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-card hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {remove.isPending && (
              <LoadingSpinner size="sm" className="border-white/40 border-t-white" />
            )}
            Delete assignment
          </button>
        </>
      }
    >
      <p className="text-sm text-gray-700">
        <span className="font-medium">{assignment.title}</span> will be soft-deleted. Existing
        submissions and grades stay attached but the assignment will no longer appear in lists.
      </p>
    </Modal>
  );
}

function formatDue(dueDate: string | null): string {
  if (!dueDate) return '—';
  const d = new Date(dueDate);
  if (Number.isNaN(d.getTime())) return dueDate;
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}
