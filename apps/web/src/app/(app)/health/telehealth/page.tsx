'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useAuthStore, hasAnyPermission } from '@/lib/auth-store';
import { useToast } from '@/components/ui/Toast';
import {
  useCreateTelehealthProvider,
  useScheduleTelehealthSession,
  useTelehealthProviders,
  useTelehealthSessions,
  useUpdateTelehealthSession,
} from '@/hooks/use-health-advanced';
import {
  TELEHEALTH_SESSION_STATUS_LABEL,
  TELEHEALTH_SESSION_STATUS_PILL,
  formatDateTime,
} from '@/lib/health-advanced-format';

/**
 * Telehealth manager. Nurse + admin only (gated on hlt-006:read at
 * the route level — non-holders see a friendly empty state). HIPAA
 * audit fires server-side on every session list/detail read.
 */
export default function TelehealthPage() {
  const user = useAuthStore((s) => s.user);
  const canManage = hasAnyPermission(user, ['hlt-006:write']);
  const canRead = hasAnyPermission(user, ['hlt-006:read']);
  const { toast } = useToast();
  const providers = useTelehealthProviders();
  const sessions = useTelehealthSessions();
  const create = useCreateTelehealthProvider();
  const schedule = useScheduleTelehealthSession();

  const [showProviderForm, setShowProviderForm] = useState(false);
  const [providerName, setProviderName] = useState('');
  const [speciality, setSpeciality] = useState('');
  const [bookingUrl, setBookingUrl] = useState('');

  const [showSchedule, setShowSchedule] = useState(false);
  const [studentId, setStudentId] = useState('');
  const [providerId, setProviderId] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');
  const [duration, setDuration] = useState(30);

  if (!canRead) {
    return (
      <div className="rounded border border-amber-200 bg-amber-50 p-5 text-sm text-amber-800">
        Telehealth requires hlt-006:read.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Telehealth</h1>
        <Link className="text-sm text-sky-700 hover:underline" href="/health">
          ← Health
        </Link>
      </div>

      {canManage ? (
        <section className="rounded border border-slate-200 bg-white p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">Provider directory</h2>
            <button
              className="rounded bg-sky-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-sky-700"
              onClick={() => setShowProviderForm((v) => !v)}
            >
              {showProviderForm ? 'Cancel' : 'Add provider'}
            </button>
          </div>
          {showProviderForm ? (
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              <input
                className="rounded border border-slate-300 px-2 py-1 text-sm"
                placeholder="Provider name"
                value={providerName}
                onChange={(e) => setProviderName(e.target.value)}
              />
              <input
                className="rounded border border-slate-300 px-2 py-1 text-sm"
                placeholder="Speciality"
                value={speciality}
                onChange={(e) => setSpeciality(e.target.value)}
              />
              <input
                className="rounded border border-slate-300 px-2 py-1 text-sm"
                placeholder="Booking URL"
                value={bookingUrl}
                onChange={(e) => setBookingUrl(e.target.value)}
              />
              <div className="md:col-span-3 flex justify-end">
                <button
                  className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:bg-emerald-300"
                  disabled={!providerName.trim() || create.isPending}
                  onClick={async () => {
                    try {
                      await create.mutateAsync({
                        providerName: providerName.trim(),
                        speciality: speciality || undefined,
                        bookingUrl: bookingUrl || undefined,
                      });
                      toast(`Provider added: ${providerName}`);
                      setShowProviderForm(false);
                      setProviderName('');
                      setSpeciality('');
                      setBookingUrl('');
                    } catch (e) {
                      toast(`Failed: ${(e as Error).message}`, 'error');
                    }
                  }}
                >
                  Save
                </button>
              </div>
            </div>
          ) : null}
          <ul className="mt-3 divide-y divide-slate-100 text-sm">
            {(providers.data ?? []).map((p) => (
              <li key={p.id} className="flex items-center justify-between py-2">
                <div>
                  <div className="font-medium">{p.providerName}</div>
                  {p.speciality ? (
                    <div className="text-xs text-slate-500">{p.speciality}</div>
                  ) : null}
                </div>
                {p.bookingUrl ? (
                  <a
                    className="text-xs text-sky-700 hover:underline"
                    href={p.bookingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Book →
                  </a>
                ) : null}
              </li>
            ))}
            {(providers.data ?? []).length === 0 ? (
              <li className="py-2 text-slate-500">No providers configured.</li>
            ) : null}
          </ul>
        </section>
      ) : null}

      {canManage ? (
        <section className="rounded border border-slate-200 bg-white p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">Schedule a session</h2>
            <button
              className="rounded bg-sky-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-sky-700"
              onClick={() => setShowSchedule((v) => !v)}
            >
              {showSchedule ? 'Cancel' : 'New session'}
            </button>
          </div>
          {showSchedule ? (
            <div className="mt-3 grid gap-2 md:grid-cols-4">
              <input
                className="rounded border border-slate-300 px-2 py-1 text-sm"
                placeholder="Student UUID"
                value={studentId}
                onChange={(e) => setStudentId(e.target.value)}
              />
              <select
                className="rounded border border-slate-300 px-2 py-1 text-sm"
                value={providerId}
                onChange={(e) => setProviderId(e.target.value)}
              >
                <option value="">— provider —</option>
                {(providers.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.providerName}
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
                type="number"
                min="1"
                max="480"
                className="rounded border border-slate-300 px-2 py-1 text-sm"
                placeholder="Duration (minutes)"
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
              />
              <div className="md:col-span-4 flex justify-end">
                <button
                  className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:bg-emerald-300"
                  disabled={!studentId || !providerId || !scheduledAt || schedule.isPending}
                  onClick={async () => {
                    try {
                      await schedule.mutateAsync({
                        studentId,
                        providerId,
                        scheduledAt: new Date(scheduledAt).toISOString(),
                        durationMinutes: duration,
                      });
                      toast('Session scheduled');
                      setShowSchedule(false);
                      setStudentId('');
                      setProviderId('');
                      setScheduledAt('');
                    } catch (e) {
                      toast(`Schedule failed: ${(e as Error).message}`, 'error');
                    }
                  }}
                >
                  Schedule
                </button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="rounded border border-slate-200 bg-white p-5">
        <h2 className="mb-3 text-base font-semibold">Sessions</h2>
        <table className="min-w-full text-sm">
          <thead className="text-xs uppercase text-slate-500">
            <tr className="text-left">
              <th className="py-2">Student</th>
              <th>Provider</th>
              <th>Scheduled</th>
              <th>Status</th>
              <th>Consent</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {(sessions.data ?? []).map((s) => (
              <SessionRow key={s.id} session={s} canManage={canManage} />
            ))}
            {(sessions.data ?? []).length === 0 ? (
              <tr>
                <td colSpan={6} className="py-2 text-slate-500">
                  No sessions yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function SessionRow({
  session,
  canManage,
}: {
  session: ReturnType<typeof useTelehealthSessions>['data'] extends infer T
    ? T extends Array<infer U>
      ? U
      : never
    : never;
  canManage: boolean;
}) {
  const { toast } = useToast();
  const update = useUpdateTelehealthSession(session.id);
  return (
    <tr className="align-top">
      <td className="py-2">{session.studentName ?? session.studentId.slice(0, 8)}</td>
      <td>{session.providerName ?? '—'}</td>
      <td>{formatDateTime(session.scheduledAt)}</td>
      <td>
        <span
          className={`rounded px-2 py-0.5 text-xs ${TELEHEALTH_SESSION_STATUS_PILL[session.status]}`}
        >
          {TELEHEALTH_SESSION_STATUS_LABEL[session.status]}
        </span>
      </td>
      <td className="text-xs text-slate-500">
        {session.consentReceivedAt ? formatDateTime(session.consentReceivedAt) : 'Pending'}
      </td>
      <td className="space-x-2 text-xs">
        {canManage && session.status === 'SCHEDULED' ? (
          <button
            className="text-emerald-700 hover:underline"
            onClick={async () => {
              try {
                await update.mutateAsync({ status: 'COMPLETED' });
                toast('Session marked complete');
              } catch (e) {
                toast(`Failed: ${(e as Error).message}`, 'error');
              }
            }}
          >
            Mark complete
          </button>
        ) : null}
        {canManage && session.status === 'SCHEDULED' ? (
          <button
            className="text-rose-700 hover:underline"
            onClick={async () => {
              const reason = window.prompt('Cancellation reason?');
              if (reason === null) return;
              try {
                await update.mutateAsync({ status: 'CANCELLED', cancellationReason: reason });
                toast('Session cancelled');
              } catch (e) {
                toast(`Failed: ${(e as Error).message}`, 'error');
              }
            }}
          >
            Cancel
          </button>
        ) : null}
      </td>
    </tr>
  );
}
