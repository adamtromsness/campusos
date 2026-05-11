'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  useCancelAssignment,
  useCheckIn,
  useCheckOut,
  useSubAssignments,
  useSubJobs,
} from '@/hooks/use-substitutes';
import {
  ASSIGNMENT_STATUS_LABEL,
  ASSIGNMENT_STATUS_PILL,
  JOB_STATUS_LABEL,
  JOB_STATUS_PILL,
  JOB_TYPE_LABEL,
  NOTIFICATION_RESPONSE_LABEL,
  NOTIFICATION_RESPONSE_PILL,
  NOTIFICATION_TIER_LABEL,
  formatDate,
  formatDateTime,
  formatRelativeWindow,
} from '@/lib/substitutes-format';
import type { SubAssignmentDto, SubJobPostingDto, SubJobStatus } from '@/lib/types';

export default function CoverageDashboardPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin =
    !!user && hasAnyPermission(user, ['sch-001:admin', 'sch-004:write', 'sch-004:admin']);
  const jobs = useSubJobs({}, !!user);
  const assignments = useSubAssignments({}, !!user);
  const checkIn = useCheckIn();
  const checkOut = useCheckOut();
  const cancel = useCancelAssignment();
  const [filter, setFilter] = useState<'ALL' | SubJobStatus>('ALL');
  const [cancelTarget, setCancelTarget] = useState<SubAssignmentDto | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const { toast } = useToast();

  const filteredJobs = useMemo(() => {
    const rows = jobs.data ?? [];
    if (filter === 'ALL') return rows;
    return rows.filter((j) => j.status === filter);
  }, [jobs.data, filter]);

  const assignmentsByJob = useMemo(() => {
    const map = new Map<string, SubAssignmentDto>();
    (assignments.data ?? []).forEach((a) => map.set(a.jobId, a));
    return map;
  }, [assignments.data]);

  const counts = {
    OPEN: (jobs.data ?? []).filter((j) => j.status === 'OPEN').length,
    FILLED: (jobs.data ?? []).filter((j) => j.status === 'FILLED').length,
    UNFILLED: (jobs.data ?? []).filter((j) => j.status === 'UNFILLED').length,
  };

  if (!user) return null;
  if (jobs.isLoading) return <LoadingSpinner />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Coverage Dashboard"
        description="Today's substitute jobs by status, with assignment check-in/out tracking and session notes."
        actions={
          isAdmin ? (
            <Link
              href="/substitutes/jobs/new"
              className="rounded-lg bg-campus-600 px-4 py-2 text-sm font-medium text-white hover:bg-campus-700"
            >
              Post job
            </Link>
          ) : undefined
        }
      />

      <div className="grid grid-cols-3 gap-3">
        <Stat label="Open jobs" value={counts.OPEN} accent="amber" />
        <Stat label="Filled" value={counts.FILLED} accent="emerald" />
        <Stat label="Unfilled" value={counts.UNFILLED} accent="rose" />
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <Chip
          label="All"
          count={jobs.data?.length ?? 0}
          active={filter === 'ALL'}
          onClick={() => setFilter('ALL')}
        />
        {(['OPEN', 'FILLED', 'CANCELLED', 'EXPIRED', 'UNFILLED'] as SubJobStatus[]).map((s) => (
          <Chip
            key={s}
            label={JOB_STATUS_LABEL[s]}
            count={(jobs.data ?? []).filter((j) => j.status === s).length}
            active={filter === s}
            onClick={() => setFilter(s)}
          />
        ))}
      </div>

      {filteredJobs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">
          No jobs in this view.
        </div>
      ) : (
        <ul className="space-y-3">
          {filteredJobs.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              assignment={assignmentsByJob.get(job.id) ?? null}
              isAdmin={isAdmin}
              onCheckIn={async (id) => {
                try {
                  await checkIn.mutateAsync(id);
                  toast('Checked in', 'success');
                } catch (e) {
                  toast(`Could not check in: ${(e as Error).message}`, 'error');
                }
              }}
              onCheckOut={async (id) => {
                try {
                  await checkOut.mutateAsync(id);
                  toast('Checked out', 'success');
                } catch (e) {
                  toast(`Could not check out: ${(e as Error).message}`, 'error');
                }
              }}
              onCancelAssignment={(a) => {
                setCancelTarget(a);
                setCancelReason('');
              }}
            />
          ))}
        </ul>
      )}

      {cancelTarget && (
        <Modal
          open={!!cancelTarget}
          onClose={() => setCancelTarget(null)}
          title="Cancel assignment (school-side)"
          footer={
            <>
              <button
                type="button"
                onClick={() => setCancelTarget(null)}
                className="rounded-md px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
              >
                Keep
              </button>
              <button
                type="button"
                disabled={cancel.isPending || !cancelReason.trim()}
                onClick={async () => {
                  if (!cancelTarget) return;
                  try {
                    await cancel.mutateAsync({
                      id: cancelTarget.id,
                      payload: {
                        cancelledByType: 'SCHOOL',
                        cancellationReason: cancelReason,
                      },
                    });
                    toast('Assignment cancelled', 'info');
                    setCancelTarget(null);
                  } catch (e) {
                    toast(`Could not cancel: ${(e as Error).message}`, 'error');
                  }
                }}
                className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-50"
              >
                Cancel
              </button>
            </>
          }
        >
          <p className="text-sm text-gray-700 mb-3">
            School-initiated cancellations don&apos;t count as late-cancellations against the
            substitute&apos;s policy record.
          </p>
          <label className="block text-sm font-medium text-gray-700 mb-1">Reason</label>
          <textarea
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            rows={3}
            className="w-full rounded-md border border-gray-300 p-2 text-sm"
          />
        </Modal>
      )}
    </div>
  );
}

