'use client';

import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { useLiveStreams } from '@/hooks/use-athletics-advanced';

const ACCESS_LABEL: Record<string, string> = {
  PUBLIC: 'Public',
  SCHOOL_ONLY: 'School only',
  BOTH_SCHOOLS: 'Both schools',
  COACHES_ONLY: 'Coaches only',
};

const STATUS_PILL: Record<string, string> = {
  SCHEDULED: 'bg-gray-100 text-gray-700',
  LIVE: 'bg-rose-100 text-rose-700 animate-pulse',
  ENDED: 'bg-emerald-100 text-emerald-700',
  FAILED: 'bg-amber-100 text-amber-700',
};

export default function StreamingPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = hasAnyPermission(user, ['sch-001:admin']);
  const isAd = isAdmin || hasAnyPermission(user, ['ath-005:write']);
  const liveQ = useLiveStreams();

  if (!isAd) {
    return (
      <div className="space-y-6">
        <PageHeader title="Streaming" description="Game streams + highlight clips + recordings" />
        <div className="rounded-xl border border-gray-200 bg-white p-6 text-center text-sm text-gray-500">
          Streaming management is restricted to the Athletic Director.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Streaming"
        description="Per-game streams, highlight clips with consent gating, and recordings (ADR-068)"
      />

      <section className="rounded-xl border border-gray-200 bg-white p-6">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">Live now</h2>
        {liveQ.isLoading ? (
          <LoadingSpinner />
        ) : liveQ.data && liveQ.data.length > 0 ? (
          <div className="space-y-2">
            {liveQ.data.map((s) => (
              <div
                key={s.id}
                className="flex items-center justify-between rounded-lg border border-gray-200 p-3"
              >
                <div>
                  <div className="font-medium text-gray-900">Stream {s.id.slice(0, 8)}</div>
                  <div className="text-xs text-gray-500">
                    Game {s.gameId.slice(0, 8)} · {ACCESS_LABEL[s.accessLevel]}
                  </div>
                </div>
                <span
                  className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_PILL[s.streamStatus]}`}
                >
                  {s.streamStatus}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-gray-500">No streams currently live.</p>
        )}
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-6">
        <h2 className="mb-2 text-lg font-semibold text-gray-900">Highlight clip workflow</h2>
        <p className="text-sm text-gray-600">
          Per ADR-068, athletic events are public performances — clips can be extracted from streams
          without photo-privacy flags. However, before a clip is added to a student portfolio, the
          student or a linked guardian must record consent. The schema enforces this with a
          multi-column CHECK that rejects added_to_portfolio = true unless consent_status =
          CONSENTED.
        </p>
      </section>
    </div>
  );
}
