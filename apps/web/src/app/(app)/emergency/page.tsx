'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuthStore, hasAnyPermission } from '@/lib/auth-store';
import { useToast } from '@/components/ui/Toast';
import {
  useAccountability,
  useAccountabilitySummary,
  useAppendTimeline,
  useBulkAccountability,
  useDeclareIncident,
  useDrills,
  useIncidentTypes,
  useIncidents,
  useOverdueDrills,
  useProcedures,
  useResolveIncident,
  useTimeline,
  useUpdateAccountabilityRecord,
} from '@/hooks/use-incidents';
import {
  ACCOUNTABILITY_PERSON_TYPE_LABEL,
  ACCOUNTABILITY_STATUS_LABEL,
  ACCOUNTABILITY_STATUS_PILL,
  ACCOUNTABILITY_STATUSES,
  AccountabilityStatus,
  DRILL_STATUS_LABEL,
  DRILL_STATUS_PILL,
  formatDateTime,
  formatElapsed,
  formatRelative,
  INCIDENT_STATUS_LABEL,
  INCIDENT_STATUS_PILL,
  PROCEDURE_LABEL,
  SEVERITY_LABEL,
  SEVERITY_PILL,
} from '@/lib/incidents-format';

/**
 * Emergency dashboard. Two modes:
 *
 *   - Quiet mode (no ACTIVE incident): shows the recent incident
 *     history, drill schedule, procedure-review dates, and (for
 *     responders) the big red "Declare Emergency" button.
 *
 *   - Active mode (one or more ACTIVE incidents): rose-tinted top
 *     banner with the incident title, time elapsed, accountability
 *     summary bar, the procedure step checklist, and the live
 *     immutable timeline feed. Polls every 5s while active.
 */
