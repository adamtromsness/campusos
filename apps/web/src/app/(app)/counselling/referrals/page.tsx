'use client';

import { useMemo, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import {
  useAcceptReferral,
  useCompleteReferral,
  useDeclineReferral,
  useReferralActivity,
  useReferrals,
  useStartReferral,
  useTriageReferral,
} from '@/hooks/use-counselling';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  REFERRAL_ACTIVITY_LABELS,
  REFERRAL_PRIORITY_LABELS,
  REFERRAL_PRIORITY_PILL,
  REFERRAL_STATUS_LABELS,
  REFERRAL_STATUS_PILL,
  formatRelative,
  priorityRank,
  studentDisplay,
} from '@/lib/counselling-format';
import type { ReferralDto, ReferralStatus } from '@/lib/types';

type FilterChip = ReferralStatus | 'ALL' | 'TRIAGE';

const CHIPS: Array<{ value: FilterChip; label: string }> = [
  { value: 'TRIAGE', label: 'Triage queue' },
  { value: 'SUBMITTED', label: 'Submitted' },
  { value: 'TRIAGED', label: 'Triaged' },
  { value: 'ACCEPTED', label: 'Accepted' },
  { value: 'IN_PROGRESS', label: 'In progress' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'DECLINED', label: 'Declined' },
  { value: 'ALL', label: 'All' },
];

function applyFilter(list: ReferralDto[], chip: FilterChip): ReferralDto[] {
  switch (chip) {
    case 'TRIAGE':
      return list.filter((r) => r.status === 'SUBMITTED' || r.status === 'TRIAGED');
    case 'ALL':
      return list;
    default:
      return list.filter((r) => r.status === chip);
  }
}

export default function ReferralsQueuePage() {
  const { user } = useAuthStore();
  const isCounsellor = hasAnyPermission(user, ['cou-001:write']);
  const [chip, setChip] = useState<FilterChip>('TRIAGE');
  const referralsQ = useReferrals({});
  const [openId, setOpenId] = useState<string | null>(null);

  const sorted = useMemo(() => {
    const filtered = applyFilter(referralsQ.data ?? [], chip);
    return [...filtered].sort((a, b) => {
      const pr = priorityRank(a.priority) - priorityRank(b.priority);
      if (pr !== 0) return pr;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }, [referralsQ.data, chip]);

  return (
    <div>
      <PageHeader title="Referrals" description="Triage incoming referrals and track lifecycle." />

      <div className="mb-4 flex flex-wrap gap-2">
        {CHIPS.map((c) => (
          <button
            key={c.value}
            type="button"
            onClick={() => setChip(c.value)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs font-medium',
              chip === c.value
                ? 'border-campus-300 bg-campus-100 text-campus-900'
                : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50',
            )}
          >
            {c.label}
          </button>
        ))}
      </div>

      {referralsQ.isLoading ? (
        <LoadingSpinner />
      ) : sorted.length === 0 ? (
        <EmptyState title="No referrals" description="Nothing to show for the selected filter." />
      ) : (
        <ul className="space-y-2">
          {sorted.map((r) => (
            <li
              key={r.id}
              className="rounded-lg border border-gray-200 bg-white p-3 hover:border-campus-300 cursor-pointer"
              onClick={() => setOpenId(r.id)}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="text-sm font-medium text-gray-900">
                  {studentDisplay(r.studentFirstName, r.studentLastName)}
                  {r.studentGradeLevel ? (
                    <span className="ml-1 text-xs text-gray-500">
                      (Grade {r.studentGradeLevel})
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-[11px] font-medium',
                      REFERRAL_PRIORITY_PILL[r.priority],
                    )}
                  >
                    {REFERRAL_PRIORITY_LABELS[r.priority]}
                  </span>
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-[11px] font-medium',
                      REFERRAL_STATUS_PILL[r.status],
                    )}
                  >
                    {REFERRAL_STATUS_LABELS[r.status]}
                  </span>
                </div>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                {r.referralTypeName ? <span>{r.referralTypeName}</span> : null}
                {r.referredByName ? <span>· Referred by {r.referredByName}</span> : null}
                {r.assignedCounselorName ? (
                  <span>· Assigned to {r.assignedCounselorName}</span>
                ) : null}
                <span>· {formatRelative(r.createdAt)}</span>
              </div>
              <div className="mt-2 line-clamp-2 text-sm text-gray-600">{r.reason}</div>
            </li>
          ))}
        </ul>
      )}

      {openId ? (
        <ReferralDetailModal
          id={openId}
          onClose={() => setOpenId(null)}
          isCounsellor={isCounsellor}
        />
      ) : null}
    </div>
  );
}

