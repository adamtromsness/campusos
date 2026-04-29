'use client';

import Link from 'next/link';
import { useState } from 'react';
import { use } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import {
  useCreateAdmissionStream,
  useCreateIntakeCapacity,
  useEnrollmentPeriod,
  useUpdateEnrollmentPeriod,
} from '@/hooks/use-enrollment';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  PERIOD_STATUS_LABELS,
  PERIOD_STATUS_PILL,
  formatDateOnly,
  formatDateTime,
} from '@/lib/admissions-format';
import type { AdmissionStreamDto, EnrollmentPeriodStatus } from '@/lib/types';

export default function PeriodDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && hasAnyPermission(user, ['stu-003:admin']);
  const period = useEnrollmentPeriod(id, !!user);
  const update = useUpdateEnrollmentPeriod(id);
  const { toast } = useToast();
  const [showStream, setShowStream] = useState(false);
  const [showCapacity, setShowCapacity] = useState(false);

  if (!user) return null;
  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Enrollment period" description="Admissions admin only." />
        <EmptyState title="Admin access required" />
      </div>
    );
  }

  if (period.isLoading) {
    return (
      <div className="py-16 text-center">
        <LoadingSpinner />
      </div>
    );
  }
  if (period.isError || !period.data) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Period not found" />
        <EmptyState
          title="Couldn’t load period"
          action={
            <Link
              href="/admissions/periods"
              className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600"
            >
              Back to periods
            </Link>
          }
        />
      </div>
    );
  }

  const p = period.data;

  async function transition(status: EnrollmentPeriodStatus) {
    try {
      await update.mutateAsync({ status });
      toast(`Period ${PERIOD_STATUS_LABELS[status].toLowerCase()}.`, 'success');
    } catch (e: any) {
      toast(e?.message || 'Could not update status', 'error');
    }
  }

  return (
    <div className="mx-auto max-w-5xl">
      <Link
        href="/admissions/periods"
        className="mb-3 inline-block text-sm text-gray-500 hover:text-campus-700"
      >
        ← Back to periods
      </Link>
      <PageHeader
        title={p.name}
        description={`${p.academicYearName} · ${formatDateOnly(p.opensAt)} → ${formatDateOnly(
          p.closesAt,
        )}`}
        actions={
          <span
            className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${
              PERIOD_STATUS_PILL[p.status]
            }`}
          >
            {PERIOD_STATUS_LABELS[p.status]}
          </span>
        }
      />

      <div className="mt-2 flex items-center gap-2">
        {p.status === 'UPCOMING' && (
          <button
            type="button"
            onClick={() => transition('OPEN')}
            disabled={update.isPending}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
          >
            Open period
          </button>
        )}
        {p.status === 'OPEN' && (
          <button
            type="button"
            onClick={() => transition('CLOSED')}
            disabled={update.isPending}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:opacity-50"
          >
            Close period
          </button>
        )}
        <Link
          href={`/admissions/applications?enrollmentPeriodId=${p.id}`}
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100"
        >
          View applications →
        </Link>
      </div>

      <section className="mt-8">
        <header className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900">Capacity by grade</h2>
          <button
            type="button"
            onClick={() => setShowCapacity(true)}
            className="text-sm font-medium text-campus-700 hover:text-campus-600"
          >
            + Add capacity
          </button>
        </header>
        {p.capacities.length === 0 ? (
          <EmptyState
            title="No capacity defined"
            description="Add at least one grade-level capacity so applications can be submitted."
          />
        ) : (
          <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-xs font-medium uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-2 text-left">Grade</th>
                  <th className="px-4 py-2 text-right">Total</th>
                  <th className="px-4 py-2 text-right">Reserved</th>
                  <th className="px-4 py-2 text-right">Apps</th>
                  <th className="px-4 py-2 text-right">Offers</th>
                  <th className="px-4 py-2 text-right">Accepted</th>
                  <th className="px-4 py-2 text-right">Waitlisted</th>
                  <th className="px-4 py-2 text-right">Available</th>
                </tr>
              </thead>
              <tbody>
                {p.capacitySummary.map((row) => (
                  <tr key={row.gradeLevel} className="border-t border-gray-100">
                    <td className="px-4 py-2 font-semibold text-gray-900">Grade {row.gradeLevel}</td>
                    <td className="px-4 py-2 text-right">{row.totalPlaces}</td>
                    <td className="px-4 py-2 text-right">{row.reserved}</td>
                    <td className="px-4 py-2 text-right">{row.applicationsReceived}</td>
                    <td className="px-4 py-2 text-right">{row.offersIssued}</td>
                    <td className="px-4 py-2 text-right">{row.offersAccepted}</td>
                    <td className="px-4 py-2 text-right">{row.waitlisted}</td>
                    <td
                      className={`px-4 py-2 text-right font-semibold ${
                        row.available <= 0
                          ? 'text-rose-700'
                          : row.available < row.totalPlaces * 0.1
                            ? 'text-amber-700'
                            : 'text-emerald-700'
                      }`}
                    >
                      {row.available}
                    </td>
                  </tr>
                ))}
                {p.capacitySummary.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-6 text-center text-gray-500">
                      No applications yet — capacities show once activity starts.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mt-8">
        <header className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900">Admission streams</h2>
          <button
            type="button"
            onClick={() => setShowStream(true)}
            className="text-sm font-medium text-campus-700 hover:text-campus-600"
          >
            + Add stream
          </button>
        </header>
        {p.streams.length === 0 ? (
          <p className="text-sm text-gray-500">
            No streams — applicants will land on the default intake.
          </p>
        ) : (
          <ul className="space-y-2">
            {p.streams.map((s) => (
              <StreamRow key={s.id} stream={s} />
            ))}
          </ul>
        )}
      </section>

      <section className="mt-8 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-xs text-gray-500">
        Created {formatDateTime(p.createdAt)} · Updated {formatDateTime(p.updatedAt)}
      </section>

      {showStream && <CreateStreamModal periodId={p.id} onClose={() => setShowStream(false)} />}
      {showCapacity && (
        <CreateCapacityModal
          periodId={p.id}
          streams={p.streams}
          onClose={() => setShowCapacity(false)}
        />
      )}
    </div>
  );
}

function StreamRow({ stream }: { stream: AdmissionStreamDto }) {
  return (
    <li className="flex items-center justify-between rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm">
      <div>
        <p className="font-medium text-gray-900">{stream.name}</p>
        <p className="text-xs text-gray-500">
          {stream.gradeLevel ? `Grade ${stream.gradeLevel}` : 'Any grade'}
          {stream.opensAt ? ` · opens ${formatDateOnly(stream.opensAt)}` : ''}
          {stream.closesAt ? ` · closes ${formatDateOnly(stream.closesAt)}` : ''}
        </p>
      </div>
      <span
        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
          stream.isActive ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-200 text-gray-700'
        }`}
      >
        {stream.isActive ? 'Active' : 'Inactive'}
      </span>
    </li>
  );
}

