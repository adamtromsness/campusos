'use client';

import { PageHeader, EmptyState } from '@/components/ui';
import { usePublicationAnalyticsSummary, usePublications } from '@/hooks/use-publications';
import { formatDateTime, formatEngagement } from '@/lib/publications-format';

export default function PublicationAnalyticsPage() {
  const summaryQ = usePublicationAnalyticsSummary();
  const pubsQ = usePublications({});
  const rows = summaryQ.data ?? [];
  const pubs = pubsQ.data ?? [];

  const titleById = new Map(pubs.map((p) => [p.id, p.title]));

  const sortedByViews = [...rows].sort((a, b) => b.totalViews - a.totalViews);

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <PageHeader
        title="Publication Analytics"
        description="School-wide engagement metrics across the 100 most recently active publications."
      />

      {summaryQ.error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          {summaryQ.error instanceof Error
            ? summaryQ.error.message
            : 'Failed to load analytics summary'}
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState
          title="No analytics data yet"
          description="Once readers view, open, or click links in published publications, the counters will appear here."
        />
      ) : (
        <>
          <section>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
              Most engaged publications
            </h2>
            <table className="w-full text-sm">
              <thead className="border-b border-gray-200 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="pb-2 pr-3">Publication</th>
                  <th className="pb-2 pr-3 text-right">Recipients</th>
                  <th className="pb-2 pr-3 text-right">Views</th>
                  <th className="pb-2 pr-3 text-right">Unique</th>
                  <th className="pb-2 pr-3 text-right">Opens</th>
                  <th className="pb-2 pr-3 text-right">Clicks</th>
                  <th className="pb-2 pr-3 text-right">Bounces</th>
                  <th className="pb-2 pr-3 text-right">Open rate</th>
                  <th className="pb-2 pr-3 text-right">Last event</th>
                </tr>
              </thead>
              <tbody>
                {sortedByViews.map((row) => (
                  <tr key={row.publicationId} className="border-b border-gray-100">
                    <td className="py-2 pr-3">
                      <p className="font-semibold text-campus-700">
                        {titleById.get(row.publicationId) ?? 'Unknown publication'}
                      </p>
                      <p className="text-xs text-gray-500">{row.publicationId}</p>
                    </td>
                    <td className="py-2 pr-3 text-right">{row.totalRecipients}</td>
                    <td className="py-2 pr-3 text-right">{row.totalViews}</td>
                    <td className="py-2 pr-3 text-right">{row.uniqueViews}</td>
                    <td className="py-2 pr-3 text-right">{row.totalOpens}</td>
                    <td className="py-2 pr-3 text-right">{row.totalLinkClicks}</td>
                    <td className="py-2 pr-3 text-right text-rose-700">{row.totalBounces}</td>
                    <td className="py-2 pr-3 text-right">
                      {formatEngagement(row.totalOpens, row.totalRecipients)}
                    </td>
                    <td className="py-2 pr-3 text-right text-xs text-gray-600">
                      {formatDateTime(row.lastEventAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}
