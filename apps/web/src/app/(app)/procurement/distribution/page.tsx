'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Modal, PageHeader, useToast } from '@/components/ui';
import {
  DEST_MODULE_LABELS,
  formatDateTime,
  PRC_DESTINATION_MODULES,
  RECEIPT_CONDITION_LABELS,
  RECEIPT_CONDITION_PILL,
} from '@/lib/procurement-format';
import type { PrcDistDestinationModule } from '@/lib/types';
import {
  useCreateDistribution,
  useDistributionsForReceipt,
  usePurchaseOrders,
  useReceiptsForPO,
} from '@/hooks/use-procurement';

interface DraftDistLine {
  key: string;
  receiptLineId: string;
  itemDescription: string;
  remaining: number;
  quantityDistributed: number;
  unitCost: number | null;
}

export default function DistributionPage() {
  const { toast } = useToast();

  const allPos = usePurchaseOrders();
  const eligiblePos = useMemo(
    () => (allPos.data ?? []).filter((p) => ['PARTIALLY_RECEIVED', 'RECEIVED'].includes(p.status)),
    [allPos.data],
  );
  const [poId, setPoId] = useState('');
  const receipts = useReceiptsForPO(poId || null);
  const [receiptId, setReceiptId] = useState('');
  const distributions = useDistributionsForReceipt(receiptId || null);

  const [modalOpen, setModalOpen] = useState(false);
  const [destModule, setDestModule] = useState<PrcDistDestinationModule>('tech');
  const [destDept, setDestDept] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<DraftDistLine[]>([]);
  const create = useCreateDistribution();

  const selectedReceipt = useMemo(
    () => (receipts.data ?? []).find((r) => r.id === receiptId) ?? null,
    [receipts.data, receiptId],
  );

  useEffect(() => {
    if (selectedReceipt) {
      setLines(
        selectedReceipt.lines
          .filter((l) => l.quantityAccepted > 0)
          .map((l) => ({
            key: Math.random().toString(36).slice(2),
            receiptLineId: l.id,
            itemDescription: l.poItemDescription,
            remaining: l.quantityAccepted,
            quantityDistributed: 0,
            unitCost: null,
          })),
      );
    } else {
      setLines([]);
    }
  }, [selectedReceipt]);

  const submit = async () => {
    if (!receiptId) return;
    const linesToSubmit = lines.filter((l) => l.quantityDistributed > 0);
    if (linesToSubmit.length === 0) {
      toast('Distribute at least one line with quantity ≥ 1', 'error');
      return;
    }
    try {
      await create.mutateAsync({
        receiptId,
        payload: {
          destinationModule: destModule,
          destinationDepartment: destDept || undefined,
          notes: notes || undefined,
          lines: linesToSubmit.map((l) => ({
            receiptLineId: l.receiptLineId,
            quantityDistributed: l.quantityDistributed,
            itemDescription: l.itemDescription,
            unitCost: l.unitCost ?? undefined,
          })),
        },
      });
      toast(`Distributed → ${DEST_MODULE_LABELS[destModule]}`, 'success');
      setModalOpen(false);
      setNotes('');
    } catch (err: unknown) {
      toast((err as { message?: string })?.message ?? 'Distribution failed', 'error');
    }
  };

  return (
    <div>
      <PageHeader
        title="Distribution"
        description="Hand off received goods to a downstream module. Each distribution emits prc.distribution.completed."
        actions={
          <Link href="/procurement" className="text-sm text-campus-600 hover:underline">
            ← Back to Procurement
          </Link>
        }
      />

      <div className="mb-5 grid gap-3 rounded-card border border-gray-200 bg-white p-4 shadow-sm sm:grid-cols-2">
        <label className="block text-sm">
          <div className="mb-1 font-medium text-gray-700">Purchase order</div>
          <select
            value={poId}
            onChange={(e) => {
              setPoId(e.target.value);
              setReceiptId('');
            }}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="">— select —</option>
            {eligiblePos.map((p) => (
              <option key={p.id} value={p.id}>
                {p.poNumber} · {p.vendorName ?? '—'} · {p.status}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <div className="mb-1 font-medium text-gray-700">Goods receipt</div>
          <select
            value={receiptId}
            onChange={(e) => setReceiptId(e.target.value)}
            disabled={!poId}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm disabled:opacity-50"
          >
            <option value="">— select —</option>
            {(receipts.data ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {formatDateTime(r.receivedAt)} · {r.receivedByName ?? '—'} · {r.lines.length} line
                {r.lines.length === 1 ? '' : 's'}
              </option>
            ))}
          </select>
        </label>
      </div>

      {selectedReceipt && (
        <section className="mb-5">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-700">Accepted lines</h2>
            <button
              onClick={() => setModalOpen(true)}
              disabled={lines.length === 0}
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              Distribute …
            </button>
          </div>
          <div className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-sm">
            <table className="min-w-full divide-y divide-gray-100">
              <thead className="bg-gray-50">
                <tr>
                  <Th>Item</Th>
                  <Th className="text-right">Accepted</Th>
                  <Th className="text-right">Rejected</Th>
                  <Th>Condition</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {selectedReceipt.lines.map((l) => (
                  <tr key={l.id}>
                    <Td>{l.poItemDescription}</Td>
                    <Td className="text-right">{l.quantityAccepted}</Td>
                    <Td className="text-right">{l.quantityRejected}</Td>
                    <Td>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-semibold ${RECEIPT_CONDITION_PILL[l.condition]}`}
                      >
                        {RECEIPT_CONDITION_LABELS[l.condition]}
                      </span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {selectedReceipt && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-gray-700">Distribution history</h2>
          {distributions.isLoading ? (
            <div className="text-sm text-gray-500">Loading…</div>
          ) : (distributions.data ?? []).length === 0 ? (
            <div className="rounded-md border border-dashed border-gray-200 px-4 py-6 text-center text-sm text-gray-500">
              No distributions yet for this receipt.
            </div>
          ) : (
            <ul className="space-y-2">
              {(distributions.data ?? []).map((d) => (
                <li
                  key={d.id}
                  className="rounded-card border border-gray-200 bg-white px-4 py-3 text-sm shadow-sm"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-medium text-gray-900">
                        → {DEST_MODULE_LABELS[d.destinationModule]}
                        {d.destinationDepartment ? ` · ${d.destinationDepartment}` : ''}
                      </div>
                      <div className="mt-1 text-xs text-gray-500">
                        Distributed by {d.distributedByName ?? '—'} ·{' '}
                        {formatDateTime(d.distributedAt)}
                      </div>
                    </div>
                    <span className="text-xs font-medium text-gray-600">
                      {d.lines.length} line{d.lines.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  {d.notes && <div className="mt-2 text-xs text-gray-600">{d.notes}</div>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Distribute received goods"
        size="lg"
        footer={
          <>
            <button
              onClick={() => setModalOpen(false)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            >
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={create.isPending}
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {create.isPending ? 'Distributing…' : 'Distribute'}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="rounded-md bg-violet-50 p-3 text-xs text-violet-800">
            <strong>Cross-module distribution keystone.</strong> Submitting will emit{' '}
            <code>prc.distribution.completed</code> with destination_module={' '}
            <strong>{destModule}</strong> so the downstream module can react (e.g. tech auto-creates
            assets, lib catalogues new copies).
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Destination module">
              <select
                value={destModule}
                onChange={(e) => setDestModule(e.target.value as PrcDistDestinationModule)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              >
                {PRC_DESTINATION_MODULES.filter((m) => m !== 'general').map((m) => (
                  <option key={m} value={m}>
                    {DEST_MODULE_LABELS[m]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Destination department (optional)">
              <input
                value={destDept}
                onChange={(e) => setDestDept(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </Field>
          </div>
          <Field label="Notes">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </Field>
          <div>
            <h3 className="mb-2 text-xs font-semibold text-gray-700">Lines to distribute</h3>
            <div className="space-y-2">
              {lines.map((l) => (
                <div
                  key={l.key}
                  className="flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 p-2 text-sm"
                >
                  <span className="flex-1">{l.itemDescription}</span>
                  <span className="text-xs text-gray-500">/ {l.remaining}</span>
                  <input
                    type="number"
                    min={0}
                    max={l.remaining}
                    value={l.quantityDistributed}
                    onChange={(e) =>
                      setLines((prev) =>
                        prev.map((x) =>
                          x.key === l.key
                            ? {
                                ...x,
                                quantityDistributed: Math.max(
                                  0,
                                  Math.min(l.remaining, Number(e.target.value)),
                                ),
                              }
                            : x,
                        ),
                      )
                    }
                    className="w-20 rounded-md border border-gray-300 px-2 py-1 text-right text-sm"
                  />
                </div>
              ))}
            </div>
          </div>
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