function Chip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-full px-3 py-1 text-xs font-medium ring-1 transition-colors',
        active
          ? 'bg-campus-600 text-white ring-campus-600'
          : 'bg-white text-gray-700 ring-gray-300 hover:bg-gray-50',
      )}
    >
      {label} ({count})
    </button>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent: 'amber' | 'emerald' | 'rose';
}) {
  const accents = {
    amber: 'text-amber-700',
    emerald: 'text-emerald-700',
    rose: 'text-rose-700',
  };
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className={cn('mt-1 text-2xl font-bold', accents[accent])}>{value}</div>
    </div>
  );
}

function JobRow({
  job,
  assignment,
  isAdmin,
  onCheckIn,
  onCheckOut,
  onCancelAssignment,
}: {
  job: SubJobPostingDto;
  assignment: SubAssignmentDto | null;
  isAdmin: boolean;
  onCheckIn: (id: string) => Promise<void>;
  onCheckOut: (id: string) => Promise<void>;
  onCancelAssignment: (a: SubAssignmentDto) => void;
}) {
  return (
    <li className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span
              className={cn(
                'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
                JOB_STATUS_PILL[job.status],
              )}
            >
              {JOB_STATUS_LABEL[job.status]}
            </span>
            <span className="text-xs text-gray-500">
              Tier: {NOTIFICATION_TIER_LABEL[job.notificationTier]}
            </span>
          </div>
          <p className="font-semibold text-gray-900">
            {formatDate(job.jobDate)} • {job.startTime.slice(0, 5)}–{job.endTime.slice(0, 5)} •{' '}
            {JOB_TYPE_LABEL[job.jobType]}
          </p>
          <p className="text-sm text-gray-600">
            Covering {job.absentTeacherName ?? '—'}
            {job.gradeLevel ? ` • Grade ${job.gradeLevel}` : ''}
            {job.subject ? ` • ${job.subject}` : ''}
            {job.classes.length > 0 ? ` • ${job.classes.length} classes` : ''}
          </p>
        </div>
      </div>

      {/* Notifications fan-out — admin/staff view */}
      {isAdmin && job.notifications.length > 0 && (
        <details className="mt-3">
          <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-700">
            Notifications ({job.notifications.length})
          </summary>
          <ul className="mt-2 grid grid-cols-2 gap-2 text-xs">
            {job.notifications.map((n) => (
              <li key={n.id} className="flex items-center gap-2 rounded-md bg-gray-50 px-2 py-1">
                <span className="font-mono text-gray-600">{n.substituteId.slice(0, 8)}</span>
                <span
                  className={cn(
                    'inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                    NOTIFICATION_RESPONSE_PILL[n.response],
                  )}
                >
                  {NOTIFICATION_RESPONSE_LABEL[n.response]}
                </span>
                {n.response === 'PENDING' && (
                  <span className="text-gray-500">
                    {formatRelativeWindow(n.acceptanceWindowExpiresAt)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Assignment lifecycle controls */}
      {assignment && (
        <div className="mt-3 border-t border-gray-100 pt-3 flex items-center gap-3 flex-wrap">
          <span
            className={cn(
              'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
              ASSIGNMENT_STATUS_PILL[assignment.status],
            )}
          >
            {ASSIGNMENT_STATUS_LABEL[assignment.status]}
          </span>
          {assignment.checkInAt && (
            <span className="text-xs text-gray-500">
              Checked in {formatDateTime(assignment.checkInAt)}
            </span>
          )}
          {assignment.checkOutAt && (
            <span className="text-xs text-gray-500">
              Checked out {formatDateTime(assignment.checkOutAt)}
            </span>
          )}
          {isAdmin && assignment.status === 'CONFIRMED' && (
            <button
              type="button"
              onClick={() => onCheckIn(assignment.id)}
              className="text-xs font-medium text-emerald-600 hover:text-emerald-700"
            >
              Check in
            </button>
          )}
          {isAdmin && assignment.status === 'CHECKED_IN' && (
            <button
              type="button"
              onClick={() => onCheckOut(assignment.id)}
              className="text-xs font-medium text-emerald-600 hover:text-emerald-700"
            >
              Check out
            </button>
          )}
          {isAdmin && (assignment.status === 'CONFIRMED' || assignment.status === 'CHECKED_IN') && (
            <button
              type="button"
              onClick={() => onCancelAssignment(assignment)}
              className="text-xs font-medium text-rose-600 hover:text-rose-700"
            >
              Cancel
            </button>
          )}
          {assignment.status === 'CHECKED_OUT' && (
            <Link
              href={`/substitutes/ratings?assignmentId=${assignment.id}`}
              className="text-xs font-medium text-campus-600 hover:text-campus-700"
            >
              Rate / view notes →
            </Link>
          )}
        </div>
      )}
    </li>
  );
}
