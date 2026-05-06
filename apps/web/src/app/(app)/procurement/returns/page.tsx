'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Modal, PageHeader, useToast } from '@/components/ui';
import {
  formatDateTime,
  PRC_RETURN_RESOLUTIONS,
  PRC_RETURN_STATUSES,
  RETURN_RESOLUTION_LABELS,
  RETURN_STATUS_LABELS,
  RETURN_STATUS_PILL,
  RETURN_TYPE_LABELS,
} from '@/lib/procurement-format';
import type { PrcReturnDto, PrcReturnResolution } from '@/lib/types';
import { useReturns, useUpdateReturn } from '@/hooks/use-procurement';

export default function ReturnsListPage() {
  const [status, setStatus] = useState<string>('');
  const returns = useReturns(status ? { status } : undefined);
  const update = useUpdateReturn();
  const { toast } = useToast();

  const [resolveOpen, setResolveOpen] = useState(false);
  const [active, setActive] = useState<PrcReturnDto | null>(null);
  const [resolution, setResolution] = useState<PrcReturnResolution>('REPLACED');
  const [resolutionNotes, setResolutionNotes] = useState('');

  const onShip = async (r: PrcReturnDto) => {
    try {
      await update.mutateAsync({ id: r.id, payload: { action: 'SHIP' } });
      toast('Return marked shipped', 'success');
    } catch (err: unknown) {
      toast((err as { message?: string })?.message ?? 'Update failed', 'error');
    }
  };

  const onResolveSubmit = async () => {
    if (!active) return;
    try {
      await update.mutateAsync({
        id: active.id,
        payload: { action: 'RESOLVE', resolution, resolutionNotes: resolutionNotes || undefined },
      });
      toast(`Return resolved (${resolution})`, 'success');
      setResolveOpen(false);
      setActive(null);
      setResolutionNotes('');
    } catch (err: unknown) {
      toast((err as { message?: string })?.message ?? 'Resolve failed', 'error');
    }
  };

  const onCancel = async (r: PrcReturnDto) => {
    try {
      await update.mutateAsync({ id: r.id, payload: { action: 'CANCEL' } });
      toast('Return cancelled', 'success');
    } catch (err: unknown) {
      toast((err as { message?: string })?.message ?? 'Cancel failed', 'error');
    }
  };

  return (
    <div>
      <PageHeader
        title="Returns"
        description="Track returns to vendors. Each line links back to a goods-receipt line for audit."
        actions={
          <Link href="/procurement" className="text-sm text-campus-600 hover:underline">
            ← Back to Procurement
          </Link>
        }
      />

      <div className="mb-4 flex flex-wrap gap-2">
        <FilterChip label="All" active={status === ''} onClick={() => setStatus('')} />
        {PRC_RETURN_STATUSES.map((s) => (
          <FilterChip
            key={s}
            label={RETURN_STATUS_LABELS[s]}
            active={status === s}
            onClick={() => setStatus(s)}
          />
        ))}
      </div>

      {returns.isLoading ? (
        <div className="text-sm text-gray-500">Loading…</div>
      ) : (returns.data ?? []).length === 0 ? (
        <div className="rounded-md border border-dashed border-gray-200 bg-white px-6 py-12 text-center text-sm text-gray-500">
          No returns recorded.
        </div>
      ) : (
        <ul className="space-y-2">
          {(returns.data ?? []).map((r) => (
            <li key={r.id} className="rounded-card border border-gray-200 bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="font-medium text-gray-900">
                    {RETURN_TYPE_LABELS[r.returnType]} · {r.quantityReturned} unit
                    {r.quantityReturned === 1 ? '' : 's'}
                  </div>
                  <div className="mt-1 text-xs text-gray-500">
                    Initiated by {r.initiatedByName ?? '—'} · {formatDateTime(r.initiatedAt)}{' '}
                    {r.vendorRmaNumber && `· RMA ${r.vendorRmaNumber}`}
                    {r.returnReference && ` · Ref ${r.returnReference}`}
                  </div>
                  {r.resolution && (
                    <div className="mt-1 text-xs text-emerald-700">
                      Resolved: {RETURN_RESOLUTION_LABELS[r.resolution]}
                      {r.resolvedAt && ` · ${formatDateTime(r.resolvedAt)}`}
                    </div>
                  )}
                  {r.resolutionNotes && (
                    <div className="mt-1 text-xs text-gray-600">{r.resolutionNotes}</div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${RETURN_STATUS_PILL[r.status]}`}
                  >
                    {RETURN_STATUS_LABELS[r.status]}
                  </span>
                  {r.status === 'INITIATED' && (
                    <button
                      onClick={() => onShip(r)}
                      className="rounded-md border border-sky-300 bg-white px-2 py-1 text-xs font-medium text-sky-700 hover:bg-sky-50"
                    >
                      Mark shipped
                    </button>
                  )}
                  {(r.status === 'INITIATED' || r.status === 'SHIPPED_TO_VENDOR') && (
                    <button
                      onClick={() => {
                        setActive(r);
                        setResolution('REPLACED');
                        setResolutionNotes('');
                        setResolveOpen(true);
                      }}
                      className="rounded-md bg-emerald-600 px-2 py-1 text-xs font-medium text-white"
                    >
                      Resolve
                    </button>
                  )}
                  {r.status !== 'RESOLVED' && r.status !== 'CANCELLED' && (
                    <button
                      onClick={() => onCancel(r)}
                      className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs font-medium text-gray-700"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={resolveOpen}
        onClose={() => setResolveOpen(false)}
        title="Resolve return"
        footer={
          <>
            <button
              onClick={() => setResolveOpen(false)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            >
              Cancel
            </button>
            <button
              onClick={onResolveSubmit}
              disabled={update.isPending}
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              Resolve
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Resolution">
            <select
              value={resolution}
              onChange={(e) => setResolution(e.target.value as PrcReturnResolution)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            >
              {PRC_RETURN_RESOLUTIONS.map((r) => (
                <option key={r} value={r}>
                  {RETURN_RESOLUTION_LABELS[r]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Notes">
            <textarea
              value={resolutionNotes}
              onChange={(e) => setResolutionNotes(e.target.value)}
              rows={3}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </Field>
        </div>
      </Modal>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <div className="mb-1 font-medium text-gray-700">{label}</div>
      {children}
    </label>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3 py-1 text-xs font-medium transition ${
        active
          ? 'bg-campus-600 text-white'
          : 'bg-white text-gray-700 ring-1 ring-gray-200 hover:ring-campus-400'
      }`}
    >
      {label}
    </button>
  );
}
