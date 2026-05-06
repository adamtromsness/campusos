'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { PageHeader, useToast } from '@/components/ui';
import {
  DEST_MODULE_LABELS,
  formatCurrency,
  PRC_DESTINATION_MODULES,
} from '@/lib/procurement-format';
import type { PrcCreatePOLine, PrcDestinationModule } from '@/lib/types';
import { useCreatePurchaseOrder, useRequisition } from '@/hooks/use-procurement';

interface DraftLine extends PrcCreatePOLine {
  key: string;
}

function emptyLine(): DraftLine {
  return {
    key: Math.random().toString(36).slice(2),
    itemDescription: '',
    quantityOrdered: 1,
    unitCost: 0,
    destinationModule: 'general' as PrcDestinationModule,
  };
}

export default function NewPurchaseOrderPage() {
  const router = useRouter();
  const search = useSearchParams();
  const requisitionId = search?.get('requisitionId') ?? null;
  const reqQuery = useRequisition(requisitionId);
  const { toast } = useToast();
  const create = useCreatePurchaseOrder();

  const [vendorId, setVendorId] = useState('');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [expectedDeliveryDate, setExpectedDeliveryDate] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('NET_30');
  const [notes, setNotes] = useState('');
  const [budgetLineId, setBudgetLineId] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);

  // Pre-populate from requisition (one-shot)
  useEffect(() => {
    if (reqQuery.data && requisitionId) {
      const r = reqQuery.data;
      if (r.budgetLineId) setBudgetLineId(r.budgetLineId);
      if (r.lines.length > 0) {
        setLines(
          r.lines.map((l) => ({
            key: Math.random().toString(36).slice(2),
            requisitionLineId: l.id,
            itemDescription: l.itemDescription,
            quantityOrdered: l.quantity,
            unitCost: l.estimatedUnitCost ?? 0,
            destinationModule: l.destinationModule,
          })),
        );
      }
    }
  }, [reqQuery.data, requisitionId]);

  const total = useMemo(
    () => lines.reduce((sum, l) => sum + l.unitCost * l.quantityOrdered, 0),
    [lines],
  );

  const updateLine = (key: string, patch: Partial<DraftLine>) => {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!vendorId || !deliveryAddress) {
      toast('Vendor and delivery address are required', 'error');
      return;
    }
    if (lines.some((l) => !l.itemDescription || l.quantityOrdered < 1 || l.unitCost < 0)) {
      toast('Each line needs a description, quantity ≥ 1, and a non-negative cost', 'error');
      return;
    }
    try {
      const created = await create.mutateAsync({
        vendorId,
        requisitionId: requisitionId ?? undefined,
        deliveryAddress,
        expectedDeliveryDate: expectedDeliveryDate || undefined,
        paymentTerms,
        notes: notes || undefined,
        budgetLineId: budgetLineId || undefined,
        lines: lines.map((l) => ({
          requisitionLineId: l.requisitionLineId,
          itemDescription: l.itemDescription,
          quantityOrdered: l.quantityOrdered,
          unitCost: l.unitCost,
          glAccountId: l.glAccountId,
          destinationModule: l.destinationModule,
        })),
      });
      toast(`PO ${created.poNumber} created (DRAFT)`, 'success');
      router.push(`/procurement/purchase-orders/${created.id}`);
    } catch (err: unknown) {
      toast((err as { message?: string })?.message ?? 'Could not create PO', 'error');
    }
  };

  return (
    <div>
      <PageHeader
        title="New purchase order"
        description={
          requisitionId
            ? 'Lines pre-populated from the linked requisition. Fill in vendor + delivery details.'
            : 'Create a fresh PO from scratch.'
        }
      />

      <form onSubmit={submit} className="max-w-4xl space-y-5">
        <Card>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Vendor (fin_suppliers UUID)" required>
              <input
                value={vendorId}
                onChange={(e) => setVendorId(e.target.value)}
                placeholder="UUID — see Finance → Suppliers"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </Field>
            <Field label="Payment terms">
              <input
                value={paymentTerms}
                onChange={(e) => setPaymentTerms(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </Field>
            <Field label="Delivery address" required>
              <input
                value={deliveryAddress}
                onChange={(e) => setDeliveryAddress(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </Field>
            <Field label="Expected delivery date">
              <input
                type="date"
                value={expectedDeliveryDate}
                onChange={(e) => setExpectedDeliveryDate(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </Field>
            <Field label="Budget line ID (optional)">
              <input
                value={budgetLineId}
                onChange={(e) => setBudgetLineId(e.target.value)}
                placeholder="Override requisition default"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </Field>
            <Field label="Notes">
              <input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </Field>
          </div>
        </Card>

        <Card>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-900">PO lines</h2>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-gray-700">
                Total: {formatCurrency(total)}
              </span>
              <button
                type="button"
                onClick={() => setLines((p) => [...p, emptyLine()])}
                className="rounded-md border border-gray-200 px-3 py-1 text-xs font-medium text-gray-700 hover:border-campus-400"
              >
                + Add line
              </button>
            </div>
          </div>
          <div className="space-y-3">
            {lines.map((line, idx) => (
              <div key={line.key} className="rounded-md border border-gray-200 bg-gray-50 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold text-gray-600">Line {idx + 1}</span>
                  {lines.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}
                      className="text-xs text-rose-600 hover:underline"
                    >
                      Remove
                    </button>
                  )}
                </div>
                <Field label="Description" required>
                  <input
                    value={line.itemDescription}
                    onChange={(e) => updateLine(line.key, { itemDescription: e.target.value })}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  />
                </Field>
                <div className="grid gap-3 sm:grid-cols-4">
                  <Field label="Qty" required>
                    <input
                      type="number"
                      min={1}
                      value={line.quantityOrdered}
                      onChange={(e) =>
                        updateLine(line.key, {
                          quantityOrdered: Math.max(1, Number(e.target.value)),
                        })
                      }
                      className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                    />
                  </Field>
                  <Field label="Unit cost" required>
                    <input
                      type="number"
                      step="0.01"
                      min={0}
                      value={line.unitCost}
                      onChange={(e) =>
                        updateLine(line.key, {
                          unitCost: Math.max(0, Number(e.target.value)),
                        })
                      }
                      className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                    />
                  </Field>
                  <Field label="GL account ID">
                    <input
                      value={line.glAccountId ?? ''}
                      onChange={(e) =>
                        updateLine(line.key, { glAccountId: e.target.value || undefined })
                      }
                      className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                    />
                  </Field>
                  <Field label="Destination">
                    <select
                      value={line.destinationModule}
                      onChange={(e) =>
                        updateLine(line.key, {
                          destinationModule: e.target.value as PrcDestinationModule,
                        })
                      }
                      className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                    >
                      {PRC_DESTINATION_MODULES.map((m) => (
                        <option key={m} value={m}>
                          {DEST_MODULE_LABELS[m]}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              </div>
            ))}
          </div>
        </Card>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={create.isPending}
            className="rounded-md bg-campus-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {create.isPending ? 'Saving…' : 'Save as DRAFT'}
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
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-4 rounded-card border border-gray-200 bg-white p-5 shadow-sm">
      {children}
    </div>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-sm">
      <div className="mb-1 font-medium text-gray-700">
        {label}
        {required && <span className="ml-1 text-rose-600">*</span>}
      </div>
      {children}
    </label>
  );
}
