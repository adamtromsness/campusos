'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/ui';
import { usePublication, useSections } from '@/hooks/use-publications';
import {
  PUBLICATION_TYPE_LABELS,
  ROLE_PILL,
  SECTION_TYPE_LABELS,
  STATUS_PILL,
  formatDate,
} from '@/lib/publications-format';

export default function PublicationDetailPage({ params }: { params: { id: string } }) {
  const pubQ = usePublication(params.id);
  const sectionsQ = useSections(params.id);

  if (!pubQ.data) return <p className="p-6 text-sm text-gray-500">Loading…</p>;
  const p = pubQ.data;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <PageHeader
        title={p.title}
        description={
          PUBLICATION_TYPE_LABELS[p.publicationType] +
          (p.seriesTitle ? ` · ${p.seriesTitle}` : '') +
          (p.editionNumber ? ` · Edition #${p.editionNumber}` : '')
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded px-2 py-0.5 text-xs ${STATUS_PILL[p.status]}`}>{p.status}</span>
        {p.publishedAt && (
          <span className="text-xs text-gray-500">Published {formatDate(p.publishedAt)}</span>
        )}
        <Link
          href={`/publications/${p.id}/delivery`}
          className="ml-auto rounded-md border border-gray-300 px-3 py-1.5 text-xs hover:bg-gray-50"
        >
          Delivery dashboard
        </Link>
        {p.editionId && (
          <Link
            href={`/publications/editions/${p.editionId}`}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-xs hover:bg-gray-50"
          >
            Edit edition
          </Link>
        )}
      </div>

      {p.collaborators.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
            Collaborators
          </h2>
          <ul className="flex flex-wrap gap-2">
            {p.collaborators.map((c) => (
              <li
                key={c.id}
                className="flex items-center gap-2 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs"
              >
                <span>{c.userName ?? c.userId.slice(0, 8)}</span>
                <span className={`rounded px-1.5 py-0.5 text-[10px] ${ROLE_PILL[c.role]}`}>
                  {c.role}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
          Sections
        </h2>
        {(sectionsQ.data?.length ?? 0) === 0 ? (
          <p className="text-sm text-gray-500">No sections yet.</p>
        ) : (
          <ul className="space-y-3">
            {sectionsQ.data!.map((sec) => (
              <li
                key={sec.id}
                className={`rounded-md border p-4 ${sec.isApproved ? 'border-gray-200 bg-white' : 'border-amber-300 bg-amber-50/40'}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="font-semibold text-gray-900">{sec.title}</h3>
                    <p className="text-xs text-gray-500">
                      {SECTION_TYPE_LABELS[sec.sectionType]}
                      {sec.ownerName ? ` · ${sec.ownerName}` : ''}
                      {!sec.isApproved && ' · pending approval'}
                    </p>
                  </div>
                  {sec.isApproved ? (
                    <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700">
                      Approved
                    </span>
                  ) : (
                    <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-700">
                      Pending
                    </span>
                  )}
                </div>
                {sec.body && (
                  <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-gray-800">
                    {sec.body}
                  </p>
                )}
                {sec.contributors.length > 0 && (
                  <p className="mt-3 text-xs text-gray-500">
                    Contributors:{' '}
                    {sec.contributors
                      .map((c) => c.contributorName ?? c.contributorId.slice(0, 8))
                      .join(', ')}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