function ReferralDetailModal({
  id,
  onClose,
  isCounsellor,
}: {
  id: string;
  onClose: () => void;
  isCounsellor: boolean;
}) {
  const { toast } = useToast();
  const referralsQ = useReferrals({});
  const referral = (referralsQ.data ?? []).find((r) => r.id === id);
  const activity = useReferralActivity(id);
  const triage = useTriageReferral(id);
  const accept = useAcceptReferral(id);
  const start = useStartReferral(id);
  const complete = useCompleteReferral(id);
  const decline = useDeclineReferral(id);
  const [completeOutcome, setCompleteOutcome] = useState('');
  const [declineReason, setDeclineReason] = useState('');

  if (!referral) {
    return null;
  }

  return (
    <Modal open={true} onClose={onClose} title="Referral detail" size="lg">
      <div className="space-y-4">
        <div>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="text-base font-semibold text-gray-900">
              {studentDisplay(referral.studentFirstName, referral.studentLastName)}
            </div>
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 text-[11px] font-medium',
                  REFERRAL_PRIORITY_PILL[referral.priority],
                )}
              >
                {REFERRAL_PRIORITY_LABELS[referral.priority]}
              </span>
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 text-[11px] font-medium',
                  REFERRAL_STATUS_PILL[referral.status],
                )}
              >
                {REFERRAL_STATUS_LABELS[referral.status]}
              </span>
            </div>
          </div>
          <div className="mt-1 text-xs text-gray-500">
            {referral.referralTypeName} · Referred by {referral.referredByName ?? 'Unknown'} ·{' '}
            {formatRelative(referral.createdAt)}
          </div>
        </div>

        <div className="rounded border border-gray-100 bg-gray-50 p-3 text-sm text-gray-700">
          <div className="text-xs font-semibold uppercase text-gray-500">Reason</div>
          <div className="mt-1 whitespace-pre-wrap">{referral.reason}</div>
        </div>

        {referral.outcome ? (
          <div className="rounded border border-emerald-100 bg-emerald-50 p-3 text-sm text-emerald-900">
            <div className="text-xs font-semibold uppercase text-emerald-700">Outcome</div>
            <div className="mt-1 whitespace-pre-wrap">{referral.outcome}</div>
          </div>
        ) : null}

        <div>
          <div className="text-xs font-semibold uppercase text-gray-500">Activity timeline</div>
          {activity.isLoading ? (
            <LoadingSpinner />
          ) : (activity.data ?? []).length === 0 ? (
            <div className="mt-1 text-sm text-gray-500">No activity yet.</div>
          ) : (
            <ul className="mt-2 space-y-2 text-sm">
              {(activity.data ?? []).map((a) => (
                <li key={a.id} className="rounded border border-gray-100 bg-white p-2 text-xs">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium text-gray-900">
                      {REFERRAL_ACTIVITY_LABELS[a.activityType]}
                    </span>
                    <span className="text-gray-500">{formatRelative(a.createdAt)}</span>
                  </div>
                  <div className="mt-0.5 text-gray-600">
                    {a.actorName ?? 'System'}
                    {a.notes ? ' — ' + a.notes : ''}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {isCounsellor ? (
          <div className="rounded-lg border border-campus-200 bg-campus-50 p-3">
            <div className="text-xs font-semibold uppercase text-campus-700">
              Counsellor actions
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {referral.status === 'SUBMITTED' || referral.status === 'TRIAGED' ? (
                <button
                  type="button"
                  className="rounded-md bg-campus-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-campus-700 disabled:opacity-50"
                  disabled={triage.isPending}
                  onClick={async () => {
                    try {
                      // Counsellor self-assigns. The current actor's employeeId is on the
                      // server side; we get back the resolved name in the response.
                      const refreshed = await triage.mutateAsync({
                        assignedCounselorId: referral.assignedCounselorId ?? '',
                      });
                      toast('Triaged: ' + refreshed.status, 'success');
                    } catch (e) {
                      // The assignedCounselorId is required and may be empty for an
                      // unassigned referral; in that case the counsellor needs to use
                      // a richer modal in a future polish pass. Surface the error.
                      toast(e instanceof Error ? e.message : 'Failed to triage', 'error');
                    }
                  }}
                >
                  Triage
                </button>
              ) : null}
              {referral.status === 'TRIAGED' || referral.status === 'SUBMITTED' ? (
                <button
                  type="button"
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                  disabled={accept.isPending}
                  onClick={async () => {
                    try {
                      await accept.mutateAsync({});
                      toast('Referral accepted', 'success');
                    } catch (e) {
                      toast(e instanceof Error ? e.message : 'Failed to accept', 'error');
                    }
                  }}
                >
                  Accept
                </button>
              ) : null}
              {referral.status === 'ACCEPTED' ? (
                <button
                  type="button"
                  className="rounded-md bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-700 disabled:opacity-50"
                  disabled={start.isPending}
                  onClick={async () => {
                    try {
                      await start.mutateAsync();
                      toast('Started case work', 'success');
                    } catch (e) {
                      toast(e instanceof Error ? e.message : 'Failed to start', 'error');
                    }
                  }}
                >
                  Start
                </button>
              ) : null}
              {referral.status === 'ACCEPTED' || referral.status === 'IN_PROGRESS' ? (
                <div className="flex flex-1 items-center gap-2">
                  <input
                    type="text"
                    value={completeOutcome}
                    onChange={(e) => setCompleteOutcome(e.target.value)}
                    placeholder="Outcome summary"
                    className="flex-1 rounded-md border border-gray-300 px-2 py-1 text-xs"
                  />
                  <button
                    type="button"
                    className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
                    disabled={!completeOutcome.trim() || complete.isPending}
                    onClick={async () => {
                      try {
                        await complete.mutateAsync({ outcome: completeOutcome.trim() });
                        toast('Referral completed', 'success');
                      } catch (e) {
                        toast(e instanceof Error ? e.message : 'Failed to complete', 'error');
                      }
                    }}
                  >
                    Complete
                  </button>
                </div>
              ) : null}
              {referral.status !== 'COMPLETED' &&
              referral.status !== 'DECLINED' &&
              referral.status !== 'CANCELLED' ? (
                <div className="flex flex-1 items-center gap-2">
                  <input
                    type="text"
                    value={declineReason}
                    onChange={(e) => setDeclineReason(e.target.value)}
                    placeholder="Decline reason"
                    className="flex-1 rounded-md border border-gray-300 px-2 py-1 text-xs"
                  />
                  <button
                    type="button"
                    className="rounded-md border border-rose-300 px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50"
                    disabled={!declineReason.trim() || decline.isPending}
                    onClick={async () => {
                      try {
                        await decline.mutateAsync({ reason: declineReason.trim() });
                        toast('Referral declined', 'success');
                      } catch (e) {
                        toast(e instanceof Error ? e.message : 'Failed to decline', 'error');
                      }
                    }}
                  >
                    Decline
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
