'use client';

import Link from 'next/link';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { useStocktakes } from '@/hooks/use-facilities-advanced';
import type { StocktakeStatus } from '@/lib/types';

const STATUS_PILL: Record<StocktakeStatus, string> = {
  IN_PROGRESS: 'bg-amber-100 text-amber-700',
  COMPLETED: 'bg-emerald-100 text-emerald-700',
};

export default function StocktakesPage() {
  const stocktakesQ = useStocktakes();

  return (
    <div>
      <PageHeader
        title="Supply stocktakes"
        description="Expected vs actual count audits. Completing a stocktake creates ADJUSTMENT transactions for every discrepancy."
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
        {stocktakesQ.isLoading ? (
          <LoadingSpinner />
        ) : stocktakesQ.data && stocktakesQ.data.length > 0 ? (
          <ul className="space-y-3">
            {stocktakesQ.data.map((s) => {
              const discrepancies = s.items.filter((it) => it.discrepancy !== 0);
              return (
                <li key={s.id} className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                  <div className="flex items-baseline justify-between">
                    <span className="text-sm font-semibold text-gray-900">
                      {s.buildingName ?? 'Building'} — {s.stocktakeDate}
                    </span>
                    <span className={'rounded-full px-1.5 py-0.5 text-xs ' + STATUS_PILL[s.status]}>
                      {s.status === 'IN_PROGRESS' ? 'In progress' : 'Completed'}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-gray-500">
                    Conducted by {s.conductedByName ?? 'Staff'} · {s.items.length} item
                    {s.items.length === 1 ? '' : 's'}
                    {discrepancies.length > 0 && (
                      <>
                        {' '}
                        ·{' '}
                        <span className="text-amber-700">
                          {discrepancies.length} discrepanc
                          {discrepancies.length === 1 ? 'y' : 'ies'}
                        </span>
                      </>
                    )}
                  </p>
                  {discrepancies.length > 0 && (
                    <ul className="mt-2 space-y-1 text-xs">
                      {discrepancies.slice(0, 5).map((it) => (
                        <li key={it.id} className="flex items-baseline justify-between">
                          <span className="text-gray-700">{it.itemName ?? 'Item'}</span>
                          <span className="text-gray-500">
                            expected {it.expectedQuantity} / actual {it.actualQuantity} (
                            <span
                              className={it.discrepancy < 0 ? 'text-rose-700' : 'text-emerald-700'}
                            >
                              {it.discrepancy > 0 ? '+' : ''}
                              {it.discrepancy}
                            </span>
                            )
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-gray-500">No stocktakes recorded yet.</p>
        )}
      </section>
    </div>
  );
}
