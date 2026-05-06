'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { PageHeader, useToast } from '@/components/ui';
import {
  DEST_MODULE_LABELS,
  PRC_DESTINATION_MODULES,
  PRC_URGENCIES,
  URGENCY_LABELS,
} from '@/lib/procurement-format';
import type { PrcCreateRequisitionLine, PrcDestinationModule, PrcUrgency } from '@/lib/types';
import { useCreateRequisition } from '@/hooks/use-procurement';

interface DraftLine extends PrcCreateRequisitionLine {
  key: string;
}

function emptyLine(): DraftLine {
  return {
    key: Math.random().toString(36).slice(2),
    itemDescription: '',
    quantity: 1,
    destinationModule: 'general' as PrcDestinationModule,
  };
}

export default function NewRequisitionPage() {
  const router = useRouter();
  const { toast } = useToast();
  const create = useCreateRequisition();
  const [department, setDepartment] = useState('');
  const [urgency, setUrgency] = useState<PrcUrgency>('ROUTINE');
  const [budgetLineId, setBudgetLineId] = useState('');
  const [justification, setJustification] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);

  const updateLine = (key: string, patch: Partial<DraftLine>) => {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  };

  const removeLine = (key: string) => {
    setLines((prev) => (prev.length === 1 ? prev : prev.filter((l) => l.key !== key)));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!justification.trim()) {
      toast('Justification is required', 'error');
      return;
    }
    if (lines.some((l) => !l.itemDescription.trim() || l.quantity < 1)) {
      toast('Each line needs a description and quantity ≥ 1', 'error');
      return;
    }
    try {
      const created = await create.mutateAsync({
        requestingDepartment: department || undefined,
        urgency,
        budgetLineId: budgetLineId || undefined,
        justification,
        lines: lines.map((l) => ({
          itemDescription: l.itemDescription,
          quantity: l.quantity,
          unit: l.unit,
          estimatedUnitCost: l.estimatedUnitCost,
          specifications: l.specifications,
          destinationModule: l.destinationModule,
        })),
      });
      toast('Draft requisition created', 'success');
      router.push(`/procurement/requisitions/${created.id}`);
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? 'Could not create requisition';
      toast(msg, 'error');
    }
  };

  return (
    <div>
      <PageHeader title="New requisition" description="Submit a request for goods or services." />

      <form onSubmit={submit} className="max-w-3xl space-y-5">
        <Card>
          <Field label="Justification" required>
            <textarea
              value={justification}
              onChange={(e) => setJustification(e.target.value)}
              rows={3}
              maxLength={2000}
              placeholder="Why is this needed?"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Department">
              <input
                value={department}
                onChange={(e) => setDepartment(e.target.value)}
                maxLength={100}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </Field>
            <Field label="Urgency">
              <select
                value={urgency}
                onChange={(e) => setUrgency(e.target.value as PrcUrgency)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              >
                {PRC_URGENCIES.map((u) => (
                  <option key={u} value={u}>
                    {URGENCY_LABELS[u]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Budget line ID (optional)">
              <input
                value={budgetLineId}
                onChange={(e) => setBudgetLineId(e.target.value)}
                placeholder="UUID"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </Field>
          </div>
        </Card>

        <Card>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-900">Line items</h2>
            <button
              type="button"
              onClick={() => setLines((p) => [...p, emptyLine()])}
              className="rounded-md border border-gray-200 px-3 py-1 text-xs font-medium text-gray-700 hover:border-campus-400"
            >
              + Add line
            </button>
          </div>
          <div className="space-y-3">
            {lines.map((line, idx) => (
              <div key={line.key} className="rounded-md border border-gray-200 bg-gray-50 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold text-gray-600">Line {idx + 1}</span>
                  {lines.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeLine(line.key)}
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
                    maxLength={500}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  />
                </Field>
                <div className="grid gap-3 sm:grid-cols-4">
                  <Field label="Quantity" required>
                    <input
                      type="number"
                      min={1}
                      value={line.quantity}
                      onChange={(e) =>
                        updateLine(line.key, { quantity: Math.max(1, Number(e.target.value)) })
                      }
                      className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                    />
                  </Field>
                  <Field label="Unit">
                    <input
                      value={line.unit ?? ''}
                      onChange={(e) => updateLine(line.key, { unit: e.target.value || undefined })}
                      placeholder="ea / box / case"
                      className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                    />
                  </Field>
                  <Field label="Est. unit cost">
                    <input
                      type="number"
                      step="0.01"
                      min={0}
                      value={line.estimatedUnitCost ?? ''}
                      onChange={(e) =>
                        updateLine(line.key, {
                          estimatedUnitCost: e.target.value ? Number(e.target.value) : undefined,
                        })
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
                <Field label="Specifications">
                  <textarea
                    value={line.specifications ?? ''}
                    onChange={(e) =>
                      updateLine(line.key, { specifications: e.target.value || undefined })
                    }
                    rows={2}
                    maxLength={2000}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  />
                </Field>
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
            {create.isPending ? 'Saving…' : 'Save as draft'}
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