export default function EmergencyDashboardPage() {
  const user = useAuthStore((s) => s.user);
  const canDeclare = hasAnyPermission(user, ['saf-001:write']);

  const incidents = useIncidents();
  const active = (incidents.data ?? []).find((i) => i.status === 'ACTIVE');
  const recentResolved = (incidents.data ?? []).filter((i) => i.status !== 'ACTIVE').slice(0, 5);

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Emergency</h1>
        <div className="flex gap-3 text-sm">
          <Link className="text-sky-700 hover:underline" href="/emergency/procedures">
            Procedures
          </Link>
          <Link className="text-sky-700 hover:underline" href="/emergency/drills">
            Drills
          </Link>
          <Link className="text-sky-700 hover:underline" href="/emergency/reports">
            Incident reports
          </Link>
          <Link className="text-sky-700 hover:underline" href="/emergency/report">
            Report incident
          </Link>
        </div>
      </div>

      {active ? (
        <ActiveIncidentPanel incident={active} canDeclare={canDeclare} />
      ) : (
        <QuietPanel canDeclare={canDeclare} />
      )}

      {recentResolved.length > 0 ? (
        <section className="rounded border border-slate-200 bg-white p-5">
          <h2 className="mb-3 text-base font-semibold">Recent incidents</h2>
          <ul className="divide-y divide-slate-100 text-sm">
            {recentResolved.map((i) => (
              <li key={i.id} className="flex items-center justify-between py-2">
                <div className="flex items-center gap-3">
                  <span
                    className={`rounded px-2 py-0.5 text-xs font-medium ${INCIDENT_STATUS_PILL[i.status]}`}
                  >
                    {INCIDENT_STATUS_LABEL[i.status]}
                  </span>
                  <span className="font-medium">{i.title ?? i.incidentTypeName ?? 'Incident'}</span>
                  <span className="text-slate-500">{formatRelative(i.declaredAt)}</span>
                </div>
                <Link
                  className="text-sky-700 hover:underline"
                  href={`/emergency/incidents/${i.id}/report`}
                >
                  After-action →
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function QuietPanel({ canDeclare }: { canDeclare: boolean }) {
  const drills = useDrills('SCHEDULED');
  const overdue = useOverdueDrills();
  const procedures = useProcedures();
  const today = new Date();
  const upcoming = (drills.data ?? []).slice(0, 3);

  return (
    <div className="space-y-6">
      {canDeclare ? <DeclarePanel /> : null}

      <section className="grid gap-4 md:grid-cols-2">
        <div className="rounded border border-slate-200 bg-white p-5">
          <h2 className="mb-3 text-base font-semibold">Upcoming drills</h2>
          {upcoming.length === 0 ? (
            <p className="text-sm text-slate-500">None scheduled.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {upcoming.map((d) => (
                <li key={d.id} className="flex items-center justify-between">
                  <span>
                    <span
                      className={`mr-2 rounded px-2 py-0.5 text-xs font-medium ${DRILL_STATUS_PILL[d.status]}`}
                    >
                      {DRILL_STATUS_LABEL[d.status]}
                    </span>
                    {PROCEDURE_LABEL[d.procedureType]}
                  </span>
                  <span className="text-slate-500">{formatDateTime(d.scheduledAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded border border-slate-200 bg-white p-5">
          <h2 className="mb-3 text-base font-semibold">Overdue drills</h2>
          {(overdue.data ?? []).length === 0 ? (
            <p className="text-sm text-emerald-700">
              All required drill types are within the 90-day window.
            </p>
          ) : (
            <ul className="space-y-2 text-sm">
              {(overdue.data ?? []).map((d) => (
                <li key={d.procedureType} className="flex items-center justify-between">
                  <span className="font-medium">{PROCEDURE_LABEL[d.procedureType]}</span>
                  <span className="text-rose-700">
                    {d.lastCompletedAt ? `${d.daysSinceLastDrill} days ago` : 'Never run'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="rounded border border-slate-200 bg-white p-5">
        <h2 className="mb-3 text-base font-semibold">Procedure review status</h2>
        {(procedures.data ?? []).length === 0 ? (
          <p className="text-sm text-slate-500">No procedures configured.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {(procedures.data ?? []).map((p) => {
              const dueIn = Math.floor(
                (new Date(p.nextReviewDate).getTime() - today.getTime()) / 86400000,
              );
              return (
                <li key={p.id} className="flex items-center justify-between">
                  <span className="font-medium">{PROCEDURE_LABEL[p.procedureType]}</span>
                  <span className={dueIn < 30 ? 'text-amber-700' : 'text-slate-500'}>
                    {dueIn < 0 ? `Overdue by ${-dueIn}d` : `Review due in ${dueIn}d`}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function DeclarePanel() {
  const { toast } = useToast();
  const types = useIncidentTypes();
  const declare = useDeclareIncident();
  const [open, setOpen] = useState(false);
  const [typeId, setTypeId] = useState('');
  const [title, setTitle] = useState('');

  return (
    <section className="rounded border-2 border-rose-300 bg-rose-50 p-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-rose-800">Declare an emergency</h2>
          <p className="text-sm text-rose-700">
            Triggers procedures, accountability tracking, and notifies all staff.
          </p>
        </div>
        <button
          className="rounded bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? 'Cancel' : 'Declare emergency'}
        </button>
      </div>

      {open ? (
        <div className="mt-4 space-y-3">
          <div>
            <label className="block text-xs font-medium uppercase text-rose-700">
              Incident type
            </label>
            <select
              className="mt-1 w-full rounded border border-rose-300 bg-white px-3 py-2 text-sm"
              value={typeId}
              onChange={(e) => setTypeId(e.target.value)}
            >
              <option value="">— select —</option>
              {(types.data ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({SEVERITY_LABEL[t.severity]})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium uppercase text-rose-700">
              Title (optional)
            </label>
            <input
              className="mt-1 w-full rounded border border-rose-300 bg-white px-3 py-2 text-sm"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Smoke reported in chemistry lab"
            />
          </div>
          <div className="rounded bg-rose-100 p-3 text-sm text-rose-800">
            Declaring will create an immutable timeline, fan-out URGENT tasks, snapshot the on-site
            visitor list, and notify the school. This action is logged.
          </div>
          <div className="flex justify-end">
            <button
              disabled={!typeId || declare.isPending}
              className="rounded bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700 disabled:bg-rose-300"
              onClick={async () => {
                try {
                  const out = await declare.mutateAsync({
                    incidentTypeId: typeId,
                    title: title || undefined,
                  });
                  toast(`Emergency declared: ${out.incidentTypeName ?? out.title ?? 'incident'}`);
                  setOpen(false);
                  setTypeId('');
                  setTitle('');
                } catch (e) {
                  toast(`Declaration failed: ${(e as Error).message}`, 'error');
                }
              }}
            >
              {declare.isPending ? 'Declaring…' : 'Confirm declaration'}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ActiveIncidentPanel({
  incident,
  canDeclare,
}: {
  incident: ReturnType<typeof useIncidents>['data'] extends infer T
    ? T extends Array<infer U>
      ? U
      : never
    : never;
  canDeclare: boolean;
}) {
  const accountability = useAccountability(incident.id);
  const summary = useAccountabilitySummary(incident.id);
  const timeline = useTimeline(incident.id);
  const append = useAppendTimeline(incident.id);
  const updateRecord = useUpdateAccountabilityRecord(incident.id);
  const bulk = useBulkAccountability(incident.id);
  const resolve = useResolveIncident(incident.id);
  const { toast } = useToast();
  const [eventType, setEventType] = useState('UPDATE');
  const [description, setDescription] = useState('');
  const [resolutionNotes, setResolutionNotes] = useState('');
  const [tick, setTick] = useState(0);

  // Re-render every second so the elapsed-time clock advances.
  useEffect(() => {
    const t = setInterval(() => setTick((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const total = summary.data?.totalPeople ?? 0;
  const acc = summary.data?.accountedFor ?? 0;
  const unk = summary.data?.unknown ?? 0;
  const miss = summary.data?.missing ?? 0;
  const med = summary.data?.medicalAssistance ?? 0;

  return (
    <div className="space-y-4">
      <section className="rounded border-2 border-rose-500 bg-rose-100 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-xs font-bold uppercase tracking-wide text-rose-700">
              Active emergency
              {incident.severity ? (
                <span className={`ml-2 rounded px-2 py-0.5 ${SEVERITY_PILL[incident.severity]}`}>
                  {SEVERITY_LABEL[incident.severity]}
                </span>
              ) : null}
            </div>
            <h2 className="mt-1 text-2xl font-bold text-rose-900">
              {incident.title ?? incident.incidentTypeName ?? 'Incident in progress'}
            </h2>
            <p className="text-sm text-rose-800">
              Declared {formatRelative(incident.declaredAt)} by {incident.declaredByName ?? 'staff'}
              .
            </p>
          </div>
          <div className="text-right">
            <div className="text-xs uppercase text-rose-700">Elapsed</div>
            <div className="font-mono text-3xl font-bold text-rose-900">
              {formatElapsed(incident.declaredAt)}
              <span className="hidden">{tick}</span>
            </div>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-5 gap-2 text-center">
          <Stat label="Total" value={total} tone="slate" />
          <Stat label="Accounted" value={acc} tone="emerald" />
          <Stat label="Unknown" value={unk} tone="amber" />
          <Stat label="Medical" value={med} tone="violet" />
          <Stat label="Missing" value={miss} tone="rose" />
        </div>

        {incident.outboxStatus ? (
          <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
            <OutboxStep label="Tasks" stamped={incident.outboxStatus.tasksCreatedAt} />
            <OutboxStep label="Muster" stamped={incident.outboxStatus.musterTakenAt} />
            <OutboxStep label="Alerts" stamped={incident.outboxStatus.alertSentAt} />
          </div>
        ) : null}
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        {/* Accountability dashboard */}
        <section className="rounded border border-slate-200 bg-white p-4">
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide">Accountability</h3>
          {(accountability.data ?? []).length === 0 ? (
            <p className="text-sm text-slate-500">
              No accountability records yet. Muster runs ~30s after declaration.
            </p>
          ) : (
            <div className="max-h-96 space-y-1 overflow-y-auto text-sm">
              {(accountability.data ?? []).map((r) => (
                <div
                  key={r.id}
                  className="flex items-center justify-between border-b border-slate-100 py-1"
                >
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">
                      {ACCOUNTABILITY_PERSON_TYPE_LABEL[r.personType]}
                    </span>
                    <span className="font-mono text-xs">{r.personId.slice(0, 8)}</span>
                  </div>
                  <select
                    className={`rounded px-2 py-0.5 text-xs ${ACCOUNTABILITY_STATUS_PILL[r.status]}`}
                    value={r.status}
                    onChange={async (e) => {
                      try {
                        await updateRecord.mutateAsync({
                          recordId: r.id,
                          payload: { status: e.target.value as AccountabilityStatus },
                        });
                      } catch (err) {
                        toast(`Update failed: ${(err as Error).message}`, 'error');
                      }
                    }}
                  >
                    {ACCOUNTABILITY_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {ACCOUNTABILITY_STATUS_LABEL[s]}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          )}

          {(accountability.data ?? []).filter((r) => r.status === 'UNKNOWN').length > 0 ? (
            <button
              className="mt-3 rounded bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
              onClick={async () => {
                const ids = (accountability.data ?? [])
                  .filter((r) => r.status === 'UNKNOWN')
                  .map((r) => r.id);
                if (ids.length === 0) return;
                try {
                  const out = await bulk.mutateAsync({ recordIds: ids, status: 'ACCOUNTED_FOR' });
                  toast(`Marked ${out.updated} accounted for`);
                } catch (err) {
                  toast(`Bulk update failed: ${(err as Error).message}`, 'error');
                }
              }}
            >
              Mark all UNKNOWN as accounted for
            </button>
          ) : null}
        </section>

        {/* Timeline */}
        <section className="rounded border border-slate-200 bg-white p-4">
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide">Immutable timeline</h3>
          <div className="max-h-72 space-y-2 overflow-y-auto text-sm">
            {(timeline.data ?? []).map((t) => (
              <div key={t.id} className="border-l-2 border-slate-300 pl-3">
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <span className="font-mono">{formatDateTime(t.recordedAt)}</span>
                  <span className="font-medium text-slate-700">{t.eventType}</span>
                  <span>by {t.recordedByName ?? '—'}</span>
                </div>
                <div className="text-sm">{t.description}</div>
              </div>
            ))}
          </div>

          {canDeclare ? (
            <div className="mt-3 space-y-2 border-t border-slate-200 pt-3">
              <div className="flex gap-2">
                <input
                  className="w-32 rounded border border-slate-300 px-2 py-1 text-xs"
                  value={eventType}
                  onChange={(e) => setEventType(e.target.value.toUpperCase())}
                  placeholder="EVENT TYPE"
                />
                <input
                  className="flex-1 rounded border border-slate-300 px-2 py-1 text-sm"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What just happened?"
                />
                <button
                  className="rounded bg-sky-600 px-3 py-1 text-sm font-semibold text-white hover:bg-sky-700 disabled:bg-sky-300"
                  disabled={!description.trim() || append.isPending}
                  onClick={async () => {
                    try {
                      await append.mutateAsync({
                        eventType,
                        description: description.trim(),
                      });
                      setDescription('');
                    } catch (err) {
                      toast(`Append failed: ${(err as Error).message}`, 'error');
                    }
                  }}
                >
                  Add entry
                </button>
              </div>
              <p className="text-xs text-slate-500">
                Entries cannot be edited or deleted. This is the legal record.
              </p>
            </div>
          ) : null}
        </section>
      </div>

      {/* Resolve */}
      {canDeclare ? (
        <section className="rounded border border-emerald-300 bg-emerald-50 p-4">
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-emerald-800">
            Mark resolved
          </h3>
          <div className="flex gap-2">
            <input
              className="flex-1 rounded border border-emerald-300 bg-white px-3 py-2 text-sm"
              placeholder="Resolution summary (≥10 chars)"
              value={resolutionNotes}
              onChange={(e) => setResolutionNotes(e.target.value)}
            />
            <button
              className="rounded bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:bg-emerald-300"
              disabled={resolutionNotes.trim().length < 10 || resolve.isPending}
              onClick={async () => {
                try {
                  await resolve.mutateAsync({ resolutionNotes: resolutionNotes.trim() });
                  toast('Incident resolved');
                  setResolutionNotes('');
                } catch (err) {
                  toast(`Resolve failed: ${(err as Error).message}`, 'error');
                }
              }}
            >
              Resolve
            </button>
          </div>
          <p className="mt-2 text-xs text-emerald-700">
            Reunification, accountability history, and timeline remain visible after resolution.
          </p>
          <Link
            className="mt-2 inline-block text-sm text-sky-700 hover:underline"
            href={`/emergency/reunification?incidentId=${incident.id}`}
          >
            Open reunification station →
          </Link>
        </section>
      ) : null}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  const cls: Record<string, string> = {
    slate: 'bg-slate-200 text-slate-800',
    emerald: 'bg-emerald-200 text-emerald-900',
    amber: 'bg-amber-200 text-amber-900',
    violet: 'bg-violet-200 text-violet-900',
    rose: 'bg-rose-300 text-rose-950',
  };
  return (
    <div className={`rounded p-2 ${cls[tone] ?? cls.slate}`}>
      <div className="text-xs uppercase">{label}</div>
      <div className="text-2xl font-bold">{value}</div>
    </div>
  );
}

function OutboxStep({ label, stamped }: { label: string; stamped: string | null }) {
  const ok = !!stamped;
  return (
    <div
      className={`rounded p-2 text-center ${ok ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}
    >
      <div className="font-medium">{label}</div>
      <div className="text-xs">{ok ? '✓ ' + formatRelative(stamped!) : 'pending…'}</div>
    </div>
  );
}
