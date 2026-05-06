'use client';

import Link from 'next/link';
import { PageHeader, EmptyState } from '@/components/ui';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { usePublications, useSeries } from '@/hooks/use-publications';
import {
  FREQUENCY_LABELS,
  PUBLICATION_TYPE_LABELS,
  STATUS_PILL,
  formatDate,
} from '@/lib/publications-format';

export default function PublicationsDashboardPage() {
  const { user } = useAuthStore();
  const isStaff = user?.personType === 'STAFF';
  const isAdmin = hasAnyPermission(user, ['sch-001:admin']);
  const showStaffSurfaces = isStaff || isAdmin;
  const seriesQ = useSeries();
  const publishedQ = usePublications({ status: 'PUBLISHED' });

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <PageHeader
        title="Publications"
        description={
          showStaffSurfaces
            ? 'Manage series, editions, and distribution.'
            : 'Read the latest school newsletters and bulletins.'
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Link
          href="/publications/subscriptions"
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
        >
          My subscriptions
        </Link>
      </div>

      {showStaffSurfaces && (
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
            Series
          </h2>
          {(seriesQ.data?.length ?? 0) === 0 ? (
            <EmptyState
              title="No series yet"
              description="A series is the recurring brand container for editions (e.g., the weekly newsletter)."
            />
          ) : (
            <ul className="space-y-2">
              {seriesQ.data!.map((s) => (
                <li key={s.id} className="rounded-md border border-gray-200 bg-white p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <Link
                        href={`/publications/series/${s.id}`}
                        className="text-base font-semibold text-campus-700 hover:underline"
                      >
                        {s.title}
                      </Link>
                      {s.description && (
                        <p className="mt-1 text-sm text-gray-700">{s.description}</p>
                      )}
                      <p className="mt-1 text-xs text-gray-500">
                        {PUBLICATION_TYPE_LABELS[s.publicationType]} ·{' '}
                        {FREQUENCY_LABELS[s.frequency]}
                      </p>
                    </div>
                    <div className="text-right text-xs text-gray-500">
                      <div>{s.editionCount} editions</div>
                      <div>{s.subscriberCount} subscribers</div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
          Published
        </h2>
        {(publishedQ.data?.length ?? 0) === 0 ? (
          <p className="text-sm text-gray-500">No published publications yet.</p>
        ) : (
          <ul className="space-y-2">
            {publishedQ.data!.map((p) => (
              <li key={p.id} className="rounded-md border border-gray-200 bg-white p-3">
                <div className="flex items-center justify-between">
                  <div>
                    <Link
                      href={`/publications/${p.id}`}
                      className="font-medium text-campus-700 hover:underline"
                    >
                      {p.title}
                    </Link>
                    <p className="text-xs text-gray-500">
                      {PUBLICATION_TYPE_LABELS[p.publicationType]}
                      {p.seriesTitle ? ` · ${p.seriesTitle}` : ''}
                      {p.editionNumber ? ` · #${p.editionNumber}` : ''} ·{' '}
                      {formatDate(p.publishedAt)}
                    </p>
                  </div>
                  <span className={`rounded px-2 py-0.5 text-xs ${STATUS_PILL[p.status]}`}>
                    {p.status}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
