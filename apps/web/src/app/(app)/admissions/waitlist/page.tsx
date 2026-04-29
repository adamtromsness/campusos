'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { useEnrollmentPeriods, useOfferFromWaitlist, useWaitlist } from '@/hooks/use-enrollment';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  WAITLIST_STATUS_LABELS,
  WAITLIST_STATUS_PILL,
  addDaysIso,
  formatDateOnly,
  formatStudentName,
  todayIso,
} from '@/lib/admissions-format';
import type { WaitlistEntryDto, WaitlistStatus } from '@/lib/types';

const FILTER_STATUSES: WaitlistStatus[] = ['ACTIVE', 'OFFERED', 'ENROLLED', 'EXPIRED', 'WITHDRAWN'];

export default function WaitlistPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && hasAnyPermission(user, ['stu-003:admin']);
  const periods = useEnrollmentPeriods(!!user);
  const [periodId, setPeriodId] = useState('');
  const [statusFilter, setStatusFilter] = useState<WaitlistStatus | 'ALL'>('ACTIVE');
  const waitlist = useWaitlist(
    {
      enrollmentPeriodId: periodId || undefined,
      status: statusFilter === 'ALL' ? undefined : statusFilter,
    },
    !!user,
  );
  const [offering, setOffering] = useState<WaitlistEntryDto | null>(null);

  const grouped = useMemo(() => {
    const map = new Map<string, WaitlistEntryDto[]>();
    for (const w of waitlist.data ?? []) {
      const list = map.get(w.gradeLevel) ?? [];
      list.push(w);
      map.set(w.gradeLevel, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.position - b.position);
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [waitlist.data]);

  if (!user) return null;
  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Waitlist" description="Admissions admin only." />
        <EmptyState title="Admin access required" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Waitlist"
        description="Ordered by grade and priority. Promote the next applicant to issue an offer."
      />

      <nav className="mt-2 flex gap-3 text-sm">
        <Link href="/admissions/applications" className="text-gray-500 hover:text-campus-700">
          Applications
        </Link>
        <span className="text-gray-300">·</span>
        <Link href="/admissions/periods" className="text-gray-500 hover:text-campus-700">
          Periods
        </Link>
        <span className="text-gray-300">·</span>
        <span className="font-medium text-campus-700">Waitlist</span>
      </nav>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <select
          value={periodId}
          onChange={(e) => setPeriodId(e.target.value)}
          className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
        >
          <option value="">All periods</option>
          {(periods.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <div className="flex flex-wrap gap-1">
          {(['ALL', ...FILTER_STATUSES] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s as WaitlistStatus | 'ALL')}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                statusFilter === s
                  ? 'bg-campus-700 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {s === 'ALL' ? 'All' : WAITLIST_STATUS_LABELS[s as WaitlistStatus]}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-6">
        {waitlist.isLoading ? (
          <div className="py-16 text-center">
            <LoadingSpinner />
          </div>
        ) : waitlist.isError ? (
          <EmptyState title="Couldn’t load waitlist" />
        ) : (waitlist.data ?? []).length === 0 ? (
          <EmptyState
            title="Queue clear"
            description={
              statusFilter === 'ACTIVE'
                ? 'No applicants currently waitlisted.'
                : 'No waitlist entries match the filter.'
            }
          />
        ) : (
          <div className="space-y-6">
            {grouped.map(([grade, rows]) => (
              <section key={grade}>
                <h2 className="mb-2 text-sm font-semibold text-gray-700">
                  Grade {grade} · {rows.length} {rows.length === 1 ? 'entry' : 'entries'}
                </h2>
                <ul className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
                  {rows.map((w) => (
                    <li
                      key={w.id}
                      className="flex flex-col gap-3 border-b border-gray-100 px-4 py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="flex items-center gap-3">
                        <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-campus-100 text-sm font-semibold text-campus-700">
                          {w.position}
                        </span>
                        <div>
                          <Link
                            href={`/admissions/applications/${w.applicationId}`}
                            className="text-sm font-semibold text-gray-900 hover:text-campus-700"
                          >
                            {formatStudentName(w.studentFirstName, w.studentLastName)}
                          </Link>
                          <p className="text-xs text-gray-500">
                            Priority {w.priorityScore.toFixed(2)} · added{' '}
                            {formatDateOnly(w.addedAt)}
                            {w.offeredAt ? ` · offered ${formatDateOnly(w.offeredAt)}` : ''}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                            WAITLIST_STATUS_PILL[w.status]
                          }`}
                        >
                          {WAITLIST_STATUS_LABELS[w.status]}
                        </span>
                        {w.status === 'ACTIVE' && (
                          <button
                            type="button"
                            onClick={() => setOffering(w)}
                            className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600"
                          >
                            Offer this spot
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>

      {offering && <OfferModal entry={offering} onClose={() => setOffering(null)} />}
    </div>
  );
}

function OfferModal({ entry, onClose }: { entry: WaitlistEntryDto; onClose: () => void }) {
  const { toast } = useToast();
  const offer = useOfferFromWaitlist(entry.id);
  const [deadline, setDeadline] = useState(addDaysIso(todayIso(), 14));

  async function onSubmit() {
    try {
      await offer.mutateAsync({
        responseDeadline: new Date(deadline + 'T23:59:59Z').toISOString(),
      });
      toast('Offer issued from waitlist.', 'success');
      onClose();
    } catch (e: any) {
      toast(e?.message || 'Could not issue offer', 'error');
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Offer this spot to ${formatStudentName(entry.studentFirstName, entry.studentLastName)}`}
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={offer.isPending}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={offer.isPending}
            className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600 disabled:opacity-50"
          >
            {offer.isPending ? 'Issuing…' : 'Issue offer'}
          </button>
        </div>
      }
    >
      <p className="text-sm text-gray-700">
        Promotes the waitlist entry to OFFERED, flips the application to ACCEPTED, and creates a new
        offer row — all atomically.
      </p>
      <label className="mt-4 block text-sm">
        <span className="text-gray-700">Response deadline</span>
        <input
          type="date"
          value={deadline}
          min={todayIso()}
          onChange={(e) => setDeadline(e.target.value)}
          className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
        />
      </label>
    </Modal>
  );
}
