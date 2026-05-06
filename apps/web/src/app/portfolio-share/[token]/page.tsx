'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import {
  ACHIEVEMENT_TYPE_LABELS,
  ACHIEVEMENT_TYPE_PILL,
  ITEM_TYPE_LABELS,
  ITEM_TYPE_PILL,
  formatDate,
} from '@/lib/portfolio-format';
import type { PublicPortfolioViewDto } from '@/lib/types';

/**
 * Public unauthenticated portfolio share view. Lands at
 * /portfolio-share/:token (intentionally distinct from the
 * authenticated /portfolio routes inside the (app) layout).
 *
 * The API endpoint is GET /portfolio/share/:token; the URL we
 * advertise to recipients carries the same path but without
 * authentication.
 *
 * 410 Gone (revoked or expired) is rendered as a friendly card.
 */
export default function PublicSharePage({ params }: { params: { token: string } }) {
  const [data, setData] = useState<PublicPortfolioViewDto | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const view = await apiFetch<PublicPortfolioViewDto>(
          `/api/v1/portfolio/share/${params.token}`,
        );
        if (!cancelled) setData(view);
      } catch (err) {
        if (cancelled) return;
        const e = err as { status?: number; message?: string };
        setError({ status: e.status ?? 0, message: e.message ?? 'Unknown error' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params.token]);

  if (error) {
    if (error.status === 410) {
      return (
        <div className="mx-auto max-w-2xl p-12">
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-8 text-center">
            <h1 className="text-2xl font-semibold text-amber-900">Share link unavailable</h1>
            <p className="mt-2 text-sm text-amber-800">
              This portfolio link has expired or been revoked by the student.
            </p>
          </div>
        </div>
      );
    }
    return (
      <div className="mx-auto max-w-2xl p-12">
        <div className="rounded-lg border border-rose-300 bg-rose-50 p-8 text-center">
          <h1 className="text-2xl font-semibold text-rose-900">Portfolio not found</h1>
          <p className="mt-2 text-sm text-rose-800">{error.message}</p>
        </div>
      </div>
    );
  }

  if (!data) {
    return <p className="p-12 text-center text-sm text-gray-500">Loading portfolio…</p>;
  }

  return (
    <div className="mx-auto max-w-4xl p-6 md:p-12">
      <header className="mb-8 border-b border-gray-200 pb-6">
        <h1 className="text-3xl font-semibold text-gray-900">{data.title}</h1>
        <p className="mt-2 text-sm text-gray-500">
          {data.studentName ? `${data.studentName} · ` : ''}
          {data.schoolName}
        </p>
        {data.description && <p className="mt-3 text-base text-gray-700">{data.description}</p>}
      </header>

      {data.featuredItems.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-amber-700">
            ★ Featured
          </h2>
          <ul className="space-y-3">
            {data.featuredItems.map((it) => (
              <li key={it.id} className="rounded-md border border-amber-200 bg-amber-50/40 p-4">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-semibold text-gray-900">{it.title}</p>
                  <span className={`rounded px-2 py-0.5 text-xs ${ITEM_TYPE_PILL[it.itemType]}`}>
                    {ITEM_TYPE_LABELS[it.itemType]}
                  </span>
                </div>
                {it.sourceTitle && (
                  <p className="mt-1 text-xs text-gray-500">From: {it.sourceTitle}</p>
                )}
                {it.description && <p className="mt-2 text-sm text-gray-700">{it.description}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">Items</h2>
        {data.items.length === 0 ? (
          <p className="text-sm text-gray-500">No items yet.</p>
        ) : (
          <ul className="space-y-2">
            {data.items.map((it) => (
              <li key={it.id} className="rounded-md border border-gray-200 bg-white p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium text-gray-900">{it.title}</p>
                    {it.sourceTitle && <p className="text-xs text-gray-500">{it.sourceTitle}</p>}
                    {it.description && (
                      <p className="mt-1 text-sm text-gray-700">{it.description}</p>
                    )}
                  </div>
                  <span className={`rounded px-2 py-0.5 text-xs ${ITEM_TYPE_PILL[it.itemType]}`}>
                    {ITEM_TYPE_LABELS[it.itemType]}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {data.achievements.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
            Achievements
          </h2>
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {data.achievements.map((a) => (
              <li key={a.id} className="rounded-md border border-gray-200 bg-white p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold text-gray-900">{a.title}</p>
                    <p className="text-xs text-gray-500">{formatDate(a.awardedAt)}</p>
                  </div>
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${ACHIEVEMENT_TYPE_PILL[a.achievementType]}`}
                  >
                    {ACHIEVEMENT_TYPE_LABELS[a.achievementType]}
                  </span>
                </div>
                {a.description && <p className="mt-2 text-sm text-gray-700">{a.description}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="border-t border-gray-200 pt-6 text-center text-xs text-gray-400">
        Powered by CampusOS
      </footer>
    </div>
  );
}
