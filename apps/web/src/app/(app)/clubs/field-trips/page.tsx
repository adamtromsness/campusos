'use client';

import Link from 'next/link';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useFieldTrips } from '@/hooks/use-clubs';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';

const STATUS_PILL: Record<string, string> = {
  PLANNING: 'bg-gray-100 text-gray-700',
  APPROVED: 'bg-sky-100 text-sky-700',
  CONFIRMED: 'bg-emerald-100 text-emerald-700',
  COMPLETED: 'bg-violet-100 text-violet-700',
  CANCELLED: 'bg-rose-100 text-rose-700',
};

export default function FieldTripsListPage() {
  const user = useAuthStore((s) => s.user);
  const isStaff = !!user && hasAnyPermission(user, ['clb-003:write']);
  const tripsQ = useFieldTrips(!!user);

  if (!user) return null;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Field trips"
        description={
          isStaff ? 'Plan, manage, and track parent consent' : "Your child's field trips"
        }
      />
      {tripsQ.isLoading ? (
        <div className="py-12 text-center">
          <LoadingSpinner />
        </div>
      ) : !tripsQ.data || tripsQ.data.length === 0 ? (
        <EmptyState title="No upcoming field trips" />
      ) : (
        <ul className="space-y-3">
          {tripsQ.data.map((t) => {
            const consentPct =
              t.participantCount > 0
                ? Math.round((t.consentSignedCount / t.participantCount) * 100)
                : 0;
            return (
              <li
                key={t.id}
                className="rounded-lg border border-gray-200 bg-white p-4 hover:border-campus-300"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1">
                    <div className="mb-1 flex items-center gap-2">
                      <span
                        className={`rounded px-1.5 py-0.5 text-xs ${
                          STATUS_PILL[t.status] ?? 'bg-gray-100 text-gray-700'
                        }`}
                      >
                        {t.status}
                      </span>
                      <span className="text-xs text-gray-500">{t.tripDate}</span>
                    </div>
                    <h3 className="text-base font-semibold text-gray-900">{t.title}</h3>
                    <p className="text-sm text-gray-600">{t.destination}</p>
                    <p className="mt-1 text-xs text-gray-500">
                      Organiser: {t.organiserName ?? '—'} · {t.participantCount} participants
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-gray-500">Consent signed</p>
                    <p className="text-sm font-semibold text-gray-900">
                      {t.consentSignedCount} / {t.participantCount}
                    </p>
                    <div className="mt-1 h-1.5 w-24 overflow-hidden rounded-full bg-gray-100">
                      <div className="h-full bg-emerald-500" style={{ width: `${consentPct}%` }} />
                    </div>
                    {isStaff ? (
                      <Link
                        href={`/clubs/field-trips/${t.id}`}
                        className="mt-2 inline-block text-xs font-medium text-campus-700 hover:underline"
                      >
                        Manage →
                      </Link>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
