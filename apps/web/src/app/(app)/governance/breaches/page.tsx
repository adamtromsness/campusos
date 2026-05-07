'use client';

import Link from 'next/link';
import { useState } from 'react';
import { PageHeader } from '@/components/ui';
import { useBreaches } from '@/hooks/use-governance';
import {
  BREACH_RISK_PILL,
  BREACH_STATUS_LABELS,
  BREACH_STATUS_PILL,
  BREACH_TYPE_LABELS,
  formatBreachCountdown,
  formatDateTime,
  tonePill,
} from '@/lib/governance-format';

export default function BreachesPage() {
  const [pendingNotificationOnly, setPendingOnly] = useState(false);
  const breaches = useBreaches({ pendingNotificationOnly });

  return (
    <div>
      <PageHeader
        title="Data breach register"
        description="GDPR Article 33 breach log. Each row carries a 72-hour countdown when supervisory authority notification is required."
      />

      <div className="mb-4 flex items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={pendingNotificationOnly}
            onChange={(e) => setPendingOnly(e.target.checked)}
            className="rounded border-gray-300"
          />
          <span>Awaiting supervisory authority notification only</span>
        </label>
        <Link href="/governance" className="ml-auto text-sm text-gray-500 hover:text-campus-700">
          ← Back to compliance dashboard
        </Link>
      </div>

      {breaches.isLoading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : !breaches.data || breaches.data.length === 0 ? (
        <p className="text-sm text-gray-500">No breach records.</p>
      ) : (
        <ul className="space-y-3">
          {breaches.data.map((b) => {
            const cd = formatBreachCountdown(b.hoursRemainingTo72);
            const isOverdue = b.isOverdue;
            return (
              <li
                key={b.id}
                className={`rounded-card border p-4 shadow-sm ${
                  isOverdue
                    ? 'border-rose-300 bg-rose-50'
                    : b.status === 'RESOLVED'
                      ? 'border-gray-200 bg-gray-50'
                      : 'border-gray-200 bg-white'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      href={`/governance/breaches/${b.id}`}
                      className="block text-base font-semibold text-gray-900 hover:text-campus-700"
                    >
                      {b.breachTitle}
                    </Link>
                    <div className="mt-1 flex flex-wrap gap-2 text-xs">
                      <span
                        className={`rounded-full px-2 py-0.5 font-semibold ${
                          BREACH_STATUS_PILL[b.status] ?? 'bg-gray-100 text-gray-700'
                        }`}
                      >
                        {BREACH_STATUS_LABELS[b.status] ?? b.status}
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 font-semibold ${
                          BREACH_RISK_PILL[b.riskLevel] ?? 'bg-gray-100 text-gray-700'
                        }`}
                      >
                        Risk {b.riskLevel}
                      </span>
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 font-semibold text-gray-700">
                        {BREACH_TYPE_LABELS[b.breachType] ?? b.breachType}
                      </span>
                      {b.estimatedAffectedIndividuals !== null && (
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 font-semibold text-gray-700">
                          {b.estimatedAffectedIndividuals.toLocaleString()} affected
                        </span>
                      )}
                    </div>
                    <div className="mt-2 text-xs text-gray-600">
                      Discovered {formatDateTime(b.discoveryDate)} — {b.hoursSinceDiscovery}h ago
                    </div>
                  </div>
                  {b.supervisoryAuthorityNotificationRequired && (
                    <span
                      className={`rounded-full px-3 py-1 text-xs font-bold ${tonePill(cd.tone)}`}
                    >
                      {cd.label}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