function CreateStreamModal({ periodId, onClose }: { periodId: string; onClose: () => void }) {
  const { toast } = useToast();
  const create = useCreateAdmissionStream(periodId);
  const [name, setName] = useState('');
  const [gradeLevel, setGradeLevel] = useState('');

  async function onSubmit() {
    if (!name.trim()) {
      toast('Stream name is required', 'error');
      return;
    }
    try {
      await create.mutateAsync({
        name: name.trim(),
        gradeLevel: gradeLevel.trim() || null,
      });
      toast('Stream added', 'success');
      onClose();
    } catch (e: any) {
      toast(e?.message || 'Could not add stream', 'error');
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="New admission stream"
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={create.isPending}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={create.isPending}
            className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600 disabled:opacity-50"
          >
            {create.isPending ? 'Saving…' : 'Add stream'}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <label className="block text-sm">
          <span className="text-gray-700">Stream name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            placeholder="e.g. Music Scholarship"
            className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </label>
        <label className="block text-sm">
          <span className="text-gray-700">Grade level (optional)</span>
          <input
            value={gradeLevel}
            onChange={(e) => setGradeLevel(e.target.value)}
            maxLength={8}
            placeholder="Leave blank for any grade"
            className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </label>
      </div>
    </Modal>
  );
}

function CreateCapacityModal({
  periodId,
  streams,
  onClose,
}: {
  periodId: string;
  streams: AdmissionStreamDto[];
  onClose: () => void;
}) {
  const { toast } = useToast();
  const create = useCreateIntakeCapacity(periodId);
  const [gradeLevel, setGradeLevel] = useState('');
  const [totalPlaces, setTotalPlaces] = useState('');
  const [reservedPlaces, setReservedPlaces] = useState('0');
  const [streamId, setStreamId] = useState('');

  async function onSubmit() {
    const total = Number(totalPlaces);
    const reserved = Number(reservedPlaces || '0');
    if (!gradeLevel.trim() || !Number.isFinite(total) || total < 0) {
      toast('Grade level and total places are required', 'error');
      return;
    }
    try {
      await create.mutateAsync({
        gradeLevel: gradeLevel.trim(),
        totalPlaces: total,
        reservedPlaces: reserved,
        streamId: streamId || null,
      });
      toast('Capacity added', 'success');
      onClose();
    } catch (e: any) {
      toast(e?.message || 'Could not add capacity', 'error');
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="New intake capacity"
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={create.isPending}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={create.isPending}
            className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600 disabled:opacity-50"
          >
            {create.isPending ? 'Saving…' : 'Add capacity'}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <label className="block text-sm">
          <span className="text-gray-700">Grade level</span>
          <input
            value={gradeLevel}
            onChange={(e) => setGradeLevel(e.target.value)}
            maxLength={8}
            placeholder="e.g. 9"
            className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm">
            <span className="text-gray-700">Total places</span>
            <input
              type="number"
              min={0}
              value={totalPlaces}
              onChange={(e) => setTotalPlaces(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            />
          </label>
          <label className="block text-sm">
            <span className="text-gray-700">Reserved</span>
            <input
              type="number"
              min={0}
              value={reservedPlaces}
              onChange={(e) => setReservedPlaces(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            />
          </label>
        </div>
        {streams.length > 0 && (
          <label className="block text-sm">
            <span className="text-gray-700">Stream (optional)</span>
            <select
              value={streamId}
              onChange={(e) => setStreamId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            >
              <option value="">All streams</option>
              {streams.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </Modal>
  );
}
