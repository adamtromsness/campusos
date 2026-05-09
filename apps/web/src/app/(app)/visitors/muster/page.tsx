'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { useCreateMuster, useMusters } from '@/hooks/use-visitors';
import type { DrillType } from '@/lib/types';
import { DRILL_TYPES, DRILL_TYPE_LABEL, formatDateTime } from '@/lib/visitors-format';

/**
 * /visitors/muster — emergency muster control + history.
 *
 * Big rose button "Create Muster Snapshot" creates a snapshot of all
 * currently signed-in visitors and routes to the per-muster
 * accountability tracker.
 */
export default function MusterListPage() {
  const router = useRouter();
  const { toast } = useToast();
  const mustersQ = useMusters();
  const createMuster = useCreateMuster();
  const [drillType, setDrillType] = useState<DrillType>('FIRE_DRILL');
  const [description, setDescription] = useState('');

  async function handleCreate() {
    if (
      !confirm(
        'Create an emergency muster snapshot now? This will snapshot every currently signed-in visitor.',
      )
    ) {
      return;
    }
    try {
      const r = await createMuster.mutateAsync({
        drillType,
        description: description.trim() || undefined,
      });
      toast(
        'Muster created — ' + r.muster.totalOnSiteAtSnapshot + ' visitor(s) snapshotted',
        'success',
      );
      router.push('/visitors/muster/' + r.muster.id);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Emergency muster"
        description="One-click snapshot of every currently signed-in visitor for fire drills, lockdowns, and evacuations."
      />

      <section className="rounded-lg border-2 border-rose-300 bg-rose-50 p-6">
        <h2 className="text-lg font-semibold text-rose-900">Start a new muster</h2>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <select
            value={drillType}
            onChange={(e) => setDrillType(e.target.value as DrillType)}
            className="rounded border border-gray-300 px-3 py-2 text-sm"
          >
            {DRILL_TYPES.map((t) => (
              <option key={t} value={t}>
                {DRILL_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
          <input
            type="text"
            placeholder="Description (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <button
          onClick={handleCreate}
          disabled={createMuster.isPending}
          className="mt-4 w-full rounded-md bg-rose-700 px-4 py-3 text-base font-semibold text-white hover:bg-rose-800 disabled:opacity-50"
        >
          {createMuster.isPending ? 'Creating snapshot…' : '🚨 Create muster snapshot'}
        </button>
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="text-base font-semibold text-gray-900">Recent musters</h2>
        {mustersQ.isLoading ? (
          <LoadingSpinner />
        ) : mustersQ.data && mustersQ.data.length > 0 ? (
          <ul className="mt-4 space-y-2">
            {mustersQ.data.map((m) => (
              <li
                key={m.id}
                className="flex items-center justify-between rounded border border-gray-100 px-3 py-2"
              >
                <div>
                  <Link
                    href={'/visitors/muster/' + m.id}
                    className="font-medium text-campus-700 hover:underline"
                  >
                    {DRILL_TYPE_LABEL[m.drillType]}
                  </Link>
                  <div className="text-xs text-gray-500">
                    {formatDateTime(m.createdAt)} · {m.totalOnSiteAtSnapshot} on site
                    {m.closedAt ? ' · closed ' + formatDateTime(m.closedAt) : ' · OPEN'}
                  </div>
                </div>
                <Link
                  href={'/visitors/muster/' + m.id}
                  className="text-sm font-medium text-campus-700 hover:underline"
                >
                  View →
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            title="No musters"
            description="Recent fire drills and emergencies will appear here."
          />
        )}
      </section>
    </div>
  );
}
