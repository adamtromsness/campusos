'use client';

import Link from 'next/link';
import { useState } from 'react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import {
  INJURY_SEVERITY_LABELS,
  INJURY_SEVERITY_PILL,
  RETURN_TO_PLAY_LABELS,
  RETURN_TO_PLAY_PILL,
  formatDate,
} from '@/lib/athletics-format';
import { useAthleticsInjuries } from '@/hooks/use-athletics';
import type { AthleticsReturnToPlayStatus } from '@/lib/types';

const STATUS_FILTERS: Array<{ key: AthleticsReturnToPlayStatus | 'ALL'; label: string }> = [
  { key: 'ALL', label: 'All' },
  { key: 'ACTIVE', label: 'Active' },
  { key: 'SIDELINED', label: 'Sidelined' },
  { key: 'CONCUSSION_PROTOCOL', label: 'Concussion protocol' },
  { key: 'CLEARED', label: 'Cleared' },
];

export default function InjuriesPage() {
  const [filter, setFilter] = useState<AthleticsReturnToPlayStatus | 'ALL'>('ALL');
  const injuriesQ = useAthleticsInjuries({
    status: filter === 'ALL' ? undefined : filter,
  });

  return (
    <div className="space-y-6">
      <PageHeader title="Injury log" description="Athletic injuries and concussion protocols" />

      <div className="flex flex-wrap gap-2">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`rounded-full px-3 py-1 text-sm ${
              filter === f.key
                ? 'bg-campus-600 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {injuriesQ.isLoading ? (
        <LoadingSpinner />
      ) : injuriesQ.data && injuriesQ.data.length > 0 ? (
        <div className="space-y-2">
          {injuriesQ.data.map((i) => (
            <Link
              key={i.id}
              href={`/athletics/injuries/${i.id}`}
              className={`block rounded-lg border bg-white p-4 hover:border-campus-300 ${
                i.returnToPlayStatus === 'CONCUSSION_PROTOCOL'
                  ? 'border-rose-300'
                  : 'border-gray-200'
              }`}
            >
              <div className="flex items-start justify-between">
                <div>
                  <div className="font-medium text-gray-900">
                    {i.studentName} — {i.bodyPart}
                  </div>
                  <div className="mt-1 text-sm text-gray-600">{i.injuryDescription}</div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${INJURY_SEVERITY_PILL[i.severity]}`}
                  >
                    {INJURY_SEVERITY_LABELS[i.severity]}
                  </span>
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${RETURN_TO_PLAY_PILL[i.returnToPlayStatus]}`}
                  >
                    {RETURN_TO_PLAY_LABELS[i.returnToPlayStatus]}
                  </span>
                </div>
              </div>
              <div className="mt-2 text-xs text-gray-500">
                {formatDate(i.injuryDate)} · logged by {i.loggedByName ?? '—'}
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <p className="text-sm text-gray-500">No injuries match the filter.</p>
      )}
    </div>
  );
}
