'use client';

import Link from 'next/link';
import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import {
  useAcademicYears,
  useCreateEnrollmentPeriod,
  useEnrollmentPeriods,
  useUpdateEnrollmentPeriod,
} from '@/hooks/use-enrollment';
import { hasAnyPermission, useAuthStore } from '@/lib/auth-store';
import {
  PERIOD_STATUS_LABELS,
  PERIOD_STATUS_PILL,
  formatDateOnly,
} from '@/lib/admissions-format';
import type { EnrollmentPeriodDto, EnrollmentPeriodStatus } from '@/lib/types';

export default function AdmissionsPeriodsPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && hasAnyPermission(user, ['stu-003:admin']);
  const periods = useEnrollmentPeriods(!!user);
  const [showCreate, setShowCreate] = useState(false);

  if (!user) return null;
  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Enrollment Periods" description="Admissions admin only." />
        <EmptyState
          title="Admin access required"
          description="Ask a school admin to manage enrollment periods."
        />
      </div>
    );
  }

  const rows = periods.data ?? [];

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Enrollment Periods"
        description="Admission windows for upcoming and current academic years."
        actions={
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600"
          >
            New period
          </button>
        }
      />

      <nav className="mt-2 flex gap-3 text-sm">
        <Link href="/admissions/applications" className="text-gray-500 hover:text-campus-700">
          Applications
        </Link>
        <span className="text-gray-300">·</span>
        <span className="font-medium text-campus-700">Periods</span>
        <span className="text-gray-300">·</span>
        <Link href="/admissions/waitlist" className="text-gray-500 hover:text-campus-700">
          Waitlist
        </Link>
      </nav>

      <div className="mt-6">
        {periods.isLoading ? (
          <div className="py-16 text-center">
            <LoadingSpinner />
          </div>
        ) : periods.isError ? (
          <EmptyState title="Couldn’t load periods" />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No enrollment periods yet"
            description="Open one to start collecting applications."
            action={
              <button
                type="button"
                onClick={() => setShowCreate(true)}
                className="rounded-lg bg-campus-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-campus-600"
              >
                New period
              </button>
            }
          />
        ) : (
          <ul className="space-y-3">
            {rows.map((p) => (
              <PeriodCard key={p.id} period={p} />
            ))}
          </ul>
        )}
      </div>

      {showCreate && <CreatePeriodModal onClose={() => setShowCreate(false)} />}
    </div>
  );
}

function PeriodCard({ period }: { period: EnrollmentPeriodDto }) {
  const update = useUpdateEnrollmentPeriod(period.id);
  const { toast } = useToast();

  async function transition(status: EnrollmentPeriodStatus) {
    try {
      await update.mutateAsync({ status });
      toast(`Period ${PERIOD_STATUS_LABELS[status].toLowerCase()}.`, 'success');
    } catch (e: any) {
      toast(e?.message || 'Could not update status', 'error');
    }
  }

  const totals = period.capacitySummary.reduce(
    (acc, row) => {
      acc.total += row.totalPlaces;
      acc.received += row.applicationsReceived;
      acc.offers += row.offersIssued;
      acc.accepted += row.offersAccepted;
      acc.waitlisted += row.waitlisted;
      acc.available += row.available;
      return acc;
    },
    { total: 0, received: 0, offers: 0, accepted: 0, waitlisted: 0, available: 0 },
  );

  return (
    <li className="rounded-xl border border-gray-200 bg-white px-5 py-4 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Link
              href={`/admissions/periods/${period.id}`}
              className="text-base font-semibold text-gray-900 hover:text-campus-700"
            >
              {period.name}
            </Link>
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                PERIOD_STATUS_PILL[period.status]
              }`}
            >
              {PERIOD_STATUS_LABELS[period.status]}
            </span>
          </div>
          <p className="mt-1 text-xs text-gray-500">
            {period.academicYearName} · {formatDateOnly(period.opensAt)} →{' '}
            {formatDateOnly(period.closesAt)}
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          {period.status === 'UPCOMING' && (
            <button
              type="button"
              onClick={() => transition('OPEN')}
              disabled={update.isPending}
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
            >
              Open
            </button>
          )}
          {period.status === 'OPEN' && (
            <button
              type="button"
              onClick={() => transition('CLOSED')}
              disabled={update.isPending}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:opacity-50"
            >
              Close
            </button>
          )}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 text-xs sm:grid-cols-6">
        <Stat label="Places" value={totals.total} />
        <Stat label="Applications" value={totals.received} />
        <Stat label="Offers issued" value={totals.offers} />
        <Stat label="Accepted" value={totals.accepted} />
        <Stat label="Waitlisted" value={totals.waitlisted} />
        <Stat label="Available" value={totals.available} tone={totals.available <= 0 ? 'amber' : 'normal'} />
      </div>
    </li>
  );
}

function Stat({
  label,
  value,
  tone = 'normal',
}: {
  label: string;
  value: number;
  tone?: 'normal' | 'amber';
}) {
  return (
    <div
      className={`rounded-lg px-3 py-2 ${
        tone === 'amber' ? 'bg-amber-50 text-amber-900' : 'bg-gray-50 text-gray-700'
      }`}
    >
      <p className="text-[11px] uppercase tracking-wide opacity-70">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
    </div>
  );
}

function CreatePeriodModal({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const years = useAcademicYears();
  const create = useCreateEnrollmentPeriod();
  const [academicYearId, setAcademicYearId] = useState('');
  const [name, setName] = useState('');
  const [opensAt, setOpensAt] = useState('');
  const [closesAt, setClosesAt] = useState('');
  const [allowsMidYear, setAllowsMidYear] = useState(false);

  async function onSubmit() {
    if (!academicYearId || !name.trim() || !opensAt || !closesAt) {
      toast('Fill all required fields', 'error');
      return;
    }
    try {
      await create.mutateAsync({
        academicYearId,
        name: name.trim(),
        opensAt: new Date(opensAt).toISOString(),
        closesAt: new Date(closesAt).toISOString(),
        allowsMidYearApplications: allowsMidYear,
      });
      toast('Enrollment period created', 'success');
      onClose();
    } catch (e: any) {
      toast(e?.message || 'Could not create period', 'error');
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="New enrollment period"
      size="lg"
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
            {create.isPending ? 'Creating…' : 'Create period'}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <Field label="Academic year" required>
          <select
            value={academicYearId}
            onChange={(e) => setAcademicYearId(e.target.value)}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          >
            <option value="">Select a year…</option>
            {(years.data ?? []).map((y) => (
              <option key={y.id} value={y.id}>
                {y.name}
                {y.isCurrent ? ' (current)' : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Period name" required>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            placeholder="e.g. Fall 2026 Admissions"
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
          />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Opens at" required>
            <input
              type="datetime-local"
              value={opensAt}
              onChange={(e) => setOpensAt(e.target.value)}
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            />
          </Field>
          <Field label="Closes at" required>
            <input
              type="datetime-local"
              value={closesAt}
              onChange={(e) => setClosesAt(e.target.value)}
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-campus-500 focus:outline-none focus:ring-1 focus:ring-campus-500"
            />
          </Field>
        </div>
        <label className="inline-flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={allowsMidYear}
            onChange={(e) => setAllowsMidYear(e.target.checked)}
            className="rounded border-gray-300 text-campus-600 focus:ring-campus-500"
          />
          Allow mid-year applications
        </label>
      </div>
    </Modal>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-sm">
      <span className="text-gray-700">
        {label}
        {required && <span className="ml-0.5 text-rose-600">*</span>}
      </span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
