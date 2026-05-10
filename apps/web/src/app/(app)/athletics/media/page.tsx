'use client';

import { useState } from 'react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useAthleticsProgrammes } from '@/hooks/use-athletics';
import { useMediaAssets, type MediaAssetType } from '@/hooks/use-athletics-advanced';

const ASSET_TYPE_PILL: Record<MediaAssetType, string> = {
  PHOTO: 'bg-sky-100 text-sky-700',
  VIDEO: 'bg-violet-100 text-violet-700',
  DOCUMENT: 'bg-gray-100 text-gray-700',
  LOGO: 'bg-amber-100 text-amber-700',
};

const ASSET_TYPES: MediaAssetType[] = ['PHOTO', 'VIDEO', 'DOCUMENT', 'LOGO'];

export default function MediaGalleryPage() {
  const programmesQ = useAthleticsProgrammes();
  const [programmeId, setProgrammeId] = useState<string | null>(null);
  const [assetType, setAssetType] = useState<MediaAssetType | null>(null);
  const mediaQ = useMediaAssets({
    programmeId: programmeId ?? undefined,
    assetType: assetType ?? undefined,
  });

  return (
    <div className="space-y-6">
      <PageHeader title="Athletics Media" description="Team photos, videos, documents, and logos" />

      <div className="flex flex-wrap gap-2">
        <select
          value={programmeId ?? ''}
          onChange={(e) => setProgrammeId(e.target.value || null)}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm"
        >
          <option value="">All programmes</option>
          {programmesQ.data?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.sportName}
            </option>
          ))}
        </select>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => setAssetType(null)}
            className={`rounded-full px-3 py-1 text-sm ${
              assetType === null
                ? 'bg-campus-700 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            All
          </button>
          {ASSET_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setAssetType(t)}
              className={`rounded-full px-3 py-1 text-sm ${
                assetType === t
                  ? 'bg-campus-700 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {mediaQ.isLoading ? (
        <LoadingSpinner />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {mediaQ.data?.map((a) => (
            <div key={a.id} className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
              <div className="flex items-start justify-between gap-2">
                <div className="font-medium text-gray-900">{a.title ?? a.s3Key}</div>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${ASSET_TYPE_PILL[a.assetType]}`}
                >
                  {a.assetType}
                </span>
              </div>
              {a.description && <p className="mt-1 text-sm text-gray-600">{a.description}</p>}
              <div className="mt-3 text-xs text-gray-500 space-y-0.5">
                {a.programmeName && <div>{a.programmeName}</div>}
                <div>Uploaded {a.uploadedAt.slice(0, 10)}</div>
                {a.uploadedByName && <div>by {a.uploadedByName}</div>}
                <div className="font-mono truncate">{a.s3Key}</div>
              </div>
            </div>
          ))}
          {(mediaQ.data?.length ?? 0) === 0 && (
            <div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-gray-500 sm:col-span-2 lg:col-span-3">
              No media assets match these filters.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
