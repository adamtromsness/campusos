'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import { useAuthStore } from '@/lib/auth-store';
import {
  useAcceptJob,
  useCancelAssignment,
  useDeclineJob,
  useMySubstituteProfile,
  useSubAssignments,
  useSubJobs,
} from '@/hooks/use-substitutes';
import {
  ASSIGNMENT_STATUS_LABEL,
  ASSIGNMENT_STATUS_PILL,
  JOB_TYPE_LABEL,
  formatDate,
  formatDateTime,
  formatRating,
  formatRelativeWindow,
} from '@/lib/substitutes-format';
import type { SubAssignmentDto, SubJobPostingDto } from '@/lib/types';

export default function SubstituteDashboardPage() {
  const user = useAuthStore((s) => s.user);
  const profile = useMySubstituteProfile(!!user);
  const jobs = useSubJobs({}, !!user);
  const assignments = useSubAssignments({}, !!user);
  const accept = useAcceptJob();
  const decline = useDeclineJob();
  const cancel = useCancelAssignment();
  const { toast } = useToast();
  const [cancelling, setCancelling] = useState<SubAssignmentDto | null>(null);
  const [cancelReason, setCancelReason] = useState('');

  // Open notifications: my notifications still PENDING + window not expired,
  // for jobs still OPEN.
  const openNotifications = useMemo(() => {
    if (!profile.data || !jobs.data) return [];
    const subId = profile.data.id;
    return jobs.data
      .filter((j) => j.status === 'OPEN')
      .map((j) => {
        const myNotif = j.notifications.find(
          (n) => n.substituteId === subId && n.response === 'PENDING',
        );
        return myNotif ? { job: j, notification: myNotif } : null;
      })
      .filter(
        (
          x,
        ): x is {
          job: SubJobPostingDto;
          notification: SubJobPostingDto['notifications'][number];
        } => x !== null,
      );
  }, [profile.data, jobs.data]);

  // Upcoming = CONFIRMED + CHECKED_IN, my own
  const upcoming = useMemo(() => {
    return (assignments.data ?? []).filter(
      (a) => a.status === 'CONFIRMED' || a.status === 'CHECKED_IN',
    );
  }, [assignments.data]);
  const past = useMemo(() => {
    return (assignments.data ?? []).filter(
      (a) => a.status === 'CHECKED_OUT' || a.status === 'CANCELLED' || a.status === 'NO_SHOW',
    );
  }, [assignments.data]);

  if (!user) return null;
  if (profile.isLoading) return <LoadingSpinner />;

  const me = profile.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Substitute Dashboard"
        description={
          me
            ? `${me.displayName ?? 'Substitute'} • ${me.totalAssignments} completed assignments • ${formatRating(me.overallRating)}`
            : 'Set up your profile to start receiving job offers'
        }
        actions={
          <Link
            href="/substitutes/profile"
            className="text-sm font-medium text-campus-600 hover:text-campus-700"
          >
            Edit profile →
          </Link>
        }
      />

      {!me ? (
        <EmptyState
          title="No substitute profile yet"
          description="Set up your profile to appear in the marketplace and receive job offers."
          action={
            <Link
              href="/substitutes/profile"
              className="inline-block rounded-lg bg-campus-600 px-4 py-2 text-sm font-medium text-white hover:bg-campus-700"
            >
              Set up profile
            </Link>
          }
        />
      ) : (
        <>
          <Section title={`Open job offers (${openNotifications.length})`}>
            {openNotifications.length === 0 ? (
              <p className="text-sm text-gray-500">
                No open offers. Update your availability or preferences to receive more.
              </p>
            ) : (
              <div className="space-y-3">
                {openNotifications.map(({ job, notification }) => (
                  <div
                    key={job.id}
                    className="rounded-xl border border-amber-200 bg-amber-50 p-4 shadow-sm"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-semibold text-gray-900">
                          {formatDate(job.jobDate)} • {job.startTime.slice(0, 5)}–
                          {job.endTime.slice(0, 5)}
                        </p>
                        <p className="text-sm text-gray-600">
                          {JOB_TYPE_LABEL[job.jobType]}
                          {job.gradeLevel ? ` • Grade ${job.gradeLevel}` : ''}
                          {job.subject ? ` • ${job.subject}` : ''}
                        </p>
                        <p className="text-xs text-gray-500 mt-1">
                          Covering {job.absentTeacherName ?? 'teacher'}
                          {job.classes.length > 0 ? ` • ${job.classes.length} classes` : ''}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-xs font-medium text-amber-700">
                          {formatRelativeWindow(notification.acceptanceWindowExpiresAt)}
                        </p>
                      </div>
                    </div>
                    <div className="mt-3 flex gap-2">
                      <button
                        type="button"
                        disabled={accept.isPending}
                        onClick={async () => {
                          try {
                            await accept.mutateAsync(job.id);
                            toast('Job accepted', 'success');
                          } catch (e) {
                            toast(`Could not accept: ${(e as Error).message}`, 'error');
                          }
                        }}
                        className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                      >
                        Accept
                      </button>
                      <button
                        type="button"
                        disabled={decline.isPending}
                        onClick={async () => {
                          try {
                            await decline.mutateAsync(job.id);
                            toast('Declined', 'info');
                          } catch (e) {
                            toast(`Could not decline: ${(e as Error).message}`, 'error');
                          }
                        }}
                        className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-gray-700 ring-1 ring-gray-300 hover:bg-gray-50 disabled:opacity-50"
                      >
                        Decline
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Section>

          <Section title={`Upcoming (${upcoming.length})`}>
            {upcoming.length === 0 ? (
              <p className="text-sm text-gray-500">No upcoming assignments.</p>
            ) : (
              <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
                {upcoming.map((a) => (
                  <AssignmentRow
                    key={a.id}
                    assignment={a}
                    onCancel={() => {
                      setCancelling(a);
                      setCancelReason('');
                    }}
                  />
                ))}
              </ul>
            )}
          </Section>

          <Section title={`Past (${past.length})`}>
            {past.length === 0 ? (
              <p className="text-sm text-gray-500">No past assignments yet.</p>
            ) : (
              <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
                {past.slice(0, 10).map((a) => (
                  <AssignmentRow key={a.id} assignment={a} onCancel={() => {}} hideCancel />
                ))}
              </ul>
            )}
          </Section>
        </>
      )}

      {cancelling && (
        <Modal
          open={!!cancelling}
          onClose={() => setCancelling(null)}
          title="Cancel assignment"
          footer={
            <>
              <button
                type="button"
                onClick={() => setCancelling(null)}
                className="rounded-md px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100"
              >
                Keep
              </button>
              <button
                type="button"
                disabled={cancel.isPending || !cancelReason.trim()}
                onClick={async () => {
                  if (!cancelling) return;
                  try {
                    await cancel.mutateAsync({
                      id: cancelling.id,
                      payload: { cancelledByType: 'SUBSTITUTE', cancellationReason: cancelReason },
                    });
                    toast('Assignment cancelled', 'info');
                    setCancelling(null);
                    setCancelReason('');
                  } catch (e) {
                    toast(`Could not cancel: ${(e as Error).message}`, 'error');
                  }
                }}
                className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-50"
              >
                Cancel assignment
              </button>
            </>
          }
        >
          <p className="text-sm text-gray-700 mb-3">
            Cancellations within the school&apos;s late window may incur a policy consequence
            (suspension or rating penalty).
          </p>
          <label className="block text-sm font-medium text-gray-700 mb-1">Reason</label>
          <textarea
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            rows={4}
            className="w-full rounded-md border border-gray-300 p-2 text-sm"
            placeholder="Briefly explain the reason for cancelling..."
          />
        </Modal>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-base font-semibold text-gray-900 mb-2">{title}</h2>
      {children}
    </section>
  );
}

function AssignmentRow({
  assignment,
  onCancel,
  hideCancel = false,
}: {
  assignment: SubAssignmentDto;
  onCancel: () => void;
  hideCancel?: boolean;
}) {
  return (
    <li className="px-4 py-3 flex items-center justify-between gap-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-gray-900">
          Assignment {assignment.id.slice(0, 8)} • {formatDateTime(assignment.confirmedAt)}
        </p>
        <p className="text-xs text-gray-500">
          {assignment.checkInAt ? `Checked in ${formatDateTime(assignment.checkInAt)}` : ''}
          {assignment.checkOutAt ? ` • Checked out ${formatDateTime(assignment.checkOutAt)}` : ''}
        </p>
      </div>
      <span
        className={cn(
          'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
          ASSIGNMENT_STATUS_PILL[assignment.status],
        )}
      >
        {ASSIGNMENT_STATUS_LABEL[assignment.status]}
      </span>
      {!hideCancel && (assignment.status === 'CONFIRMED' || assignment.status === 'CHECKED_IN') && (
        <button
          type="button"
          onClick={onCancel}
          className="text-sm font-medium text-rose-600 hover:text-rose-700"
        >
          Cancel
        </button>
      )}
    </li>
  );
}
