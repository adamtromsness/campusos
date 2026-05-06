'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { EmptyState, PageHeader } from '@/components/ui';
import {
  formatCurrency,
  formatDate,
  PRC_REQ_STATUSES,
  REQ_STATUS_LABELS,
  REQ_STATUS_PILL,
  URGENCY_LABELS,
  URGENCY_PILL,
} from '@/lib/procurement-format';
import { useRequisitions } from '@/hooks/use-procurement';

export default function RequisitionsListPage() {
  const [status, setStatus] = useState<string>('');
  const reqs = useRequisitions(status ? { status } : undefined);

  const counts = useMemo(() => {
    const map: Record<string, number> = { ALL: 0 };
    for (const r of reqs.data ?? []) {
      map.ALL = (map.ALL ?? 0) + 1;
      map[r.status] = (map[r.status] ?? 0) + 1;
    }
    return map;
  }, [reqs.data]);

  return (
    <div>
      <PageHeader
        title="Requisitions"
        description="Submit and track procurement requests."
        actions={
          <Link
            href="/procurement/requisitions/new"
            className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white"
          >
            New requisition
          </Link>
        }
      />

      <div className="mb-4 flex flex-wrap gap-2">
        <FilterChip
          label={`All (${counts.ALL ?? 0})`}
          active={status === ''}
          onClick={() => setStatus('')}
        />
        {PRC_REQ_STATUSES.map((s) => (
          <FilterChip
            key={s}
            label={REQ_STATUS_LABELS[s]}
            active={status === s}
            onClick={() => setStatus(s)}
          />
        ))}
      </div>

      {reqs.isLoading ? (
        <div className="text-sm text-gray-500">Loading…</div>
      ) : (reqs.data ?? []).length === 0 ? (
        <EmptyState
          title={
            status
              ? `No requisitions in ${REQ_STATUS_LABELS[status as never] ?? status}`
              : 'No requisitions yet'
          }
          description="Create your first requisition to start the procurement workflow."
          action={
            <Link
              href="/procurement/requisitions/new"
              className="rounded-md bg-campus-600 px-3 py-1.5 text-sm font-medium text-white"
            >
              New requisition
            </Link>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-gray-100">
            <thead className="bg-gray-50">
              <tr>
                <Th>Status</Th>
                <Th>Urgency</Th>
                <Th>Justification</Th>
                <Th>Lines</Th>
                <Th className="text-right">Estimate</Th>
                <Th>Requester</Th>
                <Th>Submitted</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 bg-white">
              {(reqs.data ?? []).map((r) => (
                <tr key={r.id} className="hover:bg-gray-50">
                  <Td>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${REQ_STATUS_PILL[r.status]}`}
                    >
                      {REQ_STATUS_LABELS[r.status]}
                    </span>
                  </Td>
                  <Td>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${URGENCY_PILL[r.urgency]}`}
                    >
                      {URGENCY_LABELS[r.urgency]}
                    </span>
                  </Td>
                  <Td>
                    <Link
                      href={`/procurement/requisitions/${r.id}`}
                      className="text-campus-700 hover:underline"
                    >
                      {r.justification.slice(0, 80)}
                      {r.justification.length > 80 ? '…' : ''}
                    </Link>
                  </Td>
                  <Td>{r.lines.length}</Td>
                  <Td className="text-right">{formatCurrency(r.totalEstimatedCost)}</Td>
                  <Td>{r.requestingPersonName ?? '—'}</Td>
                  <Td>{formatDate(r.submittedAt)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
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
