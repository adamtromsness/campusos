'use client';

import { useState } from 'react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import { useOfficials } from '@/hooks/use-athletics-advanced';

export default function OfficialsPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = hasAnyPermission(user, ['sch-001:admin']);
  const isAd = isAdmin || hasAnyPermission(user, ['ath-003:write']);
  const [sport, setSport] = useState<string>('');
  const [search, setSearch] = useState<string>('');
  const officialsQ = useOfficials({
    sport: sport || undefined,
    search: search || undefined,
    isAvailable: true,
  });

  if (!isAd) {
    return (
      <div className="space-y-6">
        <PageHeader title="Officials" description="Officials marketplace" />
        <div className="rounded-xl border border-gray-200 bg-white p-6 text-center text-sm text-gray-500">
          The officials marketplace is restricted to the Athletic Director.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Officials"
        description="Search platform-portable officials, manage assignments, and submit bidirectional ratings (ADR-063)"
      />

      <section className="rounded-xl border border-gray-200 bg-white p-6">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">Search marketplace</h2>
        <div className="mb-4 flex flex-wrap gap-3">
          <select
            value={sport}
            onChange={(e) => setSport(e.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
          >
            <option value="">All sports</option>
            <option value="BASKETBALL">Basketball</option>
            <option value="FOOTBALL">Football</option>
            <option value="SOCCER">Soccer</option>
            <option value="VOLLEYBALL">Volleyball</option>
          </select>
          <input
            type="text"
            placeholder="Search by name or bio…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
          />
        </div>
        {officialsQ.isLoading ? (
          <LoadingSpinner />
        ) : officialsQ.data && officialsQ.data.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {officialsQ.data.map((o) => (
              <div key={o.id} className="rounded-lg border border-gray-200 p-4">
                <div className="flex items-start justify-between">
                  <div className="font-medium text-gray-900">{o.personName ?? 'Official'}</div>
                  {o.isAvailable ? (
                    <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700">
                      Available
                    </span>
                  ) : (
                    <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
                      Inactive
                    </span>
                  )}
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {o.sports.map((sp) => (
                    <span
                      key={sp}
                      className="rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-700"
                    >
                      {sp}
                    </span>
                  ))}
                </div>
                {o.certificationLevel ? (
                  <div className="mt-2 text-xs text-gray-600">{o.certificationLevel}</div>
                ) : null}
                {o.baseFee !== null ? (
                  <div className="mt-1 text-xs text-gray-500">Base fee ${o.baseFee.toFixed(2)}</div>
                ) : null}
                {o.averageOverallRating !== null ? (
                  <div className="mt-1 text-xs text-amber-700">
                    ★ {o.averageOverallRating.toFixed(1)} ({o.ratingCount})
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-gray-500">No officials match the current filter.</p>
        )}
      </section>
    </div>
  );
}
