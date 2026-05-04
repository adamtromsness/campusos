'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner, PageLoader } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { cn } from '@/components/ui/cn';
import { useStudent } from '@/hooks/use-children';
import { useBehaviorPlans, useDisciplineIncidents } from '@/hooks/use-discipline';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  INCIDENT_STATUS_LABELS,
  INCIDENT_STATUS_PILL,
  PLAN_STATUS_LABELS,
  PLAN_STATUS_PILL,
  PLAN_TYPE_LABELS,
  SEVERITIES,
  SEVERITY_LABELS,
  SEVERITY_PILL,
  formatIncidentDate,
} from '@/lib/discipline-format';
import type { DisciplineIncidentDto, GoalDto, Severity } from '@/lib/types';

export default function ChildBehaviourPage() {
  const params = useParams<{ id: string }>();
  const studentId = params?.id ?? '';
  const user = useAuthStore((s) => s.user);
  const canRead = !!user && hasAnyPermission(user, ['beh-001:read']);
  const canReadPlans = !!user && hasAnyPermission(user, ['beh-002:read']);

  const student = useStudent(studentId);
  const incidents = useDisciplineIncidents({ studentId, limit: 200 }, !!studentId && canRead);
  const plans = useBehaviorPlans({ studentId }, !!studentId && canReadPlans);

  const recentIncidents = useMemo(() => {
    return (incidents.data ?? [])
      .slice()
      .sort((a, b) => b.incidentDate.localeCompare(a.incidentDate))
      .slice(0, 10);
  }, [incidents.data]);

  const incidentsBySeverity = useMemo(() => {
    const counts: Record<Severity, number> = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
    for (const inc of incidents.data ?? []) {
      counts[inc.severity]++;
    }
    return counts;
  }, [incidents.data]);

  const activePlans = useMemo(() => {
    return (plans.data ?? []).filter((p) => p.status === 'ACTIVE' || p.status === 'REVIEW');
  }, [plans.data]);

  if (!user) return null;
  if (!canRead) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Behaviour" />
        <EmptyState
          title="Access required"
          description="You need behaviour-read access to view this page."
        />
      </div>
    );
  }

  if (student.isLoading || !student.data) return <PageLoader label="Loading…" />;

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        href="/dashboard"
        className="mb-3 inline-flex items-center gap-1 text-sm text-campus-600 hover:text-campus-700"
      >
        ← Back to dashboard
      </Link>

      <PageHeader
        title={`${student.data.fullName}'s behaviour`}
        description={
          student.data.gradeLevel
            ? `Grade ${student.data.gradeLevel}${student.data.studentNumber ? ` · #${student.data.studentNumber}` : ''}`
            : undefined
        }
      />

      {/* Severity stat panel — total counts (not just live) so the parent
          sees the full history at a glance. */}
      <section className="mb-6 rounded-lg border border-gray-200 bg-white p-5">
        <h3 className="text-base font-semibold text-gray-900">Incidents by severity</h3>
        <p className="mt-0.5 text-xs text-gray-500">
          Includes all incidents on file. Resolved incidents stay in the count for context.
        </p>
        <dl className="mt-4 grid grid-cols-4 gap-3">
          {SEVERITIES.map((sev) => (
            <div key={sev} className={cn('rounded-lg p-3 text-center', SEVERITY_PILL[sev])}>
              <dt className="text-[10px] uppercase tracking-wide opacity-80">
                {SEVERITY_LABELS[sev]}
              </dt>
              <dd className="mt-1 text-2xl font-semibold">{incidentsBySeverity[sev]}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* Recent incidents list */}
      <section className="mb-6 rounded-lg border border-gray-200 bg-white p-5">
        <h3 className="text-base font-semibold text-gray-900">Recent incidents</h3>
        {incidents.isLoading ? (
          <div className="mt-3 flex items-center gap-2 text-sm text-gray-500">
            <LoadingSpinner size="sm" /> Loading…
          </div>
        ) : recentIncidents.length === 0 ? (
          <EmptyState
            title="No incidents on file"
            description={`There are no behaviour incidents on file for ${student.data.fullName}.`}
          />
        ) : (
          <ul className="mt-3 space-y-3">
            {recentIncidents.map((inc) => (
              <ParentIncidentRow key={inc.id} incident={inc} />
            ))}
          </ul>
        )}
      </section>

      {/* Active behaviour plans summary */}
      {canReadPlans && (
        <section className="rounded-lg border border-gray-200 bg-white p-5">
          <h3 className="text-base font-semibold text-gray-900">Active behaviour plans</h3>
          <p className="mt-0.5 text-xs text-gray-500">
            Read-only summary. Talk to your child&apos;s counsellor for details on strategies and
            goals.
          </p>
          {plans.isLoading ? (
            <div className="mt-3 flex items-center gap-2 text-sm text-gray-500">
              <LoadingSpinner size="sm" /> Loading…
            </div>
          ) : activePlans.length === 0 ? (
            <p className="mt-3 text-sm text-gray-500">
              No active behaviour plans on file for {student.data.fullName}.
            </p>
          ) : (
            <ul className="mt-3 space-y-3">
              {activePlans.map((p) => {
                const goalsMet = p.goals.filter((g) => g.progress === 'MET').length;
                const goalsInProgress = p.goals.filter((g) => g.progress === 'IN_PROGRESS').length;
                return (
                  <li key={p.id} className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-800 ring-1 ring-violet-200">
                        {PLAN_TYPE_LABELS[p.planType]}
                      </span>
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                          PLAN_STATUS_PILL[p.status],
                        )}
                      >
                        {PLAN_STATUS_LABELS[p.status]}
                      </span>
                      <span className="text-xs text-gray-500">
                        Review by {formatIncidentDate(p.reviewDate)}
                      </span>
                    </div>
                    <p className="mt-2 text-sm text-gray-900">
                      {p.goals.length === 0
                        ? 'No goals set yet'
                        : `${goalsMet} of ${p.goals.length} goals met` +
                          (goalsInProgress > 0 ? ` · ${goalsInProgress} in progress` : '')}
                    </p>
                    {p.goals.length > 0 && (
                      <ul className="mt-2 space-y-1">
                        {p.goals.map((g) => (
                          <ParentGoalRow key={g.id} goal={g} />
                        ))}
                      </ul>
                    )}
                    {p.targetBehaviors.length > 0 && (
                      <details className="mt-3 text-xs text-gray-600">
                        <summary className="cursor-pointer font-medium text-gray-700 hover:text-gray-900">
                          What we&apos;re working on
                        </summary>
                        <div className="mt-2 space-y-2">
                          <DetailBlock
                            label="Behaviours we're reducing"
                            items={p.targetBehaviors}
                          />
                          {p.replacementBehaviors.length > 0 && (
                            <DetailBlock
                              label="Behaviours we're building"
                              items={p.replacementBehaviors}
                            />
                          )}
                          {p.reinforcementStrategies.length > 0 && (
                            <DetailBlock label="Strategies" items={p.reinforcementStrategies} />
                          )}
                        </div>
                      </details>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

function ParentIncidentRow({ incident }: { incident: DisciplineIncidentDto }) {
  return (
    <li className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm">
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
        {incident.location && <span className="text-xs text-gray-500">· {incident.location}</span>}
      </div>
      <p className="mt-1 text-sm font-medium text-gray-900">{incident.categoryName}</p>
      <p className="mt-0.5 text-sm text-gray-700">{incident.description}</p>
      {incident.actions.length > 0 && (
        <div className="mt-2">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Actions taken</p>
          <ul className="mt-1 space-y-1">
            {incident.actions.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2 text-xs text-gray-700">
                <span className="font-medium">{a.actionTypeName}</span>
                {a.requiresParentNotification && (
                  <span
                    className={cn(
                      'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium',
                      a.parentNotified
                        ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
                        : 'bg-amber-50 text-amber-700 ring-1 ring-amber-200',
                    )}
                  >
                    {a.parentNotified
                      ? 'Notified ' +
                        (a.parentNotifiedAt
                          ? new Date(a.parentNotifiedAt).toLocaleDateString()
                          : '')
                      : 'Notification pending'}
                  </span>
                )}
                {a.startDate && a.endDate && a.startDate !== a.endDate && (
                  <span className="text-gray-500">
                    {formatIncidentDate(a.startDate)} – {formatIncidentDate(a.endDate)}
                  </span>
                )}
                {a.startDate && (!a.endDate || a.endDate === a.startDate) && (
                  <span className="text-gray-500">{formatIncidentDate(a.startDate)}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

function ParentGoalRow({ goal }: { goal: GoalDto }) {
  const dot =
    goal.progress === 'MET'
      ? 'bg-emerald-500'
      : goal.progress === 'IN_PROGRESS'
        ? 'bg-sky-500'
        : goal.progress === 'NOT_MET'
          ? 'bg-rose-500'
          : 'bg-gray-300';
  return (
    <li className="flex items-start gap-2 text-xs text-gray-700">
      <span className={cn('mt-1.5 h-1.5 w-1.5 flex-none rounded-full', dot)} />
      <span>{goal.goalText}</span>
    </li>
  );
}

function DetailBlock({ label, items }: { label: string; items: string[] }) {
  return (
    <div>
      <p className="text-[10px] font-medium uppercase tracking-wide text-gray-500">{label}</p>
      <ul className="mt-0.5 list-inside list-disc space-y-0.5 text-xs text-gray-700">
        {items.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ul>
    </div>
  );
}
