'use client';

import { use } from 'react';
import Link from 'next/link';
import {
  useAccountabilitySummary,
  useIncident,
  useReunifications,
  useTimeline,
} from '@/hooks/use-incidents';
import {
  formatDateTime,
  formatPercent,
  formatRelative,
  INCIDENT_STATUS_LABEL,
  INCIDENT_STATUS_PILL,
  PROCEDURE_LABEL,
  ProcedureType,
  SEVERITY_LABEL,
} from '@/lib/incidents-format';

interface Props {
  params: Promise<{ id: string }>;
}

/**
 * After-action report. Auto-generated from the immutable timeline +
 * the final accountability summary + the reunification log. The
 * report does NOT mutate any data — it is a read-only assemblage of
 * the legal record.
 */
export default function AfterActionReportPage({ params }: Props) {
  const { id } = use(params);
  const incident = useIncident(id);
  const timeline = useTimeline(id);
  const summary = useAccountabilitySummary(id);
  const reunifications = useReunifications(id);

  if (incident.isLoading) return <p className="p-5">Loading…</p>;
  if (!incident.data) return <p className="p-5 text-slate-500">Incident not found.</p>;

  const i = incident.data;
  const final =
    i.status === 'RESOLVED' ? 'Resolved' : i.status === 'CANCELLED' ? 'Cancelled' : 'In progress';
  const accountabilityPct =
    summary.data && summary.data.totalPeople > 0
      ? summary.data.accountedFor / summary.data.totalPeople
      : null;

  return (
    <article className="mx-auto max-w-4xl space-y-6 bg-white p-8 print:p-0">
      <div className="flex items-baseline justify-between border-b border-slate-300 pb-4 print:hidden">
        <h1 className="text-2xl font-bold">After-Action Report</h1>
        <div className="flex gap-3 text-sm">
          <button
            className="rounded border border-slate-300 px-3 py-1.5"
            onClick={() => window.print()}
          >
            Print
          </button>
          <Link className="text-sky-700 hover:underline" href="/emergency">
            ← Dashboard
          </Link>
        </div>
      </div>

      <header className="space-y-2 border-b border-slate-300 pb-4">
        <h2 className="text-3xl font-bold">{i.title ?? i.incidentTypeName ?? 'Incident'}</h2>
        <p className="text-slate-600">
          {i.incidentTypeName
            ? (PROCEDURE_LABEL[i.incidentTypeCode as ProcedureType] ?? i.incidentTypeName)
            : ''}
          {i.severity ? ` · ${SEVERITY_LABEL[i.severity]} severity` : ''} ·{' '}
          <span
            className={`rounded px-2 py-0.5 text-xs font-medium ${INCIDENT_STATUS_PILL[i.status]}`}
          >
            {INCIDENT_STATUS_LABEL[i.status]}
          </span>
        </p>
      </header>

      <section>
        <h3 className="mb-2 text-base font-semibold uppercase tracking-wide">Summary</h3>
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <dt className="font-medium text-slate-500">Declared</dt>
          <dd>{formatDateTime(i.declaredAt)}</dd>
          <dt className="font-medium text-slate-500">Declared by</dt>
          <dd>{i.declaredByName ?? '—'}</dd>
          {i.resolvedAt ? (
            <>
              <dt className="font-medium text-slate-500">{final}</dt>
              <dd>{formatDateTime(i.resolvedAt)}</dd>
            </>
          ) : null}
          {i.description ? (
            <>
              <dt className="font-medium text-slate-500">Description</dt>
              <dd>{i.description}</dd>
            </>
          ) : null}
          {i.resolutionNotes ? (
            <>
              <dt className="font-medium text-slate-500">Resolution</dt>
              <dd>{i.resolutionNotes}</dd>
            </>
          ) : null}
        </dl>
      </section>

      <section>
        <h3 className="mb-2 text-base font-semibold uppercase tracking-wide">
          Final accountability
        </h3>
        {summary.data ? (
          <div className="grid grid-cols-2 gap-2 text-sm md:grid-cols-5">
            <Card label="Total" value={summary.data.totalPeople} />
            <Card label="Accounted for" value={summary.data.accountedFor} />
            <Card label="Unknown" value={summary.data.unknown} />
            <Card label="Medical" value={summary.data.medicalAssistance} />
            <Card label="Missing" value={summary.data.missing} />
          </div>
        ) : (
          <p className="text-slate-500">No accountability summary available.</p>
        )}
        {accountabilityPct != null ? (
          <p className="mt-2 text-sm text-slate-600">
            Final accountability rate: <strong>{formatPercent(accountabilityPct)}</strong>
          </p>
        ) : null}
      </section>

      <section>
        <h3 className="mb-2 text-base font-semibold uppercase tracking-wide">Timeline of events</h3>
        <ol className="space-y-2 border-l-2 border-slate-300 pl-4 text-sm">
          {(timeline.data ?? []).map((t) => (
            <li key={t.id}>
              <div className="text-xs font-mono text-slate-500">{formatDateTime(t.recordedAt)}</div>
              <div>
                <span className="mr-2 inline-block rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium">
                  {t.eventType}
                </span>
                {t.description}
              </div>
              <div className="text-xs text-slate-500">— {t.recordedByName ?? '—'}</div>
            </li>
          ))}
          {(timeline.data ?? []).length === 0 ? (
            <li className="text-slate-500">No timeline entries.</li>
          ) : null}
        </ol>
      </section>

      {(reunifications.data ?? []).length > 0 ? (
        <section>
          <h3 className="mb-2 text-base font-semibold uppercase tracking-wide">
            Reunification log
          </h3>
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-slate-500">
                <th className="py-1">Time</th>
                <th>Student</th>
                <th>Released to</th>
                <th>Released by</th>
                <th>Corrections</th>
              </tr>
            </thead>
            <tbody>
              {(reunifications.data ?? []).map((r) => (
                <tr key={r.id}>
                  <td className="py-1">{formatDateTime(r.releasedAt)}</td>
                  <td>{r.studentName ?? r.studentId.slice(0, 8)}</td>
                  <td>{r.releasedToName ?? '—'}</td>
                  <td>{r.releasedByName ?? '—'}</td>
                  <td>{r.corrections.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      <footer className="border-t border-slate-300 pt-4 text-xs text-slate-500">
        Generated {formatRelative(new Date().toISOString())}. This report is auto-assembled from the
        immutable incident timeline and the final accountability snapshot. Source data may not be
        edited; corrections are appended to the audit chain.
      </footer>
    </article>
  );
}

function Card({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-slate-200 p-2 text-center">
      <div className="text-xs uppercase text-slate-500">{label}</div>
      <div className="text-2xl font-bold">{value}</div>
    </div>
  );
}
