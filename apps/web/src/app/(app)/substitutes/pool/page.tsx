'use client';

import { useMemo, useState } from 'react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/cn';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  useAddToPool,
  useSchoolPool,
  useSubstituteSearch,
  useUpdatePoolMember,
} from '@/hooks/use-substitutes';
import {
  POOL_STATUS_LABEL,
  POOL_STATUS_PILL,
  formatDate,
  formatRating,
} from '@/lib/substitutes-format';
import type { PoolStatus, SchoolPoolMemberDto } from '@/lib/types';

export default function SchoolPoolPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin =
    !!user && hasAnyPermission(user, ['sch-001:admin', 'sch-004:write', 'sch-004:admin']);
  const pool = useSchoolPool(!!user);
  const addToPool = useAddToPool();
  const updateMember = useUpdatePoolMember();
  const [addOpen, setAddOpen] = useState(false);
  const [suspending, setSuspending] = useState<SchoolPoolMemberDto | null>(null);
  const [filter, setFilter] = useState<'ALL' | PoolStatus>('ALL');
  const { toast } = useToast();

  const filtered = useMemo(() => {
    const rows = pool.data ?? [];
    if (filter === 'ALL') return rows;
    return rows.filter((r) => r.status === filter);
  }, [pool.data, filter]);

  if (!user) return null;
  if (pool.isLoading) return <LoadingSpinner />;

  const counts = {
    ACTIVE: (pool.data ?? []).filter((r) => r.status === 'ACTIVE').length,
    SUSPENDED: (pool.data ?? []).filter((r) => r.status === 'SUSPENDED').length,
    REMOVED: (pool.data ?? []).filter((r) => r.status === 'REMOVED').length,
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Substitute Pool"
        description="Curated list of substitutes your school trusts. Pool members are notified first when a job is posted."
        actions={
          isAdmin ? (
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              className="rounded-lg bg-campus-600 px-4 py-2 text-sm font-medium text-white hover:bg-campus-700"
            >
              Add substitute
            </button>
          ) : undefined
        }
      />

      <div className="flex items-center gap-2 flex-wrap">
        <Chip
          label="All"
          count={pool.data?.length ?? 0}
          active={filter === 'ALL'}
          onClick={() => setFilter('ALL')}
        />
        {(['ACTIVE', 'SUSPENDED', 'REMOVED'] as PoolStatus[]).map((s) => (
          <Chip
            key={s}
            label={POOL_STATUS_LABEL[s]}
            count={counts[s]}
            active={filter === s}
            onClick={() => setFilter(s)}
          />
        ))}
      </div>

      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr className="text-left">
              <th className="px-4 py-2 font-medium text-gray-700">Substitute</th>
              <th className="px-4 py-2 font-medium text-gray-700">Rating</th>
              <th className="px-4 py-2 font-medium text-gray-700">Status</th>
              <th className="px-4 py-2 font-medium text-gray-700">Suspended until</th>
              <th className="px-4 py-2 font-medium text-gray-700">Added</th>
              {isAdmin && <th className="px-4 py-2"></th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filtered.length === 0 && (
              <tr>
                <td colSpan={isAdmin ? 6 : 5} className="px-4 py-6 text-center text-gray-500">
                  No substitutes in this view.
                </td>
              </tr>
            )}
            {filtered.map((m) => (
              <tr key={m.id}>
                <td className="px-4 py-3 text-gray-900">
                  <div className="font-medium">{m.substituteName ?? 'Unknown'}</div>
                  <div className="text-xs text-gray-500 font-mono">
                    {m.substituteId.slice(0, 8)}
                  </div>
                </td>
                <td className="px-4 py-3 text-gray-700">{formatRating(m.overallRating)}</td>
                <td className="px-4 py-3">
                  <span
                    className={cn(
                      'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
                      POOL_STATUS_PILL[m.status],
                    )}
                  >
                    {POOL_STATUS_LABEL[m.status]}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-700">
                  {m.suspendedUntil ? (
                    <div>
                      <div>{formatDate(m.suspendedUntil)}</div>
                      {m.suspensionReason && (
                        <div className="text-xs text-gray-500 mt-0.5 line-clamp-1">
                          {m.suspensionReason}
                        </div>
                      )}
                    </div>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="px-4 py-3 text-gray-700">{formatDate(m.addedAt)}</td>
                {isAdmin && (
                  <td className="px-4 py-3 text-right">
                    {m.status === 'ACTIVE' ? (
                      <button
                        type="button"
                        onClick={() => setSuspending(m)}
                        className="text-xs font-medium text-amber-600 hover:text-amber-700"
                      >
                        Suspend
                      </button>
                    ) : m.status === 'SUSPENDED' ? (
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await updateMember.mutateAsync({
                              id: m.id,
                              payload: { status: 'ACTIVE' },
                            });
                            toast('Reactivated', 'success');
                          } catch (e) {
                            toast(`Could not reactivate: ${(e as Error).message}`, 'error');
                          }
                        }}
                        className="text-xs font-medium text-emerald-600 hover:text-emerald-700"
                      >
                        Reactivate
                      </button>
                    ) : null}
                    {m.status !== 'REMOVED' && (
                      <button
                        type="button"
                        onClick={async () => {
                          if (
                            !window.confirm(
                              `Permanently remove ${m.substituteName ?? 'this substitute'} from the pool?`,
                            )
                          )
                            return;
                          try {
                            await updateMember.mutateAsync({
                              id: m.id,
                              payload: { status: 'REMOVED' },
                            });
                            toast('Removed', 'info');
                          } catch (e) {
                            toast(`Could not remove: ${(e as Error).message}`, 'error');
                          }
                        }}
                        className="ml-3 text-xs font-medium text-rose-600 hover:text-rose-700"
                      >
                        Remove
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {addOpen && (
        <AddToPoolModal
          open={addOpen}
          onClose={() => setAddOpen(false)}
          onSubmit={async ({ substituteId, notes }) => {
            try {
              await addToPool.mutateAsync({ substituteId, notes });
              toast('Added to pool', 'success');
              setAddOpen(false);
            } catch (e) {
              toast(`Could not add: ${(e as Error).message}`, 'error');
            }
          }}
          isPending={addToPool.isPending}
        />
      )}

      {suspending && (
        <SuspendModal
          member={suspending}
          onClose={() => setSuspending(null)}
          onSubmit={async ({ until, reason }) => {
            try {
              await updateMember.mutateAsync({
                id: suspending.id,
                payload: { status: 'SUSPENDED', suspendedUntil: until, suspensionReason: reason },
              });
              toast('Suspended', 'info');
              setSuspending(null);
            } catch (e) {
              toast(`Could not suspend: ${(e as Error).message}`, 'error');
            }
          }}
          isPending={updateMember.isPending}
        />
      )}
    </div>
  );
}

function Chip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-full px-3 py-1 text-xs font-medium ring-1 transition-colors',
        active
          ? 'bg-campus-600 text-white ring-campus-600'
          : 'bg-white text-gray-700 ring-gray-300 hover:bg-gray-50',
      )}
    >
      {label} ({count})
    </button>
  );
}

function AddToPoolModal({
  open,
  onClose,
  onSubmit,
  isPending,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (payload: { substituteId: string; notes?: string }) => Promise<void>;
  isPending: boolean;
}) {
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<{ id: string; displayName: string | null } | null>(null);
  const [notes, setNotes] = useState('');
  const results = useSubstituteSearch({ verifiedOnly: false }, search.length === 0 || true);

  const filtered = useMemo(() => {
    const rows = results.data ?? [];
    if (!search.trim()) return rows.slice(0, 20);
    const q = search.toLowerCase();
    return rows
      .filter(
        (r) =>
          (r.displayName ?? '').toLowerCase().includes(q) ||
          r.gradeLevels.some((g) => g.toLowerCase().includes(q)),
      )
      .slice(0, 20);
  }, [results.data, search]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add substitute to pool"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={isPending || !picked}
            onClick={() => onSubmit({ substituteId: picked!.id, notes: notes.trim() || undefined })}
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campus-700 disabled:opacity-50"
          >
            Add
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <input
          type="search"
          placeholder="Search by name or grade level..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded-md border border-gray-300 p-2 text-sm"
        />
        <div className="max-h-64 overflow-y-auto rounded-md border border-gray-200">
          {results.isLoading ? (
            <p className="p-3 text-sm text-gray-500">Loading…</p>
          ) : filtered.length === 0 ? (
            <p className="p-3 text-sm text-gray-500">No matching substitutes.</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {filtered.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => setPicked({ id: s.id, displayName: s.displayName })}
                    className={cn(
                      'w-full text-left px-3 py-2 text-sm hover:bg-gray-50',
                      picked?.id === s.id && 'bg-campus-50',
                    )}
                  >
                    <div className="font-medium text-gray-900">{s.displayName ?? '(no name)'}</div>
                    <div className="text-xs text-gray-500">
                      {s.gradeLevels.join(', ')} • {formatRating(s.overallRating)}
                      {' • '}
                      {s.totalAssignments} assignments
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <textarea
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Optional notes — visible only to school admins"
          className="w-full rounded-md border border-gray-300 p-2 text-sm"
        />
      </div>
    </Modal>
  );
}

function SuspendModal({
  member,
  onClose,
  onSubmit,
  isPending,
}: {
  member: SchoolPoolMemberDto;
  onClose: () => void;
  onSubmit: (payload: { until: string; reason: string }) => Promise<void>;
  isPending: boolean;
}) {
  const today = new Date();
  const defaultUntil = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const [until, setUntil] = useState(defaultUntil);
  const [reason, setReason] = useState('');

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={`Suspend ${member.substituteName ?? 'substitute'}`}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={isPending || !until || !reason.trim()}
            onClick={() => onSubmit({ until, reason })}
            className="rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
          >
            Suspend
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Suspended until</label>
          <input
            type="date"
            value={until}
            onChange={(e) => setUntil(e.target.value)}
            className="w-full rounded-md border border-gray-300 p-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Reason</label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            className="w-full rounded-md border border-gray-300 p-2 text-sm"
            placeholder="Why is this substitute being suspended?"
          />
        </div>
      </div>
    </Modal>
  );
}
