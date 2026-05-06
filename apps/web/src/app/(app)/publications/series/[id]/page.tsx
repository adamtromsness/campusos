'use client';

import Link from 'next/link';
import { PageHeader, useToast } from '@/components/ui';
import { useCreateEdition, useEditionsForSeries, useSeriesById } from '@/hooks/use-publications';
import {
  FREQUENCY_LABELS,
  PUBLICATION_TYPE_LABELS,
  STATUS_PILL,
  formatDate,
} from '@/lib/publications-format';

export default function SeriesPage({ params }: { params: { id: string } }) {
  const seriesQ = useSeriesById(params.id);
  const editionsQ = useEditionsForSeries(params.id);
  const create = useCreateEdition(params.id);
  const { toast } = useToast();

  const handleCreateEdition = async () => {
    try {
      await create.mutateAsync({});
      toast('New edition created');
    } catch (err) {
      toast(`Failed: ${(err as Error).message}`, 'error');
    }
  };

  if (!seriesQ.data) return <p className="p-6 text-sm text-gray-500">Loading…</p>;
  const s = seriesQ.data;

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <PageHeader
        title={s.title}
        description={
          PUBLICATION_TYPE_LABELS[s.publicationType] + ' · ' + FREQUENCY_LABELS[s.frequency]
        }
      />

      {s.description && <p className="text-sm text-gray-700">{s.description}</p>}

      <div className="grid grid-cols-3 gap-3 text-center">
        <div className="rounded-md border border-gray-200 bg-white p-3">
          <div className="text-xs uppercase text-gray-500">Editions</div>
          <div className="text-2xl font-semibold">{s.editionCount}</div>
        </div>
        <div className="rounded-md border border-gray-200 bg-white p-3">
          <div className="text-xs uppercase text-gray-500">Subscribers</div>
          <div className="text-2xl font-semibold">{s.subscriberCount}</div>
        </div>
        <div className="rounded-md border border-gray-200 bg-white p-3">
          <div className="text-xs uppercase text-gray-500">Status</div>
          <div className="mt-1 text-sm">{s.isActive ? 'Active' : 'Inactive'}</div>
        </div>
      </div>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Editions</h2>
          <button
            type="button"
            onClick={handleCreateEdition}
            className="rounded-md bg-campus-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-800"
          >
            New edition
          </button>
        </div>
        {(editionsQ.data?.length ?? 0) === 0 ? (
          <p className="text-sm text-gray-500">No editions yet.</p>
        ) : (
          <ul className="space-y-2">
            {editionsQ.data!.map((e) => (
              <li key={e.id} className="rounded-md border border-gray-200 bg-white p-3">
                <div className="flex items-center justify-between">
                  <div>
                    <Link
                      href={`/publications/editions/${e.id}`}
                      className="font-medium text-campus-700 hover:underline"
                    >
                      Edition #{e.editionNumber}
                      {e.editionLabel ? ` — ${e.editionLabel}` : ''}
                    </Link>
                    <p className="text-xs text-gray-500">
                      {e.theme ? `${e.theme} · ` : ''}
                      {e.editorName ? `Editor: ${e.editorName} · ` : ''}
                      {e.publishedAt ? `Published ${formatDate(e.publishedAt)}` : 'Draft'}
                    </p>
                  </div>
                  <span className={`rounded px-2 py-0.5 text-xs ${STATUS_PILL[e.status]}`}>
                    {e.status}
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
