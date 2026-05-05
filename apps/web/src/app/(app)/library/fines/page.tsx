'use client';

import Link from 'next/link';
import { useState } from 'react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  FINE_STATUS_PILL,
  FINE_TYPE_PILL,
  LIBRARY_FINE_STATUS_LABELS,
  LIBRARY_FINE_TYPE_LABELS,
  formatCurrency,
  formatRelative,
} from '@/lib/library-format';
import { useFines, usePayFine, useWaiveFine } from '@/hooks/use-library';
import type { LibraryFineDto, LibraryFineStatus } from '@/lib/types';

const STATUS_CHIPS: { key: LibraryFineStatus | 'ALL'; label: string }[] = [
  { key: 'OUTSTANDING', label: 'Outstanding' },
  { key: 'PAID', label: 'Paid' },
  { key: 'WAIVED', label: 'Waived' },
  { key: 'ALL', label: 'All' },
];

export default function FinesPage() {
  const user = useAuthStore((s) => s.user);
  const isLibrarian = !!user && hasAnyPermission(user, ['sch-001:admin', 'lib-001:write']);
  const isAdmin = !!user && hasAnyPermission(user, ['sch-001:admin']);

  const [filter, setFilter] = useState<LibraryFineStatus | 'ALL'>('OUTSTANDING');
  const finesQ = useFines({
    status: filter === 'ALL' ? undefined : filter,
  });
  const fines = finesQ.data ?? [];

  const total = fines
    .filter((f) => f.status === 'OUTSTANDING')
    .reduce((s, f) => s + Number(f.amount), 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Library fines"
        description={
          isLibrarian
            ? 'Manage outstanding fines. Mark as paid when collected; admins can waive.'
            : 'Your library fines. Visit the librarian to pay.'
        }
      />

      {isLibrarian && (
        <Link href="/library" className="text-sm font-medium text-campus-700 hover:text-campus-800">
          ← Back to library
        </Link>
      )}

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <div className="text-xs uppercase tracking-wide text-gray-500">Outstanding total</div>
          <div className="mt-1 text-2xl font-semibold text-rose-700">{formatCurrency(total)}</div>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <div className="text-xs uppercase tracking-wide text-gray-500">Outstanding count</div>
          <div className="mt-1 text-2xl font-semibold text-gray-900">
            {fines.filter((f) => f.status === 'OUTSTANDING').length}
          </div>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <div className="text-xs uppercase tracking-wide text-gray-500">
            Total fines (any status)
          </div>
          <div className="mt-1 text-2xl font-semibold text-gray-900">{fines.length}</div>
        </div>
      </section>

      <div className="flex flex-wrap gap-2">
        {STATUS_CHIPS.map((c) => (
          <button
            key={c.key}
            onClick={() => setFilter(c.key)}
            className={
              'rounded-full px-3 py-1 text-xs font-medium transition ' +
              (filter === c.key
                ? 'bg-campus-600 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200')
            }
          >
            {c.label}
          </button>
        ))}
      </div>

      {finesQ.isLoading ? (
        <LoadingSpinner />
      ) : fines.length === 0 ? (
        <p className="rounded-md border border-gray-200 bg-white p-5 text-sm text-gray-600">
          No fines match this filter.
        </p>
      ) : (
        <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
          {fines.map((f) => (
            <FineRow key={f.id} fine={f} isLibrarian={isLibrarian} isAdmin={isAdmin} />
          ))}
        </ul>
      )}
    </div>
  );
}

function FineRow({
  fine,
  isLibrarian,
  isAdmin,
}: {
  fine: LibraryFineDto;
  isLibrarian: boolean;
  isAdmin: boolean;
}) {
  const [waiveOpen, setWaiveOpen] = useState(false);
  const payFine = usePayFine();
  const waiveFine = useWaiveFine();
  const toast = useToast();

  return (
    <li className="flex items-center justify-between gap-4 p-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-gray-900">{fine.itemTitle ?? '—'}</span>
          <span
            className={'rounded px-2 py-0.5 text-xs font-medium ' + FINE_TYPE_PILL[fine.fineType]}
          >
            {LIBRARY_FINE_TYPE_LABELS[fine.fineType]}
          </span>
          <span
            className={'rounded px-2 py-0.5 text-xs font-medium ' + FINE_STATUS_PILL[fine.status]}
          >
            {LIBRARY_FINE_STATUS_LABELS[fine.status]}
          </span>
        </div>
        <div className="mt-1 text-xs text-gray-500">
          {fine.patronName ?? fine.patronId.slice(0, 8)}
          {fine.daysOverdue !== null ? ` · ${fine.daysOverdue} days late` : ''} · created{' '}
          {formatRelative(fine.createdAt)}
        </div>
      </div>
      <div className="flex flex-col items-end gap-2">
        <div className="text-lg font-semibold text-gray-900">
          {formatCurrency(Number(fine.amount))}
        </div>
        {isLibrarian && fine.status === 'OUTSTANDING' && (
          <div className="flex gap-2 text-xs">
            <button
              onClick={async () => {
                try {
                  await payFine.mutateAsync(fine.id);
                  toast.toast('Marked paid.');
                } catch (err) {
                  toast.toast(err instanceof Error ? err.message : 'Could not mark paid', 'error');
                }
              }}
              disabled={payFine.isPending}
              className="rounded-md bg-emerald-600 px-2 py-1 font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
            >
              {payFine.isPending ? 'Paying…' : 'Mark paid'}
            </button>
            {isAdmin && (
              <button
                onClick={() => setWaiveOpen(true)}
                className="rounded-md border border-gray-300 bg-white px-2 py-1 font-medium text-gray-800 hover:bg-gray-50"
              >
                Waive
              </button>
            )}
          </div>
        )}
      </div>

      <Modal open={waiveOpen} onClose={() => setWaiveOpen(false)} title="Waive fine" footer={null}>
        <WaiveForm
          onSubmit={async (reason) => {
            try {
              await waiveFine.mutateAsync({ id: fine.id, body: { reason } });
              toast.toast('Fine waived.');
              setWaiveOpen(false);
            } catch (err) {
              toast.toast(err instanceof Error ? err.message : 'Could not waive fine', 'error');
            }
          }}
          submitting={waiveFine.isPending}
        />
      </Modal>
    </li>
  );
}

function WaiveForm({
  onSubmit,
  submitting,
}: {
  onSubmit: (reason: string) => Promise<void>;
  submitting: boolean;
}) {
  const [reason, setReason] = useState('');
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!reason.trim()) return;
        await onSubmit(reason.trim());
      }}
      className="space-y-3"
    >
      <p className="text-sm text-gray-700">
        Waiving a fine writes off the amount. The reason is recorded for audit.
      </p>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={3}
        maxLength={2000}
        required
        placeholder="Reason for waiver"
        className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
      />
      <button
        type="submit"
        disabled={submitting || !reason.trim()}
        className="rounded-md bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-60"
      >
        {submitting ? 'Waiving…' : 'Waive fine'}
      </button>
    </form>
  );
}
