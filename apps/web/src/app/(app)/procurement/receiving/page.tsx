'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { PageHeader, useToast } from '@/components/ui';
import {
  formatCurrency,
  PRC_INSPECTION_OUTCOMES,
  PRC_RECEIPT_CONDITIONS,
  RECEIPT_CONDITION_LABELS,
  INSPECTION_LABELS,
} from '@/lib/procurement-format';
import type { PrcCreateReceiptLine, PrcInspectionOutcome, PrcReceiptCondition } from '@/lib/types';
import { useCreateReceipt, usePurchaseOrder, usePurchaseOrders } from '@/hooks/use-procurement';

interface DraftReceiptLine extends PrcCreateReceiptLine {
  key: string;
  poItemDescription: string;
  remaining: number;
}

export default function ReceivingPage() {
  const router = useRouter();
  const search = useSearchParams();
  const initialPoId = search?.get('poId') ?? '';
  const [selectedPoId, setSelectedPoId] = useState<string>(initialPoId);
  const { toast } = useToast();
  const create = useCreateReceipt();

  // List receivable POs
  const allPos = usePurchaseOrders();
  const receivablePos = useMemo(
    () =>
      (allPos.data ?? []).filter((p) =>
        ['ISSUED', 'ACKNOWLEDGED', 'SHIPPED', 'PARTIALLY_RECEIVED'].includes(p.status),
      ),
    [allPos.data],
  );

  const po = usePurchaseOrder(selectedPoId || null);
  const [inspectionOutcome, setInspectionOutcome] = useState<PrcInspectionOutcome>('ACCEPTED');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<DraftReceiptLine[]>([]);

  useEffect(() => {
    if (po.data) {
      setLines(
        po.data.lines.map((l) => {
          const remaining = l.quantityOrdered - l.quantityReceived;
          return {
            key: Math.random().toString(36).slice(2),
            poLineId: l.id,
            poItemDescription: l.itemDescription,
            remaining,
            quantityReceived: 0,
            quantityAccepted: 0,
            quantityRejected: 0,
            condition: 'GOOD' as PrcReceiptCondition,
          };
        }),
      );
      setNotes('');
      setInspectionOutcome('ACCEPTED');
    }
  }, [po.data]);

  const updateLine = (key: string, patch: Partial<DraftReceiptLine>) => {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!po.data) {
      toast('Pick a PO first', 'error');
      return;
    }
    const linesToSubmit = lines.filter((l) => l.quantityReceived > 0);
    if (linesToSubmit.length === 0) {
      toast('Receive at least one line with quantity ≥ 1', 'error');
      return;
    }
    for (const l of linesToSubmit) {
      if (l.quantityAccepted + l.quantityRejected !== l.quantityReceived) {
        toast(`Line ${l.poItemDescription}: accepted + rejected must equal received`, 'error');
        return;
      }
      if (l.quantityReceived > l.remaining) {
        toast(
          `Line ${l.poItemDescription}: only ${l.remaining} remaining on this PO line`,
          'error',
        );
        return;
      }
    }
    try {
      await create.mutateAsync({
        poId: po.data.id,
        payload: {
          inspectionOutcome,
          notes: notes || undefined,
          lines: linesToSubmit.map((l) => ({
            poLineId: l.poLineId,
            quantityReceived: l.quantityReceived,
            quantityAccepted: l.quantityAccepted,
            quantityRejected: l.quantityRejected,
            condition: l.condition,
            discrepancyNotes: l.discrepancyNotes,
          })),
        },
      });
      toast('Goods received successfully', 'success');
      router.push(`/procurement/purchase-orders/${po.data.id}`);
    } catch (err: unknown) {
      toast((err as { message?: string })?.message ?? 'Receipt failed', 'error');
    }
  };

  return (
    <div>
      <PageHeader
        title="Receiving"
        description="Log goods received against a purchase order. Vendor performance is auto-updated atomically."
        actions={
          <Link
            href="/procurement/purchase-orders"
            className="text-sm text-campus-600 hover:underline"
          >
            ← Back to POs
          </Link>
        }
      />

      <div className="mb-5 rounded-card border border-gray-200 bg-white p-4 shadow-sm">
        <label className="block text-sm">
          <div className="mb-1 font-medium text-gray-700">Purchase order</div>
          <select
            value={selectedPoId}
            onChange={(e) => setSelectedPoId(e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="">— select —</option>
            {receivablePos.map((p) => (
              <option key={p.id} value={p.id}>
                {p.poNumber} · {p.vendorName ?? 'Unknown'} · {p.status}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!selectedPoId && (
        <div className="rounded-md border border-dashed border-gray-200 bg-white px-6 py-12 text-center text-sm text-gray-500">
          Pick an open PO to log a receipt.
        </div>
      )}

      {selectedPoId && po.isLoading && <div className="text-sm text-gray-500">Loading PO…</div>}

      {po.data && lines.length > 0 && (
        <form onSubmit={submit} className="space-y-5">
          <div className="rounded-card border border-gray-200 bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-900">{po.data.poNumber}</h2>
              <span className="text-xs text-gray-500">
                Vendor: {po.data.vendorName ?? '—'} · Total {formatCurrency(po.data.totalAmount)}
              </span>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Inspection outcome">
                <select
                  value={inspectionOutcome}
                  onChange={(e) => setInspectionOutcome(e.target.value as PrcInspectionOutcome)}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                >
                  {PRC_INSPECTION_OUTCOMES.map((o) => (
                    <option key={o} value={o}>
                      {INSPECTION_LABELS[o]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Notes">
                <input
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                />
              </Field>
            </div>
          </div>

          <div className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-sm">
            <table className="min-w-full divide-y divide-gray-100">
              <thead className="bg-gray-50">
                <tr>
                  <Th>Item</Th>
                  <Th className="text-right">Remaining</Th>
                  <Th className="text-right">Received</Th>
                  <Th className="text-right">Accepted</Th>
                  <Th className="text-right">Rejected</Th>
                  <Th>Condition</Th>
                  <Th>Discrepancy</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {lines.map((l) => (
                  <tr key={l.key}>
                    <Td>{l.poItemDescription}</Td>
                    <Td className="text-right">{l.remaining}</Td>
                    <Td>
                      <input
                        type="number"
                        min={0}
                        max={l.remaining}
                        value={l.quantityReceived}
                        onChange={(e) =>
                          updateLine(l.key, {
                            quantityReceived: Math.max(0, Number(e.target.value)),
                            quantityAccepted: Math.max(0, Number(e.target.value)),
                            quantityRejected: 0,
                          })
                        }
                        className="w-20 rounded-md border border-gray-300 px-2 py-1 text-right text-sm"
                      />
                    </Td>
                    <Td>
                      <input
                        type="number"
                        min={0}
                        max={l.quantityReceived}
                        value={l.quantityAccepted}
                        onChange={(e) =>
                          updateLine(l.key, {
                            quantityAccepted: Math.max(0, Number(e.target.value)),
                            quantityRejected: Math.max(
                              0,
                              l.quantityReceived - Number(e.target.value),
                            ),
                          })
                        }
                        className="w-20 rounded-md border border-gray-300 px-2 py-1 text-right text-sm"
                      />
                    </Td>
                    <Td className="text-right">{l.quantityRejected}</Td>
                    <Td>
                      <select
                        value={l.condition}
                        onChange={(e) =>
                          updateLine(l.key, {
                            condition: e.target.value as PrcReceiptCondition,
                          })
                        }
                        className="rounded-md border border-gray-300 px-2 py-1 text-sm"
                      >
                        {PRC_RECEIPT_CONDITIONS.map((c) => (
                          <option key={c} value={c}>
                            {RECEIPT_CONDITION_LABELS[c]}
                          </option>
                        ))}
                      </select>
                    </Td>
                    <Td>
                      <input
                        value={l.discrepancyNotes ?? ''}
                        onChange={(e) =>
                          updateLine(l.key, {
                            discrepancyNotes: e.target.value || undefined,
                          })
                        }
                        placeholder="Optional"
                        className="w-full rounded-md border border-gray-300 px-2 py-1 text-sm"
                      />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={create.isPending}
              className="rounded-md bg-campus-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {create.isPending ? 'Recording…' : 'Record receipt'}
            </button>
            <button
              type="button"
              onClick={() => router.back()}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
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
