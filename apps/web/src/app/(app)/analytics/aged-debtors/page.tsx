'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/ui';
import { useAgedDebtors } from '@/hooks/use-analytics';
import { formatCurrency, formatRelativeAgo } from '@/lib/analytics-format';

export default function AgedDebtorsPage() {
  const data = useAgedDebtors();
  const total = (data.data ?? []).reduce((acc, r) => acc + r.totalOutstanding, 0);

  return (
    <div>
      <PageHeader
        title="Aged debtors"
        description="Per-family outstanding balance buckets (current / 30 / 60 / 90+)."
        actions={
          <Link href="/analytics" className="text-sm text-campus-600 hover:underline">
            ← Analytics
          </Link>
        }
      />

      <section className="mb-6 grid gap-3 sm:grid-cols-3">
        <Stat label="Families with balances" value={(data.data ?? []).length.toString()} />
        <Stat label="Total outstanding" value={formatCurrency(total)} tone="text-rose-700" />
        <Stat
          label="90+ days"
          value={formatCurrency((data.data ?? []).reduce((a, r) => a + r.days90Plus, 0))}
          tone="text-rose-800"
        />
      </section>

      {data.isLoading ? (
        <div className="text-sm text-gray-500">Loading…</div>
      ) : (data.data ?? []).length === 0 ? (
        <div className="rounded-md border border-dashed border-emerald-200 bg-emerald-50 px-4 py-12 text-center text-sm text-emerald-700">
          No outstanding balances. Run the Finance AR worker if Cycle 6 invoices have changed.
        </div>
      ) : (
        <div className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-gray-100">
            <thead className="bg-gray-50">
              <tr>
                <Th>Family</Th>
                <Th className="text-right">Total</Th>
                <Th className="text-right">Current</Th>
                <Th className="text-right">30 days</Th>
                <Th className="text-right">60 days</Th>
                <Th className="text-right">90+ days</Th>
                <Th>Last payment</Th>
                <Th />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {(data.data ?? []).map((r) => (
                <tr key={r.id}>
                  <Td>{r.accountHolderName ?? '—'}</Td>
                  <Td className="text-right font-semibold">{formatCurrency(r.totalOutstanding)}</Td>
                  <Td className="text-right">{formatCurrency(r.currentBucket)}</Td>
                  <Td className="text-right text-amber-700">{formatCurrency(r.days30)}</Td>
                  <Td className="text-right text-orange-700">{formatCurrency(r.days60)}</Td>
                  <Td className="text-right text-rose-700">{formatCurrency(r.days90Plus)}</Td>
                  <Td className="text-xs text-gray-500">
                    {r.lastPaymentDate ? formatRelativeAgo(r.lastPaymentDate) : 'never'}
                  </Td>
                  <Td>
                    <Link
                      href={`/billing/accounts/${r.familyAccountId}`}
                      className="text-xs text-campus-700 hover:underline"
                    >
                      Open account →
                    </Link>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-card border border-gray-200 bg-white p-4 shadow-sm">
      <div className="text-xs font-semibold uppercase tracking-wide text-gray-600">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${tone ?? 'text-gray-900'}`}>{value}</div>
    </div>
  );
}

function Th({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return (
    <th
      className={`px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-600 ${className}`}
    >
      {children}
    </th>
  );
}

function Td({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return (
    <td className={`whitespace-nowrap px-4 py-2.5 text-sm text-gray-700 ${className}`}>
      {children}
    </td>
  );
}
