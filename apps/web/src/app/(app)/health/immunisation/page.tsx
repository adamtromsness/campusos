'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useAuthStore, hasAnyPermission } from '@/lib/auth-store';
import { useToast } from '@/components/ui/Toast';
import {
  useComplianceDashboard,
  useComplianceList,
  useImmunisationRequirements,
  useRunCompliance,
} from '@/hooks/use-health-advanced';
import {
  COMPLIANCE_STATUSES,
  COMPLIANCE_STATUS_LABEL,
  COMPLIANCE_STATUS_PILL,
  formatDateTime,
} from '@/lib/health-advanced-format';
import type { ComplianceStatus } from '@/lib/types';

/**
 * State reporting surface — the load-bearing dashboard for the
 * annual immunisation compliance submission. Compliant + Exempt are
 * counted as "in compliance" for the headline percentage; the state
 * report endpoint emits one CSV row per applicable vaccine.
 */
export default function ImmunisationCompliancePage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = hasAnyPermission(user, ['hlt-001:admin']);
  const canRead = hasAnyPermission(user, ['hlt-001:read']);
  const { toast } = useToast();
  const dashboard = useComplianceDashboard();
  const requirements = useImmunisationRequirements('KS');
  const [statusFilter, setStatusFilter] = useState<ComplianceStatus | ''>('');
  const list = useComplianceList(statusFilter ? { status: statusFilter } : undefined);
  const run = useRunCompliance();

  if (!canRead) {
    return (
      <div className="rounded border border-amber-200 bg-amber-50 p-5 text-sm text-amber-800">
        Compliance dashboard requires hlt-001:read.
      </div>
    );
  }

  const d = dashboard.data;
  const compliancePct = d?.compliancePercent ?? 0;
  const tone = compliancePct >= 95 ? 'emerald' : compliancePct >= 85 ? 'amber' : 'rose';
  const toneCls: Record<string, string> = {
    emerald: 'bg-emerald-100 text-emerald-800',
    amber: 'bg-amber-100 text-amber-800',
    rose: 'bg-rose-100 text-rose-800',
  };

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Immunisation Compliance</h1>
        <div className="flex gap-3 text-sm">
          <a
            className="rounded border border-slate-300 px-3 py-1.5 hover:bg-slate-50"
            href="/api/v1/health/immunisation/compliance/report"
            target="_blank"
            rel="noopener noreferrer"
          >
            Export state CSV
          </a>
          <Link className="text-sky-700 hover:underline" href="/health">
            ← Health
          </Link>
        </div>
      </div>

      {d ? (
        <section className="rounded border-2 border-slate-200 bg-white p-5">
          <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
            <div className={`rounded p-3 text-center ${toneCls[tone]}`}>
              <div className="text-xs uppercase">Compliance</div>
              <div className="text-3xl font-bold">{compliancePct.toFixed(1)}%</div>
            </div>
            <Stat label="Total" value={d.totalStudents} tone="slate" />
            <Stat label="Compliant" value={d.compliant} tone="emerald" />
            <Stat label="Non-compliant" value={d.nonCompliant} tone="rose" />
            <Stat label="Exempt" value={d.exempt} tone="violet" />
          </div>
          {d.lastComputedAt ? (
            <p className="mt-3 text-xs text-slate-500">
              Last computed {formatDateTime(d.lastComputedAt)}
            </p>
          ) : null}
          {isAdmin ? (
            <div className="mt-3 flex justify-end">
              <button
                className="rounded bg-sky-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-sky-700 disabled:bg-sky-300"
                disabled={run.isPending}
                onClick={async () => {
                  try {
                    const r = await run.mutateAsync({});
                    toast(
                      `Recomputed ${r.computed} students; ${r.newlyNonCompliant} newly non-compliant`,
                    );
                  } catch (e) {
                    toast(`Failed: ${(e as Error).message}`, 'error');
                  }
                }}
              >
                Recompute now
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="rounded border border-slate-200 bg-white p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Students</h2>
          <select
            className="rounded border border-slate-300 px-2 py-1 text-sm"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as ComplianceStatus | '')}
          >
            <option value="">All statuses</option>
            {COMPLIANCE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {COMPLIANCE_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        <table className="mt-3 min-w-full text-sm">
          <thead className="text-xs uppercase text-slate-500">
            <tr className="text-left">
              <th className="py-2">Student</th>
              <th>Grade</th>
              <th>Status</th>
              <th>Missing vaccines</th>
              <th>Exemption</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {(list.data ?? []).map((c) => (
              <tr key={c.id}>
                <td className="py-2">{c.studentName ?? c.studentId.slice(0, 8)}</td>
                <td>{c.studentGrade ?? '—'}</td>
                <td>
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${COMPLIANCE_STATUS_PILL[c.status]}`}
                  >
                    {COMPLIANCE_STATUS_LABEL[c.status]}
                  </span>
                </td>
                <td className="text-xs">
                  {c.missingVaccines.length === 0 ? (
                    '—'
                  ) : (
                    <ul>
                      {c.missingVaccines.map((m) => (
                        <li key={m.vaccineName}>
                          {m.vaccineName}: {m.dosesReceived}/{m.dosesRequired}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td className="text-xs">{c.exemptionType ?? '—'}</td>
              </tr>
            ))}
            {(list.data ?? []).length === 0 ? (
              <tr>
                <td colSpan={5} className="py-2 text-slate-500">
                  No compliance records yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>

      <section className="rounded border border-slate-200 bg-white p-5">
        <h2 className="mb-3 text-base font-semibold">State requirements (Kansas)</h2>
        <ul className="text-sm">
          {(requirements.data ?? []).map((r) => (
            <li
              key={r.id}
              className="flex items-center justify-between border-b border-slate-100 py-1"
            >
              <span>
                <strong>{r.vaccineName}</strong> — {r.requiredDoses} doses by grade{' '}
                {r.requiredByGrade}
              </span>
              <span className="text-xs text-slate-500">
                {r.allowsExemption
                  ? (r.exemptionTypes ?? []).join(', ') || 'exemptions allowed'
                  : 'no exemption'}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  const cls: Record<string, string> = {
    slate: 'bg-slate-100 text-slate-700',
    emerald: 'bg-emerald-100 text-emerald-800',
    rose: 'bg-rose-100 text-rose-800',
    violet: 'bg-violet-100 text-violet-800',
  };
  return (
    <div className={`rounded p-3 text-center ${cls[tone] ?? cls.slate}`}>
      <div className="text-xs uppercase">{label}</div>
      <div className="text-3xl font-bold">{value}</div>
    </div>
  );
}
