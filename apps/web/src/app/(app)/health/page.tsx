'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import {
  useImmunisationCompliance,
  useMedicationDashboard,
  useNurseVisitRoster,
} from '@/hooks/use-health';
import { useUpdateNurseVisit } from '@/hooks/use-health';
import { useToast } from '@/components/ui/Toast';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  DASHBOARD_STATUS_LABELS,
  DASHBOARD_STATUS_PILL,
  formatTime,
  studentDisplayName,
} from '@/lib/health-format';
import type { NurseVisitDto } from '@/lib/types';

/* /health — three-panel nurse dashboard.
 * Reads:
 *   - GET /health/nurse-visits/roster (live IN_PROGRESS)
 *   - GET /health/medication-dashboard (today's school-wide schedule)
 *   - GET /health/immunisation-compliance (admin-only OVERDUE rollup)
 */

export default function NurseDashboardPage() {
  const user = useAuthStore((s) => s.user);
  const canReadHealth = !!user && hasAnyPermission(user, ['hlt-001:read']);
  const isNurseScope =
    !!user && hasAnyPermission(user, ['hlt-001:write', 'hlt-002:read', 'hlt-002:write']);
  const isAdmin = !!user && hasAnyPermission(user, ['hlt-001:admin', 'sch-001:admin']);

  if (!user || !canReadHealth) {
    return (
      <div className="mx-auto max-w-6xl space-y-6 p-6">
        <PageHeader title="Health" />
        <EmptyState
          title="Health is not available for your account"
          description="Your role does not include health-record read access."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <PageHeader
        title="Nurse dashboard"
        description="Live office roster, today's medication schedule, and immunisation compliance."
        actions={
          isNurseScope ? (
            <div className="flex flex-wrap gap-2">
              <Link
                href="/health/nurse-visits"
                className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Visit log
              </Link>
              <Link
                href="/health/medications"
                className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Medications
              </Link>
              <Link
                href="/health/screenings"
                className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Screenings
              </Link>
              <Link
                href="/health/dietary"
                className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Dietary
              </Link>
            </div>
          ) : null
        }
      />

      <RosterPanel />
      <MedicationPanel />
      {isAdmin ? <CompliancePanel /> : null}
    </div>
  );
}

function RosterPanel() {
  const { toast } = useToast();
  const roster = useNurseVisitRoster();

  return (
    <section className="rounded-lg border border-gray-200 bg-white">
      <header className="flex items-center justify-between border-b border-gray-200 p-4">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Live roster</h2>
          <p className="text-sm text-gray-500">
            Students and staff currently signed in to the nurse office.
          </p>
        </div>
        <Link
          href="/health/nurse-visits"
          className="text-sm font-medium text-campus-600 hover:text-campus-700"
        >
          Sign someone in →
        </Link>
      </header>
      <div className="p-4">
        {roster.isLoading ? (
          <LoadingSpinner />
        ) : (roster.data ?? []).length === 0 ? (
          <EmptyState
            title="No active visits"
            description="When a nurse signs someone in, they will appear here."
          />
        ) : (
          <ul className="divide-y divide-gray-100">
            {(roster.data ?? []).map((v) => (
              <RosterRow key={v.id} visit={v} onSignedOut={() => toast('Signed out', 'success')} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function RosterRow({ visit, onSignedOut }: { visit: NurseVisitDto; onSignedOut: () => void }) {
  const update = useUpdateNurseVisit(visit.id);
  return (
    <li className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <div className="flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold text-gray-900">
            {visit.visitedPersonName ?? visit.visitedPersonId.slice(0, 8)}
          </p>
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-amber-200">
            {visit.visitedPersonType === 'STUDENT' ? 'Student' : 'Staff'}
          </span>
        </div>
        {visit.reason ? <p className="mt-1 text-sm text-gray-600">{visit.reason}</p> : null}
        <p className="mt-1 text-xs text-gray-500">
          Signed in{' '}
          {new Date(visit.signedInAt).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </p>
      </div>
      <button
        type="button"
        onClick={() => {
          update.mutate({ signOut: true }, { onSuccess: onSignedOut });
        }}
        disabled={update.isPending}
        className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
      >
        {update.isPending ? 'Signing out…' : 'Sign out'}
      </button>
    </li>
  );
}

function MedicationPanel() {
  const dashboard = useMedicationDashboard();

  const grouped = useMemo(() => {
    const by: Record<string, typeof dashboard.data> = {};
    for (const r of dashboard.data ?? []) {
      const key = r.scheduledTime;
      if (!by[key]) by[key] = [];
      by[key]!.push(r);
    }
    return Object.entries(by).sort(([a], [b]) => a.localeCompare(b));
  }, [dashboard.data]);

  return (
    <section className="rounded-lg border border-gray-200 bg-white">
      <header className="flex items-center justify-between border-b border-gray-200 p-4">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Today&apos;s medications</h2>
          <p className="text-sm text-gray-500">
            One row per scheduled-today slot across every active medication. Hit the medication
            dashboard for the full per-time-slot checklist with administer / miss buttons.
          </p>
        </div>
        <Link
          href="/health/medications"
          className="text-sm font-medium text-campus-600 hover:text-campus-700"
        >
          Open dashboard →
        </Link>
      </header>
      <div className="p-4">
        {dashboard.isLoading ? (
          <LoadingSpinner />
        ) : (dashboard.data ?? []).length === 0 ? (
          <EmptyState
            title="No medication slots scheduled today"
            description="Schedule slots will appear here when a nurse adds them to a student's medication."
          />
        ) : (
          <div className="space-y-4">
            {grouped.map(([slot, rows]) => (
              <div key={slot}>
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                  {formatTime(slot)}
                </p>
                <ul className="mt-2 divide-y divide-gray-100">
                  {(rows ?? []).map((r) => (
                    <li
                      key={r.scheduleEntryId + ':' + (r.administrationId ?? 'pending')}
                      className="flex items-center justify-between gap-4 py-2"
                    >
                      <div>
                        <p className="text-sm font-semibold text-gray-900">
                          {studentDisplayName(r.studentFirstName, r.studentLastName, r.studentId)}
                        </p>
                        <p className="text-xs text-gray-500">
                          {r.medicationName}
                          {r.dosage ? ' · ' + r.dosage : ''}
                          {r.isSelfAdministered ? ' · self-administered' : ''}
                        </p>
                      </div>
                      <span
                        className={
                          'rounded-full px-2 py-0.5 text-xs font-medium ' +
                          DASHBOARD_STATUS_PILL[r.status]
                        }
                      >
                        {DASHBOARD_STATUS_LABELS[r.status]}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
        <p className="mt-4 text-xs text-gray-400">
          Tip: open the medication dashboard for one-click administer / miss buttons.
        </p>
      </div>
    </section>
  );
}

function CompliancePanel() {
  const compliance = useImmunisationCompliance();
  const totals = useMemo(() => {
    let current = 0;
    let overdue = 0;
    let waived = 0;
    for (const r of compliance.data ?? []) {
      current += r.currentCount;
      overdue += r.overdueCount;
      waived += r.waivedCount;
    }
    return { current, overdue, waived };
  }, [compliance.data]);

  return (
    <section className="rounded-lg border border-gray-200 bg-white">
      <header className="border-b border-gray-200 p-4">
        <h2 className="text-base font-semibold text-gray-900">Immunisation compliance</h2>
        <p className="text-sm text-gray-500">
          School-wide rollup. Sorted by overdue count (most urgent first).
        </p>
      </header>
      <div className="p-4">
        {compliance.isLoading ? (
          <LoadingSpinner />
        ) : (compliance.data ?? []).length === 0 ? (
          <EmptyState title="No immunisation rows yet" />
        ) : (
          <>
            <div className="mb-4 grid grid-cols-3 gap-4">
              <Stat label="Current" value={totals.current} tone="emerald" />
              <Stat
                label="Overdue"
                value={totals.overdue}
                tone={totals.overdue > 0 ? 'rose' : 'gray'}
              />
              <Stat label="Waived" value={totals.waived} tone="gray" />
            </div>
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="pb-2">Vaccine</th>
                  <th className="pb-2 text-right">Current</th>
                  <th className="pb-2 text-right">Overdue</th>
                  <th className="pb-2 text-right">Waived</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {(compliance.data ?? []).map((r) => (
                  <tr key={r.vaccineName}>
                    <td className="py-2 font-medium text-gray-900">{r.vaccineName}</td>
                    <td className="py-2 text-right tabular-nums text-emerald-700">
                      {r.currentCount}
                    </td>
                    <td className="py-2 text-right tabular-nums text-rose-700">{r.overdueCount}</td>
                    <td className="py-2 text-right tabular-nums text-gray-500">{r.waivedCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </section>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'emerald' | 'rose' | 'gray';
}) {
  const toneClasses: Record<string, string> = {
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    rose: 'border-rose-200 bg-rose-50 text-rose-800',
    gray: 'border-gray-200 bg-gray-50 text-gray-700',
  };
  return (
    <div className={'rounded-lg border p-3 ' + (toneClasses[tone] ?? toneClasses.gray)}>
      <p className="text-xs font-medium uppercase tracking-wide opacity-70">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}
