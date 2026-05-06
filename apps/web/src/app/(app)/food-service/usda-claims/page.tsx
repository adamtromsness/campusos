'use client';

import Link from 'next/link';
import { useState } from 'react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { useFdsGenerateUsdaClaim, useFdsUsdaClaims } from '@/hooks/use-food-service';
import { FDS_USDA_STATUS_LABEL, formatCurrency } from '@/lib/food-service-format';

export default function UsdaClaimsPage() {
  const claims = useFdsUsdaClaims();
  const generate = useFdsGenerateUsdaClaim();
  const { toast } = useToast();
  const [monthYear, setMonthYear] = useState(new Date().toISOString().slice(0, 7) + '-01');

  return (
    <div>
      <PageHeader
        title="USDA monthly claims"
        description="Aggregates FREE / REDUCED / PAID meal counts from transactions"
        actions={
          <Link
            href="/food-service"
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            ← Food Service
          </Link>
        }
      />

      <section className="mb-4 rounded-2xl border border-gray-200 bg-white p-5">
        <h2 className="text-base font-semibold text-gray-900">Generate a draft claim</h2>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="text-sm">
            <span className="block font-medium text-gray-700">Month</span>
            <input
              type="date"
              value={monthYear}
              onChange={(e) => setMonthYear(e.target.value)}
              className="mt-1 rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <button
            type="button"
            onClick={async () => {
              try {
                const res = await generate.mutateAsync({ monthYear });
                toast(
                  `Generated: ${res.freeMealsCount} free / ${res.reducedMealsCount} reduced / ${res.paidMealsCount} paid`,
                  'success',
                );
              } catch (err) {
                toast((err as Error).message, 'error');
              }
            }}
            disabled={generate.isPending}
            className="rounded-lg bg-campus-700 px-3 py-2 text-sm font-medium text-white hover:bg-campus-800 disabled:bg-gray-300"
          >
            {generate.isPending ? 'Generating…' : 'Generate draft'}
          </button>
        </div>
      </section>

      {claims.isLoading ? (
        <LoadingSpinner />
      ) : claims.data && claims.data.length > 0 ? (
        <ul className="space-y-2">
          {claims.data.map((c) => (
            <li key={c.id} className="rounded-2xl border border-gray-200 bg-white p-4">
              <div className="flex items-baseline justify-between gap-3">
                <div>
                  <div className="font-semibold text-gray-900">{c.monthYear.slice(0, 7)}</div>
                  <div className="text-xs text-gray-500">
                    {c.freeMealsCount} free / {c.reducedMealsCount} reduced / {c.paidMealsCount}{' '}
                    paid
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-base font-semibold text-gray-900">
                    {formatCurrency(c.reimbursementAmount)}
                  </div>
                  <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs text-sky-700">
                    {FDS_USDA_STATUS_LABEL[c.status]}
                  </span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-gray-500">No claims yet.</p>
      )}
    </div>
  );
}
