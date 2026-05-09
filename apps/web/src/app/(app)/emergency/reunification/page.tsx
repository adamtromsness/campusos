'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useAuthStore, hasAnyPermission } from '@/lib/auth-store';
import { useToast } from '@/components/ui/Toast';
import {
  useCorrectReunification,
  useCreateReunification,
  useIncidents,
  useReunifications,
} from '@/hooks/use-incidents';
import { formatDateTime } from '@/lib/incidents-format';

/**
 * Reunification station. Operates against an ACTIVE incident:
 *
 *  - Pick the active incident (or via ?incidentId=…).
 *  - Enter the student id and the visitor id (the adult collecting
 *    the student must already be signed in via the visitor kiosk —
 *    enforced server-side).
 *  - Submit. The release record + accountability flip + immutable
 *    timeline entry all land atomically in one tenant tx.
 *  - If the wrong student was released, click Correct on the row
 *    and capture the reason (≥20 chars) — written to the audit
 *    chain.
 */
export default function ReunificationPage() {
  const user = useAuthStore((s) => s.user);
  const { toast } = useToast();
  const canRelease = hasAnyPermission(user, ['saf-001:write']);
  const params = useSearchParams();

  const incidents = useIncidents({ status: 'ACTIVE' });
  const queryIncidentId = params?.get('incidentId') ?? null;
  const incident =
    (incidents.data ?? []).find((i) => i.id === queryIncidentId) ?? incidents.data?.[0] ?? null;

  const reunifications = useReunifications(incident?.id ?? null);
  const create = useCreateReunification(incident?.id ?? '');

  const [studentId, setStudentId] = useState('');
  const [releasedToId, setReleasedToId] = useState('');
  const [notes, setNotes] = useState('');

  if (!canRelease) {
    return (
      <p className="rounded border border-amber-200 bg-amber-50 p-5 text-sm text-amber-800">
        Reunification requires saf-001:write or school admin.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Reunification Station</h1>
        <Link className="text-sm text-sky-700 hover:underline" href="/emergency">
          ← Dashboard
        </Link>
      </div>

      {!incident ? (
        <p className="rounded border border-slate-200 bg-white p-5 text-sm text-slate-500">
          No ACTIVE incident — reunification opens automatically when one is declared.
        </p>
      ) : (
        <>
          <section className="rounded border border-rose-300 bg-rose-50 p-4 text-sm">
            <div className="text-xs font-bold uppercase text-rose-700">Active incident</div>
            <div className="font-semibold text-rose-900">
              {incident.title ?? incident.incidentTypeName}
            </div>
          </section>

          <section className="rounded border border-slate-200 bg-white p-5">
            <h2 className="mb-3 text-base font-semibold">Release a student</h2>
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <label className="block text-xs font-medium uppercase text-slate-600">
                  Student ID
                </label>
                <input
                  className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
                  value={studentId}
                  onChange={(e) => setStudentId(e.target.value)}
                  placeholder="UUID of sis_students row"
                />
              </div>
              <div>
                <label className="block text-xs font-medium uppercase text-slate-600">
                  Visitor ID (collecting adult)
                </label>
                <input
                  className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
                  value={releasedToId}
                  onChange={(e) => setReleasedToId(e.target.value)}
                  placeholder="UUID from the visitor kiosk sign-in"
                />
                <p className="mt-1 text-xs text-amber-700">
                  Must be currently signed in via /visitors. The server rejects releases to visitors
                  whose sign-in has been signed out.
                </p>
              </div>
            </div>
            <div className="mt-3">
              <label className="block text-xs font-medium uppercase text-slate-600">Notes</label>
              <input
                className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Optional"
              />
            </div>
            <div className="mt-3 flex justify-end">
              <button
                disabled={!studentId || !releasedToId || create.isPending}
                className="rounded bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:bg-emerald-300"
                onClick={async () => {
                  try {
                    await create.mutateAsync({
                      studentId,
                      releasedToId,
                      notes: notes || undefined,
                    });
                    toast('Release recorded — student marked accounted for.');
                    setStudentId('');
                    setReleasedToId('');
                    setNotes('');
                  } catch (e) {
                    toast(`Release failed: ${(e as Error).message}`, 'error');
                  }
                }}
              >
                {create.isPending ? 'Releasing…' : 'Release student'}
              </button>
            </div>
          </section>

          <section className="rounded border border-slate-200 bg-white p-5">
            <h2 className="mb-3 text-base font-semibold">Releases this incident</h2>
            <ul className="divide-y divide-slate-100 text-sm">
              {(reunifications.data ?? []).map((r) => (
                <ReunificationRow
                  key={r.id}
                  record={r}
                  incidentId={incident.id}
                  onError={(m) => toast(m, 'error')}
                  onSuccess={(m) => toast(m)}
                />
              ))}
              {(reunifications.data ?? []).length === 0 ? (
                <li className="py-3 text-slate-500">No releases yet.</li>
              ) : null}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

function ReunificationRow({
  record,
  incidentId,
  onError,
  onSuccess,
}: {
  record: ReturnType<typeof useReunifications>['data'] extends infer T
    ? T extends Array<infer U>
      ? U
      : never
    : never;
  incidentId: string;
  onError: (m: string) => void;
  onSuccess: (m: string) => void;
}) {
  const correct = useCorrectReunification(record.id, incidentId);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');

  return (
    <li className="py-2">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-medium">{record.studentName ?? record.studentId.slice(0, 8)}</div>
          <div className="text-xs text-slate-500">
            Released {formatDateTime(record.releasedAt)} to{' '}
            {record.releasedToName ?? record.releasedToId.slice(0, 8)} by{' '}
            {record.releasedByName ?? '—'}
          </div>
        </div>
        <button
          className="rounded border border-amber-400 bg-amber-50 px-2 py-1 text-xs text-amber-800 hover:bg-amber-100"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? 'Cancel' : 'Correct'}
        </button>
      </div>

      {record.corrections.length > 0 ? (
        <ul className="mt-1 space-y-1 text-xs text-slate-600">
          {record.corrections.map((c) => (
            <li key={c.id}>
              <span className="font-mono">{formatDateTime(c.correctedAt)}</span> by{' '}
              {c.correctedByName} — {c.correctionReason}
            </li>
          ))}
        </ul>
      ) : null}

      {open ? (
        <div className="mt-2 flex gap-2">
          <input
            className="flex-1 rounded border border-slate-300 px-2 py-1 text-sm"
            placeholder="Reason (≥20 chars)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button
            disabled={reason.trim().length < 20 || correct.isPending}
            className="rounded bg-amber-500 px-3 py-1 text-sm font-semibold text-white disabled:bg-amber-300"
            onClick={async () => {
              try {
                await correct.mutateAsync({ correctionReason: reason.trim() });
                onSuccess('Correction recorded.');
                setOpen(false);
                setReason('');
              } catch (e) {
                onError(`Correction failed: ${(e as Error).message}`);
              }
            }}
          >
            Save
          </button>
        </div>
      ) : null}
    </li>
  );
}
