'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { cn } from '@/components/ui/cn';
import { useDisciplineIncidents } from '@/hooks/use-discipline';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  INCIDENT_STATUS_LABELS,
  INCIDENT_STATUS_PILL,
  SEVERITY_LABELS,
  SEVERITY_PILL,
  formatIncidentDate,
  isIncidentLive,
  sortIncidents,
  studentName,
} from '@/lib/discipline-format';
import type { DisciplineIncidentDto, IncidentStatus } from '@/lib/types';

type FilterChip = IncidentStatus | 'ALL' | 'LIVE';

const FILTER_CHIPS: Array<{ value: FilterChip; label: string }> = [
  { value: 'LIVE', label: 'Live' },
  { value: 'OPEN', label: 'Open' },
  { value: 'UNDER_REVIEW', label: 'Under review' },
  { value: 'RESOLVED', label: 'Resolved' },
  { value: 'ALL', label: 'All' },
];

function applyFilter(list: DisciplineIncidentDto[], chip: FilterChip): DisciplineIncidentDto[] {
  switch (chip) {
    case 'LIVE':
      return list.filter((i) => isIncidentLive(i.status));
    case 'OPEN':
      return list.filter((i) => i.status === 'OPEN');
    case 'UNDER_REVIEW':
      return list.filter((i) => i.status === 'UNDER_REVIEW');
    case 'RESOLVED':
      return list.filter((i) => i.status === 'RESOLVED');
    case 'ALL':
    default:
      return list;
  }
}

export default function BehaviourQueuePage() {
  const user = useAuthStore((s) => s.user);
  const canRead = !!user && hasAnyPermission(user, ['beh-001:read']);
  const canReport = !!user && hasAnyPermission(user, ['beh-001:write']);
  const isAdmin = !!user && hasAnyPermission(user, ['beh-001:admin', 'sch-001:admin']);
  const [filter, setFilter] = useState<FilterChip>('LIVE');

  const incidents = useDisciplineIncidents({ limit: 200 }, canRead);

  const visible = useMemo(() => {
    const filtered = applyFilter(incidents.data ?? [], filter);
    return filtered.slice().sort(sortIncidents);
  }, [incidents.data, filter]);

  const liveCount = useMemo(
    () => (incidents.data ?? []).filter((i) => isIncidentLive(i.status)).length,
    [incidents.data],
  );

  if (!user) return null;
  if (!canRead) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Behaviour" />
        <EmptyState
          title="Access required"
          description="You need behaviour-read access to view the discipline queue."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Behaviour"
        description={
          liveCount === 0
            ? 'No live incidents — log one if a behaviour issue needs attention.'
            : liveCount === 1
              ? '1 live incident'
              : liveCount + ' live incidents'
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {isAdmin && (
              <Link
                href="/behaviour/admin/categories"
                className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Manage catalogue
              </Link>
            )}
            {canReport && (
              <Link
                href="/behaviour/report"
                className="inline-flex items-center gap-2 rounded-lg bg-campus-700 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-campus-800"
              >
                Report incident
              </Link>
            )}
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {FILTER_CHIPS.map((chip) => (
          <button
            key={chip.value}
            type="button"
            onClick={() => setFilter(chip.value)}
            className={cn(
              'rounded-full px-3 py-1 text-sm transition',
              filter === chip.value
                ? 'bg-campus-700 text-white'
                : 'bg-white text-gray-700 ring-1 ring-gray-200 hover:bg-gray-50',
            )}
          >
            {chip.label}
          </button>
        ))}
      </div>

      {incidents.isLoading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-gray-500">
          <LoadingSpinner size="sm" /> Loading…
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          title="No incidents to show"
          description={
            filter === 'LIVE'
              ? 'No live incidents. Report one if a behaviour issue needs attention.'
              : 'Nothing matches this filter.'
          }
        />
      ) : (
        <ul className="space-y-2">
          {visible.map((incident) => (
            <IncidentRow key={incident.id} incident={incident} />
          ))}
        </ul>
      )}
    </div>
  );
}

function IncidentRow({ incident }: { incident: DisciplineIncidentDto }) {
  return (
    <li>
      <Link
        href={'/behaviour/' + incident.id}
        className="block rounded-lg border border-gray-200 bg-white p-4 transition hover:border-campus-300 hover:bg-campus-50/40"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
              SEVERITY_PILL[incident.severity],
            )}
          >
            {SEVERITY_LABELS[incident.severity]}
          </span>
          <span
            className={cn(
              'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
              INCIDENT_STATUS_PILL[incident.status],
            )}
          >
            {INCIDENT_STATUS_LABELS[incident.status]}
          </span>
          <span className="text-xs text-gray-500">{formatIncidentDate(incident.incidentDate)}</span>
          {incident.actions.length > 0 && (
            <span className="rounded-full bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700 ring-1 ring-violet-200">
              {incident.actions.length} action{incident.actions.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
        <p className="mt-2 text-sm font-medium text-gray-900">
          {studentName(incident)}
          {incident.studentGradeLevel ? ' · Grade ' + incident.studentGradeLevel : ''} ·{' '}
          <span className="text-gray-700">{incident.categoryName}</span>
        </p>
        <p className="mt-0.5 line-clamp-2 text-sm text-gray-600">{incident.description}</p>
        <p className="mt-1 text-xs text-gray-500">
          {incident.reportedByName
            ? 'Reported by ' + incident.reportedByName
            : 'Reported anonymously'}
          {incident.location ? ' · ' + incident.location : ''}
        </p>
      </Link>
    </li>
  );
}
