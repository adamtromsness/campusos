'use client';

import { useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';
import { useMyActionItems, useUpdateActionItem } from '@/hooks/use-meetings';
import type { ActionItemStatus } from '@/lib/types';

const STATUS_PILL: Record<ActionItemStatus, string> = {
  OPEN: 'bg-rose-100 text-rose-800',
  IN_PROGRESS: 'bg-amber-100 text-amber-800',
  DONE: 'bg-emerald-100 text-emerald-800',
  CANCELLED: 'bg-gray-100 text-gray-700',
};

function isOverdue(dueDate: string | null, status: ActionItemStatus) {
  if (!dueDate || status === 'DONE' || status === 'CANCELLED') return false;
  return new Date(dueDate) < new Date();
}

export default function ActionItemsPage() {
  const [filter, setFilter] = useState<ActionItemStatus | 'ALL'>('OPEN');
  const { data: items } = useMyActionItems(
    filter === 'ALL' ? undefined : (filter as ActionItemStatus),
  );
  const update = useUpdateActionItem();
  const { toast } = useToast();

  const sorted = (items ?? []).slice().sort((a, b) => {
    const ad = a.dueDate ?? '9999-12-31';
    const bd = b.dueDate ?? '9999-12-31';
    return ad.localeCompare(bd);
  });

  return (
    <div className="mx-auto w-full max-w-5xl">
      <PageHeader
        title="My action items"
        description="Action items assigned to you across every meeting. Mark them done as you complete each one."
        actions={
          <Link
            href="/meetings"
            className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            ← All meetings
          </Link>
        }
      />

      <div className="mt-3 inline-flex rounded-lg bg-gray-100 p-1">
        {(['OPEN', 'IN_PROGRESS', 'DONE', 'ALL'] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={
              'rounded-md px-3 py-1.5 text-sm font-semibold transition ' +
              (filter === f ? 'bg-white text-campus-900 shadow-sm' : 'text-gray-700')
            }
          >
            {f.replace(/_/g, ' ')}
          </button>
        ))}
      </div>

      <div className="mt-4 space-y-2">
        {sorted.length === 0 ? (
          <EmptyState
            title="No action items"
            description="Action items assigned to you in meetings will appear here."
          />
        ) : (
          sorted.map((a) => {
            const overdue = isOverdue(a.dueDate, a.status);
            return (
              <div
                key={a.id}
                className={
                  'rounded-lg border p-4 shadow-sm ' +
                  (overdue ? 'border-rose-300 bg-rose-50' : 'border-gray-200 bg-white')
                }
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={
                          'rounded-full px-2 py-0.5 text-xs font-semibold ' + STATUS_PILL[a.status]
                        }
                      >
                        {a.status.replace(/_/g, ' ')}
                      </span>
                      {overdue && (
                        <span className="rounded-full bg-rose-700 px-2 py-0.5 text-xs font-semibold text-white">
                          Overdue
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-sm text-gray-900">{a.description}</p>
                    <p className="mt-1 text-xs text-gray-500">
                      <Link
                        href={'/meetings/' + a.meetingId}
                        className="text-campus-700 hover:underline"
                      >
                        {a.meetingTitle ?? 'Meeting'}
                      </Link>
                      {a.dueDate ? ' · due ' + a.dueDate : ''}
                    </p>
                  </div>
                  {a.status !== 'DONE' && a.status !== 'CANCELLED' && (
                    <div className="flex shrink-0 flex-col gap-1">
                      {a.status === 'OPEN' && (
                        <button
                          type="button"
                          onClick={() =>
                            update.mutate(
                              { id: a.id, input: { status: 'IN_PROGRESS' } },
                              {
                                onSuccess: () => toast('Marked in progress', 'success'),
                              },
                            )
                          }
                          className="rounded-md border border-amber-700 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-800 hover:bg-amber-100"
                        >
                          Start
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          update.mutate(
                            { id: a.id, input: { status: 'DONE' } },
                            {
                              onSuccess: () => toast('Marked done', 'success'),
                            },
                          )
                        }
                        className="rounded-md border border-emerald-700 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800 hover:bg-emerald-100"
                      >
                        Done
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
