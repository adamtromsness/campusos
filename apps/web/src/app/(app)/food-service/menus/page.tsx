'use client';

import Link from 'next/link';
import { useState } from 'react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import {
  useFdsAllergenCheck,
  useFdsDailyMenus,
  useFdsMenuCycles,
  useFdsMenuItems,
} from '@/hooks/use-food-service';
import { FDS_CATEGORY_LABEL, FDS_CATEGORY_PILL, formatCurrency } from '@/lib/food-service-format';

const ALLERGEN_FILTERS = [
  'MILK',
  'EGG',
  'WHEAT',
  'PEANUTS',
  'TREE_NUTS',
  'SOYBEANS',
  'FISH',
  'SHELLFISH',
  'SESAME',
];

export default function FoodServiceMenusPage() {
  const [allergenFilter, setAllergenFilter] = useState<string[]>([]);

  const cyclesQ = useFdsMenuCycles();
  const allItemsQ = useFdsMenuItems({});
  const allergenItemsQ = useFdsAllergenCheck(allergenFilter);
  const today = new Date().toISOString().slice(0, 10);
  const weekFromNow = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const dailyMenusQ = useFdsDailyMenus(today, weekFromNow);

  const items = allergenFilter.length > 0 ? (allergenItemsQ.data ?? []) : (allItemsQ.data ?? []);

  return (
    <div>
      <PageHeader
        title="Menu planner"
        description="Cycles, items with allergen codes, daily menus"
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
        <h2 className="text-base font-semibold text-gray-900">Cycles</h2>
        {cyclesQ.isLoading ? (
          <LoadingSpinner />
        ) : cyclesQ.data && cyclesQ.data.length > 0 ? (
          <ul className="mt-3 grid gap-2 lg:grid-cols-3">
            {cyclesQ.data.map((c) => (
              <li key={c.id} className="rounded-lg border border-gray-100 bg-gray-50 p-3 text-sm">
                <div className="font-medium text-gray-900">{c.name}</div>
                <div className="text-xs text-gray-500">
                  {c.cycleLengthDays}-day cycle · {c.isActive ? 'Active' : 'Inactive'}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-gray-500">No cycles configured.</p>
        )}
      </section>

      <section className="mb-4 rounded-2xl border border-gray-200 bg-white p-5">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-base font-semibold text-gray-900">Item catalogue</h2>
          <span className="text-xs text-gray-500">
            {items.length} item{items.length === 1 ? '' : 's'}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          {ALLERGEN_FILTERS.map((code) => {
            const active = allergenFilter.includes(code);
            return (
              <button
                key={code}
                type="button"
                onClick={() =>
                  setAllergenFilter((prev) =>
                    active ? prev.filter((c) => c !== code) : [...prev, code],
                  )
                }
                className={`rounded-full border px-2.5 py-0.5 text-xs ${
                  active
                    ? 'border-rose-700 bg-rose-700 text-white'
                    : 'border-rose-300 bg-white text-rose-700'
                }`}
              >
                {code}
              </button>
            );
          })}
          {allergenFilter.length > 0 && (
            <button
              type="button"
              onClick={() => setAllergenFilter([])}
              className="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs text-gray-700"
            >
              Clear
            </button>
          )}
        </div>
        {allItemsQ.isLoading ? (
          <LoadingSpinner />
        ) : (
          <ul className="mt-3 grid gap-2 lg:grid-cols-2">
            {items.map((it) => (
              <li key={it.id} className="rounded-lg border border-gray-100 bg-gray-50 p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium text-gray-900">{it.name}</span>
                  <span className="text-xs text-gray-500">{formatCurrency(it.unitCost)}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs ${FDS_CATEGORY_PILL[it.category]}`}
                  >
                    {FDS_CATEGORY_LABEL[it.category]}
                  </span>
                  {it.calories !== null && (
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
                      {it.calories} cal
                    </span>
                  )}
                  {it.isVegetarian && (
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700">
                      Veg
                    </span>
                  )}
                  {it.isGlutenFree && (
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700">
                      GF
                    </span>
                  )}
                  {it.allergenCodes.map((code) => (
                    <span
                      key={code}
                      className="rounded-full bg-rose-100 px-2 py-0.5 text-xs text-rose-700"
                    >
                      {code}
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-2xl border border-gray-200 bg-white p-5">
        <h2 className="text-base font-semibold text-gray-900">Upcoming daily menus</h2>
        {dailyMenusQ.isLoading ? (
          <LoadingSpinner />
        ) : dailyMenusQ.data && dailyMenusQ.data.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {dailyMenusQ.data.map((m) => (
              <li key={m.id} className="rounded-lg border border-gray-100 bg-gray-50 p-3">
                <div className="flex items-baseline justify-between gap-3">
                  <div>
                    <div className="font-medium text-gray-900">
                      {m.menuDate} · {m.mealType}
                    </div>
                    <div className="text-xs text-gray-500">
                      {(m.items ?? []).length} item
                      {(m.items ?? []).length === 1 ? '' : 's'}
                    </div>
                  </div>
                </div>
                <ul className="mt-2 flex flex-wrap gap-1 text-xs">
                  {(m.items ?? []).map((it) => (
                    <li
                      key={it.id}
                      className="rounded-full bg-white px-2 py-0.5 text-gray-700 ring-1 ring-gray-200"
                    >
                      {it.menuItemName}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-gray-500">No daily menus in the next 7 days.</p>
        )}
      </section>
    </div>
  );
}
