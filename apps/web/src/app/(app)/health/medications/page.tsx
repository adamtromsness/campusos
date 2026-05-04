'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { useAdministerDose, useLogMissedDose, useMedicationDashboard } from '@/hooks/use-health';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  DASHBOARD_STATUS_LABELS,
  DASHBOARD_STATUS_PILL,
  MISSED_REASONS,
  MISSED_REASON_LABELS,
  MEDICATION_ROUTE_LABELS,
  formatTime,
  studentDisplayName,
} from '@/lib/health-format';
import type { MedicationDashboardRowDto, MissedReason } from '@/lib/types';

/* /health/medications — expanded school-wide medication checklist.
 * Per-time-slot rows with Administer / Mark missed buttons (nurse only).
 */

export default function MedicationDashboardPage() {
  const user = useAuthStore((s) => s.user);
  const canRead = !!user && hasAnyPermission(user, ['hlt-002:read']);
  const canWrite = !!user && hasAnyPermission(user, ['hlt-002:write']);

  const dashboard = useMedicationDashboard(canRead);

  const grouped = useMemo(() => {
    const by: Record<string, MedicationDashboardRowDto[]> = {};
    for (const r of dashboard.data ?? []) {
      const key = r.scheduledTime;
      if (!by[key]) by[key] = [];
      by[key]!.push(r);
    }
    return Object.entries(by).sort(([a], [b]) => a.localeCompare(b));
  }, [dashboard.data]);

  if (!canRead) {
    return (
      <div className="mx-auto max-w-5xl space-y-6 p-6">
        <PageHeader title="Medication dashboard" />
        <EmptyState
          title="Not available"
          description="The medication dashboard is visible to nurses, counsellors, and admins only."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <PageHeader
        title="Medication dashboard"
        description="Today's school-wide medication schedule. One row per scheduled-today slot across every active medication."
        actions={
          <Link
            href="/health"
            className="text-sm font-medium text-campus-600 hover:text-campus-700"
          >
            ← Dashboard
          </Link>
        }
      />

      {dashboard.isLoading ? (
        <LoadingSpinner />
      ) : (dashboard.data ?? []).length === 0 ? (
        <EmptyState title="No scheduled medications today" />
      ) : (
        <div className="space-y-6">
          {grouped.map(([slot, rows]) => (
            <SlotSection key={slot} slot={slot} rows={rows} canWrite={canWrite} />
          ))}
        </div>
      )}
    </div>
  );
}

function SlotSection({
  slot,
  rows,
  canWrite,
}: {
  slot: string;
  rows: MedicationDashboardRowDto[];
  canWrite: boolean;
}) {
  return (
    <section className="rounded-lg border border-gray-200 bg-white">
      <header className="border-b border-gray-200 p-3">
        <h2 className="text-base font-semibold text-gray-900">{formatTime(slot)}</h2>
        <p className="text-xs text-gray-500">
          {rows.filter((r) => r.status === 'PENDING').length} pending ·{' '}
          {rows.filter((r) => r.status === 'ADMINISTERED').length} administered ·{' '}
          {rows.filter((r) => r.status === 'MISSED').length} missed
        </p>
      </header>
      <ul className="divide-y divide-gray-100">
        {rows.map((r) => (
          <DashboardRow
            key={r.scheduleEntryId + ':' + (r.administrationId ?? 'pending')}
            row={r}
            canWrite={canWrite}
          />
        ))}
      </ul>
    </section>
  );
}

function DashboardRow({ row, canWrite }: { row: MedicationDashboardRowDto; canWrite: boolean }) {
  const { toast } = useToast();
  const [missOpen, setMissOpen] = useState(false);
  const administer = useAdministerDose(row.medicationId);
  const isPending = row.status === 'PENDING';

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-3 py-3">
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold text-gray-900">
            {studentDisplayName(row.studentFirstName, row.studentLastName, row.studentId)}
          </p>
          <span className="rounded-full bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700 ring-1 ring-sky-200">
            {MEDICATION_ROUTE_LABELS[row.route]}
          </span>
          {row.isSelfAdministered ? (
            <span className="rounded-full bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700 ring-1 ring-violet-200">
              Self-administered
            </span>
          ) : null}
          <span
            className={
              'rounded-full px-2 py-0.5 text-xs font-medium ' + DASHBOARD_STATUS_PILL[row.status]
            }
          >
            {DASHBOARD_STATUS_LABELS[row.status]}
          </span>
        </div>
        <p className="mt-1 text-xs text-gray-500">
          {row.medicationName}
          {row.dosage ? ' · ' + row.dosage : ''}
          {row.administeredAt
            ? ' · administered ' +
              new Date(row.administeredAt).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })
            : ''}
          {row.missedReason ? ' · ' + MISSED_REASON_LABELS[row.missedReason] : ''}
        </p>
      </div>
      {canWrite && isPending ? (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() =>
              administer.mutate(
                {
                  scheduleEntryId: row.scheduleEntryId,
                  doseGiven: row.dosage ?? null,
                  parentNotified: false,
                },
                {
                  onSuccess: () => toast('Administered', 'success'),
                  onError: (e) => toast((e as Error).message, 'error'),
                },
              )
            }
            disabled={administer.isPending}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
          >
            Administer
          </button>
          <button
            type="button"
            onClick={() => setMissOpen(true)}
            className="rounded-md border border-rose-200 bg-rose-50 px-3 py-1.5 text-sm font-medium text-rose-700 hover:bg-rose-100"
          >
            Mark missed
          </button>
        </div>
      ) : null}
      <MissModal open={missOpen} row={row} onClose={() => setMissOpen(false)} />
    </li>
  );
}

function MissModal({
  open,
  row,
  onClose,
}: {
  open: boolean;
  row: MedicationDashboardRowDto;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const logMissed = useLogMissedDose(row.medicationId);
  const [reason, setReason] = useState<MissedReason>('STUDENT_ABSENT');
  const [notes, setNotes] = useState('');

  return (
    <Modal open={open} title="Mark dose missed" onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm text-gray-700">
          {studentDisplayName(row.studentFirstName, row.studentLastName, row.studentId)} ·{' '}
          {row.medicationName} · {formatTime(row.scheduledTime)}
        </p>
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wide text-gray-600">
            Reason
          </label>
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value as MissedReason)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          >
            {MISSED_REASONS.map((r) => (
              <option key={r} value={r}>
                {MISSED_REASON_LABELS[r]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wide text-gray-600">
            Notes (optional)
          </label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() =>
              logMissed.mutate(
                {
                  scheduleEntryId: row.scheduleEntryId,
                  missedReason: reason,
                  notes: notes || null,
                },
                {
                  onSuccess: () => {
                    toast('Logged missed dose', 'success');
                    onClose();
                  },
                  onError: (e) => toast((e as Error).message, 'error'),
                },
              )
            }
            disabled={logMissed.isPending}
            className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-60"
          >
            Log missed
          </button>
        </div>
      </div>
    </Modal>
  );
}
