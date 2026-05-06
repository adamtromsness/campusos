'use client';

import Link from 'next/link';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import {
  useFdsAllergenAlerts,
  useFdsDietaryUpdateRequests,
  useFdsReviewDietaryUpdate,
} from '@/hooks/use-food-service';
import {
  FDS_DUR_STATUS_LABEL,
  FDS_DUR_STATUS_PILL,
  FDS_DUR_TYPE_LABEL,
  FDS_SEVERITY_LABEL,
  FDS_SEVERITY_PILL,
} from '@/lib/food-service-format';
import type { FdsDietaryUpdateRequestDto } from '@/lib/types';

export default function DietaryDashboardPage() {
  const requestsQ = useFdsDietaryUpdateRequests();
  const alertsQ = useFdsAllergenAlerts();

  const pending = (requestsQ.data ?? []).filter((r) => r.status === 'PENDING');
  const allergenByCode = new Map<string, number>();
  (alertsQ.data ?? []).forEach((a) => {
    if (a.severity !== 'CRITICAL') return;
    allergenByCode.set(a.allergenCode, (allergenByCode.get(a.allergenCode) ?? 0) + 1);
  });

  return (
    <div>
      <PageHeader
        title="Dietary dashboard"
        description="Update requests, allergen alerts, school-wide allergen heatmap"
        actions={
          <Link
            href="/food-service"
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            ← Food Service
          </Link>
        }
      />

      <section className="mb-4 rounded-2xl border border-gray-200 bg-white p-5">
        <h2 className="text-base font-semibold text-gray-900">
          Pending dietary update requests ({pending.length})
        </h2>
        {requestsQ.isLoading ? (
          <LoadingSpinner />
        ) : pending.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {pending.map((r) => (
              <RequestRow key={r.id} req={r} />
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-gray-500">No pending requests.</p>
        )}
      </section>

      <section className="mb-4 rounded-2xl border border-rose-200 bg-rose-50 p-5">
        <h2 className="text-base font-semibold text-rose-900">CRITICAL allergen heatmap</h2>
        {alertsQ.isLoading ? (
          <LoadingSpinner />
        ) : allergenByCode.size === 0 ? (
          <p className="mt-3 text-sm text-rose-800">No CRITICAL allergens on file.</p>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            {[...allergenByCode.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([code, count]) => (
                <div
                  key={code}
                  className="rounded-lg bg-white px-3 py-1.5 text-sm shadow-sm ring-1 ring-rose-200"
                >
                  <span className="font-mono font-semibold text-rose-900">{code}</span>
                  <span className="ml-2 text-rose-700">
                    {count} student{count === 1 ? '' : 's'}
                  </span>
                </div>
              ))}
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-gray-200 bg-white p-5">
        <h2 className="text-base font-semibold text-gray-900">All allergen alerts</h2>
        {alertsQ.isLoading ? (
          <LoadingSpinner />
        ) : alertsQ.data && alertsQ.data.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {alertsQ.data.map((a) => (
              <li
                key={a.id}
                className="flex items-start justify-between gap-3 rounded-lg border border-gray-100 bg-gray-50 p-3 text-sm"
              >
                <div>
                  <div className="font-medium text-gray-900">
                    {a.studentName ?? 'Student'} — {a.allergenDisplayName}
                  </div>
                  <div className="text-xs text-gray-500">
                    Code: {a.allergenCode} · Synced {new Date(a.lastSyncedAt).toLocaleDateString()}
                  </div>
                </div>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs ${FDS_SEVERITY_PILL[a.severity]}`}
                >
                  {FDS_SEVERITY_LABEL[a.severity]}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-gray-500">No allergen alerts.</p>
        )}
      </section>
    </div>
  );
}

function RequestRow({ req }: { req: FdsDietaryUpdateRequestDto }) {
  const review = useFdsReviewDietaryUpdate(req.id);
  const { toast } = useToast();

  return (
    <li className="rounded-lg border border-gray-100 bg-gray-50 p-3">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <div className="font-medium text-gray-900">
            {req.studentName ?? 'Student'} — {FDS_DUR_TYPE_LABEL[req.changeType]}
          </div>
          <div className="text-xs text-gray-500">
            Proposed: <code className="font-mono">{req.proposedValue}</code>
            {req.reason && ` · ${req.reason}`}
          </div>
          <div className="text-xs text-gray-500">
            Submitted by {req.submittedByName ?? 'unknown'} ·{' '}
            {new Date(req.createdAt).toLocaleString()}
          </div>
        </div>
        <span className={`rounded-full px-2 py-0.5 text-xs ${FDS_DUR_STATUS_PILL[req.status]}`}>
          {FDS_DUR_STATUS_LABEL[req.status]}
        </span>
      </div>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={async () => {
            try {
              await review.mutateAsync({ status: 'APPROVED' });
              toast('Request approved + applied to dietary profile', 'success');
            } catch (err) {
              toast((err as Error).message, 'error');
            }
          }}
          disabled={review.isPending}
          className="rounded-lg bg-emerald-700 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-800 disabled:bg-gray-300"
        >
          Approve
        </button>
        <button
          type="button"
          onClick={async () => {
            const notes = window.prompt('Reason for rejection?') ?? '';
            try {
              await review.mutateAsync({ status: 'REJECTED', reviewNotes: notes });
              toast('Request rejected', 'success');
            } catch (err) {
              toast((err as Error).message, 'error');
            }
          }}
          disabled={review.isPending}
          className="rounded-lg border border-rose-300 bg-white px-3 py-1 text-xs text-rose-700 hover:bg-rose-50"
        >
          Reject
        </button>
      </div>
    </li>
  );
}
