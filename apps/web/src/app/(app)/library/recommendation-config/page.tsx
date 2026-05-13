'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { useRecommendationConfig, useUpdateRecommendationConfig } from '@/hooks/use-library';
import type { UpdateRecommendationWeightsPayload } from '@/lib/types';

/**
 * /library/recommendation-config — School admin configures the
 * recommendation engine's 5-strategy weights. The librarian role
 * reads but cannot mutate this surface; only school admins (or
 * holders of lib-002:admin / lib-003:admin) update.
 *
 * Persisted under school_config key `library_recommendation_weights`.
 * The LibraryRecommendationWorker normalises each strategy's raw
 * scores then applies these weights before producing the final
 * ranked list.
 */
export default function RecommendationConfigPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin =
    !!user && hasAnyPermission(user, ['sch-001:admin', 'lib-002:admin', 'lib-003:admin']);
  const isLibrarian =
    !!user && hasAnyPermission(user, ['sch-001:admin', 'lib-002:write', 'lib-002:read']);

  const cfgQ = useRecommendationConfig(isLibrarian);
  const update = useUpdateRecommendationConfig();
  const { toast } = useToast();

  const [draft, setDraft] = useState<UpdateRecommendationWeightsPayload>({});
  useEffect(() => {
    if (cfgQ.data) setDraft(cfgQ.data);
  }, [cfgQ.data]);

  const sum = useMemo(() => {
    const w = { ...(cfgQ.data ?? {}), ...draft };
    return (
      (w.collaborativeFiltering ?? 0) +
      (w.readingLevelMatch ?? 0) +
      (w.subjectMatch ?? 0) +
      (w.newArrival ?? 0) +
      (w.staffPick ?? 0)
    );
  }, [cfgQ.data, draft]);

  if (!user) return null;
  if (!isLibrarian) {
    return (
      <EmptyState
        title="Librarian access required"
        description="Recommendation engine configuration is managed by librarians and school admins."
      />
    );
  }

  function save() {
    if (Math.abs(sum - 100) > 0.5) {
      toast('Weights must sum to 100 (current: ' + sum.toFixed(1) + ')', 'error');
      return;
    }
    update.mutate(draft, {
      onSuccess: () => toast('Recommendation weights updated', 'success'),
      onError: (err) => toast((err as Error).message, 'error'),
    });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Recommendation engine"
        description="Tune the per-school weight blend across the 5 scoring strategies."
      />

      <Link href="/library" className="text-sm font-medium text-campus-700 hover:text-campus-800">
        ← Back to library
      </Link>

      <div className="rounded-md bg-sky-50 p-3 text-sm text-sky-900">
        <strong>How it works:</strong> the LibraryRecommendationWorker normalises each
        strategy&apos;s raw scores then applies these weights to produce the final ranked list per
        student. The 5 weights must sum to <strong>100</strong>. School admins can rebalance to
        prioritise reading level alignment over collaborative filtering, or any other blend.
      </div>

      {cfgQ.isLoading || !cfgQ.data ? (
        <LoadingSpinner />
      ) : (
        <div className="space-y-3 rounded-lg border border-gray-200 bg-white p-5">
          <WeightRow
            label="Collaborative filtering"
            description="Students who read X also read Y. Co-checkout frequency."
            value={draft.collaborativeFiltering ?? cfgQ.data.collaborativeFiltering}
            onChange={(v) => setDraft((d) => ({ ...d, collaborativeFiltering: v }))}
            readonly={!isAdmin}
          />
          <WeightRow
            label="Reading level match"
            description="±50 Lexile or AR band alignment with the student's reading level."
            value={draft.readingLevelMatch ?? cfgQ.data.readingLevelMatch}
            onChange={(v) => setDraft((d) => ({ ...d, readingLevelMatch: v }))}
            readonly={!isAdmin}
          />
          <WeightRow
            label="Subject match"
            description="Catalogue subject tags overlapping the student's checkout history."
            value={draft.subjectMatch ?? cfgQ.data.subjectMatch}
            onChange={(v) => setDraft((d) => ({ ...d, subjectMatch: v }))}
            readonly={!isAdmin}
          />
          <WeightRow
            label="New arrival"
            description="Items catalogued in the last 30 days matching the student's interests."
            value={draft.newArrival ?? cfgQ.data.newArrival}
            onChange={(v) => setDraft((d) => ({ ...d, newArrival: v }))}
            readonly={!isAdmin}
          />
          <WeightRow
            label="Staff pick"
            description="Librarian-curated picks from published GENERAL reading lists."
            value={draft.staffPick ?? cfgQ.data.staffPick}
            onChange={(v) => setDraft((d) => ({ ...d, staffPick: v }))}
            readonly={!isAdmin}
          />

          <div className="flex items-center justify-between border-t border-gray-200 pt-3">
            <div className="text-sm">
              <span className="text-gray-600">Total:</span>{' '}
              <span
                className={
                  'font-semibold ' +
                  (Math.abs(sum - 100) > 0.5 ? 'text-rose-700' : 'text-emerald-700')
                }
              >
                {sum.toFixed(1)} / 100
              </span>
            </div>
            {isAdmin && (
              <button
                type="button"
                onClick={save}
                disabled={update.isPending || Math.abs(sum - 100) > 0.5}
                className="rounded-md bg-campus-600 px-4 py-2 text-sm font-medium text-white hover:bg-campus-700 disabled:opacity-50"
              >
                Save weights
              </button>
            )}
          </div>
          {!isAdmin && (
            <div className="text-xs text-gray-500">
              Read-only — only school admins can update recommendation weights.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function WeightRow({
  label,
  description,
  value,
  onChange,
  readonly,
}: {
  label: string;
  description: string;
  value: number;
  onChange: (v: number) => void;
  readonly: boolean;
}) {
  return (
    <div className="grid grid-cols-12 items-center gap-3 border-b border-gray-100 py-2 last:border-b-0">
      <div className="col-span-7">
        <div className="font-medium text-gray-900">{label}</div>
        <div className="text-xs text-gray-600">{description}</div>
      </div>
      <div className="col-span-3">
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={value}
          disabled={readonly}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-full"
        />
      </div>
      <div className="col-span-2">
        <input
          type="number"
          min={0}
          max={100}
          value={value}
          disabled={readonly}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-full rounded-md border border-gray-300 px-2 py-1 text-right text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
        />
      </div>
    </div>
  );
}
