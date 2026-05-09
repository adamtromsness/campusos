'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useAuthStore, hasAnyPermission } from '@/lib/auth-store';
import { useToast } from '@/components/ui/Toast';
import {
  useCancelDrill,
  useCompleteDrill,
  useCreateDrill,
  useDrills,
  useOverdueDrills,
} from '@/hooks/use-incidents';
import {
  DRILL_STATUS_LABEL,
  DRILL_STATUS_PILL,
  PROCEDURE_LABEL,
  PROCEDURE_TYPES,
  ProcedureType,
  formatDateTime,
  formatDuration,
  formatPercent,
  formatRelative,
} from '@/lib/incidents-format';

export default function DrillsPage() {
  const user = useAuthStore((s) => s.user);
  const { toast } = useToast();
  const canManage = hasAnyPermission(user, ['saf-004:write']);
  const drills = useDrills();
  const overdue = useOverdueDrills();
  const create = useCreateDrill();
  const [type, setType] = useState<ProcedureType>('FIRE_EVACUATION');
  const [scheduledAt, setScheduledAt] = useState('');
  const [notes, setNotes] = useState('');
  const [showForm, setShowForm] = useState(false);

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Emergency Drills</h1>
        <Link className="text-sm text-sky-700 hover:underline" href="/emergency">
          ← Dashboard
        </Link>
      </div>

      {(overdue.data ?? []).length > 0 ? (
        <section className="rounded border border-amber-300 bg-amber-50 p-4">
          <h2 className="mb-2 text-sm font-semibold uppercase text-amber-800">Overdue</h2>
          <ul className="space-y-1 text-sm">
            {(overdue.data ?? []).map((d) => (
              <li key={d.procedureType} className="flex items-center justify-between">
                <span className="font-medium">{PROCEDURE_LABEL[d.procedureType]}</span>
                <span className="text-rose-700">
                  {d.lastCompletedAt
                    ? `Last completed ${formatRelative(d.lastCompletedAt)}`
                    : 'Never run'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {canManage ? (
        <section className="rounded border border-slate-200 bg-white p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">Schedule a drill</h2>
            <button
              className="rounded bg-sky-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-sky-700"
              onClick={() => setShowForm((v) => !v)}
            >
              {showForm ? 'Cancel' : 'New drill'}
            </button>
          </div>
          {showForm ? (
            <div className="mt-3 grid gap-3 md:grid-cols-3">
              <select
                className="rounded border border-slate-300 px-2 py-1 text-sm"
                value={type}
                onChange={(e) => setType(e.target.value as ProcedureType)}
              >
                {PROCEDURE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {PROCEDURE_LABEL[t]}
                  </option>
                ))}
              </select>
              <input
                type="datetime-local"
                className="rounded border border-slate-300 px-2 py-1 text-sm"
                value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)}
              />
              <input
                className="rounded border border-slate-300 px-2 py-1 text-sm"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Notes"
              />
              <div className="md:col-span-3 flex justify-end">
                <button
                  className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:bg-emerald-300"
                  disabled={!scheduledAt || create.isPending}
                  onClick={async () => {
                    try {
                      await create.mutateAsync({
                        procedureType: type,
                        scheduledAt: new Date(scheduledAt).toISOString(),
                        notes: notes || undefined,
                      });
                      toast(`Drill scheduled: ${PROCEDURE_LABEL[type]}`);
                      setShowForm(false);
                      setScheduledAt('');
                      setNotes('');
                    } catch (e) {
                      toast(`Schedule failed: ${(e as Error).message}`, 'error');
                    }
                  }}
                >
                  {create.isPending ? 'Scheduling…' : 'Schedule'}
                </button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="rounded border border-slate-200 bg-white p-5">
        <h2 className="mb-3 text-base font-semibold">All drills</h2>
        <table className="min-w-full text-sm">
          <thead className="text-xs uppercase text-slate-500">
            <tr className="text-left">
              <th className="py-2">Type</th>
              <th>Scheduled</th>
              <th>Status</th>
              <th>Duration</th>
              <th>Participation</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {(drills.data ?? []).map((d) => (
              <DrillRow key={d.id} drill={d} canManage={canManage} />
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function DrillRow({
  drill,
  canManage,
}: {
  drill: ReturnType<typeof useDrills>['data'] extends infer T
    ? T extends Array<infer U>
      ? U
      : never
    : never;
  canManage: boolean;
}) {
  const { toast } = useToast();
  const complete = useCompleteDrill(drill.id);
  const cancel = useCancelDrill(drill.id);
  const [open, setOpen] = useState(false);
  const [completedAt, setCompletedAt] = useState('');
  const [duration, setDuration] = useState(600);
  const [rate, setRate] = useState(0.95);

  return (
    <>
      <tr className="align-top">
        <td className="py-2">{PROCEDURE_LABEL[drill.procedureType]}</td>
        <td>{formatDateTime(drill.scheduledAt)}</td>
        <td>
          <span className={`rounded px-2 py-0.5 text-xs ${DRILL_STATUS_PILL[drill.status]}`}>
            {DRILL_STATUS_LABEL[drill.status]}
          </span>
        </td>
        <td>{formatDuration(drill.durationSeconds)}</td>
        <td>{formatPercent(drill.participationRate)}</td>
        <td className="space-x-2 text-sm">
          {canManage && drill.status === 'SCHEDULED' ? (
            <>
              <button className="text-sky-700 hover:underline" onClick={() => setOpen((v) => !v)}>
                {open ? 'Cancel' : 'Complete'}
              </button>
              <button
                className="text-rose-700 hover:underline"
                onClick={async () => {
                  if (!confirm('Cancel this drill?')) return;
                  try {
                    await cancel.mutateAsync({});
                    toast('Drill cancelled');
                  } catch (e) {
                    toast(`Cancel failed: ${(e as Error).message}`, 'error');
                  }
                }}
              >
                Cancel
              </button>
            </>
          ) : null}
        </td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={6} className="bg-slate-50 p-3">
            <div className="grid gap-2 md:grid-cols-4">
              <input
                type="datetime-local"
                className="rounded border border-slate-300 px-2 py-1 text-sm"
                value={completedAt}
                onChange={(e) => setCompletedAt(e.target.value)}
                placeholder="Completed at"
              />
              <input
                type="number"
                className="rounded border border-slate-300 px-2 py-1 text-sm"
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
                placeholder="Duration (s)"
              />
              <input
                type="number"
                step="0.001"
                min="0"
                max="1"
                className="rounded border border-slate-300 px-2 py-1 text-sm"
                value={rate}
                onChange={(e) => setRate(Number(e.target.value))}
                placeholder="Participation rate (0-1)"
              />
              <button
                className="rounded bg-emerald-600 px-3 py-1 text-sm font-semibold text-white"
                disabled={!completedAt || complete.isPending}
                onClick={async () => {
                  try {
                    await complete.mutateAsync({
                      completedAt: new Date(completedAt).toISOString(),
                      durationSeconds: duration,
                      participationRate: rate,
                    });
                    toast('Drill marked complete');
                    setOpen(false);
                  } catch (e) {
                    toast(`Complete failed: ${(e as Error).message}`, 'error');
                  }
                }}
              >
                {complete.isPending ? 'Saving…' : 'Save'}
              </button>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
