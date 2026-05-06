'use client';

import { useState } from 'react';
import Link from 'next/link';
import { PageHeader, Modal, useToast } from '@/components/ui';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { useJournalBatches, usePostJournalBatch, useVoidJournalBatch } from '@/hooks/use-finance';
import {
  BATCH_STATUS_LABELS,
  BATCH_STATUS_PILL,
  BATCH_TYPE_LABELS,
  formatCurrency,
  formatDateTime,
} from '@/lib/finance-format';
import type { FinJournalBatchDto } from '@/lib/types';

export default function JournalsPage() {
  const { user } = useAuthStore();
  const isAdmin = hasAnyPermission(user, ['fin-005:write']);
  const isFullAdmin = hasAnyPermission(user, ['fin-005:admin']);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const batchesQ = useJournalBatches({ status: statusFilter || undefined });
  const postMut = usePostJournalBatch();
  const voidMut = useVoidJournalBatch();
  const { toast } = useToast();
  const [detail, setDetail] = useState<FinJournalBatchDto | null>(null);
  const [voidReason, setVoidReason] = useState('');

  const batches = batchesQ.data ?? [];

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <PageHeader
        title="GL journal viewer"
        description="Posted journal batches with balance proof."
      />
      <Link href="/finance" className="text-sm text-campus-700 hover:underline">
        ← Back to finance
      </Link>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          Status:
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded border border-gray-300 px-2 py-1 text-sm"
          >
            <option value="">All</option>
            <option value="DRAFT">Draft</option>
            <option value="POSTED">Posted</option>
            <option value="VOIDED">Voided</option>
          </select>
        </label>
        <span className="text-xs text-gray-500">{batches.length} batches</span>
      </div>

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-4 py-2 text-left">Batch</th>
              <th className="px-4 py-2 text-left">Description</th>
              <th className="px-4 py-2 text-left">Type</th>
              <th className="px-4 py-2 text-left">Period</th>
              <th className="px-4 py-2 text-right">Debit</th>
              <th className="px-4 py-2 text-right">Credit</th>
              <th className="px-4 py-2 text-left">Status</th>
              <th className="px-4 py-2 text-right">Posted</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {batches.map((b) => (
              <tr key={b.id} className="border-t border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-2 font-mono text-xs">{b.batchNumber}</td>
                <td className="px-4 py-2">{b.description}</td>
                <td className="px-4 py-2 text-xs text-gray-600">
                  {BATCH_TYPE_LABELS[b.batchType]}
                </td>
                <td className="px-4 py-2 text-xs text-gray-600">{b.periodName}</td>
                <td className="px-4 py-2 text-right font-mono">{formatCurrency(b.totalDebit)}</td>
                <td className="px-4 py-2 text-right font-mono">{formatCurrency(b.totalCredit)}</td>
                <td className="px-4 py-2">
                  <span
                    className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${BATCH_STATUS_PILL[b.status]}`}
                  >
                    {BATCH_STATUS_LABELS[b.status]}
                  </span>
                </td>
                <td className="px-4 py-2 text-right text-xs text-gray-600">
                  {b.postedAt ? formatDateTime(b.postedAt) : '—'}
                </td>
                <td className="px-4 py-2 text-right">
                  <button
                    type="button"
                    onClick={() => setDetail(b)}
                    className="text-sm text-campus-700 hover:underline"
                  >
                    View
                  </button>
                </td>
              </tr>
            ))}
            {batches.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-sm text-gray-500">
                  No batches match this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {isAdmin && (
        <p className="text-xs text-gray-500">
          New batches land via <code>POST /api/v1/finance/journal-batches</code>. The keystone
          balance validation runs inside the same tx as the status flip — on imbalance the entire
          transaction rolls back.
        </p>
      )}

      <Modal
        open={!!detail}
        onClose={() => {
          setDetail(null);
          setVoidReason('');
        }}
        title={detail ? `Batch ${detail.batchNumber}` : ''}
        footer={
          detail && (
            <div className="flex w-full items-center justify-between">
              <div className="space-x-2 text-xs text-gray-500">
                <span>
                  Status:{' '}
                  <span
                    className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${BATCH_STATUS_PILL[detail.status]}`}
                  >
                    {BATCH_STATUS_LABELS[detail.status]}
                  </span>
                </span>
                {detail.postedByName && <span>· Posted by {detail.postedByName}</span>}
              </div>
              <div className="flex gap-2">
                {detail.status === 'DRAFT' && isAdmin && (
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await postMut.mutateAsync(detail.id);
                        toast('Batch posted — balance validated.', 'success');
                        setDetail(null);
                      } catch (e: unknown) {
                        toast((e as Error).message, 'error');
                      }
                    }}
                    className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
                  >
                    Post (validate balance)
                  </button>
                )}
                {detail.status === 'POSTED' && isFullAdmin && (
                  <>
                    <input
                      type="text"
                      placeholder="Void reason"
                      value={voidReason}
                      onChange={(e) => setVoidReason(e.target.value)}
                      className="rounded border border-gray-300 px-2 py-1 text-sm"
                    />
                    <button
                      type="button"
                      disabled={!voidReason.trim()}
                      onClick={async () => {
                        try {
                          await voidMut.mutateAsync({ id: detail.id, reason: voidReason });
                          toast('Batch voided.', 'success');
                          setDetail(null);
                          setVoidReason('');
                        } catch (e: unknown) {
                          toast((e as Error).message, 'error');
                        }
                      }}
                      className="rounded bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-50"
                    >
                      Void
                    </button>
                  </>
                )}
              </div>
            </div>
          )
        }
      >
        {detail && (
          <div className="space-y-3">
            <div className="text-sm">
              <span className="font-medium">{detail.description}</span>
              {detail.sourceModule && (
                <span className="ml-2 inline-flex items-center rounded bg-sky-50 px-2 py-0.5 text-xs text-sky-700 ring-1 ring-sky-200">
                  source: {detail.sourceModule}
                </span>
              )}
            </div>
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left">Account</th>
                  <th className="px-3 py-2 text-left">Fund</th>
                  <th className="px-3 py-2 text-right">Debit</th>
                  <th className="px-3 py-2 text-right">Credit</th>
                  <th className="px-3 py-2 text-left">Description</th>
                </tr>
              </thead>
              <tbody>
                {detail.entries.map((e) => (
                  <tr key={e.id} className="border-t border-gray-100">
                    <td className="px-3 py-1.5 font-mono text-xs">
                      {e.accountCode} {e.accountName}
                    </td>
                    <td className="px-3 py-1.5 text-xs text-gray-600">{e.fundCode}</td>
                    <td className="px-3 py-1.5 text-right font-mono">
                      {e.debit > 0 ? formatCurrency(e.debit) : '—'}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono">
                      {e.credit > 0 ? formatCurrency(e.credit) : '—'}
                    </td>
                    <td className="px-3 py-1.5 text-xs text-gray-600">{e.description ?? ''}</td>
                  </tr>
                ))}
                <tr className="border-t-2 border-gray-300 bg-gray-50">
                  <td colSpan={2} className="px-3 py-2 text-right text-xs font-semibold uppercase">
                    Totals
                  </td>
                  <td className="px-3 py-2 text-right font-mono font-semibold">
                    {formatCurrency(detail.totalDebit)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono font-semibold">
                    {formatCurrency(detail.totalCredit)}
                  </td>
                  <td></td>
                </tr>
              </tbody>
            </table>
            <p className="text-xs text-gray-500">
              The schema-side <code>fin_gl_one_side_chk</code> enforces single-sided lines; the
              keystone <code>validateBatchBalance</code> in PostingService runs SUM(debit) =
              SUM(credit) inside the same tx as the POSTED flip.
            </p>
          </div>
        )}
      </Modal>
    </div>
  );
}
