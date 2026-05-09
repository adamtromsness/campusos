'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useAuthStore, hasAnyPermission } from '@/lib/auth-store';
import { useToast } from '@/components/ui/Toast';
import {
  useOverdueReferrals,
  useScreeningReferrals,
  useUpdateReferral,
} from '@/hooks/use-health-advanced';
import {
  REFERRAL_OUTCOMES,
  REFERRAL_OUTCOME_LABEL,
  REFERRAL_STATUSES,
  REFERRAL_STATUS_LABEL,
  REFERRAL_STATUS_PILL,
  REFERRAL_TYPES,
  REFERRAL_TYPE_LABEL,
  formatDateOnly,
  isOverdue,
} from '@/lib/health-advanced-format';
import type {
  ScreeningReferralDto,
  ScreeningReferralOutcome,
  ScreeningReferralStatus,
  ScreeningReferralType,
} from '@/lib/types';

/**
 * Referral tracker. Listing requires hlt-004:read; outcome recording
 * requires hlt-004:write. Overdue referrals (status=REFERRED with
 * follow_up_date in the past) bubble up at the top.
 */
export default function ScreeningReferralsPage() {
  const user = useAuthStore((s) => s.user);
  const canRead = hasAnyPermission(user, ['hlt-004:read']);
  const canWrite = hasAnyPermission(user, ['hlt-004:write']);
  const [statusFilter, setStatusFilter] = useState<ScreeningReferralStatus | ''>('');
  const [typeFilter, setTypeFilter] = useState<ScreeningReferralType | ''>('');
  const list = useScreeningReferrals({
    status: statusFilter || undefined,
    referralType: typeFilter || undefined,
  });
  const overdue = useOverdueReferrals();

  if (!canRead) {
    return (
      <div className="rounded border border-amber-200 bg-amber-50 p-5 text-sm text-amber-800">
        Screening referrals require hlt-004:read.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Screening Referrals</h1>
        <Link className="text-sm text-sky-700 hover:underline" href="/health">
          ← Health
        </Link>
      </div>

      {(overdue.data ?? []).length > 0 ? (
        <section className="rounded border-2 border-rose-300 bg-rose-50 p-5">
          <h2 className="text-base font-semibold text-rose-900">
            Overdue follow-ups ({(overdue.data ?? []).length})
          </h2>
          <ul className="mt-2 divide-y divide-rose-200 text-sm">
            {(overdue.data ?? []).map((r) => (
              <li key={r.id} className="flex items-center justify-between py-1.5">
                <span>
                  <strong>{r.studentName ?? r.studentId.slice(0, 8)}</strong> —{' '}
                  {REFERRAL_TYPE_LABEL[r.referralType]} → {r.referredTo ?? '—'}
                </span>
                <span className="text-xs text-rose-700">Due {formatDateOnly(r.followUpDate)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="rounded border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-center gap-3">
          <select
            className="rounded border border-slate-300 px-2 py-1 text-sm"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as ScreeningReferralStatus | '')}
          >
            <option value="">All statuses</option>
            {REFERRAL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {REFERRAL_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          <select
            className="rounded border border-slate-300 px-2 py-1 text-sm"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as ScreeningReferralType | '')}
          >
            <option value="">All types</option>
            {REFERRAL_TYPES.map((t) => (
              <option key={t} value={t}>
                {REFERRAL_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </div>

        <table className="mt-3 min-w-full text-sm">
          <thead className="text-xs uppercase text-slate-500">
            <tr className="text-left">
              <th className="py-2">Student</th>
              <th>Type</th>
              <th>Provider</th>
              <th>Referred</th>
              <th>Follow-up</th>
              <th>Status</th>
              <th>Outcome</th>
              <th></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {(list.data ?? []).map((r) => (
              <ReferralRow key={r.id} referral={r} canWrite={canWrite} />
            ))}
            {(list.data ?? []).length === 0 ? (
              <tr>
                <td colSpan={8} className="py-2 text-slate-500">
                  No referrals match the filters.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function ReferralRow({
  referral,
  canWrite,
}: {
  referral: ScreeningReferralDto;
  canWrite: boolean;
}) {
  const update = useUpdateReferral(referral.id);
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [outcome, setOutcome] = useState<ScreeningReferralOutcome | ''>(
    referral.followUpOutcome ?? '',
  );
  const [outcomeDate, setOutcomeDate] = useState(
    referral.followUpDate ?? new Date().toISOString().slice(0, 10),
  );

  const overdue = isOverdue(referral.followUpDate, referral.status);

  return (
    <tr className={`align-top ${overdue ? 'bg-rose-50' : ''}`}>
      <td className="py-2">{referral.studentName ?? referral.studentId.slice(0, 8)}</td>
      <td>{REFERRAL_TYPE_LABEL[referral.referralType]}</td>
      <td className="text-xs">{referral.referredTo ?? '—'}</td>
      <td className="text-xs">{formatDateOnly(referral.referralDate) || '—'}</td>
      <td className="text-xs">{formatDateOnly(referral.followUpDate) || '—'}</td>
      <td>
        <span className={`rounded px-2 py-0.5 text-xs ${REFERRAL_STATUS_PILL[referral.status]}`}>
          {REFERRAL_STATUS_LABEL[referral.status]}
        </span>
      </td>
      <td className="text-xs">
        {referral.followUpOutcome ? REFERRAL_OUTCOME_LABEL[referral.followUpOutcome] : '—'}
      </td>
      <td className="text-right text-xs">
        {canWrite && referral.status === 'REFERRED' ? (
          editing ? (
            <div className="flex flex-col items-end gap-1">
              <select
                className="rounded border border-slate-300 px-1 py-0.5"
                value={outcome}
                onChange={(e) => setOutcome(e.target.value as ScreeningReferralOutcome | '')}
              >
                <option value="">— outcome —</option>
                {REFERRAL_OUTCOMES.map((o) => (
                  <option key={o} value={o}>
                    {REFERRAL_OUTCOME_LABEL[o]}
                  </option>
                ))}
              </select>
              <input
                type="date"
                className="rounded border border-slate-300 px-1 py-0.5"
                value={outcomeDate}
                onChange={(e) => setOutcomeDate(e.target.value)}
              />
              <div className="flex gap-2">
                <button
                  className="text-emerald-700 hover:underline disabled:text-slate-400"
                  disabled={!outcome || update.isPending}
                  onClick={async () => {
                    if (!outcome) return;
                    try {
                      await update.mutateAsync({
                        status: 'FOLLOW_UP_COMPLETE',
                        followUpOutcome: outcome,
                        followUpDate: outcomeDate,
                      });
                      toast('Follow-up recorded');
                      setEditing(false);
                    } catch (e) {
                      toast(`Failed: ${(e as Error).message}`, 'error');
                    }
                  }}
                >
                  Save
                </button>
                <button
                  className="text-slate-600 hover:underline"
                  onClick={() => setEditing(false)}
                >
                  Cancel
                </button>
              </div>
              <button
                className="text-rose-700 hover:underline"
                onClick={async () => {
                  if (!window.confirm('Mark as lost to follow-up?')) return;
                  try {
                    await update.mutateAsync({ status: 'LOST_TO_FOLLOW_UP' });
                    toast('Marked lost to follow-up');
                    setEditing(false);
                  } catch (e) {
                    toast(`Failed: ${(e as Error).message}`, 'error');
                  }
                }}
              >
                Lost to follow-up
              </button>
            </div>
          ) : (
            <button className="text-sky-700 hover:underline" onClick={() => setEditing(true)}>
              Record outcome
            </button>
          )
        ) : null}
      </td>
    </tr>
  );
}
