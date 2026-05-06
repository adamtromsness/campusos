'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { EmptyState, PageHeader } from '@/components/ui';
import {
  COMMITMENT_LABELS,
  COMMITMENT_PILL,
  formatCurrency,
  formatDate,
  formatDateTime,
} from '@/lib/procurement-format';
import { usePurchaseOrders } from '@/hooks/use-procurement';

export default function CommitmentsPage() {
  const pos = usePurchaseOrders();

  const rows = useMemo(() => {
    const list = pos.data ?? [];
    return list.flatMap((p) =>
      p.commitments.map((c) => ({
        commitment: c,
        po: p,
      })),
    );
  }, [pos.data]);

  const totalCommitted = useMemo(
    () =>
      rows
        .filter((r) => r.commitment.status !== 'RELEASED')
        .reduce((sum, r) => sum + r.commitment.committedAmount - r.commitment.releasedAmount, 0),
    [rows],
  );

  return (
    <div>
      <PageHeader
        title="Budget commitments"
        description="Active encumbrances against fin_budget_lines. PO ISSUE commits, CLOSE/CANCEL releases."
        actions={
          <Link href="/procurement" className="text-sm text-campus-600 hover:underline">
            ← Back to Procurement
          </Link>
        }
      />

      <div className="mb-6 rounded-card border border-violet-200 bg-violet-50 p-4 text-violet-800">
        <div className="text-xs uppercase tracking-wide opacity-70">Total active encumbrance</div>
        <div className="mt-1 text-2xl font-bold">{formatCurrency(totalCommitted)}</div>
      </div>

      {pos.isLoading ? (
        <div className="text-sm text-gray-500">Loading…</div>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No active commitments"
          description="Issuing a PO will create a commitment row here and bump fin_budget_lines.encumbered_amount in one transaction."
        />
      ) : (
        <div className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-gray-100">
            <thead className="bg-gray-50">
              <tr>
                <Th>PO</Th>
                <Th>Vendor</Th>
                <Th>Budget account</Th>
                <Th className="text-right">Committed</Th>
                <Th className="text-right">Released</Th>
                <Th className="text-right">Net encumbered</Th>
                <Th>Status</Th>
                <Th>Released at</Th>
                <Th>PO issued</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map(({ commitment: c, po }) => {
                const net = c.committedAmount - c.releasedAmount;
                return (
                  <tr key={c.id}>
                    <Td>
                      <Link
                        href={`/procurement/purchase-orders/${po.id}`}
                        className="font-medium text-campus-700 hover:underline"
                      >
                        {po.poNumber}
                      </Link>
                    </Td>
                    <Td>{po.vendorName ?? '—'}</Td>
                    <Td>{c.budgetAccountCode ?? '—'}</Td>
                    <Td className="text-right">{formatCurrency(c.committedAmount)}</Td>
                    <Td className="text-right">{formatCurrency(c.releasedAmount)}</Td>
                    <Td className="text-right">
                      {c.status === 'RELEASED' ? (
                        <span className="text-gray-400">—</span>
                      ) : (
                        <strong className="text-violet-700">{formatCurrency(net)}</strong>
                      )}
                    </Td>
                    <Td>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-semibold ${COMMITMENT_PILL[c.status]}`}
                      >
                        {COMMITMENT_LABELS[c.status]}
                      </span>
                    </Td>
                    <Td>{formatDateTime(c.releasedAt)}</Td>
                    <Td>{formatDate(po.issuedAt)}</Td>
                  </tr>
                );
              })}
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
