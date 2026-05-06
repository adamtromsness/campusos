'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Modal, PageHeader, useToast } from '@/components/ui';
import {
  formatDateTime,
  INSPECTION_LABELS,
  INSPECTION_PILL,
  PRC_RETURN_TYPES,
  RECEIPT_CONDITION_LABELS,
  RECEIPT_CONDITION_PILL,
  RETURN_STATUS_LABELS,
  RETURN_STATUS_PILL,
  RETURN_TYPE_LABELS,
} from '@/lib/procurement-format';
import type { PrcReturnType } from '@/lib/types';
import {
  useCreateReturn,
  useDistributionsForReceipt,
  useReceiptsForPO,
  useReturnsForReceiptLine,
} from '@/hooks/use-procurement';

export default function ReceiptDetailPage() {
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const receiptId = params?.id ?? null;
  const poId = search?.get('poId') ?? null;
  const { toast } = useToast();

  const allReceiptsLookup = useReceiptsForPO(poId);
  const receipt = useMemo(
    () => (allReceiptsLookup.data ?? []).find((r) => r.id === receiptId),
    [allReceiptsLookup.data, receiptId],
  );

  const distributions = useDistributionsForReceipt(receiptId);

  const [retOpen, setRetOpen] = useState(false);
  const [retLineId, setRetLineId] = useState<string | null>(null);
  const [retType, setRetType] = useState<PrcReturnType>('DAMAGED');
  const [retQty, setRetQty] = useState(1);
  const [retRef, setRetRef] = useState('');
  const [retRma, setRetRma] = useState('');
  const createReturn = useCreateReturn();

  if (!poId) {
    return (
      <div className="p-6">
        <PageHeader
          title="Receipt context required"
          description="Open this receipt from its parent PO."
        />
        <Link
          href="/procurement/purchase-orders"
          className="text-sm text-campus-600 hover:underline"
        >
          ← Back to POs
        </Link>
      </div>
    );
  }

  if (allReceiptsLookup.isLoading) {
    return <div className="p-6 text-sm text-gray-500">Loading…</div>;
  }
  if (!receipt) {
    return (
      <div className="p-6">
        <PageHeader title="Receipt not found" />
        <Link
          href={`/procurement/purchase-orders/${poId}`}
          className="text-sm text-campus-600 hover:underline"
        >
          ← Back to PO
        </Link>
      </div>
    );
  }

  const submitReturn = async () => {
    if (!retLineId) return;
    try {
      await createReturn.mutateAsync({
        receiptLineId: retLineId,
        payload: {
          returnType: retType,
          quantityReturned: retQty,
          returnReference: retRef || undefined,
          vendorRmaNumber: retRma || undefined,
        },
      });
      toast('Return initiated', 'success');
      setRetOpen(false);
      setRetRef('');
      setRetRma('');
    } catch (err: unknown) {
      toast((err as { message?: string })?.message ?? 'Return failed', 'error');
    }
  };

  return (
    <div>
      <PageHeader
        title="Goods receipt"
        description={`PO ${receipt.poNumber} · received by ${receipt.receivedByName ?? '—'} · ${formatDateTime(receipt.receivedAt)}`}
        actions={
          <Link
            href={`/procurement/purchase-orders/${receipt.purchaseOrderId}`}
            className="text-sm text-campus-600 hover:underline"
          >
            ← Back to PO
          </Link>
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <span
          className={`rounded-full px-3 py-1 text-xs font-semibold ${INSPECTION_PILL[receipt.inspectionOutcome]}`}
        >
          {INSPECTION_LABELS[receipt.inspectionOutcome]}
        </span>
      </div>

      {receipt.notes && (
        <div className="mb-5 rounded-card border border-gray-200 bg-white p-4 text-sm text-gray-700 shadow-sm">
          {receipt.notes}
        </div>
      )}

      <section className="mb-5">
        <h2 className="mb-2 text-sm font-semibold text-gray-700">Lines</h2>
        <div className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-gray-100">
            <thead className="bg-gray-50">
              <tr>
                <Th>Item</Th>
                <Th className="text-right">Received</Th>
                <Th className="text-right">Accepted</Th>
                <Th className="text-right">Rejected</Th>
                <Th>Condition</Th>
                <Th>Discrepancy</Th>
                <Th>Action</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {receipt.lines.map((l) => (
                <tr key={l.id}>
                  <Td>{l.poItemDescription}</Td>
                  <Td className="text-right">{l.quantityReceived}</Td>
                  <Td className="text-right">{l.quantityAccepted}</Td>
                  <Td className="text-right">{l.quantityRejected}</Td>
                  <Td>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${RECEIPT_CONDITION_PILL[l.condition]}`}
                    >
                      {RECEIPT_CONDITION_LABELS[l.condition]}
                    </span>
                  </Td>
                  <Td>{l.discrepancyNotes ?? '—'}</Td>
                  <Td>
                    <button
                      onClick={() => {
                        setRetLineId(l.id);
                        setRetQty(Math.min(l.quantityReceived, 1));
                        setRetType(
                          l.condition === 'DAMAGED'
                            ? 'DAMAGED'
                            : l.condition === 'DEFECTIVE'
                              ? 'DEFECTIVE'
                              : 'WARRANTY_CLAIM',
                        );
                        setRetOpen(true);
                      }}
                      className="rounded-md border border-rose-300 px-2 py-1 text-xs font-medium text-rose-700 hover:bg-rose-50"
                    >
                      Initiate return
                    </button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mb-5">
        <h2 className="mb-2 text-sm font-semibold text-gray-700">Returns</h2>
        <div className="space-y-3">
          {receipt.lines.map((l) => (
            <ReturnsList key={l.id} receiptLineId={l.id} />
          ))}
        </div>
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-700">Distributions</h2>
          <Link
            href="/procurement/distribution"
            className="text-sm text-campus-600 hover:underline"
          >
            Distribute →
          </Link>
        </div>
        {distributions.isLoading ? (
          <div className="text-sm text-gray-500">Loading…</div>
        ) : (distributions.data ?? []).length === 0 ? (
          <div className="rounded-md border border-dashed border-gray-200 px-4 py-6 text-center text-sm text-gray-500">
            No distributions for this receipt yet.
          </div>
        ) : (
          <ul className="space-y-2">
            {(distributions.data ?? []).map((d) => (
              <li
                key={d.id}
                className="rounded-card border border-gray-200 bg-white px-4 py-3 text-sm shadow-sm"
              >
                <div className="font-medium text-gray-900">→ {d.destinationModule}</div>
                <div className="mt-1 text-xs text-gray-500">
                  {d.distributedByName ?? '—'} · {formatDateTime(d.distributedAt)} ·{' '}
                  {d.lines.length} line
                  {d.lines.length === 1 ? '' : 's'}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Modal
        open={retOpen}
        onClose={() => setRetOpen(false)}
        title="Initiate return"
        footer={
          <>
            <button
              onClick={() => setRetOpen(false)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            >
              Cancel
            </button>
            <button
              onClick={submitReturn}
              disabled={createReturn.isPending}
              className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              Initiate
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Return type">
            <select
              value={retType}
              onChange={(e) => setRetType(e.target.value as PrcReturnType)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            >
              {PRC_RETURN_TYPES.map((t) => (
                <option key={t} value={t}>
                  {RETURN_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Quantity">
            <input
              type="number"
              min={1}
              value={retQty}
              onChange={(e) => setRetQty(Math.max(1, Number(e.target.value)))}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </Field>
          <Field label="Return reference (optional)">
            <input
              value={retRef}
              onChange={(e) => setRetRef(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </Field>
          <Field label="Vendor RMA # (optional)">
            <input
              value={retRma}
              onChange={(e) => setRetRma(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </Field>
        </div>
      </Modal>
    </div>
  );
}

function ReturnsList({ receiptLineId }: { receiptLineId: string }) {
  const q = useReturnsForReceiptLine(receiptLineId);
  if (q.isLoading) return null;
  if (!q.data || q.data.length === 0) return null;
  return (
    <ul className="space-y-2">
      {q.data.map((r) => (
        <li
          key={r.id}
          className="rounded-card border border-gray-200 bg-white px-4 py-3 text-sm shadow-sm"
        >
          <div className="flex items-center justify-between">
            <div>
              <div className="font-medium text-gray-900">
                {RETURN_TYPE_LABELS[r.returnType]} · {r.quantityReturned} unit
                {r.quantityReturned === 1 ? '' : 's'}
              </div>
              <div className="mt-1 text-xs text-gray-500">
                Initiated by {r.initiatedByName ?? '—'} · {formatDateTime(r.initiatedAt)}{' '}
                {r.vendorRmaNumber ? `· RMA ${r.vendorRmaNumber}` : ''}
              </div>
            </div>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-semibold ${RETURN_STATUS_PILL[r.status]}`}
            >
              {RETURN_STATUS_LABELS[r.status]}
            </span>
          </div>
        </li>
      ))}
    </ul>
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

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={`px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-600 ${className}`}
    >
      {children}
    </th>
  );
}

function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <td className={`whitespace-nowrap px-4 py-2.5 text-sm text-gray-700 ${className}`}>
      {children}
    </td>
  );
}
