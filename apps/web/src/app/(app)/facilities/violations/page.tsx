'use client';

import Link from 'next/link';
import { useState } from 'react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { useFacActiveViolations, useFacResolveViolation } from '@/hooks/use-facilities';
import {
  FAC_VIOL_SEVERITY_LABEL,
  FAC_VIOL_SEVERITY_PILL,
  formatRelativeDue,
  isOverdue,
} from '@/lib/facilities-format';
import type { FacViolationDto } from '@/lib/types';

export default function ViolationsPage() {
  const violationsQ = useFacActiveViolations();
  const [openId, setOpenId] = useState<string | null>(null);

  const sorted = (violationsQ.data ?? []).slice().sort((a, b) => {
    return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
  });

  return (
    <div>
      <PageHeader
        title="Violation tracker"
        description="Active inspection violations sorted by due date"
        actions={
          <Link
            href="/facilities"
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            ← Facilities
          </Link>
        }
      />

      <section className="rounded-2xl border border-gray-200 bg-white p-5">
        {violationsQ.isLoading ? (
          <LoadingSpinner />
        ) : sorted.length > 0 ? (
          <ul className="space-y-2 text-sm">
            {sorted.map((v) => (
              <li
                key={v.id}
                className={`rounded-lg border p-3 ${
                  isOverdue(v.dueDate) ? 'border-rose-300 bg-rose-50' : 'border-gray-200 bg-gray-50'
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${FAC_VIOL_SEVERITY_PILL[v.severity]}`}
                    >
                      {FAC_VIOL_SEVERITY_LABEL[v.severity]}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${
                        isOverdue(v.dueDate)
                          ? 'bg-rose-200 text-rose-900'
                          : 'bg-gray-200 text-gray-700'
                      }`}
                    >
                      {formatRelativeDue(v.dueDate)}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setOpenId(v.id)}
                    className="rounded-lg bg-emerald-700 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-800"
                  >
                    Resolve
                  </button>
                </div>
                <p className="mt-2 text-gray-900">{v.description}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-gray-500">No active violations. Buildings are compliant.</p>
        )}
      </section>

      {openId && (
        <ResolveViolationModal
          violation={sorted.find((v) => v.id === openId)!}
          onClose={() => setOpenId(null)}
        />
      )}
    </div>
  );
}

function ResolveViolationModal({
  violation,
  onClose,
}: {
  violation: FacViolationDto;
  onClose: () => void;
}) {
  const resolve = useFacResolveViolation(violation.id);
  const { toast } = useToast();
  const [notes, setNotes] = useState('');
  const [linkedWoId, setLinkedWoId] = useState('');

  return (
    <Modal
      open
      onClose={onClose}
      title="Resolve violation"
      footer={
        <button
          type="button"
          onClick={async () => {
            if (!notes) {
              toast('Resolution notes required', 'error');
              return;
            }
            try {
              await resolve.mutateAsync({
                resolutionNotes: notes,
                linkedWorkOrderId: linkedWoId || undefined,
              });
              toast('Violation resolved', 'success');
              onClose();
            } catch (err) {
              toast((err as Error).message, 'error');
            }
          }}
          disabled={resolve.isPending}
          className="rounded-lg bg-emerald-700 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:bg-gray-300"
        >
          {resolve.isPending ? 'Resolving…' : 'Mark resolved'}
        </button>
      }
    >
      <div className="space-y-3 text-sm">
        <div className="rounded-lg bg-gray-50 p-3 text-gray-700">{violation.description}</div>
        <label className="block">
          <span className="block font-medium text-gray-700">Resolution notes</span>
          <textarea
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="What was done to fix this?"
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="block">
          <span className="block font-medium text-gray-700">Linked work order (optional)</span>
          <input
            value={linkedWoId}
            onChange={(e) => setLinkedWoId(e.target.value.trim())}
            placeholder="UUID"
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-xs"
          />
        </label>
      </div>
    </Modal>
  );
}
