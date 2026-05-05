'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import { useCaseload, useCloseCaseload, useSessions } from '@/hooks/use-counselling';
import {
  CASELOAD_STATUS_LABELS,
  CASELOAD_STATUS_PILL,
  PRIMARY_CONCERN_LABELS,
  PRIMARY_CONCERN_PILL,
  SESSION_STATUS_LABELS,
  SESSION_STATUS_PILL,
  SESSION_TYPE_LABELS,
  SESSION_TYPE_PILL,
  formatDateOnly,
  studentDisplay,
} from '@/lib/counselling-format';

export default function CaseloadDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { toast } = useToast();
  const id = params?.id ?? '';
  const cl = useCaseload(id);
  const sessionsQ = useSessions({
    caseloadId: id,
    enabled: !!id,
  });
  const close = useCloseCaseload(id);
  const [closing, setClosing] = useState(false);
  const [reason, setReason] = useState('');

  if (cl.isLoading) return <LoadingSpinner />;
  if (cl.isError || !cl.data) {
    return (
      <EmptyState
        title="Caseload not found"
        description="It may have been closed or you do not have access."
        action={
          <Link
            href="/counselling"
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Back to dashboard
          </Link>
        }
      />
    );
  }

  const caseload = cl.data;
  const sessions = sessionsQ.data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title={studentDisplay(caseload.studentFirstName, caseload.studentLastName)}
        description={'Caseload opened ' + formatDateOnly(caseload.openedAt)}
      />

      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-xs font-medium',
              PRIMARY_CONCERN_PILL[caseload.primaryConcern],
            )}
          >
            {PRIMARY_CONCERN_LABELS[caseload.primaryConcern]}
          </span>
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-xs font-medium',
              CASELOAD_STATUS_PILL[caseload.status],
            )}
          >
            {CASELOAD_STATUS_LABELS[caseload.status]}
          </span>
          {caseload.isPrimaryCounselor ? (
            <span className="rounded-full bg-campus-100 px-2 py-0.5 text-xs font-medium text-campus-800">
              Primary
            </span>
          ) : (
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
              Consultant
            </span>
          )}
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-4">
          <div>
            <dt className="text-xs text-gray-500">Counsellor</dt>
            <dd className="text-gray-900">{caseload.counselorName ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">Academic year</dt>
            <dd className="text-gray-900">{caseload.academicYearName ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">Sessions</dt>
            <dd className="text-gray-900">{caseload.sessionCount ?? 0}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">Last session</dt>
            <dd className="text-gray-900">{formatDateOnly(caseload.lastSessionDate)}</dd>
          </div>
        </dl>
        {caseload.notes ? (
          <div className="mt-4 rounded border border-gray-100 bg-gray-50 p-3 text-sm text-gray-700">
            <div className="text-xs font-semibold uppercase text-gray-500">Counsellor notes</div>
            <div className="mt-1 whitespace-pre-wrap">{caseload.notes}</div>
          </div>
        ) : null}
      </div>

      {caseload.linkedBipId ? (
        <div className="rounded-lg border border-violet-200 bg-violet-50 p-4">
          <div className="text-xs font-semibold uppercase text-violet-700">
            Linked Behaviour Plan
          </div>
          <div className="mt-1 text-sm text-violet-900">
            This caseload is linked to an active BIP from Cycle 9.{' '}
            <Link
              href={'/behavior-plans/' + caseload.linkedBipId}
              className="font-medium underline"
            >
              Open BIP →
            </Link>
          </div>
        </div>
      ) : null}

      <div>
        <h2 className="mb-3 text-base font-semibold text-gray-900">Session history</h2>
        {sessionsQ.isLoading ? (
          <LoadingSpinner />
        ) : sessions.length === 0 ? (
          <EmptyState
            title="No sessions yet"
            description="Schedule the first session for this caseload from the Sessions log."
          />
        ) : (
          <ul className="space-y-2">
            {sessions.map((s) => (
              <li
                key={s.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-200 bg-white p-3"
              >
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium text-gray-900">{formatDateOnly(s.sessionDate)}</span>
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-[11px] font-medium',
                      SESSION_TYPE_PILL[s.sessionType],
                    )}
                  >
                    {SESSION_TYPE_LABELS[s.sessionType]}
                  </span>
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-[11px] font-medium',
                      SESSION_STATUS_PILL[s.status],
                    )}
                  >
                    {SESSION_STATUS_LABELS[s.status]}
                  </span>
                  {s.durationMinutes ? (
                    <span className="text-xs text-gray-500">{s.durationMinutes} min</span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {caseload.status === 'ACTIVE' ? (
        <div>
          <button
            type="button"
            onClick={() => setClosing(true)}
            className="rounded-md border border-rose-300 px-3 py-1.5 text-sm font-medium text-rose-700 hover:bg-rose-50"
          >
            Close caseload
          </button>
        </div>
      ) : null}

      <Modal
        open={closing}
        onClose={() => setClosing(false)}
        title="Close caseload"
        footer={
          <div className="flex justify-end gap-2 px-5 py-3">
            <button
              type="button"
              onClick={() => setClosing(false)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!reason.trim() || close.isPending}
              onClick={async () => {
                try {
                  await close.mutateAsync({ closureReason: reason.trim() });
                  toast('Caseload closed', 'success');
                  setClosing(false);
                  router.push('/counselling');
                } catch (e) {
                  toast(e instanceof Error ? e.message : 'Failed to close', 'error');
                }
              }}
              className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-50"
            >
              {close.isPending ? 'Closing…' : 'Close caseload'}
            </button>
          </div>
        }
      >
        <p className="text-sm text-gray-600">
          Stamp the closure reason. The status flips to CLOSED atomically and the partial UNIQUE
          keystone releases.
        </p>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why is this caseload closing?"
          className="mt-3 w-full rounded-md border border-gray-300 p-2 text-sm"
          rows={4}
          maxLength={1000}
        />
      </Modal>
    </div>
  );
}
