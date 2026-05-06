'use client';

import Link from 'next/link';
import { EmptyState, PageHeader } from '@/components/ui';
import { formatDateTime, formatPercentage } from '@/lib/procurement-format';
import { useVendorPerformance } from '@/hooks/use-procurement';

export default function VendorPerformancePage() {
  const vp = useVendorPerformance();

  return (
    <div>
      <PageHeader
        title="Vendor performance"
        description="Live scores updated atomically per goods receipt: quality (accepted / total) and on-time delivery."
        actions={
          <Link href="/procurement" className="text-sm text-campus-600 hover:underline">
            ← Back to Procurement
          </Link>
        }
      />

      {vp.isLoading ? (
        <div className="text-sm text-gray-500">Loading…</div>
      ) : (vp.data ?? []).length === 0 ? (
        <EmptyState
          title="No vendor scoring data yet"
          description="Vendor performance materialises after the first goods receipt is logged against each vendor."
        />
      ) : (
        <div className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-gray-100">
            <thead className="bg-gray-50">
              <tr>
                <Th>Vendor</Th>
                <Th className="text-right">Orders</Th>
                <Th className="text-right">On-time</Th>
                <Th className="text-right">Late</Th>
                <Th className="text-right">Accepted</Th>
                <Th className="text-right">Rejected</Th>
                <Th className="text-right">Quality score</Th>
                <Th className="text-right">Delivery score</Th>
                <Th>Last updated</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {(vp.data ?? []).map((row) => (
                <tr key={row.id}>
                  <Td>{row.vendorName ?? '—'}</Td>
                  <Td className="text-right">{row.totalOrders}</Td>
                  <Td className="text-right text-emerald-700">{row.onTimeDeliveries}</Td>
                  <Td className="text-right text-rose-700">{row.lateDeliveries}</Td>
                  <Td className="text-right text-emerald-700">{row.acceptedCount}</Td>
                  <Td className="text-right text-rose-700">{row.rejectedCount}</Td>
                  <Td className="text-right">
                    <ScorePill score={row.averageQualityScore} />
                  </Td>
                  <Td className="text-right">
                    <ScorePill score={row.averageDeliveryScore} />
                  </Td>
                  <Td>{formatDateTime(row.lastUpdatedAt)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ScorePill({ score }: { score: number | null }) {
  if (score === null) return <span className="text-gray-400">—</span>;
  const tone =
    score >= 0.95
      ? 'bg-emerald-100 text-emerald-700'
      : score >= 0.8
        ? 'bg-amber-100 text-amber-700'
        : 'bg-rose-100 text-rose-700';
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${tone}`}>
      {formatPercentage(score)}
    </span>
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
